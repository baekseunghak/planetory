"""systemd에서 TESS 수집을 끝날 때까지 재개하는 단일 Worker 감독 루프."""

from __future__ import annotations

import json
import os
import shutil
import socket
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from . import tess


class AlreadyRunning(RuntimeError):
    """같은 Worker의 감독 프로세스가 이미 잠금을 보유한다."""


def systemd_notify(message: str) -> bool:
    address = os.environ.get("NOTIFY_SOCKET", "")
    if not address:
        return False
    if address.startswith("@"):  # systemd abstract namespace socket
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.connect(address)
        channel.sendall(message.encode("utf-8"))
    return True


@contextmanager
def process_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b" ")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise AlreadyRunning(f"supervisor lock is held: {path}") from error
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n".encode("ascii"))
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def supervisor_lock_path(run_root: Path, worker_slot: int) -> Path:
    return run_root.parent / "locks" / f"supervisor-worker-{worker_slot}.lock"


def disk_fraction(path: Path, usage: Callable = shutil.disk_usage) -> float:
    value = usage(path)
    return value.used / value.total


def count_fits(output_root: Path, sector: int) -> int:
    path = output_root / f"sector={sector:04d}"
    return sum(1 for item in path.glob("*.fits") if item.is_file()) if path.is_dir() else 0


def legacy_process_matches(pid_file: Path, run_root: Path, sector: int) -> bool:
    try:
        pid = int(pid_file.read_text(encoding="ascii").strip())
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8")
    except (OSError, ValueError, UnicodeDecodeError):
        return False
    return "ingestion download" in command and str(run_root) in command and f"--sector {sector}" in command


def _paths(run_root: Path, sector: int, worker_slot: int) -> dict[str, Path]:
    prefix = run_root / "manifests" / f"sector-{sector}-worker-{worker_slot}"
    return {
        "events": prefix.with_suffix(".events.jsonl"),
        "run": prefix.with_suffix(".run.json"),
        "audit": prefix.with_suffix(".audit.json"),
        "exit": prefix.with_suffix(".exit"),
        "complete": prefix.with_suffix(".complete.json"),
        "legacy_pid": run_root / "pids" / f"sector-{sector}-worker-{worker_slot}.pid",
    }


def _cleaned_after_raw(run_root: Path, source: dict, sector: int, worker_slot: int) -> bool:
    path = run_root / "hdfs-load" / f"sector={sector:04d}" / f"worker-{worker_slot}.cleanup.json"
    if not path.is_file():
        return False
    state = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "schema": "planetory.tess-source-cleanup.v1",
        "run_id": run_root.name.removeprefix("run-"),
        "release_id": run_root.name.removeprefix("run-"),
        "source_list_sha256": source["source_list_sha256"],
        "sector": sector,
        "worker_slot": worker_slot,
    }
    if (any(state.get(key) != value for key, value in expected.items())
            or state.get("status") not in {"in_progress", "complete"}):
        raise RuntimeError("local cleanup state conflicts with the Sector source")
    return True


def _write_exit(path: Path, code: int) -> None:
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(f"{code}\n", encoding="ascii")
    os.replace(temporary, path)


def _state(path: Path, **values) -> None:
    tess.write_json_atomic({"schema": "planetory.ingestion-supervisor.v1", "updated_at": tess.utc_now(), **values}, path)


def _audit_sector(
    source: dict,
    output_root: Path,
    paths: dict[str, Path],
    worker_slot: int,
    sector: int,
    progress: Callable[[], None] = lambda: None,
) -> bool:
    tess.repair_event_log(paths["events"])
    summary, code = tess.audit_download(
        source,
        output_root,
        paths["events"],
        worker_slot=worker_slot,
        sectors={sector},
        progress=progress,
    )
    tess.write_json_atomic(summary, paths["audit"])
    if code == 0:
        tess.write_json_atomic(
            {
                "schema": "planetory.ingestion-sector-complete.v1",
                "completed_at": tess.utc_now(),
                "sector": sector,
                "worker_slot": worker_slot,
                "validated": summary["validated"],
                "total_bytes": summary["total_bytes"],
                "source_list_sha256": summary["source_list_sha256"],
            },
            paths["complete"],
        )
        return True
    return False


def run_supervisor(
    config: dict,
    source: dict,
    output_root: Path,
    run_root: Path,
    *,
    worker_slot: int,
    sectors: list[int],
    sleep: Callable[[float], None] = time.sleep,
    usage: Callable = shutil.disk_usage,
    legacy_checker: Callable[[Path, Path, int], bool] = legacy_process_matches,
    notify: Callable[[str], object] = systemd_notify,
    max_cycles: int | None = None,
) -> int:
    state_path = run_root / "manifests" / f"supervisor-worker-{worker_slot}.json"
    lock_path = supervisor_lock_path(run_root, worker_slot)
    stop_fraction = float(config["disk_stop_fraction"])
    resume_fraction = float(config["disk_resume_fraction"])
    retry_initial = int(config["retry_initial_seconds"])
    retry_max = int(config["retry_max_seconds"])
    cycles = 0
    capacity_latched = False

    def heartbeat(status: str | None = None) -> None:
        fields = ["WATCHDOG=1"]
        if status:
            fields.append(f"STATUS={status}")
        notify("\n".join(fields))

    def monitored_sleep(seconds: float) -> None:
        remaining = max(0.0, seconds)
        while remaining > 0:
            heartbeat()
            duration = min(30.0, remaining)
            sleep(duration)
            remaining -= duration

    def update_state(**values) -> None:
        _state(state_path, **values)
        heartbeat(str(values.get("status", "running")))

    with process_lock(lock_path):
        notify(f"READY=1\nWATCHDOG=1\nSTATUS=worker {worker_slot} supervisor ready")
        for sector in sectors:
            paths = _paths(run_root, sector, worker_slot)
            retry_attempt = 0
            while True:
                if _cleaned_after_raw(run_root, source, sector, worker_slot):
                    break
                if paths["complete"].is_file() and _audit_sector(
                    source, output_root, paths, worker_slot, sector, progress=heartbeat
                ):
                    break

                while legacy_checker(paths["legacy_pid"], run_root, sector):
                    update_state(
                        status="ADOPTING",
                        sector=sector,
                        worker_slot=worker_slot,
                        reason="waiting for pre-supervisor download process",
                    )
                    monitored_sleep(30)

                if paths["exit"].is_file() and paths["exit"].read_text(encoding="ascii").strip() == "0":
                    if _audit_sector(source, output_root, paths, worker_slot, sector, progress=heartbeat):
                        break

                current_disk_fraction = disk_fraction(output_root, usage)
                capacity_latched = capacity_latched or current_disk_fraction >= stop_fraction
                while capacity_latched and current_disk_fraction >= resume_fraction:
                    update_state(
                        status="PAUSED_CAPACITY",
                        sector=sector,
                        worker_slot=worker_slot,
                        disk_fraction=current_disk_fraction,
                        stop_fraction=stop_fraction,
                        resume_fraction=resume_fraction,
                    )
                    monitored_sleep(60)
                    current_disk_fraction = disk_fraction(output_root, usage)
                capacity_latched = False

                before = count_fits(output_root, sector)
                update_state(
                    status="RUNNING",
                    sector=sector,
                    worker_slot=worker_slot,
                    retry_attempt=retry_attempt,
                    fits=before,
                )
                summary, code = tess.run_download(
                    source,
                    output_root,
                    paths["events"],
                    worker_slot=worker_slot,
                    sectors={sector},
                    retries=int(config["max_retries"]),
                    max_part_bytes=int(config["max_part_bytes"]),
                    disk_stop_fraction=stop_fraction,
                    max_consecutive_failures=int(config["max_consecutive_failures"]),
                    concurrency=int(config.get("download_concurrency", 1)),
                    progress=heartbeat,
                )
                tess.write_json_atomic(summary, paths["run"])
                _write_exit(paths["exit"], code)
                cycles += 1
                if code == 0 and _audit_sector(
                    source, output_root, paths, worker_slot, sector, progress=heartbeat
                ):
                    break

                after = count_fits(output_root, sector)
                retry_attempt = 0 if after > before else retry_attempt + 1
                delay = 60 if code == 2 else min(retry_max, retry_initial * (2 ** min(retry_attempt, 10)))
                capacity_latched = code == 2
                update_state(
                    status="PAUSED_CAPACITY" if code == 2 else "BACKOFF",
                    sector=sector,
                    worker_slot=worker_slot,
                    exit_code=code,
                    retry_attempt=retry_attempt,
                    retry_after_seconds=delay,
                    fits=after,
                    failures=summary["failed"],
                    stopped_capacity=summary["stopped_capacity"],
                    stopped_circuit=summary["stopped_circuit"],
                )
                if max_cycles is not None and cycles >= max_cycles:
                    return 4
                monitored_sleep(delay)

        update_state(status="COMPLETE", worker_slot=worker_slot, sectors=sectors)
    return 0

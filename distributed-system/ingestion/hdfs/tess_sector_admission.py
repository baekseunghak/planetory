"""Node 1 admission for one immutable post-year-one TESS Sector run."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shlex
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ingestion import tess

import tess_hdfs_runall as raw


ROOT = Path("/var/lib/planetory-tess-admission")
SOURCE_CONFIG = Path(__file__).resolve().parents[1] / "config" / "service-v1.json"
SCRIPT_RE = re.compile(
    r"^https://archive\.stsci\.edu/missions/tess/download_scripts/sector/tesscurl_sector_(\d+)_lc\.sh$"
)
INGESTION_RELEASE_RE = re.compile(r"^/mnt/data/planetory-ingestion/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
BRONZE_RELEASE_RE = re.compile(r"^/opt/planetory-bronze/releases/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@contextmanager
def locked_root():
    import fcntl  # Node 1 runs Linux; keep the pure contract importable in offline Windows tests.

    if ROOT.is_symlink():
        raise ValueError("admission state root must not be a symlink")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o022:
        raise ValueError("admission state root must be root-owned and not group-writable")
    with (ROOT / "lock").open("a+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def state_path(sector: int) -> Path:
    if not 14 <= sector <= 70:
        raise ValueError("automatic admission is restricted to Sector 14..70")
    return ROOT / f"sector-{sector:04d}.json"


def validate_options(sector: int, script_url: str, ingestion_release: str, hdfs_release: str,
                     bronze_release: str, version: str, partitions: int) -> None:
    match = SCRIPT_RE.fullmatch(script_url)
    if not match or int(match.group(1)) != sector:
        raise ValueError("Sector does not match official two-minute LC script URL")
    if not INGESTION_RELEASE_RE.fullmatch(ingestion_release) or not BRONZE_RELEASE_RE.fullmatch(bronze_release):
        raise ValueError("invalid immutable ingestion or Bronze release")
    if not hdfs_release.startswith("/opt/planetory-hdfs-load/releases/") or not raw.loader.RELEASE_ID_RE.fullmatch(
        Path(hdfs_release).name
    ) or Path(hdfs_release).parent != Path("/opt/planetory-hdfs-load/releases"):
        raise ValueError("invalid immutable HDFS release")
    if not raw.loader.RELEASE_ID_RE.fullmatch(version) or not 1 <= partitions <= 200:
        raise ValueError("invalid Bronze version or partition count")


def source_paths(state: dict) -> tuple[Path, Path]:
    directory = ROOT / f"run-{state['run_id']}"
    return directory / "tess-service-v1.json", directory / "sector-config.json"


def new_run_id() -> str:
    candidate = datetime.now(timezone.utc)
    existing = {json.loads(path.read_text(encoding="utf-8")).get("run_id")
                for path in ROOT.glob("sector-*.json")}
    while True:
        value = candidate.strftime("%Y%m%dT%H%M%SZ")
        if value not in existing and not (ROOT / f"run-{value}").exists():
            return value
        candidate += timedelta(seconds=1)


def prepare_source(state: dict) -> dict:
    source_path, config_path = source_paths(state)
    source_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if config_path.exists():
        config = tess.load_config(config_path)
    else:
        config = tess.load_config(SOURCE_CONFIG)
        config = {**config, "version": f"spoc-2min-sector-{state['sector']}", "sectors": [{
            "sector": state["sector"], "bulk_script_url": state["script_url"],
        }]}
        tess.write_json_atomic(config, config_path)
    if config["sectors"] != [{"sector": state["sector"], "bulk_script_url": state["script_url"]}]:
        raise ValueError("Sector source configuration changed")
    if source_path.exists():
        source = tess.load_source_list(source_path)
    else:
        source = tess.build_source_list(config)
        tess.write_json_atomic(source, source_path)
    if state.get("source_list_sha256") and state["source_list_sha256"] != source["source_list_sha256"]:
        raise ValueError("immutable Sector source list changed")
    if state.get("source_document_sha256") and state["source_document_sha256"] != tess.sha256_file(source_path):
        raise ValueError("immutable Sector source document changed")
    if (
        source["product_count"] < 5
        or {item["sector"] for item in source["products"]} != {state["sector"]}
        or {item["assigned_worker"] for item in source["products"]} != set(range(1, 6))
    ):
        raise ValueError("Sector source list is incomplete")
    return source


def worker_unit(state: dict, slot: int) -> tuple[str, str]:
    run_id, sector = state["run_id"], state["sector"]
    release = state["ingestion_release"]
    run_root = f"/mnt/data/staging/S15P21C206-75/run-{run_id}"
    lock_root = "/mnt/data/staging/S15P21C206-75/locks"
    unit = f"planetory-tess-ingestion-{run_id}-worker-{slot}.service"
    text = f"""[Unit]
Description=Planetory TESS Sector {sector} worker {slot}
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/mnt/data
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=main
WatchdogSec=5min
User=planetory-admin
WorkingDirectory={release}
Environment=PYTHONPATH={release}
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3.12 -m ingestion supervise --config {run_root}/manifests/sector-config.json --source-list {run_root}/manifests/tess-service-v1.json --expected-source-list-sha256 {state['source_list_sha256']} --output {run_root}/raw --run-root {run_root} --worker-slot {slot} --sector {sector}
Restart=on-failure
RestartSec=30s
TimeoutStopSec=30s
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={run_root} {lock_root}

[Install]
WantedBy=multi-user.target
"""
    return unit, text


def install_worker(state: dict, slot: int) -> None:
    worker = {"slot": slot, "internal_ip": raw.WORKER_IPS[slot]}
    run_id = state["run_id"]
    run_root = f"/mnt/data/staging/S15P21C206-75/run-{run_id}"
    source_path, config_path = source_paths(state)
    source_sha = tess.sha256_file(source_path)
    config_sha = tess.sha256_file(config_path)
    temporary = f"{run_root}/manifests/.admit-{run_id}-w{slot}"
    raw.ssh(worker, "sudo install -d -o \"$(id -un)\" -g \"$(id -gn)\" " + " ".join(
        shlex.quote(path) for path in (
            run_root, run_root + "/manifests", run_root + "/raw",
            "/mnt/data/staging/S15P21C206-75/locks",
        )
    ))
    scp = [
        "/usr/bin/scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={raw.KNOWN_HOSTS}", "-o", f"BindAddress={raw.NODE1_IP}",
        "-i", raw.SSH_KEY,
    ]
    for local, suffix in ((source_path, "source"), (config_path, "config")):
        raw.run([*scp, str(local), f"planetory-admin@{worker['internal_ip']}:{temporary}-{suffix}.json"])
    unit, text = worker_unit(state, slot)
    encoded = base64.b64encode(text.encode()).decode()
    script = f"""set -eu
test -f {shlex.quote(state['ingestion_release'] + '/READY')}
run_root={shlex.quote(run_root)}
temporary={shlex.quote(temporary)}
unit={shlex.quote(unit)}
mkdir -p "$run_root/manifests" "$run_root/raw" /mnt/data/staging/S15P21C206-75/locks
for kind in source config; do
  file="$temporary-$kind.json"
  target="$run_root/manifests/$(test "$kind" = source && echo tess-service-v1.json || echo sector-config.json)"
  expected=$(test "$kind" = source && echo {source_sha} || echo {config_sha})
  test "$(sha256sum "$file" | cut -d ' ' -f 1)" = "$expected"
  if test -e "$target"; then cmp -s "$file" "$target" || {{ echo WORKER_SOURCE_CONFLICT >&2; exit 1; }}
  else install -m 0644 "$file" "$target"; fi
  rm -f -- "$file"
done
candidate="$temporary.service"
printf '%s' '{encoded}' | base64 --decode > "$candidate"
if sudo test -e "/etc/systemd/system/$unit"; then
  sudo cmp -s "$candidate" "/etc/systemd/system/$unit" || {{ echo INGESTION_UNIT_CONFLICT >&2; exit 1; }}
else sudo install -o root -g root -m 0644 "$candidate" "/etc/systemd/system/$unit"; fi
rm -f -- "$candidate"
sudo systemctl daemon-reload
sudo systemd-analyze verify "/etc/systemd/system/$unit"
sudo systemctl enable "$unit" >/dev/null
echo INGESTION_UNIT_READY unit="$unit"
"""
    raw.ssh(worker, script)


def prepare(args: argparse.Namespace) -> dict:
    validate_options(args.sector, args.script_url, args.ingestion_release, args.hdfs_release,
                     args.bronze_release, args.bronze_pipeline_version, args.bronze_output_partitions)
    with locked_root():
        path = state_path(args.sector)
        requested = {
            "sector": args.sector, "script_url": args.script_url,
            "ingestion_release": args.ingestion_release, "hdfs_release": args.hdfs_release,
            "bronze_release": args.bronze_release, "bronze_pipeline_version": args.bronze_pipeline_version,
            "bronze_output_partitions": args.bronze_output_partitions,
        }
        if path.exists():
            state = json.loads(path.read_text(encoding="utf-8"))
            if any(state.get(key) != value for key, value in requested.items()):
                raise ValueError("Sector admission conflicts with immutable intent")
        else:
            state = {**requested, "run_id": new_run_id()}
            tess.write_json_atomic(state, path)
        source = prepare_source(state)
        state = {**state, "source_list_sha256": source["source_list_sha256"],
                 "source_document_sha256": tess.sha256_file(source_paths(state)[0]),
                 "product_count": source["product_count"]}
        tess.write_json_atomic(state, path)
        for slot in range(1, 6):
            install_worker(state, slot)
        state = {**state, "installed": True}
        tess.write_json_atomic(state, path)
        return state


def worker_markers(state: dict) -> list[dict]:
    source = tess.load_source_list(source_paths(state)[0])
    expected = {slot: sum(item["assigned_worker"] == slot for item in source["products"])
                for slot in range(1, 6)}
    markers = []
    for slot in range(1, 6):
        worker = {"slot": slot, "internal_ip": raw.WORKER_IPS[slot]}
        path = (f"/mnt/data/staging/S15P21C206-75/run-{state['run_id']}/manifests/"
                f"sector-{state['sector']}-worker-{slot}.complete.json")
        output = raw.ssh(worker, f"cat {shlex.quote(path)}", echo=False).stdout
        marker = json.loads(output)
        if (
            marker.get("schema") != "planetory.ingestion-sector-complete.v1"
            or marker.get("sector") != state["sector"]
            or marker.get("worker_slot") != slot
            or marker.get("source_list_sha256") != state["source_list_sha256"]
            or int(marker.get("validated", 0)) != expected[slot]
            or int(marker.get("total_bytes", 0)) < 1
        ):
            raise ValueError(f"Worker {slot} completion marker differs from admitted Sector")
        markers.append(marker)
    if sum(int(marker["validated"]) for marker in markers) != state["product_count"]:
        raise ValueError("Worker completion count differs from immutable source list")
    return markers


def finalize(sector: int) -> dict:
    with locked_root():
        state = json.loads(state_path(sector).read_text(encoding="utf-8"))
        if not state.get("installed"):
            raise ValueError("all Worker units must be installed before Raw config")
        if tess.sha256_file(source_paths(state)[0]) != state["source_document_sha256"]:
            raise ValueError("immutable Sector source document changed")
        markers = worker_markers(state)
        run_id = state["run_id"]
        config = {
            "schema": raw.CONFIG_SCHEMA, "run_id": run_id,
            "expected_source_list_sha256": state["source_list_sha256"],
            "code_release_id": Path(state["hdfs_release"]).name,
            "code_release": state["hdfs_release"],
            "target_bundle_bytes": 512 << 20, "minimum_worker_free_gib": 100,
            "cleanup_source_after_commit": False,
            "workers": [{"slot": slot, "internal_ip": raw.WORKER_IPS[slot]} for slot in range(1, 6)],
            "sector_contexts": [{
                "sector": sector, "run_id": run_id, "release_id": run_id,
                "source_list_sha256": state["source_list_sha256"],
                "product_count": state["product_count"],
                "total_bytes": sum(int(marker["total_bytes"]) for marker in markers),
            }],
        }
        raw.validate_config(config)
        path = Path(f"/etc/planetory/tess-hdfs-runall/{run_id}.json")
        if path.exists():
            if json.loads(path.read_text(encoding="utf-8")) != config:
                raise ValueError("immutable HDFS Sector config changed")
        else:
            tess.write_json_atomic(config, path)
        return {"sector": sector, "run_id": run_id, "hdfs_config": str(path),
                "source_list_sha256": state["source_list_sha256"]}


def _optional_worker_json(slot: int, path: str) -> dict | None:
    worker = {"slot": slot, "internal_ip": raw.WORKER_IPS[slot]}
    output = raw.ssh(
        worker,
        f"if test -f {shlex.quote(path)}; then cat {shlex.quote(path)}; else echo MISSING; fi",
        echo=False,
    ).stdout.strip()
    return None if output == "MISSING" else json.loads(output)


def status(sector: int) -> dict:
    path = state_path(sector)
    if not path.exists():
        return {"sector": sector, "admitted": False}
    state = json.loads(path.read_text(encoding="utf-8"))
    if not state.get("installed"):
        return {**state, "admitted": True, "installed": False}
    source = tess.load_source_list(source_paths(state)[0])
    if (
        source["source_list_sha256"] != state["source_list_sha256"]
        or tess.sha256_file(source_paths(state)[0]) != state["source_document_sha256"]
    ):
        raise ValueError("admitted source list changed")
    run_id, source_sha = state["run_id"], state["source_list_sha256"]
    expected_by_slot = {slot: sum(item["assigned_worker"] == slot for item in source["products"])
                        for slot in range(1, 6)}
    raw_path = f"/lake/raw/tess/release={run_id}/sector={sector:04d}"
    bronze_path = f"/lake/bronze/tess/sector={sector:04d}"
    raw_ready_path = f"{raw_path}/_READY.json"
    raw_ready = raw.hdfs_json(raw_ready_path) if raw.hdfs_exists(raw_ready_path) else None
    if raw_ready and any(raw_ready.get(key) != expected for key, expected in {
        "run_id": run_id, "release_id": run_id, "source_list_sha256": source_sha,
        "sector": sector, "product_count": state["product_count"], "replication": 2,
    }.items()):
        raise ValueError("Raw final conflicts with admitted Sector")
    bronze_ready_path = f"{bronze_path}/_READY.json"
    bronze_ready = raw.hdfs_json(bronze_ready_path) if raw.hdfs_exists(bronze_ready_path) else None
    if bronze_ready and (
        not raw_ready
        or any(bronze_ready.get(key) != expected for key, expected in {
            "sector": sector, "raw_release": run_id, "raw_path": raw_path,
            "source_list_sha256": source_sha, "run_id": run_id,
            "pipeline_version": state["bronze_pipeline_version"],
            "product_count": state["product_count"], "parse_error_count": 0,
        }.items())
    ):
        raise ValueError("Bronze final conflicts with admitted Sector")
    cleanup = True
    for slot in range(1, 6):
        cleanup_path = (f"/mnt/data/staging/S15P21C206-75/run-{run_id}/hdfs-load/"
                        f"sector={sector:04d}/worker-{slot}.cleanup.json")
        row = _optional_worker_json(slot, cleanup_path)
        if row is None:
            cleanup = False
            continue
        if not raw_ready:
            raise ValueError(f"Worker {slot} cleanup exists without Raw final")
        if any(row.get(key) != expected for key, expected in {
            "schema": "planetory.tess-source-cleanup.v1",
            "run_id": run_id, "release_id": run_id, "source_list_sha256": source_sha,
            "sector": sector, "worker_slot": slot,
        }.items()) or row.get("status") not in {"in_progress", "complete"}:
            raise ValueError(f"Worker {slot} cleanup state conflicts with admitted Sector")
        if row["status"] != "complete":
            cleanup = False
    if bronze_ready and not cleanup:
        raise ValueError("Bronze final exists without five cleanup proofs")
    download = bool(raw_ready)
    if not download:
        found = []
        for slot in range(1, 6):
            marker_path = (f"/mnt/data/staging/S15P21C206-75/run-{run_id}/manifests/"
                           f"sector-{sector}-worker-{slot}.complete.json")
            row = _optional_worker_json(slot, marker_path)
            if row is None:
                continue
            if any(row.get(key) != expected for key, expected in {
                "schema": "planetory.ingestion-sector-complete.v1", "sector": sector,
                "worker_slot": slot, "source_list_sha256": source_sha,
            }.items()) or int(row.get("validated", 0)) != expected_by_slot[slot]:
                raise ValueError(f"Worker {slot} download marker conflicts with admitted Sector")
            found.append(row)
        download = len(found) == 5 and sum(int(row["validated"]) for row in found) == state["product_count"]
    return {
        **state, "admitted": True,
        "evidence": {"download": download, "raw": bool(raw_ready),
                     "cleanup": cleanup, "bronze": bool(bronze_ready)},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    admission = commands.add_parser("prepare")
    admission.add_argument("--sector", type=int, required=True)
    admission.add_argument("--script-url", required=True)
    admission.add_argument("--ingestion-release", required=True)
    admission.add_argument("--hdfs-release", required=True)
    admission.add_argument("--bronze-release", required=True)
    admission.add_argument("--bronze-pipeline-version", required=True)
    admission.add_argument("--bronze-output-partitions", type=int, required=True)
    done = commands.add_parser("finalize")
    done.add_argument("--sector", type=int, required=True)
    inspect = commands.add_parser("status")
    inspect.add_argument("--sector", type=int, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or os.uname().nodename.split(".")[0] != "master-1":
        raise SystemExit("Node 1 root is required")
    result = prepare(args) if args.command == "prepare" else (
        finalize(args.sector) if args.command == "finalize" else status(args.sector)
    )
    print("ADMISSION_JSON=" + json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

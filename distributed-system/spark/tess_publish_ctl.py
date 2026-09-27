"""Node 1 control for the 276 publish step: fetch an approved publish-ready run and load it with the Publisher.

Airflow starts it after the human approval in tess_publication_run. Like the Gold controller it runs as a
systemd unit, so an Airflow restart or redeploy does not stop a long publish. The Publisher is idempotent:
a unit restart after a transient failure finds finished stars ALREADY_PUBLISHED.

The Publisher image is not an argument. Under sudo an arbitrary image with host networking and the DB
env file would equal root, so the image comes from the root-only /etc/planetory/publisher/image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tess_bronze_ctl import DATA_CONTRACT_EXIT_CODE, hdfs_exists, hdfs_json, run, utc_now, write_state
from tess_gold_ctl import (APPROVAL_RE, GOLD_ATTEMPT_RE, HDFS_COMMAND, OUTPUTS, PUBLISH_READY_ROOT,
                           PUBLISH_READY_SCHEMA, RELEASE_DIR_RE, UNIT_ROOT, latest_state)
from tess_silver_ctl import RUN_ID_RE, systemd_properties

ENV_FILE = "/etc/planetory/publisher/env"
IMAGE_FILE = Path("/etc/planetory/publisher/image")
IMAGE_RE = re.compile(r"[a-z0-9.-]+(:[0-9]+)?/planetory/publisher(:[0-9a-f]{40}|@sha256:[0-9a-f]{64})")
STATE_ROOT = "/var/lib/planetory-publish"
PART_RE = re.compile(rf"({'|'.join(OUTPUTS)})/part-[0-9]{{5}}")
# ponytail: the whole run is fetched before publishing (1~13 has at most 5,156 ready stars, a few GB).
# If a run outgrows the disk, stream bundle parts one at a time.
DISK_MARGIN = 2 * 1024 ** 3
DONE = "complete"


class PublishContractError(RuntimeError):
    """A deterministic failure that must not restart unchanged (exit 65)."""


def unit_name(run_id: str) -> str:
    return f"planetory-tess-publish-{run_id}.service"


def ready_marker(run_id: str) -> tuple[dict[str, Any], str]:
    """The run's publish-ready marker, which only the gate writes after its checks pass."""
    path = f"{PUBLISH_READY_ROOT}/run_id={run_id}/_READY.json"
    if not hdfs_exists(path):
        raise PublishContractError(f"run {run_id} has no publish-ready marker")
    marker, sha256 = hdfs_json(path)
    match = GOLD_ATTEMPT_RE.fullmatch(str(marker.get("attempt")))
    if marker.get("schema") != PUBLISH_READY_SCHEMA or marker.get("run_id") != run_id or not match \
            or match.group(1) != run_id:
        raise PublishContractError(f"publish-ready marker for {run_id} is not this run's gate output")
    files = marker.get("files")
    if not isinstance(files, dict) or not files or not all(PART_RE.fullmatch(rel) for rel in files):
        raise PublishContractError("publish-ready files must be <manifest|candidates|bundles>/part-NNNNN")
    return marker, sha256


def publisher_image() -> str:
    image = IMAGE_FILE.read_text(encoding="utf-8").strip() if IMAGE_FILE.is_file() else ""
    if not IMAGE_RE.fullmatch(image):
        raise PublishContractError(f"{IMAGE_FILE} must hold one pinned Publisher image")
    return image


def fetch_part(source: str, target: Path, spec: dict[str, Any]) -> None:
    """Stream one part from HDFS, checking the gate's sha256, bytes and lines while writing it."""
    digest, size, lines = hashlib.sha256(), 0, 0
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as out, subprocess.Popen([*HDFS_COMMAND, "dfs", "-cat", source],
                                                    stdout=subprocess.PIPE) as process:
        for chunk in iter(lambda: process.stdout.read(1 << 20), b""):
            out.write(chunk)
            digest.update(chunk)
            size += len(chunk)
            lines += chunk.count(b"\n")
    if process.returncode:
        raise RuntimeError(f"hdfs -cat failed ({process.returncode}): {source}")  # transient: the unit restarts
    if (digest.hexdigest(), size, lines) != (spec["sha256"], spec["bytes"], spec["lines"]):
        raise PublishContractError(f"{source} differs from the publish-ready files entry")


def fetch(marker: dict[str, Any], folder: Path) -> None:
    """Lay out the folder publish-run --ready reads. Files are world-readable for the Publisher user."""
    need = sum(spec["bytes"] for spec in marker["files"].values()) + DISK_MARGIN
    folder.parent.mkdir(parents=True, exist_ok=True)
    if folder.exists():   # an earlier attempt's copy, kept for diagnosis; it must not count against the new fetch
        shutil.rmtree(folder)
    free = shutil.disk_usage(folder.parent).free
    if need > free:
        raise PublishContractError(f"publish needs {need} bytes under {folder.parent}, {free} free")
    folder.mkdir()
    (folder / "_READY.json").write_text(json.dumps(marker, sort_keys=True) + "\n", encoding="utf-8")
    for rel, spec in sorted(marker["files"].items()):
        fetch_part(f"{marker['attempt']}/{rel}", folder / rel, spec)
    for path in [folder, *folder.rglob("*")]:
        os.chmod(path, 0o755 if path.is_dir() else 0o644)


def publish_command(image: str, folder: Path, run_id: str, approval: str) -> list[str]:
    return ["/usr/bin/docker", "run", "--rm", "--network", "host", "--env-file", ENV_FILE,
            "-v", f"{folder}:/ready:ro", image, "python", "-m", "publisher", "publish-run",
            "--run-id", run_id, "--ready", "/ready", "--approval", approval]


def command_publish(args: argparse.Namespace) -> None:
    folder = Path(args.state_root, f"run={args.run_id}", "ready")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    state_file = Path(args.state_root, f"run={args.run_id}", f"publish={stamp}.json")
    state = {"run_id": args.run_id, "command": "publish", "unit": unit_name(args.run_id), "status": "prepared",
             "approval": args.approval, "updated_at_utc": utc_now()}
    # Written before the marker and image checks, so a failure there reaches Airflow with its reason.
    write_state(state_file, state)
    try:
        marker, ready_sha256 = ready_marker(args.run_id)
        image = publisher_image()
        state.update(status="fetching", attempt=marker["attempt"], publish_ready_sha256=ready_sha256, image=image,
                     updated_at_utc=utc_now())
        write_state(state_file, state)
        fetch(marker, folder)
        state.update(status="publishing", updated_at_utc=utc_now())
        write_state(state_file, state)
        # Progress goes to the journal; stdout is the run record JSON.
        result = subprocess.run(publish_command(image, folder, args.run_id, args.approval),
                                stdout=subprocess.PIPE, text=True, check=False)
        try:
            record = json.loads(result.stdout)
        except json.JSONDecodeError:
            record = None
        state.update(publisher_exit=result.returncode, record=record)
        # The folder stays for diagnosis; a restart fetches it again. Only exit 1 (a transient failure or an
        # unhandled DB error) is retried. Anything else, such as docker's 125 or argparse's 2 from an image
        # without publish-run, repeats unchanged, so it stops like a data failure.
        if result.returncode == 1:
            raise RuntimeError("publish-run exited 1; the unit retries and finished stars stay ALREADY_PUBLISHED")
        if result.returncode != 0:
            raise PublishContractError(
                f"publish-run exited {result.returncode}: {(record or {}).get('reason') or record}")
    except PublishContractError as exc:
        state.update(status="rejected", failure_detail=str(exc)[:500], updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    except Exception as exc:
        state.update(status="failed", failure_detail=f"{type(exc).__name__}: {exc}"[:500], updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    shutil.rmtree(folder)
    state.update(status=DONE, updated_at_utc=utc_now())
    write_state(state_file, state)
    print(f"PUBLISH_COMPLETE run={args.run_id} counts={json.dumps((record or {}).get('counts'))}", flush=True)


def operation_argv(args: argparse.Namespace) -> list[str]:
    return ["/usr/bin/python3.12", f"{args.release_dir}/spark/tess_publish_ctl.py", "publish",
            "--release-dir", args.release_dir, "--run-id", args.run_id, "--approval", args.approval]


def unit_text(args: argparse.Namespace) -> str:
    """Same unit shape as the Gold controller: oneshot, restarts on failure, never after exit 65."""
    return "\n".join([
        "[Unit]",
        f"Description=Planetory TESS publish {args.run_id}",
        "After=network-online.target hadoop-hdfs-namenode.service docker.service",
        "Wants=network-online.target",
        # As for Gold: a failure that repeats is not refetched and republished forever; 7 starts a day is
        # one more than the DAG's MAX_UNIT_RESTARTS, after which the unit stays failed.
        "StartLimitIntervalSec=1d",
        "StartLimitBurst=7",
        "",
        "[Service]",
        "Type=oneshot",
        "User=root",
        "Group=root",
        f"WorkingDirectory={args.release_dir}",
        "Environment=PYTHONDONTWRITEBYTECODE=1",
        f"ExecStart={' '.join(operation_argv(args))}",
        "ExecStartPost=-/usr/bin/systemctl disable %n",
        "ExecStopPost=-/bin/sh -c 'if [ \"$EXIT_CODE\" = \"exited\" ] && [ \"$EXIT_STATUS\" = \"65\" ]; "
        "then /usr/bin/systemctl disable \"%n\"; fi'",
        "TimeoutStartSec=infinity",
        "Restart=on-failure",
        "RestartPreventExitStatus=65",
        "RestartSec=5min",
        "UMask=0027",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
    ])


def command_start_unit(args: argparse.Namespace) -> None:
    """Install and start the publish unit, then return without waiting."""
    if not RELEASE_DIR_RE.fullmatch(args.release_dir) or (
            Path(__file__).resolve() != Path(args.release_dir, "spark", "tess_publish_ctl.py")):
        raise PublishContractError("unit release must be the immutable release running this controller")
    name = unit_name(args.run_id)
    path, text = UNIT_ROOT / name, unit_text(args)
    if path.exists():
        if path.read_text(encoding="utf-8") != text:
            raise PublishContractError(f"UNIT_DEFINITION_MISMATCH {name}")
    else:
        candidate = UNIT_ROOT / f".{name}.part"
        candidate.write_text(text, encoding="utf-8")
        os.chmod(candidate, 0o644)
        os.replace(candidate, path)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "enable", name])
    if systemd_properties(name).get("ActiveState") in ("active", "activating"):
        print(f"PUBLISH_UNIT_ALREADY_ACTIVE={name}", flush=True)
        return
    if (latest_state(args.state_root, args.run_id, name) or {}).get("status") == DONE:
        print(f"PUBLISH_UNIT_ALREADY_COMPLETE={name}", flush=True)
        return
    run(["/usr/bin/systemctl", "reset-failed", name], check=False)
    run(["/usr/bin/systemctl", "--no-block", "start", name])
    print(f"PUBLISH_UNIT_STARTED={name}", flush=True)


def command_status(args: argparse.Namespace) -> None:
    """Read-only unit and latest state. Same status line as the Gold controller, so the DAG reads both."""
    name = unit_name(args.run_id)
    print("GOLD_STATUS_JSON=" + json.dumps(
        {"unit": name, "systemd": systemd_properties(name), "state": latest_state(args.state_root, args.run_id, name)},
        sort_keys=True, separators=(",", ":")), flush=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    publish = commands.add_parser("publish")
    publish.set_defaults(handler=command_publish)
    start = commands.add_parser("start-unit")
    start.set_defaults(handler=command_start_unit)
    start.add_argument("operation", choices=("publish",))
    status = commands.add_parser("status")
    status.set_defaults(handler=command_status)
    status.add_argument("operation", choices=("publish",))
    for child in (publish, start):
        child.add_argument("--release-dir", required=True)
        child.add_argument("--run-id", required=True)
        child.add_argument("--approval", required=True)
    status.add_argument("--run-id", required=True)
    for child in (publish, start, status):
        child.add_argument("--state-root", default=STATE_ROOT)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not RUN_ID_RE.fullmatch(args.run_id):
        raise SystemExit("run ID must be UTC yyyyMMddTHHmmssZ")
    if args.command != "status" and not APPROVAL_RE.fullmatch(args.approval):
        raise SystemExit("approval must be one token of letters, digits and ._/-")
    try:
        args.handler(args)
        return 0
    except PublishContractError as exc:
        print(f"PUBLISH_TERMINAL_FAILURE {exc}", file=sys.stderr, flush=True)
        return DATA_CONTRACT_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())

"""Node 1에서 내부망으로 TESS HDFS 적재를 끝까지 실행한다."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import tess_hdfs_load as loader


CONFIG_SCHEMA = "planetory.tess-hdfs-runall.v1"
SPARK_IMAGE = "apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1"
JAVA_HOME = "/usr/lib/jvm/java-17-openjdk-amd64"
HADOOP_CONF_DIR = "/etc/hadoop"
HDFS = "/opt/hadoop/bin/hdfs"
PYTHON = "/usr/bin/python3.12"
SSH_KEY = "/etc/planetory/tess-hdfs-runall/id_ed25519"
KNOWN_HOSTS = "/etc/planetory/tess-hdfs-runall/known_hosts"
NODE1_IP = "10.20.1.10"
WORKER_IPS = {slot: f"10.20.{slot + 1}.10" for slot in range(1, 6)}
SPARK_HOSTS = {"master-1": NODE1_IP, **{f"worker-{slot + 1}": ip for slot, ip in WORKER_IPS.items()}}


def run(arguments: list[str], *, check: bool = True, echo: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(arguments, text=True, capture_output=True, check=False)
    if echo and result.stdout:
        print(result.stdout, end="")
    if echo and result.stderr:
        print(result.stderr, end="", file=os.sys.stderr)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(arguments)}")
    return result


def validate_config(value: dict) -> dict:
    if value.get("schema") != CONFIG_SCHEMA:
        raise ValueError("invalid server RunAll config schema")
    if not loader.RUN_ID_RE.fullmatch(str(value.get("run_id", ""))):
        raise ValueError("invalid server RunAll run_id")
    if not loader.SHA256_RE.fullmatch(str(value.get("expected_source_list_sha256", ""))):
        raise ValueError("invalid server RunAll source checksum")
    if not loader.SHA256_RE.fullmatch(str(value.get("expected_coverage_sha256", ""))):
        raise ValueError("invalid server RunAll coverage checksum")
    code_release_id = str(value.get("code_release_id", ""))
    if not loader.RELEASE_ID_RE.fullmatch(code_release_id):
        raise ValueError("invalid server RunAll code release")
    if value.get("code_release") != f"/opt/planetory-hdfs-load/releases/{code_release_id}":
        raise ValueError("server RunAll code release path mismatch")
    target = int(value.get("target_bundle_bytes", 0))
    if not 512 << 20 <= target <= 1 << 30:
        raise ValueError("server RunAll bundle size must be 512 MiB through 1 GiB")
    if int(value.get("minimum_worker_free_gib", 0)) < 80:
        raise ValueError("server RunAll worker free-space floor is too small")
    workers = {int(item.get("slot", 0)): str(item.get("internal_ip", "")) for item in value.get("workers", [])}
    if workers != WORKER_IPS:
        raise ValueError("server RunAll requires the exact five Worker internal IPs")
    coverage = str(value.get("coverage_manifest", ""))
    if not coverage.startswith("/"):
        raise ValueError("server RunAll coverage manifest must be an absolute path")
    return value


def load_config(path: Path) -> dict:
    return validate_config(json.loads(path.read_text(encoding="utf-8")))


def ssh_arguments(worker: dict, command: str) -> list[str]:
    return [
        "/usr/bin/ssh", "-n", "-F", "/dev/null", "-b", NODE1_IP, "-i", SSH_KEY,
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={KNOWN_HOSTS}",
        f"planetory-admin@{worker['internal_ip']}", command,
    ]


def ssh(worker: dict, script: str, *, echo: bool = True) -> subprocess.CompletedProcess[str]:
    payload = base64.b64encode(script.encode()).decode()
    return run(ssh_arguments(worker, f"printf '%s' '{payload}' | base64 --decode | bash"), echo=echo)


def hdfs(arguments: list[str], *, check: bool = True, echo: bool = True) -> subprocess.CompletedProcess[str]:
    return run([
        "/usr/bin/sudo", "-u", "hdfs", "/usr/bin/env",
        f"JAVA_HOME={JAVA_HOME}", f"HADOOP_CONF_DIR={HADOOP_CONF_DIR}",
        HDFS, *arguments,
    ], check=check, echo=echo)


def hdfs_exists(path: str) -> bool:
    return hdfs(["dfs", "-test", "-e", path], check=False, echo=False).returncode == 0


def hdfs_json(path: str) -> dict:
    return json.loads(hdfs(["dfs", "-cat", path], echo=False).stdout)


def context_paths(context: dict) -> tuple[str, str, str]:
    run_id = str(context["run_id"])
    release_id = str(context["release_id"])
    sector = int(context["sector"])
    stage = f"/lake/raw/tess/.staging/run={run_id}/release={release_id}/sector={sector:04d}"
    final = f"/lake/raw/tess/release={release_id}/sector={sector:04d}"
    return stage, final, f"hdfs://planetory{final}"


def safe_mode_is_off(output: str) -> bool:
    lines = [line for line in output.splitlines() if line]
    return bool(lines) and all(line.startswith("Safe mode is OFF") for line in lines)


def preflight(expected_bytes: int) -> None:
    states = [hdfs(["haadmin", "-getServiceState", name], echo=False).stdout.strip() for name in ("nn1", "nn2")]
    if states not in (["active", "standby"], ["standby", "active"]):
        raise RuntimeError(f"invalid HDFS HA state: {':'.join(states)}")
    if hdfs(["getconf", "-confKey", "dfs.replication"], echo=False).stdout.strip() != "2":
        raise RuntimeError("HDFS replication is not 2")
    if hdfs(["getconf", "-confKey", "dfs.datanode.du.reserved"], echo=False).stdout.strip() != "107374182400":
        raise RuntimeError("HDFS DataNode reserve is not 100 GiB")
    if not safe_mode_is_off(hdfs(["dfsadmin", "-safemode", "get"], echo=False).stdout):
        raise RuntimeError("HDFS safe mode is not OFF")
    report = hdfs(["dfsadmin", "-report"], echo=False).stdout
    match = re.search(r"^Live datanodes \((\d+)\):", report, re.MULTILINE)
    if not match or int(match.group(1)) != 5:
        raise RuntimeError("HDFS does not have five live DataNodes")
    fields = hdfs(["dfs", "-df", "/"], echo=False).stdout.splitlines()[-1].split()
    capacity, used_bytes, available = map(int, fields[1:4])
    used_percent = int(fields[4].rstrip("%"))
    if used_percent >= 75:
        raise RuntimeError("HDFS usage is already 75 percent or higher")
    if expected_bytes and (
        used_bytes + expected_bytes * 2 > capacity * 70 // 100
        or available < expected_bytes * 2
    ):
        raise RuntimeError("HDFS capacity is insufficient for the next Sector at RF2")
    print(f"HDFS_PREFLIGHT_OK ha={':'.join(states)} live_datanodes=5 used_percent={used_percent}")


def prepare_stage(context: dict) -> None:
    stage, final, _ = context_paths(context)
    if hdfs_exists(final):
        raise RuntimeError(f"final Sector already exists while preparing stage: {final}")
    hdfs(["dfs", "-mkdir", "-p", f"{stage}/.control"])
    hdfs(["dfs", "-chown", "-R", "planetory-admin:hadoop", stage])
    hdfs(["dfs", "-chmod", "0750", stage, f"{stage}/.control"])
    print(f"STAGE_PREPARED={stage}")


def worker_unit(config: dict, context: dict, worker: dict) -> tuple[str, str]:
    run_id = str(context["run_id"])
    release_id = str(context["release_id"])
    source_sha = str(context["source_list_sha256"])
    sector = int(context["sector"])
    slot = int(worker["slot"])
    stage, _, final_uri = context_paths(context)
    release = str(config["code_release"])
    run_root = f"/mnt/data/staging/S15P21C206-75/run-{run_id}"
    state = f"{run_root}/hdfs-load/sector={sector:04d}"
    unit = f"planetory-tess-hdfs-load-{run_id}-s{sector}-w{slot}.service"
    command = " ".join([
        PYTHON, f"{release}/hdfs/tess_hdfs_runall.py", "worker",
        "--run-root", run_root, "--stage-uri", stage, "--final-uri", final_uri,
        "--code-release", release, "--run-id", run_id, "--release-id", release_id,
        "--source-sha", source_sha, "--sector", str(sector), "--worker-slot", str(slot),
        "--sector-product-count", str(context["product_count"]),
        "--target-bundle-bytes", str(config["target_bundle_bytes"]),
        "--minimum-worker-free-gib", str(config["minimum_worker_free_gib"]),
    ])
    text = f"""[Unit]
Description=Planetory TESS HDFS server RunAll {run_id} sector {sector} worker {slot}
Wants=network-online.target
After=network-online.target hadoop-hdfs-datanode.service
RequiresMountsFor=/mnt/data
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=planetory-admin
WorkingDirectory={release}
Environment=JAVA_HOME={JAVA_HOME}
Environment=HADOOP_CONF_DIR={HADOOP_CONF_DIR}
Environment=PYTHONPATH={release}
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart={command}
Restart=on-failure
RestartSec=30s
TimeoutStartSec=3h
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={state}
"""
    return unit, text


def start_worker(config: dict, context: dict, worker: dict) -> str:
    unit, text = worker_unit(config, context, worker)
    encoded = base64.b64encode(text.encode()).decode()
    state = f"/mnt/data/staging/S15P21C206-75/run-{context['run_id']}/hdfs-load/sector={int(context['sector']):04d}"
    script = f"""set -eu
unit='{unit}'
temporary=/tmp/$unit
cleanup() {{ status=$?; rm -f -- "$temporary"; exit "$status"; }}
trap cleanup EXIT
install -d -m 0750 '{state}'
printf '%s' '{encoded}' | base64 --decode > "$temporary"
sudo install -o root -g root -m 0644 "$temporary" "/etc/systemd/system/$unit"
sudo systemctl daemon-reload
sudo systemd-analyze verify "/etc/systemd/system/$unit"
if sudo systemctl is-active --quiet "$unit"; then
 echo WORKER_UNIT_ACTIVE unit="$unit"
else
 sudo systemctl reset-failed "$unit" >/dev/null 2>&1 || true
 sudo systemctl --no-block start "$unit"
 echo WORKER_UNIT_STARTED unit="$unit"
fi
"""
    ssh(worker, script)
    return unit


def worker_state(worker: dict, unit: str) -> dict[str, str]:
    result = ssh(worker, f"sudo systemctl show '{unit}' --property=LoadState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager", echo=False)
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def wait_workers(config: dict, context: dict, units: dict[int, str]) -> None:
    deadline = time.monotonic() + 3 * 60 * 60
    while True:
        pending = []
        restarts = []
        for worker in config["workers"]:
            slot = int(worker["slot"])
            state = worker_state(worker, units[slot])
            if state.get("LoadState") != "loaded":
                raise RuntimeError(f"Worker {slot} uploader unit is not loaded")
            if state.get("ActiveState") == "inactive" and state.get("Result") == "success" and state.get("ExecMainStatus") == "0":
                restarts.append(f"w{slot}={state.get('NRestarts', 'unknown')}")
                continue
            if state.get("ActiveState") == "failed" or (
                state.get("ActiveState") == "inactive" and state.get("Result") != "success"
            ):
                raise RuntimeError(f"Worker {slot} uploader failed: {state}")
            pending.append(f"w{slot}={state.get('ActiveState')}/{state.get('SubState')}")
        if not pending:
            print(f"UPLOAD_COMPLETE sector={context['sector']} restarts={','.join(restarts)}")
            return
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Worker upload timed out: {','.join(pending)}")
        print(f"UPLOAD_WAIT sector={context['sector']} pending={','.join(pending)}")
        time.sleep(30)


def run_loader_as_hdfs(config: dict, arguments: list[str]) -> subprocess.CompletedProcess[str]:
    release = str(config["code_release"])
    return run([
        "/usr/bin/sudo", "-u", "hdfs", "/usr/bin/env",
        f"JAVA_HOME={JAVA_HOME}", f"HADOOP_CONF_DIR={HADOOP_CONF_DIR}", f"PYTHONPATH={release}",
        PYTHON, f"{release}/hdfs/tess_hdfs_load.py", *arguments,
    ])


def audit(config: dict, context: dict, source: str, output: Path) -> dict:
    _, _, final_uri = context_paths(context)
    arguments = [
        "audit", "--stage-uri", source, "--final-uri", final_uri,
        "--source-sha", str(context["source_list_sha256"]),
        "--run-id", str(context["run_id"]), "--release-id", str(context["release_id"]),
        "--sector", str(context["sector"]), "--output", str(output),
    ]
    for slot in range(1, 6):
        arguments.extend(["--worker-slot", str(slot)])
    run_loader_as_hdfs(config, arguments)
    return json.loads(output.read_text(encoding="utf-8"))


def java_commit(config: dict, source: str, destination: str) -> None:
    release = str(config["code_release"])
    classpath = run([
        "/usr/bin/env", f"JAVA_HOME={JAVA_HOME}", f"HADOOP_CONF_DIR={HADOOP_CONF_DIR}",
        "/opt/hadoop/bin/hadoop", "classpath",
    ], echo=False).stdout.strip()
    run([
        "/usr/bin/sudo", "-u", "hdfs", "/usr/bin/env",
        f"JAVA_HOME={JAVA_HOME}", f"HADOOP_CONF_DIR={HADOOP_CONF_DIR}",
        "/usr/bin/java", "-cp", f"{release}/classes:{classpath}",
        "TessSequenceFileTool", "commit", source, destination,
    ])


def commit_sector(config: dict, context: dict) -> None:
    stage, final, final_uri = context_paths(context)
    with tempfile.TemporaryDirectory(prefix=f"tess-hdfs-s{context['sector']}-") as temporary:
        root = Path(temporary)
        shutil.chown(root, user="hdfs", group="hadoop")
        root.chmod(0o750)
        audit_path = root / "audit.json"
        ready_path = root / "ready.json"
        if hdfs_exists(final):
            result = audit(config, context, final, audit_path)
            ready = hdfs_json(f"{final}/_READY.json")
            loader.validate_ready(ready, {
                "schema": loader.PLAN_SCHEMA,
                "run_id": context["run_id"], "release_id": context["release_id"],
                "source_list_sha256": context["source_list_sha256"], "sector": context["sector"],
                "sector_product_count": result["product_count"], "replication": 2,
            })
            if not hdfs_exists(f"{final}/manifest.parquet/_SUCCESS"):
                raise RuntimeError("cached final Sector has no Parquet success marker")
            print(f"COMMIT_CACHED final={final}")
            return

        if hdfs_exists(f"{stage}/_READY.json.part"):
            hdfs(["dfs", "-rm", "-f", f"{stage}/_READY.json.part"])
        result = audit(config, context, stage, audit_path)
        count = int(result["product_count"])
        if count != int(context["product_count"]):
            raise RuntimeError("Sector audit count differs from coverage")
        if hdfs_exists(f"{stage}/manifest.parquet"):
            hdfs(["dfs", "-rm", "-r", "-skipTrash", f"{stage}/manifest.parquet"])
        spark_script = Path(config["code_release"]) / "hdfs" / "manifest_to_parquet.py"
        run(["/usr/bin/docker", "pull", SPARK_IMAGE])
        docker = ["/usr/bin/docker", "run", "--rm", "--network", "host"]
        for name, ip in SPARK_HOSTS.items():
            docker.extend(["--add-host", f"{name}:{ip}"])
        docker.extend([
            "-e", f"HADOOP_CONF_DIR={HADOOP_CONF_DIR}", "-e", "HADOOP_USER_NAME=planetory-admin",
            "-v", f"{HADOOP_CONF_DIR}:{HADOOP_CONF_DIR}:ro",
            "-v", f"{spark_script}:/opt/planetory/manifest_to_parquet.py:ro",
            "--entrypoint", "/opt/spark/bin/spark-submit", SPARK_IMAGE, "--master", "local[1]",
            "/opt/planetory/manifest_to_parquet.py",
            f"hdfs://planetory{stage}/.control/worker=*/bundle-*.manifest.jsonl",
            f"hdfs://planetory{stage}/manifest.parquet", str(count),
            str(context["source_list_sha256"]), str(context["sector"]),
        ])
        run(docker)
        if not hdfs_exists(f"{stage}/manifest.parquet/_SUCCESS"):
            raise RuntimeError("Spark did not create the Parquet success marker")
        hdfs(["dfs", "-setrep", "-w", "2", f"{stage}/manifest.parquet"])
        ready = {
            "schema": loader.READY_SCHEMA, "run_id": context["run_id"],
            "release_id": context["release_id"], "source_list_sha256": context["source_list_sha256"],
            "sector": int(context["sector"]), "product_count": count, "replication": 2,
        }
        loader.atomic_json(ready_path, ready)
        if hdfs_exists(f"{stage}/_READY.json"):
            hdfs(["dfs", "-rm", "-f", f"{stage}/_READY.json"])
        hdfs(["dfs", "-put", str(ready_path), f"{stage}/_READY.json.part"])
        hdfs(["dfs", "-mv", f"{stage}/_READY.json.part", f"{stage}/_READY.json"])
        hdfs(["dfs", "-mkdir", "-p", f"/lake/raw/tess/release={context['release_id']}"])
        java_commit(config, stage, final)
        if hdfs_json(f"{final}/_READY.json") != ready:
            raise RuntimeError("final Sector ready marker changed during commit")
        fsck = hdfs(["fsck", final, "-files", "-blocks"]).stdout
        if "Status: HEALTHY" not in fsck or not re.search(r"Under-replicated blocks:\s+0", fsck):
            raise RuntimeError("final Sector HDFS fsck failed")
        print(f"COMMIT_OK final={final} products={count}")


def commit_coverage(config: dict) -> None:
    digest = str(config["expected_coverage_sha256"])
    stage = f"/lake/raw/tess/.staging/coverage={digest}/run={config['run_id']}"
    final = f"/lake/raw/tess/coverage={digest}"
    with tempfile.TemporaryDirectory(prefix="tess-hdfs-coverage-") as temporary:
        shutil.chown(temporary, user="hdfs", group="hadoop")
        Path(temporary).chmod(0o750)
        ready_path = Path(temporary) / "ready.json"
        run_loader_as_hdfs(config, [
            "coverage-ready", "--coverage-manifest", str(config["coverage_manifest"]),
            "--expected-sha", digest, "--output", str(ready_path),
        ])
        ready = json.loads(ready_path.read_text(encoding="utf-8"))
        if hdfs_exists(final):
            if hdfs_json(f"{final}/_READY.json") != ready:
                raise RuntimeError("existing HDFS coverage marker conflicts with validated coverage")
            print(f"COVERAGE_COMMIT_CACHED final={final}")
            return
        hdfs(["dfs", "-mkdir", "-p", stage])
        found = set(hdfs(["dfs", "-find", stage]).stdout.splitlines())
        allowed = {stage, f"{stage}/_READY.json", f"{stage}/_READY.json.part"}
        if found - allowed:
            raise RuntimeError(f"unexpected HDFS coverage staging artifacts: {sorted(found - allowed)}")
        if hdfs_exists(f"{stage}/_READY.json"):
            if hdfs_json(f"{stage}/_READY.json") != ready:
                raise RuntimeError("staged HDFS coverage marker conflicts with validated coverage")
        else:
            if hdfs_exists(f"{stage}/_READY.json.part"):
                hdfs(["dfs", "-rm", "-f", f"{stage}/_READY.json.part"])
            hdfs(["dfs", "-put", str(ready_path), f"{stage}/_READY.json.part"])
            hdfs(["dfs", "-mv", f"{stage}/_READY.json.part", f"{stage}/_READY.json"])
        java_commit(config, stage, final)
        if hdfs_json(f"{final}/_READY.json") != ready:
            raise RuntimeError("HDFS coverage marker changed during commit")
        print(f"COVERAGE_COMMIT_OK final={final}")


def coordinator(config: dict) -> None:
    coverage = loader.load_coverage_map(Path(config["coverage_manifest"]), config["expected_coverage_sha256"])
    contexts = list(coverage["sectors"])
    expansion = [item for item in contexts if item["run_id"] == config["run_id"]]
    if not expansion or any(item["source_list_sha256"] != config["expected_source_list_sha256"] for item in expansion):
        raise RuntimeError("coverage does not match the requested expansion run")
    for context in contexts:
        preflight(int(context["total_bytes"]))
        _, final, _ = context_paths(context)
        print(f"RUN_ALL_SECTOR_START sector={context['sector']} run={context['run_id']}")
        if not hdfs_exists(final):
            prepare_stage(context)
            units = {int(worker["slot"]): start_worker(config, context, worker) for worker in config["workers"]}
            wait_workers(config, context, units)
        commit_sector(config, context)
        print(f"RUN_ALL_SECTOR_COMPLETE sector={context['sector']}")
    commit_coverage(config)
    print("RUN_ALL_COMPLETE sectors=" + ",".join(str(item["sector"]) for item in contexts))


def worker(arguments: argparse.Namespace) -> None:
    run_root = Path(arguments.run_root)
    raw_root = run_root / "raw"
    sector_root = raw_root / f"sector={arguments.sector:04d}"
    if next(sector_root.glob("*.part"), None):
        raise RuntimeError("partial source file remains in the Sector")
    if shutil.disk_usage(run_root).free < arguments.minimum_worker_free_gib * (1 << 30):
        raise RuntimeError("Worker source disk is below the free-space floor")
    state = run_root / "hdfs-load" / f"sector={arguments.sector:04d}"
    plan_path = state / f"worker-{arguments.worker_slot}.plan.json"
    plan = loader.build_plan(
        run_root / "manifests" / "tess-service-v1.json",
        run_root / "manifests" / f"sector-{arguments.sector}-worker-{arguments.worker_slot}.events.jsonl",
        run_root / "manifests" / f"sector-{arguments.sector}-worker-{arguments.worker_slot}.audit.json",
        raw_root, worker_slot=arguments.worker_slot, sector=arguments.sector,
        target_bundle_bytes=arguments.target_bundle_bytes,
        run_id=arguments.run_id, release_id=arguments.release_id,
    )
    if plan["source_list_sha256"] != arguments.source_sha:
        raise RuntimeError("Worker source checksum differs from coverage")
    if int(plan["sector_product_count"]) != arguments.sector_product_count:
        raise RuntimeError("Worker Sector count differs from coverage")
    loader.atomic_json(plan_path, plan)
    remote = f"{arguments.stage_uri}/.control/worker={arguments.worker_slot}/plan.json"
    run([HDFS, "dfs", "-mkdir", "-p", str(Path(remote).parent)])
    if run([HDFS, "dfs", "-test", "-e", remote], check=False).returncode == 0:
        existing = json.loads(run([HDFS, "dfs", "-cat", remote], echo=False).stdout)
        if existing != plan:
            raise RuntimeError("HDFS worker plan conflicts with the deterministic local plan")
    else:
        part = remote + ".part"
        run([HDFS, "dfs", "-rm", "-f", part], check=False)
        run([HDFS, "dfs", "-put", str(plan_path), part])
        run([HDFS, "dfs", "-mv", part, remote])
    loader.upload_plan(plan_path, arguments.stage_uri, arguments.final_uri, Path(arguments.code_release) / "classes", HDFS)
    print(f"WORKER_COMPLETE sector={arguments.sector} worker={arguments.worker_slot}")


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    runall = commands.add_parser("runall")
    runall.add_argument("--config", type=Path, required=True)
    upload = commands.add_parser("worker")
    upload.add_argument("--run-root", required=True)
    upload.add_argument("--stage-uri", required=True)
    upload.add_argument("--final-uri", required=True)
    upload.add_argument("--code-release", required=True)
    upload.add_argument("--run-id", required=True)
    upload.add_argument("--release-id", required=True)
    upload.add_argument("--source-sha", required=True)
    upload.add_argument("--sector", type=int, required=True)
    upload.add_argument("--worker-slot", type=int, required=True)
    upload.add_argument("--sector-product-count", type=int, required=True)
    upload.add_argument("--target-bundle-bytes", type=int, required=True)
    upload.add_argument("--minimum-worker-free-gib", type=int, required=True)
    arguments = parser.parse_args()
    if arguments.command == "runall":
        coordinator(load_config(arguments.config))
    else:
        worker(arguments)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

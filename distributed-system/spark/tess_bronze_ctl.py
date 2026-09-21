"""Node 1 control plane for resumable Raw-to-Bronze Sector conversion."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SPARK_IMAGE = "apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1"
SPARK_HDFS_USER = "planetory-admin"
BRONZE_READY_SCHEMA = "planetory.tess-bronze-sector.v1"
BRONZE_COVERAGE_SCHEMA = "planetory.tess-bronze-coverage.v1"
BRONZE_DATA_SCHEMA = "planetory.tess-bronze.v1"
RAW_READY_SCHEMA = "planetory.tess-hdfs-release.v1"
RAW_COVERAGE_SCHEMA = "planetory.tess-hdfs-coverage.v1"
RAW_COVERAGE_SHA256 = "df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94"
RAW_RELEASES = {**{sector: "20260919T005932Z" for sector in range(1, 14)},
                3: "20260918T080417Z", 4: "20260918T080417Z", 5: "20260918T080417Z"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
APP_ID_RE = re.compile(r"application_[0-9]+_[0-9]+")
DATA_CONTRACT_EXIT_CODE = 65
HOST_ARGS = [item for number in range(1, 7)
             for item in ("--add-host", f"{'master' if number == 1 else 'worker'}-{number}:10.20.{number}.10")]


class BronzeDataContractError(RuntimeError):
    """A deterministic input/output contract violation that operator action must fix."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(arguments: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(arguments, input=input_text, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n", flush=True)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(arguments[:4])}")
    return result


def hdfs(*arguments: str, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run([
        "sudo", "-u", "hdfs", "env",
        "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64",
        "HADOOP_CONF_DIR=/etc/hadoop",
        "/opt/hadoop/bin/hdfs", *arguments,
    ], input_text=input_text, check=check)


def yarn(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run([
        "sudo", "-u", "yarn", "env",
        "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64",
        "HADOOP_CONF_DIR=/etc/hadoop",
        "/opt/hadoop/bin/yarn", *arguments,
    ], check=check)


def hdfs_exists(path: str) -> bool:
    return hdfs("dfs", "-test", "-e", path, check=False).returncode == 0


def hdfs_json(path: str) -> tuple[dict[str, Any], str]:
    result = hdfs("dfs", "-cat", path)
    payload = result.stdout.encode("utf-8")
    return json.loads(payload), hashlib.sha256(payload).hexdigest()


def raw_context(sector: int) -> dict[str, Any]:
    release = RAW_RELEASES[sector]
    path = f"/lake/raw/tess/release={release}/sector={sector:04d}"
    ready, ready_sha = hdfs_json(f"{path}/_READY.json")
    expected = {
        "schema": RAW_READY_SCHEMA,
        "sector": sector,
        "release_id": release,
        "replication": 2,
    }
    for key, value in expected.items():
        if ready.get(key) != value:
            raise BronzeDataContractError(f"Raw ready mismatch sector={sector} field={key}")
    if int(ready.get("product_count", 0)) <= 0 or not SHA256_RE.fullmatch(
        str(ready.get("source_list_sha256", ""))
    ):
        raise BronzeDataContractError(f"Raw ready counts/checksum invalid sector={sector}")
    if not hdfs_exists(f"{path}/manifest.parquet/_SUCCESS"):
        raise BronzeDataContractError(f"Raw manifest is not complete sector={sector}")
    return {"release": release, "path": path, "ready": ready, "ready_sha256": ready_sha}


def validate_raw_coverage(value: dict[str, Any], contexts: dict[int, dict[str, Any]]) -> None:
    expected_sectors = set(range(1, 14))
    rows = value.get("sectors", [])
    by_sector = {int(row.get("sector", -1)): row for row in rows}
    expected_products = sum(int(contexts[sector]["ready"]["product_count"]) for sector in expected_sectors)
    if (
        value.get("schema") != RAW_COVERAGE_SCHEMA
        or value.get("source_coverage_sha256") != RAW_COVERAGE_SHA256
        or int(value.get("replication", -1)) != 2
        or int(value.get("expected", -1)) != expected_products
        or int(value.get("validated", -1)) != expected_products
        or len(rows) != 13
        or set(by_sector) != expected_sectors
    ):
        raise BronzeDataContractError("Raw coverage marker does not prove Sector 1 through 13")
    for sector, context in contexts.items():
        row = by_sector[sector]
        expected = {
            "location": context["path"],
            "release_id": context["release"],
            "sector": sector,
            "source_list_sha256": context["ready"]["source_list_sha256"],
            "product_count": context["ready"]["product_count"],
            "ready_sha256": context["ready_sha256"],
        }
        if any(row.get(key) != expected_value for key, expected_value in expected.items()):
            raise BronzeDataContractError(f"Raw coverage mismatch sector={sector}")


def raw_coverage(contexts: dict[int, dict[str, Any]]) -> tuple[dict[str, Any], str]:
    path = f"/lake/raw/tess/coverage={RAW_COVERAGE_SHA256}/_READY.json"
    value, ready_sha256 = hdfs_json(path)
    validate_raw_coverage(value, contexts)
    print(f"BRONZE_RAW_COVERAGE_OK products={value['validated']} path={path}", flush=True)
    return value, ready_sha256


def cluster_preflight(sectors: list[int], *, allow_running: bool = False) -> dict[int, dict[str, Any]]:
    nn1 = hdfs("haadmin", "-getServiceState", "nn1").stdout.strip()
    nn2 = hdfs("haadmin", "-getServiceState", "nn2").stdout.strip()
    if f"{nn1}:{nn2}" not in ("active:standby", "standby:active"):
        raise RuntimeError(f"invalid HDFS HA state: {nn1}:{nn2}")
    safe = hdfs("dfsadmin", "-safemode", "get").stdout
    if safe.count("Safe mode is OFF") != 2:
        raise RuntimeError("HDFS safe mode is not OFF on both NameNodes")
    report = hdfs("dfsadmin", "-report").stdout
    live = re.search(r"Live datanodes \((\d+)\)", report)
    if not live or int(live.group(1)) != 5:
        raise RuntimeError("expected five live DataNodes")
    used = hdfs("dfs", "-df", "/").stdout.splitlines()
    if len(used) < 2 or int(used[-1].split()[-1].rstrip("%")) >= 75:
        raise RuntimeError("HDFS usage is at or above 75%")
    nodes = yarn("node", "-list", "-all").stdout
    if len(re.findall(r"\sRUNNING\s", nodes)) != 5:
        raise RuntimeError("expected five RUNNING NodeManagers")
    applications = yarn("application", "-list", "-appStates", "RUNNING").stdout
    running = APP_ID_RE.findall(applications)
    if running and not allow_running:
        raise RuntimeError(f"another YARN application is running: {','.join(running)}")
    contexts = {sector: raw_context(sector) for sector in sectors}
    print(
        f"BRONZE_PREFLIGHT_OK sectors={','.join(map(str, sectors))} "
        f"ha={nn1}:{nn2} live_datanodes=5 running_apps={len(running)}",
        flush=True,
    )
    return contexts


def build_runtime(release_dir: Path) -> str:
    requirements = release_dir / "spark" / "requirements.txt"
    kernel = release_dir / "astro_kernel"
    if not requirements.is_file() or not kernel.is_dir():
        raise RuntimeError("release is missing requirements or astro_kernel")
    identity = hashlib.sha256(requirements.read_bytes())
    for path in sorted(kernel.rglob("*.py")):
        identity.update(path.relative_to(kernel).as_posix().encode())
        identity.update(path.read_bytes())
    runtime_id = identity.hexdigest()
    local_root = Path("/opt/planetory-bronze/runtime") / runtime_id
    archive = local_root / "python-deps.tar.gz"
    remote = f"/lake/bronze/tess/.runtime/python-deps-{runtime_id}.tar.gz"
    if archive.is_file() and hdfs_exists(remote):
        print(f"BRONZE_RUNTIME_CACHED hdfs={remote}", flush=True)
        return remote

    local_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="bronze-runtime-", dir="/var/tmp") as temp:
        deps = Path(temp) / "deps"
        deps.mkdir()
        run([
            "docker", "run", "--rm", "--user", "0:0",
            "-v", f"{requirements}:/runtime/requirements.txt:ro",
            "-v", f"{deps}:/runtime/deps",
            "--entrypoint", "/bin/bash", SPARK_IMAGE, "-c",
            "python3 -m pip install --disable-pip-version-check pip==24.3.1 && "
            "python3 -m pip install --disable-pip-version-check --no-compile "
            "--only-binary=:all: --platform manylinux_2_28_x86_64 "
            "--platform manylinux_2_17_x86_64 --platform manylinux2014_x86_64 --implementation cp "
            "--python-version 3.12 --abi cp312 --abi abi3 --abi none "
            "--target /runtime/deps --requirement /runtime/requirements.txt",
        ])
        shutil.copytree(kernel, deps / "astro_kernel")
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(deps)
        result = subprocess.run([
            "/usr/bin/python3.12", "-c",
            "import astropy,numpy,astro_kernel; print(astropy.__version__,numpy.__version__)",
        ], env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        print(result.stdout, end="", flush=True)
        if result.returncode:
            raise RuntimeError("runtime import smoke test failed")
        run([
            "tar", "--sort=name", "--mtime=UTC 1970-01-01", "--owner=0", "--group=0",
            "--numeric-owner", "-czf", str(archive), "-C", str(deps), ".",
        ])
    hdfs("dfs", "-mkdir", "-p", "/lake/bronze/tess/.runtime")
    if not hdfs_exists(remote):
        hdfs("dfs", "-put", str(archive), remote)
    hdfs("dfs", "-setrep", "-w", "2", remote)
    print(f"BRONZE_RUNTIME_OK id={runtime_id} hdfs={remote}", flush=True)
    return remote


def state_path(state_root: Path, run_id: str, sector: int) -> Path:
    return state_root / f"run={run_id}" / f"sector={sector:04d}.json"


def prepare_spark_paths(output: str, run_id: str, sector: int) -> None:
    spark_staging = f"/lake/bronze/tess/.spark-staging/run={run_id}/sector={sector:04d}"
    hdfs("dfs", "-mkdir", "-p", output, spark_staging)
    hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", output, spark_staging)
    hdfs("dfs", "-chmod", "0750", output, spark_staging)
    print(f"BRONZE_SPARK_PATHS_READY output={output} spark_staging={spark_staging}", flush=True)


def write_state(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def application_state(application_id: str) -> str:
    output = yarn("application", "-status", application_id, check=False).stdout
    match = re.search(r"\bState\s*:\s*([A-Z]+)", output)
    final = re.search(r"\bFinal-State\s*:\s*([A-Z]+)", output)
    if final and final.group(1) not in ("UNDEFINED", "UNDEFINED_FINAL_STATE"):
        return final.group(1)
    return match.group(1) if match else "UNKNOWN"


def wait_application(application_id: str, poll_seconds: int = 30) -> None:
    while True:
        state = application_state(application_id)
        print(f"BRONZE_APPLICATION_STATUS id={application_id} state={state}", flush=True)
        if state == "SUCCEEDED":
            return
        if state in ("FAILED", "KILLED"):
            raise RuntimeError(f"YARN application {application_id} ended as {state}")
        if state == "UNKNOWN":
            raise RuntimeError(f"cannot determine YARN application state: {application_id}")
        time.sleep(poll_seconds)


def submit(
    *,
    release_dir: Path,
    runtime_hdfs: str,
    context: dict[str, Any],
    sector: int,
    run_id: str,
    pipeline_version: str,
    output: str,
    output_partitions: int,
    state_file: Path,
    state: dict[str, Any],
    canary_products: int = 0,
) -> str:
    ready = context["ready"]
    job = release_dir / "spark" / "tess_bronze.py"
    app_name = f"S15P21C206-77-bronze-{run_id}-s{sector:04d}"
    command = [
        "sudo", "docker", "run", "--rm", "--network", "host", *HOST_ARGS,
        "-e", "HADOOP_CONF_DIR=/etc/hadoop", "-e", "YARN_CONF_DIR=/etc/hadoop",
        "-e", f"HADOOP_USER_NAME={SPARK_HDFS_USER}",
        "-v", "/etc/hadoop:/etc/hadoop:ro", "-v", f"{job}:/opt/planetory/tess_bronze.py:ro",
        "--entrypoint", "/opt/spark/bin/spark-submit", SPARK_IMAGE,
        "--master", "yarn", "--deploy-mode", "cluster", "--name", app_name,
        "--archives", f"hdfs://planetory{runtime_hdfs}#environment",
        "--conf", "spark.driver.port=7078", "--conf", "spark.blockManager.port=7079",
        "--conf", f"spark.yarn.stagingDir=hdfs://planetory/lake/bronze/tess/.spark-staging/run={run_id}/sector={sector:04d}",
        "--conf", "spark.executor.instances=5", "--conf", "spark.executor.cores=2",
        "--conf", "spark.executor.memory=6g", "--conf", "spark.executor.memoryOverhead=2048",
        "--conf", "spark.driver.memory=2g", "--conf", "spark.driver.memoryOverhead=1024",
        "--conf", "spark.pyspark.python=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.appMasterEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.maxAppAttempts=1", "--conf", "spark.speculation=false",
        "/opt/planetory/tess_bronze.py",
        "--raw-path", f"hdfs://planetory{context['path']}",
        "--raw-release", context["release"],
        "--raw-ready-sha256", context["ready_sha256"],
        "--source-list-sha256", ready["source_list_sha256"],
        "--sector", str(sector), "--expected-products", str(ready["product_count"]),
        "--pipeline-version", pipeline_version, "--run-id", run_id,
        "--output", f"hdfs://planetory{output}", "--output-partitions", str(output_partitions),
    ]
    if canary_products:
        command.extend(["--canary-products", str(canary_products)])
    process = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    application_id = None
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="", flush=True)
        matches = APP_ID_RE.findall(line)
        if matches and application_id is None:
            application_id = matches[-1]
            state.update(application_id=application_id, status="submitted", updated_at_utc=utc_now())
            write_state(state_file, state)
    return_code = process.wait()
    if return_code:
        raise RuntimeError(f"spark-submit failed with exit {return_code}")
    if not application_id:
        raise RuntimeError("spark-submit did not report an application id")
    wait_application(application_id)
    return application_id


def part_checksum_digest(path: str) -> tuple[int, str]:
    listing = hdfs("dfs", "-ls", f"{path}/part-*.parquet").stdout
    parts = sorted(
        fields[-1]
        for line in listing.splitlines()
        if (fields := line.split()) and fields[-1].split("/")[-1].startswith("part-")
        and fields[-1].endswith(".parquet")
    )
    if not parts:
        raise RuntimeError(f"no Parquet parts in {path}")
    rows = []
    for part in parts:
        output = hdfs("dfs", "-checksum", part).stdout.strip().split()
        if len(output) < 3:
            raise RuntimeError(f"invalid checksum output for {part}")
        rows.append("\t".join((part.split("/")[-1], output[-2], output[-1])))
    digest = hashlib.sha256(("\n".join(sorted(rows)) + "\n").encode()).hexdigest()
    return len(parts), digest


def fsck_healthy(path: str) -> None:
    result = hdfs("fsck", path, "-files", "-blocks", "-locations")
    text = result.stdout
    if "is HEALTHY" not in text or not re.search(r"Under[- ]replicated blocks:\s*0", text):
        raise RuntimeError(f"incomplete FSCK output for {path}")
    if re.search(
        r"Under[- ]replicated blocks:\s*[1-9]|Missing blocks:\s*[1-9]|Corrupt blocks:\s*[1-9]",
        text,
    ):
        raise RuntimeError(f"unhealthy HDFS blocks for {path}")


def audit_final(sector: int, context: dict[str, Any], pipeline_version: str) -> bool:
    final = f"/lake/bronze/tess/sector={sector:04d}"
    if not hdfs_exists(final):
        return False
    ready, _ = hdfs_json(f"{final}/_READY.json")
    expected = {
        "schema": BRONZE_READY_SCHEMA,
        "data_schema": BRONZE_DATA_SCHEMA,
        "sector": sector,
        "raw_path": context["path"],
        "raw_release": context["release"],
        "raw_ready_sha256": context["ready_sha256"],
        "source_list_sha256": context["ready"]["source_list_sha256"],
        "product_count": context["ready"]["product_count"],
        "pipeline_version": pipeline_version,
        "replication": 2,
    }
    for key, value in expected.items():
        if ready.get(key) != value:
            raise BronzeDataContractError(f"existing Bronze mismatch sector={sector} field={key}")
    count, digest = part_checksum_digest(final)
    if ready.get("part_file_count") != count or ready.get("part_checksums_sha256") != digest:
        raise BronzeDataContractError(f"existing Bronze part checksum mismatch sector={sector}")
    fsck_healthy(final)
    print(f"BRONZE_CACHED sector={sector} products={ready['product_count']}", flush=True)
    return True


def atomic_commit(release_dir: Path, staging_data: str, final: str) -> None:
    classpath = run([
        "env", "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
        "/opt/hadoop/bin/hadoop", "classpath",
    ]).stdout.strip()
    run([
        "sudo", "-u", "hdfs", "env",
        "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
        "java", "-cp", f"{release_dir / 'classes'}:{classpath}",
        "TessSequenceFileTool", "commit", staging_data, final,
    ])


def finalize_sector(
    *,
    release_dir: Path,
    context: dict[str, Any],
    sector: int,
    run_id: str,
    pipeline_version: str,
    output: str,
    application_id: str,
) -> dict[str, Any]:
    summary_lines = hdfs("dfs", "-cat", f"{output}/summary/part-*.json").stdout.splitlines()
    if len(summary_lines) != 1:
        raise RuntimeError(f"expected one summary row sector={sector}")
    summary = json.loads(summary_lines[0])
    expected_count = int(context["ready"]["product_count"])
    if not summary.get("contract_ok") or int(summary.get("success_products", -1)) != expected_count:
        print(f"BRONZE_PARSE_ERRORS sector={sector} errors={summary.get('error_products')} path={output}/errors")
        raise BronzeDataContractError(f"Bronze conversion contract failed sector={sector}")

    staging_data = f"{output}/data"
    hdfs("dfs", "-setrep", "-w", "2", staging_data)
    part_count, part_digest = part_checksum_digest(staging_data)
    ready = {
        "schema": BRONZE_READY_SCHEMA,
        "data_schema": BRONZE_DATA_SCHEMA,
        "sector": sector,
        "raw_path": context["path"],
        "raw_release": context["release"],
        "raw_ready_sha256": context["ready_sha256"],
        "source_list_sha256": context["ready"]["source_list_sha256"],
        "input_snapshot_count": int(summary["input_snapshot_count"]),
        "input_snapshots_sha256": summary["input_snapshots_sha256"],
        "pipeline_version": pipeline_version,
        "run_id": run_id,
        "spark_application_id": application_id,
        "product_count": expected_count,
        "observation_count": int(summary["observation_count"]),
        "parse_error_count": 0,
        "part_file_count": part_count,
        "part_checksums_sha256": part_digest,
        "replication": 2,
        "completed_at_utc": utc_now(),
    }
    marker = json.dumps(ready, sort_keys=True, separators=(",", ":")) + "\n"
    hdfs("dfs", "-put", "-", f"{staging_data}/_READY.json.part", input_text=marker)
    hdfs("dfs", "-mv", f"{staging_data}/_READY.json.part", f"{staging_data}/_READY.json")
    fsck_healthy(staging_data)
    final = f"/lake/bronze/tess/sector={sector:04d}"
    if hdfs_exists(final):
        raise BronzeDataContractError(f"final Bronze path appeared before commit: {final}")
    atomic_commit(release_dir, staging_data, final)
    fsck_healthy(final)
    if not audit_final(sector, context, pipeline_version):
        raise BronzeDataContractError(f"final audit did not find sector={sector}")
    hdfs("dfs", "-rm", "-r", "-skipTrash", output)
    print(f"BRONZE_COMMIT_OK sector={sector} products={expected_count} final={final}", flush=True)
    return ready


def commit_coverage(
    *,
    release_dir: Path,
    contexts: dict[int, dict[str, Any]],
    raw_coverage_ready_sha256: str,
    run_id: str,
    pipeline_version: str,
) -> None:
    sectors = []
    for sector in range(1, 14):
        if not audit_final(sector, contexts[sector], pipeline_version):
            raise RuntimeError(f"Bronze coverage is missing sector={sector}")
        location = f"/lake/bronze/tess/sector={sector:04d}"
        ready, ready_sha256 = hdfs_json(f"{location}/_READY.json")
        sectors.append({
            "sector": sector,
            "location": location,
            "ready_sha256": ready_sha256,
            "product_count": int(ready["product_count"]),
            "observation_count": int(ready["observation_count"]),
        })
    stable = {
        "schema": BRONZE_COVERAGE_SCHEMA,
        "source_coverage_sha256": RAW_COVERAGE_SHA256,
        "raw_coverage_ready_sha256": raw_coverage_ready_sha256,
        "pipeline_version": pipeline_version,
        "product_count": sum(row["product_count"] for row in sectors),
        "observation_count": sum(row["observation_count"] for row in sectors),
        "replication": 2,
        "sectors": sectors,
    }
    final = f"/lake/bronze/tess/coverage={RAW_COVERAGE_SHA256}"
    if hdfs_exists(final):
        existing, _ = hdfs_json(f"{final}/_READY.json")
        if any(existing.get(key) != value for key, value in stable.items()):
            raise BronzeDataContractError("existing Bronze coverage marker conflicts with Sector finals")
        fsck_healthy(final)
        print(f"BRONZE_COVERAGE_CACHED products={stable['product_count']} final={final}", flush=True)
        return

    stage = f"/lake/bronze/tess/.staging/coverage={RAW_COVERAGE_SHA256}/run={run_id}"
    hdfs("dfs", "-mkdir", "-p", stage)
    found = set(hdfs("dfs", "-find", stage).stdout.splitlines())
    allowed = {stage, f"{stage}/_READY.json", f"{stage}/_READY.json.part"}
    if found - allowed:
        raise RuntimeError(f"unexpected Bronze coverage staging artifacts: {sorted(found - allowed)}")
    if hdfs_exists(f"{stage}/_READY.json.part"):
        hdfs("dfs", "-rm", "-f", f"{stage}/_READY.json.part")
    if hdfs_exists(f"{stage}/_READY.json"):
        marker, _ = hdfs_json(f"{stage}/_READY.json")
        if any(marker.get(key) != value for key, value in stable.items()):
            raise BronzeDataContractError("staged Bronze coverage marker conflicts with Sector finals")
    else:
        marker = {
            **stable,
            "run_id": run_id,
            "completed_at_utc": utc_now(),
        }
        payload = json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n"
        hdfs("dfs", "-put", "-", f"{stage}/_READY.json.part", input_text=payload)
        hdfs("dfs", "-mv", f"{stage}/_READY.json.part", f"{stage}/_READY.json")
    hdfs("dfs", "-setrep", "-w", "2", stage)
    fsck_healthy(stage)
    atomic_commit(release_dir, stage, final)
    committed, _ = hdfs_json(f"{final}/_READY.json")
    if committed != marker:
        raise RuntimeError("Bronze coverage marker changed during commit")
    fsck_healthy(final)
    print(f"BRONZE_COVERAGE_COMMIT_OK products={stable['product_count']} final={final}", flush=True)


def run_sector(
    *,
    release_dir: Path,
    runtime_hdfs: str,
    context: dict[str, Any],
    sector: int,
    run_id: str,
    pipeline_version: str,
    output_partitions: int,
    state_root: Path,
) -> dict[str, Any]:
    if audit_final(sector, context, pipeline_version):
        ready, _ = hdfs_json(f"/lake/bronze/tess/sector={sector:04d}/_READY.json")
        return ready
    attempt = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = f"/lake/bronze/tess/.staging/run={run_id}/sector={sector:04d}/attempt={attempt}"
    state_file = state_path(state_root, run_id, sector)
    state = {
        "run_id": run_id,
        "sector": sector,
        "attempt": attempt,
        "output": output,
        "status": "prepared",
        "updated_at_utc": utc_now(),
    }
    write_state(state_file, state)
    prepare_spark_paths(output, run_id, sector)
    application_id = submit(
        release_dir=release_dir,
        runtime_hdfs=runtime_hdfs,
        context=context,
        sector=sector,
        run_id=run_id,
        pipeline_version=pipeline_version,
        output=output,
        output_partitions=output_partitions,
        state_file=state_file,
        state=state,
    )
    state.update(status="application_succeeded", application_id=application_id, updated_at_utc=utc_now())
    write_state(state_file, state)
    try:
        ready = finalize_sector(
            release_dir=release_dir,
            context=context,
            sector=sector,
            run_id=run_id,
            pipeline_version=pipeline_version,
            output=output,
            application_id=application_id,
        )
    except BronzeDataContractError as exc:
        state.update(
            status="terminal_failed",
            failure_type=type(exc).__name__,
            failure_detail=str(exc),
            updated_at_utc=utc_now(),
        )
        write_state(state_file, state)
        raise
    state.update(status="complete", updated_at_utc=utc_now())
    write_state(state_file, state)
    return ready


def command_canary(args: argparse.Namespace) -> None:
    release_dir = Path(args.release_dir).resolve()
    context = cluster_preflight([args.sector])[args.sector]
    runtime_hdfs = build_runtime(release_dir)
    output = f"/validation/S15P21C206-77/run={args.run_id}/sector={args.sector:04d}"
    if hdfs_exists(output):
        raise BronzeDataContractError(f"canary output already exists: {output}")
    state_file = state_path(Path(args.state_root), args.run_id, args.sector)
    state = {
        "run_id": args.run_id,
        "sector": args.sector,
        "output": output,
        "status": "canary_prepared",
        "updated_at_utc": utc_now(),
    }
    write_state(state_file, state)
    prepare_spark_paths(output, args.run_id, args.sector)
    application_id = submit(
        release_dir=release_dir,
        runtime_hdfs=runtime_hdfs,
        context=context,
        sector=args.sector,
        run_id=args.run_id,
        pipeline_version=args.pipeline_version,
        output=output,
        output_partitions=1,
        state_file=state_file,
        state=state,
        canary_products=args.canary_products,
    )
    summary_lines = hdfs("dfs", "-cat", f"{output}/summary/part-*.json").stdout.splitlines()
    if len(summary_lines) != 1:
        raise RuntimeError("canary summary row is missing")
    summary = json.loads(summary_lines[0])
    if not summary.get("contract_ok") or int(summary.get("error_products", -1)) != 0:
        raise BronzeDataContractError(f"canary contract failed; inspect {output}/errors")
    if int(summary.get("success_products", 0)) <= 0:
        raise RuntimeError("canary produced no products")
    state.update(status="canary_complete", application_id=application_id, updated_at_utc=utc_now())
    write_state(state_file, state)
    hdfs("dfs", "-rm", "-r", "-skipTrash", output)
    print(
        f"BRONZE_CANARY_OK sector={args.sector} products={summary['success_products']} "
        f"observations={summary['observation_count']} application_id={application_id}",
        flush=True,
    )


def command_preflight(args: argparse.Namespace) -> None:
    contexts = cluster_preflight(args.sectors)
    if set(args.sectors) == set(range(1, 14)):
        raw_coverage(contexts)


def command_run_all(args: argparse.Namespace) -> None:
    release_dir = Path(args.release_dir).resolve()
    contexts = cluster_preflight(args.sectors)
    full_coverage = set(args.sectors) == set(range(1, 14))
    raw_coverage_ready_sha256 = None
    if full_coverage:
        _, raw_coverage_ready_sha256 = raw_coverage(contexts)
    runtime_hdfs = build_runtime(release_dir)
    hdfs("dfs", "-mkdir", "-p", "/lake/bronze/tess/.staging", "/lake/bronze/tess/.spark-staging")
    completed = []
    for sector in args.sectors:
        cluster_preflight([sector], allow_running=False)
        run_sector(
            release_dir=release_dir,
            runtime_hdfs=runtime_hdfs,
            context=contexts[sector],
            sector=sector,
            run_id=args.run_id,
            pipeline_version=args.pipeline_version,
            output_partitions=args.output_partitions,
            state_root=Path(args.state_root),
        )
        completed.append(sector)
    if full_coverage:
        assert raw_coverage_ready_sha256 is not None
        commit_coverage(
            release_dir=release_dir,
            contexts=contexts,
            raw_coverage_ready_sha256=raw_coverage_ready_sha256,
            run_id=args.run_id,
            pipeline_version=args.pipeline_version,
        )
    print(f"BRONZE_RUN_ALL_OK sectors={','.join(map(str, completed))}", flush=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subparsers = root.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--sector", dest="sectors", type=int, action="append", required=True)
    preflight.set_defaults(handler=command_preflight)
    canary = subparsers.add_parser("canary")
    canary.add_argument("--release-dir", required=True)
    canary.add_argument("--run-id", required=True)
    canary.add_argument("--pipeline-version", required=True)
    canary.add_argument("--sector", type=int, required=True)
    canary.add_argument("--canary-products", type=int, default=5)
    canary.add_argument("--state-root", default="/var/lib/planetory-bronze-canary")
    canary.set_defaults(handler=command_canary, sectors=None)
    run_all = subparsers.add_parser("run-all")
    run_all.add_argument("--release-dir", required=True)
    run_all.add_argument("--run-id", required=True)
    run_all.add_argument("--pipeline-version", required=True)
    run_all.add_argument("--sector", dest="sectors", type=int, action="append", required=True)
    run_all.add_argument("--output-partitions", type=int, default=40)
    run_all.add_argument("--state-root", default="/var/lib/planetory-bronze")
    run_all.set_defaults(handler=command_run_all)
    return root


def main() -> int:
    args = parser().parse_args()
    sectors = args.sectors if getattr(args, "sectors", None) is not None else [args.sector]
    if any(sector not in range(1, 14) for sector in sectors):
        raise SystemExit("sectors must be in 1..13")
    if len(set(sectors)) != len(sectors):
        raise SystemExit("duplicate sector")
    if getattr(args, "canary_products", 1) <= 0:
        raise SystemExit("canary products must be positive")
    args.handler(args)
    return 0


def cli() -> int:
    try:
        return main()
    except BronzeDataContractError as exc:
        print(
            f"BRONZE_DATA_CONTRACT_FAILED type={type(exc).__name__} detail={exc}",
            file=sys.stderr,
            flush=True,
        )
        return DATA_CONTRACT_EXIT_CODE
    except Exception as exc:
        print(f"BRONZE_CONTROL_FAILED type={type(exc).__name__} detail={exc}", file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    raise SystemExit(cli())

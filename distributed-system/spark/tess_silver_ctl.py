"""Node 1 control plane for resumable Bronze-to-Silver initial BLS runs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from tess_bronze_ctl import (
    APP_ID_RE,
    BRONZE_COVERAGE_SCHEMA,
    BRONZE_DATA_SCHEMA,
    BRONZE_READY_SCHEMA,
    DATA_CONTRACT_EXIT_CODE,
    HOST_ARGS,
    SPARK_HDFS_USER,
    SPARK_IMAGE,
    application_state,
    atomic_commit,
    build_runtime,
    event_log_conf,
    require_yarn_headroom,
    run,
    fsck_healthy,
    hdfs,
    hdfs_exists,
    hdfs_json,
    part_checksum_digest,
    utc_now,
    wait_application,
    write_state,
    yarn,
    yarn_slot,
)


SILVER_READY_SCHEMA = "planetory.tess-silver-attempt.v5"
# Attempt markers Gold may read: the Sector 1~13 run is v4, 275 and later attempts are v5.
SILVER_INPUT_SCHEMAS = ("planetory.tess-silver-attempt.v4", SILVER_READY_SCHEMA)
SILVER_MANIFEST_SCHEMA = "planetory.tess-silver-stage.v4"
SILVER_TERMINAL_SCHEMA = "planetory.tess-silver-terminal.v1"
BRONZE_SNAPSHOT_SCHEMA = "planetory.tess-silver-bronze-snapshot.v1"
# Planned usage after the attempt, the same line the Raw loader applies to its RF2 estimate.
# Raised from 70%/75% by the operator on 2026-09-27 to fit more backlog buckets. Above about 80%
# (4 of 5 DataNodes) one lost DataNode can no longer be re-replicated to RF2; that risk is accepted.
# The 80-85% band stays free for Gold backup and Raw/Bronze.
SILVER_CAPACITY_LIMIT = 0.80
# The shared Silver/Gold preflight refuses any new work at or above this HDFS use.
PREFLIGHT_STOP_PERCENT = 85
SILVER_APP_RE = re.compile(r"\sS15P21C206-78-silver-")
MAX_TIC_BUCKETS = 1024  # tess_silver.py re-validates the same bound inside the job
V4_READY_SCHEMA = "planetory.tess-silver-attempt.v4"
PLAN_SCHEMA = "planetory.tess-silver-plan.v1"
# RF2 bytes one Silver run should add. A single new Sector (about 73 GB) stays one run and the
# Sector 15~70 backlog (about 3 TB) splits into about 15 buckets.
# ponytail: fixed target; tune once bucket run times and HDFS headroom are measured.
PLAN_BUCKET_BYTES = 200 * 10**9
PLAN_OUTPUT_RE = re.compile(r"/lake/silver/\.plan/run=[0-9]{8}T[0-9]{6}Z")
DEFAULT_BRONZE_COVERAGE = (
    "/lake/bronze/tess/coverage="
    "df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94"
)
SHA256_RE = re.compile(r"[0-9a-f]{64}")
RUN_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z")
VERSION_RE = re.compile(r"[A-Za-z0-9._-]+")
ATTEMPT_PATH_RE = re.compile(
    r"/lake/silver/pipeline_version=[A-Za-z0-9._-]+/"
    r"run_id=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z"
)


class SilverDataContractError(RuntimeError):
    """A deterministic contract failure that must not restart unchanged."""


def validate_bronze_coverage(value: dict[str, Any], markers: dict[int, tuple[dict, str]]) -> None:
    rows = value.get("sectors", [])
    by_sector = {int(row.get("sector", -1)): row for row in rows}
    if (
        value.get("schema") != BRONZE_COVERAGE_SCHEMA
        or len(rows) != 13
        or set(by_sector) != set(range(1, 14))
        or int(value.get("replication", -1)) != 2
        or int(value.get("product_count", 0)) <= 0
        or int(value.get("observation_count", 0)) <= 0
        or not isinstance(value.get("pipeline_version"), str)
        or not value["pipeline_version"]
        or set(markers) != set(range(1, 14))
    ):
        raise SilverDataContractError("Bronze coverage does not prove Sector 1 through 13")
    for sector, row in by_sector.items():
        marker, marker_sha256 = markers[sector]
        expected = {
            "schema": BRONZE_READY_SCHEMA,
            "data_schema": BRONZE_DATA_SCHEMA,
            "sector": sector,
            "pipeline_version": value["pipeline_version"],
            "product_count": row.get("product_count"),
            "observation_count": row.get("observation_count"),
            "replication": 2,
        }
        if row.get("location") != f"/lake/bronze/tess/sector={sector:04d}":
            raise SilverDataContractError(f"Bronze coverage location mismatch sector={sector}")
        if row.get("ready_sha256") != marker_sha256:
            raise SilverDataContractError(f"Bronze ready checksum mismatch sector={sector}")
        if any(marker.get(key) != expected_value for key, expected_value in expected.items()):
            raise SilverDataContractError(f"Bronze marker mismatch sector={sector}")


def bronze_coverage(path: str) -> dict[str, Any]:
    match = re.fullmatch(r"/lake/bronze/tess/coverage=([0-9a-f]{64})", path)
    if not match:
        raise SilverDataContractError("Bronze coverage must be an immutable 1..13 coverage path")
    value, ready_sha256 = hdfs_json(f"{path}/_READY.json")
    markers = {}
    for row in value.get("sectors", []):
        sector = int(row.get("sector", -1))
        if sector in range(1, 14):
            markers[sector] = hdfs_json(f"{row.get('location')}/_READY.json")
    if set(markers) != set(range(1, 14)):
        raise SilverDataContractError("Bronze coverage references incomplete Sector markers")
    validate_bronze_coverage(value, markers)
    for row in value["sectors"]:
        if not hdfs_exists(f"{row['location']}/_SUCCESS"):
            raise SilverDataContractError(f"Bronze Parquet is incomplete sector={row['sector']}")
    print(f"SILVER_BRONZE_COVERAGE_OK products={value['product_count']} path={path}", flush=True)
    snapshot = snapshot_from_rows([
        {
            "sector": int(row["sector"]),
            "location": row["location"],
            "ready_sha256": row["ready_sha256"],
            "pipeline_version": value["pipeline_version"],
            "product_count": int(row["product_count"]),
            "observation_count": int(row["observation_count"]),
        }
        for row in value["sectors"]
    ], coverage=path)
    # 80 Gold audits its Silver input against the coverage and its marker, so they stay in the result.
    return {**snapshot, "coverage_sha256": match.group(1), "ready_sha256": ready_sha256}


def snapshot_from_rows(rows: list[dict[str, Any]], *, coverage: str | None) -> dict[str, Any]:
    """One Bronze input snapshot; its ID depends on the Sector rows only, not on how they were found."""
    body = {"schema": BRONZE_SNAPSHOT_SCHEMA, "sectors": sorted(rows, key=lambda row: row["sector"])}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {**body, "sha256": digest, "coverage": coverage,
            "bronze_paths": [row["location"] for row in body["sectors"]]}


def validate_sector_marker(sector: int, marker: dict[str, Any]) -> None:
    version = marker.get("pipeline_version")
    if (
        marker.get("schema") != BRONZE_READY_SCHEMA
        or marker.get("data_schema") != BRONZE_DATA_SCHEMA
        or marker.get("sector") != sector
        or marker.get("replication") != 2
        or not isinstance(marker.get("product_count"), int) or marker["product_count"] <= 0
        or not isinstance(marker.get("observation_count"), int) or marker["observation_count"] <= 0
        or not isinstance(version, str) or not VERSION_RE.fullmatch(version)
    ):
        raise SilverDataContractError(f"Bronze marker mismatch sector={sector}")


def bronze_sector_snapshot(through_sector: int) -> dict[str, Any]:
    """Sector 1..N final markers as one cumulative snapshot; each Sector keeps its own Bronze version (275)."""
    listing = hdfs("dfs", "-ls", "/lake/bronze/tess/sector=*/_SUCCESS", check=False).stdout
    finished = {fields[-1] for line in listing.splitlines() if (fields := line.split())}
    rows = []
    for sector in range(1, through_sector + 1):
        location = f"/lake/bronze/tess/sector={sector:04d}"
        if f"{location}/_SUCCESS" not in finished:
            raise SilverDataContractError(f"Bronze Parquet is incomplete sector={sector}")
        marker, ready_sha256 = hdfs_json(f"{location}/_READY.json")
        validate_sector_marker(sector, marker)
        rows.append({
            "sector": sector,
            "location": location,
            "ready_sha256": ready_sha256,
            "pipeline_version": marker["pipeline_version"],
            "product_count": marker["product_count"],
            "observation_count": marker["observation_count"],
        })
    snapshot = snapshot_from_rows(rows, coverage=None)
    versions = sorted({row["pipeline_version"] for row in rows})
    print(f"SILVER_BRONZE_SNAPSHOT_OK sectors=1-{through_sector} versions={','.join(versions)} "
          f"sha256={snapshot['sha256']}", flush=True)
    return snapshot


def capacity_budget(df_output: str) -> int:
    """RF2 bytes an attempt may still add before HDFS passes the planned-usage line."""
    fields = df_output.splitlines()[-1].split()
    size, used = int(fields[1]), int(fields[2])
    return int(size * SILVER_CAPACITY_LIMIT) - used


def silver_capacity_budget() -> int:
    budget = capacity_budget(hdfs("dfs", "-df", "/").stdout)
    if budget <= 0:
        raise SilverDataContractError(f"HDFS has no Silver capacity below {SILVER_CAPACITY_LIMIT:.0%} budget={budget}")
    print(f"SILVER_CAPACITY_BUDGET bytes={budget} limit={SILVER_CAPACITY_LIMIT:.0%}", flush=True)
    return budget


def cluster_preflight(bronze_coverage_path: str = DEFAULT_BRONZE_COVERAGE, *, through_sector: int | None = None,
                      allow_running: bool = False) -> dict[str, Any]:
    """Shared HDFS/YARN checks and the Bronze input. 80 Gold calls it with the coverage path only."""
    nn1 = hdfs("haadmin", "-getServiceState", "nn1").stdout.strip()
    nn2 = hdfs("haadmin", "-getServiceState", "nn2").stdout.strip()
    if f"{nn1}:{nn2}" not in ("active:standby", "standby:active"):
        raise RuntimeError(f"invalid HDFS HA state: {nn1}:{nn2}")
    if hdfs("dfsadmin", "-safemode", "get").stdout.count("Safe mode is OFF") != 2:
        raise RuntimeError("HDFS safe mode is not OFF on both NameNodes")
    report = hdfs("dfsadmin", "-report").stdout
    if not (match := re.search(r"Live datanodes \((\d+)\)", report)) or int(match.group(1)) != 5:
        raise RuntimeError("expected five live DataNodes")
    used = hdfs("dfs", "-df", "/").stdout.splitlines()
    if len(used) < 2 or int(used[-1].split()[-1].rstrip("%")) >= PREFLIGHT_STOP_PERCENT:
        raise RuntimeError(f"HDFS usage is at or above {PREFLIGHT_STOP_PERCENT}%")
    nodes = yarn("node", "-list", "-all").stdout
    if len(re.findall(r"\sRUNNING\s", nodes)) != 5:
        raise RuntimeError("expected five RUNNING NodeManagers")
    applications = yarn("application", "-list", "-appStates", "RUNNING").stdout
    running = APP_ID_RE.findall(applications) if allow_running else require_yarn_headroom(applications)
    snapshot = bronze_sector_snapshot(through_sector) if through_sector else bronze_coverage(bronze_coverage_path)
    print(f"SILVER_PREFLIGHT_OK ha={nn1}:{nn2} live_datanodes=5 running_apps={len(running)}", flush=True)
    return snapshot


def silver_preflight(args: argparse.Namespace) -> dict[str, Any]:
    """Silver runs one at a time: the capacity budget covers a single in-flight Silver output.

    Only Silver commands refuse here; a Gold unit that restarts on this error would spend its daily starts.
    """
    if SILVER_APP_RE.search(yarn("application", "-list", "-appStates", "RUNNING").stdout):
        raise RuntimeError("another Silver application is running")
    return cluster_preflight(args.bronze_coverage, through_sector=args.through_sector)


# Increment planning (275). One increment = the Sectors whose Bronze is final but not yet in Silver:
# `through B, delta S+1..B`, split into TIC buckets only when its output would not fit one run.
# The same rule serves the Sector 15~70 backlog and every later Sector, from any evidence state.

def bronze_through(success_listing: str) -> int:
    """Bronze watermark B: the last Sector N whose Sectors 1..N all have a final `_SUCCESS`."""
    done = {int(match.group(1)) for match in re.finditer(r"/lake/bronze/tess/sector=(\d{4})/_SUCCESS", success_listing)}
    through = 0
    while through + 1 in done:
        through += 1
    return through


def attempt_increment(marker: dict[str, Any]) -> tuple[int, int, int, int] | None:
    """(through, delta_from, buckets, bucket) a committed attempt completes, or None if it adds no coverage."""
    if marker.get("schema") == V4_READY_SCHEMA:
        # The only v4 coverage is the fixed Sector 1~13 Bronze coverage (78); its retry repeats it.
        return (13, 1, 1, 0) if marker.get("bronze_coverage_sha256") else None
    if marker.get("schema") != SILVER_READY_SCHEMA:
        return None
    through = max(int(row["sector"]) for row in marker["bronze_snapshot"]["sectors"])
    if selection := marker.get("selection"):
        return through, selection["delta_from_sector"], selection["tic_buckets"], selection["tic_bucket"]
    # A full run covers its whole snapshot; a retry only re-runs failed TICs of an attempt it follows.
    return (through, 1, 1, 0) if marker.get("operation") == "run" else None


def silver_progress(increments: list[tuple[int, int, int, int]]) -> tuple[int, tuple[int, int, int] | None, set[int]]:
    """Silver watermark S, and the unfinished increment that continues from it with its done buckets.

    An increment (through N, delta from M, K buckets) is finished once all K buckets are committed,
    and a finished one that starts at or before S + 1 advances S to N.
    """
    groups: dict[tuple[int, int, int], set[int]] = {}
    for through, start, buckets, bucket in increments:
        groups.setdefault((through, start, buckets), set()).add(bucket)
    silver = 0
    while finished := [key for key, done in groups.items()
                       if key[1] <= silver + 1 and key[0] > silver and done == set(range(key[2]))]:
        silver = max(key[0] for key in finished)
    unfinished = [(key, done) for key, done in groups.items()
                  if key[1] <= silver + 1 and key[0] > silver and done != set(range(key[2]))]
    if len(unfinished) > 1:
        raise SilverDataContractError(f"more than one unfinished Silver increment: {sorted(k for k, _ in unfinished)}")
    return (silver, *unfinished[0]) if unfinished else (silver, None, set())


def plan_buckets(estimated_bytes: int) -> int:
    return min(MAX_TIC_BUCKETS, max(1, -(-estimated_bytes // PLAN_BUCKET_BYTES)))


def next_step(increment: tuple[int, int, int], done: set[int], bucket_bytes: int, budget: int) -> dict[str, Any]:
    through, start, buckets = increment
    return {
        "action": "run" if bucket_bytes <= budget else "wait_capacity",
        "through_sector": through,
        "delta_from_sector": start,
        "tic_buckets": buckets,
        "tic_bucket": min(set(range(buckets)) - done),
        "done_buckets": sorted(done),
        "estimated_bucket_bytes": bucket_bytes,
    }


def state_path(root: Path, run_id: str, attempt_id: str) -> Path:
    return root / f"run={run_id}" / f"attempt={attempt_id}.json"


def prepare_paths(output: str, run_id: str, attempt_id: str) -> None:
    spark_staging = f"/lake/silver/.spark-staging/run={run_id}/attempt={attempt_id}"
    hdfs("dfs", "-mkdir", "-p", output, spark_staging)
    hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", output, spark_staging)
    hdfs("dfs", "-chmod", "0750", output, spark_staging)
    print(f"SILVER_SPARK_PATHS_READY output={output} spark_staging={spark_staging}", flush=True)


def remove_empty_dir(path: str) -> None:
    result = hdfs("dfs", "-rmdir", path, check=False)
    if result.returncode and hdfs_exists(path):
        print(f"SILVER_CLEANUP_SKIPPED non_empty={path}", flush=True)


def cleanup_spark_staging(run_id: str, attempt_id: str, output: str) -> None:
    attempt = f"/lake/silver/.spark-staging/run={run_id}/attempt={attempt_id}"
    if hdfs_exists(attempt):
        result = hdfs("dfs", "-rm", "-r", "-skipTrash", attempt, check=False)
        if result.returncode and hdfs_exists(attempt):
            print(f"SILVER_CLEANUP_SKIPPED path={attempt}", flush=True)
    remove_empty_dir(f"/lake/silver/.spark-staging/run={run_id}")
    remove_empty_dir(output.rsplit("/", 1)[0])


STAGING_OUTPUT_RE = re.compile(
    r"/(lake/silver|validation/S15P21C206-78)/\.staging/run=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z"
)
TERMINAL_APP_STATES = ("FAILED", "KILLED", "SUCCEEDED")


def discard_failed_attempt(run_id: str, attempt_id: str, output: str, application_id: str | None) -> bool:
    """Remove a restartable attempt's partial staging so systemd restarts do not pile up.

    A multi-day run that fails is restarted from scratch as a new attempt; without this
    each failure leaves up to the full output size behind until HDFS hits the preflight stop line.
    The final attempt path is never touched. A YARN CLI hiccup can report UNKNOWN while
    the app is still healthy, so staging is kept unless the app is confirmed ended.
    """
    if not STAGING_OUTPUT_RE.fullmatch(output):
        raise RuntimeError(f"refusing to discard an unexpected path: {output}")
    if application_id:
        state = application_state(application_id)
        if state not in TERMINAL_APP_STATES:
            print(f"SILVER_CLEANUP_SKIPPED application={application_id} state={state} output={output}", flush=True)
            return False
    if hdfs_exists(output):
        hdfs("dfs", "-rm", "-r", "-skipTrash", output, check=False)
    cleanup_spark_staging(run_id, attempt_id, output)
    print(f"SILVER_FAILED_ATTEMPT_DISCARDED output={output}", flush=True)
    return True


def terminal_data_contract_error(output: str) -> SilverDataContractError | None:
    terminal = f"{output}/_TERMINAL"
    if not hdfs_exists(f"{terminal}/_SUCCESS"):
        return None
    marker, _ = hdfs_json(f"{terminal}/part-*")
    if (
        marker.get("schema_version") != SILVER_TERMINAL_SCHEMA
        or marker.get("failure_type") != "data_contract"
        or not marker.get("error_code")
    ):
        raise RuntimeError(f"invalid Silver terminal marker: {terminal}")
    return SilverDataContractError(
        f"Silver input contract failed code={marker['error_code']} detail={marker.get('error_detail', '')}"
    )


def submit(
    *,
    release_dir: Path,
    runtime_hdfs: str,
    snapshot: dict[str, Any],
    run_id: str,
    attempt_id: str,
    pipeline_version: str,
    output: str,
    final_output: str,
    output_partitions: int,
    shuffle_partitions: int,
    state_file: Path,
    state: dict[str, Any],
    capacity_budget_bytes: int,
    tic_ids: list[int] | None = None,
    retry_manifest: str | None = None,
    selection: dict[str, int] | None = None,
    plan_only: bool = False,
) -> str:
    job = release_dir / "spark" / "tess_silver.py"
    command = [
        "sudo", "docker", "run", "--rm", "--network", "host", *HOST_ARGS,
        "-e", "HADOOP_CONF_DIR=/etc/hadoop", "-e", "YARN_CONF_DIR=/etc/hadoop",
        "-e", f"HADOOP_USER_NAME={SPARK_HDFS_USER}",
        "-v", "/etc/hadoop:/etc/hadoop:ro", "-v", f"{job}:/opt/planetory/tess_silver.py:ro",
        "--entrypoint", "/opt/spark/bin/spark-submit", SPARK_IMAGE,
        "--master", "yarn", "--deploy-mode", "cluster",
        "--name", f"S15P21C206-78-silver-{run_id}-{attempt_id}",
        "--archives", f"hdfs://planetory{runtime_hdfs}#environment",
        "--conf", "spark.driver.port=7078", "--conf", "spark.blockManager.port=7079",
        "--conf", f"spark.yarn.stagingDir=hdfs://planetory/lake/silver/.spark-staging/run={run_id}/attempt={attempt_id}",
        # Silver is CPU-bound BLS per TIC. YARN places by memory only and rejects containers above
        # maximum-allocation-vcores=3, so the container size is what spreads executors: 7 GiB fits
        # exactly 3 per 24 GiB NodeManager and 2 on worker-2 (16 GiB), 6 tasks per 6-vCPU worker.
        # The 2026-09-24 run with 8 GiB packed 3 executors on one worker and 1 on another (64 vs
        # 24 min per task) while each executor used about 2.2 GiB. The 3 GiB driver fills the rest
        # of one 24 GiB node; if YARN puts it on worker-2 instead, 13 executors start.
        # Dynamic allocation starts at the cap and adds executors when YARN memory frees (for example
        # after a Bronze stage), without an external shuffle service. Executors holding shuffle files
        # or the DISK_ONLY results are never released, so no TIC result is recomputed.
        "--conf", "spark.dynamicAllocation.enabled=true",
        "--conf", "spark.dynamicAllocation.shuffleTracking.enabled=true",
        "--conf", "spark.dynamicAllocation.initialExecutors=14",
        "--conf", "spark.dynamicAllocation.maxExecutors=14",
        "--conf", "spark.dynamicAllocation.minExecutors=2",
        "--conf", "spark.dynamicAllocation.executorIdleTimeout=300s",
        "--conf", "spark.executor.cores=2",
        "--conf", "spark.executor.memory=5g", "--conf", "spark.executor.memoryOverhead=2048",
        "--conf", "spark.executorEnv.OMP_NUM_THREADS=1",
        "--conf", "spark.driver.memory=2g", "--conf", "spark.driver.memoryOverhead=1024",
        "--conf", "spark.pyspark.python=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.appMasterEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.maxAppAttempts=1", "--conf", "spark.speculation=false",
        *event_log_conf(),
        "/opt/planetory/tess_silver.py",
    ]
    for row in snapshot["sectors"]:
        command.extend(["--bronze-path", f"hdfs://planetory{row['location']}",
                        "--bronze-sector-version", f"{row['sector']}={row['pipeline_version']}"])
    command.extend([
        "--bronze-snapshot-sha256", snapshot["sha256"],
        "--capacity-budget-bytes", str(capacity_budget_bytes),
        "--pipeline-version", pipeline_version,
        "--run-id", run_id,
        "--attempt-id", attempt_id,
        "--output", f"hdfs://planetory{output}",
        "--final-output", f"hdfs://planetory{final_output}",
        "--output-partitions", str(output_partitions),
        "--shuffle-partitions", str(shuffle_partitions),
    ])
    for tic_id in tic_ids or []:
        command.extend(["--tic-id", str(tic_id)])
    if retry_manifest:
        command.extend(["--retry-manifest", f"hdfs://planetory{retry_manifest}"])
    if selection:
        command.extend(["--delta-from-sector", str(selection["delta_from_sector"]),
                        "--tic-buckets", str(selection["tic_buckets"]),
                        "--tic-bucket", str(selection["tic_bucket"])])
    if plan_only:
        command.append("--plan-only")

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
        if error := terminal_data_contract_error(output):
            raise error
        raise RuntimeError(f"spark-submit failed with exit {return_code}")
    if not application_id:
        raise RuntimeError("spark-submit did not report an application id")
    try:
        wait_application(application_id, label="SILVER")
    except RuntimeError:
        if error := terminal_data_contract_error(output):
            raise error
        raise
    return application_id


def audit_attempt(final: str, expected: dict[str, Any]) -> dict[str, Any]:
    marker, _ = hdfs_json(f"{final}/_READY.json")
    for key, value in expected.items():
        if marker.get(key) != value:
            raise SilverDataContractError(f"Silver attempt mismatch field={key}")
    for name in ("target_combined", "periodogram", "iteration", "manifest"):
        count, digest = part_checksum_digest(f"{final}/{name}")
        if marker.get(f"{name}_part_count") != count or marker.get(f"{name}_checksums_sha256") != digest:
            raise SilverDataContractError(f"Silver checksum mismatch output={name}")
    fsck_healthy(final)
    return marker


def finalize_attempt(
    *,
    release_dir: Path,
    snapshot: dict[str, Any],
    run_id: str,
    attempt_id: str,
    pipeline_version: str,
    output: str,
    final: str,
    application_id: str,
    capacity_budget_bytes: int,
    selection: dict[str, int] | None = None,
    operation: str | None = None,
) -> dict[str, Any]:
    lines = hdfs("dfs", "-cat", f"{output}/summary/part-*.json").stdout.splitlines()
    if len(lines) != 1:
        raise RuntimeError("expected one Silver summary row")
    summary = json.loads(lines[0])
    if not summary.get("contract_ok") or int(summary.get("manifest_tics", -1)) <= 0:
        raise SilverDataContractError("Silver manifest output contract failed")
    if summary.get("bronze_snapshot_sha256") != snapshot["sha256"]:
        raise SilverDataContractError("Silver summary does not match the submitted Bronze snapshot")
    try:
        science_audit = json.loads(summary["science_audit_json"])
    except (KeyError, TypeError, ValueError) as exc:
        raise SilverDataContractError("Silver science audit is invalid") from exc
    if not isinstance(science_audit, list) or len(science_audit) > 5:
        raise SilverDataContractError("Silver science audit exceeds the Canary contract")
    checksums = {}
    for name in ("target_combined", "periodogram", "iteration", "manifest"):
        path = f"{output}/{name}"
        hdfs("dfs", "-setrep", "-w", "2", path)
        count, digest = part_checksum_digest(path)
        checksums[f"{name}_part_count"] = count
        checksums[f"{name}_checksums_sha256"] = digest
    marker = {
        "schema": SILVER_READY_SCHEMA,
        "manifest_schema": SILVER_MANIFEST_SCHEMA,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "pipeline_version": pipeline_version,
        "bronze_snapshot_sha256": snapshot["sha256"],
        "bronze_snapshot": {"schema": snapshot["schema"], "sectors": snapshot["sectors"]},
        "bronze_coverage": snapshot["coverage"],
        # Gold re-audits a coverage attempt against these; a Sector snapshot has none.
        "bronze_coverage_sha256": snapshot.get("coverage_sha256"),
        "bronze_coverage_ready_sha256": snapshot.get("ready_sha256"),
        "selection": selection,
        # run, canary or retry: the planner counts a selection-less attempt as coverage only for run.
        "operation": operation,
        "spark_application_id": application_id,
        "selected_tics": int(summary["selected_tics"]),
        "selected_products": int(summary["selected_products"]),
        "estimated_output_bytes": int(summary["estimated_output_bytes"]),
        "capacity_budget_bytes": capacity_budget_bytes,
        "succeeded_tics": int(summary["succeeded_tics"]),
        "no_quality_peak_tics": int(summary["no_quality_peak_tics"]),
        "failed_tics": int(summary["failed_tics"]),
        "retryable_failed_tics": int(summary["retryable_failed_tics"]),
        "iteration_tics": int(summary["iteration_tics"]),
        "iteration_succeeded_tics": int(summary["iteration_succeeded_tics"]),
        "iteration_incomplete_tics": int(summary["iteration_incomplete_tics"]),
        "iteration_qa_stopped_tics": int(summary["iteration_qa_stopped_tics"]),
        "iteration_failed_tics": int(summary["iteration_failed_tics"]),
        "science_audit": science_audit,
        "replication": 2,
        **checksums,
        "completed_at_utc": utc_now(),
    }
    payload = json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n"
    hdfs("dfs", "-put", "-", f"{output}/_READY.json.part", input_text=payload)
    hdfs("dfs", "-mv", f"{output}/_READY.json.part", f"{output}/_READY.json")
    fsck_healthy(output)
    if hdfs_exists(final):
        raise SilverDataContractError(f"final Silver attempt already exists: {final}")
    final_parent = final.rsplit("/", 1)[0]
    if not hdfs_exists(final_parent):
        hdfs("dfs", "-mkdir", "-p", final_parent)
        hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", final_parent)
        hdfs("dfs", "-chmod", "0750", final_parent)
    atomic_commit(release_dir, output, final)
    audit_attempt(final, {
        "schema": SILVER_READY_SCHEMA,
        "manifest_schema": SILVER_MANIFEST_SCHEMA,
        "run_id": run_id,
        "attempt_id": attempt_id,
        "pipeline_version": pipeline_version,
        "bronze_snapshot_sha256": snapshot["sha256"],
        "replication": 2,
    })
    print(
        f"SILVER_COMMIT_OK selected={marker['selected_tics']} failed={marker['failed_tics']} final={final}",
        flush=True,
    )
    return marker


def run_attempt(
    *,
    args: argparse.Namespace,
    snapshot: dict[str, Any],
    tic_ids: list[int] | None = None,
    retry_manifest: str | None = None,
    selection: dict[str, int] | None = None,
    validation: bool = False,
) -> tuple[str, dict[str, Any]]:
    # Before any HDFS write, so a refused run leaves nothing behind.
    budget = silver_capacity_budget()
    release_dir = Path(args.release_dir).resolve()
    runtime_hdfs = build_runtime(release_dir)
    attempt_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = "/validation/S15P21C206-78" if validation else "/lake/silver"
    output = f"{root}/.staging/run={args.run_id}/attempt={attempt_id}"
    final = (
        f"{root}/run={args.run_id}/attempt={attempt_id}"
        if validation
        else f"{root}/pipeline_version={args.pipeline_version}/run_id={args.run_id}/attempt={attempt_id}"
    )
    state_file = state_path(Path(args.state_root), args.run_id, attempt_id)
    state = {
        "run_id": args.run_id,
        "attempt_id": attempt_id,
        "unit": unit_name(args.command, args.run_id, getattr(args, "retry_from", None)),
        "output": output,
        "final": final,
        "bronze_snapshot_sha256": snapshot["sha256"],
        "selection": selection,
        "capacity_budget_bytes": budget,
        "status": "prepared",
        "updated_at_utc": utc_now(),
    }
    write_state(state_file, state)
    prepare_paths(output, args.run_id, attempt_id)
    try:
        application_id = submit(
            release_dir=release_dir,
            runtime_hdfs=runtime_hdfs,
            snapshot=snapshot,
            run_id=args.run_id,
            attempt_id=attempt_id,
            pipeline_version=args.pipeline_version,
            output=output,
            final_output=final,
            output_partitions=args.output_partitions,
            shuffle_partitions=args.shuffle_partitions,
            state_file=state_file,
            state=state,
            capacity_budget_bytes=budget,
            tic_ids=tic_ids,
            retry_manifest=retry_manifest,
            selection=selection,
        )
        marker = finalize_attempt(
            release_dir=release_dir,
            snapshot=snapshot,
            run_id=args.run_id,
            attempt_id=attempt_id,
            pipeline_version=args.pipeline_version,
            output=output,
            final=final,
            application_id=application_id,
            capacity_budget_bytes=budget,
            selection=selection,
            operation=args.command,
        )
        cleanup_spark_staging(args.run_id, attempt_id, output)
        if validation and marker["failed_tics"]:
            raise SilverDataContractError(f"canary has failed TICs; inspect {final}/manifest")
    except SilverDataContractError as exc:
        # Contract failures are not restarted, so their staging stays for diagnosis.
        state.update(status="terminal_failed", failure_detail=str(exc), updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    except Exception as exc:
        discarded = discard_failed_attempt(args.run_id, attempt_id, output, state.get("application_id"))
        state.update(status="failed", failure_detail=f"{type(exc).__name__}: {exc}"[:500],
                     staging_discarded=discarded, updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    state.update(status="complete", application_id=application_id, result=marker, updated_at_utc=utc_now())
    write_state(state_file, state)
    return final, marker


def command_preflight(args: argparse.Namespace) -> None:
    silver_preflight(args)
    print(f"SILVER_CAPACITY_BUDGET_PREVIEW bytes={capacity_budget(hdfs('dfs', '-df', '/').stdout)}", flush=True)


def command_canary(args: argparse.Namespace) -> None:
    snapshot = silver_preflight(args)
    final, marker = run_attempt(args=args, snapshot=snapshot, tic_ids=args.tic_id, validation=True)
    print(f"SILVER_CANARY_AUDIT={json.dumps(marker['science_audit'], sort_keys=True, separators=(',', ':'))}", flush=True)
    hdfs("dfs", "-rm", "-r", "-skipTrash", final)
    remove_empty_dir(final.rsplit("/", 1)[0])
    print(f"SILVER_CANARY_OK tics={marker['selected_tics']}", flush=True)


def run_selection(args: argparse.Namespace) -> dict[str, int] | None:
    if getattr(args, "delta_from_sector", None) is None:
        return None
    return {"delta_from_sector": args.delta_from_sector, "tic_buckets": args.tic_buckets,
            "tic_bucket": args.tic_bucket}


def command_run(args: argparse.Namespace) -> None:
    snapshot = silver_preflight(args)
    run_attempt(args=args, snapshot=snapshot, selection=run_selection(args))


def command_retry(args: argparse.Namespace) -> None:
    snapshot = silver_preflight(args)
    previous, _ = hdfs_json(f"{args.retry_from}/_READY.json")
    # A v4 attempt predates the snapshot ID and is not retried by this release.
    if (previous.get("schema") != SILVER_READY_SCHEMA or
            previous.get("manifest_schema") != SILVER_MANIFEST_SCHEMA or
            not hdfs_exists(f"{args.retry_from}/manifest/_SUCCESS")):
        raise SilverDataContractError("retry source is not a completed Silver attempt")
    if previous.get("run_id") != args.run_id or previous.get("bronze_snapshot_sha256") != snapshot["sha256"]:
        raise SilverDataContractError("retry source run or Bronze snapshot does not match")
    if int(previous.get("failed_tics", 0)) <= 0:
        raise SilverDataContractError("retry source has no failed TICs")
    run_attempt(args=args, snapshot=snapshot, retry_manifest=f"{args.retry_from}/manifest")


def active_silver_work() -> list[str]:
    """Running Silver units and YARN apps; a plan never hands out a bucket while one of them runs."""
    units = run(["/usr/bin/systemctl", "list-units", "planetory-tess-silver-*", "--state=active,activating",
                 "--no-legend", "--plain"]).stdout
    apps = yarn("application", "-list", "-appStates", "RUNNING").stdout
    return ([line.split()[0] for line in units.splitlines() if line.strip()]
            + [line.split()[0] for line in apps.splitlines() if SILVER_APP_RE.search(line)])


def hdfs_glob(pattern: str) -> str:
    """`hdfs dfs -ls` of a glob. No match is an empty listing; any other failure stops the plan,
    so an unreachable NameNode never reads as "no Bronze" (idle) or "no Silver" (replan from Sector 1)."""
    result = hdfs("dfs", "-ls", pattern, check=False)
    if result.returncode and "No such file or directory" not in result.stdout:
        raise RuntimeError(f"HDFS listing failed ({result.returncode}): {pattern}")
    return result.stdout


def committed_silver_markers() -> list[dict[str, Any]]:
    listing = hdfs_glob("/lake/silver/pipeline_version=*/run_id=*/attempt=*/_READY.json")
    paths = sorted(fields[-1] for line in listing.splitlines()
                   if (fields := line.split()) and fields[-1].endswith("/_READY.json")
                   and ATTEMPT_PATH_RE.fullmatch(fields[-1].removesuffix("/_READY.json")))
    return [hdfs_json(path)[0] for path in paths]


def plan_estimate(args: argparse.Namespace, through: int, start: int) -> int:
    """RF2 bytes of one unsplit increment, from a Spark pass that selects and counts but runs no BLS."""
    snapshot = cluster_preflight(args.bronze_coverage, through_sector=through)
    release_dir = Path(args.release_dir).resolve()
    runtime_hdfs = build_runtime(release_dir)
    plan_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = f"/lake/silver/.plan/run={plan_id}"
    if not PLAN_OUTPUT_RE.fullmatch(output):
        raise RuntimeError(f"unexpected plan path: {output}")
    prepare_paths(output, plan_id, plan_id)
    try:
        submit(release_dir=release_dir, runtime_hdfs=runtime_hdfs, snapshot=snapshot, run_id=plan_id,
               attempt_id=plan_id, pipeline_version=args.pipeline_version, output=output, final_output=output,
               output_partitions=args.output_partitions, shuffle_partitions=args.shuffle_partitions,
               state_file=Path(args.state_root, "plans", f"{plan_id}.json"), state={"plan_id": plan_id},
               capacity_budget_bytes=0, plan_only=True,
               selection={"delta_from_sector": start, "tic_buckets": 1, "tic_bucket": 0})
        value, _ = hdfs_json(f"{output}/_PLAN/part-*")
    finally:
        hdfs("dfs", "-rm", "-r", "-f", "-skipTrash", output, check=False)
        cleanup_spark_staging(plan_id, plan_id, output)
    print(f"SILVER_PLAN_ESTIMATE through={through} delta_from={start} tics={value['selected_tics']} "
          f"products={value['selected_products']} bytes={value['estimated_output_bytes']}", flush=True)
    return int(value["estimated_output_bytes"])


def command_plan(args: argparse.Namespace) -> None:
    """Print the next Silver increment bucket to run, recomputed from HDFS evidence every time."""
    def emit(value: dict[str, Any]) -> None:
        print("SILVER_PLAN_JSON=" + json.dumps({"schema": PLAN_SCHEMA, **value}, sort_keys=True,
                                               separators=(",", ":")), flush=True)

    if active := active_silver_work():
        emit({"action": "busy", "active": active})
        return
    bronze = bronze_through(hdfs_glob("/lake/bronze/tess/sector=*/_SUCCESS"))
    markers = committed_silver_markers()
    silver, increment, done = silver_progress([inc for marker in markers if (inc := attempt_increment(marker))])
    base = {"bronze_through": bronze, "silver_through": silver,
            "capacity_budget_bytes": capacity_budget(hdfs("dfs", "-df", "/").stdout)}
    if increment is None and silver >= bronze:
        emit({**base, "action": "idle"})
        return
    if increment is None:
        estimated = plan_estimate(args, bronze, silver + 1)
        buckets = plan_buckets(estimated)
        increment, bucket_bytes = (bronze, silver + 1, buckets), -(-estimated // buckets)
    else:
        # Buckets of one increment are similar in size, so a finished one prices the rest.
        bucket_bytes = max(int(marker["estimated_output_bytes"]) for marker in markers
                           if (inc := attempt_increment(marker)) and inc[:3] == increment)
    emit({**base, **next_step(increment, done, bucket_bytes, base["capacity_budget_bytes"])})


UNIT_ROOT = Path("/etc/systemd/system")
RELEASE_DIR_RE = re.compile(r"/opt/planetory-silver/releases/[0-9]{8}T[0-9]{6}Z")
UNIT_DESCRIPTIONS = {
    "run": "Planetory TESS Bronze to Silver {run_id}",
    "canary": "Planetory TESS Silver canary {run_id}",
    "retry": "Planetory TESS Silver failed-TIC retry {run_id}",
}


def unit_name(operation: str, run_id: str, retry_from: str | None = None) -> str:
    """One deterministic unit per request, so a retried Airflow task cannot start a second run.

    `run` keeps the name run-tess-silver.ps1 uses, so either entry point sees the same unit.
    """
    if operation == "run":
        return f"planetory-tess-silver-{run_id}.service"
    if operation == "canary":
        return f"planetory-tess-silver-canary-{run_id}.service"
    source_attempt = (retry_from or "").rsplit("attempt=", 1)[-1]
    if not RUN_ID_RE.fullmatch(source_attempt):
        raise SilverDataContractError("retry unit requires an immutable source attempt")
    return f"planetory-tess-silver-retry-{run_id}-{source_attempt}.service"


def operation_argv(args: argparse.Namespace) -> list[str]:
    release = args.release_dir
    argv = [
        "/usr/bin/python3.12", f"{release}/spark/tess_silver_ctl.py", args.operation,
        "--release-dir", release, "--run-id", args.run_id, "--pipeline-version", args.pipeline_version,
        "--bronze-coverage", args.bronze_coverage, "--shuffle-partitions", str(args.shuffle_partitions),
        "--output-partitions", str(args.output_partitions),
    ]
    for tic_id in args.tic_id or []:
        argv.extend(["--tic-id", str(tic_id)])
    if args.retry_from:
        argv.extend(["--retry-from", args.retry_from])
    return argv


def unit_text(args: argparse.Namespace) -> str:
    """The systemd unit run-tess-silver.ps1 writes, byte for byte, so both entry points agree."""
    return "\n".join([
        "[Unit]",
        f"Description={UNIT_DESCRIPTIONS[args.operation].format(run_id=args.run_id)}",
        "After=network-online.target hadoop-hdfs-namenode.service hadoop-yarn-resourcemanager.service docker.service",
        "Wants=network-online.target",
        "StartLimitIntervalSec=0",
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


def latest_attempt(state_root: str, run_id: str, unit: str) -> dict[str, Any] | None:
    """Newest attempt state of one unit; it survives reboots, unlike systemd's start time and result.

    Attempts written before the `unit` field existed belong to the `run` unit.
    """
    default = unit_name("run", run_id)
    for path in sorted(Path(state_root, f"run={run_id}").glob("attempt=*.json"), reverse=True):
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("unit", default) == unit:
            return state
    return None


def refuse_completed_unit(args: argparse.Namespace) -> None:
    """A completed request must not run again, whichever entry point restarts it."""
    unit = unit_name(args.command, args.run_id, getattr(args, "retry_from", None))
    if (latest_attempt(args.state_root, args.run_id, unit) or {}).get("status") == "complete":
        raise SilverDataContractError(f"SILVER_UNIT_ALREADY_COMPLETE {unit}; use a new run ID")


def systemd_properties(name: str) -> dict[str, str]:
    output = subprocess.run(
        ["/usr/bin/systemctl", "show", name, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
         "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainStartTimestampMonotonic", "-p", "NRestarts"],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False,
    ).stdout
    return dict(line.split("=", 1) for line in output.splitlines() if "=" in line)


def validate_unit_request(args: argparse.Namespace) -> None:
    if not RELEASE_DIR_RE.fullmatch(args.release_dir):
        raise SilverDataContractError("unit release must be an immutable Silver release")
    # The unit must run the same controller that sudo allowed, not another release.
    if Path(__file__).resolve() != Path(args.release_dir, "spark", "tess_silver_ctl.py"):
        raise SilverDataContractError("unit release does not match the running controller")
    if args.operation == "canary" and not 1 <= len(args.tic_id or []) <= 5:
        raise SilverDataContractError("canary unit requires one to five TIC IDs")
    if args.operation != "canary" and args.tic_id:
        raise SilverDataContractError("TIC selection is permitted only for canary")
    if (args.operation == "retry") != bool(args.retry_from):
        raise SilverDataContractError("retry_from is required for retry and only for retry")


def command_start_unit(args: argparse.Namespace) -> None:
    """Install and start the Silver systemd unit, then return without waiting for Spark."""
    validate_unit_request(args)
    name = unit_name(args.operation, args.run_id, args.retry_from)
    path = UNIT_ROOT / name
    text = unit_text(args)
    if path.exists():
        if path.read_text(encoding="utf-8") != text:
            raise SilverDataContractError(f"UNIT_DEFINITION_MISMATCH {name}")
    else:
        candidate = UNIT_ROOT / f".{name}.part"
        candidate.write_text(text, encoding="utf-8")
        os.chmod(candidate, 0o644)
        os.replace(candidate, path)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "enable", name])
    props = systemd_properties(name)
    if props.get("ActiveState") in ("active", "activating"):
        print(f"SILVER_UNIT_ALREADY_ACTIVE={name}", flush=True)
        return
    # systemd forgets a finished oneshot after a reboot, so completion comes from the attempt state.
    if (latest_attempt(args.state_root, args.run_id, name) or {}).get("status") == "complete":
        print(f"SILVER_UNIT_ALREADY_COMPLETE={name}", flush=True)
        return
    run(["/usr/bin/systemctl", "reset-failed", name], check=False)
    run(["/usr/bin/systemctl", "--no-block", "start", name])
    print(f"SILVER_UNIT_STARTED={name}", flush=True)


def command_status(args: argparse.Namespace) -> None:
    """Read-only unit and latest attempt state for the asynchronous Airflow wait."""
    name = unit_name(args.operation, args.run_id, args.retry_from)
    latest = latest_attempt(args.state_root, args.run_id, name)
    print("SILVER_STATUS_JSON=" + json.dumps(
        {"unit": name, "systemd": systemd_properties(name), "attempt": latest},
        sort_keys=True, separators=(",", ":")), flush=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--bronze-coverage", default=DEFAULT_BRONZE_COVERAGE)
    # start-unit keeps the coverage-only CLI the Airflow sudoers rule pins; Sector snapshots (275)
    # run through the operator entry points until 80 wires them into the DAG.
    source = argparse.ArgumentParser(add_help=False, parents=[common])
    source.add_argument("--through-sector", type=int)
    subparsers = root.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight", parents=[source])
    preflight.set_defaults(handler=command_preflight)
    for command, handler in (("canary", command_canary), ("run", command_run), ("retry", command_retry)):
        child = subparsers.add_parser(command, parents=[source])
        child.add_argument("--release-dir", required=True)
        child.add_argument("--run-id", required=True)
        child.add_argument("--pipeline-version", required=True)
        child.add_argument("--output-partitions", type=int, default=80)
        child.add_argument("--shuffle-partitions", type=int, default=200)
        child.add_argument("--state-root", default="/var/lib/planetory-silver")
        child.set_defaults(handler=handler)
        if command == "canary":
            child.add_argument("--tic-id", type=int, action="append", required=True)
        if command == "run":
            child.add_argument("--delta-from-sector", type=int)
            child.add_argument("--tic-buckets", type=int, default=1)
            child.add_argument("--tic-bucket", type=int, default=0)
        if command == "retry":
            child.add_argument("--retry-from", required=True)
    plan = subparsers.add_parser("plan", parents=[common])
    plan.add_argument("--release-dir", required=True)
    plan.add_argument("--pipeline-version", required=True)
    plan.add_argument("--output-partitions", type=int, default=80)
    plan.add_argument("--shuffle-partitions", type=int, default=200)
    plan.add_argument("--state-root", default="/var/lib/planetory-silver")
    plan.set_defaults(handler=command_plan)
    start = subparsers.add_parser("start-unit", parents=[common])
    start.add_argument("operation", choices=("canary", "run", "retry"))
    start.add_argument("--release-dir", required=True)
    start.add_argument("--run-id", required=True)
    start.add_argument("--pipeline-version", required=True)
    start.add_argument("--output-partitions", type=int, default=80)
    start.add_argument("--shuffle-partitions", type=int, default=200)
    start.add_argument("--tic-id", type=int, action="append")
    start.add_argument("--retry-from")
    start.add_argument("--state-root", default="/var/lib/planetory-silver")
    start.set_defaults(handler=command_start_unit)
    status = subparsers.add_parser("status")
    status.add_argument("operation", choices=("canary", "run", "retry"))
    status.add_argument("--run-id", required=True)
    status.add_argument("--retry-from")
    status.add_argument("--state-root", default="/var/lib/planetory-silver")
    status.set_defaults(handler=command_status)
    return root


def validate_snapshot_request(args: argparse.Namespace) -> None:
    """Exit 65 on a bad request so the systemd unit does not restart it every five minutes."""
    through = getattr(args, "through_sector", None)
    delta = getattr(args, "delta_from_sector", None)
    buckets, bucket = getattr(args, "tic_buckets", 1), getattr(args, "tic_bucket", 0)
    if through is not None and not 1 <= through <= 999:
        raise SilverDataContractError("--through-sector must be a Sector number")
    if delta is not None and (through is None or not 1 <= delta <= through):
        raise SilverDataContractError("--delta-from-sector needs --through-sector and must be within 1..through")
    if not 1 <= buckets <= MAX_TIC_BUCKETS or not 0 <= bucket < buckets:
        raise SilverDataContractError(
            f"--tic-bucket must be in 0..--tic-buckets-1 and --tic-buckets in 1..{MAX_TIC_BUCKETS}")
    if buckets > 1 and delta is None:
        raise SilverDataContractError("TIC buckets split only a --delta-from-sector run")


def main() -> int:
    args = parser().parse_args()
    if hasattr(args, "run_id") and not RUN_ID_RE.fullmatch(args.run_id):
        raise SystemExit("run ID must be UTC yyyyMMddTHHmmssZ")
    if hasattr(args, "pipeline_version") and not VERSION_RE.fullmatch(args.pipeline_version):
        raise SystemExit("pipeline version contains unsupported characters")
    if getattr(args, "retry_from", None) and not ATTEMPT_PATH_RE.fullmatch(args.retry_from):
        raise SystemExit("retry source must be an immutable Silver attempt path")
    if getattr(args, "tic_id", None) and any(tic_id <= 0 for tic_id in args.tic_id):
        raise SystemExit("TIC IDs must be positive")
    if getattr(args, "output_partitions", 1) <= 0 or getattr(args, "shuffle_partitions", 1) <= 0:
        raise SystemExit("partition counts must be positive")
    try:
        validate_snapshot_request(args)
        if args.command in ("canary", "run", "retry"):
            refuse_completed_unit(args)
        if args.command in ("canary", "run", "retry", "plan"):
            with yarn_slot():
                args.handler(args)
        else:
            args.handler(args)
        return 0
    except SilverDataContractError as exc:
        print(f"SILVER_TERMINAL_FAILURE {exc}", file=sys.stderr, flush=True)
        return DATA_CONTRACT_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())

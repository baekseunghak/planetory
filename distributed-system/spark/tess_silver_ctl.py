"""Node 1 control plane for resumable Bronze-to-Silver initial BLS runs."""

from __future__ import annotations

import argparse
import json
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
    require_yarn_headroom,
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


SILVER_READY_SCHEMA = "planetory.tess-silver-attempt.v4"
SILVER_MANIFEST_SCHEMA = "planetory.tess-silver-stage.v4"
SILVER_TERMINAL_SCHEMA = "planetory.tess-silver-terminal.v1"
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
    coverage_sha256 = match.group(1)
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
    return {
        "path": path,
        "coverage_sha256": coverage_sha256,
        "ready_sha256": ready_sha256,
        "pipeline_version": value["pipeline_version"],
        "bronze_paths": [row["location"] for row in sorted(value["sectors"], key=lambda row: row["sector"])],
    }


def cluster_preflight(bronze_coverage_path: str, *, allow_running: bool = False) -> dict[str, Any]:
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
    if len(used) < 2 or int(used[-1].split()[-1].rstrip("%")) >= 75:
        raise RuntimeError("HDFS usage is at or above 75%")
    nodes = yarn("node", "-list", "-all").stdout
    if len(re.findall(r"\sRUNNING\s", nodes)) != 5:
        raise RuntimeError("expected five RUNNING NodeManagers")
    applications = yarn("application", "-list", "-appStates", "RUNNING").stdout
    running = APP_ID_RE.findall(applications) if allow_running else require_yarn_headroom(applications)
    coverage = bronze_coverage(bronze_coverage_path)
    print(f"SILVER_PREFLIGHT_OK ha={nn1}:{nn2} live_datanodes=5 running_apps={len(running)}", flush=True)
    return coverage


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
    each failure leaves up to the full output size behind until HDFS hits the 75% gate.
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
    coverage: dict[str, Any],
    run_id: str,
    attempt_id: str,
    pipeline_version: str,
    output: str,
    final_output: str,
    output_partitions: int,
    shuffle_partitions: int,
    state_file: Path,
    state: dict[str, Any],
    tic_ids: list[int] | None = None,
    retry_manifest: str | None = None,
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
        "--conf", "spark.executor.instances=5", "--conf", "spark.executor.cores=2",
        "--conf", "spark.executor.memory=6g", "--conf", "spark.executor.memoryOverhead=2048",
        "--conf", "spark.driver.memory=2g", "--conf", "spark.driver.memoryOverhead=1024",
        "--conf", "spark.pyspark.python=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.appMasterEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.maxAppAttempts=1", "--conf", "spark.speculation=false",
        "/opt/planetory/tess_silver.py",
    ]
    for path in coverage["bronze_paths"]:
        command.extend(["--bronze-path", f"hdfs://planetory{path}"])
    command.extend([
        "--bronze-coverage-sha256", coverage["coverage_sha256"],
        "--bronze-coverage-ready-sha256", coverage["ready_sha256"],
        "--bronze-pipeline-version", coverage["pipeline_version"],
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
    coverage: dict[str, Any],
    run_id: str,
    attempt_id: str,
    pipeline_version: str,
    output: str,
    final: str,
    application_id: str,
) -> dict[str, Any]:
    lines = hdfs("dfs", "-cat", f"{output}/summary/part-*.json").stdout.splitlines()
    if len(lines) != 1:
        raise RuntimeError("expected one Silver summary row")
    summary = json.loads(lines[0])
    if not summary.get("contract_ok") or int(summary.get("manifest_tics", -1)) <= 0:
        raise SilverDataContractError("Silver manifest output contract failed")
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
        "bronze_coverage_sha256": coverage["coverage_sha256"],
        "bronze_coverage_ready_sha256": coverage["ready_sha256"],
        "bronze_pipeline_version": coverage["pipeline_version"],
        "spark_application_id": application_id,
        "selected_tics": int(summary["selected_tics"]),
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
        "bronze_coverage_sha256": coverage["coverage_sha256"],
        "bronze_coverage_ready_sha256": coverage["ready_sha256"],
        "bronze_pipeline_version": coverage["pipeline_version"],
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
    coverage: dict[str, Any],
    tic_ids: list[int] | None = None,
    retry_manifest: str | None = None,
    validation: bool = False,
) -> tuple[str, dict[str, Any]]:
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
        "output": output,
        "final": final,
        "status": "prepared",
        "updated_at_utc": utc_now(),
    }
    write_state(state_file, state)
    prepare_paths(output, args.run_id, attempt_id)
    try:
        application_id = submit(
            release_dir=release_dir,
            runtime_hdfs=runtime_hdfs,
            coverage=coverage,
            run_id=args.run_id,
            attempt_id=attempt_id,
            pipeline_version=args.pipeline_version,
            output=output,
            final_output=final,
            output_partitions=args.output_partitions,
            shuffle_partitions=args.shuffle_partitions,
            state_file=state_file,
            state=state,
            tic_ids=tic_ids,
            retry_manifest=retry_manifest,
        )
        marker = finalize_attempt(
            release_dir=release_dir,
            coverage=coverage,
            run_id=args.run_id,
            attempt_id=attempt_id,
            pipeline_version=args.pipeline_version,
            output=output,
            final=final,
            application_id=application_id,
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
    cluster_preflight(args.bronze_coverage)


def command_canary(args: argparse.Namespace) -> None:
    coverage = cluster_preflight(args.bronze_coverage)
    final, marker = run_attempt(args=args, coverage=coverage, tic_ids=args.tic_id, validation=True)
    print(f"SILVER_CANARY_AUDIT={json.dumps(marker['science_audit'], sort_keys=True, separators=(',', ':'))}", flush=True)
    hdfs("dfs", "-rm", "-r", "-skipTrash", final)
    remove_empty_dir(final.rsplit("/", 1)[0])
    print(f"SILVER_CANARY_OK tics={marker['selected_tics']}", flush=True)


def command_run(args: argparse.Namespace) -> None:
    coverage = cluster_preflight(args.bronze_coverage)
    run_attempt(args=args, coverage=coverage)


def command_retry(args: argparse.Namespace) -> None:
    coverage = cluster_preflight(args.bronze_coverage)
    previous, _ = hdfs_json(f"{args.retry_from}/_READY.json")
    if (previous.get("schema") != SILVER_READY_SCHEMA or
            previous.get("manifest_schema") != SILVER_MANIFEST_SCHEMA or
            not hdfs_exists(f"{args.retry_from}/manifest/_SUCCESS")):
        raise SilverDataContractError("retry source is not a completed Silver attempt")
    if (
        previous.get("run_id") != args.run_id
        or previous.get("bronze_coverage_sha256") != coverage["coverage_sha256"]
        or previous.get("bronze_coverage_ready_sha256") != coverage["ready_sha256"]
    ):
        raise SilverDataContractError("retry source run or Bronze snapshot does not match")
    if int(previous.get("failed_tics", 0)) <= 0:
        raise SilverDataContractError("retry source has no failed TICs")
    run_attempt(args=args, coverage=coverage, retry_manifest=f"{args.retry_from}/manifest")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--bronze-coverage", default=DEFAULT_BRONZE_COVERAGE)
    subparsers = root.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight", parents=[common])
    preflight.set_defaults(handler=command_preflight)
    for command, handler in (("canary", command_canary), ("run", command_run), ("retry", command_retry)):
        child = subparsers.add_parser(command, parents=[common])
        child.add_argument("--release-dir", required=True)
        child.add_argument("--run-id", required=True)
        child.add_argument("--pipeline-version", required=True)
        child.add_argument("--output-partitions", type=int, default=80)
        child.add_argument("--shuffle-partitions", type=int, default=200)
        child.add_argument("--state-root", default="/var/lib/planetory-silver")
        child.set_defaults(handler=handler)
        if command == "canary":
            child.add_argument("--tic-id", type=int, action="append", required=True)
        if command == "retry":
            child.add_argument("--retry-from", required=True)
    return root


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
        if args.command in ("canary", "run", "retry"):
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

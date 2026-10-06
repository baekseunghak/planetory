"""Node 1 control for the 80 Gold stage: verify inputs, submit tess_gold to YARN, commit the attempt.

A committed attempt means the Gold outputs passed storage checks (RF2, part checksums,
FSCK) and match the run manifest. Publication readiness is decided later by the publish
gate; nothing here marks a run publishable.
"""

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
    DATA_CONTRACT_EXIT_CODE,
    HOST_ARGS,
    SPARK_HDFS_USER,
    SPARK_IMAGE,
    application_state,
    atomic_commit,
    run,
    build_runtime,
    event_log_conf,
    fsck_healthy,
    hdfs,
    hdfs_exists,
    hdfs_json,
    utc_now,
    wait_application,
    write_state,
    yarn_slot,
)
from tess_silver_ctl import (
    ATTEMPT_PATH_RE,
    DEFAULT_BRONZE_COVERAGE,
    RUN_ID_RE,
    SILVER_INPUT_SCHEMAS,
    SILVER_MANIFEST_SCHEMA,
    SilverDataContractError,
    audit_attempt,
    cluster_preflight,
    remove_empty_dir,
    systemd_properties,
)

GOLD_READY_SCHEMA = "planetory.tess-gold-attempt.v1"
GOLD_TERMINAL_SCHEMA = "planetory.tess-gold-terminal.v1"  # same string as tess_gold (Node 1 has no numpy)
EXTERNAL_READY_SCHEMA = "planetory.tess-external-snapshot.v1"
GOLD_ROOT = "/lake/gold/tess/publication-candidates"
VALIDATION_ROOT = "/validation/S15P21C206-80"
EXTERNAL_PATH_RE = re.compile(r"/lake/external/tess/run_id=[0-9]{8}T[0-9]{6}Z")
STAGING_OUTPUT_RE = re.compile(
    r"/(lake/gold/tess|validation/S15P21C206-80)/\.staging/run=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z"
)
# JSON Lines outputs the Publisher downloads (276); the one-line summary is read, not recorded, as in Silver.
OUTPUTS = ("bundles", "candidates", "manifest")
HDFS_COMMAND = ["sudo", "-u", "hdfs", "env", "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64",
                "HADOOP_CONF_DIR=/etc/hadoop", "/opt/hadoop/bin/hdfs"]  # same as tess_bronze_ctl.hdfs
TERMINAL_APP_STATES = ("FAILED", "KILLED", "SUCCEEDED")
PUBLISH_READY_SCHEMA = "planetory.tess-publish-ready.v1"
PUBLISH_READY_ROOT = "/lake/gold/tess/publish-ready"
GATE_ROOT = "/lake/gold/tess/.gate"
GATE_VERDICT_SCHEMA = "planetory.tess-gold-gate-verdict.v1"  # same string as tess_gate
GOLD_ATTEMPT_RE = re.compile(rf"{GOLD_ROOT}/run_id=([0-9]{{8}}T[0-9]{{6}}Z)/attempt=[0-9]{{8}}T[0-9]{{6}}Z")
SCHEMA_FILE = "contracts/gold/publication-candidates.schema.json"
# Approval references travel through systemd ExecStart and sudoers, so they are one safe token.
APPROVAL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}")
UNIT_ROOT = Path("/etc/systemd/system")
# The pipeline release installed by run-tess-silver.ps1 also carries the Gold stage.
RELEASE_DIR_RE = re.compile(r"/opt/planetory-silver/releases/[0-9]{8}T[0-9]{6}Z")
UNIT_DONE = {"run": "complete", "gate": "publish_ready"}


class GoldDataContractError(RuntimeError):
    """A deterministic contract failure that must not restart unchanged."""


def silver_input(path: str, coverage: dict[str, Any]) -> dict[str, Any]:
    """The committed Silver attempt this run reads, re-audited against the Bronze coverage."""
    if not ATTEMPT_PATH_RE.fullmatch(path):
        raise GoldDataContractError(f"Silver input must be an immutable attempt path: {path}")
    # The Sector 1~13 attempt is v4 and a later coverage run is v5. A 275 Sector-snapshot attempt
    # has no coverage fields, so it fails the audit below until Gold reads a per-TIC selection.
    schema = hdfs_json(f"{path}/_READY.json")[0].get("schema")
    if schema not in SILVER_INPUT_SCHEMAS:
        raise GoldDataContractError(f"Silver input schema is not readable by Gold: {schema}")
    marker = audit_attempt(path, {
        "schema": schema,
        "manifest_schema": SILVER_MANIFEST_SCHEMA,
        "bronze_coverage_sha256": coverage["coverage_sha256"],
        "bronze_coverage_ready_sha256": coverage["ready_sha256"],
        "replication": 2,
    })
    _, ready_sha256 = hdfs_json(f"{path}/_READY.json")
    return {"marker": marker, "ready_sha256": ready_sha256}


def external_input(path: str, required: list[str]) -> dict[str, Any]:
    """The run's committed external snapshot. The job re-checks each file's SHA-256 on the
    exact bytes it parses; catting CSVs here would print them and decode them as text."""
    if not EXTERNAL_PATH_RE.fullmatch(path):
        raise GoldDataContractError(f"external input must be a run snapshot path: {path}")
    marker, ready_sha256 = hdfs_json(f"{path}/_READY.json")
    sources = marker.get("sources")
    if marker.get("schema") != EXTERNAL_READY_SCHEMA or not isinstance(sources, dict) or sorted(sources) != sorted(required):
        raise GoldDataContractError(f"external snapshot does not cover exactly {sorted(required)}")
    missing = sorted(name for name in sources if not hdfs_exists(f"{path}/sources/{name}.csv"))
    if missing:
        raise GoldDataContractError(f"external source files missing: {missing}")
    fsck_healthy(path)
    return {"ready_sha256": ready_sha256, "sources": sources}


def spark_staging(run_id: str, attempt_id: str) -> str:
    return f"/lake/gold/.spark-staging/run={run_id}/attempt={attempt_id}"


def prepare_paths(output: str, run_id: str, attempt_id: str) -> None:
    staging = spark_staging(run_id, attempt_id)
    hdfs("dfs", "-mkdir", "-p", output, staging)
    hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", output, staging)
    hdfs("dfs", "-chmod", "0750", output, staging)


def cleanup_spark_staging(run_id: str, attempt_id: str, output: str) -> None:
    staging = spark_staging(run_id, attempt_id)
    if hdfs_exists(staging):
        hdfs("dfs", "-rm", "-r", "-skipTrash", staging, check=False)
    remove_empty_dir(staging.rsplit("/", 1)[0])
    remove_empty_dir(output.rsplit("/", 1)[0])


def discard_failed_attempt(run_id: str, attempt_id: str, output: str, application_id: str | None) -> bool:
    """Remove a restartable attempt's staging once its app has ended; never touch a final path."""
    if not STAGING_OUTPUT_RE.fullmatch(output):
        raise RuntimeError(f"refusing to discard an unexpected path: {output}")
    if application_id and application_state(application_id) not in TERMINAL_APP_STATES:
        print(f"GOLD_CLEANUP_SKIPPED application={application_id} output={output}", flush=True)
        return False
    if hdfs_exists(output):
        hdfs("dfs", "-rm", "-r", "-skipTrash", output, check=False)
    cleanup_spark_staging(run_id, attempt_id, output)
    return True


def terminal_error(output: str) -> GoldDataContractError | None:
    if not hdfs_exists(f"{output}/_TERMINAL/_SUCCESS"):
        return None
    marker, _ = hdfs_json(f"{output}/_TERMINAL/part-*")
    if marker.get("schema") != GOLD_TERMINAL_SCHEMA or marker.get("failure_type") != "data_contract":
        raise RuntimeError(f"invalid Gold terminal marker: {output}/_TERMINAL")
    return GoldDataContractError(f"Gold contract failed: {marker.get('error_detail', '')}")


def spark_submit(*, release_dir: Path, runtime_hdfs: str, name: str, staging: str, job: str,
                 files: tuple[str, ...] = (), driver_conf: tuple[str, ...] = ()) -> list[str]:
    """docker spark-submit up to the job file; job and files are mounted from the release."""
    mounts = [arg for path in (f"spark/{job}", *files)
              for arg in ("-v", f"{release_dir / path}:/opt/planetory/{Path(path).name}:ro")]
    shipped = ["--files", ",".join(f"/opt/planetory/{Path(path).name}" for path in files)] if files else []
    return [
        "sudo", "docker", "run", "--rm", "--network", "host", *HOST_ARGS,
        "-e", "HADOOP_CONF_DIR=/etc/hadoop", "-e", "YARN_CONF_DIR=/etc/hadoop",
        "-e", f"HADOOP_USER_NAME={SPARK_HDFS_USER}",
        "-v", "/etc/hadoop:/etc/hadoop:ro", *mounts,
        "--entrypoint", "/opt/spark/bin/spark-submit", SPARK_IMAGE,
        "--master", "yarn", "--deploy-mode", "cluster", "--name", name,
        "--archives", f"hdfs://planetory{runtime_hdfs}#environment", *shipped,
        "--conf", "spark.driver.port=7078", "--conf", "spark.blockManager.port=7079",
        "--conf", f"spark.yarn.stagingDir=hdfs://planetory{staging}",
        # Executors use the Silver container size (7 GiB, 3 per 24 GiB NodeManager) so YARN
        # spreads them the same way; see tess_silver_ctl.submit.
        "--conf", "spark.dynamicAllocation.enabled=true",
        "--conf", "spark.dynamicAllocation.shuffleTracking.enabled=true",
        "--conf", "spark.dynamicAllocation.initialExecutors=14",
        "--conf", "spark.dynamicAllocation.maxExecutors=14",
        "--conf", "spark.dynamicAllocation.minExecutors=2",
        "--conf", "spark.dynamicAllocation.executorIdleTimeout=300s",
        "--conf", "spark.executor.cores=2",
        "--conf", "spark.executor.memory=5g", "--conf", "spark.executor.memoryOverhead=2048",
        "--conf", "spark.executorEnv.OMP_NUM_THREADS=1",
        *driver_conf,
        "--conf", "spark.pyspark.python=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3",
        "--conf", "spark.executorEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.appMasterEnv.PYTHONPATH=./environment",
        "--conf", "spark.yarn.maxAppAttempts=1", "--conf", "spark.speculation=false",
        *event_log_conf(),
        f"/opt/planetory/{job}",
    ]


def submit_command(*, release_dir: Path, runtime_hdfs: str, coverage: dict[str, Any], args: argparse.Namespace,
                   attempt_id: str, output: str) -> list[str]:
    command = spark_submit(
        release_dir=release_dir, runtime_hdfs=runtime_hdfs, job="tess_gold.py",
        name=f"S15P21C206-80-gold-{args.run_id}-{attempt_id}", staging=spark_staging(args.run_id, attempt_id),
        # ponytail: the driver combines every light star result (no payloads) in memory; raise
        # these if a larger run's rows and record checksums outgrow them.
        driver_conf=("--conf", "spark.driver.memory=4g", "--conf", "spark.driver.memoryOverhead=1024",
                     "--conf", "spark.driver.maxResultSize=3g"))
    command += [
        "--silver-attempt", f"hdfs://planetory{args.silver_attempt}",
        "--external", f"hdfs://planetory{args.external}",
        "--approval-identity", args.approval_identity,
        "--approval-discoverability", args.approval_discoverability,
        "--approval-external", args.approval_external,
        "--run-id", args.run_id, "--attempt-id", attempt_id,
        "--output", f"hdfs://planetory{output}",
        "--shuffle-partitions", str(args.shuffle_partitions),
        "--output-partitions", str(args.output_partitions),
    ]
    for path in coverage["bronze_paths"]:
        command.extend(["--bronze-path", f"hdfs://planetory{path}"])
    for name in args.required_source:
        command.extend(["--required-source", name])
    for tic_id in args.exclude_tic:
        command.extend(["--exclude-tic", str(tic_id)])
    for tic_id in getattr(args, "tic_id", None) or []:
        command.extend(["--tic-id", str(tic_id)])
    return command


def submit(command: list[str], output: str, state_file: Path, state: dict[str, Any]) -> str:
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
    if process.wait() or not application_id:
        if error := terminal_error(output):
            raise error
        raise RuntimeError("spark-submit failed or did not report an application id")
    try:
        wait_application(application_id, label="GOLD")
    except RuntimeError:
        if error := terminal_error(output):
            raise error
        raise
    return application_id


def read_summary(output: str) -> dict[str, Any]:
    lines = hdfs("dfs", "-cat", f"{output}/summary/part-*").stdout.splitlines()
    if len(lines) != 1:
        raise GoldDataContractError("expected one Gold summary line")
    summary = json.loads(lines[0])
    if not summary.get("contract_ok"):
        raise GoldDataContractError(f"Gold outputs disagree with the manifest: {summary}")
    return summary


def file_digest(path: str) -> dict[str, Any]:
    """SHA-256, size and line count of one HDFS file, streamed so its content is never printed."""
    process = subprocess.Popen([*HDFS_COMMAND, "dfs", "-cat", path], stdout=subprocess.PIPE)
    digest, size, lines = hashlib.sha256(), 0, 0
    assert process.stdout is not None
    for chunk in iter(lambda: process.stdout.read(1 << 20), b""):
        digest.update(chunk)
        size += len(chunk)
        lines += chunk.count(b"\n")
    if process.wait():
        raise RuntimeError(f"hdfs cat failed: {path}")
    return {"sha256": digest.hexdigest(), "bytes": size, "lines": lines}


def output_files(root: str) -> dict[str, dict[str, Any]]:
    """Every part file of the outputs, keyed by its path relative to the attempt."""
    files = {}
    for name in OUTPUTS:
        parts = sorted(p for p in hdfs("dfs", "-ls", "-C", f"{root}/{name}/part-*").stdout.split()
                       if p.rsplit("/", 1)[-1].startswith("part-"))
        if not parts:
            raise RuntimeError(f"no part files in {root}/{name}")
        files.update({f"{name}/{p.rsplit('/', 1)[-1]}": file_digest(p) for p in parts})
    return files


def ready_marker(*, args: argparse.Namespace, attempt_id: str, coverage: dict[str, Any], silver: dict[str, Any],
                 external: dict[str, Any], summary: dict[str, Any], application_id: str,
                 files: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": GOLD_READY_SCHEMA,
        "run_id": args.run_id,
        "attempt_id": attempt_id,
        "silver_attempt": args.silver_attempt,
        "silver_ready_sha256": silver["ready_sha256"],
        "bronze_coverage_sha256": coverage["coverage_sha256"],
        "bronze_coverage_ready_sha256": coverage["ready_sha256"],
        "external": args.external,
        "external_ready_sha256": external["ready_sha256"],
        "external_sources": external["sources"],
        "required_sources": sorted(args.required_source),
        "excluded_tics": sorted(args.exclude_tic),
        "canary_tics": sorted(getattr(args, "tic_id", None) or []),
        "approvals": {"identity": args.approval_identity, "discoverability": args.approval_discoverability,
                      "external": args.approval_external},
        **{key: summary[key] for key in ("status", "complete", "counts", "target_tic_count",
                                         "candidate_count", "candidates_sha256")},
        "spark_application_id": application_id,
        "replication": 2,
        "files": files,
        "completed_at_utc": utc_now(),
    }


def audit_gold(final: str, marker: dict[str, Any], *, content: bool = True) -> None:
    """Marker, part-file content and FSCK. A rename inside HDFS keeps content, so the
    commit itself skips re-hashing; the gate re-hashes every file."""
    committed, _ = hdfs_json(f"{final}/_READY.json")
    if committed != marker:
        raise GoldDataContractError("Gold attempt marker changed during commit")
    if content and output_files(final) != marker["files"]:
        raise GoldDataContractError("Gold part files differ from the attempt marker")
    fsck_healthy(final)


def finalize(*, release_dir: Path, output: str, final: str, **fields: Any) -> dict[str, Any]:
    summary = read_summary(output)
    for name in OUTPUTS:
        hdfs("dfs", "-setrep", "-w", "2", f"{output}/{name}")
    marker = ready_marker(summary=summary, files=output_files(output), **fields)
    payload = json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n"
    hdfs("dfs", "-put", "-", f"{output}/_READY.json.part", input_text=payload)
    hdfs("dfs", "-mv", f"{output}/_READY.json.part", f"{output}/_READY.json")
    fsck_healthy(output)
    if hdfs_exists(final):
        raise GoldDataContractError(f"final Gold attempt already exists: {final}")
    parent = final.rsplit("/", 1)[0]
    if not hdfs_exists(parent):
        hdfs("dfs", "-mkdir", "-p", parent)
        hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", parent)
        hdfs("dfs", "-chmod", "0750", parent)
    atomic_commit(release_dir, output, final)
    audit_gold(final, marker, content=False)
    print(f"GOLD_COMMIT_OK status={marker['status']} counts={json.dumps(marker['counts'], sort_keys=True)} "
          f"final={final}", flush=True)
    return marker


def committed_attempt(args: argparse.Namespace) -> tuple[str, dict[str, Any]] | None:
    """This run's already committed attempt, re-audited, or None.

    A crash after the atomic commit but before the state file says complete would otherwise
    make the restarted unit compute and commit a second attempt for the same run.
    """
    root = f"{GOLD_ROOT}/run_id={args.run_id}"
    if not hdfs_exists(root):
        return None
    finals = []
    for line in hdfs("dfs", "-ls", root).stdout.splitlines():
        fields = line.split()
        if fields and GOLD_ATTEMPT_RE.fullmatch(fields[-1]):
            finals.append(fields[-1])
    if not finals:
        return None
    if len(finals) > 1:
        raise GoldDataContractError(f"run {args.run_id} has {len(finals)} committed attempts; resolve them first")
    marker, _ = hdfs_json(f"{finals[0]}/_READY.json")
    requested = {"silver_attempt": args.silver_attempt, "external": args.external,
                 "required_sources": sorted(args.required_source), "excluded_tics": sorted(args.exclude_tic),
                 "approvals": {"identity": args.approval_identity, "discoverability": args.approval_discoverability,
                               "external": args.approval_external}}
    if any(marker.get(key) != value for key, value in requested.items()):
        raise GoldDataContractError(f"committed attempt {finals[0]} was made from other inputs; use a new run ID")
    audit_gold(finals[0], marker, content=False)
    return finals[0], marker


def run_attempt(args: argparse.Namespace, *, validation: bool = False) -> tuple[str, dict[str, Any]]:
    attempt_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = VALIDATION_ROOT if validation else "/lake/gold/tess"
    output = f"{root}/.staging/run={args.run_id}/attempt={attempt_id}"
    final = (f"{VALIDATION_ROOT}/run={args.run_id}/attempt={attempt_id}" if validation
             else f"{GOLD_ROOT}/run_id={args.run_id}/attempt={attempt_id}")
    state_file = Path(args.state_root) / f"run={args.run_id}" / f"attempt={attempt_id}.json"
    state = {"run_id": args.run_id, "attempt_id": attempt_id, "command": args.command, "output": output,
             "unit": unit_name(args.command, args.run_id), "final": final, "status": "prepared",
             "updated_at_utc": utc_now()}
    # Written before the input checks, so a contract failure there reaches Airflow with its reason.
    write_state(state_file, state)
    try:
        if not validation and (adopted := committed_attempt(args)):
            final, marker = adopted
            state.update(status="complete", final=final, adopted=True, result=marker, updated_at_utc=utc_now())
            write_state(state_file, state)
            print(f"GOLD_COMMITTED_ATTEMPT_ADOPTED final={final}", flush=True)
            return final, marker
        coverage = cluster_preflight(args.bronze_coverage)
        silver = silver_input(args.silver_attempt, coverage)
        external = external_input(args.external, args.required_source)
        release_dir = Path(args.release_dir).resolve()
        runtime_hdfs = build_runtime(release_dir)
        prepare_paths(output, args.run_id, attempt_id)
        command = submit_command(release_dir=release_dir, runtime_hdfs=runtime_hdfs, coverage=coverage,
                                 args=args, attempt_id=attempt_id, output=output)
        application_id = submit(command, output, state_file, state)
        marker = finalize(release_dir=release_dir, output=output, final=final, args=args, attempt_id=attempt_id,
                          coverage=coverage, silver=silver, external=external, application_id=application_id)
        cleanup_spark_staging(args.run_id, attempt_id, output)
    except (GoldDataContractError, SilverDataContractError) as exc:
        # Contract failures are not restarted, so their staging stays for diagnosis.
        state.update(status="terminal_failed", failure_detail=str(exc)[:500], updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    except Exception as exc:
        discarded = discard_failed_attempt(args.run_id, attempt_id, output, state.get("application_id"))
        state.update(status="failed", failure_detail=f"{type(exc).__name__}: {exc}"[:500],
                     staging_discarded=discarded, updated_at_utc=utc_now())
        write_state(state_file, state)
        raise
    state.update(status="complete", result=marker, updated_at_utc=utc_now())
    write_state(state_file, state)
    return final, marker


def gate_input(attempt: str) -> tuple[str, dict[str, Any], str]:
    """A committed, complete, non-canary Gold attempt whose storage and inputs are unchanged."""
    match = GOLD_ATTEMPT_RE.fullmatch(attempt)
    if not match:
        raise GoldDataContractError(f"gate input must be a committed Gold attempt path: {attempt}")
    marker, ready_sha256 = hdfs_json(f"{attempt}/_READY.json")
    if marker.get("schema") != GOLD_READY_SCHEMA or marker.get("run_id") != match.group(1):
        raise GoldDataContractError("Gold attempt marker does not match its path")
    if marker.get("canary_tics"):
        raise GoldDataContractError("a canary attempt is never publish-ready")
    if marker.get("status") != "complete" or marker.get("complete") is not True:
        raise GoldDataContractError("run is incomplete: request_failed or unprocessed targets remain")
    audit_gold(attempt, marker)
    for path, key in ((marker["silver_attempt"], "silver_ready_sha256"), (marker["external"], "external_ready_sha256")):
        if hdfs_json(f"{path}/_READY.json")[1] != marker[key]:
            raise GoldDataContractError(f"input changed since the Gold attempt: {key}")
    return match.group(1), marker, ready_sha256


def gate_paths(run_id: str, check_id: str) -> tuple[str, str]:
    return f"{GATE_ROOT}/run={run_id}/check={check_id}", f"{GATE_ROOT}/.spark-staging/run={run_id}/check={check_id}"


def gate_command(*, release_dir: Path, runtime_hdfs: str, run_id: str, check_id: str, attempt: str,
                 output: str) -> list[str]:
    return spark_submit(
        release_dir=release_dir, runtime_hdfs=runtime_hdfs, job="tess_gate.py", files=(SCHEMA_FILE,),
        name=f"S15P21C206-80-gate-{run_id}-{check_id}", staging=gate_paths(run_id, check_id)[1],
        driver_conf=("--conf", "spark.driver.memory=2g", "--conf", "spark.driver.memoryOverhead=1024")) + [
        "--attempt", f"hdfs://planetory{attempt}", "--schema", Path(SCHEMA_FILE).name, "--run-id", run_id,
        "--output", f"hdfs://planetory{output}"]


def read_verdict(output: str, run_id: str, attempt: str) -> dict[str, Any]:
    lines = hdfs("dfs", "-cat", f"{output}/verdict/part-*").stdout.splitlines()
    verdict = json.loads(lines[0]) if len(lines) == 1 else {}
    if (verdict.get("schema"), verdict.get("run_id"), verdict.get("attempt")) != (GATE_VERDICT_SCHEMA, run_id, attempt):
        raise RuntimeError(f"invalid gate verdict in {output}")
    return verdict


def write_publish_ready(run_id: str, attempt: str, gold_ready_sha256: str, marker: dict[str, Any],
                        verdict: dict[str, Any], check_id: str) -> dict[str, Any]:
    """The only writer of publish-ready. mv refuses an existing marker, so two gates cannot both win."""
    value = {
        "schema": PUBLISH_READY_SCHEMA, "run_id": run_id, "attempt": attempt, "gold_ready_sha256": gold_ready_sha256,
        **{key: verdict[key] for key in ("gate_version", "checked_at_utc", "bundles", "candidates",
                                         "candidates_sha256")},
        # files: attempt-relative part paths with sha256, bytes and lines, for the Publisher's download check.
        **{key: marker[key] for key in ("counts", "excluded_tics", "approvals", "silver_attempt", "external",
                                        "files")},
        "completed_at_utc": utc_now(),
    }
    folder = f"{PUBLISH_READY_ROOT}/run_id={run_id}"
    hdfs("dfs", "-mkdir", "-p", folder)
    part = f"{folder}/_READY.json.{check_id}.part"  # per check, so a concurrent gate cannot swap its content
    hdfs("dfs", "-put", "-f", "-", part, input_text=json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
    hdfs("dfs", "-setrep", "-w", "2", part)
    hdfs("dfs", "-mv", part, f"{folder}/_READY.json")
    print(f"GOLD_PUBLISH_READY run={run_id} attempt={attempt}", flush=True)
    return value


def application_ended(application_id: str | None) -> bool:
    if not application_id:
        return True
    try:
        return application_state(application_id) in TERMINAL_APP_STATES
    except Exception:  # an unreadable YARN state keeps the staging a running app may still need
        return False


def command_gate(args: argparse.Namespace) -> None:
    match = GOLD_ATTEMPT_RE.fullmatch(args.attempt)
    if not match:
        raise GoldDataContractError(f"gate input must be a committed Gold attempt path: {args.attempt}")
    run_id, check_id = match.group(1), datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output, staging = gate_paths(run_id, check_id)
    state_file = Path(args.state_root) / f"run={run_id}" / f"gate={check_id}.json"
    state = {"run_id": run_id, "command": "gate", "attempt": args.attempt, "output": output,
             "unit": unit_name("gate", run_id), "status": "prepared", "updated_at_utc": utc_now()}
    write_state(state_file, state)
    try:
        _, marker, gold_ready_sha256 = gate_input(args.attempt)
        ready = f"{PUBLISH_READY_ROOT}/run_id={run_id}/_READY.json"
        if hdfs_exists(ready):
            value, _ = hdfs_json(ready)
            if (value.get("attempt"), value.get("gold_ready_sha256")) != (args.attempt, gold_ready_sha256):
                raise GoldDataContractError(f"run {run_id} is already publish-ready with another attempt")
            # Also the restart after an interrupted gate: record the state it did not get to write.
            print(f"GOLD_PUBLISH_READY_CACHED run={run_id}", flush=True)
        else:
            release_dir = Path(args.release_dir).resolve()
            runtime_hdfs = build_runtime(release_dir)
            hdfs("dfs", "-mkdir", "-p", output, staging)
            hdfs("dfs", "-chown", f"{SPARK_HDFS_USER}:hadoop", output, staging)
            try:
                submit(gate_command(release_dir=release_dir, runtime_hdfs=runtime_hdfs, run_id=run_id,
                                    check_id=check_id, attempt=args.attempt, output=output), output, state_file, state)
            finally:
                if application_ended(state.get("application_id")):
                    hdfs("dfs", "-rm", "-r", "-skipTrash", staging, check=False)
            verdict = read_verdict(output, run_id, args.attempt)
            if not verdict["ok"]:
                # The verdict stays under .gate for diagnosis; no publish-ready is written.
                state.update(status="rejected", errors=verdict["errors"], updated_at_utc=utc_now())
                write_state(state_file, state)
                raise GoldDataContractError("publish gate rejected the attempt: " + "; ".join(verdict["errors"][:5]))
            value = write_publish_ready(run_id, args.attempt, gold_ready_sha256, marker, verdict, check_id)
            hdfs("dfs", "-rm", "-r", "-skipTrash", output, check=False)
    except (GoldDataContractError, SilverDataContractError) as exc:
        if state["status"] != "rejected":
            state.update(status="terminal_failed", failure_detail=str(exc)[:500], updated_at_utc=utc_now())
            write_state(state_file, state)
        raise
    state.update(status="publish_ready", result=value, updated_at_utc=utc_now())
    write_state(state_file, state)


def unit_name(operation: str, run_id: str) -> str:
    """One deterministic unit per run and operation, so a retried Airflow task finds the same unit."""
    return f"planetory-tess-gold-{operation}-{run_id}.service"


def operation_argv(args: argparse.Namespace) -> list[str]:
    """The controller command the unit runs; every value is a validated single token."""
    argv = ["/usr/bin/python3.12", f"{args.release_dir}/spark/tess_gold_ctl.py", args.operation]
    if args.operation == "gate":
        return argv + ["--attempt", args.attempt, "--release-dir", args.release_dir]
    argv += ["--release-dir", args.release_dir, "--run-id", args.run_id, "--silver-attempt", args.silver_attempt,
             "--external", args.external]
    for name in args.required_source:
        argv += ["--required-source", name]
    for tic_id in args.exclude_tic:
        argv += ["--exclude-tic", str(tic_id)]
    return argv + ["--approval-identity", args.approval_identity,
                   "--approval-discoverability", args.approval_discoverability,
                   "--approval-external", args.approval_external,
                   "--shuffle-partitions", str(args.shuffle_partitions),
                   "--output-partitions", str(args.output_partitions)]


def unit_text(args: argparse.Namespace, run_id: str) -> str:
    """Same unit shape as the Silver controller: oneshot, restarts on failure, never after exit 65."""
    return "\n".join([
        "[Unit]",
        f"Description=Planetory TESS Gold {args.operation} {run_id}",
        "After=network-online.target hadoop-hdfs-namenode.service hadoop-yarn-resourcemanager.service docker.service",
        "Wants=network-online.target",
        # A deterministic non-contract failure must not resubmit to YARN forever; 7 starts a day is
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


def latest_state(state_root: str, run_id: str, unit: str) -> dict[str, Any] | None:
    """Newest state file this unit wrote; it survives reboots, unlike systemd's result."""
    for path in sorted(Path(state_root, f"run={run_id}").glob("*.json"), reverse=True):
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("unit") == unit:
            return state
    return None


def unit_run_id(args: argparse.Namespace) -> str:
    if args.operation == "run":
        return args.run_id
    match = GOLD_ATTEMPT_RE.fullmatch(args.attempt or "")
    if not match:
        raise GoldDataContractError(f"gate unit needs a committed Gold attempt path: {args.attempt}")
    return match.group(1)


def command_start_unit(args: argparse.Namespace) -> None:
    """Install and start the Gold or gate unit, then return without waiting for Spark."""
    if not RELEASE_DIR_RE.fullmatch(args.release_dir) or (
            Path(__file__).resolve() != Path(args.release_dir, "spark", "tess_gold_ctl.py")):
        raise GoldDataContractError("unit release must be the immutable release running this controller")
    run_id = unit_run_id(args)
    name = unit_name(args.operation, run_id)
    path, text = UNIT_ROOT / name, unit_text(args, run_id)
    if path.exists():
        if path.read_text(encoding="utf-8") != text:
            raise GoldDataContractError(f"UNIT_DEFINITION_MISMATCH {name}")
    else:
        candidate = UNIT_ROOT / f".{name}.part"
        candidate.write_text(text, encoding="utf-8")
        os.chmod(candidate, 0o644)
        os.replace(candidate, path)
        run(["/usr/bin/systemctl", "daemon-reload"])
        run(["/usr/bin/systemctl", "enable", name])
    if systemd_properties(name).get("ActiveState") in ("active", "activating"):
        print(f"GOLD_UNIT_ALREADY_ACTIVE={name}", flush=True)
        return
    if (latest_state(args.state_root, run_id, name) or {}).get("status") == UNIT_DONE[args.operation]:
        print(f"GOLD_UNIT_ALREADY_COMPLETE={name}", flush=True)
        return
    run(["/usr/bin/systemctl", "reset-failed", name], check=False)
    run(["/usr/bin/systemctl", "--no-block", "start", name])
    print(f"GOLD_UNIT_STARTED={name}", flush=True)


def command_status(args: argparse.Namespace) -> None:
    """Read-only unit and latest state for the asynchronous Airflow wait."""
    name = unit_name(args.operation, args.run_id)
    print("GOLD_STATUS_JSON=" + json.dumps(
        {"unit": name, "systemd": systemd_properties(name), "state": latest_state(args.state_root, args.run_id, name)},
        sort_keys=True, separators=(",", ":")), flush=True)


def command_preflight(args: argparse.Namespace) -> None:
    coverage = cluster_preflight(args.bronze_coverage)
    silver_input(args.silver_attempt, coverage)
    external_input(args.external, args.required_source)
    print("GOLD_PREFLIGHT_OK", flush=True)


def command_canary(args: argparse.Namespace) -> None:
    final, marker = run_attempt(args, validation=True)
    print(f"GOLD_CANARY_COUNTS={json.dumps(marker['counts'], sort_keys=True)}", flush=True)
    hdfs("dfs", "-rm", "-r", "-skipTrash", final)
    remove_empty_dir(final.rsplit("/", 1)[0])


def command_run(args: argparse.Namespace) -> None:
    run_attempt(args)


def _run_arguments(child: argparse.ArgumentParser, *, required: bool = True) -> None:
    child.add_argument("--bronze-coverage", default=DEFAULT_BRONZE_COVERAGE)
    child.add_argument("--silver-attempt", required=required)
    child.add_argument("--external", required=required)
    child.add_argument("--required-source", action="append", required=required, default=None)


def _job_arguments(child: argparse.ArgumentParser, *, required: bool = True) -> None:
    child.add_argument("--release-dir", required=True)
    child.add_argument("--run-id", required=required)
    child.add_argument("--exclude-tic", type=int, action="append", default=[])
    for name in ("identity", "discoverability", "external"):
        child.add_argument(f"--approval-{name}", required=required)
    child.add_argument("--shuffle-partitions", type=int, default=400)
    child.add_argument("--output-partitions", type=int, default=40)
    child.add_argument("--state-root", default="/var/lib/planetory-gold")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subparsers = root.add_subparsers(dest="command", required=True)
    for command, handler in (("preflight", command_preflight), ("canary", command_canary), ("run", command_run)):
        child = subparsers.add_parser(command)
        child.set_defaults(handler=handler)
        _run_arguments(child)
        if command != "preflight":
            _job_arguments(child)
        if command == "canary":
            child.add_argument("--tic-id", type=int, action="append", required=True)
    gate = subparsers.add_parser("gate")
    gate.set_defaults(handler=command_gate)
    gate.add_argument("--attempt", required=True)
    gate.add_argument("--release-dir", required=True)
    gate.add_argument("--state-root", default="/var/lib/planetory-gold")
    # Airflow entry points: start a unit that runs `run` or `gate`, and read its state.
    start = subparsers.add_parser("start-unit")
    start.set_defaults(handler=command_start_unit)
    start.add_argument("operation", choices=tuple(UNIT_DONE))
    _run_arguments(start, required=False)
    _job_arguments(start, required=False)
    start.add_argument("--attempt")
    status = subparsers.add_parser("status")
    status.set_defaults(handler=command_status)
    status.add_argument("operation", choices=tuple(UNIT_DONE))
    status.add_argument("--run-id", required=True)
    status.add_argument("--state-root", default="/var/lib/planetory-gold")
    return root


def validate(args: argparse.Namespace) -> None:
    command = args.operation if args.command == "start-unit" else args.command
    if args.command == "status":
        if not RUN_ID_RE.fullmatch(args.run_id):
            raise SystemExit("run ID must be UTC yyyyMMddTHHmmssZ")
        return
    if command == "gate":
        return  # the attempt path and marker are checked by gate_input / unit_run_id
    if not args.required_source or not args.silver_attempt or not args.external:
        raise SystemExit("--silver-attempt, --external and --required-source are required")
    if len(set(args.required_source)) != len(args.required_source):
        raise SystemExit("--required-source must not repeat")
    if not ATTEMPT_PATH_RE.fullmatch(args.silver_attempt) or not EXTERNAL_PATH_RE.fullmatch(args.external):
        raise SystemExit("--silver-attempt and --external must be committed attempt and snapshot paths")
    if command == "preflight":
        return
    if not RUN_ID_RE.fullmatch(args.run_id or ""):
        raise SystemExit("run ID must be UTC yyyyMMddTHHmmssZ")
    approvals = (args.approval_identity, args.approval_discoverability, args.approval_external)
    if not all(isinstance(value, str) and APPROVAL_RE.fullmatch(value) for value in approvals):
        raise SystemExit("approval references must be single tokens of letters, digits and ._/-")
    tics = getattr(args, "tic_id", None) or []
    if len(tics) > 5 or any(value <= 0 for value in [*tics, *args.exclude_tic]):
        raise SystemExit("canary takes at most five positive TIC IDs; excluded TICs must be positive")
    if not 1 <= args.shuffle_partitions <= 2000 or not 1 <= args.output_partitions <= 200:
        raise SystemExit("shuffle partitions must be in 1..2000 and output partitions in 1..200")


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    validate(args)
    try:
        if args.command in ("preflight", "start-unit", "status"):
            args.handler(args)
        else:
            if args.command == "run" and (latest_state(args.state_root, args.run_id, unit_name("run", args.run_id))
                                          or {}).get("status") == "complete":
                raise GoldDataContractError(f"GOLD_RUN_ALREADY_COMPLETE {args.run_id}; use a new run ID")
            with yarn_slot():
                args.handler(args)
        return 0
    except (GoldDataContractError, SilverDataContractError) as exc:
        print(f"GOLD_TERMINAL_FAILURE {exc}", file=sys.stderr, flush=True)
        return DATA_CONTRACT_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())

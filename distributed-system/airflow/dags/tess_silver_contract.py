"""Strict, shell-safe request contract for the legacy Bronze coverage Silver run."""

from __future__ import annotations

import re
import shlex


RELEASE = re.compile(r"/opt/planetory-silver/releases/[0-9]{8}T[0-9]{6}Z")
COVERAGE = re.compile(r"/lake/bronze/tess/coverage=[0-9a-f]{64}")
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
RETRY = re.compile(
    r"/lake/silver/pipeline_version=[A-Za-z0-9._-]+/"
    r"run_id=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z"
)


def silver_command(conf: dict) -> str:
    """Build only the arguments allowed by the Node 1 Silver sudo policy."""
    if not isinstance(conf, dict):
        raise ValueError("Silver DAG requires explicit run configuration")
    allowed = {"operation", "silver_release", "bronze_coverage", "run_id", "pipeline_version",
               "shuffle_partitions", "output_partitions", "tic_ids", "retry_from"}
    if set(conf) - allowed:
        raise ValueError("unknown Silver DAG configuration keys")
    operation = conf.get("operation")
    if operation not in ("canary", "run", "retry"):
        raise ValueError("operation must be canary, run or retry")
    release = str(conf.get("silver_release", ""))
    coverage = str(conf.get("bronze_coverage", ""))
    run_id = str(conf.get("run_id", ""))
    version = str(conf.get("pipeline_version", ""))
    if not (RELEASE.fullmatch(release) and COVERAGE.fullmatch(coverage)
            and RUN_ID.fullmatch(run_id) and VERSION.fullmatch(version)):
        raise ValueError("invalid immutable Silver release, Bronze coverage or run lineage")
    shuffle = conf.get("shuffle_partitions", 200)
    output = conf.get("output_partitions", 80)
    # Up to 2000 so a full run can cut ~256-TIC tasks to ~64 and shorten the slow-worker tail.
    if type(shuffle) is not int or not 1 <= shuffle <= 2000:
        raise ValueError("shuffle_partitions must be in 1..2000")
    if type(output) is not int or not 1 <= output <= 200:
        raise ValueError("output_partitions must be in 1..200")
    tic_ids = conf.get("tic_ids", [])
    retry_from = conf.get("retry_from")
    if not isinstance(tic_ids, list):
        raise ValueError("tic_ids must be a list")
    if operation == "canary":
        if (not 1 <= len(tic_ids) <= 5
                or any(type(tic) is not int or tic <= 0 for tic in tic_ids)
                or len(set(tic_ids)) != len(tic_ids) or retry_from is not None):
            raise ValueError("canary requires one to five distinct positive TIC IDs")
    elif tic_ids:
        raise ValueError("TIC selection is permitted only for canary")
    if operation == "retry":
        if not isinstance(retry_from, str) or not RETRY.fullmatch(retry_from):
            raise ValueError("retry requires an immutable Silver attempt path")
    elif retry_from is not None:
        raise ValueError("retry_from is permitted only for retry")
    # start-unit installs and starts the Silver systemd unit, then returns; Spark keeps running
    # under systemd even if Airflow restarts, and silver_status_command polls it.
    arguments = [
        "/usr/bin/sudo", "-n", "/usr/bin/python3.12", f"{release}/spark/tess_silver_ctl.py",
        "start-unit", operation, "--release-dir", release, "--run-id", run_id,
        "--pipeline-version", version, "--bronze-coverage", coverage,
        "--shuffle-partitions", str(shuffle), "--output-partitions", str(output),
    ]
    for tic in tic_ids:
        arguments.extend(("--tic-id", str(tic)))
    if retry_from is not None:
        arguments.extend(("--retry-from", retry_from))
    return shlex.join(arguments)


def silver_status_command(conf: dict) -> str:
    """Read-only status of the unit silver_command started, validated the same way."""
    silver_command(conf)
    release = str(conf["silver_release"])
    arguments = ["/usr/bin/sudo", "-n", "/usr/bin/python3.12", f"{release}/spark/tess_silver_ctl.py",
                 "status", conf["operation"], "--run-id", str(conf["run_id"])]
    if conf.get("retry_from") is not None:
        arguments.extend(("--retry-from", conf["retry_from"]))
    return shlex.join(arguments)

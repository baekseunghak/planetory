"""Strict, shell-safe request contract for the 80 publication run (external → Gold → gate → approval).

Commands are built in exactly the argument order the Node 1 sudo policy
(configure-tess-gold-airflow-node1.sh) allows; change both together.
"""

from __future__ import annotations

import json
import re
import shlex

RELEASE = re.compile(r"/opt/planetory-silver/releases/[0-9]{8}T[0-9]{6}Z")
RUN_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z")
SILVER = re.compile(r"/lake/silver/pipeline_version=[A-Za-z0-9._-]+/run_id=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z")
GOLD_ATTEMPT = re.compile(r"/lake/gold/tess/publication-candidates/run_id=([0-9]{8}T[0-9]{6}Z)/attempt=[0-9]{8}T[0-9]{6}Z")
APPROVAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}")
SOURCES = ("exofop_toi", "mast_tce_s1_s13", "nea_pscomppars", "nea_toi")
MAX_EXCLUDED = 20
KEYS = {"release", "run_id", "silver_attempt", "required_sources", "exclude_tics", "approvals",
        "shuffle_partitions", "output_partitions"}


def publication_request(conf: dict) -> dict:
    """Validate the trigger conf; the run ID names the external snapshot, Gold run and publish-ready."""
    if not isinstance(conf, dict) or set(conf) - KEYS:
        raise ValueError("publication run requires explicit configuration with known keys only")
    release, run_id, silver = (str(conf.get(key, "")) for key in ("release", "run_id", "silver_attempt"))
    if not (RELEASE.fullmatch(release) and RUN_ID.fullmatch(run_id) and SILVER.fullmatch(silver)):
        raise ValueError("invalid immutable release, run ID or Silver attempt")
    # The collector always fetches all four and Gold requires exactly the collected set, so a
    # subset would pass here and then stop the Gold unit with exit 65.
    sources = conf.get("required_sources")
    if not isinstance(sources, list) or not all(isinstance(s, str) for s in sources) or sorted(sources) != list(SOURCES):
        raise ValueError(f"required_sources must list exactly {SOURCES}")
    # The tutorial stars are in Sectors 1~13, so a run must name what it leaves out, even as [].
    excluded = conf.get("exclude_tics")
    if (not isinstance(excluded, list) or len(excluded) > MAX_EXCLUDED or len(set(excluded)) != len(excluded)
            or any(type(tic) is not int or tic <= 0 for tic in excluded)):
        raise ValueError(f"exclude_tics must list up to {MAX_EXCLUDED} distinct positive TIC IDs")
    approvals = conf.get("approvals")
    if (not isinstance(approvals, dict) or set(approvals) != {"identity", "discoverability", "external"}
            or not all(isinstance(v, str) and APPROVAL.fullmatch(v) for v in approvals.values())):
        raise ValueError("approvals needs identity, discoverability and external single-token references")
    shuffle, output = conf.get("shuffle_partitions", 400), conf.get("output_partitions", 40)
    if type(shuffle) is not int or not 1 <= shuffle <= 2000 or type(output) is not int or not 1 <= output <= 200:
        raise ValueError("shuffle_partitions must be in 1..2000 and output_partitions in 1..200")
    return dict(release=release, run_id=run_id, silver_attempt=silver, required_sources=sorted(sources),
                exclude_tics=sorted(excluded), approvals=dict(approvals), shuffle_partitions=shuffle,
                output_partitions=output, external=f"/lake/external/tess/run_id={run_id}")


def _controller(request: dict, script: str) -> list[str]:
    return ["/usr/bin/sudo", "-n", "/usr/bin/python3.12", f"{request['release']}/spark/{script}"]


def collect_command(request: dict) -> str:
    return shlex.join(_controller(request, "tess_external_ctl.py") + [
        "collect", "--run-id", request["run_id"], "--release-dir", request["release"]])


def gold_start_command(request: dict) -> str:
    arguments = _controller(request, "tess_gold_ctl.py") + [
        "start-unit", "run", "--release-dir", request["release"], "--run-id", request["run_id"],
        "--silver-attempt", request["silver_attempt"], "--external", request["external"]]
    for name in request["required_sources"]:
        arguments += ["--required-source", name]
    for tic in request["exclude_tics"]:
        arguments += ["--exclude-tic", str(tic)]
    approvals = request["approvals"]
    arguments += ["--approval-identity", approvals["identity"], "--approval-discoverability",
                  approvals["discoverability"], "--approval-external", approvals["external"],
                  "--shuffle-partitions", str(request["shuffle_partitions"]),
                  "--output-partitions", str(request["output_partitions"])]
    return shlex.join(arguments)


def gate_start_command(request: dict, attempt: str) -> str:
    match = GOLD_ATTEMPT.fullmatch(str(attempt))
    if not match or match.group(1) != request["run_id"]:
        raise ValueError(f"gate needs this run's committed Gold attempt, got {attempt!r}")
    return shlex.join(_controller(request, "tess_gold_ctl.py") + [
        "start-unit", "gate", "--release-dir", request["release"], "--attempt", attempt])


def status_command(request: dict, operation: str) -> str:
    if operation not in ("run", "gate"):
        raise ValueError("status operation must be run or gate")
    return shlex.join(_controller(request, "tess_gold_ctl.py") + ["status", operation, "--run-id", request["run_id"]])


def unit_progress(output: str, done: str, max_restarts: int) -> tuple[str, object]:
    """From controller `status` output: ("complete", state), ("pending", None) or ("failed"/"terminal", reason)."""
    rows = [line.removeprefix("GOLD_STATUS_JSON=") for line in output.splitlines()
            if line.startswith("GOLD_STATUS_JSON=")]
    if len(rows) != 1:
        return "failed", "status returned no unique result"
    try:
        value = json.loads(rows[0])
    except json.JSONDecodeError:
        return "failed", "status returned invalid JSON"
    unit, state = value.get("systemd") or {}, value.get("state") or {}
    active = unit.get("ActiveState") in ("active", "activating")
    if unit.get("LoadState") != "loaded":
        return "terminal", f"unit is not installed: {value.get('unit')}"
    # The state file survives a reboot; systemd's result does not.
    if state.get("status") == done and not active:
        return "complete", state
    # A running unit has not written its own state yet, so an older attempt's state must not end the wait.
    if not active and (state.get("status") in ("terminal_failed", "rejected") or unit.get("ExecMainStatus") == "65"):
        return "terminal", f"data contract failed: {state.get('failure_detail') or state.get('errors')}"
    if active:
        if int(unit.get("NRestarts") or 0) > max_restarts:
            return "terminal", f"unit keeps restarting under systemd: {state.get('failure_detail')}"
        return "pending", None
    if unit.get("ActiveState") == "inactive" and unit.get("ExecMainStartTimestampMonotonic") == "0":
        return "pending", None  # queued by --no-block start, or not yet restarted after a reboot
    return "terminal", (f"unit ended without completing: state={unit.get('ActiveState')} "
                        f"result={unit.get('Result')} status={state.get('status')}")

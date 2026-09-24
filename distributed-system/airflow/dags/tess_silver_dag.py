"""Opt-in 1..13 Bronze coverage to Silver Spark/YARN execution.

Airflow starts a systemd unit on Node 1 and waits through the Triggerer instead of holding an
SSH session for the days a full run takes, so an Airflow restart or redeploy does not stop Silver.
The YARN cap is enforced on Node 1 by the controller's slot files and headroom check.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from airflow.providers.standard.triggers.temporal import TimeDeltaTrigger
from airflow.sdk import BaseOperator, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowException, AirflowFailException

from tess_pipeline_contract import remaining_wait_time
from tess_pipeline_remote import remote, require_success
from tess_silver_contract import silver_command, silver_status_command

WAIT_LIMIT = timedelta(days=14)
POLL_INTERVAL = timedelta(minutes=5)
STATUS_TIMEOUT_SECONDS = 120
# A few lost polls must not fail a days-long run that keeps going under systemd.
MAX_STATUS_FAILURES = 6
# The unit restarts every 5 minutes without limit; past this the cause is persistent.
MAX_UNIT_RESTARTS = 6


def request_commands(conf: dict) -> tuple[str, str]:
    try:
        return silver_command(conf), silver_status_command(conf)
    except ValueError as error:
        raise AirflowFailException(str(error)) from error


def silver_state(status_output: str) -> str:
    """Decide from `status` output: pending, complete, or raise for a finished failure."""
    rows = [line.removeprefix("SILVER_STATUS_JSON=") for line in status_output.splitlines()
            if line.startswith("SILVER_STATUS_JSON=")]
    if len(rows) != 1:
        raise AirflowException("Silver status returned no unique result")
    try:
        value = json.loads(rows[0])
    except json.JSONDecodeError as error:
        raise AirflowException("Silver status returned invalid JSON") from error
    unit, attempt = value.get("systemd") or {}, value.get("attempt") or {}
    active = unit.get("ActiveState") in ("active", "activating")
    status = attempt.get("status")
    print(f"SILVER_STATUS unit={value.get('unit')} state={unit.get('ActiveState')}/{unit.get('SubState')} "
          f"restarts={unit.get('NRestarts')} attempt={attempt.get('attempt_id')} status={status} "
          f"app={attempt.get('application_id')}")
    if unit.get("LoadState") != "loaded":
        raise AirflowFailException(f"Silver unit is not installed: {value.get('unit')}")
    # The attempt file survives a reboot; systemd's start time and result do not.
    if status == "complete" and not active:
        result = attempt.get("result") or {}
        print(f"SILVER_COMPLETE final={attempt.get('final')} selected={result.get('selected_tics')} "
              f"failed={result.get('failed_tics')} qa_stopped={result.get('iteration_qa_stopped_tics')}")
        return "complete"
    if status == "terminal_failed" or unit.get("ExecMainStatus") == "65":
        raise AirflowFailException(f"Silver data contract failed: {attempt.get('failure_detail')}")
    if active:
        restarts = int(unit.get("NRestarts") or 0)
        if restarts > MAX_UNIT_RESTARTS:
            raise AirflowFailException(
                f"Silver unit restarted {restarts} times and keeps restarting under systemd until stopped: "
                f"{attempt.get('failure_detail')}")
        return "pending"
    # Queued by `--no-block start`, or enabled and not yet started again after a reboot.
    if unit.get("ActiveState") == "inactive" and unit.get("ExecMainStartTimestampMonotonic") == "0":
        return "pending"
    raise AirflowFailException(
        f"Silver unit ended without a complete attempt: state={unit.get('ActiveState')} "
        f"result={unit.get('Result')} attempt={status} detail={attempt.get('failure_detail')}")


class SilverUnitWaitOperator(BaseOperator):
    """Poll the Silver unit through the Triggerer without holding a LocalExecutor slot."""

    def _check_or_defer(self, context: dict, failures: int) -> None:
        _, status_command = request_commands(context["dag_run"].conf)
        try:
            code, output = remote("planetory_node_1", status_command, timeout=STATUS_TIMEOUT_SECONDS)
        except Exception as error:  # SSH transport only; the unit keeps running without Airflow.
            code, output = None, f"{type(error).__name__}: {error}"
        if code == 0:
            failures = 0
            if silver_state(output) == "complete":
                return
        else:
            failures += 1
            print(f"SILVER_STATUS_UNAVAILABLE failures={failures} exit={code} {output[-500:]}")
            if failures > MAX_STATUS_FAILURES:
                raise AirflowException(f"Silver status failed {failures} times in a row on Node 1")
        remaining = remaining_wait_time(context["ti"].start_date, WAIT_LIMIT, datetime.now(timezone.utc))
        if remaining <= timedelta():
            raise AirflowFailException("Silver did not complete within 14 days")
        self.defer(trigger=TimeDeltaTrigger(POLL_INTERVAL), method_name="execute_complete",
                   kwargs={"failures": failures}, timeout=remaining)

    def execute(self, context: dict) -> None:
        self._check_or_defer(context, failures=0)

    def execute_complete(self, context: dict, event: dict | None = None, failures: int = 0) -> None:
        self._check_or_defer(context, failures)


@dag(
    dag_id="tess_bronze_to_silver",
    dag_display_name="tess_bronze_to_silver · Bronze 1~13 → Silver",
    description="Sector 1~13 Bronze coverage를 Silver로 처리한다(수동 실행).",
    schedule=None,
    start_date=datetime(2026, 9, 22, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(days=15),
    tags=["tess", "silver", "yarn"],
)
def silver_dag():
    @task(task_id="validate_request")
    def validate_request() -> None:
        request_commands(get_current_context()["dag_run"].conf)

    @task(task_id="start_unit", retries=3, retry_delay=timedelta(minutes=5))
    def start_unit() -> None:
        # The unit name is deterministic, so a retried task finds the same unit instead of a new run.
        start_command, _ = request_commands(get_current_context()["dag_run"].conf)
        require_success("planetory_node_1", start_command, terminal_exit=65)

    wait = SilverUnitWaitOperator(task_id="wait_silver", retries=3, retry_delay=timedelta(minutes=5))
    validate_request() >> start_unit() >> wait


silver_dag()

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
    if unit.get("LoadState") != "loaded":
        raise AirflowFailException(f"Silver unit is not installed: {value.get('unit')}")
    # A queued or auto-restarting oneshot unit is still activating; never-started means not yet.
    if unit.get("ActiveState") in ("active", "activating") or unit.get("ExecMainStartTimestampMonotonic") == "0":
        return "pending"
    if unit.get("Result") == "success" and attempt.get("status") == "complete":
        result = attempt.get("result") or {}
        print(f"SILVER_COMPLETE final={attempt.get('final')} selected={result.get('selected_tics')} "
              f"failed={result.get('failed_tics')} qa_stopped={result.get('iteration_qa_stopped_tics')}")
        return "complete"
    if attempt.get("status") == "terminal_failed" or unit.get("ExecMainStatus") == "65":
        raise AirflowFailException(f"Silver data contract failed: {attempt.get('failure_detail')}")
    raise AirflowFailException(
        f"Silver unit ended without a complete attempt: result={unit.get('Result')} "
        f"attempt={attempt.get('status')} detail={attempt.get('failure_detail')}")


class SilverUnitWaitOperator(BaseOperator):
    """Poll the Silver unit through the Triggerer without holding a LocalExecutor slot."""

    def _check_or_defer(self, context: dict) -> None:
        _, status_command = request_commands(context["dag_run"].conf)
        code, output = remote("planetory_node_1", status_command)
        if code:
            raise AirflowException(f"Silver status failed on Node 1 (exit {code}): {output}")
        if silver_state(output) == "complete":
            return
        remaining = remaining_wait_time(context["ti"].start_date, WAIT_LIMIT, datetime.now(timezone.utc))
        if remaining <= timedelta():
            raise AirflowFailException("Silver did not complete within 14 days")
        self.defer(trigger=TimeDeltaTrigger(POLL_INTERVAL), method_name="execute_complete",
                   timeout=remaining)

    def execute(self, context: dict) -> None:
        self._check_or_defer(context)

    def execute_complete(self, context: dict, event: dict | None = None) -> None:
        self._check_or_defer(context)


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

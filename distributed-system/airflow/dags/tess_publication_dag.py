"""80 publication run: external catalogs → Gold → publish gate → human approval → publish, under one run ID.

Gold, the gate and the publish step run as systemd units on Node 1 and are polled through the Triggerer,
so an Airflow restart or redeploy does not stop them. Airflow only submits; Spark runs on YARN. The 276
publish step runs downstream of approve_publication, so only an approved run is published.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from airflow.providers.standard.operators.hitl import ApprovalOperator
from airflow.providers.standard.triggers.temporal import TimeDeltaTrigger
from airflow.sdk import BaseOperator, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowException, AirflowFailException

from tess_pipeline_contract import remaining_wait_time
from tess_pipeline_remote import remote, require_success
from tess_publication_contract import (collect_command, gate_start_command, gold_start_command,
                                       publication_request, publish_start_command, status_command, unit_progress)

WAIT_LIMIT = timedelta(days=3)
POLL_INTERVAL = timedelta(minutes=5)
STATUS_TIMEOUT_SECONDS = 120
MAX_STATUS_FAILURES = 6
MAX_UNIT_RESTARTS = 6
DONE = {"run": "complete", "gate": "publish_ready", "publish": "complete"}


def request(conf: dict) -> dict:
    try:
        return publication_request(conf)
    except (ValueError, TypeError) as error:
        raise AirflowFailException(str(error)) from error


class GoldUnitWaitOperator(BaseOperator):
    """Poll a Gold, gate or publish unit through the Triggerer without holding a LocalExecutor slot."""

    def __init__(self, *, operation: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.operation = operation

    def _check_or_defer(self, context: dict, failures: int):
        command = status_command(request(context["dag_run"].conf), self.operation)
        try:
            code, output = remote("planetory_node_1", command, timeout=STATUS_TIMEOUT_SECONDS)
        except Exception as error:  # SSH transport only; the unit keeps running without Airflow.
            code, output = None, f"{type(error).__name__}: {error}"
        progress, detail = unit_progress(output, DONE[self.operation], MAX_UNIT_RESTARTS) if code == 0 else (
            "failed", f"exit={code} {output[-500:]}")
        print(f"GOLD_UNIT_PROGRESS operation={self.operation} progress={progress}")
        if progress == "complete":
            if self.operation == "run":
                return detail["final"]  # the committed attempt the gate checks
            if self.operation == "publish":
                # Run record summary (276). The full per-star record stays in the Node 1 state file.
                record = detail.get("record") or {}
                return {**{key: record.get(key) for key in ("run_id", "approval", "status", "counts")},
                        "notify": (record.get("notify") or {}).get("status"),
                        "not_published": [s for s in record.get("stars") or []
                                          if s.get("code") not in ("PUBLISHED", "ALREADY_PUBLISHED")][:50]}
            ready = detail.get("result") or {}
            return {key: ready.get(key) for key in ("run_id", "attempt", "counts", "bundles", "candidates",
                                                    "excluded_tics")}
        if progress == "terminal":
            raise AirflowFailException(f"Gold {self.operation}: {detail}")
        failures = failures + 1 if progress == "failed" else 0
        if failures > MAX_STATUS_FAILURES:
            raise AirflowException(f"Gold {self.operation} status failed {failures} times in a row: {detail}")
        remaining = remaining_wait_time(context["ti"].start_date, WAIT_LIMIT, datetime.now(timezone.utc))
        if remaining <= timedelta():
            raise AirflowFailException(f"Gold {self.operation} did not complete within {WAIT_LIMIT}")
        # No defer timeout: a TaskDeferralTimeout would be retried with a fresh start_date and stretch
        # the limit; the last poll lands on the deadline and the branch above fails without retry.
        self.defer(trigger=TimeDeltaTrigger(min(POLL_INTERVAL, remaining)), method_name="execute_complete",
                   kwargs={"failures": failures})

    def execute(self, context: dict):
        return self._check_or_defer(context, failures=0)

    def execute_complete(self, context: dict, event: dict | None = None, failures: int = 0):
        return self._check_or_defer(context, failures)


@dag(
    dag_id="tess_publication_run",
    dag_display_name="tess_publication_run · Silver 1~13 → Gold 게시",
    description="외부 카탈로그 수집, Gold 생성, 게시 준비 gate, 수동 게시 승인, 서비스 DB 게시를 run ID 하나로 실행한다(수동 실행).",
    schedule=None,
    start_date=datetime(2026, 9, 27, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(days=14),
    tags=["tess", "gold", "publish"],
)
def publication_dag():
    @task(task_id="validate_request")
    def validate_request() -> None:
        request(get_current_context()["dag_run"].conf)

    @task(task_id="collect_external", retries=3, retry_delay=timedelta(minutes=10),
          execution_timeout=timedelta(hours=1))
    def collect_external() -> None:
        # Idempotent per run ID: a committed snapshot is reused, an interrupted one is replaced.
        require_success("planetory_node_1", collect_command(request(get_current_context()["dag_run"].conf)))

    @task(task_id="start_gold", retries=3, retry_delay=timedelta(minutes=5))
    def start_gold() -> None:
        # The unit name is deterministic, so a retried task finds the same unit instead of a new run.
        require_success("planetory_node_1", gold_start_command(request(get_current_context()["dag_run"].conf)),
                        terminal_exit=65)

    @task(task_id="start_gate", retries=3, retry_delay=timedelta(minutes=5))
    def start_gate(attempt: str) -> None:
        conf = request(get_current_context()["dag_run"].conf)
        try:
            command = gate_start_command(conf, attempt)
        except ValueError as error:
            raise AirflowFailException(str(error)) from error
        require_success("planetory_node_1", command, terminal_exit=65)

    wait_gold = GoldUnitWaitOperator(task_id="wait_gold", operation="run", retries=3,
                                     retry_delay=timedelta(minutes=5))
    wait_gate = GoldUnitWaitOperator(task_id="wait_gate", operation="gate", retries=3,
                                     retry_delay=timedelta(minutes=5))
    approve = ApprovalOperator(
        task_id="approve_publication",
        subject="TESS 게시 승인: run {{ dag_run.conf['run_id'] }}",
        body="게시 준비 gate를 통과했습니다. 승인하면 Publisher 게시 단계로 넘어갑니다.\n\n"
             "{{ ti.xcom_pull(task_ids='wait_gate') | tojson }}",
        fail_on_reject=True,
        response_timeout=timedelta(days=7),
    )

    @task(task_id="start_publish", retries=3, retry_delay=timedelta(minutes=5))
    def start_publish() -> None:
        # Deterministic unit per run: a retried task finds the same unit; a finished one is not restarted.
        require_success("planetory_node_1", publish_start_command(request(get_current_context()["dag_run"].conf)),
                        terminal_exit=65)

    wait_publish = GoldUnitWaitOperator(task_id="wait_publish", operation="publish", retries=3,
                                        retry_delay=timedelta(minutes=5))
    validate_request() >> collect_external() >> start_gold() >> wait_gold
    start_gate(wait_gold.output) >> wait_gate >> approve
    approve >> start_publish() >> wait_publish


publication_dag()

"""Opt-in 1..13 Bronze coverage to Silver Spark/YARN execution."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from airflow.providers.ssh.operators.ssh import SSHOperator
from airflow.sdk import dag, get_current_context, task
from airflow.sdk.exceptions import AirflowFailException

from tess_silver_contract import silver_command


@dag(
    dag_id="tess_bronze_to_silver",
    schedule=None,
    start_date=datetime(2026, 9, 22, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(days=14),
    tags=["tess", "silver", "yarn"],
)
def silver_dag():
    @task(task_id="validate_request")
    def validate_request() -> str:
        # Silver reads immutable 1..13 Bronze coverage while the Sector stages write 14+, so the
        # two no longer have to be drained apart. Concurrency is bounded by the tess_yarn Pool and
        # by the matching Node 1 slot files, not by refusing to start.
        try:
            return silver_command(get_current_context()["dag_run"].conf)
        except ValueError as error:
            raise AirflowFailException(str(error)) from error

    command = validate_request()
    SSHOperator(
        task_id="run_silver",
        ssh_conn_id="planetory_node_1",
        command="{{ ti.xcom_pull(task_ids='validate_request') }}",
        get_pty=True,
        cmd_timeout=None,
        execution_timeout=timedelta(days=14),
        retries=0,
        pool="tess_yarn",
    ).set_upstream(command)


silver_dag()

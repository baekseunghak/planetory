"""Opt-in 1..13 Bronze coverage to Silver Spark/YARN execution."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from airflow.providers.ssh.operators.ssh import SSHOperator
from airflow.sdk import Variable, dag, get_current_context, task
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
        if Variable.get("tess_pipeline_enabled", default="false").lower() != "false":
            raise AirflowFailException("Sector discovery must be drained before legacy Silver")
        # Airflow 3 DAG code has no metadata DB access; read run counts through the Task SDK.
        ti = get_current_context()["ti"]
        for dag_id in ("tess_sector_raw", "tess_sector_bronze"):
            if ti.get_dr_count(dag_id=dag_id, states=["queued", "running"]):
                raise AirflowFailException("Raw/Bronze DAG runs must finish before legacy Silver")
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

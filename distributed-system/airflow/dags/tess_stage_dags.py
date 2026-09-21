"""Sector-parameterized TESS stage DAGs; paused until discovery and runtime gates are ready."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from airflow.decorators import dag, task
from airflow.exceptions import AirflowException, AirflowFailException
from airflow.operators.python import get_current_context
from airflow.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.sensors.base import PokeReturnValue

from tess_pipeline_contract import command, stage_inputs, validate_download_markers
from tess_pipeline_remote import remote, require_success


def inputs() -> dict:
    try:
        return stage_inputs(get_current_context()["dag_run"].conf)
    except ValueError as error:
        raise AirflowFailException(str(error)) from error


def download_markers(value: dict, *, start_missing: bool) -> bool:
    sector, run_id, source_sha = value["sector"], value["run_id"], value["source_list_sha256"]
    markers = []
    pending = False
    for slot in range(1, 6):
        marker = (
            f"/mnt/data/staging/S15P21C206-75/run-{run_id}/manifests/"
            f"sector-{sector}-worker-{slot}.complete.json"
        )
        unit = f"planetory-tess-ingestion-{run_id}-worker-{slot}.service"
        script = f"set -eu\nif test -f {command([marker])}; then cat {command([marker])}; exit 0; fi\n"
        script += f"sudo -n systemctl start {command([unit])}\nexit 75" if start_missing else "exit 76"
        status, output = remote(f"planetory_worker_{slot}", script)
        if status == 75:
            pending = True
            continue
        if status == 76:
            raise AirflowFailException(f"Worker {slot} download marker is missing for Sector {sector}")
        if status:
            raise AirflowException(f"Worker {slot} download marker check failed (exit {status})")
        try:
            markers.append(json.loads(output))
        except json.JSONDecodeError as error:
            raise AirflowFailException(f"Worker {slot} returned an invalid marker") from error
    if pending:
        return False
    try:
        validate_download_markers(markers, sector, run_id, source_sha)
    except ValueError as error:
        raise AirflowFailException(str(error)) from error
    return True


def hdfs_stage(value: dict, operation: str) -> None:
    release = value["hdfs_release"]
    args = [
        "/usr/bin/sudo", "-n", "/usr/bin/env",
        "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
        f"PYTHONPATH={release}", "/usr/bin/python3.12",
        f"{release}/hdfs/tess_hdfs_runall.py", operation,
        "--config", value["hdfs_config"], "--sector", str(value["sector"]),
        "--expected-run-id", value["run_id"], "--expected-source-sha", value["source_list_sha256"],
        "--expected-code-release", release,
    ]
    if operation == "runall":
        args.append("--skip-cleanup")
    require_success("planetory_node_1", command(args))


def trigger_next(target: str, source_task: str) -> TriggerDagRunOperator:
    result = f"ti.xcom_pull(task_ids='{source_task}')"
    return TriggerDagRunOperator(
        task_id="trigger_next_stage",
        trigger_dag_id=target,
        trigger_run_id=f"tess_s{{{{ {result}['sector'] }}}}_{{{{ {result}['lineage_sha256'][:16] }}}}",
        conf=f"{{{{ {result} }}}}",
        reset_dag_run=False,
        skip_when_already_exists=True,
    )


STAGE_ARGS = dict(
    schedule=None,
    start_date=datetime(2026, 9, 22, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(days=14),
    render_template_as_native_obj=True,
    tags=["tess", "sector-stage"],
)


@dag(dag_id="tess_sector_download", **STAGE_ARGS)
def download_dag():
    @task.sensor(task_id="check_download", poke_interval=60, timeout=14 * 24 * 60 * 60, mode="reschedule")
    def check_download() -> PokeReturnValue:
        value = inputs()
        done = download_markers(value, start_missing=True)
        return PokeReturnValue(is_done=done, xcom_value=value if done else None)

    check_download() >> trigger_next("tess_sector_raw", "check_download")


@dag(dag_id="tess_sector_raw", **STAGE_ARGS)
def raw_dag():
    @task(task_id="commit_raw", retries=12, retry_delay=timedelta(minutes=5))
    def commit_raw() -> dict:
        value = inputs()
        download_markers(value, start_missing=False)
        hdfs_stage(value, "runall")
        return value

    commit_raw() >> trigger_next("tess_sector_cleanup", "commit_raw")


@dag(dag_id="tess_sector_cleanup", **STAGE_ARGS)
def cleanup_dag():
    @task(task_id="cleanup_local", retries=12, retry_delay=timedelta(minutes=5))
    def cleanup_local() -> dict:
        value = inputs()
        hdfs_stage(value, "cleanup-sector")
        return value

    cleanup_local() >> trigger_next("tess_sector_bronze", "cleanup_local")


@dag(dag_id="tess_sector_bronze", **STAGE_ARGS)
def bronze_dag():
    @task(task_id="commit_bronze", retries=12, retry_delay=timedelta(minutes=5))
    def commit_bronze() -> None:
        value = inputs()
        release = value["bronze_release"]
        args = [
            "/usr/bin/sudo", "-n", "/usr/bin/python3.12", f"{release}/spark/tess_bronze_ctl.py",
            "run-all", "--release-dir", release, "--run-id", value["bronze_run_id"],
            "--pipeline-version", value["bronze_pipeline_version"],
            "--output-partitions", str(value["bronze_output_partitions"]),
            "--sector", str(value["sector"]), "--raw-release", value["run_id"],
            "--expected-source-sha", value["source_list_sha256"],
        ]
        require_success("planetory_node_1", command(args), terminal_exit=65)

    commit_bronze()


download_dag()
raw_dag()
cleanup_dag()
bronze_dag()

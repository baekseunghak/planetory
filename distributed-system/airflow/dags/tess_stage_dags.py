"""Sector-parameterized TESS stage DAGs; paused until discovery and runtime gates are ready."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from airflow.providers.standard.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.providers.standard.triggers.temporal import TimeDeltaTrigger
from airflow.sdk import BaseOperator, Variable, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowException, AirflowFailException

from tess_pipeline_contract import command, remaining_wait_time, stage_inputs, validate_download_markers
from tess_pipeline_remote import remote, require_success


def stop_on_contract_failure(message: str) -> None:
    Variable.set("tess_pipeline_enabled", "false")
    if Variable.get("tess_pipeline_enabled") != "false":
        raise AirflowFailException("Failed to persist TESS pipeline stop flag")
    raise AirflowFailException(message)


def inputs(context: dict | None = None) -> dict:
    try:
        return stage_inputs((context or get_current_context())["dag_run"].conf)
    except ValueError as error:
        stop_on_contract_failure(str(error))


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
            stop_on_contract_failure(f"Worker {slot} download marker is missing for Sector {sector}")
        if status:
            raise AirflowException(f"Worker {slot} download marker check failed (exit {status})")
        try:
            markers.append(json.loads(output))
        except json.JSONDecodeError as error:
            stop_on_contract_failure(f"Worker {slot} returned an invalid marker")
    if pending:
        return False
    try:
        validate_download_markers(markers, sector, run_id, source_sha)
    except ValueError as error:
        stop_on_contract_failure(str(error))
    return True


class DownloadMarkerWaitOperator(BaseOperator):
    """Poll Worker completion through Triggerer without retaining a LocalExecutor process."""

    def _check_or_defer(self, context: dict) -> dict:
        value = inputs(context)
        if download_markers(value, start_missing=True):
            return value
        remaining = remaining_wait_time(
            context["ti"].start_date,
            timedelta(days=14),
            datetime.now(timezone.utc),
        )
        if remaining <= timedelta():
            raise AirflowFailException(f"Sector {value['sector']} download did not complete within 14 days")
        self.defer(
            trigger=TimeDeltaTrigger(timedelta(minutes=5)),
            method_name="execute_complete",
            timeout=remaining,
        )

    def execute(self, context: dict) -> dict:
        return self._check_or_defer(context)

    def execute_complete(self, context: dict, event: dict | None = None) -> dict:
        return self._check_or_defer(context)


def hdfs_stage(value: dict, operation: str) -> None:
    release = value["hdfs_release"]
    if operation == "runall" and value["sector"] >= 14:
        finalize = command([
            "/usr/bin/sudo", "-n", "/usr/bin/env", f"PYTHONPATH={release}",
            "/usr/bin/python3.12", f"{release}/hdfs/tess_sector_admission.py",
            "finalize", "--sector", str(value["sector"]),
        ])
        status, output = remote("planetory_node_1", finalize)
        if status:
            raise AirflowException(f"Sector Raw configuration failed (exit {status}): {output}")
        rows = [line.removeprefix("ADMISSION_JSON=") for line in output.splitlines()
                if line.startswith("ADMISSION_JSON=")]
        if len(rows) != 1:
            raise AirflowException("Sector Raw configuration returned no unique result")
        try:
            prepared = json.loads(rows[0])
        except json.JSONDecodeError:
            stop_on_contract_failure("Sector Raw configuration returned invalid JSON")
        if any(prepared.get(key) != expected for key, expected in {
            "sector": value["sector"], "run_id": value["run_id"],
            "source_list_sha256": value["source_list_sha256"],
            "hdfs_config": value["hdfs_config"],
        }.items()):
            stop_on_contract_failure("Sector Raw configuration lineage changed")
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
        trigger_run_id=f"tess_s{{{{ {result}['sector'] }}}}_{{{{ {result}['lineage_sha256'][:16] }}}}_r{{{{ {result}['attempt'] }}}}",
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


@dag(
    dag_id="tess_sector_download",
    dag_display_name="tess_sector_download · TESS 다운로드·검증",
    description="섹터별 Worker 다운로드 완료 증거를 확인한다.",
    **STAGE_ARGS,
)
def download_dag():
    check_download = DownloadMarkerWaitOperator(task_id="check_download")
    check_download >> trigger_next("tess_sector_raw", "check_download")


@dag(
    dag_id="tess_sector_raw",
    dag_display_name="tess_sector_raw · HDFS Raw 적재·검증",
    description="다운로드가 완료된 섹터를 HDFS Raw에 적재하고 검증한다.",
    **STAGE_ARGS,
)
def raw_dag():
    @task(task_id="commit_raw", retries=12, retry_delay=timedelta(minutes=5))
    def commit_raw() -> dict:
        value = inputs()
        download_markers(value, start_missing=False)
        hdfs_stage(value, "runall")
        return value

    commit_raw() >> trigger_next("tess_sector_cleanup", "commit_raw")


@dag(
    dag_id="tess_sector_cleanup",
    dag_display_name="tess_sector_cleanup · 로컬 원본 안전 삭제",
    description="Raw 정합성 재검증 후 해당 섹터의 로컬 FITS만 삭제한다.",
    **STAGE_ARGS,
)
def cleanup_dag():
    @task(task_id="cleanup_local", retries=12, retry_delay=timedelta(minutes=5))
    def cleanup_local() -> dict:
        value = inputs()
        hdfs_stage(value, "cleanup-sector")
        return value

    cleanup_local() >> trigger_next("tess_sector_bronze", "cleanup_local")


@dag(
    dag_id="tess_sector_bronze",
    dag_display_name="tess_sector_bronze · Bronze 변환·검증",
    description="HDFS Raw를 Spark로 Bronze로 변환하고 결과를 검증한다.",
    **STAGE_ARGS,
)
def bronze_dag():
    # The tess_yarn Pool caps concurrent Spark/YARN submissions across Bronze and Silver.
    @task(task_id="commit_bronze", retries=12, retry_delay=timedelta(minutes=5), pool="tess_yarn")
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
        try:
            require_success("planetory_node_1", command(args), terminal_exit=65)
        except AirflowFailException as error:
            stop_on_contract_failure(str(error))

    commit_bronze()


download_dag()
raw_dag()
cleanup_dag()
bronze_dag()

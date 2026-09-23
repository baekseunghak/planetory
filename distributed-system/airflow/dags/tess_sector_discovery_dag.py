"""Opt-in reconciliation of unfinished TESS Sectors every five minutes."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from airflow.providers.standard.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.sdk import Variable, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowException, AirflowFailException

from tess_pipeline_contract import command, release_path, stage_inputs
from tess_pipeline_remote import remote
from tess_sector_discovery import (
    completed_through, effective_max_sector, published_lc_scripts, resume_stage, retry_attempt_from_task,
)


STAGE_DAGS = {
    "download": "tess_sector_download", "raw": "tess_sector_raw",
    "cleanup": "tess_sector_cleanup", "bronze": "tess_sector_bronze",
}


def admission(release: str, operation: str, sector: int, *options: str) -> dict:
    args = [
        "/usr/bin/sudo", "-n", "/usr/bin/env", f"PYTHONPATH={release}",
        "/usr/bin/python3.12", f"{release}/hdfs/tess_sector_admission.py",
        operation, "--sector", str(sector), *options,
    ]
    status, output = remote("planetory_node_1", command(args))
    if status:
        raise AirflowException(f"Sector {sector} admission {operation} failed (exit {status}): {output}")
    rows = [line.removeprefix("ADMISSION_JSON=") for line in output.splitlines()
            if line.startswith("ADMISSION_JSON=")]
    if len(rows) != 1:
        raise AirflowException("Sector admission returned no unique result")
    try:
        result = json.loads(rows[0])
    except json.JSONDecodeError as error:
        raise AirflowException("Sector admission returned invalid JSON") from error
    if result.get("sector") != sector:
        raise AirflowFailException("Sector admission returned a different Sector")
    return result


def settings() -> dict:
    try:
        value = Variable.get("tess_pipeline_settings", default=None, deserialize_json=True)
        if not isinstance(value, dict):
            raise ValueError("settings must be a JSON object")
        return value
    except ValueError as error:
        raise AirflowFailException("tess_pipeline_settings is missing or invalid") from error


def check_stage_dags() -> None:
    ti = get_current_context()["ti"]
    for dag_id in STAGE_DAGS.values():
        try:
            if ti.get_dag(dag_id).is_paused:
                raise AirflowException(f"Sector stage DAG is paused: {dag_id}")
        except AirflowException:
            raise
        except Exception as error:
            raise AirflowException(f"Sector stage DAG is unavailable: {dag_id}") from error


def stage_attempt(dag_id: str, prefix: str) -> int | None:
    return retry_attempt_from_task(get_current_context()["ti"], dag_id, prefix)


@dag(
    dag_id="tess_sector_discovery",
    dag_display_name="tess_sector_discovery · 새 섹터 발견·재개",
    description="게시된 TESS 섹터와 완료 증거를 확인해 다음 단계를 시작한다.",
    schedule=timedelta(minutes=5),
    start_date=datetime(2026, 9, 22, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(minutes=50),
    render_template_as_native_obj=True,
    params={"max_sector": 70},
    tags=["tess", "discovery"],
)
def discovery_dag():
    @task(retries=3, retry_delay=timedelta(minutes=5))
    def reconcile() -> list[dict]:
        # A durable stop flag prevents new admission after scheduler or host restart.
        if Variable.get("tess_pipeline_enabled", default="false").lower() != "true":
            return []
        config = settings()
        try:
            hdfs_release = release_path(str(config.get("hdfs_release", "")),
                                        "/opt/planetory-hdfs-load/releases/")
        except ValueError as error:
            raise AirflowFailException("invalid immutable HDFS release setting") from error
        try:
            max_sector = effective_max_sector(
                get_current_context()["params"]["max_sector"],
                Variable.get("tess_pipeline_max_sector", default="70"),
            )
            # Bronze final is immutable, so confirmed Sectors are not re-queried over SSH every tick.
            done = completed_through(Variable.get("tess_pipeline_completed_through", default="13"))
        except ValueError as error:
            raise AirflowFailException(str(error)) from error
        check_stage_dags()
        try:
            scripts = published_lc_scripts()
        except (OSError, ValueError) as error:
            print(f"MAST_INDEX_UNAVAILABLE: {type(error).__name__}; resuming admitted Sectors only")
            scripts = {}
        plans = []
        contiguous = done
        for sector in range(done + 1, max_sector + 1):
            current = admission(hdfs_release, "status", sector)
            if not current.get("admitted") or not current.get("installed"):
                if not current.get("admitted") and sector not in scripts:
                    break  # No new admission without the official script; never skip a gap.
                # An earlier partial intent retains its original immutable options.
                chosen = current if current.get("admitted") else config
                current = admission(hdfs_release, "prepare", sector,
                    "--script-url", current["script_url"] if current.get("admitted") else scripts[sector],
                    "--ingestion-release", str(chosen.get("ingestion_release", "")),
                    "--hdfs-release", str(chosen.get("hdfs_release", "")),
                    "--bronze-release", str(chosen.get("bronze_release", "")),
                    "--bronze-pipeline-version", str(chosen.get("bronze_pipeline_version", "")),
                    "--bronze-output-partitions", str(chosen.get("bronze_output_partitions", "")))
                stage = "download"
            else:
                try:
                    stage = resume_stage(current["evidence"])
                except (KeyError, ValueError) as error:
                    raise AirflowFailException(f"Sector {sector} evidence is inconsistent") from error
                if stage is None:
                    if contiguous == sector - 1:
                        contiguous = sector
                    continue
            try:
                value = stage_inputs({
                    "sector": sector, "run_id": current["run_id"],
                    "source_list_sha256": current["source_list_sha256"],
                    "hdfs_release": current["hdfs_release"],
                    "hdfs_config": f"/etc/planetory/tess-hdfs-runall/{current['run_id']}.json",
                    "bronze_release": current["bronze_release"],
                    "bronze_run_id": current["run_id"],
                    "bronze_pipeline_version": current["bronze_pipeline_version"],
                    "bronze_output_partitions": current["bronze_output_partitions"],
                })
            except (KeyError, ValueError) as error:
                raise AirflowFailException(f"Sector {sector} admission lineage is invalid") from error
            dag_id = STAGE_DAGS[stage]
            prefix = f"tess_s{sector}_{value['lineage_sha256'][:16]}_r"
            try:
                attempt = stage_attempt(dag_id, prefix)
            except ValueError as error:
                raise AirflowFailException(str(error)) from error
            if attempt is None:
                if stage == "download":
                    break
                continue
            value["attempt"] = attempt
            plans.append({
                "trigger_dag_id": dag_id, "trigger_run_id": prefix + str(attempt), "conf": value,
            })
            if stage == "download":
                break  # At most one unfinished download Sector; older stages may overlap.
        if contiguous != done:
            Variable.set("tess_pipeline_completed_through", str(contiguous))
        return plans

    TriggerDagRunOperator.partial(
        task_id="trigger_stage",
        reset_dag_run=False,
        skip_when_already_exists=True,
    ).expand_kwargs(reconcile())


discovery_dag()

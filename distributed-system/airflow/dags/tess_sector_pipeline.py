"""Sector-ordered TESS download -> Raw -> Bronze orchestration."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from airflow.decorators import dag, task
from airflow.exceptions import AirflowException, AirflowFailException
from airflow.models.param import Param
from airflow.operators.python import get_current_context
from airflow.providers.ssh.hooks.ssh import SSHHook
from airflow.sensors.base import PokeReturnValue

from tess_pipeline_contract import (
    RELEASE_RE,
    RUN_ID_RE,
    command,
    exact_path,
    release_path,
    sector_inputs,
    validate_download_markers,
)


OLD_RUN = "20260918T080417Z"
NEW_RUN = "20260919T005932Z"
OLD_SOURCE = "5781b664ea901bbbeecb4829e34c314e52961d111460b3e5a6ebe58918efc789"
NEW_SOURCE = "8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38"
DEFAULT_SECTOR_RUNS = {str(sector): OLD_RUN if sector in (3, 4, 5) else NEW_RUN for sector in range(1, 14)}
DEFAULT_SECTOR_SOURCES = {
    str(sector): OLD_SOURCE if sector in (3, 4, 5) else NEW_SOURCE for sector in range(1, 14)
}


def _remote(connection_id: str, remote_command: str) -> tuple[int, str]:
    client = SSHHook(ssh_conn_id=connection_id).get_conn()
    _, stdout, _ = client.exec_command(remote_command)
    stdout.channel.set_combine_stderr(True)
    output = stdout.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), output


def _require_success(connection_id: str, remote_command: str, *, terminal_exit: int | None = None) -> None:
    status, output = _remote(connection_id, remote_command)
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    if terminal_exit is not None and status == terminal_exit:
        raise AirflowFailException(f"remote data-contract failure on {connection_id} (exit {status})")
    if status:
        raise AirflowException(f"remote command failed on {connection_id} (exit {status})")


@dag(
    dag_id="tess_sector_download_raw_bronze",
    description="Validate each downloaded TESS Sector, commit Raw, clean local FITS, then commit Bronze",
    schedule=None,
    start_date=datetime(2026, 9, 21, tzinfo=timezone.utc),
    catchup=False,
    is_paused_upon_creation=True,
    max_active_runs=1,
    dagrun_timeout=timedelta(days=14),
    tags=["tess", "hdfs", "bronze"],
    params={
        "sector_runs": Param(DEFAULT_SECTOR_RUNS, type="object"),
        "sector_source_sha256": Param(DEFAULT_SECTOR_SOURCES, type="object"),
        "hdfs_release": Param(
            "/opt/planetory-hdfs-load/releases/20260921T101150Z", type="string"
        ),
        "hdfs_config": Param(
            "/etc/planetory/tess-hdfs-runall/20260919T005932Z.json", type="string"
        ),
        "bronze_release": Param(
            "/opt/planetory-bronze/releases/20260920T225128Z", type="string"
        ),
        "bronze_run_id": Param("20260920T230600Z", type="string", pattern=r"^\d{8}T\d{6}Z$"),
        "bronze_pipeline_version": Param(
            "S15P21C206-77-20260920T220814Z", type="string", pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
        ),
        "bronze_output_partitions": Param(40, type="integer", minimum=1, maximum=200),
    },
)
def tess_sector_pipeline():
    @task.sensor(poke_interval=60, timeout=14 * 24 * 60 * 60, mode="reschedule")
    def wait_download(sector: int) -> PokeReturnValue:
        params = get_current_context()["params"]
        try:
            run_id, source_sha = sector_inputs(params, sector)
        except ValueError as error:
            raise AirflowFailException(str(error)) from error
        markers = []
        for slot in range(1, 6):
            marker = (
                f"/mnt/data/staging/S15P21C206-75/run-{run_id}/manifests/"
                f"sector-{sector}-worker-{slot}.complete.json"
            )
            unit = f"planetory-tess-ingestion-{run_id}-worker-{slot}.service"
            script = (
                "set -eu\n"
                f"if test -f {command([marker])}; then cat {command([marker])}; exit 0; fi\n"
                f"sudo -n systemctl start {command([unit])}\n"
                "exit 75"
            )
            status, output = _remote(f"planetory_worker_{slot}", script)
            if status == 75:
                return PokeReturnValue(is_done=False)
            if status:
                raise AirflowException(
                    f"Worker {slot} download marker check failed for Sector {sector} (exit {status})"
                )
            try:
                markers.append(json.loads(output))
            except json.JSONDecodeError as error:
                raise AirflowFailException(
                    f"Worker {slot} returned an invalid completion marker for Sector {sector}"
                ) from error
        try:
            value = validate_download_markers(markers, sector, run_id, source_sha)
        except ValueError as error:
            raise AirflowFailException(str(error)) from error
        return PokeReturnValue(is_done=True, xcom_value=value)

    @task(retries=12, retry_delay=timedelta(minutes=5))
    def commit_raw(download: dict) -> dict:
        params = get_current_context()["params"]
        sector = int(download["sector"])
        run_id, source_sha = sector_inputs(params, sector)
        if download["run_id"] != run_id or download["source_list_sha256"] != source_sha:
            raise AirflowFailException("download lineage changed before Raw commit")
        release = release_path(str(params["hdfs_release"]), "/opt/planetory-hdfs-load/releases/")
        config = exact_path(str(params["hdfs_config"]), "/etc/planetory/tess-hdfs-runall/")
        arguments = [
            "/usr/bin/sudo", "-n", "/usr/bin/env",
            "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
            f"PYTHONPATH={release}", "/usr/bin/python3.12",
            f"{release}/hdfs/tess_hdfs_runall.py", "runall", "--config", config,
            "--sector", str(sector), "--skip-cleanup",
        ]
        _require_success("planetory_node_1", command(arguments))
        return download

    @task(retries=12, retry_delay=timedelta(minutes=5))
    def cleanup_local(raw: dict) -> dict:
        params = get_current_context()["params"]
        sector = int(raw["sector"])
        release = release_path(str(params["hdfs_release"]), "/opt/planetory-hdfs-load/releases/")
        config = exact_path(str(params["hdfs_config"]), "/etc/planetory/tess-hdfs-runall/")
        arguments = [
            "/usr/bin/sudo", "-n", "/usr/bin/env",
            "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
            f"PYTHONPATH={release}", "/usr/bin/python3.12",
            f"{release}/hdfs/tess_hdfs_runall.py", "cleanup-sector", "--config", config,
            "--sector", str(sector),
        ]
        _require_success("planetory_node_1", command(arguments))
        return raw

    @task(retries=12, retry_delay=timedelta(minutes=5))
    def finalize_raw(download: dict) -> dict:
        params = get_current_context()["params"]
        release = release_path(str(params["hdfs_release"]), "/opt/planetory-hdfs-load/releases/")
        config = exact_path(str(params["hdfs_config"]), "/etc/planetory/tess-hdfs-runall/")
        arguments = [
            "/usr/bin/sudo", "-n", "/usr/bin/env",
            "JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64", "HADOOP_CONF_DIR=/etc/hadoop",
            f"PYTHONPATH={release}", "/usr/bin/python3.12",
            f"{release}/hdfs/tess_hdfs_runall.py", "coverage", "--config", config,
        ]
        _require_success("planetory_node_1", command(arguments))
        return download

    @task(retries=12, retry_delay=timedelta(minutes=5))
    def commit_bronze(raw: dict) -> dict:
        params = get_current_context()["params"]
        release = release_path(str(params["bronze_release"]), "/opt/planetory-bronze/releases/")
        run_id = str(params["bronze_run_id"])
        version = str(params["bronze_pipeline_version"])
        if not RUN_ID_RE.fullmatch(run_id) or not RELEASE_RE.fullmatch(version):
            raise AirflowFailException("invalid Bronze run or pipeline version")
        arguments = [
            "/usr/bin/sudo", "-n", "/usr/bin/python3.12",
            f"{release}/spark/tess_bronze_ctl.py", "run-all", "--release-dir", release,
            "--run-id", run_id, "--pipeline-version", version,
            "--output-partitions", str(int(params["bronze_output_partitions"])),
            "--sector", str(int(raw["sector"])),
        ]
        _require_success("planetory_node_1", command(arguments), terminal_exit=65)
        return raw

    @task(retries=12, retry_delay=timedelta(minutes=5))
    def finalize_bronze(raw: dict) -> None:
        params = get_current_context()["params"]
        release = release_path(str(params["bronze_release"]), "/opt/planetory-bronze/releases/")
        run_id = str(params["bronze_run_id"])
        version = str(params["bronze_pipeline_version"])
        if not RUN_ID_RE.fullmatch(run_id) or not RELEASE_RE.fullmatch(version):
            raise AirflowFailException("invalid Bronze run or pipeline version")
        arguments = [
            "/usr/bin/sudo", "-n", "/usr/bin/python3.12",
            f"{release}/spark/tess_bronze_ctl.py", "coverage", "--release-dir", release,
            "--run-id", run_id, "--pipeline-version", version,
        ]
        _require_success("planetory_node_1", command(arguments), terminal_exit=65)

    previous = None
    for sector in range(1, 14):
        downloaded = wait_download.override(task_id=f"wait_download_sector_{sector:02d}")(sector)
        if previous is not None:
            previous >> downloaded
        raw = commit_raw.override(task_id=f"commit_raw_sector_{sector:02d}")(downloaded)
        cleaned = cleanup_local.override(task_id=f"cleanup_local_sector_{sector:02d}")(raw)
        if sector == 13:
            cleaned = finalize_raw.override(task_id="finalize_raw_coverage")(cleaned)
        previous = commit_bronze.override(task_id=f"commit_bronze_sector_{sector:02d}")(cleaned)
    finalize_bronze.override(task_id="finalize_bronze_coverage")(previous)


tess_sector_pipeline()

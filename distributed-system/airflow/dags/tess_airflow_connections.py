"""One-time, idempotent SSH metadata setup for the TESS Airflow scheduler."""

from __future__ import annotations

import argparse
import json
import re


HOSTS = {"planetory_node_1": ("10.20.1.10", "master-1")}
HOSTS.update({f"planetory_worker_{slot}": (f"10.20.{slot + 1}.10", f"worker-{slot + 1}")
              for slot in range(1, 6)})
EXTRA = {
    "key_file": "/home/airflow/.ssh/id_ed25519",
    "no_host_key_check": "false",
    "allow_host_key_change": "false",
    "look_for_keys": "false",
}


def configure(release: str, cap: int) -> None:
    from airflow.models import Connection, Variable
    from airflow.utils.session import create_session

    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", release):
        raise ValueError("invalid immutable release ID")
    if not 14 <= cap <= 70:
        raise ValueError("Sector cap must be in 14..70")
    settings = {
        "ingestion_release": f"/mnt/data/planetory-ingestion/releases/{release}",
        "hdfs_release": f"/opt/planetory-hdfs-load/releases/{release}",
        "bronze_release": f"/opt/planetory-bronze/releases/{release}",
        "bronze_pipeline_version": f"S15P21C206-77-{release}",
        "bronze_output_partitions": 40,
    }
    if Variable.get("tess_pipeline_enabled", default_var="false").lower() != "false":
        raise ValueError("pipeline must be stopped before configuring connections")
    current = Variable.get("tess_pipeline_settings", default_var=None, deserialize_json=True)
    if current is not None and current != settings:
        raise ValueError("existing pipeline settings have a different immutable lineage")
    with create_session() as session:
        for conn_id, (host, _) in HOSTS.items():
            existing = session.query(Connection).filter(Connection.conn_id == conn_id).one_or_none()
            if existing is None:
                session.add(Connection(conn_id=conn_id, conn_type="ssh", host=host,
                                       login="tess-airflow", port=22, extra=json.dumps(EXTRA)))
            elif (existing.conn_type != "ssh" or existing.host != host
                  or existing.login != "tess-airflow" or existing.port != 22
                  or existing.extra_dejson != EXTRA or existing._password is not None):
                raise ValueError(f"SSH Connection metadata conflicts: {conn_id}")
    if current is None:
        Variable.set("tess_pipeline_settings", settings, serialize_json=True)
    Variable.set("tess_pipeline_max_sector", str(cap))
    Variable.set("tess_pipeline_enabled", "false")
    print(f"TESS_CONNECTIONS_CONFIGURED count={len(HOSTS)} cap={cap}")


def verify() -> None:
    from airflow.providers.ssh.hooks.ssh import SSHHook

    for conn_id, (host, hostname) in HOSTS.items():
        client = SSHHook(ssh_conn_id=conn_id).get_conn()
        _, stdout, _ = client.exec_command("hostname -s; id -un; sudo -n -l")
        stdout.channel.set_combine_stderr(True)
        output = stdout.read().decode("utf-8", errors="replace")
        if stdout.channel.recv_exit_status() or not output.startswith(f"{hostname}\ntess-airflow\n"):
            raise RuntimeError(f"SSH identity check failed: {conn_id}")
        if "NOPASSWD: ALL" in output:
            raise RuntimeError(f"unrestricted sudo is forbidden for Airflow: {conn_id}")
        print(f"TESS_SSH_READY conn_id={conn_id} host={host}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True)
    parser.add_argument("--cap", type=int, default=14)
    parser.add_argument("--verify-only", action="store_true")
    arguments = parser.parse_args()
    if not arguments.verify_only:
        configure(arguments.release, arguments.cap)
    verify()

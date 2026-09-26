"""Small SSH adapter shared by the legacy and Sector-stage TESS DAGs."""

from airflow.providers.ssh.hooks.ssh import SSHHook
from airflow.sdk.exceptions import AirflowException, AirflowFailException


def remote(connection_id: str, remote_command: str, *, timeout: float | None = None) -> tuple[int, str]:
    """Run one command and close the session; `timeout` bounds each read so a stalled session
    cannot hold an Airflow worker slot. Long stage commands keep the default of no bound."""
    client = SSHHook(ssh_conn_id=connection_id).get_conn()
    try:
        _, stdout, _ = client.exec_command(remote_command, timeout=timeout)
        stdout.channel.set_combine_stderr(True)
        output = stdout.read().decode("utf-8", errors="replace")
        return stdout.channel.recv_exit_status(), output
    finally:
        client.close()


def require_success(connection_id: str, remote_command: str, *, terminal_exit: int | None = None) -> None:
    status, output = remote(connection_id, remote_command)
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    if terminal_exit is not None and status == terminal_exit:
        raise AirflowFailException(f"remote data-contract failure on {connection_id} (exit {status})")
    if status:
        raise AirflowException(f"remote command failed on {connection_id} (exit {status})")

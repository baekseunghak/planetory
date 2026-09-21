"""Small SSH adapter shared by the legacy and Sector-stage TESS DAGs."""

from airflow.exceptions import AirflowException, AirflowFailException
from airflow.providers.ssh.hooks.ssh import SSHHook


def remote(connection_id: str, remote_command: str) -> tuple[int, str]:
    client = SSHHook(ssh_conn_id=connection_id).get_conn()
    _, stdout, _ = client.exec_command(remote_command)
    stdout.channel.set_combine_stderr(True)
    output = stdout.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), output


def require_success(connection_id: str, remote_command: str, *, terminal_exit: int | None = None) -> None:
    status, output = remote(connection_id, remote_command)
    if output:
        print(output, end="" if output.endswith("\n") else "\n")
    if terminal_exit is not None and status == terminal_exit:
        raise AirflowFailException(f"remote data-contract failure on {connection_id} (exit {status})")
    if status:
        raise AirflowException(f"remote command failed on {connection_id} (exit {status})")

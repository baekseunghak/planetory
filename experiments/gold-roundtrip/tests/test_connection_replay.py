import pytest

from gold_roundtrip.connection_replay import audit, entry, write


def test_audit_rejects_tampered_output(tmp_path):
    p = tmp_path / "proof.json"
    write(p, {"value": 1})
    write(tmp_path / "manifest.json", dict(passed=True, outputs=[entry(p)]))
    assert len(audit(tmp_path)) == 2
    write(p, {"value": 2})
    with pytest.raises(ValueError, match="checksum"):
        audit(tmp_path)


def test_audit_rejects_external_path_even_with_valid_checksum(tmp_path):
    folder = tmp_path / "run"
    folder.mkdir()
    p = tmp_path / "outside.json"
    write(p, {})
    write(folder / "manifest.json", dict(passed=True, outputs=[entry(p)]))
    with pytest.raises(ValueError, match="path"):
        audit(folder)


def test_db_harness_rejects_remote_database_before_connect(tmp_path, monkeypatch):
    from gold_roundtrip.connection_db import run
    monkeypatch.setenv("DATABASE_URL", "postgresql://example.invalid/test")
    with pytest.raises(ValueError, match="local_database_required"):
        run(tmp_path, tmp_path / "report.json")

@pytest.mark.parametrize('url', [
    'postgresql://localhost/test?hostaddr=192.0.2.1',
    'postgresql://localhost/test?service=remote',
    'host=localhost hostaddr=192.0.2.1 dbname=test',
    'host=localhost service=remote dbname=test',
    'postgresql://localhost/test?host=example.invalid',
    'host=localhost,example.invalid dbname=test',
])
def test_db_routing_overrides_rejected(url):
    from gold_roundtrip.connection_db import local_connection_parameters
    with pytest.raises(ValueError, match='local_database_required'):
        local_connection_parameters(url)


@pytest.mark.parametrize('key', ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'])
def test_db_environment_routing_rejected(monkeypatch, key):
    from gold_roundtrip.connection_db import local_connection_parameters
    monkeypatch.setenv(key, 'override')
    with pytest.raises(ValueError, match='local_database_required'):
        local_connection_parameters('postgresql://localhost/test')


@pytest.mark.parametrize('host,address', [('localhost','127.0.0.1'), ('127.0.0.1','127.0.0.1'), ('[::1]','::1')])
def test_db_loopback_is_pinned(monkeypatch, host, address):
    from gold_roundtrip.connection_db import local_connection_parameters
    for key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'):
        monkeypatch.delenv(key, raising=False)
    assert local_connection_parameters(f'postgresql://{host}/test')['hostaddr'] == address


@pytest.mark.parametrize('address', ['192.0.2.1', '', None])
def test_connected_address_checked_before_ddl(address):
    from types import SimpleNamespace
    from gold_roundtrip.connection_db import require_local_connection
    with pytest.raises(ValueError, match='connected_database_not_local'):
        require_local_connection(SimpleNamespace(info=SimpleNamespace(hostaddr=address)))

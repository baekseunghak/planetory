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

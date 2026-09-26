import json

import pytest

from tess_bench import external_catalog_regression as regression
from tess_fixture.targets import TARGETS


def test_saved_source_hold_and_recursive_inputs(tmp_path, monkeypatch):
    raw = tmp_path / "source.raw"
    raw.write_text("fixture")
    source_manifest = tmp_path / "manifest.json"
    # A bare Archive "BJD" has no documented scale (external-time-evidence-v1) and stays held.
    source_manifest.write_text(json.dumps({"sources": {"nea_pscomppars": {
        "file": raw.name, "requested_url": "https://example.org/ps"}}}))
    source = dict(source_manifest=str(source_manifest), source_sha256="a"*64,
        retrieved_at="2026-09-22T00:00:00Z", duplicate_keys=[], rows=[dict(
        tic_id=str(TARGETS[0].tic_id), pl_name="fixture b", pl_orbper="2", pl_tranmid="2457001",
        pl_trandur="2", pl_tranmid_systemref="BJD", tran_flag="1")])
    monkeypatch.setattr(regression, "audit", lambda _: {"sources": {"nea_pscomppars": source}})
    output = regression.run([source_manifest], tmp_path / "results")
    result = json.loads((output / "result.json").read_text())
    manifest = json.loads((output / "manifest.json").read_text())
    assert result["validation_scope"] == "candidate_input_missing"
    snapshot = result["deliveries"]["nea_pscomppars"]["snapshot"]
    assert result["deliveries"]["nea_pscomppars"]["status"] == "ready"
    assert not snapshot["rows"] and snapshot["held_rows"][0]["reason"] == "unverified_time_standard"
    assert snapshot["time_evidence"].startswith("external-time-evidence-v1")
    assert manifest["status"] == "completed" and manifest["publishable"] is False
    assert any(i["path"].endswith("astro_kernel\\external_catalog.py") or i["path"].endswith("astro_kernel/external_catalog.py") for i in manifest["inputs"])
    for output_entry in manifest["outputs"]:
        assert regression._entry(output_entry["path"]) == output_entry


def test_audit_failure_creates_no_success(tmp_path, monkeypatch):
    def fail(_):
        raise ValueError("checksum mismatch")
    monkeypatch.setattr(regression, "audit", fail)
    with pytest.raises(ValueError):
        regression.run([], tmp_path / "results")
    assert not (tmp_path / "results").exists()

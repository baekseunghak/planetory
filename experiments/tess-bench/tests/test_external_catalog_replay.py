import pytest
from tess_bench.external_catalog_replay import convert


def test_archive_explicit_time_and_nontransiting_exclusion():
    row = dict(tic_id="TIC 123", pl_name="planet", pl_orbper="2", pl_tranmid="2457001",
               pl_tranmid_systemref="BJD-TDB", pl_trandur="2", tran_flag="1")
    result = convert("nea_pscomppars", row)
    assert result["epoch_btjd"] == 1 and result["time_system"] == "BTJD-TDB"
    assert result["raw"] == row
    assert convert("nea_pscomppars", {**row, "tran_flag": "0"})["time_system"] == "not_transiting"


@pytest.mark.parametrize("system", ["BJD", "JD", ""])
def test_archive_unknown_scale_never_becomes_tdb(system):
    row = dict(tic_id="123", pl_name="planet", pl_orbper="2", pl_tranmid="2457001",
               pl_tranmid_systemref=system, pl_trandur="2", tran_flag="1")
    result = convert("nea_pscomppars", row)
    assert result["time_system"] != "BTJD-TDB"
    assert "epoch_btjd" not in result


def test_toi_number_remains_string_and_documented_bjd_is_tdb():
    # external-time-evidence-v1: the TOI epoch is BTJD-TDB by the TOI release notes and SPOC TIMESYS.
    row = dict(tid="123", toi="100.01", pl_orbper="2", pl_tranmid="2457001", pl_trandurh="2")
    result = convert("nea_toi", row)
    assert result["external_id"] == "100.01"
    assert (result["time_system"], result["epoch_btjd"]) == ("BTJD-TDB", 1.0)
    assert "normalization_status" not in result


def test_runner_writes_plan_results_and_checksums_without_real_experiment(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    import numpy as np
    from tess_bench import external_catalog_replay as module
    from tess_fixture.external_catalog import sha256

    target = SimpleNamespace(key="sample", tic_id=123)
    raw = tmp_path / "raw"
    (raw / "sample").mkdir(parents=True)
    (raw / "sample" / "lc.fits").write_bytes(b"synthetic test input")
    manifest = tmp_path / "input.json"
    manifest.write_text('{"sources":{}}')
    monkeypatch.setattr(module, "audit", lambda _: {"sources": {"nea_toi": {"source_manifest": str(manifest), "rows": []}}})
    monkeypatch.setattr(module, "select_targets", lambda _: [target])
    monkeypatch.setattr(module, "iter_products", lambda _: [(target, 1, "lc.fits", "unused")])
    monkeypatch.setattr(module, "load_sector", lambda _: SimpleNamespace(meta={"TIMESYS": "TDB", "TIMEUNIT": "d", "BJDREFI": 2457000, "BJDREFF": 0}))
    baseline = SimpleNamespace(time=np.array([0., 1., 2.]), flux=np.ones(3), sector_of_point=np.ones(3))
    monkeypatch.setattr(module, "build_baseline", lambda _: baseline)
    monkeypatch.setattr(module, "detrend_silver", lambda *args: SimpleNamespace(status="ok", time=baseline.time, flux_det=baseline.flux, version="test"))
    monkeypatch.setattr(module, "iterate_bls", lambda *args, **kwargs: {"accepted": [], "termination": "no_quality_peak"})
    module.run([manifest], raw, tmp_path / "out")
    result_path = next((tmp_path / "out").glob("*/manifest.json"))
    result = json.loads(result_path.read_text())
    assert result["status"] == "completed" and result["approved"] is False
    assert result["records"][0]["n_candidates"] == 0
    for item in result["outputs"]:
        from pathlib import Path
        assert sha256(Path(item["path"]).read_bytes()) == item["sha256"]

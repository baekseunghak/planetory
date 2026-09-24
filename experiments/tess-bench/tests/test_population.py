import json
from types import SimpleNamespace

import numpy as np
import pytest

from tess_bench import population as pop
from tess_fixture import manifest
from tess_fixture.service_sample import load_sample_config


@pytest.mark.parametrize("snr,sde,ntr,expected", [
    (7, 6, 2, True), (6.99, 6, 2, False), (7, 5.99, 2, False),
    (7, 6, 1, False), (float("nan"), 6, 2, False), (7, float("inf"), 2, False),
])
def test_gate_boundary_and_nonfinite(snr, sde, ntr, expected):
    assert pop.passes_gate(SimpleNamespace(snr=snr, sde=sde, n_transits=ntr)) == expected


def test_summary_excludes_failures_and_separates_hosts():
    rows = [dict(group="random", status="ok", n_gate_peaks=0),
            dict(group="random", status="ok", n_gate_peaks=2),
            dict(group="random", status="failed", n_gate_peaks=""),
            dict(group="planet_host", status="ok", n_gate_peaks=0)]
    summary = pop.summarize(rows)
    assert summary["random"] == dict(selected=3, valid=2, failed=1, no_gate_peak=1,
                                     has_gate_peak=1, no_gate_peak_fraction_valid=0.5)
    assert summary["planet_host"]["selected"] == 1
    assert pop.summarize([rows[2]])["random"]["no_gate_peak_fraction_valid"] is None


def test_preflight_rejects_tampering(tmp_path, monkeypatch):
    sample = load_sample_config(pop.FIXTURE / "configs/service_sample_v1.json")
    member = sample.members[0]
    path = tmp_path / str(member.tic_id) / sample.filename(member)
    path.parent.mkdir()
    path.write_bytes(b"fixed input")
    checks = tmp_path / "checks.json"
    checks.write_text(json.dumps({"files": [{"filename": path.name,
                       "sha256": pop.file_entry(path)["sha256"], "procver": "v1"}]}))
    monkeypatch.setattr(pop, "primary_header", lambda p: dict(TICID=member.tic_id, SECTOR=member.sector, PROCVER="v1"))
    assert len(pop.preflight(sample, [member], tmp_path, checks)) == 1
    path.write_bytes(b"changed input")
    with pytest.raises(ValueError, match="checksum"):
        pop.preflight(sample, [member], tmp_path, checks)


def test_preprocessing_failure_never_counts_as_no_peak(monkeypatch):
    member = SimpleNamespace(tic_id=1, sector=3, group="random")
    baseline = SimpleNamespace(time=np.arange(600), flux=np.ones(600), sector_of_point=np.full(600, 3),
                               n_raw=600, n_valid=600)
    monkeypatch.setattr(pop, "load_sector", lambda p: None)
    monkeypatch.setattr(pop, "build_baseline", lambda *args: baseline)
    monkeypatch.setattr(pop, "preprocess", lambda *args: SimpleNamespace(
        status="ok", kept=np.ones(600, dtype=bool), failures=[{"reason": "invalid_trend"}]))
    monkeypatch.setattr(pop, "run_bls", lambda *a, **kw: pytest.fail("must not search failed preprocessing"))
    row, peaks, run = pop.measure(member, None, SimpleNamespace(quality_bitmask=None, min_points=500), None)
    assert row["status"] == "failed" and row["n_gate_peaks"] == ""
    assert peaks == [] and run is None


def test_cli_records_selection_settings_and_output_hashes(tmp_path, monkeypatch):
    # No real experiment and no Git subprocess: exercise the orchestration with fixed numerical output.
    monkeypatch.setattr(manifest, "code_info", lambda p: {"git_commit": "test", "git_dirty": True})
    monkeypatch.setattr(pop, "preflight", lambda *args: [])
    def fake_measure(member, *args):
        row = dict.fromkeys(pop.STAR_FIELDS, "")
        row.update(tic_id=member.tic_id, sector=member.sector, group=member.group,
                   status="ok", n_gate_peaks=0, wall_s=0.1)
        return row, [], SimpleNamespace(periods=np.array([1., 2.]), power=np.array([0., 1.]))
    monkeypatch.setattr(pop, "measure", fake_measure)
    pop.main(["--limit", "2", "--output-root", str(tmp_path)])
    path = next(tmp_path.glob("*/manifest.json"))
    result = json.loads(path.read_text())
    manifest.validate_manifest(result)
    cfg = result["config"]
    assert result["task"] == "S15P21C206-109"
    assert cfg["subset"] is True and cfg["preliminary"] is True
    assert len(cfg["members"]) == 2
    assert cfg["bls_setting_id"] == "poc_linear20k" and cfg["bls"]["n_periods"] == 20000
    assert cfg["preprocess_setting_id"] == "biweight_1.0d" and cfg["gate"] == pop.GATE
    for entry in result["outputs"]:
        assert pop.file_entry(pop.Path(entry["path"]))["sha256"] == entry["sha256"]


def test_failed_preflight_creates_no_run(tmp_path, monkeypatch):
    def reject(*args):
        raise ValueError("checksum mismatch")
    monkeypatch.setattr(pop, "preflight", reject)
    with pytest.raises(ValueError, match="checksum"):
        pop.main(["--limit", "1", "--output-root", str(tmp_path)])
    assert not list(tmp_path.iterdir())


def test_measure_runs_existing_numerical_pipeline_on_synthetic_curve(monkeypatch):
    from tess_fixture.lightcurve import SectorCurve
    from tess_bench.bls import BlsSetting
    from tess_bench.preprocess import Setting
    t = np.linspace(1400, 1427, 4000)
    f = 1 + np.random.default_rng(109).normal(0, 0.0003, len(t))
    f[np.abs((t - 1401 + 1) % 2 - 1) < 0.06] -= 0.01
    curve = SectorCurve(1, 3, "synthetic", t, f, np.full(len(t), 0.0003),
                        np.zeros(len(t), dtype=int), np.arange(len(t)), {})
    monkeypatch.setattr(pop, "load_sector", lambda p: curve)
    row, peaks, run = pop.measure(SimpleNamespace(tic_id=1, sector=3, group="random"), None,
                                  Setting("test", detrend_method="none"),
                                  BlsSetting("test", n_periods=1000))
    assert row["status"] == "ok", row["reason"]
    assert row["n_gate_peaks"] > 0 and len(peaks) == 5
    assert len(run.periods) == 1000 and len(run.power) == 1000

import json
from pathlib import Path

import numpy as np
import pytest

from tess_fixture import inject as inj
from tess_fixture.lightcurve import Baseline

from tess_bench import cli, metrics as mt, preprocess as pp

FIXTURE = Path(__file__).resolve().parents[2] / "tess-fixture"
GRID = FIXTURE / "configs" / "injection_grid_v1.json"


def _baseline(seed=2):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1427.0, 2 / 1440)
    t = t[(t < 1412.0) | (t > 1413.5)]
    f = 1.0 + rng.normal(0, 3e-4, size=t.shape)
    return Baseline(tic_id=1, sectors=(3,), time=t, flux=f, sector_of_point=np.full(t.shape, 3),
                    normalization_median={3: 1.0}, n_raw=len(t), n_valid=len(t), source_files=("fake",))


def test_depth_ratio_near_one_without_detrending_and_kept_ratio_one():
    grid = inj.load_grid(GRID)
    base = _baseline()
    rows = inj.build_catalog(grid, base, "fake-real", inj.grid_set_id(grid), include_multi=False)
    row = next(r for r in rows if r.depth_ppm == 3000 and r.duration_hours == 2.0 and r.phase_label == "middle")
    flux = inj.inject_group(base, [row])
    res = pp.preprocess(base.time, flux, base.sector_of_point, pp.Setting("none", detrend_method="none"))
    m = mt.signal_metrics(res, [row], row)
    assert abs(m.depth_ratio - 1.0) < 0.05
    assert m.in_transit_kept == 1.0
    assert 200 < m.oot_scatter_ppm < 400
    assert m.n_in_transit > 0 and m.status == "ok"


def test_overlapping_pair_metrics_exclude_shared_points():
    grid = inj.load_grid(GRID)
    base = _baseline()
    rows = inj.build_catalog(grid, base, "fake-real", inj.grid_set_id(grid))
    pair = [r for r in rows if r.phase_label == "overlapping_transits"]
    flux = inj.inject_group(base, pair)
    res = pp.preprocess(base.time, flux, base.sector_of_point, pp.Setting("none", detrend_method="none"))
    for r in pair:
        m = mt.signal_metrics(res, pair, r)
        assert abs(m.depth_ratio - 1.0) < 0.05, (r.injection_id, m.depth_ratio)


def test_summarize_groups_by_duration():
    rows = [{"depth_ratio": d, "duration_hours": h, "in_transit_kept": 1.0, "oot_scatter_ppm": 300.0,
             "boundary_ratio": 1.0, "n_failed_segments": 0}
            for d, h in ((0.9, 0.5), (0.8, 2.0), (0.4, 8.0), (0.5, 8.0))]
    s = mt.summarize(rows)
    assert s["n_signals"] == 4 and s["failed_segments_per_curve"] == 0
    assert s["depth_ratio_0.5h"] == 0.9 and s["depth_ratio_2h"] == 0.8 and s["depth_ratio_8h"] == pytest.approx(0.45)


SAMPLE_READY = all((FIXTURE / "sample_raw" / "toi270" / f).is_file() for f in (
    "tess2018263035959-s0003-0000000259377017-0123-s_lc.fits",
    "tess2018292075959-s0004-0000000259377017-0124-s_lc.fits",
    "tess2018319095959-s0005-0000000259377017-0125-s_lc.fits"))


@pytest.mark.skipif(not SAMPLE_READY, reason="TOI-270 FITS 표본 없음 (tess-fixture download 먼저)")
def test_cli_smoke_run_writes_metrics_summary_manifest(tmp_path):
    results = tmp_path / "results"
    cli.main(["preprocess", "--target", "toi270", "--results", str(results), "--only", "poc_baseline", "savgol_0.5d",
              "--limit", "4", "--no-noise", "--single-only"])
    run = next((results / "bench").rglob("run-*"))
    assert (run / "metrics.csv").is_file() and (run / "summary.csv").is_file()
    summary = (run / "summary.csv").read_text(encoding="utf-8").strip().splitlines()
    assert len(summary) == 1 + 2                                   # header + 2 settings × 1 baseline
    manifest = next((results / "manifests").glob("preprocess-toi270-*.json"))
    data = json.loads(manifest.read_text(encoding="utf-8"))
    assert data["config"]["parameters"]["settings"] == ["poc_baseline", "savgol_0.5d"]
    assert all(Path(o["path"]).is_file() for o in data["outputs"])

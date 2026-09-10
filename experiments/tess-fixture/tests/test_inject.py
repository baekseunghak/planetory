import json
from pathlib import Path

import numpy as np
import pytest

from tess_fixture import inject as inj
from tess_fixture.lightcurve import Baseline, synthetic_noise_baseline

GRID_PATH = Path(__file__).resolve().parents[1] / "configs" / "injection_grid_v1.json"


def _fake_baseline(n_days=27.0, cadence_min=2.0, gap=(12.0, 13.0), seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, cadence_min / 1440.0)
    t = t[(t < 1400.0 + gap[0]) | (t > 1400.0 + gap[1])]
    f = 1.0 + rng.normal(0, 5e-4, size=t.shape)
    return Baseline(tic_id=1, sectors=(3,), time=t, flux=f, sector_of_point=np.full(t.shape, 3),
                    normalization_median={3: 1000.0}, n_raw=len(t) + 10, n_valid=len(t), source_files=("fake.fits",))


def test_grid_v1_has_108_single_signal_points():
    grid = inj.load_grid(GRID_PATH)
    singles = inj.single_signal_grid(grid)
    assert len(singles) == 3 * 3 * 4 * 3 == 108
    # 순서: period → duration → depth → phase
    assert singles[0][1].period_days == 1.0 and singles[0][0] == "start"
    assert singles[-1][1].period_days == 20.0 and singles[-1][0] == "end"


def test_box_model_depth_and_duration():
    t = np.linspace(0, 10, 10_001)
    signal = inj.Signal(period_days=2.0, duration_hours=2.4, depth_ppm=1000, phase_fraction=0.0)
    model = inj.box_model(t, signal, t0=1.0)
    assert model.min() == pytest.approx(1 - 1e-3)
    in_transit = (model < 1).sum() * (t[1] - t[0])
    # 10일 안에 t0=1,3,5,7,9 → 5회 × 0.1일
    assert in_transit == pytest.approx(5 * 0.1, rel=0.02)


def test_catalog_ids_unique_and_transit_counts_positive():
    grid = inj.load_grid(GRID_PATH)
    base = _fake_baseline()
    rows = inj.build_catalog(grid, base, baseline_id="fake-real", set_id="g1")
    ids = [r.injection_id for r in rows]
    assert len(ids) == len(set(ids))
    singles = [r for r in rows if r.signal_index == 0 and r.group_id == r.injection_id]
    assert len(singles) == 108
    multi_groups = {r.group_id for r in rows if r.group_id != r.injection_id}
    assert len(multi_groups) == len(grid["multi_signal_pairs"])
    assert all(r.n_points_in_transit > 0 for r in rows)
    # 20일 주기, 27일 창이면 통과 1~2회
    assert {r.n_transits_in_window for r in singles if r.period_days == 20.0} <= {1, 2}


def test_injection_is_deterministic_and_only_dims_in_transit():
    grid = inj.load_grid(GRID_PATH)
    base = _fake_baseline()
    rows = inj.build_catalog(grid, base, baseline_id="fake-real", set_id="g1", include_multi=False)
    row = rows[5]
    f1 = inj.inject_group(base, [row])
    f2 = inj.inject_group(base, [row])
    np.testing.assert_array_equal(f1, f2)
    ratio = f1 / base.flux
    assert ratio.max() == pytest.approx(1.0)
    assert ratio.min() == pytest.approx(1 - row.depth_ppm * 1e-6)


def test_noise_baseline_keeps_time_structure_and_is_seeded():
    base = _fake_baseline()
    n1 = synthetic_noise_baseline(base, seed=7)
    n2 = synthetic_noise_baseline(base, seed=7)
    n3 = synthetic_noise_baseline(base, seed=8)
    np.testing.assert_array_equal(n1.time, base.time)
    np.testing.assert_array_equal(n1.flux, n2.flux)
    assert not np.array_equal(n1.flux, n3.flux)
    assert abs(n1.robust_scatter - base.robust_scatter) / base.robust_scatter < 0.1


def test_write_catalog_and_curves(tmp_path):
    grid = json.loads(GRID_PATH.read_text(encoding="utf-8"))
    base = _fake_baseline()
    rows = inj.build_catalog(grid, base, baseline_id="fake-real", set_id="g1", include_multi=True)
    inj.write_catalog(rows, tmp_path / "catalog.csv")
    written = inj.write_injected_curves(base, rows[:3] + rows[-2:], tmp_path / "curves")
    assert (tmp_path / "catalog.csv").read_text(encoding="utf-8").count("\n") == len(rows) + 1
    assert (tmp_path / "curves" / "baseline.npz").is_file()
    assert len(written) == 1 + 3 + 1   # baseline + 3 singles + 1 multi group(2 rows)

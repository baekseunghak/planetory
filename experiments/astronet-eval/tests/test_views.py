import numpy as np
import pytest

from astronet_eval import views as vw


def _curve(period=3.0, t0=1401.0, dur_days=2.0 / 24, depth=0.01, n_days=27.0, cadence_min=2.0, noise=0.0, seed=0):
    t = np.arange(1400.0, 1400.0 + n_days, cadence_min / 1440.0)
    rng = np.random.default_rng(seed)
    f = 1.0 + rng.normal(0, noise, size=t.shape)
    phase = ((t - t0) / period + 0.5) % 1.0 - 0.5
    f[np.abs(phase * period) < dur_days / 2] -= depth
    return t, f


def test_phase_fold_range_and_order():
    t, f = _curve()
    ft, ff = vw.phase_fold(t, f, 3.0, 1401.0)
    assert ft.min() >= -1.5 and ft.max() < 1.5
    assert np.all(np.diff(ft) >= 0) and ff.shape == f.shape


def test_median_view_normalizes_dip_to_minus_one_and_baseline_to_zero():
    t, f = _curve()
    ft, ff = vw.phase_fold(t, f, 3.0, 1401.0)
    g = vw.median_view(ft, ff, num_bins=201, bin_width=3.0 * 1.2 / 201, t_min=-1.5, t_max=1.5)
    assert g.shape == (201,) and g.dtype == np.float32
    assert g.min() == pytest.approx(-1.0) and abs(float(np.median(g))) < 1e-6
    assert int(np.argmin(g)) in range(98, 103)                     # 통과 중심이 가운데 bin
    assert (g[:80] == 0).all() and (g[-80:] == 0).all()             # 통과 밖은 0


def test_median_view_failures():
    t = np.array([0.0, 0.1]); f = np.array([1.0, 1.0])
    with pytest.raises(vw.ViewFailure) as info:
        vw.median_view(t, f, num_bins=5, bin_width=0.01, t_min=10.0, t_max=11.0)     # 점이 범위 밖
    assert info.value.reason == "empty_view"
    with pytest.raises(vw.ViewFailure) as info:
        vw.median_view(np.linspace(0, 1, 50), np.ones(50), num_bins=5, bin_width=0.3, t_min=0, t_max=1)   # 평평 → 최솟값 0
    assert info.value.reason == "flat_view"


def test_make_views_success_and_counts():
    t, f = _curve(noise=2e-4)
    v = vw.make_views(t, f, period_days=3.0, epoch_btjd=1401.0, duration_days=2.0 / 24)
    assert v.global_view.shape == (201,) and v.local_view.shape == (61,)
    assert v.n_points == len(t) and v.n_in_transit > 0
    assert v.n_empty_global_bins == 0 and v.n_empty_local_bins == 0
    assert np.isfinite(v.global_view).all() and v.local_view.min() == pytest.approx(-1.0, abs=1e-6)


def test_make_views_counts_empty_bins_from_gap():
    t, f = _curve()
    keep = (t < 1405.0) | (t > 1420.0)                    # 큰 공백 → 접어도 비는 bin 이 생길 수 있음
    v = vw.make_views(t[keep], f[keep], period_days=13.0, epoch_btjd=1401.0, duration_days=3.0 / 24)
    assert v.n_empty_global_bins > 0                        # 보간 전 빈 bin 이 기록된다
    assert np.isfinite(v.global_view).all()                 # 보간 후에는 유한


@pytest.mark.parametrize("kwargs, reason", [
    (dict(period_days=3.0, epoch_btjd=1401.0, duration_days=0.5 / 24, spec=vw.ViewSpec(min_in_transit_points=10_000)), "too_few_transit_points"),
    (dict(period_days=0.0, epoch_btjd=1401.0, duration_days=0.1), "invalid_geometry"),
    (dict(period_days=1.0, epoch_btjd=1401.0, duration_days=2.0), "invalid_geometry"),
])
def test_make_views_failure_reasons(kwargs, reason):
    t, f = _curve(noise=2e-4)
    with pytest.raises(vw.ViewFailure) as info:
        vw.make_views(t, f, **kwargs)
    assert info.value.reason == reason


def test_too_few_transit_points_with_sparse_cadence():
    """2시간 간격 관측에 0.5h 통과, 통과 중심이 격자에서 1.2시간 비켜 있어 통과 안에 점이 없다."""
    t = np.arange(1400.0, 1427.0, 2.0 / 24)
    rng = np.random.default_rng(3)
    f = 1 + rng.normal(0, 1e-4, size=t.shape)
    with pytest.raises(vw.ViewFailure) as info:
        vw.make_views(t, f, period_days=3.0, epoch_btjd=1401.05, duration_days=0.5 / 24)
    assert info.value.reason == "too_few_transit_points"


def test_make_views_drops_nan_points_and_fails_when_none_left():
    t, f = _curve()
    f2 = f.copy(); f2[:100] = np.nan
    v = vw.make_views(t, f2, period_days=3.0, epoch_btjd=1401.0, duration_days=2.0 / 24)
    assert v.n_points == len(t) - 100
    with pytest.raises(vw.ViewFailure) as info:
        vw.make_views(t, np.full_like(f, np.nan), period_days=3.0, epoch_btjd=1401.0, duration_days=2.0 / 24)
    assert info.value.reason == "no_valid_points"

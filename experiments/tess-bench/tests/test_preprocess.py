from pathlib import Path

import numpy as np
import pytest

from tess_bench import preprocess as pp

SETTINGS = Path(__file__).resolve().parents[1] / "configs" / "preprocess_settings_v1.json"


def _curve(n_days=27.0, cadence_min=2.0, gaps=((12.0, 13.5),), sectors=None, noise=5e-4, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, cadence_min / 1440.0)
    for a, b in gaps:
        t = t[(t < 1400.0 + a) | (t > 1400.0 + b)]
    f = 1.0 + rng.normal(0, noise, size=t.shape)
    sector = np.where(t < 1400.0 + n_days / 2, 3, 4) if sectors is None else np.full(t.shape, sectors)
    return t, f, sector


def _box(t, period, t0, dur_h, depth):
    phase = ((t - t0) / period + 0.5) % 1.0 - 0.5
    m = np.ones_like(t)
    m[np.abs(phase * period) < 0.5 * dur_h / 24] = 1 - depth
    return m


def test_settings_v1_load_and_ids_unique():
    cfg, settings = pp.load_settings(SETTINGS)
    ids = [s.setting_id for s in settings]
    assert len(ids) == len(set(ids)) == 11
    base = next(s for s in settings if s.setting_id == "poc_baseline")
    assert (base.quality_bitmask, base.gap_days, base.split_sectors, base.detrend_method, base.window_days,
            base.sigma_upper, base.min_points) == (None, 0.5, False, "savgol", 2.0, 5.0, 500)
    only = pp.load_settings(SETTINGS, ["biweight_1.0d"])[1]
    assert len(only) == 1 and only[0].detrend_method == "biweight" and only[0].window_days == 1.0
    with pytest.raises(KeyError):
        pp.load_settings(SETTINGS, ["nope"])


def test_segments_split_on_gap_and_optionally_sector():
    t, f, sector = _curve()                      # 공백 1개(12~13.5일), Sector 경계는 13.5일 근처가 아니라 27/2=13.5 → 공백 안
    segs = pp.segment_indices(t, sector, gap_days=0.5, split_sectors=False)
    assert len(segs) == 2
    t2, f2, s2 = _curve(gaps=())                 # 공백 없음, Sector 만 바뀜
    assert len(pp.segment_indices(t2, s2, 0.5, split_sectors=False)) == 1
    assert len(pp.segment_indices(t2, s2, 0.5, split_sectors=True)) == 2


def test_savgol_window_points_matches_poc_rule():
    cadence = 2 / 1440
    assert pp.savgol_window_points(2.0, cadence) == 1441          # 1440 | 1
    assert pp.savgol_window_points(0.001, cadence) == 11          # 최소 11


def test_long_window_preserves_transit_short_window_erodes_it():
    t, f, sector = _curve(noise=2e-4)
    depth = 3e-3
    f_inj = f * _box(t, period=5.0, t0=1402.0, dur_h=8.0, depth=depth)
    in_tr = _box(t, 5.0, 1402.0, 8.0, depth) < 1
    def measured(setting):
        r = pp.preprocess(t, f_inj, sector, setting)
        return np.nanmedian(r.flux_det[~in_tr]) - np.nanmedian(r.flux_det[in_tr])

    d_none = measured(pp.Setting("none", detrend_method="none"))
    d_long = measured(pp.Setting("long", window_days=3.0))
    d_short = measured(pp.Setting("short", window_days=0.4))
    d_bw = measured(pp.Setting("bw", detrend_method="biweight", window_days=1.0))
    assert abs(d_none / depth - 1.0) < 0.05                     # 다듬기 없으면 그대로
    # SG 는 통과를 마스킹하지 않고 다항식을 맞추므로 창이 길어도 깊이를 일부 깎는다. 창이 짧을수록 더 깎는다.
    # 이 손실 크기를 재는 것이 벤치마크의 목적이라 여기서는 순서와 대략의 범위만 고정한다.
    assert 0.6 < d_long / depth < 1.0
    assert d_short < d_long
    assert d_short / depth < 0.75
    # biweight 는 튀는 점(통과)에 덜 끌려 같은 급 창에서 SG 보다 깊이를 더 보존한다
    assert d_bw > measured(pp.Setting("sg1", window_days=1.0))


def test_biweight_location_ignores_outliers_and_trend_follows_slow_variation():
    x = np.concatenate([np.full(200, 1.0), np.full(20, 0.9)])       # 10% 가 통과처럼 낮음
    assert abs(pp.biweight_location(x) - 1.0) < 1e-6
    assert abs(np.mean(x) - 1.0) > 5e-3                             # 평균은 끌려감
    t = np.linspace(0, 10, 3000)
    slow = 1 + 0.01 * np.sin(2 * np.pi * t / 10)
    f = slow * _box(t, period=3.0, t0=1.0, dur_h=3.0, depth=5e-3)
    trend = pp.biweight_trend(t, f, window_days=1.0, stride=10)
    assert np.max(np.abs(trend - slow)) < 2e-3                      # 통과에 끌리지 않고 느린 변화만 따라감


def test_short_segment_falls_back_to_median_and_records_reason():
    t, f, sector = _curve(gaps=((5.0, 5.6), (5.7, 25.0)))          # 5.6~5.7일 사이에 짧은 조각 하나
    s = pp.Setting("x", window_days=2.0)
    r = pp.preprocess(t, f, sector, s)
    reasons = {(fl["segment_id"], fl["reason"]) for fl in r.failures}
    assert any(reason == "short_segment_median_fallback" for _, reason in reasons)
    assert r.status == "ok" and np.isfinite(r.flux_det).sum() > 0.9 * len(t)


def test_too_few_points_and_invalid_trend_are_reported_not_raised():
    t, f, sector = _curve(n_days=0.5)
    r = pp.preprocess(t, f, sector, pp.Setting("x"))
    assert r.status == "too_few_points" and r.failures[0]["reason"] == "too_few_points"
    t, f, sector = _curve()
    f_bad = f.copy()
    f_bad[:3000] = 0.0                                              # 추세가 0 → invalid_trend
    r = pp.preprocess(t, f_bad, sector, pp.Setting("x", window_days=0.5))
    assert any(fl["reason"] == "invalid_trend" for fl in r.failures)
    assert np.isnan(r.flux_det[:100]).all()


def test_upper_clipping_only_removes_bright_outliers():
    t, f, sector = _curve(noise=2e-4)
    f2 = f.copy()
    f2[100] = 1.05          # 위로 튐
    f2[200] = 0.95          # 아래로 튐 (통과일 수 있음)
    r = pp.preprocess(t, f2, sector, pp.Setting("x", detrend_method="none"))
    assert not r.kept[100]
    assert r.kept[200]

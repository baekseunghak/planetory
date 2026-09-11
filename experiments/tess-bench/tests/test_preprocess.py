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
    assert cfg["version"] == "1.1.0"
    assert len(ids) == len(set(ids)) == 18
    base = next(s for s in settings if s.setting_id == "poc_baseline")
    assert (base.quality_bitmask, base.gap_days, base.split_sectors, base.detrend_method, base.window_days,
            base.sigma_upper, base.min_points, base.edge_mask_hours, base.two_stage) == (None, 0.5, False, "savgol", 2.0, 5.0, 500, 0.0, False)
    only = pp.load_settings(SETTINGS, ["biweight_1.0d"])[1]
    assert len(only) == 1 and only[0].detrend_method == "biweight" and only[0].window_days == 1.0
    edge = pp.load_settings(SETTINGS, ["edge12h_biweight_1.0d"])[1][0]
    assert edge.edge_mask_hours == 12.0 and edge.detrend_method == "biweight" and edge.factor == "edge"
    two = pp.load_settings(SETTINGS, ["two_stage_bw3.0d_bw0.5d"])[1][0]
    assert two.two_stage and two.stage1_method == "biweight" and two.stage1_window_days == 3.0 and two.window_days == 0.5
    assert {s.factor for s in settings} == {"baseline", "quality", "segment", "window", "method", "edge", "two_stage"}
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


def test_edge_mask_excludes_segment_edges_from_result_and_trend():
    t, f, sector = _curve(noise=2e-4)                       # 구간 2개 (공백 12~13.5일)
    r0 = pp.preprocess(t, f, sector, pp.Setting("none", detrend_method="none"))
    r6 = pp.preprocess(t, f, sector, pp.Setting("edge6", detrend_method="none", edge_mask_hours=6.0))
    assert r0.n_edge_masked == 0
    # 구간 2개 × 양끝 6시간 = 24시간 분량 ≈ 720점 (2분 cadence)
    assert 700 <= r6.n_edge_masked <= 740
    assert not r6.kept[r6.edge_masked].any()
    assert np.isnan(r6.flux_det[r6.edge_masked]).all()
    assert np.isnan(r6.trend[r6.edge_masked]).all()
    # 구간 안쪽 점은 그대로 남는다
    inner = ~r6.edge_masked
    assert r6.kept[inner].sum() >= 0.99 * inner.sum()
    # 첫 구간의 첫 점·마지막 점은 제외, 6시간 안쪽 점은 유지
    seg0 = np.where(r6.segment_id == 0)[0]
    assert r6.edge_masked[seg0[0]] and r6.edge_masked[seg0[-1]]
    mid = seg0[len(seg0) // 2]
    assert not r6.edge_masked[mid]


def test_edge_mask_reduces_in_transit_points_when_transit_sits_at_edge():
    t, f, sector = _curve(noise=2e-4)
    depth = 3e-3
    t0 = t[0] + 2.0 / 24                                   # 첫 통과 중심이 구간 시작 2시간 뒤
    f_inj = f * _box(t, period=50.0, t0=t0, dur_h=3.0, depth=depth)
    in_tr = _box(t, 50.0, t0, 3.0, depth) < 1
    r = pp.preprocess(t, f_inj, sector, pp.Setting("edge6", detrend_method="none", edge_mask_hours=6.0))
    assert in_tr.sum() > 0
    assert (r.kept & in_tr).sum() == 0                     # 가장자리 통과는 전부 잘림


def test_two_stage_reduces_residual_on_active_star_while_preserving_depth():
    """느린 큰 변동(주기 5일, 2%) + 8h 통과. 단일 짧은 창은 깊이를 깎고, 단일 긴 창은 잔여 변동을 남긴다."""
    rng = np.random.default_rng(5)
    t = np.arange(1400.0, 1427.0, 2 / 1440)
    slow = 1 + 0.02 * np.sin(2 * np.pi * t / 5.0)
    depth = 3e-3
    model = _box(t, period=9.0, t0=1403.0, dur_h=8.0, depth=depth)
    f = slow * model * (1 + rng.normal(0, 3e-4, size=t.shape))
    sector = np.full(t.shape, 3)
    in_tr = model < 1

    def run(setting):
        r = pp.preprocess(t, f, sector, setting)
        oot = r.flux_det[~in_tr]
        d = np.nanmedian(oot) - np.nanmedian(r.flux_det[in_tr])
        scatter = 1.4826 * np.nanmedian(np.abs(oot - np.nanmedian(oot)))
        return d / depth, scatter

    d_long, s_long = run(pp.Setting("bw3", detrend_method="biweight", window_days=3.0))
    d_short, s_short = run(pp.Setting("bw05", detrend_method="biweight", window_days=0.5))
    d_two, s_two = run(pp.Setting("two", detrend_method="biweight", window_days=0.5,
                                  stage1_method="biweight", stage1_window_days=3.0))
    # 긴 창: 5일 변동이 남아 잡음(잔여)이 크다. 2단계는 그 잔여를 줄인다
    assert s_two < s_long
    # 짧은 창은 8h 깊이를 크게 깎는다. 2단계는 짧은 창 단독보다 깊이를 더 보존한다
    assert d_short < 0.7
    assert d_two > d_short
    # 2단계 결과의 추세는 두 단계의 곱이라 유한하다
    r = pp.preprocess(t, f, sector, pp.Setting("two", detrend_method="biweight", window_days=0.5,
                                                 stage1_method="biweight", stage1_window_days=3.0))
    assert np.isfinite(r.trend).mean() > 0.99


def test_two_stage_setting_validation():
    import json
    bad = {"settings_id": "x", "version": "0", "defaults": {},
           "settings": [{"setting_id": "a", "stage1_method": "none", "stage1_window_days": 3.0}]}
    p = Path(__file__).resolve().parent / "_bad_settings.json"
    p.write_text(json.dumps(bad), encoding="utf-8")
    try:
        with pytest.raises(ValueError):
            pp.load_settings(p)
    finally:
        p.unlink()


def test_upper_clipping_only_removes_bright_outliers():
    t, f, sector = _curve(noise=2e-4)
    f2 = f.copy()
    f2[100] = 1.05          # 위로 튐
    f2[200] = 0.95          # 아래로 튐 (통과일 수 있음)
    r = pp.preprocess(t, f2, sector, pp.Setting("x", detrend_method="none"))
    assert not r.kept[100]
    assert r.kept[200]

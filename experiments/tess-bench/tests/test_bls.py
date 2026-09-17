from pathlib import Path

import numpy as np
import pytest

from tess_bench import bls, bls_match
from tess_fixture import inject as inj

SETTINGS = Path(__file__).resolve().parents[1] / "configs" / "bls_settings_v1.json"


def _curve(period=3.0, t0=1402.0, dur_h=2.0, depth=3e-3, n_days=27.0, noise=3e-4, seed=1, extra=None):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, 2.0 / 1440)
    f = 1 + rng.normal(0, noise, size=t.shape)
    for P, e, dh, d in [(period, t0, dur_h, depth)] + (extra or []):
        if P:
            phase = ((t - e) / P + 0.5) % 1.0 - 0.5
            f[np.abs(phase * P) < dh / 48] *= 1 - d
    return t, f


def _row(period=3.0, t0=1402.0, dur_h=2.0, depth_ppm=3000.0, n_tr=8, iid="i0"):
    return inj.InjectionRow(iid, "set", "b", 0, iid, period, dur_h, depth_ppm, 0.5, "middle", t0, "box", n_tr, 200)


# ------------------------------------------------------------------ 설정

def test_settings_v1_load_defaults_and_factors():
    cfg, settings = bls.load_bls_settings(SETTINGS)
    assert cfg["version"] == "1.0.0" and len(settings) == 9
    base = next(s for s in settings if s.setting_id == "poc_linear20k")
    assert (base.grid, base.n_periods, base.period_min_days, base.period_max_rule, base.objective) == ("linear", 20000, 0.5, "baseline/3", "likelihood")
    assert base.durations_hours == (1.2, 1.92, 2.88, 4.8) and base.period_max(78.0) == pytest.approx(26.0)
    assert {s.factor for s in settings} == {"baseline", "grid_density", "grid_type", "period_range", "duration_grid", "objective"}
    only = bls.load_bls_settings(SETTINGS, ["autoperiod_ff3"])[1]
    assert only[0].grid == "autoperiod" and only[0].frequency_factor == 3.0
    with pytest.raises(KeyError):
        bls.load_bls_settings(SETTINGS, ["nope"])
    assert bls.BlsSetting("x", period_max_rule="fixed:12").period_max(100.0) == 12.0
    with pytest.raises(ValueError):
        bls.BlsSetting("x", period_max_rule="weird").period_max(10.0)


def test_period_grid_linear_and_autoperiod():
    t, _ = _curve(n_days=27.0)
    lin = bls.period_grid(bls.BlsSetting("l", n_periods=100), t)
    assert lin.size == 100 and lin[0] == 0.5 and lin[-1] == pytest.approx((t.max() - t.min()) / 3)
    from astropy.timeseries import BoxLeastSquares
    auto = bls.period_grid(bls.BlsSetting("a", grid="autoperiod"), t, BoxLeastSquares(t, np.ones_like(t)))
    assert auto.min() >= 0.5 and auto.size > 1000
    with pytest.raises(ValueError):
        bls.period_grid(bls.BlsSetting("e", period_max_rule="fixed:0.4"), t)


# ------------------------------------------------------------------ 실행·피크

def test_run_bls_recovers_injected_period_and_reports_stats():
    t, f = _curve()
    run = bls.run_bls(t, f, bls.BlsSetting("s", n_periods=4000), baseline_time=t)
    assert run.n_periods == 4000 and run.elapsed_s > 0 and len(run.peaks) == 5
    top = run.peaks[0]
    assert top.rank == 1 and top.period_days == pytest.approx(3.0, rel=0.01)
    assert top.n_transits >= 8 and top.n_in_transit > 100 and top.mask_dropped_fraction == pytest.approx(0.0)
    assert top.sde > 6 and top.snr > 5 and top.poc_snr > 5 and np.isfinite(top.depth_err)
    # 상위 피크는 서로 다른 주기 (2% 이상 떨어짐)
    ps = [p.period_days for p in run.peaks]
    assert all(abs(ps[i] / ps[j] - 1) >= 0.02 for i in range(5) for j in range(i))


def test_select_top_peaks_merges_neighbours():
    periods = np.array([1.0, 1.01, 1.005, 2.0, 2.05, 3.0])
    power = np.array([10, 9, 8, 7, 6, 5.0])
    assert bls.select_top_peaks(periods, power, 3, 0.02) == [0, 3, 4]      # 1.0 이웃 둘 제외, 2.0/2.05 는 2.5% 차이라 별개
    power[5] = np.nan
    assert 5 not in bls.select_top_peaks(periods, power, 6, 0.02)


def test_run_bls_rejects_too_few_points_and_no_valid_duration():
    t, f = _curve(n_days=0.1)
    with pytest.raises(ValueError):
        bls.run_bls(t, f, bls.BlsSetting("s"))
    t, f = _curve()
    with pytest.raises(ValueError, match="duration"):
        bls.run_bls(t, f, bls.BlsSetting("s", period_min_days=0.01, durations_hours=(1.0,)))


def test_mask_dropped_fraction_counts_points_removed_by_preprocessing():
    t, f = _curve()
    keep = np.ones(t.shape, bool)
    phase = ((t - 1402.0) / 3.0 + 0.5) % 1.0 - 0.5
    in_tr = np.abs(phase * 3.0) < 1.0 / 24
    drop_idx = np.flatnonzero(in_tr)[:50]
    keep[drop_idx] = False                                 # 통과 점 50개를 전처리가 지웠다고 가정
    run = bls.run_bls(t[keep], f[keep], bls.BlsSetting("s", n_periods=3000), baseline_time=t)
    assert 0.0 < run.peaks[0].mask_dropped_fraction < 0.3


# ------------------------------------------------------------------ 매칭

def test_match_direct_alias_wrong_missed():
    t, f = _curve()
    run = bls.run_bls(t, f, bls.BlsSetting("s", n_periods=4000))
    row = _row(n_tr=run.peaks[0].n_transits)
    m = bls_match.match_injection(t, row, run.peaks)
    assert m.match == "direct" and m.matched_rank == 1 and abs(m.period_rel_err) < 0.01
    assert m.window_overlap > 0.5 and m.cumulative_err_over_half_dur <= 1.0 and 0.5 < m.duration_ratio < 2.0
    assert 0.5 < m.depth_ratio < 1.5 and m.epoch_cyclic_err_hours < 1.0
    # 상위 5 피크에는 P/2·2P 봉우리도 들어 있어 어떤 정답이든 직접 매칭될 수 있다. alias 판정은 1위 피크만 넘겨 확인한다.
    top1 = run.peaks[:1]
    # 정답 주기를 절반으로 적으면 피크(3.0)는 정답(1.5)의 2배 → alias_double
    half = _row(period=1.5, n_tr=2 * row.n_transits_in_window)
    assert bls_match.match_injection(t, half, top1).match == "alias_double"
    # 정답 주기를 2배로 적으면 → alias_half
    dbl = _row(period=6.0, n_tr=row.n_transits_in_window // 2)
    assert bls_match.match_injection(t, dbl, top1).match == "alias_half"
    # 무관한 주기 → wrong, 가장 가까운 피크의 오차가 기록됨
    wrong = _row(period=7.7, t0=1401.3, n_tr=3)
    mw = bls_match.match_injection(t, wrong, run.peaks)
    assert mw.match == "wrong" and mw.matched_rank is not None and np.isfinite(mw.period_rel_err)
    assert bls_match.match_injection(t, row, []).match == "missed"


def test_direct_beats_alias_and_rank_orders_ties():
    t = np.arange(1400.0, 1427.0, 2 / 1440)
    peaks = [bls.Peak(1, 6.0, 1402.0, 2.0, 3e-3, 1e-4, 10, 10, 8, 30, 20, 4, 200, 0.0),
             bls.Peak(2, 3.0, 1402.0, 2.0, 3e-3, 1e-4, 9, 9, 7, 28, 19, 8, 400, 0.0)]
    m = bls_match.match_injection(t, _row(period=3.0), peaks)
    assert m.match == "direct" and m.matched_rank == 2                   # rank1 은 alias(2배)지만 direct 가 우선


def test_summarize_and_bins():
    rows = []
    for i, (kind, P, dh, dp) in enumerate([("direct", 1.0, 0.5, 500), ("alias_half", 5.0, 2.0, 1000), ("wrong", 20.0, 8.0, 3000), ("direct", 20.0, 8.0, 10000)]):
        rows.append({"match": kind, "matched_rank": 1 if kind != "wrong" else 2, "period_rel_err": 0.001, "epoch_cyclic_err_hours": 0.2,
                     "duration_ratio": 1.1, "depth_ratio": 0.9, "period_days": P, "duration_hours": dh, "depth_ppm": dp})
    s = bls_match.summarize_matches(rows)
    assert s["n_signals"] == 4 and s["direct_recovery"] == 0.5 and s["alias_inclusive_recovery"] == 0.75 and s["wrong_rate"] == 0.25
    assert s["direct_period_<2d"] == 1.0 and s["direct_period_>=10d"] == 0.5 and s["direct_depth_<=1000ppm"] == 0.5
    assert s["matched_rank1_fraction"] == 1.0 and bls_match.summarize_matches([]) == {"n_signals": 0}
    assert "direct_recovery_in_range" not in s                          # 열이 없으면 범위 안 지표를 만들지 않는다
    for r in rows:
        r["in_search_range"] = "true" if r["period_days"] < 10 else "false"   # 20일 두 개는 범위 밖
    s2 = bls_match.summarize_matches(rows)
    assert s2["n_signals_in_range"] == 2 and s2["direct_recovery_in_range"] == 0.5 and s2["alias_inclusive_recovery_in_range"] == 1.0
    assert s2["direct_recovery"] == 0.5                                 # 전체 지표는 그대로


def test_summarize_in_range_all_out_gives_nan():
    rows = [{"match": "missed", "matched_rank": "", "period_rel_err": float("nan"), "epoch_cyclic_err_hours": float("nan"),
             "duration_ratio": float("nan"), "depth_ratio": float("nan"), "period_days": 20.0, "duration_hours": 4.0,
             "depth_ppm": 1000, "in_search_range": "false"}]
    s = bls_match.summarize_matches(rows)
    assert s["n_signals_in_range"] == 0 and s["direct_recovery_in_range"] != s["direct_recovery_in_range"]   # nan


def test_gate_table_counts_recovery_and_false_peaks():
    peaks = [
        {"setting_id": "s", "baseline_id": "b-real", "group_id": "g1", "is_pure_noise": "false", "rank": 1, "sde": 12.0, "snr": 10.0, "n_transits": 8},
        {"setting_id": "s", "baseline_id": "b-real", "group_id": "g2", "is_pure_noise": "false", "rank": 1, "sde": 5.0, "snr": 4.0, "n_transits": 2},
        {"setting_id": "s", "baseline_id": "b-noise", "group_id": "none", "is_pure_noise": "true", "rank": 1, "sde": 7.0, "snr": 6.0, "n_transits": 3},
        {"setting_id": "s", "baseline_id": "b-noise", "group_id": "none", "is_pure_noise": "true", "rank": 2, "sde": 4.0, "snr": 3.0, "n_transits": 2},
    ]
    matches = [{"setting_id": "s", "baseline_id": "b-real", "group_id": "g1", "match": "direct", "matched_rank": 1},
               {"setting_id": "s", "baseline_id": "b-real", "group_id": "g2", "match": "direct", "matched_rank": 1}]
    table = bls_match.gate_table(peaks, matches, snr_thresholds=[5], sde_thresholds=[6], min_transits=[3])
    by = {r["gate"]: r for r in table}
    assert by["none"]["gated_recovery"] == 1.0 and by["none"]["false_peaks_per_noise_curve"] == 2.0
    assert by["snr>=5"]["gated_recovery"] == 0.5 and by["snr>=5"]["false_peaks_per_noise_curve"] == 1.0
    assert by["snr>=5&sde>=6&ntr>=3"]["gated_recovery"] == 0.5 and by["snr>=5&sde>=6&ntr>=3"]["false_peaks_per_noise_curve"] == 1.0
    assert by["sde>=6"]["n_noise_curves"] == 1 and by["sde>=6"]["n_signals"] == 2
    assert by["none"]["n_real_curves"] == 0 and by["none"]["residual_peaks_per_real_curve"] != by["none"]["residual_peaks_per_real_curve"]


def test_gate_table_residual_peaks_on_real_none_curves():
    """realclean 의 주입 없는 곡선(group none) 에 남은 피크는 '잔여' 로 따로 세고, 잡음 none 곡선과 섞지 않는다."""
    peaks = [
        {"setting_id": "s", "baseline_id": "star-realclean", "group_id": "none", "rank": 1, "sde": 30.0, "snr": 50.0, "n_transits": 40},
        {"setting_id": "s", "baseline_id": "star-realclean", "group_id": "none", "rank": 2, "sde": 3.0, "snr": 17.0, "n_transits": 5},
        {"setting_id": "s", "baseline_id": "star-realclean", "group_id": "g1", "rank": 1, "sde": 12.0, "snr": 10.0, "n_transits": 8},
        {"setting_id": "s", "baseline_id": "star-noise1", "group_id": "none", "rank": 1, "sde": 4.0, "snr": 3.0, "n_transits": 2},
        {"setting_id": "s", "baseline_id": "star-noise2", "group_id": "none", "rank": 1, "sde": 7.5, "snr": 8.0, "n_transits": 3},
    ]
    matches = [{"setting_id": "s", "baseline_id": "star-realclean", "group_id": "g1", "match": "direct", "matched_rank": 1}]
    table = bls_match.gate_table(peaks, matches, snr_thresholds=[7], sde_thresholds=[6], min_transits=[])
    by = {r["gate"]: r for r in table}
    assert by["none"]["n_real_curves"] == 1 and by["none"]["n_noise_curves"] == 2
    assert by["none"]["residual_peaks_per_real_curve"] == 2.0 and by["none"]["false_peaks_per_noise_curve"] == 1.0
    assert by["snr>=7"]["residual_peaks_per_real_curve"] == 2.0        # SNR 만으로는 자전 변광 피크(SNR 17, SDE 3)가 남는다
    assert by["snr>=7"]["false_peaks_per_noise_curve"] == 0.5
    assert by["snr>=7&sde>=6"]["residual_peaks_per_real_curve"] == 1.0  # SDE 를 더하면 제거 잔여(SNR 50, SDE 30) 만 남는다
    assert by["snr>=7&sde>=6"]["false_peaks_per_noise_curve"] == 0.5 and by["snr>=7&sde>=6"]["gated_recovery"] == 1.0

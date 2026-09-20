"""SNR 점 오차 방식 비교 (bls_dy, 문서 5.3절·MR !59 리뷰 반영)."""
import numpy as np
import pytest

from tess_bench import bls, bls_dy
from tess_fixture.lightcurve import SectorCurve, build_baseline


def _curve(period=3.0, t0=1402.0, dur_h=2.0, depth=3e-3, n_days=27.0, noise=3e-4, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, 2.0 / 1440)
    f = 1 + rng.normal(0, noise, size=t.shape)
    phase = ((t - t0) / period + 0.5) % 1.0 - 0.5
    f[np.abs(phase * period) < dur_h / 48] *= 1 - depth
    return t, f


def _sector(sector, t, flux, err, quality):
    return SectorCurve(tic_id=1, sector=sector, filename=f"s{sector}.fits", time=t, flux=flux, flux_err=err,
                       quality=quality, cadenceno=np.arange(t.size), meta={})


def test_baseline_flux_err_follows_build_baseline_mask_and_order():
    rng = np.random.default_rng(0)
    t1 = np.array([1.0, 3.0, 2.0, 4.0]); f1 = np.array([200.0, 210.0, np.nan, 190.0]); e1 = np.array([2.0, 3.0, 4.0, 5.0]); q1 = np.array([0, 0, 0, 8])
    t2 = np.array([10.0, 11.0]); f2 = np.array([50.0, 50.0]); e2 = np.array([1.0, 0.5]); q2 = np.array([0, 0])
    curves = [_sector(2, t2, f2, e2, q2), _sector(1, t1, f1, e1, q1)]
    base = build_baseline(curves)
    err = bls_dy.baseline_flux_err(curves, base)
    # sector 1: 유효 점 t=1(200, e 2)·t=3(210, e 3) → 중앙값 205; t=2 는 NaN, t=4 는 quality 8 로 제외. sector 2: 중앙값 50
    assert base.time.tolist() == [1.0, 3.0, 10.0, 11.0]
    assert err == pytest.approx([2 / 205, 3 / 205, 1 / 50, 0.5 / 50])
    with pytest.raises(ValueError):
        bls_dy.baseline_flux_err(curves, build_baseline(curves[:1]))


def test_local_scatter_tracks_segment_noise_and_falls_back_when_sparse():
    rng = np.random.default_rng(3)
    t = np.arange(0, 4.0, 2.0 / 1440)
    f = 1 + rng.normal(0, 1e-3, t.size)
    f[t >= 2.0] = 1 + rng.normal(0, 3e-3, (t >= 2.0).sum())
    s = bls_dy.local_scatter(t, f, window_days=1.0)
    assert np.median(s[t < 2.0]) == pytest.approx(1e-3, rel=0.15) and np.median(s[t >= 2.0]) == pytest.approx(3e-3, rel=0.15)
    sparse = bls_dy.local_scatter(t[:10], f[:10], window_days=0.001, min_points=20)       # 구간마다 1점 → 전역값
    assert np.allclose(sparse, bls_dy.robust_scatter(f[:10]))
    with pytest.raises(ValueError):
        bls_dy.local_scatter(t, f, window_days=0)


def test_recompute_snr_with_global_dy_reproduces_run_bls_snr():
    t, f = _curve()
    run = bls.run_bls(t, f, bls.BlsSetting("s", n_periods=4000))
    rows = [p.as_row() for p in run.peaks]
    dys = bls_dy.dy_arrays(t, f, None)
    got = bls_dy.recompute_snr(t, f, dys["global"], rows)
    rel = np.abs(np.array(got) - np.array([p.snr for p in run.peaks])) / np.array([p.snr for p in run.peaks])
    assert np.median(rel) < 1e-9 and rel.max() < 0.05                       # 위상 비닝 근사 차이(몇 %)만 허용, 대부분은 정확히 같다
    assert np.allclose(dys["flux_err"], dys["global"])                                     # 원본 오차가 없으면 전역값
    # 점 오차를 2배로 주면 SNR 은 절반
    half = bls_dy.recompute_snr(t, f, 2 * dys["global"], rows)
    assert half == pytest.approx([g / 2 for g in got], rel=1e-9)


def test_dy_arrays_flux_err_fills_invalid_points_with_global():
    t, f = _curve(n_days=3.0)
    err = np.full(t.size, 2e-4); err[:5] = np.nan; err[5] = -1.0
    dys = bls_dy.dy_arrays(t, f, err)
    assert np.all(dys["flux_err"][6:] == 2e-4) and np.allclose(dys["flux_err"][:6], dys["global"][0])


def test_gate_comparison_applies_same_gates_per_method():
    peaks = {"setting_id": "s", "baseline_id": "b-realclean", "group_id": "g1", "rank": 1, "sde": 8.0, "n_transits": 5}
    none_noise = {"setting_id": "s", "baseline_id": "b-noise1", "group_id": "none", "rank": 1, "sde": 7.0, "n_transits": 3}
    by_method = {"global": [{**peaks, "snr": 10.0}, {**none_noise, "snr": 9.0}],
                 "local": [{**peaks, "snr": 10.0}, {**none_noise, "snr": 4.0}]}
    matches = [{"setting_id": "s", "baseline_id": "b-realclean", "group_id": "g1", "match": "direct", "matched_rank": "1"}]
    table = bls_dy.gate_comparison(by_method, matches)
    row = {(r["method"], r["gate"]): r for r in table}
    assert row[("global", "snr>=7&sde>=6")]["false_peaks_per_noise_curve"] == 1.0
    assert row[("local", "snr>=7&sde>=6")]["false_peaks_per_noise_curve"] == 0.0          # local 오차가 커져 임의 피크가 게이트를 못 넘는다
    assert row[("global", "snr>=7&sde>=6")]["gated_recovery"] == row[("local", "snr>=7&sde>=6")]["gated_recovery"] == 1.0
    assert {r["gate"] for r in table} == {"none", "snr>=7", "sde>=6", "snr>=7&sde>=6"}


def test_manifest_mismatches_detects_changed_inputs_and_params():
    prm = {"grid_set_id": "injection_grid_v1-1.1.0", "preprocess_setting": {"window_days": 1.0, "sigma_upper": 5.0},
           "setting_params": {"poc_linear20k": {"n_periods": 20000, "durations_hours": [1.2, 1.92, 2.88, 4.8]}}}
    inputs = [{"role": "grid", "sha256": "g"}, {"role": "bls_settings", "sha256": "b"}, {"role": "preprocess_settings", "sha256": "p"}, {"role": "raw_product", "sha256": "x"}]
    ok_sha = {"grid": "g", "bls_settings": "b", "preprocess_settings": "p"}
    cur_setting = {"poc_linear20k": {"n_periods": 20000, "durations_hours": [1.2, 1.92, 2.88, 4.8], "n_durations": 4}}   # 나중에 추가된 기록 키는 무시
    assert bls_dy.manifest_mismatches(prm, inputs, ok_sha, grid_set_id="injection_grid_v1-1.1.0", preprocess_params={"window_days": 1.0, "sigma_upper": 5.0, "extra": 1}, setting_params=cur_setting) == []
    bad = bls_dy.manifest_mismatches(prm, inputs, {**ok_sha, "grid": "changed"}, grid_set_id="injection_grid_v1-1.2.0",
                                     preprocess_params={"window_days": 0.5, "sigma_upper": 5.0}, setting_params={"poc_linear20k": {"n_periods": 50000}})
    assert bad == ["sha256:grid", "grid_set_id", "preprocess:window_days", "setting:poc_linear20k:n_periods", "setting_key_missing:poc_linear20k:durations_hours"]
    assert "manifest_missing:preprocess_settings" in bls_dy.manifest_mismatches(prm, inputs[:2], ok_sha, grid_set_id="injection_grid_v1-1.1.0", preprocess_params={"window_days": 1.0, "sigma_upper": 5.0}, setting_params=cur_setting)
    assert "setting_missing:poc_linear20k" in bls_dy.manifest_mismatches(prm, inputs, ok_sha, grid_set_id="injection_grid_v1-1.1.0", preprocess_params={"window_days": 1.0, "sigma_upper": 5.0}, setting_params={})


def test_manifest_mismatches_flags_deleted_or_renamed_keys_but_allows_known_meta_keys():
    """3차 리뷰: 기록된 키가 현재 params 에서 사라지면(삭제·이름 변경) 통과시키지 않는다."""
    prm = {"grid_set_id": "g", "preprocess_setting": {"window_days": 1.0, "sigma_upper": 5.0}, "setting_params": {"s": {"n_periods": 20000, "oversample": 10}}}
    inputs = [{"role": r, "sha256": r} for r in ("grid", "bls_settings", "preprocess_settings")]
    sha = {r: r for r in ("grid", "bls_settings", "preprocess_settings")}
    base = dict(grid_set_id="g", preprocess_params={"window_days": 1.0, "sigma_upper": 5.0}, setting_params={"s": {"n_periods": 20000, "oversample": 10}})
    assert bls_dy.manifest_mismatches(prm, inputs, sha, **base) == []
    renamed = bls_dy.manifest_mismatches(prm, inputs, sha, grid_set_id="g", preprocess_params={"window_d": 1.0, "sigma_upper": 5.0}, setting_params=base["setting_params"])
    assert renamed == ["preprocess_missing:window_days"]
    dropped = bls_dy.manifest_mismatches(prm, inputs, sha, grid_set_id="g", preprocess_params=base["preprocess_params"], setting_params={"s": {"n_periods": 20000}})
    assert dropped == ["setting_key_missing:s:oversample"]
    meta_ok = bls_dy.manifest_mismatches(prm, inputs, sha, grid_set_id="g", preprocess_params=base["preprocess_params"],
                                         setting_params={"s": {"n_periods": 20000, "oversample": 10, "n_durations": 4, "durations_hours_configured": [1.2]}})
    assert meta_ok == []                                                                       # 허용된 기록용 메타 키만 새로 있어도 통과
    unknown_new = bls_dy.manifest_mismatches(prm, inputs, sha, grid_set_id="g", preprocess_params=base["preprocess_params"],
                                             setting_params={"s": {"n_periods": 20000, "oversample": 10, "brand_new": 1}})
    assert unknown_new == ["setting_key_added:s:brand_new"]


def test_reproduction_verdict_is_per_setting_and_rejects_systematic_drift():
    exact = [{"setting_id": "a", "snr_stored": 10.0, "snr_global": 10.0} for _ in range(18)]
    exact += [{"setting_id": "a", "snr_stored": 10.0, "snr_global": 10.9}]                      # 위상 비닝 근사 피크 1개 (1/19 ≈ 5%)
    drift = [{"setting_id": "b", "snr_stored": 10.0, "snr_global": 10.02} for _ in range(19)]   # 설정 전체가 0.2% 다름 → 중앙값·비율 모두 실패
    v = {r["setting_id"]: r for r in bls_dy.reproduction_verdict(exact + drift)}
    assert v["a"]["ok"] and v["a"]["n"] == 19 and v["a"]["fraction_over_1e-3"] == pytest.approx(1 / 19)
    assert not v["b"]["ok"] and v["b"]["median"] == pytest.approx(0.002)
    many = [{"setting_id": "c", "snr_stored": 10.0, "snr_global": 10.0 if i % 3 else 10.5} for i in range(21)]   # 33% 가 근사 차 → 실패 (상한 25%)
    assert not bls_dy.reproduction_verdict(many)[0]["ok"]
    some = [{"setting_id": "c2", "snr_stored": 10.0, "snr_global": 10.0 if i % 7 else 10.5} for i in range(21)]  # 14% (CM Dra 실측) → 통과
    assert bls_dy.reproduction_verdict(some)[0]["ok"]
    # 최대 상대 차 상한 0.2 (실측 최대 0.161): 바로 아래는 통과, 넘으면 실패
    assert bls_dy.REPRODUCTION_ABS_MAX == 0.2
    below = [{"setting_id": "d", "snr_stored": 10.0, "snr_global": 10.0} for _ in range(19)] + [{"setting_id": "d", "snr_stored": 10.0, "snr_global": 11.99}]
    above = [{"setting_id": "e", "snr_stored": 10.0, "snr_global": 10.0} for _ in range(19)] + [{"setting_id": "e", "snr_stored": 10.0, "snr_global": 12.01}]
    assert bls_dy.reproduction_verdict(below)[0]["ok"] and not bls_dy.reproduction_verdict(above)[0]["ok"]

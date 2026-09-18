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

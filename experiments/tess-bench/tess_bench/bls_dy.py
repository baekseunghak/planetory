# -*- coding: utf-8 -*-
"""SNR 점 오차(dy) 산정 방식 비교 (S15P21C206-110, MR !59 리뷰 반영, 문서 5.3절).

`bls` 실행은 정제곡선 전역 robust scatter 하나를 모든 점의 오차로 준다. 후보 검출 설계 5.6절이 비교하라고 한
원본 `PDCSAP_FLUX_ERR` 와 국소 scatter 는 그 실행에 없으므로, 저장된 상위 피크의 SNR 만 세 방식으로 다시 계산한다
(재탐색 없음, astropy `compute_stats` 의 depth / depth_err). 게이트 비교는 `bls_match.gate_table` 을 SNR 열만 바꿔 재사용한다.

방식
  global   : 정제곡선 전체 1.4826×MAD 를 모든 점에 (현재 구현. 저장된 snr 과 같아야 한다 → 재현 검사)
  flux_err : 원본 PDCSAP_FLUX_ERR / Sector 중앙값 / 추세. 합성 잡음 곡선은 생성 σ(실제 곡선의 robust scatter) 상수
  local    : 정제곡선을 window_days 구간으로 잘라 구간별 1.4826×MAD. 점이 min_points 미만인 구간은 전역값
"""

from __future__ import annotations

import numpy as np

from tess_fixture.lightcurve import Baseline, SectorCurve, quality_keep_mask

METHODS: tuple[str, ...] = ("global", "flux_err", "local")


def baseline_flux_err(curves: list[SectorCurve], baseline: Baseline, quality_bitmask: int | None = None) -> np.ndarray:
    """`build_baseline` 과 같은 선택·정규화·정렬로 PDCSAP_FLUX_ERR 를 바탕곡선 점에 맞춘다(상대 밝기 단위).

    시각 배열이 바탕곡선과 정확히 같지 않으면 ValueError — 다른 마스크·정렬 규칙이 섞인 것이다.
    """
    times, errs = [], []
    for curve in sorted(curves, key=lambda c: c.sector):
        keep = quality_keep_mask(curve.quality, quality_bitmask) & np.isfinite(curve.time) & np.isfinite(curve.flux)
        t, f, e = curve.time[keep], curve.flux[keep], curve.flux_err[keep]
        order = np.argsort(t)
        med = float(np.median(f[order])) if len(f) else float("nan")
        times.append(t[order]); errs.append(e[order] / med)
    time = np.concatenate(times); err = np.concatenate(errs)
    order = np.argsort(time, kind="stable")
    time, err = time[order], err[order]
    if time.shape != baseline.time.shape or not np.array_equal(time, baseline.time):
        raise ValueError("flux_err alignment failed: time arrays differ from build_baseline")
    return err


def robust_scatter(x: np.ndarray) -> float:
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def local_scatter(t: np.ndarray, f: np.ndarray, *, window_days: float = 1.0, min_points: int = 20) -> np.ndarray:
    """구간별(window_days 폭, 첫 시각 기준) robust scatter 를 각 점에 준다. 점이 적은 구간은 전역 scatter."""
    t = np.asarray(t, float); f = np.asarray(f, float)
    if window_days <= 0:
        raise ValueError("window_days must be positive")
    glob = robust_scatter(f)
    out = np.full(t.shape, glob)
    if t.size == 0:
        return out
    bins = np.floor((t - t.min()) / window_days).astype(int)
    for b in np.unique(bins):
        idx = bins == b
        if idx.sum() >= min_points:
            s = robust_scatter(f[idx])
            if np.isfinite(s) and s > 0:
                out[idx] = s
    return out


def dy_arrays(t: np.ndarray, f: np.ndarray, err_det: np.ndarray | None, *, window_days: float = 1.0, min_points: int = 20) -> dict[str, np.ndarray]:
    """세 방식의 점 오차 배열. err_det 가 None(합성 잡음 등 원본 오차 없음)이면 flux_err 방식은 호출자가 준 상수 대신 전역값."""
    glob = robust_scatter(f)
    out = {"global": np.full(t.shape, glob), "local": local_scatter(t, f, window_days=window_days, min_points=min_points)}
    if err_det is None:
        out["flux_err"] = np.full(t.shape, glob)
    else:
        e = np.asarray(err_det, float)
        bad = ~np.isfinite(e) | (e <= 0)
        if bad.any():                                   # 추세 실패 점 등은 전역값으로 메운다(점 수는 작다)
            e = e.copy(); e[bad] = glob
        out["flux_err"] = e
    return out


def recompute_snr(t: np.ndarray, f: np.ndarray, dy: np.ndarray, peaks: list[dict]) -> list[float]:
    """저장된 피크(period_days, duration_hours, epoch_btjd)마다 dy 로 box 적합 SNR(depth / depth_err)을 다시 계산한다.

    `power()` 의 depth_snr 은 위상을 duration/oversample 로 비닌 근사값이고 `compute_stats` 는 점 단위 정확값이라
    같은 dy 라도 피크 몇 개는 몇 % 다를 수 있다. 방식 사이 비교는 모두 이 함수로 하므로 일관된다.
    """
    from astropy.timeseries import BoxLeastSquares

    if not peaks:
        return []
    bls = BoxLeastSquares(np.asarray(t, float), np.asarray(f, float), dy=np.asarray(dy, float))
    out = []
    for p in peaks:
        st = bls.compute_stats(float(p["period_days"]), float(p["duration_hours"]) / 24.0, float(p["epoch_btjd"]))
        depth, err = float(st["depth"][0]), float(st["depth"][1])
        out.append(depth / err if np.isfinite(err) and err > 0 else float("nan"))
    return out


def gate_comparison(peak_rows_by_method: dict[str, list[dict]], match_rows: list[dict], *, snr_min: float = 7.0, sde_min: float = 6.0) -> list[dict]:
    """방식별로 SNR 열을 바꾼 피크 행에 같은 게이트(없음·SNR·SDE·SNR&SDE)를 적용해 한 표로 합친다."""
    from .bls_match import gate_table

    def _num(x):
        return int(x) if float(x).is_integer() else x                 # 게이트 이름을 bls-gates 와 같게 (snr>=7, 7.0 아님)

    out: list[dict] = []
    for method, rows in peak_rows_by_method.items():
        table = gate_table(rows, match_rows, snr_thresholds=[_num(snr_min)], sde_thresholds=[_num(sde_min)], min_transits=[])
        for r in table:
            out.append({"method": method, **r})
    return out

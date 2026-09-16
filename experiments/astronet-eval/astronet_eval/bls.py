# -*- coding: utf-8 -*-
"""junk 후보용 BLS 최강 피크와, 알려진 주기의 epoch·duration 산출.

BLS 격자·품질 기준은 110 벤치마크의 대상이라 여기서는 PoC `pipeline.bls_features` 기본값을 잠정값으로 쓴다
(설정 파일 `junk_bls`). 이 모듈은 후보의 **기하**(period·epoch·duration)만 만들고 품질 판정은 하지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BlsPeak:
    period_days: float
    epoch_btjd: float
    duration_days: float
    depth: float            # 상대 깊이 (astropy depth)
    power: float
    snr: float | None


def _bls(time: np.ndarray, flux: np.ndarray):
    from astropy.timeseries import BoxLeastSquares
    return BoxLeastSquares(time, flux)


def strongest_peak(time: np.ndarray, flux: np.ndarray, *, period_min_days: float = 0.5,
                   period_max_days: float | None = None, n_periods: int = 20000,
                   durations_days=(0.05, 0.08, 0.12, 0.2)) -> BlsPeak:
    """선형 주기 격자에서 power 최대인 봉우리. PoC 기본값과 같은 격자 규칙."""
    ok = np.isfinite(time) & np.isfinite(flux)
    t, f = np.asarray(time, float)[ok], np.asarray(flux, float)[ok]
    if t.size < 100:
        raise ValueError(f"BLS 에 필요한 점이 부족하다: {t.size}")
    baseline = float(t.max() - t.min())
    period_max = period_max_days or min(baseline / 3.0, 100.0)
    if period_max <= period_min_days:
        raise ValueError(f"주기 범위가 비었다: [{period_min_days}, {period_max}]")
    durations = np.asarray(durations_days, dtype=float)
    durations = durations[durations < period_min_days]           # astropy 요구: duration < 최소 period
    grid = np.linspace(period_min_days, period_max, int(n_periods))
    result = _bls(t, f).power(grid, durations, objective="snr")
    i = int(np.argmax(result.power))
    depth_err = float(result.depth_err[i]) if np.isfinite(result.depth_err[i]) and result.depth_err[i] > 0 else None
    return BlsPeak(period_days=float(result.period[i]), epoch_btjd=float(result.transit_time[i]),
                   duration_days=float(result.duration[i]), depth=float(result.depth[i]), power=float(result.power[i]),
                   snr=None if depth_err is None else float(result.depth[i] / depth_err))


def geometry_at_known_period(time: np.ndarray, flux: np.ndarray, period_days: float,
                             durations_days=(0.02, 0.03, 0.05, 0.08, 0.12, 0.2)) -> BlsPeak:
    """주기를 알고 epoch·duration 만 모르는 후보(식쌍성 등). 그 주기 하나에서 BLS 로 통과 중심·폭을 고른다."""
    ok = np.isfinite(time) & np.isfinite(flux)
    t, f = np.asarray(time, float)[ok], np.asarray(flux, float)[ok]
    durations = np.asarray(durations_days, dtype=float)
    durations = durations[durations < period_days]
    if durations.size == 0:
        raise ValueError(f"주기 {period_days} 보다 짧은 duration 후보가 없다")
    result = _bls(t, f).power(np.array([period_days]), durations, objective="snr")
    depth_err = float(result.depth_err[0]) if np.isfinite(result.depth_err[0]) and result.depth_err[0] > 0 else None
    return BlsPeak(period_days=float(result.period[0]), epoch_btjd=float(result.transit_time[0]),
                   duration_days=float(result.duration[0]), depth=float(result.depth[0]), power=float(result.power[0]),
                   snr=None if depth_err is None else float(result.depth[0] / depth_err))

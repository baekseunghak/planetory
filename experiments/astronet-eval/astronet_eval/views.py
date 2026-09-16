# -*- coding: utf-8 -*-
"""위상 접기와 AstroNet-Triage global/local view 생성.

수식은 40번 `experiments/astronet-feasibility/prepare_toi270_probe.py` 의 `phase_fold`·`median_view` 와 같다.
이 규칙은 checkpoint 가 학습한 입력 규칙이라 바꾸지 않는다. 바뀐 것은 예외로 중단하는 대신 후보별 실패
사유(`ViewFailure`)를 돌려주는 점이다. 점수 0 대체는 하지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ViewSpec:
    global_bins: int = 201
    global_bin_width_factor: float = 1.2       # bin 폭 = period × factor / global_bins
    local_bins: int = 61
    local_bin_width_factor: float = 0.16       # bin 폭 = duration × factor
    local_half_range_durations: float = 2.0    # local 범위 = ±duration × 2 (단, ±period/2 안)
    min_in_transit_points: int = 3


class ViewFailure(ValueError):
    """입력 변환 실패. `reason` 은 conversions.csv 에 기록되는 고정 문자열."""

    def __init__(self, reason: str, message: str):
        self.reason = reason
        super().__init__(f"[{reason}] {message}")


def phase_fold(time: np.ndarray, flux: np.ndarray, period: float, t0: float) -> tuple[np.ndarray, np.ndarray]:
    """접힌 시각 [-P/2, P/2) 오름차순과 그에 맞춘 flux. 40번과 같은 수식."""
    folded = (time + (period / 2 - t0)) % period - period / 2
    order = np.argsort(folded, kind="stable")
    return folded[order], flux[order]


def median_view(time: np.ndarray, flux: np.ndarray, *, num_bins: int, bin_width: float,
                t_min: float, t_max: float) -> np.ndarray:
    """겹치는 bin 의 중앙값 → 빈 bin 선형 보간 → 중앙값 빼기 → |최솟값| 으로 나눔 → float32.

    실패: 모든 bin 이 비었으면 `empty_view`, 정규화 분모가 0·비유한이면 `flat_view`.
    """
    spacing = (t_max - t_min - bin_width) / (num_bins - 1)
    view = np.full(num_bins, np.nan, dtype=np.float64)
    for index in range(num_bins):
        left = t_min + index * spacing
        values = flux[(time >= left) & (time < left + bin_width)]
        if values.size:
            view[index] = np.median(values)
    valid = np.flatnonzero(np.isfinite(view))
    if not valid.size:
        raise ViewFailure("empty_view", f"{num_bins}개 bin 이 모두 비었다")
    view = np.interp(np.arange(num_bins), valid, view[valid])
    view -= np.median(view)
    scale = abs(float(np.min(view)))
    if not np.isfinite(scale) or scale == 0:
        raise ViewFailure("flat_view", "view 최솟값이 0 이라 정규화할 수 없다")
    return (view / scale).astype(np.float32)


@dataclass(frozen=True)
class Views:
    global_view: np.ndarray          # (201,) float32
    local_view: np.ndarray           # (61,) float32
    n_points: int                    # 접기에 쓴 유효 점 수
    n_in_transit: int                # |folded| < duration/2 인 점 수
    n_empty_global_bins: int         # 보간 전 빈 bin 수
    n_empty_local_bins: int


def make_views(time: np.ndarray, flux: np.ndarray, *, period_days: float, epoch_btjd: float,
               duration_days: float, spec: ViewSpec = ViewSpec()) -> Views:
    """전처리된 곡선 하나와 후보 기하로 global/local view 를 만든다.

    time·flux 는 NaN 을 제거한 유효 점만 넘긴다(호출자가 `kept` 마스크 적용). 실패는 ViewFailure.
    """
    time = np.asarray(time, dtype=np.float64)
    flux = np.asarray(flux, dtype=np.float64)
    ok = np.isfinite(time) & np.isfinite(flux)
    time, flux = time[ok], flux[ok]
    if time.size == 0:
        raise ViewFailure("no_valid_points", "유효 관측점이 없다")
    if not (np.isfinite(period_days) and period_days > 0 and np.isfinite(duration_days) and 0 < duration_days < period_days):
        raise ViewFailure("invalid_geometry", f"period={period_days}, duration={duration_days}")

    folded_t, folded_f = phase_fold(time, flux, period_days, epoch_btjd)
    n_in_transit = int((np.abs(folded_t) < 0.5 * duration_days).sum())
    if n_in_transit < spec.min_in_transit_points:
        raise ViewFailure("too_few_transit_points", f"통과 안 점 {n_in_transit} < {spec.min_in_transit_points}")

    g_width = period_days * spec.global_bin_width_factor / spec.global_bins
    n_empty_g = _count_empty_bins(folded_t, spec.global_bins, g_width, -period_days / 2, period_days / 2)
    global_view = median_view(folded_t, folded_f, num_bins=spec.global_bins, bin_width=g_width,
                              t_min=-period_days / 2, t_max=period_days / 2)

    half = min(period_days / 2, duration_days * spec.local_half_range_durations)
    l_width = duration_days * spec.local_bin_width_factor
    n_empty_l = _count_empty_bins(folded_t, spec.local_bins, l_width, -half, half)
    local_view = median_view(folded_t, folded_f, num_bins=spec.local_bins, bin_width=l_width, t_min=-half, t_max=half)

    if global_view.shape != (spec.global_bins,) or local_view.shape != (spec.local_bins,):
        raise ViewFailure("bad_shape", f"{global_view.shape}, {local_view.shape}")
    if not (np.isfinite(global_view).all() and np.isfinite(local_view).all()):
        raise ViewFailure("non_finite_view", "view 에 비유한 값")
    return Views(global_view=global_view, local_view=local_view, n_points=int(time.size), n_in_transit=n_in_transit,
                 n_empty_global_bins=n_empty_g, n_empty_local_bins=n_empty_l)


def _count_empty_bins(time: np.ndarray, num_bins: int, bin_width: float, t_min: float, t_max: float) -> int:
    spacing = (t_max - t_min - bin_width) / (num_bins - 1)
    lefts = t_min + np.arange(num_bins) * spacing
    # 각 bin 에 점이 하나라도 있는지: 정렬된 time 에서 searchsorted
    t = np.sort(time)
    lo = np.searchsorted(t, lefts, side="left")
    hi = np.searchsorted(t, lefts + bin_width, side="left")
    return int((hi - lo == 0).sum())

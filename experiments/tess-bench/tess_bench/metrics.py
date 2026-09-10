# -*- coding: utf-8 -*-
"""주입 신호 하나에 대한 전처리 품질 지표.

- depth_ratio      : 전처리 후 잰 깊이 / 심은 깊이 (1 이면 보존, 작으면 깎임)
- in_transit_kept  : 통과 구간 점 중 전처리 후 남은 비율
- oot_scatter_ppm  : 통과 밖 구간의 robust scatter (잡음)
- boundary_ratio   : 구간 경계 ±0.5일 안 통과 밖 점의 |flux−1| 중앙값 / 전체 통과 밖 scatter (1 근처면 경계 왜곡 없음)
깊이는 위상 접기 없이 통과 구간 점의 중앙값과 통과 밖 중앙값 차이로 잰다. 같은 group 의 다른 신호가 겹친 점은
그 신호의 알고 있는 모델로 나눠 target 신호만 남긴 뒤 잰다(주입 파라미터를 아는 평가용 계산이며 탐색 코드가 아님).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

from tess_fixture import inject as inj

from .preprocess import PreprocessResult

BOUNDARY_HALF_WIDTH_DAYS = 0.5


@dataclass
class SignalMetrics:
    injection_id: str
    group_id: str
    period_days: float
    duration_hours: float
    depth_ppm: float
    phase_label: str
    n_in_transit: int
    n_in_transit_kept: int
    in_transit_kept: float
    depth_measured_ppm: float
    depth_ratio: float
    oot_scatter_ppm: float
    boundary_ratio: float
    n_segments: int
    n_failed_segments: int
    status: str

    def as_row(self) -> dict:
        return asdict(self)


def _in_transit(t: np.ndarray, row: inj.InjectionRow) -> np.ndarray:
    signal = inj.Signal(row.period_days, row.duration_hours, row.depth_ppm, row.phase_fraction)
    return inj.box_model(t, signal, row.t0_btjd) < 1.0


def robust_scatter(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    if len(x) < 2:
        return float("nan")
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def signal_metrics(result: PreprocessResult, rows: list[inj.InjectionRow], target: inj.InjectionRow) -> SignalMetrics:
    """rows 는 같은 group 의 모든 신호, target 은 지표를 계산할 신호."""
    t, fd, kept = result.time, result.flux_det, result.kept
    masks = {r.injection_id: _in_transit(t, r) for r in rows}
    mine = masks[target.injection_id]
    oot = ~np.any(np.stack(list(masks.values())), axis=0)

    # 같은 group 의 다른 신호가 겹친 점은 그 신호의 (알고 있는) 모델로 나눠 target 신호만 남긴다.
    # 완전히 겹치는 쌍(overlapping_transits 의 8일 신호)도 이렇게 해야 깊이를 잴 수 있다.
    other_model = np.ones_like(fd)
    for r in rows:
        if r.injection_id != target.injection_id:
            other_model *= inj.box_model(t, inj.Signal(r.period_days, r.duration_hours, r.depth_ppm, r.phase_fraction), r.t0_btjd)
    with np.errstate(invalid="ignore"):
        fd_isolated = fd / other_model

    n_in = int(mine.sum())
    n_in_kept = int((mine & kept).sum())
    kept_ratio = n_in_kept / n_in if n_in else float("nan")

    oot_vals = fd[oot & kept]
    in_vals = fd_isolated[mine & kept]
    if len(oot_vals) >= 2 and len(in_vals) >= 1:
        depth_meas = float(np.median(oot_vals) - np.median(in_vals))
    else:
        depth_meas = float("nan")
    depth_ratio = depth_meas / (target.depth_ppm * 1e-6) if np.isfinite(depth_meas) else float("nan")
    scatter = robust_scatter(oot_vals)

    # 구간 경계 왜곡: 각 구간 시작·끝에서 ±0.5일, 통과 밖·사용 점만
    near = np.zeros_like(mine)
    for edge in result.segment_edges.ravel():
        near |= np.abs(t - edge) <= BOUNDARY_HALF_WIDTH_DAYS
    near_vals = fd[near & oot & kept]
    if len(near_vals) >= 5 and np.isfinite(scatter) and scatter > 0:
        boundary_ratio = float(np.median(np.abs(near_vals - 1.0)) / scatter)
    else:
        boundary_ratio = float("nan")

    return SignalMetrics(
        injection_id=target.injection_id, group_id=target.group_id, period_days=target.period_days,
        duration_hours=target.duration_hours, depth_ppm=target.depth_ppm, phase_label=target.phase_label,
        n_in_transit=n_in, n_in_transit_kept=n_in_kept, in_transit_kept=kept_ratio,
        depth_measured_ppm=depth_meas * 1e6 if np.isfinite(depth_meas) else float("nan"), depth_ratio=depth_ratio,
        oot_scatter_ppm=scatter * 1e6 if np.isfinite(scatter) else float("nan"), boundary_ratio=boundary_ratio,
        n_segments=int(result.segment_edges.shape[1]),
        n_failed_segments=len({f["segment_id"] for f in result.failures if f["segment_id"] >= 0}),
        status=result.status,
    )


def summarize(rows: list[dict]) -> dict:
    """설정 하나(바탕곡선 하나)의 SignalMetrics 목록을 요약한다."""
    def med(key, subset=None):
        vals = np.array([r[key] for r in (subset or rows)], dtype=float)
        vals = vals[np.isfinite(vals)]
        return float(np.median(vals)) if len(vals) else float("nan")

    by_dur = {d: [r for r in rows if abs(r["duration_hours"] - d) < 1e-9] for d in (0.5, 2.0, 8.0)}
    return {
        "n_signals": len(rows),
        "depth_ratio_median": med("depth_ratio"),
        "depth_ratio_0.5h": med("depth_ratio", by_dur[0.5]),
        "depth_ratio_2h": med("depth_ratio", by_dur[2.0]),
        "depth_ratio_8h": med("depth_ratio", by_dur[8.0]),
        "in_transit_kept_median": med("in_transit_kept"),
        "oot_scatter_ppm_median": med("oot_scatter_ppm"),
        "boundary_ratio_median": med("boundary_ratio"),
        # 같은 설정이면 모든 곡선의 구간 분리가 같으므로 신호별 값을 합산하지 않고 곡선당 실패 구간 수(최대값)로 보고한다
        "failed_segments_per_curve": int(max((r["n_failed_segments"] for r in rows), default=0)),
    }

"""D14 fixed-model iterative BLS; approved D05-1 QA, without truth oracles.

Search suppression is not physical alias identification. Catalog identity and
publication are handled separately; accepted here means runtime QA acceptance.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from collections.abc import Mapping
import hashlib
import json
from types import SimpleNamespace

import numpy as np

from .bls import BlsError, SEARCH_VERSION, QUALITY_VERSION, search_bls, _vector, _search_input_sha256
from .transit_model import phase_distance_days, remove_transit_models

ITERATION_VERSION = "iteration_v1/111-unity-relative01-duration12"
TERMINATION_REASONS = ("no_quality_peak", "insufficient_observations",
    "duplicate_or_harmonic_only", "removal_qa_failed", "candidate_validation_failed",
    "numerical_failure", "max_iterations_reached")

@dataclass(frozen=True)
class IterationConfig:
    snr_min: float = 7.0
    sde_min: float = 6.0
    min_transits: int = 2
    max_candidates: int = 5
    min_points: int = 100
    refine_span_grid_steps: float = 2.0
    refine_n: int = 201
    alias_multipliers: tuple = (0.5, 1.0, 2.0)
    local_grid_rel: float = 0.02
    local_grid_n: int = 201
    qa_power_ratio_max: float = 0.5
    qa_edge_excess_max: float = 1.5
    qa_other_depth_log2_max: float = 1.0
    qa_overlap_dev_max: float = 3.0
    qa_window_offset_z_max: float = 5.0
    qa_window_offset_rel_depth: float = 0.1
    refine_duration_span: tuple = (0.5, 2.0)
    refine_duration_max_hours: float = 12.0
    max_duration_fraction: float = 0.35

_CONFIG = IterationConfig()

def _transit_stats(t, period, epoch, duration):
    inside = np.abs(phase_distance_days(t, period, epoch)) < duration / 2
    cycles = np.floor((t[inside] - epoch) / period + 0.5)
    _, counts = np.unique(cycles, return_counts=True)
    return len(counts), int(inside.sum()), counts

def robust_scatter(x: np.ndarray) -> float:
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if x.size else float("nan")


def is_duplicate(period: float, duration_days: float, n_transits: int, accepted: list[SimpleNamespace], multipliers) -> int:
    """SRS 5.1 누적 오차 규칙 |P − m·Pc| × N ≤ D/2 (m ∈ multipliers) 로 채택 후보의 중복·고조파인지. 맞으면 그 후보 step, 아니면 -1.

    D 는 피크와 채택 후보 지속시간 중 큰 값. 제거 잔여 피크는 진입·이탈 띠만 남아 지속시간이 짧게 잡히므로 피크 D 만 쓰면 놓친다.
    """
    for c in accepted:
        tol = 0.5 * max(duration_days, c.duration_hours / 24.0) / max(int(n_transits), 1)
        for m in multipliers:
            if abs(period - m * c.period_days) <= tol:
                return c.step
    return -1


def refine_peak(t: np.ndarray, f: np.ndarray, peak: SimpleNamespace, setting: SimpleNamespace, run: SimpleNamespace, cfg: IterationConfig) -> SimpleNamespace:
    """탐색 격자 피크 주위(± refine_span_grid_steps × 격자 간격)를 촘촘히 다시 계산해 주기·epoch·지속시간·깊이·SNR 을 재적합한다. SDE 는 탐색값 유지."""
    from astropy.timeseries import BoxLeastSquares
    spacing = (run.period_max_days - run.period_min_days) / max(run.n_periods - 1, 1)
    lo = max(peak.period_days - cfg.refine_span_grid_steps * spacing, setting.period_min_days)
    hi = peak.period_days + cfg.refine_span_grid_steps * spacing
    grid = np.linspace(lo, hi, cfg.refine_n)
    scatter = robust_scatter(f)
    if not (np.isfinite(scatter) and scatter > 0):
        return peak
    bls = BoxLeastSquares(t, f, dy=scatter)
    D0 = peak.duration_hours / 24.0                                   # 탐색 격자 지속시간 주위도 촘촘히 (격자 4점의 양자화 잔여를 줄인다)
    lo_d, hi_d = cfg.refine_duration_span[0] * D0, cfg.refine_duration_span[1] * D0
    if cfg.refine_duration_max_hours > 0:
        hi_d = max(hi_d, cfg.refine_duration_max_hours / 24.0)          # 탐색 격자 상한(4.8 h)보다 긴 통과(8 h)도 제거 모델이 덮게
    hi_d = min(hi_d, cfg.max_duration_fraction * peak.period_days)      # 주기의 일정 비율을 넘는 폭은 transit 이 아니다
    lo_d = min(lo_d, hi_d)
    durations = np.unique(np.concatenate([np.asarray(setting.effective_durations_hours, float) / 24.0, np.linspace(lo_d, hi_d, 15)]))
    durations = durations[(durations > 0) & (durations < setting.period_min_days)]
    res = bls.power(grid, durations, objective=setting.objective, oversample=setting.oversample)
    power = np.asarray(res.power, float)
    if not np.isfinite(power).any():
        return peak
    i = int(np.nanargmax(power))
    P, ep, D, dep = float(res.period[i]), float(res.transit_time[i]), float(res.duration[i]), float(res.depth[i])
    n_tr, n_in, _ = _transit_stats(t, P, ep, D)
    return SimpleNamespace(rank=peak.rank, period_days=P, epoch_btjd=ep, duration_hours=D * 24.0, depth=dep, depth_err=float(res.depth_err[i]),
                   power=float(power[i]), log_likelihood=float(res.log_likelihood[i]), sde=peak.sde, snr=float(res.depth_snr[i]),
                   poc_snr=peak.poc_snr, n_transits=n_tr, n_in_transit=n_in, mask_dropped_fraction=peak.mask_dropped_fraction)


def local_max_power(t: np.ndarray, f: np.ndarray, period: float, duration_days: float, cfg: IterationConfig) -> float:
    """제거 주기 ±local_grid_rel 국소 격자에서 likelihood power 최대값 (dy = 전역 robust scatter)."""
    from astropy.timeseries import BoxLeastSquares
    scatter = robust_scatter(f)
    if not (np.isfinite(scatter) and scatter > 0):
        return float("nan")
    grid = np.linspace(period * (1 - cfg.local_grid_rel), period * (1 + cfg.local_grid_rel), cfg.local_grid_n)
    try:
        res = BoxLeastSquares(t, f, dy=scatter).power(grid, [duration_days], objective="likelihood", oversample=10)
    except ValueError:
        return float("nan")
    p = np.asarray(res.power, float)
    return float(np.nanmax(p)) if np.isfinite(p).any() else float("nan")


def fixed_depth(t: np.ndarray, f: np.ndarray, period: float, duration_days: float, epoch: float) -> float:
    """고정 파라미터에서 box 적합 깊이 (astropy compute_stats)."""
    from astropy.timeseries import BoxLeastSquares
    scatter = robust_scatter(f)
    if not (np.isfinite(scatter) and scatter > 0):
        return float("nan")
    try:
        st = BoxLeastSquares(t, f, dy=scatter).compute_stats(period, duration_days, epoch)
    except ValueError:                      # 통과 창 안 점이 하나도 없음(마스킹 등) → astropy 가 빈 배열 예외
        return float("nan")
    return float(st["depth"][0])


def fixed_snr(t: np.ndarray, f: np.ndarray, period: float, duration_days: float, epoch: float) -> float:
    from astropy.timeseries import BoxLeastSquares
    scatter = robust_scatter(f)
    if not (np.isfinite(scatter) and scatter > 0):
        return float("nan")
    try:
        st = BoxLeastSquares(t, f, dy=scatter).compute_stats(period, duration_days, epoch)
    except ValueError:
        return float("nan")
    d, e = float(st["depth"][0]), float(st["depth"][1])
    return d / e if np.isfinite(e) and e > 0 else float("nan")


def in_transit_mask(t: np.ndarray, period: float, epoch: float, duration_days: float) -> np.ndarray:
    return np.abs(phase_distance_days(t, period, epoch)) < 0.5 * duration_days


def edge_excess(t: np.ndarray, residual: np.ndarray, period: float, epoch: float, duration_days: float) -> float:
    """제거 뒤 잔차에서 통과 창 가장자리 띠(D/2 ≤ |φ| < D)의 |r−1| 중앙값을 바깥(|φ| ≥ D) robust scatter 로 나눈 값.

    box 모델과 실제 파형의 진입·이탈 차이가 남으면 이 띠에 편차가 몰린다. 잡음만 남으면 약 0.67(정규분포 |x| 중앙값).
    """
    phase = np.abs(phase_distance_days(t, period, epoch))
    edge = (phase >= 0.5 * duration_days) & (phase < duration_days)
    oot = phase >= duration_days                      # 가장자리 띠 밖. 2D 로 잡으면 점유율 높은 신호(8 h/1 d)는 바깥 구간이 없다
    ok = np.isfinite(residual)
    if (edge & ok).sum() < 5 or (oot & ok).sum() < 20:
        return float("nan")
    scatter = robust_scatter(residual[oot & ok])
    if not (scatter > 0):
        return float("nan")
    return float(np.median(np.abs(residual[edge & ok] - 1.0)) / scatter)


def window_offset_z(t: np.ndarray, residual: np.ndarray, period: float, epoch: float, duration_days: float) -> float:
    """제거 뒤 통과 창 안 잔차 평균 (r−1) 을 표준오차(바깥 scatter/√n)로 나눈 z 점수. 올바른 제거면 |z| 가 몇 이내다."""
    return window_offset(t, residual, period, epoch, duration_days)[1]


def window_offset(t: np.ndarray, residual: np.ndarray, period: float, epoch: float, duration_days: float,
                  *, reference: str = "unity") -> tuple[float, float]:
    """(창 안 평균의 기준 대비 편차, z). unity는 기존 mean(r−1), oot는 안−바깥 평균.

    oot의 SE = 바깥 robust scatter × sqrt(1/n_inside + 1/n_outside).
    공통 잡음·독립 점 근사이며 시간 상관을 보정한 유의확률은 아니다.
    잘못 제거해 커진 창 안 산포로 실패를 숨기지 않도록 잡음 척도는 바깥에서만 추정한다.
    """
    if reference not in ("unity", "oot"):
        raise ValueError("reference must be unity or oot")
    phase = np.abs(phase_distance_days(t, period, epoch))
    inside = (phase < 0.5 * duration_days) & np.isfinite(residual)
    oot = (phase >= duration_days) & np.isfinite(residual)
    if inside.sum() < 5 or oot.sum() < 20:
        return float("nan"), float("nan")
    scatter = robust_scatter(residual[oot])
    if not (scatter > 0):
        return float("nan"), float("nan")
    mean = float(np.mean(residual[inside] - 1.0))
    if reference == "oot":
        mean -= float(np.mean(residual[oot] - 1.0))
        return mean, mean / (scatter * np.sqrt(1 / inside.sum() + 1 / oot.sum()))
    return mean, mean / (scatter / np.sqrt(inside.sum()))


def overlap_metrics(t: np.ndarray, residual: np.ndarray, removed: SimpleNamespace, others: list[tuple[float, float, float]]) -> tuple[float, float]:
    """(제거 모델 통과 점 중 다른 신호 통과와 겹치는 비율, 겹친 점들의 |r−1| 중앙값 / 전체 scatter). others = (P, epoch, D_days)."""
    mine = in_transit_mask(t, removed.period_days, removed.epoch_btjd, removed.duration_hours / 24.0)
    if not mine.any() or not others:
        return 0.0, float("nan")
    other = np.zeros_like(mine)
    for P, ep, D in others:
        other |= in_transit_mask(t, P, ep, D)
    both = mine & other & np.isfinite(residual)
    frac = float(both.sum() / mine.sum())
    if both.sum() < 3:
        return frac, float("nan")
    scatter = robust_scatter(residual[np.isfinite(residual)])
    if not (np.isfinite(scatter) and scatter > 0):
        return frac, float("nan")
    return frac, float(np.median(np.abs(residual[both] - 1.0)) / scatter)




def _model(candidate):
    return {"shape": "box", "baseline": {"kind": "unity"},
            "residual_model_version": "box-divide-v0",
            "parameters": {key: candidate[key] for key in
                           ("period_days", "epoch_btjd", "duration_hours", "depth_ppm")}}


def _json_safe(value):
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, np.integer):
        return int(value)
    return value


def _qa(t, original, current, residual, candidate, accepted, removal, cfg):
    p, ep, d = candidate["period_days"], candidate["epoch_btjd"], candidate["duration_hours"] / 24
    ok, ok_r, ok0 = np.isfinite(current), np.isfinite(residual), np.isfinite(original)
    before = local_max_power(t[ok], current[ok], p, d, cfg)
    after = local_max_power(t[ok_r], residual[ok_r], p, d, cfg) if ok_r.sum() >= cfg.min_points else float("nan")
    ratio = after / before if np.isfinite(before) and before > 0 else float("nan")
    failures = []
    if removal.n_finite_residual != removal.n_valid_input or not np.array_equal(ok, ok_r):
        failures.append("non_finite")
    if not (np.isfinite(ratio) and ratio <= cfg.qa_power_ratio_max):
        failures.append("power_not_reduced")
    ee = edge_excess(t, residual, p, ep, d)
    if np.isfinite(ee) and ee > cfg.qa_edge_excess_max:
        failures.append("edge_excess")
    others = [(c["period_days"], c["epoch_btjd"], c["duration_hours"] / 24) for c in accepted]
    depths_before = [fixed_depth(t[ok0], original[ok0], pp, dd, ee0) for pp, ee0, dd in others]
    depths_after = []
    if others and ok_r.sum() >= cfg.min_points:
        r0 = remove_transit_models(t, original, [_model(candidate)]).flux_residual
        valid = np.isfinite(r0)
        depths_after = [fixed_depth(t[valid], r0[valid], pp, dd, ee0) for pp, ee0, dd in others]
    if (len(depths_before) != len(depths_after) or
        any(not (np.isfinite(a) and np.isfinite(b) and a > 0 and b > 0)
            for a, b in zip(depths_before, depths_after))):
        failures.append("other_depth_not_measurable")
    ratios = [abs(np.log2(a) - np.log2(b)) for a, b in zip(depths_before, depths_after)
              if np.isfinite(a) and np.isfinite(b) and a > 0 and b > 0]
    other_log2 = max(ratios) if ratios else float("nan")
    if np.isfinite(other_log2) and other_log2 > cfg.qa_other_depth_log2_max:
        failures.append("other_candidate_damaged")
    ofrac, odev = overlap_metrics(t, residual, SimpleNamespace(**candidate), others)
    if np.isfinite(odev) and odev > cfg.qa_overlap_dev_max:
        failures.append("overlap_distortion")
    mean, wz = window_offset(t, residual, p, ep, d)
    wrel = mean / (candidate["depth_ppm"] / 1e6)
    if not np.isfinite(ee) or not np.isfinite(wz):
        failures.append("qa_not_measurable")
    if np.isfinite(wz) and abs(wz) > cfg.qa_window_offset_z_max:
        if not (np.isfinite(wrel) and abs(wrel) <= cfg.qa_window_offset_rel_depth):
            failures.append("window_offset")
    return dict(power_before=before, power_after=after, power_ratio=ratio, edge_excess=ee,
                other_depth_log2_max=other_log2, overlap_fraction=ofrac, overlap_dev=odev,
                window_offset_z=wz, window_offset_rel=wrel, window_offset_reference="unity",
                window_offset_unity_z=wz, window_offset_unity_rel=wrel,
                n_valid_input=removal.n_valid_input, n_finite_residual=removal.n_finite_residual,
                qa_failures=",".join(failures))


def iterate_bls(time, flux, *, input_snapshot_id, preprocessing_version,
                sector=None, baseline_time=None, keep_residual=False, initial_search=None):
    """Iterate frozen 120 search and 121 removal with approved 111 QA.

    Invalid contracts raise BlsError. Numerical/QA failures return status=failed
    with prior candidates and residual preserved. A safety-cap exit is incomplete.
    The default result is strict JSON. keep_residual adds an ndarray for runtime
    verification only; callers must not persist that array in candidate payloads.
    transit_model deliberately has no catalog ID until identity reconciliation.
    initial_search is the in-memory search_bls result for these exact inputs.
    """
    t, f = _vector(time, "time"), _vector(flux, "flux")
    if len(t) != len(f) or not np.isfinite(t).all() or np.any(np.diff(t) < 0):
        raise BlsError("invalid_input", "aligned arrays and finite ascending time required")
    if any(not isinstance(v, str) or not v.strip() for v in (input_snapshot_id, preprocessing_version)):
        raise BlsError("invalid_input", "input and preprocessing versions required")
    if sector is not None:
        sector = _vector(sector, "sector")
        if (len(sector) != len(t) or not np.isfinite(sector).all() or
                np.any(sector <= 0) or np.any(sector != np.floor(sector))):
            raise BlsError("invalid_input", "aligned positive integer sectors required")
    if baseline_time is not None:
        baseline_time = _vector(baseline_time, "baseline_time")
        if not np.isfinite(baseline_time).all():
            raise BlsError("invalid_input", "finite baseline times required")
        times, counts = np.unique(t, return_counts=True)
        raw, raw_counts = np.unique(baseline_time, return_counts=True)
        positions = np.searchsorted(raw, times)
        if (np.any(positions >= len(raw)) or not np.array_equal(raw[positions], times) or
                np.any(raw_counts[positions] < counts)):
            raise BlsError("invalid_input", "baseline must contain every input observation")
    if initial_search is not None:
        expected = dict(input_snapshot_id=input_snapshot_id, preprocessing_version=preprocessing_version,
                        bls_config_version=SEARCH_VERSION, candidate_quality_version=QUALITY_VERSION,
                        search_input_sha256=_search_input_sha256(t, f, sector, baseline_time),
                        n_input=len(t), n_valid=int(np.isfinite(f).sum()))
        if (not isinstance(initial_search, Mapping) or
                any(initial_search.get(key) != value for key, value in expected.items()) or
                initial_search.get("status") not in ("ok", "no_quality_peak", "failed") or
                not isinstance(initial_search.get("peaks"), list) or
                not hasattr(initial_search.get("periodogram"), "config")):
            raise BlsError("invalid_input", "initial search does not match the iteration input")
    cfg = _CONFIG
    current, accepted, steps = f.copy(), [], []
    termination, qa_failed_step = "", -1
    for step in range(cfg.max_candidates + 1):
        ok = np.isfinite(current)
        terminal = dict(step=step, n_points=int(ok.sum()))
        if np.isinf(current).any():
            termination = "numerical_failure"
        elif ok.sum() < cfg.min_points:
            termination = "insufficient_observations"
        elif step == cfg.max_candidates:
            termination = "max_iterations_reached"
        else:
            termination = ""
        if termination:
            steps.append(dict(**terminal, status="terminated", reason=termination))
            break
        try:
            run = initial_search if step == 0 and initial_search is not None else search_bls(
                t, current, input_snapshot_id=input_snapshot_id,
                preprocessing_version=preprocessing_version, sector=sector, baseline_time=baseline_time)
            if run["status"] == "failed":
                raise BlsError("numerical_failure", "search returned a failed peak")
            config = run["periodogram"].config
            setting = SimpleNamespace(period_min_days=config["period_min_days"],
                effective_durations_hours=config["durations_hours"], objective="likelihood", oversample=10)
            grid = SimpleNamespace(period_min_days=config["period_min_days"],
                period_max_days=config["period_max_days"], n_periods=config["n_periods"])
            chosen, diagnostic = None, None
            prior = [SimpleNamespace(**c) for c in accepted]
            for item in run["peaks"]:
                coarse = SimpleNamespace(**item, poc_snr=float("nan"))
                duplicate = is_duplicate(coarse.period_days, coarse.duration_hours / 24,
                                         coarse.n_transits, prior, cfg.alias_multipliers)
                peak = coarse
                if duplicate < 0:
                    peak = refine_peak(t[ok], current[ok], coarse, setting, grid, cfg)
                    duplicate = is_duplicate(peak.period_days, peak.duration_hours / 24,
                                             peak.n_transits, prior, cfg.alias_multipliers)
                if duplicate >= 0:
                    steps.append(dict(**terminal, status="rejected_duplicate", reason="",
                        rank=peak.rank, period_days=peak.period_days, epoch_btjd=peak.epoch_btjd,
                        duration_hours=peak.duration_hours, depth_ppm=peak.depth * 1e6,
                        sde=peak.sde, snr=peak.snr, n_transits=peak.n_transits,
                        duplicate_of_step=duplicate, period_coarse_days=coarse.period_days))
                    continue
                chosen, diagnostic = peak, item
                break
        except Exception as exc:
            termination = "insufficient_observations" if isinstance(exc, BlsError) and exc.code == "insufficient_observations" else "numerical_failure"
            steps.append(dict(**terminal, status="error", reason=termination, error_type=type(exc).__name__))
            break
        if chosen is None:
            termination = "duplicate_or_harmonic_only" if run["peaks"] else "no_quality_peak"
            steps.append(dict(**terminal, status="terminated", reason=termination))
            break
        c = dict(step=step, peak_id=f"step-{step}", rank=chosen.rank,
                 period_days=chosen.period_days, epoch_btjd=chosen.epoch_btjd,
                 duration_hours=chosen.duration_hours, depth_ppm=chosen.depth * 1e6,
                 sde=chosen.sde, snr=chosen.snr, n_transits=chosen.n_transits, bls_power=float(chosen.power))
        base = {key: value for key, value in c.items() if key not in ("peak_id", "bls_power")}
        base.update(n_points=int(ok.sum()))
        if not (np.isfinite([chosen.period_days, chosen.epoch_btjd, chosen.duration_hours,
                            chosen.depth, chosen.depth_err, chosen.snr, chosen.sde, chosen.power]).all()
                and chosen.depth_err > 0
                and not isinstance(chosen.n_transits, bool)
                and isinstance(chosen.n_transits, (int, np.integer)) and chosen.n_transits >= 0
                and chosen.period_days > 0 and 0 < chosen.depth < 1
                and 0 < chosen.duration_hours / 24 < chosen.period_days):
            termination = "candidate_validation_failed"
            steps.append(dict(**base, status="error", reason=termination))
            break
        if not (chosen.snr >= cfg.snr_min and chosen.sde >= cfg.sde_min
                and chosen.n_transits >= cfg.min_transits
                and chosen.duration_hours / 24 <= cfg.max_duration_fraction * chosen.period_days):
            termination = "no_quality_peak"
            steps.append(dict(**base, status="rejected_gate", reason=termination))
            break
        base["period_coarse_days"] = diagnostic["period_days"]
        try:
            removal = remove_transit_models(t, current, [_model(c)])
            residual = np.asarray(removal.flux_residual, float)
            qa = _qa(t, f, current, residual, c, accepted, removal, cfg)
        except Exception as exc:
            termination = "numerical_failure"
            steps.append(dict(**base, status="error", reason=termination, error_type=type(exc).__name__))
            break
        failed = bool(qa["qa_failures"])
        steps.append(dict(**base, **qa, status="qa_failed" if failed else "accepted",
                          reason="removal_qa_failed" if failed else ""))
        if failed:
            termination, qa_failed_step = "removal_qa_failed", step
            break
        c["transit_model"] = _model(c)
        c["search_diagnostics"] = {key: diagnostic[key] for key in (
            "period_days", "epoch_btjd", "duration_hours", "sector_stats", "sector_consistency_status",
            "mask_dropped_fraction", "diagnostic_reasons")}
        accepted.append(c)
        current = residual
    valid_original = np.isfinite(f)
    for c in accepted:
        try:
            score = fixed_snr(t[valid_original], f[valid_original], c["period_days"],
                              c["duration_hours"] / 24, c["epoch_btjd"])
        except Exception:
            score = float("nan")
        c["original_snr"] = score
        c["validated_on_original"] = bool(np.isfinite(score) and score >= cfg.snr_min)
    if accepted and not all(c["validated_on_original"] for c in accepted) and termination in (
            "no_quality_peak", "duplicate_or_harmonic_only", "max_iterations_reached"):
        search_termination = termination
        termination = "candidate_validation_failed"
        steps.append(dict(step=len(accepted), status="error", reason=termination,
                          phase="original_validation", search_termination=search_termination,
                          failed_candidate_steps=[c["step"] for c in accepted
                                                  if not c["validated_on_original"]],
                          n_points=int(valid_original.sum())))
    # Stable step fields keep absent measurements explicit, never NaN in JSON.
    defaults = dict(rank=0, n_transits=0, n_points=0, duplicate_of_step=-1,
                    window_offset_reference="unity", masked_points=0,
                    n_valid_input=0, n_finite_residual=0, qa_failures="")
    defaults.update({key: None for key in (
        "period_days", "epoch_btjd", "duration_hours", "depth_ppm", "sde", "snr",
        "period_coarse_days", "power_before", "power_after", "power_ratio", "edge_excess",
        "other_depth_log2_max", "overlap_fraction", "overlap_dev", "window_offset_z",
        "window_offset_rel", "window_offset_unity_z", "window_offset_unity_rel", "bls_elapsed_s")})
    steps = [{**defaults, **record} for record in steps]
    complete = termination in ("no_quality_peak", "duplicate_or_harmonic_only")
    config = _json_safe(asdict(cfg))
    config.update(qa_window_offset_reference="unity", continue_after_qa_fail=False,
                  qa_require_measurable=True, refine_peak=True)
    fingerprint = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    result = _json_safe(dict(status="ok" if complete else "incomplete" if termination == "max_iterations_reached" else "failed",
        termination=termination, complete=complete, steps=steps, accepted=accepted,
        n_accepted=len(accepted), qa_failed_step=qa_failed_step,
        input_snapshot_id=input_snapshot_id, preprocessing_version=preprocessing_version,
        iteration_version=ITERATION_VERSION, iteration_config=config, iteration_config_sha256=fingerprint,
        bls_config_version=SEARCH_VERSION, candidate_quality_version=QUALITY_VERSION,
        residual_model_version="box-divide-v0", time_start_btjd=float(t[0]) if len(t) else None,
        time_end_btjd=float(t[-1]) if len(t) else None))
    if keep_residual:
        result["residual"] = current.copy()
    return result

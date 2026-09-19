# -*- coding: utf-8 -*-
"""반복 BLS·고정 모델 제거 루프의 종료·제거 QA·복구 벤치마크 (S15P21C206-111, D05-1).

후보 검출 설계 5.6절 "Silver 내부 반복 BLS와 처리 종료 — v1.0" 의 루프를 fixture 곡선에서 그대로 돌리고 단계마다 기록한다.

    현재 곡선 BLS → 채택 후보의 중복·고조파가 아닌 최강 피크 → 게이트 → box transit_model 로 나눔(astro-kernel)
    → 제거 QA(power 감소·경계 돌출·다른 후보 훼손·겹친 transit·유한성) → 통과면 채택 후 잔차로 반복, 실패면 직전 단계로 복구

종료 사유는 설계 문서의 7종을 그대로 쓴다: no_quality_peak, insufficient_observations, duplicate_or_harmonic_only,
removal_qa_failed, candidate_validation_failed, numerical_failure, max_iterations_reached.
QA 문턱은 잠정값이며 원시 수치를 모두 저장해 문서에서 분포를 보고 다시 정한다. 고조파 병합의 정식 규칙은 112 가 정한다.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field, fields

import numpy as np

from astro_kernel import remove_transit_models
from tess_fixture import inject as inj

from . import bls as bl
from . import bls_match as bm

TERMINATION_REASONS = ("no_quality_peak", "insufficient_observations", "duplicate_or_harmonic_only", "removal_qa_failed",
                       "candidate_validation_failed", "numerical_failure", "max_iterations_reached")


@dataclass(frozen=True)
class IterateConfig:
    """루프 잠정 설정. 값은 manifest 에 기록되고 문서 5절에서 재검토한다."""
    snr_min: float = 7.0
    sde_min: float = 6.0
    min_transits: int = 2
    max_candidates: int = 5                     # 안전 상한 (max_iterations_reached)
    refine_peak: bool = True                    # 제거 전 피크 주위 국소 격자로 주기·epoch·지속시간 재적합 (설계 5.6 '모델을 적합해')
    refine_span_grid_steps: float = 2.0         # 탐색 격자 간격의 ± 배수
    refine_n: int = 201
    min_points: int = 100                       # 이보다 적으면 insufficient_observations
    alias_multipliers: tuple[float, ...] = (0.5, 1.0, 2.0)   # 중복·고조파 임시 규칙 (112 에서 정식 규칙으로 교체)
    local_grid_rel: float = 0.02                # power 감소 측정용 국소 격자 ±폭
    local_grid_n: int = 201
    qa_power_ratio_max: float = 0.5             # 제거 뒤/전 국소 최대 power 비. 이보다 크면 제거가 신호를 지우지 못한 것
    qa_edge_excess_max: float = 1.5             # 통과 창 가장자리 띠 |r-1| 중앙값 / 바깥 robust scatter. 잡음만 남으면 약 0.67
    qa_other_depth_log2_max: float = 1.0        # 다른 후보 깊이의 제거 전/후 |log2 비| 상한 (2배 이상 변하면 훼손)
    qa_overlap_dev_max: float = 3.0             # 겹친 점들의 잔차 편차 중앙값 / scatter
    qa_window_offset_z_max: float = 5.0         # 제거 뒤 통과 창 안 잔차 평균의 z 점수 |mean(r−1)| / (scatter/√n). 과대 제거(밝아짐)·과소 제거(어둠 잔존) 모두 잡는다
    qa_window_offset_rel_depth: float = 0.0     # >0 이면 |창 안 평균 편차| ≤ rel × 제거 깊이 일 때 z 초과여도 통과 (깊은 신호의 정당한 제거 보호). 0 은 z 만 적용(5절 실행값)
    qa_window_offset_reference: str = "unity"   # unity: 기존 기준 1, oot: 바깥 평균과 비교하는 실험 옵션
    refine_duration_span: tuple[float, float] = (0.7, 1.4)   # 재적합 지속시간 탐색 배수 (5절 실행값). 확대 안: (0.5, 2.0)
    refine_duration_max_hours: float = 0.0      # >0 이면 재적합 지속시간 상한을 max(span[1]×D₀, 이 값) 으로 넓힌다 (탐색 격자 4.8 h 상한 보정). 0 은 비활성
    continue_after_qa_fail: bool = False        # True 면 QA 실패 피크를 '제거 불가' 로 기록·제외하고 계속 탐색 (설계 변경 제안). False 는 5.6 v1.0 대로 종료
    blocked_mask_factor: float = 1.5            # continue_after_qa_fail: 제거 불가 피크의 통과 창(지속시간 × 이 배수)을 NaN 으로 가려 다음 탐색에서 숨긴다. 나누기 대신 마스킹
    max_duration_fraction: float = 0.35         # 재적합·게이트에서 허용하는 지속시간/주기 상한. 주입 격자의 8 h/1 d(0.33)는 허용하고, 하위 고조파 잔여가 주기의 절반 넘는 폭(0.65)으로 맞춰지는 것을 막는다
    qa_require_measurable: bool = True          # 경계 돌출·창 안 편향을 잴 수 없으면(바깥 구간 없음) QA 실패로 본다

    def __post_init__(self):
        if self.qa_window_offset_reference not in ("unity", "oot"):
            raise ValueError("qa_window_offset_reference must be unity or oot")

    def params(self) -> dict:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items()}


@dataclass
class Candidate:
    step: int
    period_days: float
    epoch_btjd: float
    duration_hours: float
    depth_ppm: float
    sde: float
    snr: float
    n_transits: int
    rank: int
    validated_on_original: bool | None = None   # 루프 뒤 원본 정제곡선 재평가 (candidate_validation_failed)
    original_snr: float = float("nan")

    def model(self, candidate_id: str) -> dict:
        return {"shape": "box", "candidate_id": candidate_id,
                "parameters": {"period_days": self.period_days, "epoch_btjd": self.epoch_btjd,
                               "duration_hours": self.duration_hours, "depth_ppm": self.depth_ppm}}

    def as_peak(self) -> bl.Peak:
        return bl.Peak(rank=self.step + 1, period_days=self.period_days, epoch_btjd=self.epoch_btjd, duration_hours=self.duration_hours,
                       depth=self.depth_ppm / 1e6, depth_err=float("nan"), power=float("nan"), log_likelihood=float("nan"),
                       sde=self.sde, snr=self.snr, poc_snr=float("nan"), n_transits=self.n_transits, n_in_transit=0,
                       mask_dropped_fraction=float("nan"))


@dataclass
class StepRecord:
    step: int
    status: str                      # accepted | rejected_gate | rejected_duplicate | qa_failed | error | terminated
    reason: str                      # 종료 사유 또는 빈 문자열
    rank: int = 0
    period_days: float = float("nan")
    epoch_btjd: float = float("nan")
    duration_hours: float = float("nan")
    depth_ppm: float = float("nan")
    sde: float = float("nan")
    snr: float = float("nan")
    n_transits: int = 0
    n_points: int = 0
    duplicate_of_step: int = -1
    period_coarse_days: float = float("nan")     # 미세 조정 전 탐색 격자 주기
    power_before: float = float("nan")
    power_after: float = float("nan")
    power_ratio: float = float("nan")
    edge_excess: float = float("nan")
    other_depth_log2_max: float = float("nan")    # 채택 후보 + 남은 정답 신호의 깊이 변화 중 최대 |log2|
    overlap_fraction: float = float("nan")
    overlap_dev: float = float("nan")
    window_offset_z: float = float("nan")        # 통과 창 안 잔차 평균 z 점수 (양수 = 과대 제거로 밝아짐)
    window_offset_rel: float = float("nan")      # 통과 창 안 잔차 평균 편차 / 제거 깊이
    window_offset_reference: str = "unity"      # 위 z·rel의 판정 기준; manifest에도 기록
    window_offset_unity_z: float = float("nan")  # 기준 1 대비 기존 z (oot 모드에서도 비교용 보존)
    window_offset_unity_rel: float = float("nan")
    masked_points: int = 0           # continue_after_qa_fail 로 이 단계에서 가린 점 수
    n_valid_input: int = 0
    n_finite_residual: int = 0
    qa_failures: str = ""            # 실패한 QA 항목 이름 (콤마)
    bls_elapsed_s: float = float("nan")

    def as_row(self) -> dict:
        return asdict(self)


STEP_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(StepRecord))


# --------------------------------------------------------------------------- 보조 계산

def robust_scatter(x: np.ndarray) -> float:
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if x.size else float("nan")


def is_duplicate(period: float, duration_days: float, n_transits: int, accepted: list[Candidate], multipliers) -> int:
    """SRS 5.1 누적 오차 규칙 |P − m·Pc| × N ≤ D/2 (m ∈ multipliers) 로 채택 후보의 중복·고조파인지. 맞으면 그 후보 step, 아니면 -1.

    D 는 피크와 채택 후보 지속시간 중 큰 값. 제거 잔여 피크는 진입·이탈 띠만 남아 지속시간이 짧게 잡히므로 피크 D 만 쓰면 놓친다.
    """
    for c in accepted:
        tol = 0.5 * max(duration_days, c.duration_hours / 24.0) / max(int(n_transits), 1)
        for m in multipliers:
            if abs(period - m * c.period_days) <= tol:
                return c.step
    return -1


def refine_peak(t: np.ndarray, f: np.ndarray, peak: bl.Peak, setting: bl.BlsSetting, run: bl.BlsRun, cfg: IterateConfig) -> bl.Peak:
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
    n_tr, n_in, _ = bl.transit_stats(t, P, ep, D)
    return bl.Peak(rank=peak.rank, period_days=P, epoch_btjd=ep, duration_hours=D * 24.0, depth=dep, depth_err=float(res.depth_err[i]),
                   power=float(power[i]), log_likelihood=float(res.log_likelihood[i]), sde=peak.sde, snr=float(res.depth_snr[i]),
                   poc_snr=peak.poc_snr, n_transits=n_tr, n_in_transit=n_in, mask_dropped_fraction=peak.mask_dropped_fraction)


def local_max_power(t: np.ndarray, f: np.ndarray, period: float, duration_days: float, cfg: IterateConfig) -> float:
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
    return np.abs(bl._phase_distance(t, period, epoch)) < 0.5 * duration_days


def edge_excess(t: np.ndarray, residual: np.ndarray, period: float, epoch: float, duration_days: float) -> float:
    """제거 뒤 잔차에서 통과 창 가장자리 띠(D/2 ≤ |φ| < D)의 |r−1| 중앙값을 바깥(|φ| ≥ D) robust scatter 로 나눈 값.

    box 모델과 실제 파형의 진입·이탈 차이가 남으면 이 띠에 편차가 몰린다. 잡음만 남으면 약 0.67(정규분포 |x| 중앙값).
    """
    phase = np.abs(bl._phase_distance(t, period, epoch))
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
    phase = np.abs(bl._phase_distance(t, period, epoch))
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


def overlap_metrics(t: np.ndarray, residual: np.ndarray, removed: Candidate, others: list[tuple[float, float, float]]) -> tuple[float, float]:
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
    return frac, float(np.median(np.abs(residual[both] - 1.0)) / scatter) if scatter > 0 else (frac, float("nan"))


# --------------------------------------------------------------------------- 루프

@dataclass
class IterationResult:
    steps: list[StepRecord]
    accepted: list[Candidate]         # QA 통과·복구 뒤 최종 채택 (validation 실패 후보도 포함, 플래그로 구분)
    termination: str
    qa_failed_step: int = -1
    residual: np.ndarray | None = None
    n_blocked: int = 0                # continue_after_qa_fail 로 제외된 피크 수


def iterate_curve(t: np.ndarray, f: np.ndarray, setting: bl.BlsSetting, cfg: IterateConfig, *,
                  truth: list[tuple[float, float, float]] | None = None, tamper_depth_factor: float | None = None,
                  keep_residual: bool = False) -> IterationResult:
    """전처리된 곡선 하나에 반복 제거 루프를 돈다.

    truth: 벤치마크용 정답 신호 (P, epoch, D_days) 목록 — 아직 제거되지 않은 정답 신호의 깊이 훼손을 측정한다(운영에는 없음).
    tamper_depth_factor: 실패 사례 fixture — 1단계 제거 모델의 깊이에 이 배수를 곱해 QA 실패를 유도한다.
    """
    t = np.asarray(t, float); f = np.asarray(f, float)
    steps: list[StepRecord] = []
    accepted: list[Candidate] = []
    blocked: list[Candidate] = []          # continue_after_qa_fail: 제거 불가로 기록된 피크 (중복 판정처럼 제외)
    current = f.copy()
    truth = list(truth or [])
    termination = ""
    qa_failed_step = -1
    for step in range(cfg.max_candidates + 1):
        ok = np.isfinite(current)
        if ok.sum() < cfg.min_points:
            steps.append(StepRecord(step, "terminated", "insufficient_observations", n_points=int(ok.sum()))); termination = "insufficient_observations"; break
        if step == cfg.max_candidates:
            steps.append(StepRecord(step, "terminated", "max_iterations_reached", n_points=int(ok.sum()))); termination = "max_iterations_reached"; break
        try:
            run = bl.run_bls(t[ok], current[ok], setting, baseline_time=t)
        except ValueError as exc:                                    # 퇴화 입력·격자 오류
            steps.append(StepRecord(step, "error", "numerical_failure", n_points=int(ok.sum()), qa_failures=str(exc)[:80])); termination = "numerical_failure"; break
        except Exception as exc:                                     # astropy 내부 실패
            steps.append(StepRecord(step, "error", "numerical_failure", n_points=int(ok.sum()), qa_failures=f"{type(exc).__name__}: {exc}"[:80])); termination = "numerical_failure"; break

        chosen = None
        coarse_period = float("nan")
        for p in run.peaks:
            dup = is_duplicate(p.period_days, p.duration_hours / 24.0, p.n_transits, accepted, cfg.alias_multipliers)
            blk = is_duplicate(p.period_days, p.duration_hours / 24.0, p.n_transits, blocked, cfg.alias_multipliers) if blocked else -1
            refined = p
            if dup < 0 and blk < 0 and cfg.refine_peak:
                refined = refine_peak(t[ok], current[ok], p, setting, run, cfg)      # 미세 조정 뒤 다시 중복 검사 (격자 오차로 빠져나가는 잔여 방지)
                dup = is_duplicate(refined.period_days, refined.duration_hours / 24.0, refined.n_transits, accepted, cfg.alias_multipliers)
                blk = is_duplicate(refined.period_days, refined.duration_hours / 24.0, refined.n_transits, blocked, cfg.alias_multipliers) if blocked else -1
            if dup >= 0 or blk >= 0:
                steps.append(StepRecord(step, "rejected_duplicate" if dup >= 0 else "rejected_blocked", "", rank=p.rank, period_days=refined.period_days, epoch_btjd=refined.epoch_btjd,
                                        duration_hours=refined.duration_hours, depth_ppm=refined.depth * 1e6, sde=p.sde, snr=refined.snr, n_transits=refined.n_transits,
                                        n_points=int(ok.sum()), duplicate_of_step=dup if dup >= 0 else blk, period_coarse_days=p.period_days, bls_elapsed_s=run.elapsed_s))
                continue
            chosen, coarse_period = refined, p.period_days; break
        if chosen is None:
            steps.append(StepRecord(step, "terminated", "duplicate_or_harmonic_only", n_points=int(ok.sum()), bls_elapsed_s=run.elapsed_s)); termination = "duplicate_or_harmonic_only"; break

        base = dict(rank=chosen.rank, period_days=chosen.period_days, epoch_btjd=chosen.epoch_btjd, duration_hours=chosen.duration_hours,
                    depth_ppm=chosen.depth * 1e6, sde=chosen.sde, snr=chosen.snr, n_transits=chosen.n_transits, n_points=int(ok.sum()), bls_elapsed_s=run.elapsed_s)
        passes = (np.isfinite(chosen.snr) and chosen.snr >= cfg.snr_min and np.isfinite(chosen.sde) and chosen.sde >= cfg.sde_min
                  and chosen.n_transits >= cfg.min_transits and chosen.depth > 0
                  and chosen.duration_hours / 24.0 <= cfg.max_duration_fraction * chosen.period_days)
        if not passes:
            steps.append(StepRecord(step, "rejected_gate", "no_quality_peak", **base)); termination = "no_quality_peak"; break

        base["period_coarse_days"] = coarse_period
        cand = Candidate(step=step, period_days=chosen.period_days, epoch_btjd=chosen.epoch_btjd, duration_hours=chosen.duration_hours,
                         depth_ppm=chosen.depth * 1e6, sde=chosen.sde, snr=chosen.snr, n_transits=chosen.n_transits, rank=chosen.rank)
        model_cand = cand
        if tamper_depth_factor is not None and step == 0:
            model_cand = Candidate(**{**asdict(cand), "depth_ppm": cand.depth_ppm * tamper_depth_factor})
        D = cand.duration_hours / 24.0

        # ---- 제거 전 측정
        # 다른 후보 훼손은 두 갈래로 잰다. (1) 이미 채택(제거)한 후보: 원본 정제곡선에서 그 후보의 깊이가, 이번 모델 하나만 나눈 원본에서
        # 얼마나 바뀌는지 (운영에서도 가능). (2) 아직 제거되지 않은 정답 신호(벤치마크 전용): 현재 곡선 → 잔차에서 깊이 변화.
        power_before = local_max_power(t[ok], current[ok], cand.period_days, D, cfg)
        others = [(c.period_days, c.epoch_btjd, c.duration_hours / 24.0) for c in accepted]
        remaining_truth = [tr for tr in truth if is_duplicate(tr[0], tr[2], max(cand.n_transits, 1), [cand], cfg.alias_multipliers) < 0]
        ok0 = np.isfinite(f)
        depth_before = [fixed_depth(t[ok0], f[ok0], P, Dd, ep) for (P, ep, Dd) in others] +                        [fixed_depth(t[ok], current[ok], P, Dd, ep) for (P, ep, Dd) in remaining_truth]

        # ---- 제거
        try:
            rem = remove_transit_models(t, current, [model_cand.model(f"c-{step}")])
        except Exception as exc:
            steps.append(StepRecord(step, "error", "numerical_failure", qa_failures=f"{type(exc).__name__}"[:80], **base)); termination = "numerical_failure"; break
        residual = np.asarray(rem.flux_residual, float)
        ok_r = np.isfinite(residual)

        # ---- 제거 QA
        failures = []
        if rem.n_finite_residual != rem.n_valid_input:
            failures.append("non_finite")
        power_after = local_max_power(t[ok_r], residual[ok_r], cand.period_days, D, cfg) if ok_r.sum() >= cfg.min_points else float("nan")
        power_ratio = power_after / power_before if np.isfinite(power_before) and power_before > 0 else float("nan")
        if not (np.isfinite(power_ratio) and power_ratio <= cfg.qa_power_ratio_max):
            failures.append("power_not_reduced")
        ee = edge_excess(t, residual, cand.period_days, cand.epoch_btjd, D)
        if np.isfinite(ee) and ee > cfg.qa_edge_excess_max:
            failures.append("edge_excess")
        depth_after: list[float] = []
        if ok_r.sum() >= cfg.min_points:
            if others:
                r0 = np.asarray(remove_transit_models(t, f, [model_cand.model(f"c-{step}")]).flux_residual, float); ok0r = np.isfinite(r0)
                depth_after += [fixed_depth(t[ok0r], r0[ok0r], P, Dd, ep) for (P, ep, Dd) in others]
            depth_after += [fixed_depth(t[ok_r], residual[ok_r], P, Dd, ep) for (P, ep, Dd) in remaining_truth]
        log2s = [abs(np.log2(a / b)) for a, b in zip(depth_after, depth_before) if np.isfinite(a) and np.isfinite(b) and a > 0 and b > 0]
        other_log2 = max(log2s) if log2s else float("nan")
        if np.isfinite(other_log2) and other_log2 > cfg.qa_other_depth_log2_max:
            failures.append("other_candidate_damaged")
        ofrac, odev = overlap_metrics(t, residual, cand, others + remaining_truth)
        if np.isfinite(odev) and odev > cfg.qa_overlap_dev_max:
            failures.append("overlap_distortion")
        unity_mean, unity_z = window_offset(t, residual, cand.period_days, cand.epoch_btjd, D)
        wmean, wz = (window_offset(t, residual, cand.period_days, cand.epoch_btjd, D, reference="oot")
                     if cfg.qa_window_offset_reference == "oot" else (unity_mean, unity_z))
        if cfg.qa_require_measurable and (not np.isfinite(ee) or not np.isfinite(wz)):
            failures.append("qa_not_measurable")                          # 통과 창 바깥 구간이 없어 경계·편향을 잴 수 없다
        wrel = wmean / (model_cand.depth_ppm / 1e6) if np.isfinite(wmean) and model_cand.depth_ppm > 0 else float("nan")
        unity_rel = unity_mean / (model_cand.depth_ppm / 1e6) if np.isfinite(unity_mean) and model_cand.depth_ppm > 0 else float("nan")
        if np.isfinite(wz) and abs(wz) > cfg.qa_window_offset_z_max:
            if not (cfg.qa_window_offset_rel_depth > 0 and np.isfinite(wrel) and abs(wrel) <= cfg.qa_window_offset_rel_depth):
                failures.append("window_offset")                            # z 초과이고 깊이 상대 허용도 없으면 실패

        rec = StepRecord(step, "accepted" if not failures else "qa_failed", "" if not failures else "removal_qa_failed",
                         power_before=power_before, power_after=power_after, power_ratio=power_ratio, edge_excess=ee,
                         other_depth_log2_max=other_log2, overlap_fraction=ofrac, overlap_dev=odev, window_offset_z=wz, window_offset_rel=wrel,
                         window_offset_reference=cfg.qa_window_offset_reference,
                         window_offset_unity_z=unity_z, window_offset_unity_rel=unity_rel,
                         n_valid_input=rem.n_valid_input, n_finite_residual=rem.n_finite_residual, qa_failures=",".join(failures), **base)
        steps.append(rec)
        if failures:
            if qa_failed_step < 0:
                qa_failed_step = step
            if not cfg.continue_after_qa_fail:
                termination = "removal_qa_failed"
                break                                                   # 복구: accepted 는 직전 단계까지, current 는 갱신하지 않음
            blocked.append(cand)                                        # 제거 불가로 기록. 나누기 대신 통과 창을 가려(NaN) 다음 탐색에서 숨긴다
            hide = in_transit_mask(t, cand.period_days, cand.epoch_btjd, D * cfg.blocked_mask_factor) & np.isfinite(current)
            current = current.copy(); current[hide] = np.nan
            rec.masked_points = int(hide.sum())
            termination = "removal_qa_failed"                           # 뒤에서 다른 사유로 끝나면 덮어쓴다
            continue
        accepted.append(cand)
        current = residual

    # ---- 원본 정제곡선 재평가 (설계 5.6: 각 단계 후보는 공개 전에 원본에서 다시 검증)
    ok0 = np.isfinite(f)
    for c in accepted:
        c.original_snr = fixed_snr(t[ok0], f[ok0], c.period_days, c.duration_hours / 24.0, c.epoch_btjd)
        c.validated_on_original = bool(np.isfinite(c.original_snr) and c.original_snr >= cfg.snr_min)
    if accepted and not all(c.validated_on_original for c in accepted) and termination in ("no_quality_peak", "duplicate_or_harmonic_only", "max_iterations_reached"):
        termination = "candidate_validation_failed"
    return IterationResult(steps=steps, accepted=accepted, termination=termination, qa_failed_step=qa_failed_step,
                           residual=current if keep_residual else None, n_blocked=len(blocked))


# --------------------------------------------------------------------------- 정답 대조 (벤치마크)

def match_accepted(t: np.ndarray, rows: list[inj.InjectionRow], accepted: list[Candidate], *, window_overlap_min: float = 0.5) -> list[dict]:
    """주입 신호마다 어느 단계 후보가 직접/alias 로 맞는지. bls_match.match_injection 재사용."""
    out = []
    peaks = [c.as_peak() for c in accepted]
    for r in rows:
        m = bm.match_injection(t, r, peaks, window_overlap_min=window_overlap_min) if peaks else None
        step = -1
        if m is not None and m.match in ("direct", "alias_half", "alias_double") and m.matched_rank is not None:
            step = int(m.matched_rank) - 1
        out.append({"injection_id": r.injection_id, "period_days": r.period_days, "depth_ppm": r.depth_ppm, "duration_hours": r.duration_hours,
                    "match": m.match if m is not None else "missed", "recovered_step": step})
    return out


def summarize(result: IterationResult, matches: list[dict]) -> dict:
    recovered = [m for m in matches if m["recovered_step"] >= 0]
    matched_steps = {m["recovered_step"] for m in recovered}
    false_steps = [c.step for c in result.accepted if c.step not in matched_steps]
    return {"n_injected": len(matches), "n_recovered": len(recovered), "recovery_order": ";".join(str(m["recovered_step"]) for m in matches),
            "n_accepted": len(result.accepted), "n_false_candidates": len(false_steps), "false_candidate_steps": ";".join(map(str, false_steps)),
            "n_steps": len(result.steps), "termination": result.termination, "qa_failed_step": result.qa_failed_step, "n_blocked": result.n_blocked,
            "n_validation_failed": sum(1 for c in result.accepted if c.validated_on_original is False)}

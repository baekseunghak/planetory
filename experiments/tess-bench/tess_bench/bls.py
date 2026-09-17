# -*- coding: utf-8 -*-
"""BLS 탐색 격자·목적함수 설정과 실행, 상위 피크 추출 (S15P21C206-110).

설정(`configs/bls_settings_v1.json`)마다 주기 격자·duration 격자·목적함수가 다르다. 한 곡선에 한 설정을 실행하면
주기도 전체와 상위 K 개의 서로 다른 피크(period·epoch·duration·depth·power·SDE·SNR·통과 수)를 돌려준다.
품질 게이트는 여기서 적용하지 않고 저장한 피크에 오프라인으로 적용한다(`bls_match.gate_table`).
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

import numpy as np

SETTING_FIELDS = ("grid", "n_periods", "frequency_factor", "minimum_n_transit", "period_min_days", "period_max_rule",
                  "durations_hours", "objective", "oversample", "top_k", "peak_separation_rel")


@dataclass(frozen=True)
class BlsSetting:
    setting_id: str
    factor: str = "baseline"
    description: str = ""
    grid: str = "linear"                      # linear | autoperiod
    n_periods: int = 20000                    # linear 격자 점 수
    frequency_factor: float = 1.0             # autoperiod 간격 배수 (클수록 성김)
    minimum_n_transit: int = 3                # autoperiod 의 최대 주기 = baseline / minimum_n_transit
    period_min_days: float = 0.5
    period_max_rule: str = "baseline/3"       # baseline/<n> | fixed:<days>
    durations_hours: tuple[float, ...] = (1.2, 1.92, 2.88, 4.8)
    objective: str = "likelihood"             # likelihood | snr
    oversample: int = 10
    top_k: int = 5
    peak_separation_rel: float = 0.02         # 상위 피크를 '다른 피크' 로 볼 최소 상대 주기 간격

    def params(self) -> dict:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items() if k in SETTING_FIELDS}

    @property
    def durations_days(self) -> np.ndarray:
        return np.asarray(self.durations_hours, dtype=float) / 24.0

    def period_max(self, baseline_days: float) -> float:
        rule = self.period_max_rule
        if rule.startswith("baseline/"):
            return min(baseline_days / float(rule.split("/", 1)[1]), 100.0)
        if rule.startswith("fixed:"):
            return float(rule.split(":", 1)[1])
        raise ValueError(f"unknown period_max_rule {rule!r}")


def load_bls_settings(path: Path, only: list[str] | None = None) -> tuple[dict, list[BlsSetting]]:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    defaults = cfg.get("defaults", {})
    out: list[BlsSetting] = []
    for raw in cfg["settings"]:
        merged = {**defaults, **{k: v for k, v in raw.items() if k in SETTING_FIELDS}}
        if "durations_hours" in merged:
            merged["durations_hours"] = tuple(float(x) for x in merged["durations_hours"])
        s = BlsSetting(setting_id=raw["setting_id"], factor=raw.get("factor", "baseline"),
                       description=raw.get("description", ""), **merged)
        if s.grid not in ("linear", "autoperiod"):
            raise ValueError(f"{s.setting_id}: grid must be linear|autoperiod")
        if s.objective not in ("likelihood", "snr"):
            raise ValueError(f"{s.setting_id}: objective must be likelihood|snr")
        if s.period_min_days <= 0 or s.top_k < 1 or not s.durations_hours:
            raise ValueError(f"{s.setting_id}: invalid numeric fields")
        out.append(s)
    ids = [s.setting_id for s in out]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate setting_id")
    if only:
        missing = set(only) - set(ids)
        if missing:
            raise KeyError(f"unknown setting_id {sorted(missing)}")
        out = [s for s in out if s.setting_id in only]
    return cfg, out


# --------------------------------------------------------------------------- 격자·실행

def period_grid(setting: BlsSetting, time_days: np.ndarray, bls=None) -> np.ndarray:
    """설정과 곡선 기준선으로 주기 격자를 만든다. autoperiod 는 astropy 객체가 필요하다."""
    baseline = float(np.nanmax(time_days) - np.nanmin(time_days))
    pmax = setting.period_max(baseline)
    if pmax <= setting.period_min_days:
        raise ValueError(f"period range empty: [{setting.period_min_days}, {pmax}] (baseline {baseline:.2f} d)")
    if setting.grid == "linear":
        return np.linspace(setting.period_min_days, pmax, int(setting.n_periods))
    if bls is None:
        raise ValueError("autoperiod needs a BoxLeastSquares instance")
    return np.asarray(bls.autoperiod(setting.durations_days, minimum_period=setting.period_min_days,
                                     maximum_period=pmax, minimum_n_transit=setting.minimum_n_transit,
                                     frequency_factor=setting.frequency_factor))


@dataclass
class Peak:
    rank: int
    period_days: float
    epoch_btjd: float
    duration_hours: float
    depth: float                 # 상대 깊이 (astropy depth)
    depth_err: float
    power: float
    log_likelihood: float
    sde: float                   # (power - mean) / std of the whole periodogram
    snr: float                   # astropy depth_snr
    poc_snr: float               # PoC bls_features 식 (참고 열)
    n_transits: int              # 관측점이 있는 통과 회차 수
    n_in_transit: int            # 통과 창 안 유효 점 수
    mask_dropped_fraction: float  # 바탕곡선 기준 예상 통과 점 중 전처리에서 빠진 비율 (baseline_time 없으면 NaN)

    def as_row(self) -> dict:
        return asdict(self)


@dataclass
class BlsRun:
    setting_id: str
    n_periods: int
    period_min_days: float
    period_max_days: float
    elapsed_s: float
    power_mean: float
    power_std: float
    peaks: list[Peak] = field(default_factory=list)
    periods: np.ndarray | None = None
    power: np.ndarray | None = None


def _phase_distance(t: np.ndarray, period: float, epoch: float) -> np.ndarray:
    return (t - epoch + 0.5 * period) % period - 0.5 * period


def transit_stats(t: np.ndarray, period: float, epoch: float, duration_days: float) -> tuple[int, int, np.ndarray]:
    """(관측점이 있는 통과 회차 수, 통과 안 점 수, 통과 마스크)."""
    in_tr = np.abs(_phase_distance(t, period, epoch)) < 0.5 * duration_days
    if not in_tr.any():
        return 0, 0, in_tr
    cycles = np.floor((t[in_tr] - epoch) / period + 0.5).astype(int)
    return int(np.unique(cycles).size), int(in_tr.sum()), in_tr


def poc_snr(t: np.ndarray, f: np.ndarray, period: float, epoch: float, duration_days: float, depth: float) -> float:
    """PoC `bls_features` 의 수동 SNR 식. SDE 근거가 아니라 대조용."""
    phase = np.abs(_phase_distance(t, period, epoch))
    in_tr = phase < 0.5 * duration_days
    oot = (phase > duration_days) & (phase < 3 * duration_days)
    if oot.sum() > 20:
        scatter = 1.4826 * np.median(np.abs(f[oot] - np.median(f[oot])))
    else:
        scatter = float(np.std(f))
    if not (scatter > 0):
        return 0.0
    return float(depth / (scatter / np.sqrt(max(int(in_tr.sum()), 1))))


def select_top_peaks(periods: np.ndarray, power: np.ndarray, k: int, separation_rel: float) -> list[int]:
    """power 내림차순으로 훑되 이미 고른 피크와 상대 주기 차이가 separation_rel 미만인 점은 같은 봉우리로 본다."""
    order = np.argsort(power)[::-1]
    chosen: list[int] = []
    for i in order:
        if not np.isfinite(power[i]):
            continue
        if all(abs(periods[i] / periods[j] - 1.0) >= separation_rel for j in chosen):
            chosen.append(int(i))
        if len(chosen) >= k:
            break
    return chosen


def run_bls(t: np.ndarray, f: np.ndarray, setting: BlsSetting, *, baseline_time: np.ndarray | None = None,
            keep_periodogram: bool = False) -> BlsRun:
    """전처리된 곡선(NaN 제거) 하나에 설정 하나를 실행한다.

    baseline_time 을 주면 전처리 전 바탕곡선 시각에서 예상 통과 점 수를 세어 마스크로 빠진 비율을 계산한다.
    """
    from astropy.timeseries import BoxLeastSquares

    ok = np.isfinite(t) & np.isfinite(f)
    t, f = np.asarray(t, float)[ok], np.asarray(f, float)[ok]
    if t.size < 100:
        raise ValueError(f"too few points for BLS: {t.size}")
    # astropy 는 dy 가 없으면 단위 오차를 가정해 depth_snr 와 objective=snr 이 무의미해진다.
    # 정제곡선의 robust scatter(1.4826×MAD) 를 점마다 같은 오차로 넘긴다 (PDCSAP_FLUX_ERR 사용 여부는 5.6절 TBD).
    scatter = float(1.4826 * np.median(np.abs(f - np.median(f))))
    if not (np.isfinite(scatter) and scatter > 0):
        raise ValueError("degenerate flux: robust scatter is zero or non-finite")
    bls = BoxLeastSquares(t, f, dy=scatter)
    started = time.perf_counter()
    periods = period_grid(setting, t, bls)
    durations = setting.durations_days
    durations = durations[durations < setting.period_min_days]
    if durations.size == 0:
        raise ValueError(f"{setting.setting_id}: no duration shorter than period_min {setting.period_min_days} d")
    res = bls.power(periods, durations, objective=setting.objective, oversample=setting.oversample)
    elapsed = time.perf_counter() - started

    power = np.asarray(res.power, float)
    finite = np.isfinite(power)
    mean = float(np.mean(power[finite])) if finite.any() else float("nan")
    std = float(np.std(power[finite])) if finite.sum() > 1 else float("nan")

    peaks: list[Peak] = []
    for rank, i in enumerate(select_top_peaks(periods, power, setting.top_k, setting.peak_separation_rel), 1):
        P, ep, D, dep = float(res.period[i]), float(res.transit_time[i]), float(res.duration[i]), float(res.depth[i])
        n_tr, n_in, in_tr = transit_stats(t, P, ep, D)
        if baseline_time is not None:
            _, n_expected, _ = transit_stats(np.asarray(baseline_time, float), P, ep, D)
            dropped = float(1.0 - n_in / n_expected) if n_expected > 0 else float("nan")
        else:
            dropped = float("nan")
        sde = (power[i] - mean) / std if np.isfinite(std) and std > 0 else float("nan")
        peaks.append(Peak(rank=rank, period_days=P, epoch_btjd=ep, duration_hours=D * 24.0, depth=dep,
                          depth_err=float(res.depth_err[i]), power=float(power[i]),
                          log_likelihood=float(res.log_likelihood[i]), sde=float(sde), snr=float(res.depth_snr[i]),
                          poc_snr=poc_snr(t, f, P, ep, D, dep), n_transits=n_tr, n_in_transit=n_in,
                          mask_dropped_fraction=dropped))
    return BlsRun(setting_id=setting.setting_id, n_periods=int(periods.size), period_min_days=float(periods.min()),
                  period_max_days=float(periods.max()), elapsed_s=float(elapsed), power_mean=mean, power_std=std,
                  peaks=peaks, periods=periods if keep_periodogram else None, power=power if keep_periodogram else None)


PEAK_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(Peak))


# --------------------------------------------------------------------------- 알려진 신호 제거 (realclean 바탕곡선)

BJD_OFFSET = 2457000.0


def known_signal_models(reference_rows: list[dict], target_key: str) -> tuple[list[dict], list[dict]]:
    """references.csv 행에서 target 의 확인 통과 행성을 astro-kernel `transit_model` JSON 으로 만든다.

    tran_flag=1 이고 주기·통과 중심·지속시간·깊이가 모두 있는 행만 쓴다. (모델 목록, 제외한 행과 사유) 를 돌려준다.
    이 모델을 121 `remove_transit_models` 로 나눈 곡선이 `realclean` 바탕곡선이다. 실제 잡음·계통 오차는 남고
    알려진 행성 신호만 빠지므로 주입 신호 회수율을 잴 수 있다. 식쌍성처럼 Archive 행이 없는 별은 그대로 남는다.
    """
    models, skipped = [], []
    for row in reference_rows:
        if row.get("target_key") != target_key or not row.get("pl_name"):
            continue
        if str(row.get("tran_flag", "")).strip() != "1":
            skipped.append({"pl_name": row["pl_name"], "reason": "not_transiting"}); continue
        try:
            period = float(row["pl_orbper"]); tranmid = float(row["pl_tranmid"]); dur = float(row["pl_trandur"]); dep = float(row["pl_trandep"])
        except (KeyError, TypeError, ValueError):
            skipped.append({"pl_name": row["pl_name"], "reason": "missing_period_epoch_duration_or_depth"}); continue
        depth_ppm = dep * 1e4                       # pl_trandep 은 %
        if not (period > 0 and dur > 0 and dur / 24.0 < period and 0 < depth_ppm < 1e6):
            skipped.append({"pl_name": row["pl_name"], "reason": "invalid_geometry"}); continue
        models.append({"shape": "box", "candidate_id": row["pl_name"],
                       "parameters": {"period_days": period, "epoch_btjd": tranmid - BJD_OFFSET, "duration_hours": dur, "depth_ppm": depth_ppm}})
    return models, skipped

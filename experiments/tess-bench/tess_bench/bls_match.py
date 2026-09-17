# -*- coding: utf-8 -*-
"""주입 정답과 BLS 상위 피크의 매칭, 설정별 요약, 오프라인 품질 게이트 표 (S15P21C206-110).

매칭 규칙(갭 분석 5.7·SRS 5.1)
- direct: |P_peak − P_inj| × N_inj ≤ D_inj/2 이고 통과 창 중첩 ≥ window_overlap_min
- alias_half / alias_double: P_peak 를 2배 / 절반으로 환산한 뒤 같은 규칙
- wrong: 상위 피크가 있지만 어느 규칙도 만족하지 않음 (가장 가까운 피크의 원시 오차를 기록)
- missed: 피크 자체가 없음(퇴화)
판정과 무관하게 원시 오차를 항상 저장해 허용 오차를 바꿔도 재판정할 수 있다.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, fields

import numpy as np

from tess_fixture import inject as inj

from .bls import Peak, _phase_distance

ALIAS_MULTIPLIERS = {"alias_half": 0.5, "alias_double": 2.0}


@dataclass
class MatchResult:
    injection_id: str
    group_id: str
    match: str                      # direct | alias_half | alias_double | wrong | missed
    matched_rank: int | None
    period_rel_err: float           # (P_peak_eq − P_inj) / P_inj, P_peak_eq 는 alias 환산 후
    epoch_cyclic_err_hours: float   # 주입 t0 와 피크 epoch 의 순환 차이 (P_inj 기준)
    duration_ratio: float           # D_peak / D_inj
    depth_ratio: float              # depth_peak / depth_inj
    window_overlap: float           # 주입·피크 통과 창 교집합 점 수 / 두 창 집합 중 작은 쪽 점 수
    cumulative_err_over_half_dur: float   # |ΔP|×N_inj / (D_inj/2). 1 이하면 SRS 5.1 규칙 통과
    peak_power: float
    peak_sde: float
    peak_snr: float
    peak_n_transits: int

    def as_row(self) -> dict:
        return asdict(self)


MATCH_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(MatchResult))


def _raw_errors(t: np.ndarray, row: inj.InjectionRow, peak: Peak, multiplier: float) -> dict:
    """multiplier 로 환산한 피크 주기(P_peak / multiplier)를 주입 주기와 비교한 원시 오차."""
    p_eq = peak.period_days / multiplier
    d_inj = row.duration_hours / 24.0
    n_inj = max(int(row.n_transits_in_window), 1)
    dP = abs(p_eq - row.period_days)
    cyc = abs(_phase_distance(np.array([peak.epoch_btjd]), row.period_days, row.t0_btjd)[0]) * 24.0
    inj_mask = np.abs(_phase_distance(t, row.period_days, row.t0_btjd)) < 0.5 * d_inj
    peak_mask = np.abs(_phase_distance(t, peak.period_days, peak.epoch_btjd)) < 0.5 * (peak.duration_hours / 24.0)
    # 두 통과 창 집합 중 작은 쪽을 기준으로 한 중첩 비율. 2P alias 는 주입 창의 절반만 덮고 P/2 alias 는 주입 창을 모두
    # 덮으므로 한쪽 기준으로 재면 alias 판정이 비대칭이 된다. 작은 쪽 기준이면 direct·alias 모두 1 근처, 무관하면 0 근처.
    denom = min(int(inj_mask.sum()), int(peak_mask.sum()))
    overlap = float((inj_mask & peak_mask).sum() / denom) if denom > 0 else float("nan")
    return {"period_rel_err": (p_eq - row.period_days) / row.period_days, "epoch_cyclic_err_hours": float(cyc),
            "duration_ratio": (peak.duration_hours / 24.0) / d_inj,
            "depth_ratio": peak.depth / row.depth_ppm * 1e6 if row.depth_ppm else float("nan"),
            "window_overlap": overlap, "cumulative_err_over_half_dur": (dP * n_inj) / (0.5 * d_inj)}


def match_injection(t: np.ndarray, row: inj.InjectionRow, peaks: list[Peak], *, window_overlap_min: float = 0.5,
                    alias_multipliers: dict[str, float] = ALIAS_MULTIPLIERS) -> MatchResult:
    """주입 신호 하나를 상위 피크들과 대조한다. direct 를 alias 보다 우선하고, 같은 종류면 rank 가 높은 피크."""
    if not peaks:
        return MatchResult(row.injection_id, row.group_id, "missed", None, *([float("nan")] * 6), float("nan"), float("nan"), float("nan"), 0)
    candidates: list[tuple[int, str, Peak, dict]] = []   # (priority, kind, peak, errors)
    for peak in peaks:
        for kind, mult in (("direct", 1.0), *alias_multipliers.items()):
            e = _raw_errors(t, row, peak, mult)
            passes = e["cumulative_err_over_half_dur"] <= 1.0 and (np.isfinite(e["window_overlap"]) and e["window_overlap"] >= window_overlap_min)
            if passes:
                candidates.append((0 if kind == "direct" else 1, kind, peak, e))
    if candidates:
        candidates.sort(key=lambda c: (c[0], c[2].rank))
        _, kind, peak, e = candidates[0]
    else:
        # 가장 가까운 피크(직접 환산 기준 상대 주기 오차 최소)의 원시 오차를 남긴다
        kind = "wrong"
        peak = min(peaks, key=lambda p: abs(p.period_days / row.period_days - 1.0))
        e = _raw_errors(t, row, peak, 1.0)
    return MatchResult(row.injection_id, row.group_id, kind, peak.rank, e["period_rel_err"], e["epoch_cyclic_err_hours"],
                       e["duration_ratio"], e["depth_ratio"], e["window_overlap"], e["cumulative_err_over_half_dur"],
                       peak.power, peak.sde, peak.snr, peak.n_transits)


# --------------------------------------------------------------------------- 요약

def _bin_period(p: float) -> str:
    return "<2d" if p < 2 else ("2-10d" if p < 10 else ">=10d")


def _bin_duration(h: float) -> str:
    return "<1h" if h < 1 else ("1-4h" if h < 4 else ">=4h")


def _bin_depth(ppm: float) -> str:
    return "<=1000ppm" if ppm <= 1000 else ("<=3000ppm" if ppm <= 3000 else ">3000ppm")


def _truthy(v) -> bool:
    return str(v).lower() in ("true", "1", "yes")


def summarize_matches(rows: list[dict]) -> dict:
    """설정·바탕곡선 단위의 회수율 요약. rows 는 MatchResult.as_row() + 주입 행 정보(period_days 등)를 합친 dict.

    rows 에 `in_search_range`(주입 주기가 그 설정의 탐색 범위 안인가) 가 있으면 범위 안 신호만의 회수율도 낸다.
    관측 기간이 짧은 별에서는 20일 주입이 상한(기준선/3) 밖이라 어느 격자도 찾을 수 없으므로, 전체 회수율만 보면
    격자 성능과 범위 한계가 섞인다.
    """
    n = len(rows)
    if n == 0:
        return {"n_signals": 0}
    kinds = [r["match"] for r in rows]
    direct = kinds.count("direct")
    alias = kinds.count("alias_half") + kinds.count("alias_double")
    out = {"n_signals": n, "direct_recovery": direct / n, "alias_inclusive_recovery": (direct + alias) / n,
           "alias_recovery": alias / n, "wrong_rate": kinds.count("wrong") / n, "missed_rate": kinds.count("missed") / n}
    if any("in_search_range" in r for r in rows):
        inr = [r for r in rows if _truthy(r.get("in_search_range"))]
        d_in = sum(r["match"] == "direct" for r in inr); a_in = sum(r["match"].startswith("alias") for r in inr)
        out.update({"n_signals_in_range": len(inr),
                    "direct_recovery_in_range": d_in / len(inr) if inr else float("nan"),
                    "alias_inclusive_recovery_in_range": (d_in + a_in) / len(inr) if inr else float("nan")})
    matched = [r for r in rows if r["match"] in ("direct", "alias_half", "alias_double")]
    def med(key):
        vals = np.array([r[key] for r in matched], float)
        vals = vals[np.isfinite(vals)]
        return float(np.median(vals)) if vals.size else float("nan")
    out.update({"period_rel_err_median_abs": float(np.median(np.abs([r["period_rel_err"] for r in matched]))) if matched else float("nan"),
                "epoch_err_hours_median": med("epoch_cyclic_err_hours"), "duration_ratio_median": med("duration_ratio"),
                "depth_ratio_median": med("depth_ratio"), "matched_rank1_fraction": (sum(r["matched_rank"] == 1 for r in matched) / len(matched)) if matched else float("nan")})
    for name, fn, key in (("period", _bin_period, "period_days"), ("duration", _bin_duration, "duration_hours"), ("depth", _bin_depth, "depth_ppm")):
        bins: dict[str, list[str]] = {}
        for r in rows:
            bins.setdefault(fn(float(r[key])), []).append(r["match"])
        for b, ks in sorted(bins.items()):
            out[f"direct_{name}_{b}"] = ks.count("direct") / len(ks)
    return out


# --------------------------------------------------------------------------- 오프라인 게이트

def gate_table(peak_rows: list[dict], match_rows: list[dict], *, snr_thresholds, sde_thresholds, min_transits) -> list[dict]:
    """저장된 피크·매칭 행에 게이트 조합을 적용한다.

    peak_rows: peaks.csv 행(setting_id, baseline_id, group_id, rank, sde, snr, n_transits ...)
    match_rows: matches.csv 행(setting_id, baseline_id, matched_rank, match, ...). 호출자가 범위 안 신호로 걸러 넘긴다.
    각 (setting, gate) 마다
    (1) gated_recovery: 매칭된 피크가 게이트를 통과하는 주입 비율,
    (2) false_peaks_per_noise_curve: 순수 잡음 곡선(baseline 에 noise, group none)당 게이트 통과 피크 수,
    (3) residual_peaks_per_real_curve: 주입 없는 실제 곡선(realclean/real 의 group none)당 게이트 통과 피크 수.
        실제 별의 잔여 계통 오차(자전 변광, 제거 행성의 잔여, 밝은 별의 낮은 산포)가 후보로 남는 수다. 미확인 신호일
        수도 있어 가짜로 단정하지 않지만, 잡음 곡선 지표만 보면 SNR 게이트가 충분해 보이는 착시를 막는다.
    """
    def passes(sde, snr, ntr, g):
        ok = True
        if g["snr_min"] is not None:
            ok &= np.isfinite(snr) and snr >= g["snr_min"]
        if g["sde_min"] is not None:
            ok &= np.isfinite(sde) and sde >= g["sde_min"]
        if g["min_transits"] is not None:
            ok &= ntr >= g["min_transits"]
        return bool(ok)

    gates = [{"gate": "none", "snr_min": None, "sde_min": None, "min_transits": None}]
    gates += [{"gate": f"snr>={s}", "snr_min": s, "sde_min": None, "min_transits": None} for s in snr_thresholds]
    gates += [{"gate": f"sde>={d}", "snr_min": None, "sde_min": d, "min_transits": None} for d in sde_thresholds]
    gates += [{"gate": f"snr>={s}&sde>={d}", "snr_min": s, "sde_min": d, "min_transits": None} for s in snr_thresholds for d in sde_thresholds]
    gates += [{"gate": f"snr>={s}&sde>={d}&ntr>={m}", "snr_min": s, "sde_min": d, "min_transits": m}
              for s in snr_thresholds for d in sde_thresholds for m in min_transits]

    peak_index = {(r["setting_id"], r["baseline_id"], r["group_id"], int(r["rank"])): r for r in peak_rows}
    settings = sorted({r["setting_id"] for r in peak_rows})
    out = []
    for sid in settings:
        none_curves = {(r["baseline_id"], r["group_id"]) for r in peak_rows if r["setting_id"] == sid and r["group_id"] == "none"}
        noise_curves = {c for c in none_curves if "noise" in c[0]}
        real_curves = none_curves - noise_curves
        m_rows = [r for r in match_rows if r["setting_id"] == sid]

        def count_pass(curves, g):
            return sum(1 for r in peak_rows if r["setting_id"] == sid and (r["baseline_id"], r["group_id"]) in curves
                       and passes(float(r["sde"]), float(r["snr"]), int(float(r["n_transits"])), g))

        for g in gates:
            recovered = 0
            for m in m_rows:
                if m["match"] in ("direct", "alias_half", "alias_double") and m["matched_rank"] not in ("", None):
                    p = peak_index.get((sid, m["baseline_id"], m["group_id"], int(float(m["matched_rank"]))))
                    if p and passes(float(p["sde"]), float(p["snr"]), int(float(p["n_transits"])), g):
                        recovered += 1
            out.append({"setting_id": sid, **{k: ("" if v is None else v) for k, v in g.items()},
                        "gated_recovery": recovered / len(m_rows) if m_rows else float("nan"),
                        "n_signals": len(m_rows), "n_noise_curves": len(noise_curves), "n_real_curves": len(real_curves),
                        "false_peaks_per_noise_curve": count_pass(noise_curves, g) / len(noise_curves) if noise_curves else float("nan"),
                        "residual_peaks_per_real_curve": count_pass(real_curves, g) / len(real_curves) if real_curves else float("nan")})
    return out

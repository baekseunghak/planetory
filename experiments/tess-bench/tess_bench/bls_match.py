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
    # 구간별 회수율은 범위 안 신호만 센다(열이 없으면 전체). 범위 밖 20일 주입이 섞이면 짧은 관측의 별에서 희석된다.
    bin_rows = [r for r in rows if _truthy(r.get("in_search_range", "true"))] if any("in_search_range" in r for r in rows) else rows
    for name, fn, key in (("period", _bin_period, "period_days"), ("duration", _bin_duration, "duration_hours"), ("depth", _bin_depth, "depth_ppm")):
        bins: dict[str, list[str]] = {}
        for r in bin_rows:
            bins.setdefault(fn(float(r[key])), []).append(r["match"])
        for b, ks in sorted(bins.items()):
            out[f"direct_{name}_{b}"] = ks.count("direct") / len(ks)
    return out


# --------------------------------------------------------------------------- 결과 보고서 (저장 CSV → 문서 표)

def _is_pair_row(r: dict, group_sizes: dict) -> bool:
    return group_sizes.get((r["baseline_id"], r["group_id"]), 1) > 1


def report_tables(match_rows: list[dict], *, baseline_filter: str = "realclean", setting_order: list[str] | None = None) -> dict:
    """문서 5.1절 표를 저장된 matches.csv 행에서 직접 만든다. 별 여러 개의 행을 합쳐 넘기면 합계도 낸다.

    - `in_search_range` 가 true 인 행만 쓴다(열이 없으면 전체, 호출자가 `--baseline-days` 로 채운다).
    - 구간표(주기·지속시간·깊이)는 **단일 주입만** 센다. 한 곡선에 신호가 둘인 쌍 주입은 조건이 달라 같은 칸에 넣지 않고
      `pairs` 로 따로 낸다. 세 구간표의 주변합은 같아야 하며 `marginal_ok` 로 확인한다.
    - 설정표는 단일+쌍 전체(`all`)와 단일만(`single`)을 둘 다 낸다.
    """
    rows = [r for r in match_rows if r["baseline_id"].endswith(baseline_filter)]
    if rows and "in_search_range" in rows[0]:
        rows = [r for r in rows if _truthy(r["in_search_range"])]
    group_sizes: dict = {}
    for r in match_rows:                      # 쌍 판정은 범위 필터 전 행으로 (쌍의 한 신호만 범위 밖일 수 있음)
        if r["baseline_id"].endswith(baseline_filter) and r["setting_id"] == match_rows[0]["setting_id"]:
            k = (r["baseline_id"], r["group_id"]); group_sizes[k] = group_sizes.get(k, 0) + 1
    stars = sorted({r["baseline_id"].rsplit("-", 1)[0] for r in rows})
    settings = [s for s in (setting_order or sorted({r["setting_id"] for r in rows})) if any(r["setting_id"] == s for r in rows)]

    def frac(rs):
        d = sum(r["match"] == "direct" for r in rs)
        return {"n": len(rs), "direct": d, "rate": d / len(rs) if rs else float("nan")}

    setting_table = []
    for sid in settings:
        srows = [r for r in rows if r["setting_id"] == sid]
        single = [r for r in srows if not _is_pair_row(r, group_sizes)]
        entry = {"setting_id": sid, "all": frac(srows), "single": frac(single), "per_star": {}}
        for st in stars:
            st_rows = [r for r in srows if r["baseline_id"] == f"{st}-{baseline_filter}"]
            entry["per_star"][st] = frac(st_rows) if st_rows else None
        setting_table.append(entry)

    bins: dict = {}
    for name, key in (("period", "period_days"), ("duration", "duration_hours"), ("depth", "depth_ppm")):
        bins[name] = {}
        for sid in settings:
            single = [r for r in rows if r["setting_id"] == sid and not _is_pair_row(r, group_sizes)]
            per_value: dict = {}
            for r in single:
                per_value.setdefault(float(r[key]), []).append(r)
            bins[name][sid] = {v: frac(rs) for v, rs in sorted(per_value.items())}
    pairs = {sid: frac([r for r in rows if r["setting_id"] == sid and _is_pair_row(r, group_sizes)]) for sid in settings}
    sums = {name: {sid: sum(x["n"] for x in bins[name][sid].values()) for sid in settings} for name in bins}
    marginal_ok = all(len({sums[n][sid] for n in sums}) == 1 for sid in settings)
    return {"settings": setting_table, "bins": bins, "pairs": pairs, "marginal_ok": marginal_ok, "stars": stars, "n_rows": len(rows)}


def report_markdown(rep: dict, *, compare: tuple[str, ...] = ("poc_linear20k", "linear50k")) -> str:
    """report_tables 결과를 문서에 붙일 Markdown 표로."""
    def cell(f):
        return "-" if f is None or f["n"] == 0 else f"{f['rate']:.2f} ({f['direct']}/{f['n']})"
    out = ["**설정별 직접 회수율(범위 안, 상위 5 피크, 게이트 없음). 전체 = 단일+쌍 주입, 단일 = 단일 주입만**", ""]
    out.append("| setting_id | " + " | ".join(rep["stars"]) + " | 합(전체) | 합(단일) |")
    out.append("|---|" + "---|" * (len(rep["stars"]) + 2))
    for e in rep["settings"]:
        out.append(f"| `{e['setting_id']}` | " + " | ".join(cell(e["per_star"].get(st)) for st in rep["stars"])
                   + f" | {cell(e['all'])} | {cell(e['single'])} |")
    labels = {"period": "P = {:g} d", "duration": "D = {:g} h", "depth": "깊이 {:g} ppm"}
    comp = [c for c in compare if any(e["setting_id"] == c for e in rep["settings"])]
    out += ["", "**구간별 직접 회수율(범위 안, 단일 주입만, 별 합). 쌍 주입은 마지막 행에 따로**", ""]
    out.append("| 구간 | " + " | ".join(f"`{c}`" for c in comp) + " |")
    out.append("|---|" + "---|" * len(comp))
    for name in ("period", "duration", "depth"):
        for v in sorted({v for c in comp for v in rep["bins"][name][c]}):
            out.append(f"| {labels[name].format(v)} | " + " | ".join(cell(rep["bins"][name][c].get(v)) for c in comp) + " |")
    out.append("| 쌍 주입(두 신호 각각) | " + " | ".join(cell(rep["pairs"][c]) for c in comp) + " |")
    out.append("")
    out.append(f"주변합 일치: {'예' if rep['marginal_ok'] else '아니오'} (주기·지속시간·깊이 표의 단일 신호 합이 설정마다 같음). 범위 안 행 수 {rep['n_rows']}.")
    return "\n".join(out) + "\n"


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

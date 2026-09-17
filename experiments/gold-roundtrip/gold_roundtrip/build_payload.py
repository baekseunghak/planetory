"""실제 TESS 곡선(fixture TOI-270 Sector 3)으로 Gold 적재 payload 예제와 Silver 기준 결과를 만든다.

단계: FITS(QUALITY==0, Sector 중앙값 정규화) → 42 채택 전처리(biweight 1일) → 10분 비닝 세그먼트(REAL 정밀도로 반올림)
→ 로그 5,000점 주기도 → Archive 확인 행성 3개를 transit_model 계약 1.0 으로 → manifest → fold_reference_time_btjd
→ 제거 조합별 잔차 기대값(bin 중심 평가, 113 결정).

숫자는 실제 관측에서 나온 값이지만 이 payload 는 **계약 예제**다. 과학 기준값(D23)·운영 Publisher 출력이 아니다.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from astropy.timeseries import BoxLeastSquares

from astro_kernel import remove_transit_models, TransitModelError, parse_transit_model
from tess_fixture import download as dl
from tess_fixture import references as refs
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.targets import iter_products, select_targets
from tess_bench import bls as bl
from tess_bench.preprocess import load_settings, preprocess

from . import qa
from .canonical import (CHECKSUM_VERSION, RECORD_CHECKSUM_VERSION, array_checksum, bundle_version, canonical_record_bytes,
                        float64_checksum, normalize_array, record_checksum)
import hashlib

REPO = Path(__file__).resolve().parents[3]
FIXTURE_DIR = REPO / "experiments" / "tess-fixture"
BENCH_DIR = REPO / "experiments" / "tess-bench"
SCHEMA_PATH = REPO / "contracts" / "gold" / "transit-model.schema.json"

BIN_MINUTES = 10
BIN_DAYS = BIN_MINUTES / 1440.0
PERIOD_MIN_DAYS = 0.5
N_PERIODS = 5000
DURATIONS_HOURS = (1.2, 1.92, 2.88, 4.8)          # PoC 4점 (110 채택 제안 유지)

CALCULATION_VERSIONS = {
    "preprocessing": "biweight_1.0d",             # 42 잠정 채택값
    "bls_config": "bls_grid_v1/linear50k",        # 110 제안 (확정 전)
    "residual_model": "box-divide-v0",            # 113 확정
    "periodogram_config": "pg-log5000-v1",        # 113 제안 형식
    "candidate_quality": "gate_v1/snr7_sde6",     # 110 제안 (확정 전)
    "ai_model": "astronet-triage-1",              # 118 전 자리표시
    "ai_threshold": "ai-threshold-v0",
    "external_matching": "archive-2026-09-10",
}


def robust_scatter(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if x.size else float("nan")


def bin_segment(t: np.ndarray, f: np.ndarray, bin_days: float) -> tuple[float, list[float | None], list[list[int]]]:
    """유효 점(유한 f)만으로 균등 격자 비닝. start = 첫 유효 점 시각, bin 값 = 평균, 빈 bin = None."""
    keep = np.isfinite(f) & np.isfinite(t)
    t, f = t[keep], f[keep]
    start = float(t.min())
    n = int(math.floor((t.max() - start) / bin_days)) + 1
    idx = np.floor((t - start) / bin_days).astype(int)
    idx = np.clip(idx, 0, n - 1)
    sums = np.bincount(idx, weights=f, minlength=n)
    counts = np.bincount(idx, minlength=n)
    flux: list[float | None] = [float(sums[i] / counts[i]) if counts[i] else None for i in range(n)]
    gaps, run = [], None
    for i, v in enumerate(flux):
        if v is None:
            run = [i, i] if run is None else [run[0], i]
        elif run is not None:
            gaps.append(run); run = None
    if run is not None:
        gaps.append(run)
    return start, flux, gaps


def fold_reference_time(base) -> float:
    """DAT-11: DAT-02 품질 필터(QUALITY==0)와 time·flux 유한성을 통과한 원본 관측 시각에서 **중복을 제거한 뒤** 의 중앙값.

    전처리(detrending·clipping) 결과에 의존하지 않는다. build_baseline 이 만든 base.time 이 필터·유한성 집합이고, 여기서
    같은 시각(여러 Sector 파일이 겹칠 때 생길 수 있음)을 하나로 합친다(np.unique). 짝수 표본은 가운데 두 값의 평균(np.median).
    """
    return float(np.median(np.unique(np.asarray(base.time, dtype=np.float64))))


def bin_centers(start: float, n: int, bin_days: float) -> np.ndarray:
    """113 결정: Gold 세그먼트의 모델 평가 시각은 bin 중심. 호출자가 옮긴다."""
    return start + (np.arange(n) + 0.5) * bin_days


def periodogram(t: np.ndarray, f: np.ndarray, period_max: float) -> tuple[np.ndarray, np.ndarray]:
    ok = np.isfinite(f)
    grid = np.exp(np.linspace(np.log(PERIOD_MIN_DAYS), np.log(period_max), N_PERIODS))
    scatter = robust_scatter(f[ok])
    res = BoxLeastSquares(t[ok], f[ok], dy=np.full(ok.sum(), scatter)).power(grid, np.array(DURATIONS_HOURS) / 24.0, objective="likelihood")
    return grid, np.asarray(res.power, dtype=float)


def build(target_key: str = "toi270", sector: int = 3, raw: Path | None = None) -> dict:
    target = select_targets([target_key])[0]
    raw = raw or FIXTURE_DIR / "sample_raw"
    product = next(p for p in iter_products((target,)) if p[1] == sector)
    _, sec, filename, url = product
    curve = load_sector(raw / target.key / filename)
    base = build_baseline([curve])

    cfg, settings = load_settings(BENCH_DIR / "configs" / "preprocess_settings_v1.json", ["biweight_1.0d"])
    pre = preprocess(base.time, base.flux, base.sector_of_point, settings[0])
    fold_ref = fold_reference_time(base)                  # 전처리 무관: 품질 필터·유한성만 통과한 원본 시각의 중앙값
    base_days = float(base.time.max() - base.time.min())

    start, flux64, gaps = bin_segment(pre.time, pre.flux_det, BIN_DAYS)
    flux = normalize_array(flux64)                        # NULL 마스크 보존 → 유한성 검사 → float32 → -0 정규화 (canonical.py)
    n_points = len(flux)
    scatter = robust_scatter(np.array([v for v in flux if v is not None], float))
    centers = bin_centers(start, n_points, BIN_DAYS)
    f_arr = np.array([np.nan if v is None else v for v in flux], float)

    # 후보 = Archive 확인 행성 (계약 1.0 형식). 정렬은 주기 오름차순, removal_step 은 0부터.
    rows = refs.read_references(FIXTURE_DIR / "references.csv")
    models, skipped = bl.known_signal_models(rows, target.key)
    models.sort(key=lambda m: m["parameters"]["period_days"])
    longest = max(m["parameters"]["period_days"] for m in models)
    period_max = max(40.0, round(longest * 1.15, 3))    # 탐사 API 5.3절 규칙
    grid, power = periodogram(centers, f_arr, period_max)
    power32 = normalize_array(power.tolist(), allow_null=False)     # 주기도에는 NULL 이 없어야 한다

    candidates = []
    for step, m in enumerate(models):
        p = m["parameters"]
        i = int(np.argmin(np.abs(grid - p["period_days"])))
        tm = {"shape": "box", "parameters": dict(p), "baseline": {"kind": "unity"}, "residual_model_version": "box-divide-v0"}
        parse_transit_model(tm)                          # 계약 1.0 검증(candidate_id 는 DB id 확정 뒤 c-<id> 로 채움)
        candidates.append({"local_key": m["candidate_id"], "status": "active", "removal_step": step,
                           "period_days": p["period_days"], "epoch_btjd": p["epoch_btjd"], "duration_hours": p["duration_hours"],
                           "depth_ppm": p["depth_ppm"], "bls_power": round(float(power[i]), 6), "transit_model": tm,
                           "discoverable": True, "is_confirmed": True})

    segment = {"tic_id": target.tic_id, "sector": sec, "binning_revision": f"{BIN_MINUTES}m-v1", "start_btjd": start,
               "bin_minutes": BIN_MINUTES, "n_points": n_points, "flux": flux, "flux_scatter": round(scatter, 8), "gaps": gaps}
    # 입력 snapshot id 는 내용 기반: 원천 FITS 는 파일 sha256 + PROCVER, Archive 는 대상 행 내용의 sha256.
    fits_sha = dl.sha256_of(raw / target.key / filename)
    target_rows = sorted((r for r in rows if r.get("target_key") == target.key), key=lambda r: r.get("pl_name", ""))
    archive_sha = hashlib.sha256(canonical_record_bytes(target_rows)).hexdigest()
    input_snapshot_ids = [f"lc:spoc:s{sec:04d}:sha256:{fits_sha}:procver:{curve.meta.get('PROCVER', '')}",
                          f"archive:{target.key}:sha256:{archive_sha}"]
    # 외부 상태(external_signal_references 행). 통과 행성은 후보 자연 키로 연결, 비통과 행은 candidate_key null.
    by_name = {c["local_key"]: c for c in candidates}
    external_statuses = []
    for r in target_rows:
        c = by_name.get(r.get("pl_name"))
        external_statuses.append({"source": "nasa_exoplanet_archive", "external_id": r["pl_name"], "disposition": "confirmed",
                                  "period_days": float(r["pl_orbper"]) if r.get("pl_orbper") else None,
                                  "epoch_btjd": (float(r["pl_tranmid"]) - bl.BJD_OFFSET) if r.get("pl_tranmid") else None,
                                  "fetched_on": (r.get("fetched_at") or "")[:10],
                                  "candidate_key": ({"period_days": c["period_days"], "epoch_btjd": c["epoch_btjd"]} if c else None)})
    ai_results: list[dict] = []                            # 118 전. 비어 있어도 checksum 은 정의된다
    semantic = {"input_snapshot_ids": sorted(input_snapshot_ids),
                "segments": [{"tic_id": target.tic_id, "sector": sec, "binning_revision": segment["binning_revision"]}],
                "calculation_versions": CALCULATION_VERSIONS}
    manifest = {
        "segment_ids": [],                                # 적재 시 DB id 로 채움
        "array_checksums": {},                            # 적재 시 자연 키 → DB id 로 채움. 값은 아래 checksums 와 같다
        "checksum_version": CHECKSUM_VERSION,
        "residual_model_version": CALCULATION_VERSIONS["residual_model"],
        "periodogram_config_version": CALCULATION_VERSIONS["periodogram_config"],
        "binning": {"bin_minutes": BIN_MINUTES, "rule": "kept-point mean per bin from first kept time; empty bin NULL; values rounded to float32 before load"},
        "period_grid": {"period_min_days": PERIOD_MIN_DAYS, "period_max_days": period_max, "n_periods": N_PERIODS, "spacing": "log",
                        "max_rule": "max(40 d, 1.15 × longest candidate period)"},
        "fine_tune": {"half_width_cells": 3},
        "curve_steps": {"rule": "one_candidate_per_step", "order": "removal_step"},
        "input_snapshot_ids": semantic["input_snapshot_ids"],
        "calculation_versions": CALCULATION_VERSIONS,
        "excluded_sectors": [],
        "record_checksum_version": RECORD_CHECKSUM_VERSION,
        "record_checksums": {"candidates": record_checksum("candidates", candidates),
                             "ai_results": record_checksum("ai_results", ai_results),
                             "external_statuses": record_checksum("external_statuses", external_statuses)},
    }
    checksums = {"segment:{sector}:{binning_revision}:flux".format(**segment): array_checksum(flux),
                 "periodogram:power": array_checksum(power32), **{f"records:{k}": v for k, v in manifest["record_checksums"].items()}}

    # Silver 기준 결과: 제거 조합별 잔차 (bin 중심 평가). 전체 배열 대신 checksum·표본·통계를 남긴다.
    def residual_case(ids: list[str]):
        ms = [c["transit_model"] for c in candidates if c["local_key"] in ids]
        r = remove_transit_models(centers, f_arr, ms)
        res = r.flux_residual
        sample_idx = [0, 1, 2, n_points // 4, n_points // 2, (3 * n_points) // 4, n_points - 2, n_points - 1]
        return {"model_ids": ids, "n_valid_input": int(r.n_valid_input), "n_finite_residual": int(r.n_finite_residual),
                "residual_checksum_f64": float64_checksum(res.tolist()),
                "sample": [{"index": i, "time_btjd_bin_center": float(centers[i]), "residual": (None if not np.isfinite(res[i]) else float(res[i]))} for i in sample_idx],
                "model_flux_min": float(np.nanmin(r.model_flux)), "n_in_transit_bins": int(np.sum(r.model_flux < 1.0))}
    keys = [c["local_key"] for c in candidates]
    expected = {"remove_none": residual_case([]), "remove_first": residual_case(keys[:1]), "remove_first_two": residual_case(keys[:2]),
                "remove_first_two_reversed": residual_case(list(reversed(keys[:2]))), "remove_all": residual_case(keys)}
    assert expected["remove_first_two"]["residual_checksum_f64"] == expected["remove_first_two_reversed"]["residual_checksum_f64"]
    bad = {"shape": "box", "parameters": {**candidates[0]["transit_model"]["parameters"], "depth_ppm": 0.0}}
    try:
        remove_transit_models(centers, f_arr, [bad]); bad_code = None
    except TransitModelError as e:
        bad_code = e.code
    expected["invalid_model_zero_depth"] = {"model": bad, "expected_error": bad_code}

    payload = {
        "fixtureVersion": "gold-roundtrip-v0.2", "contractStatus": "contract-example-not-scientific-reference", "jira": "S15P21C206-117",
        "source": {"target_key": target.key, "tic_id": target.tic_id, "sector": sec, "product": filename, "source_uri": url, "product_sha256": fits_sha,
                   "procver": curve.meta.get("PROCVER", ""), "preprocessing": "biweight_1.0d (42 잠정 채택)", "n_quality0_points": int(base.n_valid),
                   "n_kept_after_preprocess": int(np.sum(pre.kept & np.isfinite(pre.flux_det))), "skipped_reference_rows": skipped},
        "star": {"tic_id": target.tic_id, "teff_k": 3506.0, "radius_rsun": 0.38, "tmag": None, "confirmed_count": len(candidates), "service_status": "published"},
        "bundle": {"tic_id": target.tic_id, "bundle_version": bundle_version(semantic), "status_at_load": "staging",
                   "fold_reference_time_btjd": fold_ref, "base_days": round(base_days, 6), "manifest": manifest},
        "segments": [segment],
        "periodogram": {"period_min_days": PERIOD_MIN_DAYS, "period_max_days": period_max, "n_periods": N_PERIODS, "power": power32,
                        "grid_rule": "period_i = min × (max/min)^(i/(n−1))", "objective": "likelihood", "durations_hours": list(DURATIONS_HOURS)},
        "candidates": candidates,
        "external_statuses": external_statuses,
        "ai_results": ai_results,
        "checksums": checksums,
        "expected_residuals": {"evaluated_at": "bin_center (start_btjd + (i + 0.5) × bin_minutes/1440)", "cases": expected},
    }
    checks = qa.validate_payload(payload)
    bad_checks = qa.failed(checks)
    if bad_checks:
        raise RuntimeError(f"payload 가 자기 QA 를 통과하지 못함: {bad_checks}")
    manifest["qa"] = {"status": "passed", "checker": "gold_roundtrip.qa.validate_payload", "n_checks": len(checks)}
    return payload


def _f32_shortest(v: float | None) -> str:
    """float32 값을 유일하게 되살리는 최단 십진 표기. 파싱(float64) 뒤 float32 로 반올림하면 같은 비트가 된다."""
    if v is None:
        return "null"
    s = np.format_float_positional(np.float32(v), unique=True, trim="-")
    return s if s not in ("", "-0") else "0"


def write(payload: dict, path: Path) -> None:
    """배열(flux·power)은 float32 최단 표기로 써서 파일 크기를 줄인다. 나머지는 json.dumps 그대로."""
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = json.loads(json.dumps(payload, allow_nan=False))
    arrays: dict[str, list] = {}
    for i, seg in enumerate(doc["segments"]):
        arrays[f"@@FLUX{i}@@"] = seg["flux"]; seg["flux"] = f"@@FLUX{i}@@"
    arrays["@@POWER@@"] = doc["periodogram"]["power"]; doc["periodogram"]["power"] = "@@POWER@@"
    text = json.dumps(doc, ensure_ascii=False, indent=1, allow_nan=False)
    for token, arr in arrays.items():
        text = text.replace(f'"{token}"', "[" + ", ".join(_f32_shortest(v) for v in arr) + "]")
    path.write_text(text + "\n", encoding="utf-8", newline="\n")

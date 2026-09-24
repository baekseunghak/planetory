"""별 하나의 Gold 게시 payload.

형식은 Gold 계약(contracts/gold)과 ERD 를 따른다. 주기도와 discoverable 은 서비스·배치가 쓰는
libs/astro-kernel 의 BLS·판정 함수로 계산한다. 후보 순서(removal_step)는 반복 탐색처럼 단계마다
잔차 주기도에서 가장 센 발견 가능 신호를 고른다. 모든 후보를 뺀 잔차에 기준을 넘는 봉우리가 남으면
정답표가 곡선의 신호를 다 담지 못한 것이므로 실패한다.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json

import numpy as np
from astro_kernel import remove_transit_models
from astro_kernel.bls import bls_periodogram, period_grid
from astro_kernel.discoverability import NUMERICAL_VERSION, RULE, classify, provided_arrays
from astro_kernel.segmentation import BIN_MINUTES, BINNING_RULE_VERSION, segment_revision

from .canonical import (ARRAY_CHECKSUM_VERSION, RECORD_CHECKSUM_VERSION, array_checksum, bundle_version,
                        normalize_array, record_checksum)
from .catalog import CATALOG, FETCHED_ON, GENERATOR_VERSION, Signal, Star
from .synth import RESIDUAL_MODEL_VERSION, star_curves, transit_model

PERIOD_MIN_DAYS = 0.5
N_PERIODS = 5000
HALF_WIDTH_CELLS = 3
PERIODOGRAM_CONFIG_VERSION = "pg-log5000-v1"
AI_MODEL_VERSION = "synthetic-ai-v0"
AI_THRESHOLD_VERSION = "ai-threshold-v0"
EXTERNAL_SOURCE = "synthetic"
EXTERNAL_LABEL = {"confirmed": "CP", "fp": "FP", "pc": "PC"}   # TFOPWG 표기
OBSERVATION_SOURCE_VERSION = f"synthetic:{GENERATOR_VERSION}"
JIRA = "S15P21C206-256"
PREPROCESSING_VERSION = "synthetic-none-v1"
# 세그먼트 revision 은 실제 Gold 와 같이 astro_kernel.segment_revision 으로 섹터마다 만든다(Gold 계약 4.1).
# 합성 원천 제품은 섹터 곡선 하나이고 그 checksum 은 flux 배열의 SHA-256 이다.
PREPROCESSING_PARAMETERS = {"generator": GENERATOR_VERSION, "detrending": "none"}

CALCULATION_VERSIONS = {
    "generator": GENERATOR_VERSION,
    "preprocessing": PREPROCESSING_VERSION,
    "binning": BINNING_RULE_VERSION,
    "bls_config": "synthetic-truth-v1",
    "residual_model": RESIDUAL_MODEL_VERSION,
    "periodogram_config": PERIODOGRAM_CONFIG_VERSION,
    "candidate_quality": f"{RULE['version']}/{NUMERICAL_VERSION}",
    "ai_model": AI_MODEL_VERSION,
    "ai_threshold": AI_THRESHOLD_VERSION,
    "external_matching": "synthetic-v1",
}


class GenerationError(RuntimeError):
    """정답표와 계산 결과가 어긋났다. 적재하지 않는다."""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _power_near(pg, period_days: float) -> float:
    i = int(np.argmin(np.abs(np.log(pg.periods / period_days))))
    lo, hi = max(0, i - HALF_WIDTH_CELLS), min(len(pg.periods), i + HALF_WIDTH_CELLS + 1)
    return float(np.max(pg.power[lo:hi]))


def _periodogram(time, flux, periods):
    return bls_periodogram(time, flux, periods, durations_hours=RULE["durations_hours"],
                           config_version=RULE["version"])


def payload_digest(version: str, fold_reference: float, base_days: float, segments: list[dict],
                   power_checksum: str, record_checksums: dict) -> str:
    """같은 bundle_version 의 재실행이 같은 내용인지 가리는 요약. DB id 가 들어가는 manifest 키는 쓰지 않는다."""
    return _sha256(json.dumps({
        "bundle_version": version, "fold_reference_time_btjd": repr(fold_reference), "base_days": repr(base_days),
        "segments": [[s["sector"], s["binning_revision"], s["checksum"]] for s in segments],
        "power": power_checksum, "records": record_checksums}, sort_keys=True).encode("utf-8"))


def _harmonic_source(period_days: float, signals) -> str | None:
    """잔차 봉우리가 모양을 넣은 신호의 주기 배수(1/3~5배)면 그 신호 이름."""
    for signal in signals:
        if signal.shape == "box":
            continue
        for suffix, ratio in (("/3", 1 / 3), ("/2", 1 / 2), ("", 1), ("×2", 2), ("×3", 3), ("×4", 4), ("×5", 5)):
            if abs(period_days / (signal.period_days * ratio) - 1) < 0.01:
                return signal.key + suffix
    return None


def build_star(star: Star) -> dict:
    curves, epochs = star_curves(star)
    segments = []
    snapshot_ids = []
    for curve in curves:
        flux = normalize_array([float(v) if np.isfinite(v) else None for v in curve.flux])
        checksum = array_checksum(flux)
        flux_sha = checksum.removeprefix("sha256:")
        snapshot = f"lc:synthetic:s{curve.sector:04d}:sha256:{flux_sha}:gen:{GENERATOR_VERSION}"
        snapshot_ids.append(snapshot)
        revision = segment_revision(tic_id=star.tic_id, sector=curve.sector, snapshot_id=snapshot,
                                    products={f"synthetic:{star.tic_id}:s{curve.sector:04d}": flux_sha},
                                    preprocessing_version=PREPROCESSING_VERSION,
                                    preprocessing_parameters=PREPROCESSING_PARAMETERS)
        finite = np.array([v for v in flux if v is not None])
        segments.append({
            "tic_id": star.tic_id, "sector": curve.sector, "binning_revision": revision,
            "start_btjd": curve.start_btjd, "bin_minutes": int(BIN_MINUTES), "n_points": len(flux), "flux": flux,
            "flux_scatter": round(float(1.4826 * np.median(np.abs(finite - np.median(finite)))), 8),
            "gaps": curve.gaps, "checksum": checksum,
            "observation": {"start_btjd": round(float(curve.raw_time[0]), 6),
                            "end_btjd": round(float(curve.raw_time[-1]), 6),
                            "cadence": "120s", "source_version": OBSERVATION_SOURCE_VERSION}})

    # 사용자에게 주는 배열(정규화한 float32, bin 중심)로 계산한다. 서비스 잔차 계산의 입력과 같다.
    time, flux, _ = provided_arrays(segments)
    raw = np.unique(np.concatenate([c.raw_time for c in curves]))
    longest = max(s.period_days for s in star.signals)
    period_max = float(max(40.0, 1.15 * longest))
    periods = period_grid(PERIOD_MIN_DAYS, period_max, N_PERIODS, spacing="log")

    remaining = [(s, transit_model(s, epochs[s.key])) for s in star.signals]
    removed: list[tuple[Signal, dict]] = []
    steps = []
    stored_power = None
    while remaining:
        residual = remove_transit_models(time, flux, [m for _, m in removed]).flux_residual
        pg = _periodogram(time, residual, periods)
        if stored_power is None:
            stored_power = pg.power
        evaluated = [(s, m, classify(pg, time, residual, m, RULE), _power_near(pg, s.period_days))
                     for s, m in remaining]
        found = [e for e in evaluated if e[2]["discoverable"]]
        pick = max(found, key=lambda e: e[3]) if found else evaluated[0]
        signal, model, verdict, power = pick
        if verdict["status"] != "measured" or verdict["discoverable"] is not signal.discoverable:
            raise GenerationError(f"{star.label} {signal.key}: 기대 discoverable={signal.discoverable}, "
                                  f"계산 {verdict['discoverable']} ({verdict['reason']}) at step {len(steps)}")
        steps.append((signal, model, verdict, power))
        removed.append((signal, model))
        remaining = [(s, m) for s, m in remaining if s is not signal]

    final = remove_transit_models(time, flux, [m for _, m in removed]).flux_residual
    leftover = classify(_periodogram(time, final, periods), time, final, None, RULE)["qualified_peaks"]
    # U자·V자로 넣은 신호는 box 모델로 빼도 가장자리가 남아 같은 주기·배수에 봉우리가 생긴다. 실제 곡선과 같은
    # 현상이라 허용하고 정답표에 남긴다. 그 밖의 봉우리는 정답표가 곡선의 신호를 다 담지 못한 것이다.
    residual_peaks, unexplained = [], []
    for peak in leftover:
        source = _harmonic_source(peak["period_days"], star.signals)
        (residual_peaks if source else unexplained).append(
            {"period_days": round(peak["period_days"], 4), "snr": round(peak["snr"], 1), "from": source})
    if unexplained:
        raise GenerationError(f"{star.label}: 후보를 모두 뺀 잔차에 기준을 넘는 봉우리가 남았다: "
                              + ", ".join(f"{p['period_days']} d (SNR {p['snr']})" for p in unexplained))

    candidates, external, ai = [], [], []
    for step, (signal, model, verdict, power) in enumerate(steps):
        key = {"period_days": signal.period_days, "epoch_btjd": model["parameters"]["epoch_btjd"]}
        record = {"status": "active", "removal_step": step, "period_days": signal.period_days,
                  "epoch_btjd": key["epoch_btjd"], "duration_hours": signal.duration_hours,
                  "depth_ppm": float(signal.depth_ppm), "bls_power": round(power, 6), "transit_model": model,
                  "discoverable": signal.discoverable, "is_confirmed": signal.disposition == "confirmed"}
        name = f"{star.label}.{step + 1:02d}"
        ext = None
        if signal.disposition in EXTERNAL_LABEL:
            ext = {"source": EXTERNAL_SOURCE, "external_id": name, "disposition": EXTERNAL_LABEL[signal.disposition],
                   "period_days": signal.period_days, "epoch_btjd": key["epoch_btjd"], "fetched_on": FETCHED_ON,
                   "candidate_key": key}
            external.append(ext)
        ai_row = None
        if signal.ai:
            ai_row = {"candidate_key": key, "model_version": AI_MODEL_VERSION, "status": "completed",
                      "score": signal.ai[0], "verdict": signal.ai[1], "threshold_version": AI_THRESHOLD_VERSION}
            ai.append(ai_row)
        graded = signal.disposition in ("confirmed", "fp")
        candidates.append({
            "key": signal.key, "local_key": f"{star.label} {signal.key}", "note": signal.note, "shape": signal.shape,
            "record": record,
            "disposition": {"disposition": signal.disposition, "answer_class": "graded" if graded else "analysis",
                            "planet_truth": ({"confirmed": "planet", "fp": "not_planet"}[signal.disposition]
                                             if graded else None),
                            "source_refs": [{"source": EXTERNAL_SOURCE, "external_id": name}] if ext else []},
            "external": ext, "ai": ai_row})

    records = {"candidates": [c["record"] for c in candidates], "external_statuses": external, "ai_results": ai}
    record_checksums = {kind: record_checksum(kind, rows) for kind, rows in records.items()}
    power = normalize_array(stored_power, allow_null=False)
    power_checksum = array_checksum(power)
    catalog_snapshot = "catalog:synthetic:sha256:" + _sha256(
        json.dumps(dataclasses.asdict(star), sort_keys=True, ensure_ascii=False).encode("utf-8"))
    input_snapshot_ids = sorted([*snapshot_ids, catalog_snapshot])
    version = bundle_version(input_snapshot_ids,
                             [(s["tic_id"], s["sector"], s["binning_revision"]) for s in segments],
                             CALCULATION_VERSIONS)
    fold_reference = float(np.median(raw))
    base_days = round(float(raw[-1] - raw[0]), 6)
    digest = payload_digest(version, fold_reference, base_days, segments, power_checksum, record_checksums)

    manifest = {
        "segment_ids": [],                      # 적재할 때 DB id 로 채운다
        "array_checksums": {},                  # 키에 DB id 가 들어가므로 적재할 때 채운다
        "checksum_version": ARRAY_CHECKSUM_VERSION,
        "residual_model_version": RESIDUAL_MODEL_VERSION,
        "periodogram_config_version": PERIODOGRAM_CONFIG_VERSION,
        "binning": {"bin_minutes": int(BIN_MINUTES), "rule": BINNING_RULE_VERSION},
        "period_grid": {"period_min_days": PERIOD_MIN_DAYS, "period_max_days": period_max, "n_periods": N_PERIODS,
                        "spacing": "log", "max_rule": "max(40 d, 1.15 × longest candidate period)"},
        "fine_tune": {"half_width_cells": HALF_WIDTH_CELLS},
        "curve_steps": {"rule": "one_candidate_per_step", "order": "removal_step"},
        "input_snapshot_ids": input_snapshot_ids,
        "calculation_versions": CALCULATION_VERSIONS,
        "excluded_sectors": [],
        "record_checksum_version": RECORD_CHECKSUM_VERSION,
        "record_checksums": record_checksums,
        "qa": {"status": "passed", "checker": "local_seed.payload",
               "checks": ["expected_discoverable", "leftover_peaks_explained", "gaps_equal_null_runs"],
               "residual_peaks": residual_peaks},
        "local_seed": {"source": "synthetic", "generator": GENERATOR_VERSION, "jira": JIRA, "label": star.label,
                       "role": star.role, "payload_digest": digest,
                       "note": "로컬 통합 테스트용 합성 데이터. 과학 기준값·운영 Gold가 아니다."},
    }
    confirmed = sum(1 for c in candidates if c["record"]["is_confirmed"])
    return {
        "tic_id": star.tic_id, "label": star.label, "role": star.role, "description": star.description,
        "tutorial_seq": star.tutorial_seq, "tutorial_intent": star.tutorial_intent,
        "star": {"tic_id": star.tic_id, "teff_k": star.teff_k, "radius_rsun": star.radius_rsun, "tmag": star.tmag,
                 "confirmed_count": confirmed, "service_status": "published"},
        "segments": segments,
        "bundle": {"bundle_version": version, "fold_reference_time_btjd": fold_reference, "base_days": base_days,
                   "manifest": manifest, "payload_digest": digest},
        "periodogram": {"period_min_days": PERIOD_MIN_DAYS, "period_max_days": period_max, "n_periods": N_PERIODS,
                        "power": power, "checksum": power_checksum},
        "candidates": candidates,
        "records": records,
        "residual_peaks": residual_peaks,
    }


def build_all(stars=CATALOG) -> list[dict]:
    from .real import build_toi270     # 실제 곡선 예제. 합성 별 뒤에 둔다

    return [build_star(star) for star in stars] + [build_toi270()]

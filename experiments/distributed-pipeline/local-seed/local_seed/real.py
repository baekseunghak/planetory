"""저장소의 실제 TESS Gold 예제(TOI-270 Sector 3, S15P21C206-117)를 시드 payload 로 바꾼다.

곡선·주기도·후보·외부 참조는 예제 값을 그대로 쓴다. 예제는 실제 관측으로 만든 계약 예제이며 과학 기준값이
아니다(experiments/gold-roundtrip/README.md). 예제를 다시 만들면 내용이 바뀌므로 그때는 로컬 DB 를 초기화한다.

후보의 discoverable 은 예제 값(셋 다 true)을 따른다. 현재 astro-kernel 판정 규칙(123, 승인 전)으로 다시 계산하면
c·d 는 SNR 이 20 을 넘어도 SDE 가 기준(6)보다 낮아 false 가 된다. 한 섹터에 통과가 몇 번뿐이라 주기도 전체에
높은 값이 넓게 깔리기 때문이다. 합성 별과 달리 이 차이로 실패시키지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

from .canonical import array_checksum, normalize_array, record_checksum
from .catalog import GENERATOR_VERSION
from .payload import JIRA, payload_digest

FIXTURE = Path(__file__).resolve().parents[3] / "gold-roundtrip" / "fixtures" / "gold-toi270-s3.json"
RECORD_FIELDS = ("status", "removal_step", "period_days", "epoch_btjd", "duration_hours", "depth_ppm", "bls_power",
                 "transit_model", "discoverable", "is_confirmed")
PLANET_TRUTH = {"confirmed": "planet", "false positive": "not_planet"}


def build_toi270() -> dict:
    src = json.loads(FIXTURE.read_text(encoding="utf-8"))
    segments = []
    for seg in src["segments"]:
        flux = normalize_array(seg["flux"])
        end = seg["start_btjd"] + seg["n_points"] * seg["bin_minutes"] / 1440
        segments.append({
            **{k: seg[k] for k in ("tic_id", "sector", "binning_revision", "start_btjd", "bin_minutes", "n_points",
                                   "flux_scatter", "gaps")},
            "flux": flux, "checksum": array_checksum(flux),
            "observation": {"start_btjd": round(seg["start_btjd"], 6), "end_btjd": round(end, 6),
                            "cadence": "120s", "source_version": src["source"]["procver"]}})

    external = {(e["candidate_key"]["period_days"], e["candidate_key"]["epoch_btjd"]): e
                for e in src["external_statuses"] if e.get("candidate_key")}
    candidates = []
    for c in sorted(src["candidates"], key=lambda c: c["removal_step"]):
        ext = external.get((c["period_days"], c["epoch_btjd"]))
        label = ext["disposition"] if ext else None
        graded = label in PLANET_TRUTH
        candidates.append({
            "key": c["local_key"].split()[-1], "local_key": c["local_key"],
            "note": f"실제 {'확정 행성' if label == 'confirmed' else '신호'}({ext['source'] if ext else '외부 라벨 없음'})",
            "shape": "real",
            "record": {k: c[k] for k in RECORD_FIELDS},
            "disposition": {"disposition": "confirmed" if label == "confirmed" else "fp" if graded else "pc",
                            "answer_class": "graded" if graded else "analysis",
                            "planet_truth": PLANET_TRUTH.get(label),
                            "source_refs": [{"source": ext["source"], "external_id": ext["external_id"]}] if ext else []},
            "external": ext, "ai": None})

    records = {"candidates": [c["record"] for c in candidates], "external_statuses": src["external_statuses"],
               "ai_results": src["ai_results"]}
    record_checksums = {kind: record_checksum(kind, rows) for kind, rows in records.items()}
    power = normalize_array(src["periodogram"]["power"], allow_null=False)
    power_checksum = array_checksum(power)
    bundle = src["bundle"]
    digest = payload_digest(bundle["bundle_version"], bundle["fold_reference_time_btjd"], bundle["base_days"],
                            segments, power_checksum, record_checksums)
    manifest = {**bundle["manifest"], "record_checksums": record_checksums,
                "local_seed": {"source": f"experiments/gold-roundtrip/fixtures/{FIXTURE.name}",
                               "generator": GENERATOR_VERSION, "jira": JIRA, "label": "TOI-270", "role": "pool",
                               "payload_digest": digest,
                               "note": "실제 TESS 관측(SPOC)으로 만든 Gold 계약 예제. 과학 기준값이 아니다."}}
    pg = src["periodogram"]
    return {
        "tic_id": src["star"]["tic_id"], "label": "TOI-270", "role": "pool",
        "description": f"실제 TESS 곡선(SPOC 섹터 {src['source']['sector']}). 확정 행성 b·c·d",
        "tutorial_seq": None, "tutorial_intent": None,
        "star": dict(src["star"]),
        "segments": segments,
        "bundle": {"bundle_version": bundle["bundle_version"], "fold_reference_time_btjd": bundle["fold_reference_time_btjd"],
                   "base_days": bundle["base_days"], "manifest": manifest, "payload_digest": digest},
        "periodogram": {"period_min_days": pg["period_min_days"], "period_max_days": pg["period_max_days"],
                        "n_periods": pg["n_periods"], "power": power, "checksum": power_checksum},
        "candidates": candidates,
        "records": records,
        "residual_peaks": [],
    }

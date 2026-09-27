"""목업 입력 어댑터: 계약 예시 payload를 운영 더미 별에 옮겨 싣는다 [S15P21C206-262].

실제 Gold가 서비스 DB에 오기 전까지 분석 화면을 열어 보기 위한 입력이다. load.publish_star는 이 어댑터와
운영 입력(배치 run의 run_source)을 구분하지 않는다.

원천은 fixtures/gold-toi270-s3.json이다. experiments/gold-roundtrip(S15P21C206-117)이 실제 TESS 곡선(TOI-270,
Sector 3)으로 만든 계약 예시이며 과학 기준값이 아니다. payload로 바꾸는 규칙은 로컬 시드(S15P21C206-256)의
local_seed/real.py와 같다. 운영용으로 셋을 다르게 한다.

  - TIC를 운영 더미 별로 바꾼다. 회원 발견 기록(star_unlocks)이 있는 별이라야 분석이 열린다.
  - 별 속성(star)을 싣지 않는다. 적재가 기존 별 행을 덮어쓰지 않는다.
  - 판 bundle_version, 세그먼트 binning_revision, 관측 원천 source_version 앞에 MARK를 붙인다.
    mock_purge.sql이 이 표식으로만 지우므로 운영 Gold와 섞이지 않는다.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable, Iterator

from astro_kernel.gold_canonical import array_checksum, normalize_array, record_checksum

FIXTURE = Path(__file__).parent / "fixtures" / "gold-toi270-s3.json"
MARK = "mock-"
JIRA = "S15P21C206-262"
RECORD_FIELDS = ("status", "removal_step", "period_days", "epoch_btjd", "duration_hours", "depth_ppm", "bls_power",
                 "transit_model", "discoverable", "is_confirmed")
PLANET_TRUTH = {"confirmed": "planet", "false positive": "not_planet"}


def payloads(tics: Iterable[int]) -> Iterator[dict]:
    src = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for tic in tics:
        yield toi270_payload(src, tic)


def payload_digest(version: str, fold_reference: float, base_days: float, segments: list[dict],
                   power_checksum: str, record_checksums: dict) -> str:
    """같은 bundle_version의 재실행이 같은 내용인지 가리는 요약. DB id가 들어가는 manifest 키는 쓰지 않는다.

    로컬 시드(local_seed/payload.py)와 같은 규칙이다.
    """
    return hashlib.sha256(json.dumps({
        "bundle_version": version, "fold_reference_time_btjd": repr(fold_reference), "base_days": repr(base_days),
        "segments": [[s["sector"], s["binning_revision"], s["checksum"]] for s in segments],
        "power": power_checksum, "records": record_checksums}, sort_keys=True).encode("utf-8")).hexdigest()


def toi270_payload(src: dict, tic: int) -> dict:
    """src를 tic의 목업 판으로 바꾼다. 같은 입력이면 같은 판 버전이라 다시 돌려도 재시도로 끝난다."""
    segments = []
    for seg in src["segments"]:
        flux = normalize_array(seg["flux"])
        end = seg["start_btjd"] + seg["n_points"] * seg["bin_minutes"] / 1440
        segments.append({
            **{k: seg[k] for k in ("sector", "start_btjd", "bin_minutes", "n_points", "flux_scatter", "gaps")},
            "tic_id": tic, "binning_revision": MARK + seg["binning_revision"],
            "flux": flux, "checksum": array_checksum(flux),
            "observation": {"start_btjd": round(seg["start_btjd"], 6), "end_btjd": round(end, 6),
                            "cadence": "120s", "source_version": MARK + src["source"]["procver"]}})

    external = {(e["candidate_key"]["period_days"], e["candidate_key"]["epoch_btjd"]): e
                for e in src["external_statuses"] if e.get("candidate_key")}
    candidates = []
    for c in sorted(src["candidates"], key=lambda c: c["removal_step"]):
        ext = external.get((c["period_days"], c["epoch_btjd"]))
        label = ext["disposition"] if ext else None
        graded = label in PLANET_TRUTH
        candidates.append({
            "record": {k: c[k] for k in RECORD_FIELDS},
            "disposition": {"disposition": "confirmed" if label == "confirmed" else "fp" if graded else "pc",
                            "answer_class": "graded" if graded else "analysis",
                            "planet_truth": PLANET_TRUTH.get(label),
                            "source_refs": [{"source": ext["source"], "external_id": ext["external_id"]}] if ext else []},
            "external": [ext] if ext else [], "ai": None})

    records = {"candidates": [c["record"] for c in candidates], "external_statuses": src["external_statuses"],
               "ai_results": src["ai_results"]}
    record_checksums = {kind: record_checksum(kind, rows) for kind, rows in records.items()}
    power = normalize_array(src["periodogram"]["power"], allow_null=False)
    power_checksum = array_checksum(power)
    bundle = src["bundle"]
    version = MARK + hashlib.sha256(f"{bundle['bundle_version']}:{tic}".encode()).hexdigest()[:16]
    digest = payload_digest(version, bundle["fold_reference_time_btjd"], bundle["base_days"],
                            segments, power_checksum, record_checksums)
    manifest = {**bundle["manifest"], "record_checksums": record_checksums,
                "publish": {"payload_digest": digest, "mock": True, "jira": JIRA,
                            "source": f"distributed-system/publisher/publisher/fixtures/{FIXTURE.name}",
                            "note": "실제 TESS 관측(SPOC)으로 만든 Gold 계약 예시. 과학 기준값이 아니다."}}
    pg = src["periodogram"]
    return {
        "tic_id": tic, "label": f"TOI-270 목업 → TIC {tic}",
        "star": None,
        "segments": segments,
        "bundle": {"bundle_version": version, "fold_reference_time_btjd": bundle["fold_reference_time_btjd"],
                   "base_days": bundle["base_days"], "manifest": manifest, "payload_digest": digest},
        "periodogram": {"period_min_days": pg["period_min_days"], "period_max_days": pg["period_max_days"],
                        "n_periods": pg["n_periods"], "power": power, "checksum": power_checksum},
        "candidates": candidates,
        "external_only": [e for e in src["external_statuses"] if not e.get("candidate_key")],
    }

"""언어 간 대조용 checksum 벡터 생성 (`contracts/gold/examples/array-checksum-vectors.v0.json`).

각 사례: 입력 배열(JSON; NULL 은 null) → 기대 정규화 배열, 해시 입력 hex, SHA-256. 거절 사례는 기대 오류 코드.
Java·Node 구현은 같은 입력으로 같은 hex·sha256 이 나와야 한다. Python 은 canonical.py 가, Node 는
`contracts/gold/array-checksum.cjs` 가 이 파일로 검증한다. Java 경로는 이 저장소에서 실행하지 않았다.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .canonical import (CHECKSUM_VERSION, NULL_HASH_BYTES, RECORD_CHECKSUM_VERSION, RECORD_RULES, ArrayCanonicalError, array_checksum,
                        canonical_bytes, canonical_record_bytes, normalize_array, prepare_records, record_checksum)

MIN_SUBNORMAL = float(np.float32(2.0 ** -149))        # 1.401298464324817e-45
MIN_NORMAL = float(np.float32(2.0 ** -126))           # 1.1754943508222875e-38
MAX_FINITE = float(np.float32(3.4028234663852886e38))

CASES = [
    ("empty", [], "빈 배열: 해시 입력 0바이트"),
    ("one_and_null", [1.0, None], "값 하나 + NULL 하나. NULL 은 해시 입력에서 00 00 C0 7F"),
    ("null_first", [None, 1.0], "NULL 위치가 바뀌면 checksum 이 바뀐다(one_and_null 과 비교)"),
    ("all_null", [None, None, None], "전부 NULL"),
    ("plus_zero_minus_zero", [0.0, -0.0], "±0 은 둘 다 +0 (00 00 00 00) 으로 정규화"),
    ("point_one", [0.1], "0.1 은 float32 로 0x3DCCCCCD"),
    ("rounding_tie_even", [1.0 + 2.0 ** -24], "1 + 2^-24 는 float32 중간값 → tie-to-even 으로 1.0"),
    ("rounding_tie_even_up", [1.0 + 3.0 * 2.0 ** -24], "1 + 3·2^-24 = 1 + 1.5 ulp → tie-to-even 으로 짝수 가수 1 + 2^-22 (0x3F800002)"),
    ("rounding_nearest_up", [1.0 + 2.0 ** -23 + 2.0 ** -26], "1 + 2^-23 + 2^-26 → 가장 가까운 1 + 2^-23 (0x3F800001)"),
    ("min_subnormal", [MIN_SUBNORMAL], "float32 최소 subnormal 2^-149, 보존 (01 00 00 00)"),
    ("below_min_subnormal_underflows_to_zero", [2.0 ** -151], "2^-151 은 float32 로 0 → +0 (오류 아님)"),
    ("min_normal", [MIN_NORMAL], "float32 최소 normal 2^-126 (00 00 80 00)"),
    ("max_finite", [MAX_FINITE], "float32 최대 유한값 (FF FF 7F 7F)"),
    ("just_below_overflow_midpoint_rounds_to_max", [3.4028235677973362e38], "2^128 − 2^103 바로 아래 double → FLT_MAX (FF FF 7F 7F). 범위 검사를 |x| > FLT_MAX 로 잘못 구현하면 overflow_midpoint 사례와 함께 걸린다"),
    ("typical_flux_segment", [1.0001, 0.9998, None, 0.9989, 1.0002, 1.0003], "Gold fixture 와 같은 6점 세그먼트"),
]
REJECT_CASES = [
    ("nan_rejected", [1.0, float("nan")], "non_finite_input", "실제 NaN 은 NULL 로 바꾸지 않고 거절"),
    ("positive_infinity_rejected", [float("inf")], "non_finite_input", "+Infinity 거절"),
    ("negative_infinity_rejected", [-float("inf")], "non_finite_input", "-Infinity 거절"),
    ("float32_overflow_rejected", [3.5e38], "float32_overflow", "float64 에서는 유한하지만 float32 범위 초과 → 거절"),
    ("float32_overflow_midpoint_rejected", [3.4028235677973366e38], "float32_overflow", "2^128 − 2^103 = FLT_MAX 와 2^128 의 중간값. tie-to-even 이 2^128(무한) 으로 올려 거절. |x| > FLT_MAX 검사로는 통과시키는 잘못된 구현을 잡는다"),
    ("non_numeric_rejected", ["1.0"], "non_numeric", "문자열 숫자 거절"),
]


def build() -> dict:
    cases = []
    for cid, values, note in CASES:
        norm = normalize_array(values)
        cases.append({"id": cid, "note": note, "input": values, "normalized": norm,
                      "hash_input_hex": canonical_bytes(norm).hex(), "sha256": array_checksum(norm)})
    rejects = []
    for cid, values, code, note in REJECT_CASES:
        try:
            normalize_array(values); raise AssertionError(cid)
        except ArrayCanonicalError as e:
            assert e.code == code, (cid, e.code)
        # JSON 은 NaN/Infinity 를 표현하지 못하므로 문자열 토큰으로 적는다. 구현은 자기 언어의 값으로 바꿔 검사한다.
        rejects.append({"id": cid, "note": note, "input_tokens": [("NaN" if isinstance(v, float) and v != v else "Infinity" if v == float("inf") else "-Infinity" if v == -float("inf") else v) for v in values],
                        "expected_error": code})
    return {
        "checksumVersion": CHECKSUM_VERSION, "jira": "S15P21C206-117", "status": "proposal-v0-not-team-approved",
        "rules": {
            "element_bytes": "float32 IEEE-754 little-endian, 4 bytes per element, array order",
            "null": "hash input only: 0x7FC00000 (bytes 00 00 C0 7F). Stored in DB as SQL NULL, never as NaN",
            "nan_inf": "real NaN / ±Infinity in input are rejected (non_finite_input); float32 overflow is rejected (float32_overflow)",
            "rounding": "float64 → float32 round-to-nearest-even; subnormals preserved; underflow to zero allowed and becomes +0",
            "negative_zero": "-0.0 → +0.0 after conversion",
            "output": "\"sha256:\" + lowercase hex (64 chars) of SHA-256 over the concatenated bytes",
            "db_precision": "REAL stores float32 exactly; read back via binary protocol or text with extra_float_digits ≥ 1 (PostgreSQL 12+ default 1 gives shortest round-trip)",
            "not_covered": "array length, reference integrity, grid rule, gaps consistency are checked separately; fold_reference_time_btjd is compared as exact float64, not hashed",
        },
        "verified_paths": {"python": "gold_roundtrip.canonical (tests/test_canonical.py)", "node": "contracts/gold/array-checksum.cjs", "java": "not executed in this repository", "postgresql": "experiments/gold-roundtrip roundtrip (REAL[] round-trip)"},
        "cases": cases, "reject_cases": rejects,
    }


def write(path: Path) -> None:
    path.write_text(json.dumps(build(), ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")


CAND_A = {"id": 401, "updated_bundle_id": 101, "local_key": "a", "tic_id": 1, "status": "active", "removal_step": 0, "period_days": 3.35992, "epoch_btjd": 1461.01464,
          "duration_hours": 1.294, "depth_ppm": 976.6941, "bls_power": 0.5, "discoverable": True, "is_confirmed": True,
          "transit_model": {"candidate_id": "c-401", "shape": "box", "parameters": {"period_days": 3.35992, "epoch_btjd": 1461.01464, "duration_hours": 1.294, "depth_ppm": 976.6941},
                            "baseline": {"kind": "unity"}, "residual_model_version": "box-divide-v0"}}
CAND_B = {**CAND_A, "id": 402, "local_key": "b", "removal_step": 1, "period_days": 5.66051, "epoch_btjd": 1463.08056, "duration_hours": 1.682, "depth_ppm": 3451.844,
          "transit_model": {**CAND_A["transit_model"], "candidate_id": "c-402", "parameters": {"period_days": 5.66051, "epoch_btjd": 1463.08056, "duration_hours": 1.682, "depth_ppm": 3451.844}}}
RECORD_CASES = [
    ("empty_list", "candidates", [], "빈 컬렉션도 checksum 이 정의된다(list 0개 인코딩)"),
    ("candidates_two", "candidates", [CAND_A, CAND_B], "DB id(id·updated_bundle_id·transit_model.candidate_id)·fixture 키(local_key)·tic_id 제외, removal_step 순"),
    ("candidates_two_reversed_input", "candidates", [CAND_B, CAND_A], "입력 순서를 바꿔도 같은 checksum (candidates_two 와 비교)"),
    ("candidates_two_different_db_ids", "candidates", [{**CAND_A, "id": 9001, "transit_model": {**CAND_A["transit_model"], "candidate_id": "c-9001"}}, {**CAND_B, "id": 9002}],
     "DB id 가 달라도 같은 checksum (candidates_two 와 비교)"),
    ("ai_results_null_score", "ai_results", [{"id": 7, "candidate_id": 401, "execution_id": 3, "candidate_key": {"period_days": 3.35992, "epoch_btjd": 1461.01464},
                                              "model_version": "astronet-triage-1", "threshold_version": "ai-threshold-v0", "status": "failed", "score": None, "verdict": None}],
     "AI 실패: score·verdict null(0x00), status 문자열. DB id 제외"),
    ("external_tie_same_source_external_id", "external_statuses",
     [{"id": 1, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "TOI-270 b", "disposition": "confirmed", "period_days": 3.35992, "epoch_btjd": None, "fetched_on": "2026-09-10", "candidate_key": None},
      {"id": 2, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "TOI-270 b", "disposition": "pc", "period_days": 3.35992, "epoch_btjd": None, "fetched_on": "2026-09-01", "candidate_key": None}],
     "정렬 키(source, external_id)가 같은 두 행. 인코딩 바이트 tie-breaker 로 순서가 정해진다"),
    ("external_tie_reversed_input", "external_statuses",
     [{"id": 2, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "TOI-270 b", "disposition": "pc", "period_days": 3.35992, "epoch_btjd": None, "fetched_on": "2026-09-01", "candidate_key": None},
      {"id": 1, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "TOI-270 b", "disposition": "confirmed", "period_days": 3.35992, "epoch_btjd": None, "fetched_on": "2026-09-10", "candidate_key": None}],
     "위 사례의 입력 순서 반전. 같은 checksum 이어야 한다"),
    ("candidates_tie_same_business_key", "candidates",
     [{**CAND_A, "id": 1, "duration_hours": 1.294}, {**CAND_A, "id": 2, "duration_hours": 1.5}],
     "(removal_step, period_days, epoch_btjd) 가 같고 duration 만 다른 두 후보(V1 에 UNIQUE 없음). tie-breaker 적용"),
    ("candidates_tie_reversed_input", "candidates",
     [{**CAND_A, "id": 2, "duration_hours": 1.5}, {**CAND_A, "id": 1, "duration_hours": 1.294}],
     "위 사례의 입력 순서 반전. 같은 checksum 이어야 한다"),
    ("external_unicode", "external_statuses", [{"id": 1, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "TOI-270 b", "disposition": "confirmed",
                                                 "period_days": 3.35992, "epoch_btjd": 1461.01464, "fetched_on": "2026-09-10", "candidate_key": None},
                                                {"id": 2, "candidate_id": None, "tic_id": 1, "source": "nasa_exoplanet_archive", "external_id": "L 98-59 e", "disposition": "confirmed",
                                                 "period_days": 12.796, "epoch_btjd": None, "fetched_on": "2026-09-10", "candidate_key": None}],
     "문자열 UTF-8 길이 접두, null 필드, (source, external_id) 정렬"),
]


def build_records() -> dict:
    cases = []
    for cid, kind, records, note in RECORD_CASES:
        prepared = prepare_records(kind, records)
        b = canonical_record_bytes(prepared)
        cases.append({"id": cid, "kind": kind, "note": note, "input": records, "prepared": prepared,
                      "canonical_hex_prefix": b[:64].hex(), "canonical_length": len(b), "sha256": record_checksum(kind, records)})
    return {"recordChecksumVersion": RECORD_CHECKSUM_VERSION, "jira": "S15P21C206-117", "status": "proposal-v0-not-team-approved",
            "encoding": {"null": "0x00", "bool": "0x01 + 1 byte", "number": "0x02 + float64 LE (finite only, -0 -> +0, integers as float64)",
                         "string": "0x03 + u32 LE byte length + UTF-8", "list": "0x04 + u32 LE count + items", "object": "0x05 + u32 LE count + (key string, value) sorted by key UTF-8 bytes",
                         "collection": "sha256 over list-encoding of prepared records; prepared = exclude fields, then sort by sort_key",
                         "sort": "per key: number (float64 compare) < string (UTF-8 byte order) < null; when all keys tie, compare the canonical record bytes (total order)"},
            "rules": {k: {"exclude": list(v["exclude"]), "exclude_nested": [".".join(p) for p in v["exclude_nested"]], "sort_key": list(v["sort_key"])} for k, v in RECORD_RULES.items()},
            "verified_paths": {"python": "gold_roundtrip.canonical", "node": "contracts/gold/record-checksum.cjs", "java": "not executed", "postgresql": "gold-roundtrip recomputes candidates/external_statuses from DB rows"},
            "cases": cases}


def write_records(path: Path) -> None:
    path.write_text(json.dumps(build_records(), ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")

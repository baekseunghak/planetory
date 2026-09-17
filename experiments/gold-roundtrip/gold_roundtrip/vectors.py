"""언어 간 대조용 checksum 벡터 생성 (`contracts/gold/examples/array-checksum-vectors.v0.json`).

각 사례: 입력 배열(JSON; NULL 은 null) → 기대 정규화 배열, 해시 입력 hex, SHA-256. 거절 사례는 기대 오류 코드.
Java·Node 구현은 같은 입력으로 같은 hex·sha256 이 나와야 한다. Python 은 canonical.py 가, Node 는
`contracts/gold/array-checksum.cjs` 가 이 파일로 검증한다. Java 경로는 이 저장소에서 실행하지 않았다.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .canonical import CHECKSUM_VERSION, NULL_HASH_BYTES, ArrayCanonicalError, array_checksum, canonical_bytes, normalize_array

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
    ("typical_flux_segment", [1.0001, 0.9998, None, 0.9989, 1.0002, 1.0003], "Gold fixture 와 같은 6점 세그먼트"),
]
REJECT_CASES = [
    ("nan_rejected", [1.0, float("nan")], "non_finite_input", "실제 NaN 은 NULL 로 바꾸지 않고 거절"),
    ("positive_infinity_rejected", [float("inf")], "non_finite_input", "+Infinity 거절"),
    ("negative_infinity_rejected", [-float("inf")], "non_finite_input", "-Infinity 거절"),
    ("float32_overflow_rejected", [3.5e38], "float32_overflow", "float64 에서는 유한하지만 float32 범위 초과 → 거절"),
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

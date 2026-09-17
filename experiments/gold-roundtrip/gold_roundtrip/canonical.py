"""Gold 배열 checksum 직렬화 v0 와 bundle_version 계산.

checksum v0 = `array-f32le-null7fc00000-v0` (S15P21C206-117 제안, Codex 검토 반영, 팀 확정 전)

정규화 순서 (Publisher 가 적재 전에 한 번 수행하고, 같은 배열을 checksum 과 DB 적재에 쓴다):
  1. NULL 마스크를 먼저 보존한다. 값이 없는 원소(빈 bin)만 NULL 이다.
  2. 값이 있는 원소는 float64 에서 유한해야 한다. 실제 NaN·±Infinity 는 NULL 로 바꾸지 않고 **거절**한다(`ArrayCanonicalError`).
  3. float32 로 반올림한다(IEEE-754 round-to-nearest-even). 반올림 뒤에도 유한해야 한다(float32 범위 초과 → 거절).
     subnormal 은 그대로 보존한다. float32 최소 subnormal 보다 작아 0 으로 underflow 하면 0 이 되고 오류는 아니다(정책 명시).
  4. -0.0 은 +0.0 으로 정규화한다.
  5. 이 float32 배열이 정규화 결과다. DB 에는 이 값을 REAL 로, NULL 은 SQL NULL 로 넣는다.
해시 입력: 원소당 4바이트 little-endian. NULL 은 **해시 입력에서만** quiet NaN 정규형 0x7FC00000(바이트 00 00 C0 7F).
결과: "sha256:" + 소문자 hex 64자.

DB 왕복 정밀도: REAL 은 float32 를 정확히 저장한다. 조회는 바이너리 프로토콜(psycopg3 binary) 또는 텍스트일 때
`extra_float_digits = 3`(PostgreSQL 12+ 기본, 최단 왕복 표기)이어야 값이 보존된다. Backend 는 조회한 REAL 을 float32 로
받아 같은 바이트로 재계산한다.

배열 길이·참조 무결성·격자 규칙·gaps 정합성은 checksum 과 별개로 검사한다(roundtrip.py). `fold_reference_time_btjd` 는
배열 해시 대상이 아니고 의미 payload 의 float64 정확 비교 대상이다(69).

bundle_version 은 69 계약(`contracts/gold/validate.cjs` expectedBundleVersion)을 그대로 옮긴 것이다.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
from typing import Iterable, Sequence

import numpy as np

CHECKSUM_VERSION = "array-f32le-null7fc00000-v0"
NULL_HASH_BYTES = bytes.fromhex("0000c07f")            # float32 0x7FC00000 little-endian


class ArrayCanonicalError(ValueError):
    def __init__(self, code: str, index: int, message: str):
        super().__init__(f"{code} at index {index}: {message}")
        self.code = code
        self.index = index


def normalize_array(values: Sequence[float | None], *, allow_null: bool = True) -> list[float | None]:
    """규칙 1–4 를 적용한 float32 정규화 배열(파이썬 float, NULL 은 None).

    allow_null=False 인 배열(periodograms.power)에서 None 이 나오면 `null_not_allowed` 로 거절한다.
    """
    out: list[float | None] = []
    for i, v in enumerate(values):
        if v is None:
            if not allow_null:
                raise ArrayCanonicalError("null_not_allowed", i, "NULL 이 허용되지 않는 배열")
            out.append(None); continue
        if isinstance(v, bool) or not isinstance(v, (int, float, np.integer, np.floating)):
            raise ArrayCanonicalError("non_numeric", i, repr(v))
        v64 = float(v)
        if not math.isfinite(v64):
            raise ArrayCanonicalError("non_finite_input", i, repr(v64))
        with np.errstate(over="ignore"):
            f32 = np.float32(v64)
        if not np.isfinite(f32):
            raise ArrayCanonicalError("float32_overflow", i, repr(v64))
        if f32 == 0:
            f32 = np.float32(0.0)                              # -0.0 → +0.0 (underflow 로 0 이 된 값 포함)
        out.append(float(f32))
    return out


def canonical_bytes(normalized: Sequence[float | None]) -> bytes:
    """정규화된 배열의 해시 입력 바이트. 정규화 전 배열을 넘기면 안 된다."""
    parts = []
    for v in normalized:
        parts.append(NULL_HASH_BYTES if v is None else struct.pack("<f", v))
    return b"".join(parts)


def array_checksum(normalized: Sequence[float | None]) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(normalized)).hexdigest()


def normalize_and_checksum(values: Sequence[float | None]) -> tuple[list[float | None], str]:
    n = normalize_array(values)
    return n, array_checksum(n)


def float64_checksum(values: Iterable[float | None]) -> str:
    """Silver 기준 잔차(float64) 대조용. NaN/None 은 quiet NaN 0x7FF8000000000000. Gold 배열 checksum 과는 다른 용도."""
    parts = []
    for v in values:
        if v is None or (isinstance(v, float) and v != v):
            parts.append(struct.pack("<Q", 0x7FF8000000000000))
        else:
            parts.append(struct.pack("<d", float(v)))
    return "sha256:" + hashlib.sha256(b"".join(parts)).hexdigest()


def bundle_version(semantic_payload: dict) -> str:
    """69 계약: 정렬한 입력 snapshot·세그먼트 자연 키·계산 버전 행을 LF 로 연결한 SHA-256, 접두 pv1-."""
    lines = [f"input_snapshot:{i}" for i in semantic_payload["input_snapshot_ids"]]
    lines += [f"segment:{s['tic_id']}:{s['sector']}:{s['binning_revision']}" for s in semantic_payload["segments"]]
    lines += [f"version:{k}:{v}" for k, v in semantic_payload["calculation_versions"].items()]
    lines.sort()
    return "pv1-" + hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- 레코드 checksum (후보·AI·외부 상태) v0
#
# `record-canonical-v0`: 69 의미 payload 의 candidates_checksum·ai_results_checksum·external_statuses_checksum 용.
# 텍스트 숫자 표기(1.0 vs 1, 지수 표기)의 언어 차이를 피하려고 JSON 이 아닌 태그 바이트 열로 직렬화한다.
#   0x00 null | 0x01 bool(1바이트) | 0x02 number(float64 LE 8바이트, 유한만, -0→+0) | 0x03 string(u32 LE 길이 + UTF-8)
#   0x04 list(u32 LE 개수 + 원소들) | 0x05 object(u32 LE 개수 + (키 string, 값) 을 키의 UTF-8 바이트 오름차순)
# 정수는 float64 로 넣는다(2^53 이하 정확; tic_id·id 범위 안). NaN·Inf 는 거절.
# 컬렉션 checksum = "sha256:" + sha256( list 인코딩( 제외 필드를 뺀 레코드들을 정렬 키로 정렬한 것 ) ).
# 정렬: 키마다 숫자(float64 비교) < 문자열(UTF-8 바이트 순) < null. 모든 키가 같으면 준비된 레코드의 인코딩 바이트를 마지막 비교로 써
# 총순서를 만든다(입력 순서·언어별 문자열 비교 차이가 결과에 남지 않는다).
# DB 가 만든 값(id, updated_bundle_id, transit_model.candidate_id, bundle_id)과 fixture 전용 키(local_key)는 제외한다.

RECORD_CHECKSUM_VERSION = "record-canonical-v0"

RECORD_RULES = {
    "candidates": {"exclude": ("id", "updated_bundle_id", "local_key", "tic_id"), "exclude_nested": (("transit_model", "candidate_id"),),
                   "sort_key": ("removal_step", "period_days", "epoch_btjd")},
    "ai_results": {"exclude": ("id", "candidate_id", "execution_id"), "exclude_nested": (),
                   "sort_key": ("candidate_key.period_days", "candidate_key.epoch_btjd", "model_version")},
    "external_statuses": {"exclude": ("id", "candidate_id", "tic_id"), "exclude_nested": (),
                          "sort_key": ("source", "external_id")},
}


def _enc(value) -> bytes:
    if value is None:
        return b"\x00"
    if isinstance(value, bool):
        return b"\x01" + (b"\x01" if value else b"\x00")
    if isinstance(value, (int, float, np.integer, np.floating)):
        f = float(value)
        if not math.isfinite(f):
            raise ArrayCanonicalError("non_finite_input", -1, repr(value))
        if f == 0.0:
            f = 0.0
        return b"\x02" + struct.pack("<d", f)
    if isinstance(value, str):
        b = value.encode("utf-8")
        return b"\x03" + struct.pack("<I", len(b)) + b
    if isinstance(value, (list, tuple)):
        return b"\x04" + struct.pack("<I", len(value)) + b"".join(_enc(v) for v in value)
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-8"))
        return b"\x05" + struct.pack("<I", len(items)) + b"".join(_enc(k) + _enc(v) for k, v in items)
    raise ArrayCanonicalError("non_numeric", -1, f"지원하지 않는 타입 {type(value).__name__}")


def canonical_record_bytes(value) -> bytes:
    return _enc(value)


def _get(rec: dict, dotted: str):
    cur = rec
    for part in dotted.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur


def prepare_records(kind: str, records: Iterable[dict]) -> list[dict]:
    """제외 필드를 빼고 정렬 키로 정렬한 레코드 목록. 정렬은 (값이 None 이면 뒤로) 튜플 비교."""
    rule = RECORD_RULES[kind]
    out = []
    for r in records:
        c = json.loads(json.dumps(r, allow_nan=False))
        for k in rule["exclude"]:
            c.pop(k, None)
        for path in rule["exclude_nested"]:
            cur = c
            for part in path[:-1]:
                cur = cur.get(part, {}) if isinstance(cur, dict) else {}
            if isinstance(cur, dict):
                cur.pop(path[-1], None)
        out.append(c)

    def key(rec):
        # 정렬 키: 숫자 < 문자열(UTF-8 바이트 순) < null. 정렬 키가 모두 같으면 준비된 레코드의 인코딩 바이트로 마지막 비교(총순서).
        business = tuple((0, float(v), b"") if isinstance(v, (int, float)) else (1, 0.0, str(v).encode("utf-8")) if v is not None else (2, 0.0, b"")
                         for v in (_get(rec, k) for k in rule["sort_key"]))
        return (business, _enc(rec))
    return sorted(out, key=key)


def record_checksum(kind: str, records: Iterable[dict]) -> str:
    return "sha256:" + hashlib.sha256(canonical_record_bytes(prepare_records(kind, records))).hexdigest()

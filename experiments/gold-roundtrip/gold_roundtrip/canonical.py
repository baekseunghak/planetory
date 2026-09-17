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


def normalize_array(values: Sequence[float | None]) -> list[float | None]:
    """규칙 1–4 를 적용한 float32 정규화 배열(파이썬 float, NULL 은 None)."""
    out: list[float | None] = []
    for i, v in enumerate(values):
        if v is None:
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

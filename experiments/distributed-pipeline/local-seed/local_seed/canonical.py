"""Gold 계약의 checksum·bundle_version 규칙.

정본은 contracts/gold/publication-qa.md 3절(배열·레코드 checksum)과 contracts/gold/README.md 6절(bundle_version)이다.
같은 디렉터리 examples/ 의 대조 벡터를 tests/test_canonical.py 가 모두 재현한다.
"""
from __future__ import annotations

import copy
import hashlib
import math
import struct
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

ARRAY_CHECKSUM_VERSION = "array-f32le-null7fc00000-v0"
RECORD_CHECKSUM_VERSION = "record-canonical-v0"

# NULL 은 해시 입력에서만 float32 quiet NaN 정규형으로 쓴다(바이트 00 00 C0 7F). DB 에는 SQL NULL 이 들어간다.
_NULL_HASH_BYTES = struct.pack("<I", 0x7FC00000)

# DB 가 만드는 값은 checksum 에서 뺀다(publication-qa.md 3.2절 표).
RECORD_RULES = {
    "candidates": {
        "exclude": ("id", "updated_bundle_id", "tic_id", "local_key"),
        "exclude_nested": (("transit_model", "candidate_id"),),
        "sort_key": ("removal_step", "period_days", "epoch_btjd"),
    },
    "ai_results": {
        "exclude": ("id", "candidate_id", "execution_id"),
        "exclude_nested": (),
        "sort_key": ("candidate_key.period_days", "candidate_key.epoch_btjd", "model_version"),
    },
    "external_statuses": {
        "exclude": ("id", "candidate_id", "tic_id"),
        "exclude_nested": (),
        "sort_key": ("source", "external_id"),
    },
}


class CanonicalError(ValueError):
    """계약이 거절하는 값. code 는 벡터 파일의 expected_error 와 같다."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


def _is_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float, np.integer, np.floating))


def normalize_array(values: Iterable[Any], *, allow_null: bool = True) -> list[float | None]:
    """3.1절 1~4단계. 결과는 float32 로 정확히 표현되는 파이썬 float 와 None 이다."""
    out: list[float | None] = []
    for i, value in enumerate(values):
        if value is None:
            if not allow_null:
                raise CanonicalError("null_not_allowed", f"index {i}")
            out.append(None)
            continue
        if not _is_number(value):
            raise CanonicalError("non_numeric", f"index {i}: {value!r}")
        x = float(value)
        if not math.isfinite(x):
            raise CanonicalError("non_finite_input", f"index {i}: {x!r}")
        with np.errstate(over="ignore"):
            f32 = np.float32(x)
        if not np.isfinite(f32):
            raise CanonicalError("float32_overflow", f"index {i}: {x!r}")
        out.append(0.0 if f32 == 0 else float(f32))
    return out


def array_hash_input(normalized: Sequence[float | None]) -> bytes:
    """정규화한 배열의 해시 입력. 정규화 전 배열을 넘기지 않는다."""
    return b"".join(_NULL_HASH_BYTES if v is None else struct.pack("<f", v) for v in normalized)


def array_checksum(normalized: Sequence[float | None]) -> str:
    return "sha256:" + hashlib.sha256(array_hash_input(normalized)).hexdigest()


def encode_record(value: Any) -> bytes:
    """3.2절 태그 바이트 열."""
    if value is None:
        return b"\x00"
    if isinstance(value, bool):
        return b"\x01" + (b"\x01" if value else b"\x00")
    if _is_number(value):
        x = float(value)
        if not math.isfinite(x):
            raise CanonicalError("non_finite_input", repr(value))
        return b"\x02" + struct.pack("<d", 0.0 if x == 0 else x)
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return b"\x03" + struct.pack("<I", len(raw)) + raw
    if isinstance(value, (list, tuple)):
        return b"\x04" + struct.pack("<I", len(value)) + b"".join(encode_record(v) for v in value)
    if isinstance(value, Mapping):
        items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-8"))
        return b"\x05" + struct.pack("<I", len(items)) + b"".join(
            encode_record(k) + encode_record(v) for k, v in items)
    raise CanonicalError("non_numeric", f"지원하지 않는 타입 {type(value).__name__}")


def _dotted(record: Mapping[str, Any], path: str) -> Any:
    value: Any = record
    for part in path.split("."):
        value = value.get(part) if isinstance(value, Mapping) else None
    return value


def prepare_records(kind: str, records: Iterable[Mapping[str, Any]]) -> list[dict]:
    """DB 생성 값을 빼고 정렬한다. 정렬 키가 모두 같으면 인코딩 바이트로 총순서를 만든다."""
    rule = RECORD_RULES[kind]
    prepared = []
    for record in records:
        r = copy.deepcopy(dict(record))
        for key in rule["exclude"]:
            r.pop(key, None)
        for path in rule["exclude_nested"]:
            parent: Any = r
            for part in path[:-1]:
                parent = parent.get(part) if isinstance(parent, dict) else None
            if isinstance(parent, dict):
                parent.pop(path[-1], None)
        prepared.append(r)

    def order(r: dict) -> tuple:
        parts = []
        for path in rule["sort_key"]:
            v = _dotted(r, path)
            if v is None:
                parts.append((2, 0.0, b""))
            elif isinstance(v, str):
                parts.append((1, 0.0, v.encode("utf-8")))
            elif _is_number(v):
                parts.append((0, float(v), b""))
            else:
                raise CanonicalError("invalid_sort_key_type", f"{kind}.{path}: {type(v).__name__}")
        return tuple(parts), encode_record(r)

    return sorted(prepared, key=order)


def record_checksum(kind: str, records: Iterable[Mapping[str, Any]]) -> str:
    return "sha256:" + hashlib.sha256(encode_record(prepare_records(kind, records))).hexdigest()


def bundle_version(input_snapshot_ids: Iterable[str], segment_keys: Iterable[tuple[int, int, str]],
                   calculation_versions: Mapping[str, str]) -> str:
    """contracts/gold/validate.cjs 의 expectedBundleVersion 과 같은 규칙(pv1-sha256-sorted-lf-utf8)."""
    lines = [f"input_snapshot:{i}" for i in input_snapshot_ids]
    lines += [f"segment:{tic}:{sector}:{revision}" for tic, sector, revision in segment_keys]
    lines += [f"version:{name}:{version}" for name, version in calculation_versions.items()]
    lines.sort()
    return "pv1-" + hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()

"""contracts/gold/examples 의 언어 간 대조 벡터를 그대로 재현한다(DB 없이 실행)."""
import json
from pathlib import Path

import pytest

from local_seed.canonical import (CanonicalError, array_checksum, array_hash_input, bundle_version,
                                  encode_record, normalize_array, prepare_records, record_checksum)

EXAMPLES = Path(__file__).resolve().parents[4] / "contracts" / "gold" / "examples"
ARRAY = json.loads((EXAMPLES / "array-checksum-vectors.v0.json").read_text(encoding="utf-8"))
RECORD = json.loads((EXAMPLES / "record-checksum-vectors.v0.json").read_text(encoding="utf-8"))
SCENARIOS = json.loads((EXAMPLES / "publication-load-scenarios.json").read_text(encoding="utf-8"))

# JSON 에 쓸 수 없는 값은 벡터 파일이 문자열 토큰으로 적는다. 그 밖의 문자열은 그대로 둔다(non_numeric 사례).
_TOKENS = {"NaN": float("nan"), "Infinity": float("inf"), "-Infinity": float("-inf")}


@pytest.mark.parametrize("case", ARRAY["cases"], ids=lambda c: c["id"])
def test_array_vectors(case):
    normalized = normalize_array(case["input"])
    assert normalized == case["normalized"]
    assert array_hash_input(normalized).hex() == case["hash_input_hex"]
    assert array_checksum(normalized) == case["sha256"]


@pytest.mark.parametrize("case", ARRAY["reject_cases"], ids=lambda c: c["id"])
def test_array_rejections(case):
    values = [_TOKENS.get(v, v) if isinstance(v, str) else v for v in case["input_tokens"]]
    with pytest.raises(CanonicalError) as caught:
        normalize_array(values)
    assert caught.value.code == case["expected_error"]


def test_power_rejects_null():
    with pytest.raises(CanonicalError) as caught:
        normalize_array([1.0, None], allow_null=False)
    assert caught.value.code == "null_not_allowed"


@pytest.mark.parametrize("case", RECORD["cases"], ids=lambda c: c["id"])
def test_record_vectors(case):
    prepared = prepare_records(case["kind"], case["input"])
    assert prepared == case["prepared"]
    encoded = encode_record(prepared)
    assert len(encoded) == case["canonical_length"]
    assert encoded.hex().startswith(case["canonical_hex_prefix"])
    assert record_checksum(case["kind"], case["input"]) == case["sha256"]


@pytest.mark.parametrize("name", sorted(SCENARIOS["payloads"]))
def test_bundle_version_matches_load_scenarios(name):
    payload = SCENARIOS["payloads"][name]
    semantic = payload["semantic_payload"]
    segments = [(s["tic_id"], s["sector"], s["binning_revision"]) for s in semantic["segments"]]
    got = bundle_version(semantic["input_snapshot_ids"], segments, semantic["calculation_versions"])
    assert got == payload["bundle_version"]

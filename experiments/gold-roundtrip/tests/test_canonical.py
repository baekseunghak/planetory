import json
import math
from pathlib import Path

import pytest

from gold_roundtrip import canonical as c
from gold_roundtrip import vectors

REPO = Path(__file__).resolve().parents[3]
VECTORS = REPO / "contracts" / "gold" / "examples" / "array-checksum-vectors.v0.json"


def test_null_only_in_hash_input_and_positions_matter():
    a = c.normalize_array([1.0, None]); b = c.normalize_array([None, 1.0])
    assert a == [1.0, None] and b == [None, 1.0]                      # DB 에는 None(SQL NULL) 그대로
    assert c.canonical_bytes(a).hex() == "0000803f" + "0000c07f"
    assert c.array_checksum(a) != c.array_checksum(b)


def test_rejects_nan_inf_and_overflow_instead_of_null():
    for bad, code in (([float("nan")], "non_finite_input"), ([float("inf")], "non_finite_input"), ([3.5e38], "float32_overflow"), (["1"], "non_numeric")):
        with pytest.raises(c.ArrayCanonicalError) as info:
            c.normalize_array(bad)
        assert info.value.code == code and info.value.index == 0


def test_float32_rounding_zero_and_subnormal_policy():
    assert c.normalize_array([-0.0, 0.0]) == [0.0, 0.0] and math.copysign(1, c.normalize_array([-0.0])[0]) == 1.0
    assert c.normalize_array([1.0 + 2.0 ** -24]) == [1.0]                    # tie-to-even
    assert c.normalize_array([1.0 + 3.0 * 2.0 ** -24]) == [1.0 + 2.0 ** -22]     # 1.5 ulp → tie-to-even 은 짝수 가수(1+2^-22)
    assert c.canonical_bytes(c.normalize_array([2.0 ** -149])).hex() == "01000000"   # subnormal 보존
    assert c.normalize_array([2.0 ** -151]) == [0.0]                          # underflow → +0, 오류 아님
    assert c.canonical_bytes(c.normalize_array([3.4028234663852886e38])).hex() == "ffff7f7f"


def test_vectors_file_reproduces():
    if not VECTORS.exists():
        pytest.skip("vectors file not generated yet")
    fx = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert fx["checksumVersion"] == c.CHECKSUM_VERSION
    for case in fx["cases"]:
        n = c.normalize_array(case["input"])
        assert n == case["normalized"], case["id"]
        assert c.canonical_bytes(n).hex() == case["hash_input_hex"], case["id"]
        assert c.array_checksum(n) == case["sha256"], case["id"]
    assert vectors.build()["cases"] == fx["cases"]                          # 생성기와 파일이 같다


def test_bundle_version_matches_69_fixture_rule():
    payload = {"input_snapshot_ids": ["b", "a"], "segments": [{"tic_id": 1, "sector": 2, "binning_revision": "10m-v1"}],
               "calculation_versions": {"residual_model": "box-divide-v0", "bls_config": "x"}}
    v = c.bundle_version(payload)
    assert v.startswith("pv1-") and len(v) == 4 + 64
    assert v == c.bundle_version({**payload, "input_snapshot_ids": ["a", "b"]})   # 정렬 불변

import json
import os
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]
PAYLOAD = PKG / "fixtures" / "gold-toi270-s3.json"


def _db_available() -> bool:
    try:
        import psycopg
        from gold_roundtrip.roundtrip import DEFAULT_URL
        with psycopg.connect(os.environ.get("DATABASE_URL", DEFAULT_URL), connect_timeout=2):
            return True
    except Exception:
        return False


@pytest.mark.skipif(not PAYLOAD.exists(), reason="payload fixture 없음 (python -m gold_roundtrip build)")
def test_payload_fixture_is_self_consistent():
    from gold_roundtrip.canonical import array_checksum, bundle_version, normalize_array
    fx = json.loads(PAYLOAD.read_text(encoding="utf-8"))
    seg = fx["segments"][0]
    norm = normalize_array(seg["flux"])
    assert len(seg["flux"]) == seg["n_points"] and normalize_array(norm) == norm                  # 정규화는 멱등(파일은 float32 최단 십진 표기)
    assert all(seg["flux"][i] is None for a, b in seg["gaps"] for i in range(a, b + 1))
    key = f"segment:{seg['sector']}:{seg['binning_revision']}:flux"
    assert fx["checksums"][key] == array_checksum(norm)
    assert fx["checksums"]["periodogram:power"] == array_checksum(normalize_array(fx["periodogram"]["power"]))
    assert len(fx["periodogram"]["power"]) == fx["periodogram"]["n_periods"] == 5000
    m = fx["bundle"]["manifest"]
    assert bundle_version({"input_snapshot_ids": m["input_snapshot_ids"], "segments": [{"tic_id": seg["tic_id"], "sector": seg["sector"], "binning_revision": seg["binning_revision"]}],
                           "calculation_versions": m["calculation_versions"]}) == fx["bundle"]["bundle_version"]
    cases = fx["expected_residuals"]["cases"]
    assert cases["remove_first_two"]["residual_checksum_f64"] == cases["remove_first_two_reversed"]["residual_checksum_f64"]
    assert cases["remove_none"]["n_in_transit_bins"] == 0 and cases["remove_all"]["n_in_transit_bins"] > 0
    assert cases["invalid_model_zero_depth"]["expected_error"] == "invalid_parameter"


@pytest.mark.skipif(not PAYLOAD.exists() or not _db_available(), reason="PostgreSQL 컨테이너 또는 payload 없음")
def test_roundtrip_against_local_postgres():
    from gold_roundtrip import roundtrip
    result = roundtrip.run(json.loads(PAYLOAD.read_text(encoding="utf-8")))
    assert result["n_failed"] == 0, [c for c in result["checks"] if not c["ok"]]

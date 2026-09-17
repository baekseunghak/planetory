"""공개 전 QA 가 손상 payload 를 실제로 거절하는지 (MR !64 리뷰 차단 사항 1)."""
import json
from pathlib import Path

import pytest

from gold_roundtrip import qa
from gold_roundtrip import canonical as c

PKG = Path(__file__).resolve().parents[1]
PAYLOAD = PKG / "fixtures" / "gold-toi270-s3.json"
pytestmark = pytest.mark.skipif(not PAYLOAD.exists(), reason="payload fixture 없음 (python -m gold_roundtrip build)")


def _load():
    return json.loads(PAYLOAD.read_text(encoding="utf-8"))


def _failed_names(payload):
    return {f["check"] for f in qa.failed(qa.validate_payload(payload))}


def test_clean_payload_passes_all_checks():
    assert qa.failed(qa.validate_payload(_load())) == []


def test_missing_gap_declaration_is_rejected():
    p = _load(); seg = p["segments"][0]
    seg["gaps"] = []                                                        # NULL 은 그대로 있는데 gaps 가 비었다
    names = _failed_names(p)
    assert any(n.endswith("gaps_equal_null_runs_both_directions") for n in names)


def test_extra_gap_declaration_is_rejected():
    p = _load(); seg = p["segments"][0]
    i = next(k for k, v in enumerate(seg["flux"]) if v is not None)
    seg["gaps"] = seg["gaps"] + [[i, i]]                                     # 값이 있는 bin 을 gap 이라고 선언
    assert any(n.endswith("gaps_equal_null_runs_both_directions") for n in _failed_names(p))


def test_power_null_is_rejected():
    p = _load(); p["periodogram"]["power"][0] = None
    names = _failed_names(p)
    assert "power_no_null_and_finite" in names


def test_power_nan_is_rejected_not_nulled():
    p = _load(); p["periodogram"]["power"][5] = float("nan")
    assert "power_no_null_and_finite" in _failed_names(p)


def test_tampered_flux_breaks_checksum():
    p = _load(); seg = p["segments"][0]
    i = next(k for k, v in enumerate(seg["flux"]) if v is not None); seg["flux"][i] = seg["flux"][i] + 1e-3
    assert any(n.endswith("flux_checksum_matches") for n in _failed_names(p))


def test_candidate_change_breaks_record_checksum_but_db_id_does_not():
    p = _load()
    p["candidates"][0]["depth_ppm"] += 1.0
    assert "candidates_checksum_matches" in _failed_names(p)
    q = _load()
    q["candidates"][0]["id"] = 999; q["candidates"][0]["transit_model"]["candidate_id"] = "c-999"   # DB 생성 값은 무시
    assert "candidates_checksum_matches" not in _failed_names(q)


def test_snapshot_ids_must_be_content_based():
    p = _load(); p["bundle"]["manifest"]["input_snapshot_ids"] = ["lc:spoc:file.fits"]
    names = _failed_names(p)
    assert "input_snapshot_ids_content_based" in names and "bundle_version_matches_69_rule" in names


def test_record_checksum_rules():
    a = {"id": 1, "updated_bundle_id": 5, "removal_step": 1, "period_days": 5.0, "epoch_btjd": 1.0, "transit_model": {"candidate_id": "c-1", "shape": "box"}}
    b = {"id": 2, "updated_bundle_id": 5, "removal_step": 0, "period_days": 3.0, "epoch_btjd": 1.0, "transit_model": {"candidate_id": "c-2", "shape": "box"}}
    assert c.record_checksum("candidates", [a, b]) == c.record_checksum("candidates", [b, a])
    assert c.record_checksum("candidates", [{**a, "id": 77}]) == c.record_checksum("candidates", [a])
    assert c.record_checksum("candidates", [{**a, "period_days": 5.0001}]) != c.record_checksum("candidates", [a])
    assert c.canonical_record_bytes(None) == b"\x00" and c.canonical_record_bytes(True) == b"\x01\x01"
    assert c.canonical_record_bytes(-0.0) == c.canonical_record_bytes(0.0) and c.canonical_record_bytes(1) == c.canonical_record_bytes(1.0)
    assert c.canonical_record_bytes({"b": 1, "a": 2}) == c.canonical_record_bytes({"a": 2, "b": 1})
    with pytest.raises(c.ArrayCanonicalError):
        c.canonical_record_bytes(float("inf"))

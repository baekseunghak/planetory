import json
import os
from pathlib import Path

import numpy as np
import pytest

PKG = Path(__file__).resolve().parents[1]
PAYLOAD = PKG / "fixtures" / "gold-toi270-s3.json"
FITS_DIR = PKG.parents[0] / "tess-fixture" / "sample_raw" / "toi270"


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
    from gold_roundtrip.canonical import array_checksum, bundle_version, normalize_array, record_checksum
    fx = json.loads(PAYLOAD.read_text(encoding="utf-8"))
    assert "generated_at" not in fx                                                              # 재생성 시 diff 없음
    seg = fx["segments"][0]
    norm = normalize_array(seg["flux"])
    assert len(seg["flux"]) == seg["n_points"] and normalize_array(norm) == norm                  # 정규화는 멱등(파일은 float32 최단 십진 표기)
    assert all(seg["flux"][i] is None for a, b in seg["gaps"] for i in range(a, b + 1))
    key = f"segment:{seg['sector']}:{seg['binning_revision']}:flux"
    assert fx["checksums"][key] == array_checksum(norm)
    assert fx["checksums"]["periodogram:power"] == array_checksum(normalize_array(fx["periodogram"]["power"], allow_null=False))
    assert len(fx["periodogram"]["power"]) == fx["periodogram"]["n_periods"] == 5000
    m = fx["bundle"]["manifest"]
    assert bundle_version({"input_snapshot_ids": m["input_snapshot_ids"], "segments": [{"tic_id": seg["tic_id"], "sector": seg["sector"], "binning_revision": seg["binning_revision"]}],
                           "calculation_versions": m["calculation_versions"]}) == fx["bundle"]["bundle_version"]
    assert all(":sha256:" in i for i in m["input_snapshot_ids"])
    assert m["record_checksums"]["candidates"] == record_checksum("candidates", fx["candidates"])
    assert m["record_checksums"]["external_statuses"] == record_checksum("external_statuses", fx["external_statuses"])
    assert m["record_checksums"]["ai_results"] == record_checksum("ai_results", fx["ai_results"])
    cases = fx["expected_residuals"]["cases"]
    assert cases["remove_first_two"]["residual_checksum_f64"] == cases["remove_first_two_reversed"]["residual_checksum_f64"]
    assert cases["remove_none"]["n_in_transit_bins"] == 0 and cases["remove_all"]["n_in_transit_bins"] > 0
    assert cases["invalid_model_zero_depth"]["expected_error"] == "invalid_parameter"


@pytest.mark.skipif(not PAYLOAD.exists(), reason="payload fixture 없음")
def test_expected_residuals_recompute_from_fixture_arrays():
    """기대값 drift 검출: fixture 의 flux·모델·bin 중심 시각으로 잔차를 다시 계산해 checksum·표본과 대조한다."""
    from astro_kernel import remove_transit_models
    from gold_roundtrip.canonical import float64_checksum, normalize_array
    fx = json.loads(PAYLOAD.read_text(encoding="utf-8"))
    seg = fx["segments"][0]
    flux = np.array([np.nan if v is None else v for v in normalize_array(seg["flux"])], float)
    centers = seg["start_btjd"] + (np.arange(seg["n_points"]) + 0.5) * seg["bin_minutes"] / 1440.0
    by_key = {c["local_key"]: c["transit_model"] for c in fx["candidates"]}
    for name, case in fx["expected_residuals"]["cases"].items():
        if name == "invalid_model_zero_depth":
            continue
        r = remove_transit_models(centers, flux, [by_key[k] for k in case["model_ids"]])
        assert float64_checksum(r.flux_residual.tolist()) == case["residual_checksum_f64"], name
        assert (r.n_valid_input, r.n_finite_residual) == (case["n_valid_input"], case["n_finite_residual"]), name
        for s in case["sample"]:
            got = r.flux_residual[s["index"]]
            assert (s["residual"] is None and not np.isfinite(got)) or got == s["residual"], (name, s["index"])


@pytest.mark.skipif(not FITS_DIR.exists(), reason="TOI-270 FITS 없음")
def test_fold_reference_time_ignores_preprocessing():
    """리뷰 차단 사항 2: 기준 시각은 DAT-02 품질 필터·유한성만 통과한 원본 시각의 중앙값이며 clipping 에 따라 바뀌지 않는다."""
    from tess_fixture.lightcurve import build_baseline, load_sector
    from tess_bench.preprocess import load_settings, preprocess
    from gold_roundtrip import build_payload as bp
    curve = load_sector(next(FITS_DIR.glob("*s0003*")))
    base = build_baseline([curve])
    ref = bp.fold_reference_time(base)
    assert ref == float(np.median(np.unique(base.time)))
    cfg, settings = load_settings(bp.BENCH_DIR / "configs" / "preprocess_settings_v1.json", ["poc_baseline", "biweight_1.0d"])
    kept_medians = set()
    for s in settings:
        pre = preprocess(base.time, base.flux, base.sector_of_point, s)
        kept_medians.add(float(np.median(pre.time[pre.kept & np.isfinite(pre.flux_det)])))
        assert bp.fold_reference_time(base) == ref                                                  # 전처리를 돌려도 값이 같다
    assert len(kept_medians) >= 1                                                                  # (참고) clipping 기반 중앙값은 설정마다 다를 수 있다
    if PAYLOAD.exists():
        fx = json.loads(PAYLOAD.read_text(encoding="utf-8"))
        assert fx["bundle"]["fold_reference_time_btjd"] == ref


@pytest.mark.skipif(not PAYLOAD.exists() or not _db_available(), reason="PostgreSQL 컨테이너 또는 payload 없음")
def test_roundtrip_against_local_postgres():
    from gold_roundtrip import roundtrip
    result = roundtrip.run(json.loads(PAYLOAD.read_text(encoding="utf-8")))
    assert result["n_failed"] == 0 and result["decision"] == "PUBLISHED", [c for c in result["checks"] if not c["ok"]]
    names = [c["check"] for c in result["checks"]]
    assert names[-1] == "publish_decision" and all(c["ok"] for c in result["checks"][:-1])                # commit 은 마지막 한 번, 그 전 검사 전부 통과
    assert names.index("status_staging_before_transition") < names.index("current_transition_before_commit") < names.index("second_current_rejected_partial_unique_index")


@pytest.mark.skipif(not PAYLOAD.exists() or not _db_available(), reason="PostgreSQL 컨테이너 또는 payload 없음")
def test_roundtrip_rejects_corrupted_payload_without_loading():
    from gold_roundtrip import roundtrip
    fx = json.loads(PAYLOAD.read_text(encoding="utf-8"))
    fx["segments"][0]["gaps"] = []; fx["periodogram"]["power"][0] = None
    result = roundtrip.run(fx)
    assert result["decision"] == "PUBLISH_REJECTED" and result["schema"] is None
    failed = {c["check"] for c in result["checks"] if not c["ok"]}
    assert "qa:power_no_null_and_finite" in failed and any(f.endswith("gaps_equal_null_runs_both_directions") for f in failed)


def test_fold_reference_time_removes_duplicate_times():
    """리뷰 차단 사항(3차) 2: 중복 시각 제거 뒤 중앙값. 단일 Sector fixture 에서는 드러나지 않아 합성 사례로 검사한다."""
    from types import SimpleNamespace
    from gold_roundtrip import build_payload as bp
    times = np.array([1.0, 2.0, 2.0, 2.0, 3.0, 10.0])          # 중복 있는 원본: 중앙값 2.0 / 중복 제거 뒤 [1,2,3,10] 중앙값 2.5
    base = SimpleNamespace(time=times)
    assert bp.fold_reference_time(base) == 2.5
    assert float(np.median(times)) == 2.0                            # 중복을 제거하지 않으면 다른 값
    assert bp.fold_reference_time(SimpleNamespace(time=np.array([4.0, 1.0, 3.0, 2.0]))) == 2.5   # 정렬·짝수 평균

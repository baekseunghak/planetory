"""examples/ 의 계약 예제가 코드와 일치하는지, 그리고 numpy 없이 독립 계산한 값과도 일치하는지 확인한다.

소비자(88 Worker, 131 검증)는 같은 파일로 자기 구현을 대조한다.
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from astro_kernel import transit_model as tm

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


def _load(name):
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


def _arr(values):
    return np.array([np.nan if v is None else v for v in values], dtype=np.float64)


def _independent_residual(times, flux, models):
    """순수 파이썬 float 로 계약 수식을 다시 계산한다(numpy 미사용). 정렬 순서와 연산 순서는 계약과 같다.

    수식: dist = (t - epoch + P/2) % P - P/2, |dist| < D/2 → 1 - depth_ppm/1e6, 모델 곱은 정렬 키 순, 잔차 = flux / 곱.
    """
    ordered = sorted(models, key=lambda m: (m["parameters"]["period_days"], m["parameters"]["epoch_btjd"],
                                            m["parameters"]["duration_hours"], m["parameters"]["depth_ppm"],
                                            m["shape"], m.get("candidate_id") or ""))
    out = []
    for t, f in zip(times, flux):
        prod = 1.0
        for m in ordered:
            p = m["parameters"]
            period, epoch = p["period_days"], p["epoch_btjd"]
            half = 0.5 * (p["duration_hours"] / 24.0)
            dist = math.fmod((t - epoch + 0.5 * period), period)      # numpy % 와 부호 규약이 달라 아래에서 보정
            if dist < 0:
                dist += period
            dist -= 0.5 * period
            value = 1.0 - p["depth_ppm"] / 1e6 if abs(dist) < half else 1.0
            prod *= value
        out.append(None if f is None else f / prod)
    return out


def test_valid_examples_parse_and_round_trip():
    models = _load("transit_model.valid.json")
    assert len(models) >= 2
    for obj in models:
        m = tm.parse_transit_model(obj)
        assert m.to_dict() == obj


def test_invalid_examples_fail_with_documented_code():
    cases = _load("transit_model.invalid.json")
    assert {c["expected_code"] for c in cases} >= {
        "unsupported_shape", "missing_parameter", "unknown_parameter", "invalid_parameter",
        "unsupported_baseline", "unsupported_version"}
    for c in cases:
        with pytest.raises(tm.TransitModelError) as info:
            tm.parse_transit_model(c["model"])
        assert info.value.code == c["expected_code"], c["case"]


def test_removal_case_reproduces_expected_arrays_bitwise():
    case = _load("removal_case.json")
    seg = case["segment"]
    t = tm.segment_times(seg["start_btjd"], seg["bin_minutes"], seg["n_points"])
    np.testing.assert_array_equal(t, _arr(case["time_btjd"]))
    observed = _arr(case["flux_observed"])
    by_id = {m["candidate_id"]: m for m in case["models"]}

    for key, exp in case["expected"].items():
        models = [by_id[i] for i in exp["model_ids"]]
        r = tm.remove_transit_models(t, observed, models)
        expected = _arr(exp["flux_residual"])
        np.testing.assert_array_equal(r.flux_residual, expected, err_msg=key)
        assert np.array_equal(r.flux_residual.view(np.uint64), expected.view(np.uint64)), key   # 비트 비교
        if "model_flux" in exp:
            np.testing.assert_array_equal(r.model_flux, _arr(exp["model_flux"]), err_msg=key)
        if "residual_model_version" in exp:
            assert r.residual_model_version == exp["residual_model_version"]
        if "n_valid_input" in exp:
            assert (r.n_valid_input, r.n_finite_residual) == (exp["n_valid_input"], exp["n_finite_residual"])

    both = case["expected"]["remove_all"]["model_ids"]
    swapped = tm.remove_transit_models(t, observed, [by_id[i] for i in reversed(both)])
    np.testing.assert_array_equal(swapped.flux_residual, _arr(case["expected"]["remove_all"]["flux_residual"]))
    np.testing.assert_array_equal(tm.remove_transit_models(t, observed, []).flux_residual, observed)


def test_removal_case_matches_independent_pure_python_computation():
    """기대값이 이 패키지 출력의 단순 복사가 아님을 보이기 위해 numpy 없는 계산과 대조한다."""
    case = _load("removal_case.json")
    by_id = {m["candidate_id"]: m for m in case["models"]}
    for key, exp in case["expected"].items():
        models = [by_id[i] for i in exp["model_ids"]]
        indep = _independent_residual(case["time_btjd"], case["flux_observed"], models)
        for i, (a, b) in enumerate(zip(indep, exp["flux_residual"])):
            assert (a is None) == (b is None), (key, i)
            if a is not None:
                assert a == b, (key, i, a, b)                    # 순수 파이썬 float 와 값 동일

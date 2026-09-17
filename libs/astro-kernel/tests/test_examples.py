"""계약 예제가 코드와 일치하는지, 그리고 numpy 없이 독립 계산한 값과도 일치하는지 확인한다.

모델 JSON 의 정상·불량 예제는 `contracts/gold/examples/transit-model.*.json`(113 정본), 잔차 계산 예제는 이 패키지의
`examples/`(removal_case·bin_center_case) 에 있다. 소비자(88 Worker, 131 검증)는 같은 파일로 자기 구현을 대조한다.
"""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from astro_kernel import transit_model as tm

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
CONTRACT_EXAMPLES = Path(__file__).resolve().parents[3] / "contracts" / "gold" / "examples"


def _load(name):
    root = CONTRACT_EXAMPLES if name.startswith("transit-model.") else EXAMPLES
    return json.loads((root / name).read_text(encoding="utf-8"))


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
    models = _load("transit-model.valid.json")
    assert len(models) >= 2
    for obj in models:
        m = tm.parse_transit_model(obj)
        expected = {**obj}
        expected.setdefault("baseline", {"kind": "unity"})              # 생략 가능 키는 기본값으로 채워져 나온다
        expected.setdefault("residual_model_version", "box-divide-v0")
        assert m.to_dict() == expected


def test_invalid_examples_fail_with_documented_code():
    cases = _load("transit-model.invalid.json")
    assert {c["expected_code"] for c in cases} >= {
        "unsupported_shape", "missing_parameter", "unknown_parameter", "invalid_parameter",
        "unsupported_baseline", "unsupported_version", "invalid_type"}
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


def test_bin_center_case_shows_caller_must_shift_gold_segment_times():
    """113 결정: Gold 세그먼트는 bin 중심(`start_btjd + bin_minutes/2880`)에서 모델을 평가하고, 이동은 호출자가 한다.

    경계 bin 하나가 bin 시작 시각에서는 통과 안, bin 중심에서는 통과 밖이 되는 예제다. 두 결과가 다르므로 Worker(88)가
    이동을 빠뜨리면 이 예제로 드러난다. 커널은 넘겨받은 시각에서 그대로 평가한다(커널 수정 없음).
    """
    case = _load("bin_center_case.json")
    seg = case["segment"]
    t_start = tm.segment_times(seg["start_btjd"], seg["bin_minutes"], seg["n_points"])
    t_center = t_start + seg["bin_minutes"] / 2880.0
    np.testing.assert_array_equal(t_center, _arr(case["time_bin_center_btjd"]))
    observed = _arr(case["flux_observed"])
    for key, times in (("evaluated_at_bin_start", t_start), ("evaluated_at_bin_center", t_center)):
        exp = case["expected"][key]
        r = tm.remove_transit_models(times, observed, case["models"])
        np.testing.assert_array_equal(r.flux_residual, _arr(exp["flux_residual"]), err_msg=key)
        assert [i for i, v in enumerate(r.model_flux) if v != 1.0] == exp["in_transit_indices"], key
        indep = _independent_residual(list(times), case["flux_observed"], case["models"])
        assert all((a is None) == (b is None) and (a is None or a == b) for a, b in zip(indep, exp["flux_residual"])), key
    a, b = case["expected"]["evaluated_at_bin_start"], case["expected"]["evaluated_at_bin_center"]
    assert a["in_transit_indices"] != b["in_transit_indices"]          # 이동 여부가 결과를 바꾼다
    assert case["decision"]["gold_segments"] == "bin_center"

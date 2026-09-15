import itertools

import numpy as np
import pytest

from astro_kernel import transit_model as tm


def _model(period=3.0, epoch=1400.5, duration_h=2.0, depth_ppm=1000.0, **extra):
    obj = {"shape": "box",
           "parameters": {"period_days": period, "epoch_btjd": epoch, "duration_hours": duration_h, "depth_ppm": depth_ppm}}
    obj.update(extra)
    return obj


def _time(n_days=27.0, cadence_min=2.0, start=1400.0):
    return np.arange(start, start + n_days, cadence_min / 1440.0)


def _bits(a):
    return np.asarray(a, dtype=np.float64).view(np.uint64)


# ------------------------------------------------------------------ 파싱 (JSON)

def test_parse_valid_model_defaults_and_units():
    m = tm.parse_transit_model(_model(depth_ppm=1450, candidate_id="c-1"))
    assert m.shape == "box" and m.baseline_kind == "unity" and m.candidate_id == "c-1"
    assert m.residual_model_version == tm.DEFAULT_RESIDUAL_MODEL_VERSION
    assert m.depth == 1450 / 1e6 and m.duration_days == 2.0 / 24
    assert m.to_dict()["parameters"]["depth_ppm"] == 1450.0
    assert tm.parse_transit_model(m) is m                       # 이미 객체면 그대로


@pytest.mark.parametrize("obj, code", [
    ("not-a-dict", "invalid_type"),
    ({"shape": "trapezoid", "parameters": _model()["parameters"]}, "unsupported_shape"),
    ({"parameters": _model()["parameters"]}, "unsupported_shape"),
    ({"shape": "box", "parameters": [1, 2]}, "invalid_type"),
    ({"shape": "box", "parameters": {"period_days": 3.0}}, "missing_parameter"),
    ({"shape": "box", "parameters": {**_model()["parameters"], "snr": 9.0}}, "unknown_parameter"),
    (_model(period="3.0"), "invalid_parameter"),
    (_model(period=True), "invalid_parameter"),
    (_model(period=float("nan")), "invalid_parameter"),
    (_model(period=0.0), "invalid_parameter"),
    (_model(duration_h=0.0), "invalid_parameter"),
    (_model(period=0.05, duration_h=2.0), "invalid_parameter"),       # 2h ≥ 0.05d
    (_model(depth_ppm=0.0), "invalid_parameter"),
    (_model(depth_ppm=1_000_000.0), "invalid_parameter"),               # 모델 0 → 나눗셈 불가
    (_model(baseline={"kind": "joint_refit"}), "unsupported_baseline"),
    (_model(baseline="unity"), "unsupported_baseline"),
    (_model(residual_model_version="box-divide-v9"), "unsupported_version"),
    (_model(candidate_id=7), "invalid_type"),
])
def test_parse_rejects_contract_violations(obj, code):
    with pytest.raises(tm.TransitModelError) as info:
        tm.parse_transit_model(obj, index=2)
    assert info.value.code == code
    assert "models[2]" in str(info.value) or code == "invalid_type"


# ------------------------------------------------------------------ 직접 생성한 객체도 같은 규칙 (지적 1)

@pytest.mark.parametrize("kwargs, code", [
    ({"shape": "trapezoid"}, "unsupported_shape"),
    ({"period_days": 0.0}, "invalid_parameter"),
    ({"depth_ppm": -5.0}, "invalid_parameter"),
    ({"depth_ppm": 1_000_000.0}, "invalid_parameter"),
    ({"duration_hours": 80.0}, "invalid_parameter"),                    # 80h ≥ 3d
    ({"epoch_btjd": float("inf")}, "invalid_parameter"),
    ({"baseline_kind": "joint_refit"}, "unsupported_baseline"),
    ({"residual_model_version": "v9"}, "unsupported_version"),
    ({"candidate_id": 3}, "invalid_type"),
])
def test_direct_construction_cannot_bypass_validation(kwargs, code):
    base = dict(shape="box", period_days=3.0, epoch_btjd=1400.5, duration_hours=2.0, depth_ppm=1000.0)
    base.update(kwargs)
    with pytest.raises(tm.TransitModelError) as info:
        tm.TransitModel(**base)
    assert info.value.code == code


def test_direct_construction_coerces_ints_and_matches_parsed_object():
    direct = tm.TransitModel("box", 3, 1400, 2, 1000)
    parsed = tm.parse_transit_model(_model(period=3.0, epoch=1400.0, duration_h=2.0, depth_ppm=1000.0))
    assert direct == parsed and isinstance(direct.period_days, float)


def test_public_curve_functions_reject_non_model_inputs():
    t = _time(n_days=3.0)
    with pytest.raises(tm.TransitModelError) as info:
        tm.model_flux(t, "box")
    assert info.value.code == "invalid_type"
    with pytest.raises(tm.TransitModelError) as info:
        tm.combined_model_flux(t, [_model(), {"shape": "box"}])
    assert info.value.code == "invalid_type" and info.value.index == 1
    # dict 도 받되 검증을 거친다
    np.testing.assert_array_equal(tm.model_flux(t, _model()), tm.model_flux(t, tm.parse_transit_model(_model())))


# ------------------------------------------------------------------ 모델 곡선·경계 (지적 4)

def test_model_flux_exact_binary_boundary_both_sides():
    """period 2d, epoch 1400, duration 12h → 반폭 0.25d. 1400.25·1399.75·1401.75 는 float64 로 정확한 경계다."""
    m = tm.parse_transit_model(_model(period=2.0, epoch=1400.0, duration_h=12.0, depth_ppm=500_000))
    ulp = np.spacing(1400.25)
    t = np.array([1400.0,                      # 중심
                  1400.25 - ulp, 1400.25, 1400.25 + ulp,        # 오른쪽 경계 안·정확·밖
                  1399.75 - ulp, 1399.75, 1399.75 + ulp,        # 왼쪽 경계 밖·정확·안
                  1401.75, 1402.0, 1401.0])                     # 다음 주기 왼쪽 경계·다음 중심·위상 0.5
    dist = tm.phase_distance_days(t, 2.0, 1400.0)
    np.testing.assert_array_equal(np.abs(dist[[2, 5, 7]]), 0.25)   # 경계 거리가 정확히 0.25
    f = tm.model_flux(t, m)
    assert f[0] == 0.5
    assert f[1] == 0.5 and f[2] == 1.0 and f[3] == 1.0            # < 이므로 정확한 경계는 밖
    assert f[4] == 1.0 and f[5] == 1.0 and f[6] == 0.5
    assert f[7] == 1.0 and f[8] == 0.5 and f[9] == 1.0


def test_model_flux_values_are_finite_positive_and_time_must_be_finite():
    m = tm.parse_transit_model(_model())
    f = tm.model_flux(_time(n_days=5.0), m)
    assert np.isfinite(f).all() and (f > 0).all() and (f <= 1).all()
    with pytest.raises(tm.TransitModelError) as info:
        tm.model_flux(np.array([1400.0, np.nan, 1401.0]), m)
    assert info.value.code == "invalid_time"
    with pytest.raises(tm.TransitModelError) as info:
        tm.phase_distance_days(np.array([1400.0, np.inf]), 3.0, 1400.0)
    assert info.value.code == "invalid_time"


def test_hand_computed_small_removal_case():
    """손으로 검산 가능한 8점 예제. 모델 0.5(500,000 ppm), 통과 안 flux 0.75 → 잔차 1.5, 밖 1.0. 모두 float64 로 정확한 값."""
    m = _model(period=2.0, epoch=1400.0, duration_h=12.0, depth_ppm=500_000)
    t = np.array([1399.5, 1399.8, 1400.0, 1400.2, 1400.5, 1401.0, 1401.9, 1402.1])
    flux = np.array([1.0, 0.75, 0.75, 0.75, 1.0, 1.0, 0.75, 0.75])
    r = tm.remove_transit_models(t, flux, [m])
    np.testing.assert_array_equal(r.model_flux, [1.0, 0.5, 0.5, 0.5, 1.0, 1.0, 0.5, 0.5])
    np.testing.assert_array_equal(r.flux_residual, [1.0, 1.5, 1.5, 1.5, 1.0, 1.0, 1.5, 1.5])
    assert (r.n_points, r.n_valid_input, r.n_finite_residual) == (8, 8, 8)


# ------------------------------------------------------------------ 잔차 제거 불변량

def test_empty_removal_returns_bitwise_copy_of_input():
    t = _time()
    rng = np.random.default_rng(0)
    f = 1 + rng.normal(0, 1e-3, size=t.shape)
    f[100:110] = np.nan
    r = tm.remove_transit_models(t, f, [])
    assert r.flux_residual.dtype == np.float64
    np.testing.assert_array_equal(r.flux_residual, f)            # NaN 위치 포함 값 동일
    assert np.array_equal(_bits(r.flux_residual), _bits(f))      # 비트 동일
    assert r.flux_residual is not f                              # 입력 객체는 보존
    assert r.models == () and r.residual_model_version == tm.DEFAULT_RESIDUAL_MODEL_VERSION
    assert r.n_points == len(t) and r.n_valid_input == len(t) - 10 and r.n_finite_residual == len(t) - 10
    np.testing.assert_array_equal(r.model_flux, np.ones_like(t))


def test_empty_removal_preserves_float32_binned_input_values():
    t = tm.segment_times(1400.0, 10.0, 500)
    f32 = (1 + np.linspace(-1e-3, 1e-3, 500)).astype(np.float32)
    r = tm.remove_transit_models(t, f32, [])
    np.testing.assert_array_equal(r.flux_residual, f32.astype(np.float64))


def test_order_invariance_is_bitwise_for_all_permutations():
    t = _time()
    rng = np.random.default_rng(1)
    f = 1 + rng.normal(0, 5e-4, size=t.shape)
    models = [_model(period=3.3, epoch=1401.2, duration_h=1.7, depth_ppm=2300, candidate_id="a"),
              _model(period=7.9, epoch=1402.9, duration_h=3.1, depth_ppm=800, candidate_id="b"),
              _model(period=1.1, epoch=1400.3, duration_h=0.9, depth_ppm=4100, candidate_id="c")]
    ref = tm.remove_transit_models(t, f, models).flux_residual
    for perm in itertools.permutations(models):
        out = tm.remove_transit_models(t, f, list(perm))
        assert np.array_equal(_bits(out.flux_residual), _bits(ref))          # 실제 비트 비교
        assert [m.candidate_id for m in out.models] == ["c", "a", "b"]       # period 순 정렬


def test_single_model_removal_recovers_clean_curve():
    t = _time(n_days=9.0)
    m = tm.parse_transit_model(_model(period=3.0, epoch=1401.0, duration_h=2.0, depth_ppm=5000))
    clean = 1 + 1e-3 * np.sin(t)
    observed = clean * tm.model_flux(t, m)
    r = tm.remove_transit_models(t, observed, [m])
    assert (tm.model_flux(t, m) < 1).sum() > 0
    np.testing.assert_allclose(r.flux_residual, clean, rtol=0, atol=1e-15)   # 곱한 뒤 나눈 반올림 1회
    np.testing.assert_array_equal(r.model_flux, tm.model_flux(t, m))


def test_two_overlapping_transits_combine_multiplicatively_and_subset_isolates_the_other():
    t = _time(n_days=9.0)
    a = tm.parse_transit_model(_model(period=4.0, epoch=1402.0, duration_h=4.0, depth_ppm=10000))
    b = tm.parse_transit_model(_model(period=8.0, epoch=1402.0, duration_h=2.0, depth_ppm=20000))   # a 와 t0 동일 → 겹침
    observed = tm.model_flux(t, a) * tm.model_flux(t, b)
    both = (tm.model_flux(t, a) < 1) & (tm.model_flux(t, b) < 1)
    assert both.sum() > 0
    assert np.allclose(observed[both], (1 - 0.01) * (1 - 0.02))
    np.testing.assert_allclose(tm.remove_transit_models(t, observed, [a, b]).flux_residual, 1.0, rtol=0, atol=1e-15)
    only_b = tm.remove_transit_models(t, observed, [a]).flux_residual
    np.testing.assert_allclose(only_b, tm.model_flux(t, b), rtol=0, atol=1e-15)   # 겹친 점도 보존


@pytest.mark.parametrize("cadence_min", [2.0, 10.0, 30.0])
def test_variable_binning_uses_same_contract(cadence_min):
    m = tm.parse_transit_model(_model(period=5.0, epoch=1402.5, duration_h=3.0, depth_ppm=3000))
    t = tm.segment_times(1400.0, cadence_min, int(27 * 1440 / cadence_min))
    r = tm.remove_transit_models(t, np.ones_like(t), [m])
    in_tr = r.model_flux < 1
    expected_per_transit = 3 * 60 / cadence_min
    assert 4 * expected_per_transit * 0.9 <= in_tr.sum() <= 6 * expected_per_transit * 1.1
    np.testing.assert_allclose(r.flux_residual[in_tr], 1 / (1 - 3e-3), rtol=0, atol=1e-15)
    assert r.n_finite_residual == len(t)


# ------------------------------------------------------------------ NaN 정책 (지적 2)

def test_flux_nan_is_preserved_in_both_empty_and_single_removal():
    t = _time(n_days=6.0)
    f = np.ones_like(t)
    f[10:20] = np.nan                    # 빈 bin
    m = _model(period=2.0, epoch=1400.0, duration_h=1.0, depth_ppm=1000)
    for models in ([], [m]):
        r = tm.remove_transit_models(t, f, models)
        assert np.isnan(r.flux_residual[10:20]).all()
        assert np.isfinite(r.flux_residual[:10]).all() and np.isfinite(r.flux_residual[20:]).all()
        assert np.isfinite(r.model_flux).all()                  # 모델은 결측 위치에서도 유한
        assert r.n_valid_input == len(t) - 10 == r.n_finite_residual
        assert np.isnan(r.flux_residual).sum() == 10             # NaN 개수 불변


@pytest.mark.parametrize("models", [[], [_model(period=2.0, epoch=1400.0, duration_h=1.0, depth_ppm=1000)]])
def test_time_nan_fails_identically_for_empty_and_single_removal(models):
    t = _time(n_days=6.0)
    f = np.ones_like(t)
    t_nan = t.copy(); t_nan[30] = np.nan                       # time 만 NaN
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t_nan, f, models)
    assert info.value.code == "invalid_time" and "30" in str(info.value)
    f_nan = f.copy(); f_nan[30] = np.nan                       # 둘 다 NaN 이어도 time 이 먼저 실패
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t_nan, f_nan, models)
    assert info.value.code == "invalid_time"
    t_inf = t.copy(); t_inf[0] = np.inf
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t_inf, f, models)
    assert info.value.code == "invalid_time"


# ------------------------------------------------------------------ 새 NaN·Inf·0 이하 (지적 3)

def _deep_models(n, depth_ppm=999_999.0):
    """같은 시각에 겹치는 n 개의 거의 완전 감광 모델. 개별 모델은 1e-6 > 0 이지만 곱은 underflow 한다."""
    return [_model(period=2.0, epoch=1400.0, duration_h=12.0, depth_ppm=depth_ppm, candidate_id=f"m{i:02d}") for i in range(n)]


def test_combined_model_underflow_to_subnormal_makes_inf_residual_and_fails():
    t = np.array([1399.5, 1400.0, 1400.5])
    models = _deep_models(52)                                   # 1e-6^52 = 1e-312: 양의 비정규 수, 1/1e-312 → Inf
    m = tm.combined_model_flux(t, models)
    with np.errstate(over="ignore"):
        assert m[1] > 0 and not np.isfinite(1.0 / m[1])
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t, np.ones_like(t), models)
    assert info.value.code == "numerical_failure"


def test_combined_model_underflow_to_zero_is_nonpositive_model():
    t = np.array([1399.5, 1400.0, 1400.5])
    models = _deep_models(60)                                   # 1e-6^60 = 1e-360 → 0
    assert tm.combined_model_flux(t, models)[1] == 0.0
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t, np.ones_like(t), models)
    assert info.value.code == "nonpositive_model"


def test_underflow_only_at_missing_flux_positions_is_not_a_failure():
    """결측(flux NaN) 위치의 결합 모델이 0 이어도 유효 위치가 정상이면 성공한다. 입력 결측과 계산 실패를 구분한다."""
    t = np.array([1399.5, 1400.0, 1400.5])
    f = np.array([1.0, np.nan, 1.0])
    r = tm.remove_transit_models(t, f, _deep_models(60))
    assert r.model_flux[1] == 0.0 and np.isnan(r.flux_residual[1])
    assert r.flux_residual[0] == 1.0 and r.flux_residual[2] == 1.0
    assert r.n_valid_input == 2 == r.n_finite_residual


def test_infinite_flux_at_valid_position_is_numerical_failure():
    t = _time(n_days=3.0)
    f = np.ones_like(t); f[5] = np.inf                          # Inf flux 는 결측(NaN)이 아니라 계산 실패 값이다
    for models in ([], [_model()]):                             # 빈 제거도 Inf 를 그대로 돌려주지 않는다
        with pytest.raises(tm.TransitModelError) as info:
            tm.remove_transit_models(t, f, models)
        assert info.value.code == "numerical_failure" and info.value.field == "flux"


def test_shape_mismatch_type_and_version_rules():
    t = _time(n_days=3.0)
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t, t[:-1], [])
    assert info.value.code == "shape_mismatch"
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t.reshape(-1, 1), t.reshape(-1, 1), [])
    assert info.value.code == "shape_mismatch"
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(["a", "b"], [1.0, 2.0], [])
    assert info.value.code == "invalid_type"
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t, np.ones_like(t), [_model()], residual_model_version="box-divide-v9")
    assert info.value.code == "unsupported_version"
    ok = tm.remove_transit_models(t, np.ones_like(t), [_model()], residual_model_version="box-divide-v0")
    assert ok.residual_model_version == "box-divide-v0"


def test_accepts_already_parsed_models_and_reports_index_of_bad_dict():
    t = _time(n_days=3.0)
    good = tm.parse_transit_model(_model())
    with pytest.raises(tm.TransitModelError) as info:
        tm.remove_transit_models(t, np.ones_like(t), [good, _model(depth_ppm=-1)])
    assert info.value.code == "invalid_parameter" and info.value.index == 1


# ------------------------------------------------------------------ 세그먼트 시각

def test_segment_times_follows_erd_formula_and_validates():
    t = tm.segment_times(1400.0, 10.0, 4)
    np.testing.assert_allclose(t, [1400.0, 1400.0 + 10 / 1440, 1400.0 + 20 / 1440, 1400.0 + 30 / 1440])
    assert tm.segment_times(1400, 10, 2)[1] == 1400.0 + 10 / 1440             # 정수 인자도 허용
    for kwargs in ({"start_btjd": float("inf")}, {"start_btjd": "1400"}, {"bin_minutes": 0}, {"bin_minutes": None},
                   {"n_points": 0}, {"n_points": 2.5}, {"n_points": True}):
        args = {"start_btjd": 1400.0, "bin_minutes": 10.0, "n_points": 3}
        args.update(kwargs)
        with pytest.raises(tm.TransitModelError) as info:
            tm.segment_times(**args)
        assert info.value.code == "invalid_argument"

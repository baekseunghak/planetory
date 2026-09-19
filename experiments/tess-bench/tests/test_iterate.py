"""반복 제거 루프 (iterate, S15P21C206-111): 종료 사유·제거 QA·복구가 합성 곡선에서 의도대로 동작하는지."""
import numpy as np
import pytest

from tess_bench import bls, iterate as it
from tess_fixture import inject as inj

SETTING = bls.BlsSetting("t", n_periods=3000, period_max_rule="fixed:9")
CFG = it.IterateConfig(max_candidates=4)


def _curve(signals, n_days=27.0, noise=3e-4, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, 2.0 / 1440)
    f = 1 + rng.normal(0, noise, size=t.shape)
    for P, ep, dh, depth in signals:
        phase = ((t - ep) / P + 0.5) % 1.0 - 0.5
        f[np.abs(phase * P) < dh / 48] *= 1 - depth
    return t, f


def _row(P, ep, dh, depth_ppm, iid):
    return inj.InjectionRow(iid, "set", "b", 0, "g", P, dh, depth_ppm, 0.5, "middle", ep, "box", 8, 200)


def test_single_signal_is_accepted_once_then_loop_stops_on_quality():
    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)])
    res = it.iterate_curve(t, f, SETTING, CFG, truth=[(3.0, 1402.0, 2.0 / 24)])
    assert len(res.accepted) == 1 and res.accepted[0].period_days == pytest.approx(3.0, rel=2e-3)
    assert res.termination in ("no_quality_peak", "duplicate_or_harmonic_only")
    acc = [s for s in res.steps if s.status == "accepted"][0]
    assert acc.power_ratio < 0.5 and acc.qa_failures == "" and acc.n_finite_residual == acc.n_valid_input
    assert res.accepted[0].validated_on_original is True and res.accepted[0].original_snr >= 7
    m = it.match_accepted(t, [_row(3.0, 1402.0, 2.0, 3000.0, "i0")], res.accepted)
    assert m[0]["match"] == "direct" and m[0]["recovered_step"] == 0
    s = it.summarize(res, m)
    assert (s["n_recovered"], s["n_false_candidates"], s["qa_failed_step"]) == (1, 0, -1)


def test_two_signals_recovered_strong_first_and_weak_second():
    t, f = _curve([(3.0, 1402.0, 2.0, 5e-3), (7.0, 1403.5, 2.5, 1.2e-3)])
    res = it.iterate_curve(t, f, SETTING, CFG, truth=[(3.0, 1402.0, 2.0 / 24), (7.0, 1403.5, 2.5 / 24)])
    periods = [c.period_days for c in res.accepted]
    assert len(periods) == 2 and periods[0] == pytest.approx(3.0, rel=2e-3) and periods[1] == pytest.approx(7.0, rel=2e-3)
    m = it.match_accepted(t, [_row(3.0, 1402.0, 2.0, 5000.0, "a"), _row(7.0, 1403.5, 2.5, 1200.0, "b")], res.accepted)
    assert [x["recovered_step"] for x in m] == [0, 1]
    first = [s for s in res.steps if s.status == "accepted"][0]
    assert np.isfinite(first.other_depth_log2_max) and first.other_depth_log2_max < 1.0          # 약한 신호의 깊이가 훼손되지 않았다


def test_second_removal_failure_preserves_first_candidate_and_exact_residual(monkeypatch):
    """111 완료 조건: 빈 집합뿐 아니라 이전 정상 후보와 잔차 배열까지 보존한다."""
    t, f = _curve([(3, 1402, 2, 0.005), (7, 1403.5, 2, 0.001)])
    original = f.copy()
    first = bls.Peak(1, 3, 1402, 2, 0.005, 1e-5, 100, 100, 10, 50, 50, 9, 100, 0)
    wrong_second = bls.Peak(1, 7, 1403.5, 2, 0.003, 1e-5, 100, 100, 10, 50, 50, 4, 100, 0)
    peaks = iter([first, wrong_second])
    monkeypatch.setattr(bls, 'run_bls', lambda *a, **k: bls.BlsRun('t', 3000, .5, 9, .01, 0, 1, [next(peaks)]))
    powers = iter([10., 1., 10., 1.])
    monkeypatch.setattr(it, 'local_max_power', lambda *a, **k: next(powers))
    result = it.iterate_curve(t, f, SETTING, it.IterateConfig(refine_peak=False), keep_residual=True)
    assert result.termination == 'removal_qa_failed' and result.qa_failed_step == 1
    assert len(result.accepted) == 1 and result.accepted[0].period_days == 3
    assert 'window_offset' in result.steps[-1].qa_failures
    expected = it.remove_transit_models(t, original, [result.accepted[0].model('expected')]).flux_residual
    np.testing.assert_array_equal(result.residual, expected)
    np.testing.assert_array_equal(f, original)


@pytest.mark.parametrize('has_peak, expected', [(False, 'no_quality_peak'), (True, 'duplicate_or_harmonic_only')])
def test_empty_search_and_duplicate_only_are_distinct(monkeypatch, has_peak, expected):
    t, f = _curve([(3, 1402, 2, .003)])
    peak = bls.Peak(1, 3, 1402, 2, .003, 1e-5, 100, 100, 10, 50, 50, 9, 100, 0)
    batches = iter([[peak], [peak] if has_peak else []])
    monkeypatch.setattr(bls, 'run_bls', lambda *a, **k: bls.BlsRun('t', 3000, .5, 9, .01, 0, 1, next(batches)))
    powers = iter([10., 1.])
    monkeypatch.setattr(it, 'local_max_power', lambda *a, **k: next(powers))
    result = it.iterate_curve(t, f, SETTING, it.IterateConfig(refine_peak=False))
    assert result.termination == expected and len(result.accepted) == 1
    assert result.steps[-1].reason == expected


def test_original_revalidation_failure_is_recorded(monkeypatch):
    t, f = _curve([(3, 1402, 2, .003)])
    monkeypatch.setattr(it, 'fixed_snr', lambda *a, **k: 0.)
    result = it.iterate_curve(t, f, SETTING, CFG)
    assert result.termination == 'candidate_validation_failed'
    assert result.accepted and all(c.validated_on_original is False for c in result.accepted)
    assert it.summarize(result, [])['n_validation_failed'] == len(result.accepted)


def test_tampered_model_fails_qa_and_recovers_to_previous_candidate_set():
    """DAT-06: QA 실패 뒤 후보를 채택하지 않고 직전 정상 집합(여기서는 빈 집합)으로 복구한다."""
    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)])
    res = it.iterate_curve(t, f, SETTING, CFG, tamper_depth_factor=3.0)
    assert res.termination == "removal_qa_failed" and res.qa_failed_step == 0 and res.accepted == []
    failed = res.steps[-1]
    assert failed.status == "qa_failed" and "window_offset" in failed.qa_failures.split(",") and failed.window_offset_z > 5   # 3배 과대 제거 → 창 안이 밝아진다
    assert failed.period_days == pytest.approx(3.0, rel=2e-3)                       # 실패 단계 정보는 남긴다


def test_insufficient_points_and_numerical_failure_are_distinct_terminations(monkeypatch):
    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)], n_days=0.1)
    res = it.iterate_curve(t, f, SETTING, CFG)
    assert res.termination == "insufficient_observations" and res.steps[-1].n_points == t.size

    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)])
    monkeypatch.setattr(bls, "run_bls", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    res = it.iterate_curve(t, f, SETTING, CFG)
    assert res.termination == "numerical_failure" and res.steps[-1].status == "error" and "RuntimeError" in res.steps[-1].qa_failures


def test_max_candidates_bounds_the_loop(monkeypatch):
    """게이트를 항상 통과하는 가짜 피크를 돌려주면 안전 상한에서 멈춘다."""
    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)])
    counter = {"n": 0}

    def fake_run(tt, ff, setting, **kw):
        counter["n"] += 1
        P = 2.0 + 0.37 * counter["n"]                                                     # 매번 다른(비고조파) 주기
        peak = bls.Peak(1, P, 1401.0, 2.0, 1e-3, 1e-5, 100.0, 0.0, 10.0, 50.0, 0.0, 8, 60, 0.0)
        return bls.BlsRun("t", 10, 0.5, 9.0, 0.01, 0.0, 1.0, [peak])
    monkeypatch.setattr(bls, "run_bls", fake_run)
    monkeypatch.setattr(it, "local_max_power", lambda *a, **k: 1.0)
    monkeypatch.setattr(it, "fixed_depth", lambda *a, **k: 1e-3)
    monkeypatch.setattr(it, "fixed_snr", lambda *a, **k: 20.0)
    monkeypatch.setattr(it, "window_offset", lambda *a, **k: (0.0, 0.0))
    monkeypatch.setattr(it, "edge_excess", lambda *a, **k: 0.5)
    res = it.iterate_curve(t, f, SETTING, it.IterateConfig(max_candidates=3, refine_peak=False, qa_power_ratio_max=2.0, qa_edge_excess_max=99, qa_overlap_dev_max=99))
    assert res.termination == "max_iterations_reached" and len(res.accepted) == 3


def test_duplicate_rule_uses_cumulative_error_and_harmonics():
    acc = [it.Candidate(0, 3.0, 1402.0, 2.0, 3000.0, 10.0, 20.0, 8, 1)]
    D = 2.0 / 24
    assert it.is_duplicate(3.0 + 0.5 * D / 8 * 0.9, D, 8, acc, (0.5, 1.0, 2.0)) == 0      # 누적 오차 안 → 중복
    assert it.is_duplicate(3.0 + 0.5 * D / 8 * 1.1, D, 8, acc, (0.5, 1.0, 2.0)) == -1     # 바로 밖 → 새 후보
    assert it.is_duplicate(3.0 + 0.5 * D / 8 * 0.9, D / 4, 8, acc, (0.5, 1.0, 2.0)) == 0  # 잔여 피크의 짧은 지속시간에도 후보 D 로 판정
    assert it.is_duplicate(6.0, D, 4, acc, (0.5, 1.0, 2.0)) == 0 and it.is_duplicate(1.5, D, 16, acc, (0.5, 1.0, 2.0)) == 0
    assert it.is_duplicate(4.5, D, 6, acc, (0.5, 1.0, 2.0)) == -1


def test_oot_offset_includes_reference_mean_uncertainty_and_ignores_common_shift():
    # Two equal-size regions with symmetric fluctuations: both mean errors matter.
    t = np.r_[np.full(20, 0.5), np.full(20, 0.9)]
    noise = np.tile([-1e-4, 1e-4], 10)
    f = np.r_[1 + 2e-4 + noise, 1 + noise]
    mean, z = it.window_offset(t, f, 1, 0.5, 0.2, reference="oot")
    assert mean == pytest.approx(2e-4)
    assert z == pytest.approx(2e-4 / (1.4826e-4 * np.sqrt(2 / 20)))
    shifted = it.window_offset(t, f + 0.003, 1, 0.5, 0.2, reference="oot")
    assert shifted == pytest.approx((mean, z))
    # Legacy remains the default, including its original one-mean standard error.
    assert it.window_offset(t, f, 1, 0.5, 0.2)[1] == pytest.approx(z * np.sqrt(2))


def test_oot_cli_records_mode_in_manifest(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace
    from tess_bench import cli
    args = cli.build_parser().parse_args(['iterate', '--target', 'l98_59', '--stage', 'evaluation',
        '--no-noise', '--window-offset-reference', 'oot', '--results', str(tmp_path)])
    bi = SimpleNamespace(target=SimpleNamespace(key='l98_59'), stage='evaluation',
        groups={'realclean': {'none': []}}, prepared={('realclean', 'none'): (np.array([0., 1.]), np.ones(2))},
        n_groups=1, inputs=[], baselines={'realclean': None}, known_models=[], noise_seeds=[], set_id='injection_grid_v1-1.1.0',
        strict=SimpleNamespace(time=np.array([0., 1.])), pre=cli.Setting('biweight_1.0d'))
    monkeypatch.setattr(cli, 'build_bls_inputs', lambda *a, **k: bi)
    monkeypatch.setattr(cli, 'preprocess_groups', lambda *a, **k: None)
    def fake_iterate(t, f, setting, cfg, **kw):
        assert cfg.qa_window_offset_reference == 'oot'
        return it.IterationResult([it.StepRecord(0, 'terminated', 'no_quality_peak')], [], 'no_quality_peak')
    monkeypatch.setattr(it, 'iterate_curve', fake_iterate)
    monkeypatch.setattr(cli.mf, '_git', lambda *a, **k: None)
    assert cli.cmd_iterate(args) == 0
    manifest = json.loads(next((tmp_path / 'manifests').glob('*.json')).read_text(encoding='utf-8'))
    assert manifest['task'] == 'S15P21C206-111 iterate'
    assert manifest['config']['parameters']['iterate']['qa_window_offset_reference'] == 'oot'
    params = manifest['config']['parameters']
    cfg = it.IterateConfig(**params['iterate'])
    assert params['iterate_config_sha256'] == cfg.fingerprint()
    assert params['iterate_config_version'] == f'bls_iterate_qa_v1/{cfg.fingerprint()[:12]}'
    assert params['grid_set_id'] == 'injection_grid_v1-1.1.0'
    assert {'references', 'fixture_checksums'} <= {x['role'] for x in manifest['inputs']}
    assert cfg.fingerprint() != it.IterateConfig().fingerprint()
    assert cli.build_parser().parse_args(['iterate', '--target', 'l98_59']).window_offset_reference == 'unity'
    with pytest.raises(ValueError):
        it.IterateConfig(qa_window_offset_reference='unknown')


@pytest.mark.parametrize("missing", ["inside", "outside", "flat"])
def test_oot_offset_does_not_fallback_when_unmeasurable(missing):
    t, f = _curve([])
    inside = it.in_transit_mask(t, 1, 1400.5, 8 / 24)
    if missing == "inside":
        f[inside] = np.nan
    elif missing == "outside":
        f[np.abs(bls._phase_distance(t, 1, 1400.5)) >= 8 / 24] = np.nan
    else:
        f[:] = 1
    assert all(np.isnan(x) for x in it.window_offset(t, f, 1, 1400.5, 8 / 24, reference="oot"))


@pytest.mark.parametrize("depth_factor", [1, 0.5, 3])
def test_oot_loop_accepts_offset_baseline_but_rolls_back_wrong_removal(monkeypatch, depth_factor):
    t, noise = _curve([], noise=1e-3)
    inside = it.in_transit_mask(t, 1, 1400.5, 8 / 24)
    f = (noise + 0.0006) * np.where(inside, 0.997, 1)
    peak = bls.Peak(1, 1, 1400.5, 8, 0.003, 1e-5, 100, 100, 10, 50, 50, 27, int(inside.sum()), 0)
    monkeypatch.setattr(bls, "run_bls", lambda *a, **k: bls.BlsRun("t", 3000, 0.5, 9, 0.01, 0, 1, [peak]))
    # Isolate QA/rollback from the search and power metric, but use real model removal and offset QA.
    monkeypatch.setattr(it, "local_max_power", lambda *a, **k: 1.0)
    cfg = it.IterateConfig(max_candidates=1, refine_peak=False, qa_window_offset_reference="oot",
                           qa_window_offset_rel_depth=0.1, qa_power_ratio_max=2)
    res = it.iterate_curve(t, f, SETTING, cfg, tamper_depth_factor=depth_factor, keep_residual=True)
    rec = res.steps[0]
    assert rec.window_offset_reference == "oot"
    if depth_factor == 1:
        assert len(res.accepted) == 1
        assert abs(rec.window_offset_unity_z) > 5 and abs(rec.window_offset_unity_rel) > 0.1
        assert abs(rec.window_offset_rel) < 0.1
    else:
        assert res.termination == "removal_qa_failed" and not res.accepted
        assert "window_offset" in rec.qa_failures
        assert np.sign(rec.window_offset_z) == np.sign(depth_factor - 1)
        np.testing.assert_array_equal(res.residual, f)


def test_edge_excess_is_near_unity_for_noise_and_high_for_leftover_edges():
    t, f = _curve([], noise=1e-3)
    resid = f.copy()
    assert 0.4 < it.edge_excess(t, resid, 3.0, 1402.0, 2.0 / 24) < 1.0
    phase = np.abs(bls._phase_distance(t, 3.0, 1402.0))
    band = (phase >= 1.0 / 24) & (phase < 2.0 / 24)
    resid[band] -= 5e-3                                                                  # 가장자리 띠에 잔여 파형
    assert it.edge_excess(t, resid, 3.0, 1402.0, 2.0 / 24) > 3.0


def test_window_offset_relative_allowance_protects_deep_signal_removal():
    """깊은 신호(1%)의 제거는 SE 기준 z 는 커도 깊이 대비 편차가 작다. 상대 허용이 있으면 통과, 없으면 실패."""
    t, f = _curve([(3.0, 1402.0, 8.0, 1e-2)], noise=2e-4)                            # 8 h 긴 통과 — 격자 4.8 h 상한 밖
    strict = it.iterate_curve(t, f, SETTING, it.IterateConfig(max_candidates=2))
    relaxed = it.iterate_curve(t, f, SETTING, it.IterateConfig(max_candidates=2, qa_window_offset_rel_depth=0.1, refine_duration_max_hours=12.0))
    assert relaxed.accepted and relaxed.accepted[0].period_days == pytest.approx(3.0, rel=2e-3)
    acc = [s for s in relaxed.steps if s.status == "accepted"][0]
    assert acc.duration_hours > 6.0 and abs(acc.window_offset_rel) <= 0.1 and acc.qa_failures == ""     # 확대된 지속시간으로 8 h 를 덮었다
    first_strict = next(s for s in strict.steps if s.status in ("accepted", "qa_failed"))
    assert first_strict.duration_hours <= 4.8 * 1.4 + 1e-9                                                  # 5절 실행값은 6.7 h 까지만


def test_continue_after_qa_fail_blocks_peak_and_keeps_searching():
    """설계 변경 제안: QA 실패 피크를 제외하고 계속 탐색. 실패 피크(3배 부풀린 모델)는 blocked, 진짜 두 번째 신호는 그 뒤에 채택."""
    t, f = _curve([(3.0, 1402.0, 2.0, 5e-3), (7.0, 1403.5, 2.5, 1.5e-3)])
    stop = it.iterate_curve(t, f, SETTING, CFG, tamper_depth_factor=3.0)
    assert stop.termination == "removal_qa_failed" and stop.accepted == []
    cont = it.iterate_curve(t, f, SETTING, it.IterateConfig(max_candidates=4, continue_after_qa_fail=True), tamper_depth_factor=3.0)
    assert cont.n_blocked >= 1 and cont.qa_failed_step == 0
    assert any(c.period_days == pytest.approx(7.0, rel=2e-3) for c in cont.accepted)                     # 막힌 피크 뒤의 신호를 찾는다
    assert not any(c.period_days == pytest.approx(3.0, rel=2e-3) for c in cont.accepted)                  # 막힌 피크는 채택되지 않는다
    failed = next(s for s in cont.steps if s.status == "qa_failed")
    assert failed.masked_points > 0                                                                        # 제거 불가 피크의 통과 창을 가렸다
    assert cont.termination in ("no_quality_peak", "duplicate_or_harmonic_only", "removal_qa_failed")


def test_fixed_depth_and_snr_return_nan_when_transit_window_is_empty():
    """마스킹으로 통과 창 안 점이 하나도 없으면 예외 대신 NaN (옵션 실험에서 WASP-18 이 죽은 사례)."""
    t, f = _curve([(3.0, 1402.0, 2.0, 3e-3)])
    keep = np.abs(bls._phase_distance(t, 3.0, 1402.0)) > 0.2                                      # 통과 창 주변을 전부 제거
    assert np.isnan(it.fixed_depth(t[keep], f[keep], 3.0, 2.0 / 24, 1402.0))
    assert np.isnan(it.fixed_snr(t[keep], f[keep], 3.0, 2.0 / 24, 1402.0))
    res = it.iterate_curve(t[keep], f[keep], SETTING, it.IterateConfig(max_candidates=2, continue_after_qa_fail=True), truth=[(3.0, 1402.0, 2.0 / 24)])
    assert res.termination in it.TERMINATION_REASONS                                               # 예외 없이 끝난다


def test_refine_caps_duration_to_fraction_of_period_and_unmeasurable_qa_fails():
    """L 98-59 분리 실행에서 P/7 잔여가 지속시간 11 h(주기의 65%)로 맞춰져 QA 바깥 구간이 사라지고 통과했다. 상한 20%·측정 불가 실패로 막는다."""
    t, f = _curve([(0.7, 1400.3, 3.0, 3e-3)], noise=3e-4)
    peak = bls.Peak(1, 0.7, 1400.3, 3.0, 3e-3, 1e-5, 100.0, 0.0, 10.0, 50.0, 0.0, 30, 500, 0.0)
    run = bls.BlsRun("t", 3000, 0.5, 9.0, 0.01, 0.0, 1.0, [peak])
    cfg = it.IterateConfig(refine_duration_max_hours=12.0, refine_duration_span=(0.5, 2.0))
    refined = it.refine_peak(t, f, peak, SETTING, run, cfg)
    assert refined.duration_hours <= cfg.max_duration_fraction * 0.7 * 24 + 1e-9                     # 0.35 × 16.8 h = 5.9 h 상한
    # 바깥 구간이 없는 잔차: 지속시간이 주기의 절반을 넘으면 |φ| ≥ D 구간이 비어 edge·offset 이 NaN
    assert np.isnan(it.edge_excess(t, f, 0.7, 1400.3, 0.4)) and np.isnan(it.window_offset(t, f, 0.7, 1400.3, 0.4)[1])
    # 점유율 33%(8 h / 1 d)는 측정 가능해야 한다 (주입 격자에 있는 조합)
    t1, f1 = _curve([(1.0, 1400.5, 8.0, 3e-3)])
    assert np.isfinite(it.edge_excess(t1, f1, 1.0, 1400.5, 8.0 / 24)) and np.isfinite(it.window_offset(t1, f1, 1.0, 1400.5, 8.0 / 24)[1])
    res = it.iterate_curve(t, f, SETTING, it.IterateConfig(max_candidates=2, max_duration_fraction=0.9, qa_require_measurable=True))
    wide = [s for s in res.steps if s.status in ("accepted", "qa_failed") and s.duration_hours / 24 > 0.25 * s.period_days]
    assert all("qa_not_measurable" in s.qa_failures for s in wide)                                    # 넓은 창은 측정 불가로 실패

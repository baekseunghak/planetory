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
    monkeypatch.setattr(it, "window_offset_z", lambda *a, **k: 0.0)
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


def test_edge_excess_is_near_unity_for_noise_and_high_for_leftover_edges():
    t, f = _curve([], noise=1e-3)
    resid = f.copy()
    assert 0.4 < it.edge_excess(t, resid, 3.0, 1402.0, 2.0 / 24) < 1.0
    phase = np.abs(bls._phase_distance(t, 3.0, 1402.0))
    band = (phase >= 1.0 / 24) & (phase < 2.0 / 24)
    resid[band] -= 5e-3                                                                  # 가장자리 띠에 잔여 파형
    assert it.edge_excess(t, resid, 3.0, 1402.0, 2.0 / 24) > 3.0

"""Transactional iteration and fail-closed QA boundaries."""
from dataclasses import replace
import json
from types import SimpleNamespace

import numpy as np
import pytest

from astro_kernel import iteration as it
from astro_kernel.bls import BlsError
from astro_kernel.bls import _search_input_sha256, SEARCH_VERSION, QUALITY_VERSION


def inputs():
    t = np.linspace(0, 20, 1000)
    f = 1 + np.random.default_rng(42).normal(0, .001, len(t))
    return t, f


def peak(period=2):
    return dict(rank=1, period_days=period, epoch_btjd=.5, duration_hours=2., depth=.01,
        depth_err=.0001, power=100., sde=10., snr=20., n_transits=10, n_in_transit=30,
        sector_stats=[], sector_consistency_status="unavailable", mask_dropped_fraction=None,
        diagnostic_reasons=[])


def stub_search(monkeypatch, peaks):
    calls = iter(peaks)
    def search(*args, **kwargs):
        return dict(status="ok", peaks=next(calls), periodogram=SimpleNamespace(config=dict(
            period_min_days=.5, period_max_days=6., n_periods=20000,
            durations_hours=[1.2,1.92,2.88,4.8])))
    monkeypatch.setattr(it, "search_bls", search)
    monkeypatch.setattr(it, "refine_peak", lambda t, f, p, *args: p)
    monkeypatch.setattr(it, "fixed_snr", lambda *args: 10.)


def run(t=None, f=None, **kwargs):
    if t is None:
        t, f = inputs()
    return it.iterate_bls(t, f, input_snapshot_id="test-snapshot", preprocessing_version="silver-test", **kwargs)


def test_initial_search_is_reused_once_and_matches_normal_path(monkeypatch):
    t, f = inputs()
    config = dict(period_min_days=.5, period_max_days=6., n_periods=20000,
                  durations_hours=[1.2, 1.92, 2.88, 4.8])
    first = dict(status="no_quality_peak", peaks=[], periodogram=SimpleNamespace(config=config),
                 input_snapshot_id="test-snapshot", preprocessing_version="silver-test",
                 bls_config_version=SEARCH_VERSION, candidate_quality_version=QUALITY_VERSION,
                 n_input=len(t), n_valid=len(t),
                 search_input_sha256=_search_input_sha256(t, f, None, None))
    calls = []
    def search(*args, **kwargs):
        calls.append(1)
        return first
    monkeypatch.setattr(it, "search_bls", search)
    normal = run(t, f)
    assert len(calls) == 1
    reused = run(t, f, initial_search=first)
    assert len(calls) == 1
    assert reused == normal
    for changed in (dict(search_input_sha256="0" * 64), dict(bls_config_version="stale"),
                    dict(input_snapshot_id="another"), dict(n_valid=3)):
        other = dict(first, **changed)
        with pytest.raises(BlsError, match="initial search does not match"):
            run(t, f, initial_search=other)
    with pytest.raises(BlsError, match="initial search does not match"):
        run(t, f + .01, initial_search=first)


@pytest.mark.parametrize("termination", it.TERMINATION_REASONS)
def test_termination_and_serialization(monkeypatch, termination):
    stub_search(monkeypatch, [[peak()], []])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=""))
    if termination == "no_quality_peak":
        pass
    elif termination == "insufficient_observations":
        result = run(np.arange(10.), np.ones(10))
        assert result["termination"] == termination
        return
    elif termination == "duplicate_or_harmonic_only":
        stub_search(monkeypatch, [[peak()], [peak()]])
    elif termination == "removal_qa_failed":
        monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures="power_not_reduced"))
    elif termination == "candidate_validation_failed":
        monkeypatch.setattr(it, "fixed_snr", lambda *args: 0.)
    elif termination == "numerical_failure":
        monkeypatch.setattr(it, "search_bls", lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("failure")))
    else:
        monkeypatch.setattr(it, "_CONFIG", replace(it._CONFIG, max_candidates=1))
    result = run()
    assert result["termination"] == termination
    assert result["complete"] == (termination in ("no_quality_peak", "duplicate_or_harmonic_only"))
    json.dumps(result, allow_nan=False)


def test_failure_preserves_previous_candidate_and_residual(monkeypatch):
    stub_search(monkeypatch, [[peak()], [peak(3.1)]])
    calls = iter(["", "other_depth_not_measurable"])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=next(calls)))
    t, f = inputs()
    original = f.copy()
    result = run(t, f, keep_residual=True)
    assert result["termination"] == "removal_qa_failed"
    assert result["qa_failed_step"] == 1
    assert len(result["accepted"]) == 1
    expected = it.remove_transit_models(t, f, [result["accepted"][0]["transit_model"]]).flux_residual
    np.testing.assert_array_equal(result["residual"], expected)
    np.testing.assert_array_equal(f, original)
    assert result["accepted"][0]["validated_on_original"]
    assert "candidate_id" not in result["accepted"][0]["transit_model"]


@pytest.mark.parametrize("bad", ["shape", "time", "sector", "baseline", "empty_version"])
def test_invalid_contract_raises(monkeypatch, bad):
    t, f = inputs()
    kw = dict(input_snapshot_id="snapshot", preprocessing_version="version")
    if bad == "shape": f = f[:-1]
    if bad == "time": t = t[::-1]
    if bad == "sector": kw["sector"] = np.zeros(len(t))
    if bad == "baseline": kw["baseline_time"] = t[1:]
    if bad == "empty_version": kw["preprocessing_version"] = ""
    with pytest.raises(BlsError): it.iterate_bls(t, f, **kw)


def test_infinite_flux_is_not_missing():
    t, f = inputs()
    f[0] = np.inf
    assert run(t, f)["termination"] == "numerical_failure"


@pytest.mark.parametrize("bad_depth", [float("nan"), 0., -1.])
def test_other_depth_not_measurable_is_fail_closed(monkeypatch, bad_depth):
    t, f = inputs()
    c = dict(period_days=2., epoch_btjd=.5, duration_hours=2., depth_ppm=10000.)
    powers = iter([100., 10.])
    monkeypatch.setattr(it, "local_max_power", lambda *args: next(powers))
    monkeypatch.setattr(it, "fixed_depth", lambda *args: bad_depth)
    monkeypatch.setattr(it, "edge_excess", lambda *args: .6)
    monkeypatch.setattr(it, "window_offset", lambda *args: (0., 0.))
    rem = it.remove_transit_models(t, f, [it._model(c)])
    qa = it._qa(t, f, f, rem.flux_residual, c, [c], rem, it._CONFIG)
    assert "other_depth_not_measurable" in qa["qa_failures"]


@pytest.mark.parametrize("measurement, expected", [
    ("power", "power_not_reduced"), ("edge", "edge_excess"),
    ("window", "window_offset"), ("missing", "qa_not_measurable"),
    ("overlap", "overlap_distortion"), ("damage", "other_candidate_damaged"),
    ("finite", "non_finite")])
def test_qa_failures(monkeypatch, measurement, expected):
    t, f = inputs()
    c = dict(period_days=2., epoch_btjd=.5, duration_hours=2., depth_ppm=10000.)
    powers = iter([100., 100. if measurement == "power" else 10.])
    monkeypatch.setattr(it, "local_max_power", lambda *args: next(powers))
    depths = iter([.01, .04 if measurement == "damage" else .01])
    monkeypatch.setattr(it, "fixed_depth", lambda *args: next(depths))
    monkeypatch.setattr(it, "edge_excess", lambda *args: 2. if measurement == "edge" else .6)
    monkeypatch.setattr(it, "window_offset", lambda *args: (float("nan"), float("nan")) if measurement == "missing" else (.002, 6.) if measurement == "window" else (0., 0.))
    monkeypatch.setattr(it, "overlap_metrics", lambda *args: (.5, 4. if measurement == "overlap" else .5))
    rem = it.remove_transit_models(t, f, [it._model(c)])
    residual = rem.flux_residual.copy()
    if measurement == "finite": residual[0] = np.nan
    qa = it._qa(t, f, f, residual, c, [c], rem, it._CONFIG)
    assert expected in qa["qa_failures"]


def test_all_masked_sector_is_preserved(monkeypatch):
    actual_search = it.search_bls
    seen = []
    def search(*args, **kwargs):
        result = actual_search(*args, **kwargs)
        seen.append(result)
        return result
    monkeypatch.setattr(it, "search_bls", search)
    t, f = inputs()
    f[np.abs(it.phase_distance_days(t,2.,.5)) < .05] -= .01
    sectors = np.where(t < 10, 1, 2)
    f[sectors == 2] = np.nan
    run(t, f, sector=sectors)
    assert seen
    for p in seen[0]["peaks"]:
        assert [row["sector"] for row in p["sector_stats"]] == [1,2]
        assert p["sector_stats"][1]["depth"] is None
        assert p["sector_consistency_status"] == "not_evaluated"


def test_flat_overlap_returns_pair():
    t = np.linspace(0,10,1000)
    candidate = SimpleNamespace(period_days=2.,epoch_btjd=0.,duration_hours=2.)
    frac, dev = it.overlap_metrics(t,np.ones_like(t),candidate,[(2.,0.,2/24)])
    assert frac == 1 and np.isnan(dev)


@pytest.mark.parametrize("field,value", [("depth",1.),("period_days",float("nan")),("duration_hours",-1.),("power",float("nan")),("snr",float("nan"))])
def test_invalid_refined_peak_is_not_successful_empty(monkeypatch,field,value):
    stub_search(monkeypatch, [[peak()]])
    def refine(t,f,p,*args):
        setattr(p,field,value)
        return p
    monkeypatch.setattr(it,"refine_peak",refine)
    result=run()
    assert result["status"] == "failed"
    assert not result["complete"]
    assert result["accepted"] == []
    assert result["termination"] == "candidate_validation_failed"

@pytest.mark.parametrize("search_end", ["no_quality_peak", "duplicate_or_harmonic_only", "max_iterations_reached"])
@pytest.mark.parametrize("score", [0., float("nan")])
def test_original_validation_appends_consistent_final_record(monkeypatch, search_end, score):
    stub_search(monkeypatch, [[peak()], [peak()] if search_end == "duplicate_or_harmonic_only" else []])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=""))
    if search_end == "max_iterations_reached":
        monkeypatch.setattr(it, "_CONFIG", replace(it._CONFIG, max_candidates=1))
    monkeypatch.setattr(it, "fixed_snr", lambda *args: score)
    t, f = inputs()
    result = run(t, f, keep_residual=True)
    last = result["steps"][-1]
    assert result["termination"] == last["reason"] == "candidate_validation_failed"
    assert last["phase"] == "original_validation"
    assert last["search_termination"] == result["steps"][-2]["reason"] == search_end
    assert last["failed_candidate_steps"] == [0]
    assert last["status"] == "error" and not result["complete"]
    assert result["status"] == "failed" and result["qa_failed_step"] == -1
    assert result["accepted"][0]["validated_on_original"] is False
    expected = it.remove_transit_models(t, f, [result["accepted"][0]["transit_model"]]).flux_residual
    np.testing.assert_array_equal(result["residual"], expected)


def test_original_validation_does_not_replace_removal_failure(monkeypatch):
    stub_search(monkeypatch, [[peak()], [peak(3.1)]])
    failures = iter(["", "power_not_reduced"])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=next(failures)))
    monkeypatch.setattr(it, "fixed_snr", lambda *args: 0.)
    result = run()
    assert result["termination"] == result["steps"][-1]["reason"] == "removal_qa_failed"
    assert result["qa_failed_step"] == 1
    assert result["accepted"][0]["validated_on_original"] is False


def broken_original_snr(*args):
    raise RuntimeError("original validation defect")


@pytest.mark.parametrize("search_end", ["no_quality_peak", "duplicate_or_harmonic_only", "max_iterations_reached"])
def test_original_validation_exception_is_numerical_failure_not_qa_stop(monkeypatch, search_end):
    stub_search(monkeypatch, [[peak()], [peak()] if search_end == "duplicate_or_harmonic_only" else []])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=""))
    if search_end == "max_iterations_reached":
        monkeypatch.setattr(it, "_CONFIG", replace(it._CONFIG, max_candidates=1))
    monkeypatch.setattr(it, "fixed_snr", broken_original_snr)
    result = run()
    last = result["steps"][-1]
    assert result["termination"] == last["reason"] == "numerical_failure"
    assert last["phase"] == "original_validation" and last["error_type"] == "RuntimeError"
    assert last["search_termination"] == search_end and last["failed_candidate_steps"] == [0]
    assert result["status"] == "failed" and not result["complete"]
    assert result["accepted"][0]["validated_on_original"] is False
    json.dumps(result, allow_nan=False)


def test_original_validation_exception_outranks_removal_failure(monkeypatch):
    stub_search(monkeypatch, [[peak()], [peak(3.1)]])
    failures = iter(["", "power_not_reduced"])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures=next(failures)))
    monkeypatch.setattr(it, "fixed_snr", broken_original_snr)
    result = run()
    last = result["steps"][-1]
    assert result["termination"] == last["reason"] == "numerical_failure"
    assert last["search_termination"] == "removal_qa_failed" and last["error_type"] == "RuntimeError"
    assert result["qa_failed_step"] == 1


def test_243_iteration_gate_version_and_fingerprint(monkeypatch):
    from astro_kernel.bls import QUALITY_VERSION, RUNNING_MEDIAN_QUALITY_VERSION
    stub_search(monkeypatch, [[dict(peak(), sde=7.)], [dict(peak(), sde=7.)]])
    monkeypatch.setattr(it, "_qa", lambda *args: dict(qa_failures="forced_test_stop"))
    old = run(quality_version=QUALITY_VERSION)
    new = run(quality_version=RUNNING_MEDIAN_QUALITY_VERSION)
    assert old["termination"] == "removal_qa_failed"
    assert new["termination"] == "no_quality_peak"
    assert new["candidate_quality_version"] == RUNNING_MEDIAN_QUALITY_VERSION
    assert new["iteration_config"]["sde_min"] == 8
    assert old["iteration_config_sha256"] != new["iteration_config_sha256"]
    json.dumps(new, allow_nan=False)

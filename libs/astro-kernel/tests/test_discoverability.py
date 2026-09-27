from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from astro_kernel import discoverability as d
from astro_kernel.bls import BlsError
from astro_kernel.segmentation import bin_sector


def model(cid=1, period=2.):
    return dict(shape="box", candidate_id=f"c-{cid}", baseline={"kind": "unity"},
                residual_model_version="box-divide-v0",
                parameters=dict(period_days=period, epoch_btjd=0., duration_hours=2., depth_ppm=1000.))


def inputs():
    t = np.arange(864) * 10 / 1440
    segment = dict(tic_id=123, sector=1, binning_revision="bin-v1-fixture",
                   **bin_sector(t, np.ones(len(t))).values())
    c = dict(candidate_id=1, peak_id="peak-0", removal_step=0, status="active",
             validated_on_original=True, transit_model=model())
    raw = dict(peak_id="peak-0", step=0, transit_model=model())
    return dict(segments=[segment], quarantined=[]), dict(
        tic_id=123, bundle_id=20, complete=True, catalog_ready=True,
        proposed_candidates=[c], raw_peaks=[raw], lifecycle_actions=[dict(action="add")])


def previous(value=False):
    return dict(tic_id=123, bundle_id=19, complete=True, candidate_quality_revision="old",
                candidates=[dict(candidate_id=1, status="active", discoverable=value, transit_model=model())])


def fake_evaluator(monkeypatch, verdict=True, failure=None):
    def evaluate(t, f, prior, m, periods, rule):
        failed = failure and m is not None
        return dict(status="calculation_failed" if failed else "measured", qualified_peaks=[],
                    discoverable=None if failed or m is None else verdict,
                    reason=failure if failed else "test"), f.copy(), None
    monkeypatch.setattr(d, "evaluate", evaluate)


def run(seg, cat, **kwargs):
    return d.prepare_discoverability(seg, cat, fine_tune={"half_width_cells": 3},
                                     candidate_quality_version="quality-122", **kwargs)


def test_false_to_true_is_history_proposal_without_publication(monkeypatch):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    old = previous()
    original = deepcopy((seg, cat, old))
    result = run(seg, cat, previous_bundle=old, rule_approval="review-fixture")
    assert result["discoverability_ready"] and not result["publishable"]
    assert result["candidates"][0]["discoverable"] is True
    assert result["changes"][0]["old_value"] == "false"
    assert result["changes"][0]["new_value"] == "true"
    assert result["changes"][0]["bundle_id"] == 20
    assert (seg, cat, old) == original


@pytest.mark.parametrize("failure", ["degenerate_flux", "numerical_failure", "insufficient_observations"])
def test_failed_candidate_holds_entire_bundle(monkeypatch, failure):
    fake_evaluator(monkeypatch, failure=failure)
    seg, cat = inputs()
    old = previous(True)
    result = run(seg, cat, previous_bundle=old, rule_approval="review-fixture")
    assert result["status"] == "held"
    assert result["candidates"] == old["candidates"]
    assert result["proposed_candidates"] == result["changes"] == []
    assert result["evaluations"][1]["discoverable"] is None


def test_missing_approval_and_quarantine_do_not_publish(monkeypatch):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    assert run(seg, cat)["reasons"] == ["discoverability_approval_required"]
    seg["quarantined"] = [dict(sector=2, reason="no_valid_bins")]
    result = run(seg, cat, rule_approval="review-fixture")
    assert result["reasons"] == ["segment_quarantined"]
    assert not result["evaluations"] and not result["proposed_candidates"]


def test_new_candidate_does_not_emit_false_to_true(monkeypatch):
    fake_evaluator(monkeypatch)
    assert run(*inputs(), rule_approval="review-fixture")["changes"] == []


@pytest.mark.parametrize("key,value", [("epoch_tolerance", "other"), ("harmonic_matching", True),
                                       ("status", "approved"), ("snr_min", 6.)])
def test_unsupported_rule_is_rejected(key, value):
    rule = deepcopy(d.RULE)
    rule[key] = value
    with pytest.raises(ValueError, match="unsupported"):
        run(*inputs(), rule=rule)


def test_wrong_grid_and_insufficient_ui_width_rejected():
    rule = deepcopy(d.RULE)
    rule["grid"]["max_rule"] = "fixed40"
    with pytest.raises(ValueError):
        run(*inputs(), rule=rule)
    with pytest.raises(ValueError, match="half_width"):
        d.prepare_discoverability(*inputs(), fine_tune={"half_width_cells": 2}, candidate_quality_version="v1")


@pytest.mark.parametrize("code", ["invalid_input", "invalid_grid"])
def test_programming_errors_propagate(monkeypatch, code):
    def fail(*args, **kwargs):
        raise BlsError(code, "test")
    monkeypatch.setattr(d, "bls_periodogram", fail)
    with pytest.raises(BlsError, match=code):
        d.evaluate(np.arange(100.), np.ones(100), [], None, np.geomspace(.5, 40, 5000))


def test_measurement_failure_is_null():
    result, _, _ = d.evaluate(np.arange(100.), np.ones(100), [], None, np.geomspace(.5, 40, 5000))
    assert result["discoverable"] is None and result["reason"] == "degenerate_flux"


def test_sorted_indices_map_overlapping_sectors_and_local_gaps():
    a = dict(sector=2, **bin_sector([0., 20/1440], [np.nan, 2.]).values())
    b = dict(sector=1, **bin_sector([10/1440, 30/1440], [3., 4.]).values())
    t, f, records = d.provided_arrays([a, b])
    assert np.all(np.diff(t) >= 0)
    for s in [a, b]:
        record = next(r for r in records if r["sector"] == s["sector"])
        np.testing.assert_allclose(f[record["sorted_indices"]], np.asarray(s["flux"], float), equal_nan=True)
        assert record["gaps"] == s["gaps"]


def test_revision_stable_and_changes_with_actual_input(monkeypatch):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    first = run(seg, cat, rule_approval="a")["candidate_quality_revision"]
    assert first == run(seg, cat, rule_approval="b")["candidate_quality_revision"]
    seg["segments"][0]["flux"][0] += .001
    assert first != run(seg, cat, rule_approval="a")["candidate_quality_revision"]


def test_same_revision_cannot_change_decision(monkeypatch):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    old = previous()
    old["candidate_quality_revision"] = run(seg, cat, rule_approval="a")["candidate_quality_revision"]
    with pytest.raises(ValueError, match="same candidate_quality"):
        run(seg, cat, rule_approval="a", previous_bundle=old)


def test_discovery_residual_includes_raw_peaks_omitted_by_identity(monkeypatch):
    seg, cat = inputs()
    c = cat["proposed_candidates"][0]
    c["removal_step"] = 2
    cat["raw_peaks"][0]["step"] = 2
    cat["raw_peaks"].insert(0, dict(peak_id="other", step=0, transit_model=model(99, 3.)))
    seen = []
    def evaluate(t, f, prior, m, periods, rule):
        seen.append([x["candidate_id"] for x in prior])
        return dict(status="measured", qualified_peaks=[], discoverable=True if m else None, reason="test"), f, None
    monkeypatch.setattr(d, "evaluate", evaluate)
    run(seg, cat, rule_approval="a")
    assert seen == [[], ["c-99"]]


def test_quality_gate_runs_before_transit_count(monkeypatch):
    pg = SimpleNamespace(power=np.array([0., 10., 0.]), snr=np.array([0., 6., 0.]),
                         sde=np.array([0., 10., 0.]))
    def fail(*args):
        raise AssertionError("low SNR peak should not count transits")
    monkeypatch.setattr(d, "phase_distance_days", fail)
    assert d.classify(pg, np.arange(100.), np.ones(100), None, d.RULE)["qualified_peaks"] == []


def _three_runs():
    """10-minute bins in runs [0,10), [12,22), [24,34) days: two 2-day gaps."""
    t = np.arange(0, 34, 10 / 1440)
    t = t[(t < 10) | ((t >= 12) & (t < 22)) | (t >= 24)]
    return t, np.ones(len(t))


def _counted(t, f, period, epoch, duration_hours=2.88):
    pg = SimpleNamespace(power=np.array([0., 10., 0.]), snr=np.array([0., 20., 0.]), sde=np.array([0., 10., 0.]),
                         periods=np.array([period] * 3), epoch_btjd=np.array([epoch] * 3),
                         duration_hours=np.array([duration_hours] * 3))
    peaks = d.classify(pg, t, f, None, d.RULE)["qualified_peaks"]
    return peaks[0]["n_transits"] if peaks else 0


def test_interior_mask_drops_run_edges_only_at_long_gaps():
    t, f = _three_runs()
    f[(t > 5) & (t < 5.2)] = np.nan  # a 0.2-day hole does not split the run
    interior = d.interior_mask(t, f, d.RULE)
    for edge in (0.0, 9.9, 12.0, 21.9, 24.2, 33.9):
        assert not interior[np.argmin(np.abs(t - edge))], edge
    for inside in (0.6, 4.9, 5.3, 12.6, 30.0):
        assert interior[np.argmin(np.abs(t - inside))], inside
    assert not interior[~np.isfinite(f)].any()
    with pytest.raises(ValueError, match="ascending"):
        d.interior_mask(t[::-1], f[::-1], d.RULE)


def test_edge_gap_matches_preprocessing_gap():
    """Runs split where preprocessing splits them; changing one without the other needs a new rule version."""
    from astro_kernel.preprocessing import preprocessing_config
    assert d.RULE["edge_gap_days"] == preprocessing_config()["gap_days"]


def test_transits_count_only_well_covered_and_away_from_run_edges():
    """S15P21C206-282: a dip right after data resumes or a single edge bin is not a transit."""
    t, f = _three_runs()
    assert _counted(t, f, 6., 3.) == 6, "3 to 33 every 6 days, all at least a day inside a run"
    assert _counted(t, f, 12., 12.25) == 0, "0.25, 12.25, 24.25 all fall in the first 12 h after a gap"
    assert _counted(t, f, 10., 5.) == 3
    thin = f.copy()
    window = np.abs(t - 15.) < 2.88 / 48
    thin[window] = np.nan
    thin[np.flatnonzero(window)[0]] = 1.
    assert _counted(t, thin, 10., 5.) == 2, "15 keeps one bin of its window and no longer counts"


def test_real_bls_on_synthetic_curve_and_122_catalog():
    from astro_kernel.candidate_catalog import build_candidate_catalog
    from astro_kernel.iteration import ITERATION_VERSION
    from astro_kernel.transit_model import model_flux
    t = (np.arange(8640) + .5) * 2 / 1440
    m = model()
    f = model_flux(t, m) + np.random.default_rng(123).normal(0, .0001, len(t))
    raw_model = deepcopy(m)
    raw_model.pop("candidate_id")
    peak = dict(peak_id="peak-0", step=0, **m["parameters"], snr=20., sde=10., bls_power=100.,
                n_transits=6, original_snr=20., validated_on_original=True, transit_model=raw_model)
    source = dict(iteration_version=ITERATION_VERSION, complete=True, status="ok", termination="no_quality_peak",
                  time_start_btjd=float(t[0]), time_end_btjd=float(t[-1]), accepted=[peak],
                  input_snapshot_id="snapshot", preprocessing_version="silver", iteration_config_sha256="fixture", qa_failed_step=-1)
    cat = build_candidate_catalog(source, tic_id=123, bundle_id=20, new_candidate_ids={"peak-0": 1}, identity_approval="fixture")
    seg = dict(segments=[dict(tic_id=123, sector=1, binning_revision="fixture", **bin_sector(t, f).values())], quarantined=[])
    result = run(seg, cat, rule_approval="fixture")
    assert result["discoverability_ready"]
    assert result["candidates"][0]["discoverable"] is True
    assert len(result["periodograms"][0]["periodogram"].periods) == 5000


def test_one_failed_candidate_does_not_leak_successful_proposal(monkeypatch):
    seg, cat = inputs()
    c = deepcopy(cat["proposed_candidates"][0])
    c.update(candidate_id=2, peak_id="peak-1", removal_step=1, transit_model=model(2, 3.))
    cat["proposed_candidates"].append(c)
    cat["raw_peaks"].append(dict(step=1, peak_id="peak-1", transit_model=c["transit_model"]))
    def evaluate(t, f, prior, m, periods, rule):
        failed = m is not None and m["candidate_id"] == "c-2"
        return dict(status="calculation_failed" if failed else "measured", discoverable=None if failed else True,
                    qualified_peaks=[], reason="numerical_failure" if failed else "test"), f, None
    monkeypatch.setattr(d, "evaluate", evaluate)
    old = previous()
    result = run(seg, cat, previous_bundle=old, rule_approval="fixture")
    assert result["evaluations"][1]["discoverable"] is True
    assert result["candidates"] == old["candidates"] and result["proposed_candidates"] == []
    assert result["changes"] == []


def test_gaps_must_match_flux():
    seg, _ = inputs()
    seg["segments"][0]["gaps"] = [[0, 1]]
    with pytest.raises(ValueError, match="gaps"):
        d.provided_arrays(seg["segments"])


def test_grid_uses_gold_contract_margin(monkeypatch):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    cat["proposed_candidates"][0]["transit_model"]["parameters"]["period_days"] = 40.
    cat["raw_peaks"][0]["transit_model"]["parameters"]["period_days"] = 40.
    result = run(seg, cat, rule_approval="fixture")
    assert result["period_max_days"] == 46.


@pytest.mark.parametrize("value", [None, 0, "false"])
def test_retired_requires_boolean(monkeypatch, value):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    retired = dict(candidate_id=2, status="retired", transit_model=model(2))
    if value is not None:
        retired["discoverable"] = value
    cat["proposed_candidates"].append(retired)
    with pytest.raises(ValueError, match="retired candidates require boolean"):
        run(seg, cat, rule_approval="fixture")


@pytest.mark.parametrize("value", [True, False])
def test_retired_boolean_is_preserved(monkeypatch, value):
    fake_evaluator(monkeypatch)
    seg, cat = inputs()
    retired = dict(candidate_id=2, status="retired", transit_model=model(2), discoverable=value)
    cat["proposed_candidates"].append(retired)
    result = run(seg, cat, rule_approval="fixture")
    assert result["discoverability_ready"]
    assert result["candidates"][1] == retired


def test_evaluate_still_rejects_unsupported_rule():
    rule = deepcopy(d.RULE)
    rule["objective"] = "unsupported"
    with pytest.raises(ValueError, match="unsupported discoverability rule"):
        d.evaluate([0., 1.], [1., 1.], [], None, [1., 2.], rule)

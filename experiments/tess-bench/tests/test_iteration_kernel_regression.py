"""The regression checker must reject changed decisions and numerical results."""
from dataclasses import asdict
import json
from types import SimpleNamespace

import numpy as np
import pytest

from tess_bench.iterate import StepRecord
from tess_bench.iteration_kernel_regression import compare


def pair():
    row = StepRecord(0, "qa_failed", "removal_qa_failed", qa_failures="other_depth_not_measurable", power_ratio=0.2)
    record = {key: (None if isinstance(value, float) and not np.isfinite(value) else value)
              for key, value in asdict(row).items()}
    old = SimpleNamespace(termination="removal_qa_failed", qa_failed_step=0, accepted=[], steps=[row], residual=np.array([1.0, np.nan]))
    new = dict(termination=old.termination, qa_failed_step=0, accepted=[], steps=[record], residual=old.residual.copy())
    return old, new


def test_matching_null_metrics_and_residual_pass():
    compare(*pair())


@pytest.mark.parametrize("field,value", [("qa_failures", ""), ("power_ratio", 0.3), ("edge_excess", 0.0)])
def test_changed_qa_evidence_rejected(field, value):
    old, new = pair()
    new["steps"][0][field] = value
    with pytest.raises(AssertionError):
        compare(old, new)


def test_missing_step_rejected():
    old, new = pair()
    new["steps"] = []
    with pytest.raises(ValueError):
        compare(old, new)


def test_failed_rollback_rejected():
    old, new = pair()
    new["residual"][0] = 1.01
    with pytest.raises(AssertionError):
        compare(old, new)

@pytest.mark.parametrize("power", [None, float("nan"), 0, -1, True])
def test_invalid_bls_power_rejected(power):
    old, new = pair()
    new["accepted"] = [{"bls_power": power}]
    with pytest.raises(AssertionError, match="bls_power"):
        compare(old, new)

from tess_bench.iteration_kernel_regression import (
    DIAGNOSTIC_FIELDS, compare_diagnostic, compare_search_diagnostics,
)
from tess_bench.iterate import Candidate
from astro_kernel.bls import search_bls


@pytest.fixture
def diagnostic_case():
    t = np.arange(0., 20., .02)
    f = 1 + np.random.default_rng(122).normal(0., .0001, len(t))
    inside = np.abs((t - .5 + 1) % 2 - 1) < .05
    f[inside] -= .01
    sectors = np.where(t < 10, 1, 2)
    f[sectors == 2] = np.nan
    f[20:30] = np.nan
    searched = search_bls(t, f, sector=sectors, baseline_time=t,
                         input_snapshot_id="fixture", preprocessing_version="fixture")
    p = searched["peaks"][0]
    c = Candidate(step=0, period_days=p["period_days"], epoch_btjd=p["epoch_btjd"],
                  duration_hours=p["duration_hours"], depth_ppm=p["depth"] * 1e6,
                  sde=p["sde"], snr=p["snr"], n_transits=p["n_transits"], rank=p["rank"])
    diag = json.loads(json.dumps({key: p[key] for key in DIAGNOSTIC_FIELDS}, allow_nan=False))
    return t, f, sectors, SimpleNamespace(accepted=[c]), {"accepted": [{"search_diagnostics": diag}]}


def diagnostic_check(case):
    t, f, sectors, reference, actual = case
    compare_search_diagnostics(t, f, sectors, t, reference, actual,
                               input_snapshot_id="fixture", preprocessing_version="fixture")


def test_reference_diagnostics_include_fully_masked_sector(diagnostic_case):
    diag = diagnostic_case[-1]["accepted"][0]["search_diagnostics"]
    assert [row["sector"] for row in diag["sector_stats"]] == [1, 2]
    assert diag["sector_stats"][1]["depth"] is None
    assert diag["sector_consistency_status"] == "not_evaluated"
    assert diag["mask_dropped_fraction"] > 0
    assert "baseline_time_unavailable" not in diag["diagnostic_reasons"]
    diagnostic_check(diagnostic_case)


@pytest.mark.parametrize("field", DIAGNOSTIC_FIELDS)
def test_missing_diagnostic_field_rejected(diagnostic_case, field):
    diagnostic_case[-1]["accepted"][0]["search_diagnostics"].pop(field)
    with pytest.raises(AssertionError):
        diagnostic_check(diagnostic_case)


@pytest.mark.parametrize("mutation", ["sector", "depth", "mask_null", "mask_wrong", "reasons", "coarse_epoch", "missing"])
def test_corrupt_diagnostics_rejected(diagnostic_case, mutation):
    candidate = diagnostic_case[-1]["accepted"][0]
    diag = candidate["search_diagnostics"]
    if mutation == "sector": diag["sector_stats"].pop()
    elif mutation == "depth": diag["sector_stats"][1]["depth"] = 0.
    elif mutation == "mask_null": diag["mask_dropped_fraction"] = None
    elif mutation == "mask_wrong": diag["mask_dropped_fraction"] = 0.
    elif mutation == "reasons": diag["diagnostic_reasons"].append("baseline_time_unavailable")
    elif mutation == "coarse_epoch": diag["epoch_btjd"] += .01
    else: candidate.pop("search_diagnostics")
    with pytest.raises(AssertionError):
        diagnostic_check(diagnostic_case)


def test_new_original_validation_record_compares_to_111_legacy_history():
    c = Candidate(0, 2., .5, 2., 1000., 8., 10., 10, 1, False, 0.)
    old_step = StepRecord(1, "terminated", "no_quality_peak")
    old = SimpleNamespace(termination="candidate_validation_failed", qa_failed_step=-1,
                          accepted=[c], steps=[old_step], residual=np.ones(100))
    step = {key: (None if isinstance(value, float) and not np.isfinite(value) else value)
            for key, value in asdict(old_step).items()}
    new = dict(termination=old.termination, qa_failed_step=-1,
               accepted=[dict(asdict(c), bls_power=100.)], residual=old.residual.copy(),
               steps=[step, dict(phase="original_validation", status="error",
                   reason="candidate_validation_failed", search_termination="no_quality_peak",
                   failed_candidate_steps=[0])])
    compare(old, new)
    new["steps"][-1]["reason"] = "no_quality_peak"
    with pytest.raises(AssertionError): compare(old, new)


def test_243_real_calculation_reference_adapter_and_kernel():
    from astro_kernel.bls import RUNNING_MEDIAN_QUALITY_VERSION
    from astro_kernel.iteration import iterate_bls
    from tess_bench.bls import BlsSetting
    from tess_bench.iterate import IterateConfig
    from tess_bench.iteration_kernel_regression import reference_iteration
    t = np.linspace(0, 20, 1500)
    f = 1 + np.random.default_rng(243).normal(0, .001, t.size)
    f[np.abs((t-.5+1.5) % 3-1.5) < .05] -= .01
    cfg = IterateConfig(sde_min=8., qa_window_offset_rel_depth=.1,
                        refine_duration_span=(.5, 2.), refine_duration_max_hours=12.)
    old = reference_iteration(t, f, BlsSetting('test', n_periods=20000), cfg, RUNNING_MEDIAN_QUALITY_VERSION)
    new = iterate_bls(t, f, input_snapshot_id="synthetic-243", preprocessing_version="test",
                      baseline_time=t, keep_residual=True, quality_version=RUNNING_MEDIAN_QUALITY_VERSION)
    compare(old, new)

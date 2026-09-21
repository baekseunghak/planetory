"""The regression checker must reject changed decisions and numerical results."""
from dataclasses import asdict
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

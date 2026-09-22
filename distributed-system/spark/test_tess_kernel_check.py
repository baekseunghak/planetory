"""Offline D19 contracts; actual Spark/YARN parity remains user-run."""
import copy
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs/astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tess_kernel_check as check


def sample(tic=127):
    t = np.arange(1400, 1412, 2 / 1440)
    f = 1 + np.random.default_rng(127).normal(0, 0.0003, len(t))
    f[np.abs((t - 1401 + 1.5) % 3 - 1.5) < 0.04] *= 0.997
    return check.snapshot([check.clean(dict(
        tic_id=tic, sector=1, product_id=f"{tic}.fits", raw_sha256="a" * 64,
        input_snapshot_id="fixture", time=t, flux=f, flux_err=np.full(len(t), 0.0003),
        quality=np.zeros(len(t), dtype=int), cadenceno=np.arange(len(t))))])


def test_adapter_calls_real_preprocessing_and_bls_and_preserves_provenance():
    item = sample()
    result = check.evaluate(item)
    assert result["status"] == "ok"
    assert result["bls"]["peaks"][0]["period_days"] == pytest.approx(3, rel=0.003)
    assert result["prepared"]["source_row"] == list(range(len(item["products"][0]["time"])))
    check.compare(result, check.evaluate(copy.deepcopy(item)))
    changed = copy.deepcopy(result)
    changed["periodogram"]["power"][0] += 1
    with pytest.raises(ValueError, match="numeric mismatch"):
        check.compare(result, changed)


def test_input_hash_and_duplicate_sector_rejected():
    item = sample()
    altered = copy.deepcopy(item)
    altered["products"][0]["flux"][0] += 1
    with pytest.raises(ValueError, match="identity mismatch"):
        check.evaluate(altered)
    with pytest.raises(ValueError, match="multiple products"):
        check.snapshot(item["products"] * 2)


def test_only_failed_or_missing_tics_retry_and_changed_code_rejected():
    inputs = [sample(127), sample(128), sample(129)]
    success = check.evaluate(inputs[0])
    failed = check.evaluate(inputs[1], fail_tic=128)
    assert failed["error_code"] == "injected_failure"
    work = check.pending(inputs, [success, failed])
    assert [r["tic_id"] for r in work] == [128, 129]
    recovered = check.evaluate(work[0])
    assert recovered["status"] == "ok"
    assert [r["tic_id"] for r in check.pending(inputs, [success, recovered])] == [129]
    recovered["code_sha256"] = "changed"
    with pytest.raises(ValueError, match="input/code changed"):
        check.pending(inputs, [success, recovered])


def test_missing_observations_not_reported_as_no_signal():
    product = sample()["products"][0]
    product["flux"] = ["NaN"] * len(product["flux"])
    result = check.evaluate(check.snapshot([product]))
    assert result["status"] == "failed"
    assert result["error_stage"] == "preprocessing"
    assert "bls" not in result


def test_null_nan_mask_and_discrete_values_are_not_tolerated_as_numeric_drift():
    with pytest.raises(ValueError):
        check.compare({"flux": ["NaN"]}, {"flux": [0.0]})
    with pytest.raises(ValueError):
        check.compare({"kept": [True]}, {"kept": [1]})
    with pytest.raises(ValueError):
        check.indexed([{"tic_id": 1}, {"tic_id": 1}])

"""D13 regression against unchanged D04 experiment arithmetic, synthetic only."""
import numpy as np
import pytest

from astro_kernel.bls import search_bls
from tess_bench.bls import BlsSetting, run_bls
from tess_bench.bls_kernel_regression import compare


@pytest.mark.parametrize("depth", [0, 0.0005, 0.003])
def test_d04_default_grid_metrics_and_gate_are_reproduced(depth):
    t = np.arange(1400, 1412, 2 / 1440)
    f = 1 + np.random.default_rng(110).normal(0, 0.0003, len(t))
    f[np.abs((t - 1401 + 1.5) % 3 - 1.5) < 0.04] *= 1 - depth
    keep = np.ones(len(t), bool)
    keep[500:550] = False
    reference = run_bls(t[keep], f[keep], BlsSetting("poc_linear20k"),
                        baseline_time=t, keep_periodogram=True)
    result = search_bls(t[keep], f[keep], baseline_time=t,
                        sector=np.where(t[keep] < 1406, 1, 2),
                        input_snapshot_id="d04-synthetic-regression", preprocessing_version="test")
    compare(reference, result)
    np.testing.assert_allclose(result["periodogram"].power, reference.power, rtol=1e-12)
    for actual, expected in zip(result["peaks"], reference.peaks, strict=True):
        for name in ("period_days", "epoch_btjd", "duration_hours", "depth", "depth_err",
                     "power", "sde", "snr", "n_transits", "n_in_transit", "mask_dropped_fraction"):
            assert actual[name] == pytest.approx(getattr(expected, name), rel=1e-12)
        assert (actual["status"] == "accepted") == (expected.snr >= 7 and expected.sde >= 6)
        assert actual["sector_consistency_status"] == "not_evaluated"

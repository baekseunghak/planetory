"""D13's boundary, quality, and D12 integration contracts (no FITS needed)."""
import numpy as np
import pytest

from astro_kernel.bls import BlsError, bls_periodogram, period_grid, quality_gate, search_bls
from astro_kernel.preprocessing import SectorInput, preprocess_silver


def curve():
    t = np.arange(1400, 1412, 2 / 1440)
    f = 1 + np.random.default_rng(120).normal(0, 0.0003, len(t))
    f[np.abs((t - 1401 + 1.5) % 3 - 1.5) < 0.04] *= 0.997
    return t, f


def search(t, f, **kwargs):
    return search_bls(t, f, input_snapshot_id="synthetic-120", preprocessing_version="test", **kwargs)


def test_gate_boundaries_and_failure_are_distinct():
    assert quality_gate(7, 6) == ("accepted", [])
    assert quality_gate(6.99, 6) == ("held", ["snr_below_threshold"])
    assert quality_gate(7, 5.99) == ("held", ["sde_below_threshold"])
    assert quality_gate(np.nan, 7)[0] == "failed"


def test_d12_output_connects_without_changing_provenance():
    t, f = curve()
    raw = SectorInput(120, 1, "synthetic-product", t, f, np.full(len(t), 0.0003),
                      np.zeros(len(t), dtype=int), np.arange(len(t)))
    prepared, detrended = preprocess_silver([raw])
    assert detrended.status == "ok"
    result = search_bls(detrended.time, detrended.flux_det,
                        input_snapshot_id="synthetic-120", preprocessing_version=detrended.version,
                        sector=prepared.sector, baseline_time=t)
    assert result["status"] == "ok"
    peak = result["peaks"][0]
    assert peak["period_days"] == pytest.approx(3, rel=0.003)
    assert peak["n_transits"] == 4
    assert peak["sector_consistency_status"] == "not_applicable"
    assert peak["sector_stats"][0]["depth"] > 0
    assert 0 <= peak["mask_dropped_fraction"] <= 1
    assert result["periodogram"].periods.size == 20000
    np.testing.assert_array_equal(raw.flux, f)


def test_provided_log_grid_keeps_nan_positions_and_rejects_bad_grid():
    t, f = curve()
    f[30:40] = np.nan
    p = period_grid(0.5, 40, 5000, spacing="log")
    pg = bls_periodogram(t, f, p, config_version="provided-test")
    np.testing.assert_allclose(pg.periods, 0.5 * 80 ** (np.arange(5000) / 4999))
    np.testing.assert_array_equal(pg.valid_input, np.isfinite(f))
    assert np.isfinite(pg.power).all()
    with pytest.raises(BlsError, match="invalid_grid"):
        bls_periodogram(t, f, p[::-1], config_version="bad")
    with pytest.raises(BlsError, match="invalid_grid"):
        period_grid(0.5, 40, True, spacing="log")


def test_noise_flat_missing_and_short_inputs_are_not_conflated():
    t, _ = curve()
    f = 1 + np.random.default_rng(721).normal(0, 0.0003, len(t))
    result = search(t, f)
    assert result["status"] == "no_quality_peak"
    assert result["n_accepted"] == 0
    assert result["peaks"][0]["mask_dropped_fraction"] is None
    with pytest.raises(BlsError, match="degenerate_flux"):
        search(t, np.ones(len(t)))
    with pytest.raises(BlsError, match="insufficient_observations"):
        search(t[:99], f[:99])
    with pytest.raises(BlsError, match="insufficient_observations"):
        search(t, np.full(len(t), np.nan))
    with pytest.raises(BlsError, match="invalid_input"):
        search(t, f, baseline_time=t[1:])
    f[0] = np.inf
    with pytest.raises(BlsError, match="numerical_failure"):
        search(t, f)


def test_nonfinite_peak_fails_closed(monkeypatch):
    import astro_kernel.bls as kernel
    t, f = curve()
    real = kernel.bls_periodogram

    def corrupted(*args, **kwargs):
        pg = real(*args, **kwargs)
        pg.depth[np.argmax(pg.power)] = np.nan
        return pg

    monkeypatch.setattr(kernel, "bls_periodogram", corrupted)
    result = search(t, f)
    assert result["status"] == "failed"
    assert result["accepted_peaks"] == []
    assert result["peaks"][0]["reasons"] == ["invalid_peak_geometry"]

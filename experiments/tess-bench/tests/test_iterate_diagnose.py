import numpy as np
import pytest

from tess_bench.iterate import Candidate, in_transit_mask
from tess_bench.iterate_diagnose import measure


def test_diagnostic_separates_baseline_offset_from_removal_error():
    t = np.arange(0, 20, 0.002)
    c = Candidate(0, 1, 0.5, 8, 3000, 10, 20, 20, 1)
    mask = in_transit_mask(t, 1, 0.5, 8 / 24)
    baseline = 1.0006 + np.random.default_rng(4).normal(0, 1e-5, t.size)
    flux = baseline * np.where(mask, 0.997, 1)
    original = flux.copy()
    result = measure(t, flux, c)
    assert result['after_inside_mean_ppm'] == pytest.approx(600, abs=2)
    assert abs(result['after_inside_minus_outside_ppm']) < 2
    assert result['window_offset_rel'] == pytest.approx(0.2, abs=0.002)
    np.testing.assert_array_equal(flux, original)


def test_diagnostic_exposes_excess_removal_against_outside_baseline():
    t = np.arange(0, 20, 0.002)
    c = Candidate(0, 1, 0.5, 8, 9000, 10, 20, 20, 1)
    mask = in_transit_mask(t, 1, 0.5, 8 / 24)
    flux = (1 + np.random.default_rng(4).normal(0, 1e-5, t.size)) * np.where(mask, 0.997, 1)
    result = measure(t, flux, c)
    assert abs(result['after_outside_mean_ppm']) < 2
    assert result['after_inside_minus_outside_ppm'] > 6000

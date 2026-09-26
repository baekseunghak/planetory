"""243 operational gate and provided-grid isolation."""
import numpy as np
import pytest
from scipy.ndimage import median_filter
from astro_kernel import bls

V1 = bls.RUNNING_MEDIAN_QUALITY_VERSION


def test_sde_matches_frozen_definition_including_edges():
    p = np.linspace(.5, 20, 20000)
    y = np.random.default_rng(243).normal(size=p.size) + np.linspace(0, 50, p.size)
    y[[0, -1]] += 10
    residual = y - median_filter(y, size=1001, mode="reflect")
    np.testing.assert_allclose(bls.running_median_sde(p, y),
                               (residual-residual.mean()) / residual.std(ddof=0), rtol=1e-12)
    assert np.isnan(bls.running_median_sde(p, np.ones(p.size))).all()


@pytest.mark.parametrize("p", [np.linspace(.5, 20, 19999), np.geomspace(.5, 20, 20000),
                               np.linspace(.6, 20, 20000)])
def test_changed_grid_requires_review(p):
    with pytest.raises(bls.BlsError, match="invalid_grid"):
        bls.running_median_sde(p, np.ones(p.size))


def test_versioned_gate_boundaries():
    assert bls.quality_gate(7, 6)[0] == "accepted"
    for snr, sde, ntr, accepted in [(7, 8, 2, True), (7, 7.99, 2, False),
                                   (6.99, 8, 2, False), (7, 8, 1, False), (7, np.nan, 2, False)]:
        assert (bls.quality_gate(snr, sde, quality_version=V1, n_transits=ntr)[0] == "accepted") == accepted
    with pytest.raises(bls.BlsError):
        bls.quality_gate(7, 8, quality_version="unknown", n_transits=2)


def test_search_preserves_power_ranks_and_provided_sde():
    t = np.linspace(0, 20, 1500)
    f = 1 + np.random.default_rng(243).normal(0, .001, t.size)
    f[np.abs((t-.5+1.5) % 3-1.5) < .05] -= .01
    kwargs = dict(input_snapshot_id="synthetic", preprocessing_version="test")
    old = bls.search_bls(t, f, **kwargs)
    new = bls.search_bls(t, f, quality_version=V1, **kwargs)
    assert new["candidate_quality_version"] == V1
    np.testing.assert_array_equal(old["periodogram"].sde, new["periodogram"].sde)
    assert [p["period_days"] for p in old["peaks"]] == [p["period_days"] for p in new["peaks"]]
    scores = bls.running_median_sde(new["periodogram"].periods, new["periodogram"].power)
    for peak in new["peaks"]:
        i = np.searchsorted(new["periodogram"].periods, peak["period_days"])
        assert peak["sde"] == scores[i]
        assert (peak["status"] == "accepted") == (peak["snr"] >= 7 and scores[i] >= 8 and peak["n_transits"] >= 2)

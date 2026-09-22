import json
from types import SimpleNamespace

import numpy as np
import pytest

from astro_kernel.segmentation import bin_sector, segment_revision, segment_silver, SegmentationError


def test_edges_partial_gaps_and_json():
    result = bin_sector(np.array([0, 2, 10, 20, 40, 42]) / 1440,
                        [1, 3, 5, np.nan, 7, 9])
    np.testing.assert_allclose(result.flux, [2, 5, np.nan, np.nan, 8], equal_nan=True)
    assert result.counts.tolist() == [2, 1, 0, 0, 2]
    assert result.gaps == [[2, 3]]
    np.testing.assert_allclose(result.centers * 1440, [5, 15, 25, 35, 45])
    assert result.flux_scatter == pytest.approx(1.4826 * 3)
    assert json.loads(json.dumps(result.values(), allow_nan=False))["flux"] == [2, 5, None, None, 8]


def test_excluded_anchor_and_last_time_are_preserved():
    r = bin_sector(np.array([30, 10, 0]) / 1440, [np.nan, 1, np.nan])
    assert r.start_btjd == 0
    assert r.gaps == [[0, 0], [2, 3]]
    assert r.flux_scatter == 0


def test_snap_and_unsnapped_left_boundary():
    r = bin_sector(np.array([0, 10 * (1 - 5e-9), 20 * (1 - 1e-7)]) / 1440, [1, 3, 5])
    assert r.counts.tolist() == [1, 2]


def test_limit_never_widens():
    assert len(bin_sector([0, 19999 * 10 / 1440], [1, 1]).flux) == 20000
    with pytest.raises(SegmentationError, match="point_limit"):
        bin_sector([0, 20000 * 10 / 1440], [1, 1])


@pytest.mark.parametrize("t,f,reason", [
    ([], [], "invalid_input"), ([0], [], "invalid_input"),
    ([np.nan], [1], "invalid_time"), ([0, 0], [1, 1], "duplicate_time"),
    ([0, 1], [np.nan, np.inf], "no_valid_bins"),
])
def test_invalid_input_fails(t, f, reason):
    with pytest.raises(SegmentationError, match=reason):
        bin_sector(t, f)


def provenance():
    return dict(tic_id=123, sector=2, snapshot_id="raw-v1", products={"a": "a" * 64, "b": "b" * 64},
                preprocessing_version="silver-biweight-1.0.0",
                preprocessing_parameters={"window_days": 1.0, "masks": []})


def test_revision_is_order_independent_and_change_sensitive():
    p = provenance()
    original = segment_revision(**p)
    assert original == segment_revision(**{**p, "products": dict(reversed(list(p["products"].items())))})
    for key, value in [("sector", 3), ("tic_id", 456), ("snapshot_id", "raw-v2"),
                       ("products", {"a": "c" * 64}), ("preprocessing_version", "silver-v2"),
                       ("preprocessing_parameters", {"window_days": 2.0}),
                       ("numerical_version", "segment-numpy-2.0.0")]:
        assert original != segment_revision(**{**p, key: value})


@pytest.mark.parametrize("changes", [
    {"products": {}}, {"products": {"a": "bad"}}, {"tic_id": True},
    {"preprocessing_parameters": {"window": float("nan")}}, {"snapshot_id": ""},
])
def test_bad_provenance_rejected(changes):
    with pytest.raises(SegmentationError, match="invalid_provenance"):
        segment_revision(**{**provenance(), **changes})


def test_matches_direct_mean_for_irregular_observations():
    rng = np.random.default_rng(123)
    t = np.sort(rng.uniform(0, 2, 1000))
    f = rng.normal(1, .001, len(t))
    f[::7] = np.nan
    r = bin_sector(t, f)
    indices = np.floor((t - t[0]) * 144).astype(int)
    for i in range(len(r.flux)):
        values = f[(indices == i) & np.isfinite(f)]
        assert r.counts[i] == len(values)
        if len(values):
            assert r.flux[i] == pytest.approx(np.mean(values), rel=1e-14)
        else:
            assert np.isnan(r.flux[i])


def silver_pair():
    t = np.array([0, 10, 20, 100, 110]) / 1440
    p = SimpleNamespace(time=t, tic_id=123, sector=np.array([1, 1, 1, 2, 2]),
                        product_id=np.array(["a", "a", "a", "b", "b"]), interval_masks=())
    d = SimpleNamespace(time=t.copy(), flux_det=np.array([1., 2., 3., np.nan, np.nan]),
                        kept=np.array([False, True, True, False, False]), status="ok", version="silver-v1")
    return p, d


def test_silver_adapter_retains_axis_and_quarantines_empty_sector():
    p, d = silver_pair()
    result = segment_silver(p, d, snapshot_id="raw-v1", product_checksums={"a": "a" * 64, "b": "b" * 64},
                            preprocessing_parameters={"window_days": 1.0})
    assert result["segments"][0]["flux"] == [None, 2, 3]
    assert result["segments"][0]["diagnostics"]["n_kept"] == 2
    assert result["quarantined"][0]["reason"] == "no_valid_bins"
    assert result["publishable"] is False
    assert "discoverable" not in result["segments"][0]
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("failure", ["alignment", "status", "checksum"])
def test_silver_adapter_rejects_invalid_source(failure):
    p, d = silver_pair()
    checksums = {"a": "a" * 64, "b": "b" * 64}
    if failure == "alignment":
        d.time[0] += 1
    elif failure == "status":
        d.status = "numerical_failure"
    else:
        checksums.pop("b")
    with pytest.raises(SegmentationError):
        segment_silver(p, d, snapshot_id="raw-v1", product_checksums=checksums,
                       preprocessing_parameters={"window_days": 1.0})

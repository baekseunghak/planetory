"""Contract checks for source filtering, reference pinning, and public payloads."""
import json

import numpy as np
import pandas as pd
import pytest

import export_observations as exporter


def test_input_masks_are_disjoint_and_cover_every_raw_row():
    masks = exporter.partition_rows(
        [1, np.nan, 3, 4, 5, 6, 7],
        [1, 1, np.inf, 0, -1, 1, np.nan],
        [0, 0, 0, 0, 0, 1, 2],
    )
    assert np.stack(list(masks.values())).sum(axis=0).tolist() == [1] * 7
    assert {name: int(mask.sum()) for name, mask in masks.items()} == {
        "quality_nonzero": 2, "nonfinite": 2, "nonpositive_flux": 2, "eligible": 1,
    }


def sample_frame():
    return pd.DataFrame({
        "time": [20.0, 0.0, 30.0, 1.0, 10.0], "flux": [1.0] * 5,
        "quality": [0] * 5, "observation_group": [1] * 5,
        "source_index": [0, 0, 1, 0, 1], "source_row": [9, 1, 5, 3, 2],
    })


def test_reference_is_original_median_even_when_cleaning_changes_median(monkeypatch):
    monkeypatch.setattr(exporter, "clean", lambda frame, **kwargs: ((np.array([0., 1., 10.]), np.ones(3)), {"kept": 3}))
    t, flux, reference, retained, rejected, _ = exporter.clean_with_provenance(sample_frame())
    assert reference == 10.0
    assert reference != np.median(t)
    assert retained["source_row"].tolist() == [1, 3, 2]
    assert retained["source_index"].tolist() == [0, 0, 1]
    assert rejected["source_row"].tolist() == [9, 5]
    assert len(t) == len(flux) == len(retained)


def test_duplicate_times_fail_instead_of_merging_source_rows():
    frame = sample_frame()
    frame.loc[0, "time"] = frame.loc[1, "time"]
    with pytest.raises(ValueError, match="unique"):
        exporter.clean_with_provenance(frame)


def test_public_periodogram_omits_fitted_transit_answers():
    public = exporter.public_periodogram({
        "periods": [1.0, 2.0], "power": [0.2, 0.5],
        "t0": [1.3, 1.4], "duration": [0.1, 0.2], "depth": [0.05, 0.1],
    })
    assert set(public) == {"period_days", "power"}
    with pytest.raises(ValueError, match="Nonfinite"):
        exporter.public_periodogram({"periods": [1.0], "power": [np.nan]})


def test_json_keeps_binary64_precision_and_rejects_nan(tmp_path):
    original = float(np.nextafter(np.float64(1400), np.inf))
    path = tmp_path / "test.json"
    exporter.write_json(path, {"time_btjd": [original], "reference": original})
    restored = json.loads(path.read_text())
    assert restored["time_btjd"][0].hex() == original.hex()
    assert restored["reference"].hex() == original.hex()
    with pytest.raises(ValueError):
        exporter.write_json(tmp_path / "invalid.json", {"value": float("nan")})

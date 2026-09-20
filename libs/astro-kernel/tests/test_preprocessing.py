from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from astro_kernel import preprocessing as p
from astro_kernel.fits_adapter import parse_spoc_hdul


def curve(n=600, sector=1, start=0):
    t = start + np.arange(n) / 720
    f = 1000 * (1 + 0.001 * np.sin(np.arange(n) * 1.71))
    return p.SectorInput(123, sector, f"s{sector}.fits", t, f, np.ones(n),
                         np.zeros(n, dtype=int), np.arange(n))


def test_filters_provenance_normalization_and_no_mutation():
    c = curve()
    c.time[0] = np.nan
    c.flux[1] = np.inf
    c.quality[2] = 1
    c.flux_err[3] = np.nan
    original = c.flux.copy()
    base, result = p.preprocess_silver([c])
    assert result.status == "ok"
    assert base.n_raw == 600 and len(base.time) == 597
    assert [x["source_row"] for x in base.excluded] == [0, 1, 2]
    assert [x["reasons"][0] for x in base.excluded] == ["nonfinite_time", "nonfinite_flux", "quality_flag"]
    np.testing.assert_array_equal(base.source_row, np.arange(3, 600))
    assert np.isnan(base.flux_err[0])  # missing uncertainty does not remove flux
    assert np.median(base.flux) == 1
    assert base.flux_err[1] == 1 / np.median(c.flux[3:])
    np.testing.assert_array_equal(c.flux, original)


def test_sector_sorting_and_boundary_even_without_gap():
    a, b = curve(), curve(sector=2, start=600 / 720)
    b.flux[:] *= 3
    prepared, result = p.preprocess_silver([b, a])
    assert result.status == "ok"
    assert set(result.segment_id[:600]) == {0}
    assert set(result.segment_id[600:]) == {1}
    assert set(prepared.product_id[:600]) == {"s1.fits"}
    assert prepared.normalization_median[2] == pytest.approx(3 * prepared.normalization_median[1])


def test_overlapping_sectors_dont_mix_trends():
    a, b = curve(), curve(sector=2, start=0.01)
    b.flux[:] *= 1 + 0.02 * np.sin(np.arange(600) / 50)
    base, result = p.preprocess_silver([b, a])
    for c in (a, b):
        single_base, single = p.preprocess_silver([c])
        idx = base.sector == c.sector
        np.testing.assert_array_equal(result.trend[idx], single.trend)


def test_gap_threshold_and_short_segment_fallback():
    c = curve(602)
    c.time[-2:] += 1
    base, result = p.preprocess_silver([c])
    assert result.segment_edges.shape == (2, 2)
    assert result.failures == [dict(segment_id=1, reason="short_segment_median_fallback", n_points=2)]
    assert result.trend[-1] == np.median(base.flux[-2:])


@pytest.mark.parametrize("n", [0, 1, 499])
def test_short_input_is_not_normal_empty_candidate(n):
    base, result = p.preprocess_silver([curve(n)])
    assert result.status == "insufficient_observations"
    assert not result.kept.any()
    assert result.segment_edges.shape == (2, 0)


def test_all_invalid_and_all_constant():
    c = curve()
    c.quality[:] = 1
    base, result = p.preprocess_silver([c])
    assert len(base.excluded) == 600 and result.status == "insufficient_observations"
    c = curve()
    c.flux[:] = 1000
    _, result = p.preprocess_silver([c])
    assert result.noise_scatter == 0
    assert result.status == "insufficient_observations"
    assert set(result.reasons) == {"upper_clip"}  # unchanged strict D03 '<'


@pytest.mark.parametrize("bad", [0, -1, np.nan, np.inf])
def test_bad_trend_has_explicit_failure(monkeypatch, bad):
    monkeypatch.setattr(p, "_trend", lambda t, f: np.full(len(t), bad))
    _, result = p.preprocess_silver([curve()])
    assert result.status == "numerical_failure"
    assert set(result.reasons) == {"invalid_trend"}
    assert not result.kept.any()


@pytest.mark.parametrize("change,code", [
    ({"tic_id": True}, "invalid_identity"),
    ({"sector": 0}, "invalid_identity"),
    ({"quality": np.zeros(600, dtype=float)}, "invalid_array"),
    ({"flux": np.ones(2)}, "length_mismatch"),
    ({"flux": -np.ones(600)}, "invalid_normalization"),
    ({"product_id": ""}, "invalid_identity"),
])
def test_input_contract(change, code):
    with pytest.raises(p.PreprocessError) as e:
        p.prepare_silver([replace(curve(), **change)])
    assert e.value.code == code


def test_duplicates_mixed_tic_and_empty_rejected():
    c = curve()
    for curves, code in (([], "empty_input"), ([c, c], "duplicate_product"),
                         ([c, replace(curve(sector=2), tic_id=2)], "mixed_tic")):
        with pytest.raises(p.PreprocessError) as e:
            p.prepare_silver(curves)
        assert e.value.code == code
    c.time[1] = c.time[0]
    with pytest.raises(p.PreprocessError, match="duplicate_time"):
        p.prepare_silver([c])


def hdus():
    c = curve()
    header = dict(TIMESYS="TDB", BJDREFI=2457000, BJDREFF=0.0, TIMEUNIT="d", TIMEDEL=1/720,
                  TFIELDS=2, TTYPE1="PDCSAP_FLUX", TUNIT1="e-/s", TTYPE2="PDCSAP_FLUX_ERR", TUNIT2="e-/s")
    data = dict(TIME=c.time, PDCSAP_FLUX=c.flux, PDCSAP_FLUX_ERR=c.flux_err,
                QUALITY=c.quality, CADENCENO=c.cadenceno)
    return [SimpleNamespace(header=dict(TICID=123, SECTOR=1, PROCVER="fixture")),
            SimpleNamespace(header=header, data=data)]


def test_adapter_copies_and_preserves_metadata():
    h = hdus()
    c, meta = parse_spoc_hdul(h, product_id="input.fits")
    h[1].data["TIME"][:] = 99
    assert c.time[0] == 0 and meta["PROCVER"] == "fixture"


@pytest.mark.parametrize("key,value", [("BJDREFI", 2400000), ("BJDREFF", 0.5),
                                       ("TIMESYS", "UTC"), ("TIMEUNIT", "s"),
                                       ("TIMEDEL", 0), ("TUNIT1", "ppm")])
def test_adapter_rejects_unknown_units(key, value):
    h = hdus()
    h[1].header[key] = value
    with pytest.raises(p.PreprocessError):
        parse_spoc_hdul(h, product_id="input.fits")


def test_adapter_missing_header_and_corrupt_structure():
    h = hdus()
    del h[1].header["TIMESYS"]
    with pytest.raises(p.PreprocessError, match="missing_header_or_column"):
        parse_spoc_hdul(h, product_id="input.fits")
    with pytest.raises(p.PreprocessError, match="invalid_fits_structure"):
        parse_spoc_hdul([], product_id="input.fits")


def test_upper_clip_does_not_remove_negative_transit():
    c = curve(1000)
    c.flux[100] = 2000
    c.flux[300:310] = 990
    base, result = p.preprocess_silver([c])
    assert result.reasons[100] == "upper_clip"
    assert result.kept[300:310].all()


def test_gap_equal_half_day_stays_in_same_segment():
    t = np.arange(600) / 1024
    t[300:] += .5 - 1 / 1024
    f = 1 + .001 * np.sin(np.arange(600))
    result = p.detrend_silver(t, f, np.ones(600, dtype=int))
    assert result.segment_edges.shape[1] == 1
    t[300:] += 1 / 1024
    result = p.detrend_silver(t, f, np.ones(600, dtype=int))
    assert result.segment_edges.shape[1] == 2

from dataclasses import replace
import numpy as np
import pytest
from astro_kernel import preprocessing as p


def curve():
    return p.SectorInput(1, 3, "a.fits", np.arange(600)/720,
                        1000+np.sin(np.arange(600)), np.ones(600),
                        np.zeros(600, dtype=int), np.arange(600), "a"*64)


def mask(**changes):
    return replace(p.IntervalMask("acs", "a.fits", 3, "a"*64, "cadenceno", 0, 10,
                                  "both", "acs_test", "https://example.test/evidence", "b"*64, "test-v1"), **changes)


def test_overlap_all_reasons_and_pre_normalization():
    c=curve(); c.quality[0]=128; c.flux[1]=np.nan; c.time[2]=np.nan
    c.flux[3:11]=1e9
    b,d=p.preprocess_silver([c], interval_masks=[mask(), mask(interval_id="overlap", start=5,end=12)])
    assert b.source_row[0]==13
    assert b.normalization_median[3]==np.median(c.flux[13:])
    assert b.excluded[0]["original_quality"]==128
    assert "quality_flag" in b.excluded[0]["reasons"]
    assert "nonfinite_flux" in b.excluded[1]["reasons"]
    assert "nonfinite_time" in b.excluded[2]["reasons"]
    assert b.excluded[5]["interval_ids"]==["acs","overlap"]
    assert len(b.excluded)+len(b.time)==600
    assert b.interval_masks[0]["source_sha256"]=="b"*64
    assert c.flux[3]==1e9 and c.quality[0]==128


@pytest.mark.parametrize("closed,expected", [("both",[0,1,2]),("left",[0,1]),("right",[1,2]),("neither",[1])])
def test_boundaries(closed,expected):
    c=curve()
    b=p.prepare_silver([c], interval_masks=[mask(coordinate="BTJD_TDB_day",end=2/720,closed=closed)])
    assert [r["source_row"] for r in b.excluded]==expected


def test_empty_masks_exact_compatibility_and_full_exclusion():
    c=curve(); a,da=p.preprocess_silver([c]); b,db=p.preprocess_silver([c],interval_masks=[])
    np.testing.assert_array_equal(a.flux,b.flux);np.testing.assert_array_equal(da.flux_det,db.flux_det)
    b,d=p.preprocess_silver([c],interval_masks=[mask(end=600)])
    assert len(b.excluded)==600 and b.normalization_median[3] is None
    assert d.status=="insufficient_observations"


@pytest.mark.parametrize("changes", [{"coordinate":"UTC"},{"closed":"unknown"},{"start":20}, {"end":np.inf}, {"start":True}, {"start":0.5}, {"source_sha256":"bad"},{"version":""}])
def test_invalid_masks(changes):
    with pytest.raises(p.PreprocessError,match="invalid_mask"):
        p.prepare_silver([curve()],interval_masks=[mask(**changes)])


@pytest.mark.parametrize("changes", [{"product_sha256":"c"*64},{"product_id":"other"},{"sector":4}])
def test_wrong_source(changes):
    with pytest.raises(p.PreprocessError,match="mask_source_mismatch"):
        p.prepare_silver([curve()],interval_masks=[mask(**changes)])


def test_duplicate_mask_and_missing_checksum():
    with pytest.raises(p.PreprocessError,match="duplicate interval_id"):
        p.prepare_silver([curve()],interval_masks=[mask(),mask()])
    with pytest.raises(p.PreprocessError,match="mask_source_mismatch"):
        p.prepare_silver([replace(curve(),source_sha256=None)],interval_masks=[mask()])


def test_combined_ledger_preserves_each_raw_row():
    c=curve(); b,d=p.preprocess_silver([c],interval_masks=[mask()])
    rows=p.exclusion_ledger(b,d)
    assert len(rows)+int(d.kept.sum())==600
    assert len({(r["product_id"],r["source_row"]) for r in rows})==len(rows)
    assert all(r["reasons"] and r["reasons"]!=[""] for r in rows)
    with pytest.raises(p.PreprocessError,match="provenance_mismatch"):
        p.exclusion_ledger(b,replace(d,time=d.time+1))


def test_mask_removed_before_trend_and_empty_interval():
    c = curve()
    c.flux[:11] = 1e9
    prepared, actual = p.preprocess_silver([c], interval_masks=[mask()])
    reference = p.detrend_silver(c.time[11:], c.flux[11:]/np.median(c.flux[11:]), np.full(589, 3))
    np.testing.assert_array_equal(actual.trend, reference.trend)
    np.testing.assert_array_equal(actual.flux_det, reference.flux_det)
    empty = p.prepare_silver([c], interval_masks=[mask(start=1000, end=1001)])
    assert len(empty.time) == 600 and not empty.excluded
    _, short = p.preprocess_silver([c], interval_masks=[mask(end=101)])
    assert short.status == "insufficient_observations"


def test_multisector_unsorted_provenance_and_strict_json():
    import json
    c = curve()
    order = np.arange(599, -1, -1)
    first = replace(c, **{key:getattr(c,key)[order] for key in ("time","flux","flux_err","quality","cadenceno")})
    second = replace(curve(), product_id="b.fits", sector=4, time=c.time+2)
    first.time[0] = np.nan
    first.time[1] = np.inf
    first.time[2] = -np.inf
    first.quality[3] = 128
    b,d = p.preprocess_silver([second,first], interval_masks=[mask()])
    ledger = p.exclusion_ledger(b,d)
    json.dumps(ledger, allow_nan=False)
    originals={x.product_id:x for x in (first,second)}
    for i in range(len(b.time)):
        source=originals[b.product_id[i]]; row=b.source_row[i]
        assert b.time[i]==source.time[row]
        assert b.cadenceno[i]==source.cadenceno[row]
        assert b.original_quality[i]==source.quality[row]
    assert len(ledger)+int(d.kept.sum())==1200
    assert [r["original_time_nonfinite"] for r in ledger if "original_time_nonfinite" in r]==["NaN","+Infinity","-Infinity"]

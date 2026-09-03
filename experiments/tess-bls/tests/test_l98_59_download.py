from download_l98_59 import EXPECTED_CONFIRMED_PERIODS_DAYS, PRODUCTS, TIC_ID


def test_l98_59_product_manifest_has_three_unique_official_light_curves():
    assert TIC_ID == 307210830
    assert [sector for sector, _, _ in PRODUCTS] == [2, 5, 8]
    assert len({filename for _, filename, _ in PRODUCTS}) == 3

    padded_tic = f"{TIC_ID:016d}"
    for sector, filename, url in PRODUCTS:
        assert f"-s{sector:04d}-" in filename
        assert padded_tic in filename
        assert filename.endswith("-s_lc.fits")
        assert url.startswith("https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:TESS/product/")
        assert url.endswith(filename)


def test_l98_59_reference_periods_fit_the_default_search_range():
    periods = dict(EXPECTED_CONFIRMED_PERIODS_DAYS)

    assert set(periods) == {"L 98-59 b", "L 98-59 c", "L 98-59 d"}
    assert all(0.5 <= period <= 15.0 for period in periods.values())
    assert periods["L 98-59 b"] < periods["L 98-59 c"] < periods["L 98-59 d"]

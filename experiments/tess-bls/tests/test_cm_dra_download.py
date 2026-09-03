from download_cm_dra import EXPECTED_ORBITAL_PERIOD_DAYS, PRODUCTS, TIC_ID


def test_cm_dra_product_manifest_is_the_official_sector_16_light_curve():
    assert TIC_ID == 199574208
    assert len(PRODUCTS) == 1

    sector, filename, url = PRODUCTS[0]
    assert sector == 16
    assert filename == "tess2019253231442-s0016-0000000199574208-0152-s_lc.fits"
    assert url.startswith(
        "https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:TESS/product/"
    )
    assert url.endswith(filename)


def test_cm_dra_orbital_and_half_periods_fit_the_default_search_range():
    half_period = 0.5 * EXPECTED_ORBITAL_PERIOD_DAYS

    assert 0.5 <= half_period <= 15.0
    assert 0.5 <= EXPECTED_ORBITAL_PERIOD_DAYS <= 15.0

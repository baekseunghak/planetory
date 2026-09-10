import pytest

from tess_fixture.targets import (
    SECTOR_PRODUCT_PREFIX, TARGETS, iter_products, product_filename, product_url, select_targets,
)


def test_target_keys_and_tics_are_unique():
    keys = [t.key for t in TARGETS]
    tics = [t.tic_id for t in TARGETS]
    assert len(set(keys)) == len(keys)
    assert len(set(tics)) == len(tics)


def test_every_target_sector_has_a_registered_product_prefix():
    for t in TARGETS:
        for sector in t.sectors:
            assert sector in SECTOR_PRODUCT_PREFIX, (t.key, sector)


def test_product_filename_matches_existing_poc_downloaders():
    # experiments/tess-bls/download_*.py 에 고정된 공식 파일명과 같아야 한다.
    assert product_filename(259377017, 3) == "tess2018263035959-s0003-0000000259377017-0123-s_lc.fits"
    assert product_filename(307210830, 8) == "tess2019032160000-s0008-0000000307210830-0136-s_lc.fits"
    assert product_filename(199574208, 16) == "tess2019253231442-s0016-0000000199574208-0152-s_lc.fits"


def test_product_url_uses_official_mast_download_endpoint():
    url = product_url(259377017, 3)
    assert url.startswith("https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/")
    assert url.endswith("-s_lc.fits")


def test_unknown_sector_is_rejected():
    with pytest.raises(KeyError):
        product_filename(259377017, 99)


def test_select_targets_rejects_unknown_key():
    with pytest.raises(KeyError):
        select_targets(["nope"])
    assert select_targets(None) == TARGETS
    assert [t.key for t in select_targets(["cm_dra", "toi270"])] == ["cm_dra", "toi270"]


def test_sample_roles_cover_planned_categories():
    roles = {t.role for t in TARGETS}
    assert "eclipsing_binary" in roles
    assert "young_active_star" in roles
    assert any(r.startswith("multi_planet") for r in roles)
    assert any(r.startswith("deep") for r in roles)
    assert sum(1 for _ in iter_products()) == sum(len(t.sectors) for t in TARGETS)

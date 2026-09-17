import json
from pathlib import Path

import pytest

from tess_fixture import service_sample as ss
from tess_fixture.targets import TARGETS

CONFIG = Path(__file__).resolve().parents[1] / "configs" / "service_sample_v1.json"


def test_v1_config_loads_and_is_disjoint_from_fixture():
    cfg = ss.load_sample_config(CONFIG)
    assert cfg.sample_id == "service_sample_v1" and cfg.version == "1.0.0"
    assert len(cfg.members) == 45
    groups = {}
    for m in cfg.members:
        groups[m.group] = groups.get(m.group, 0) + 1
    assert groups == {"random": 40, "planet_host": 5}
    fixture = {t.tic_id for t in TARGETS}
    assert not ({m.tic_id for m in cfg.members} & fixture)
    assert set(cfg.selection["excluded_tic_ids"]) == fixture
    assert len({(m.tic_id, m.sector) for m in cfg.members}) == 45          # 중복 없음
    assert all(m.sector == 3 for m in cfg.members)


def test_filename_and_url_follow_spoc_pattern():
    cfg = ss.load_sample_config(CONFIG)
    m = cfg.members[0]
    name = cfg.filename(m)
    assert name == f"tess2018263035959-s0003-{m.tic_id:016d}-0123-s_lc.fits"
    assert cfg.url(m).endswith(name) and cfg.url(m).startswith("https://mast.stsci.edu/")


def _write(tmp_path: Path, cfg: dict) -> Path:
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return p


def _base_cfg():
    return {"schema": ss.SCHEMA, "sample_id": "x", "version": "0",
            "sectors": {"3": {"prefix": "tess2018263035959", "pipeline_id": "0123"}},
            "selection": {"excluded_tic_ids": [259377017]},
            "members": [{"tic_id": 1, "sector": 3, "group": "random"}]}


@pytest.mark.parametrize("mutate, match", [
    (lambda c: c.update(schema="other"), "schema"),
    (lambda c: c["members"].append({"tic_id": 1, "sector": 3, "group": "random"}), "duplicate"),
    (lambda c: c["members"].append({"tic_id": 2, "sector": 4, "group": "random"}), "no product prefix"),
    (lambda c: c["members"].append({"tic_id": 259377017, "sector": 3, "group": "random"}), "excluded"),
])
def test_config_validation_errors(tmp_path: Path, mutate, match):
    cfg = _base_cfg()
    mutate(cfg)
    with pytest.raises(ValueError, match=match):
        ss.load_sample_config(_write(tmp_path, cfg))


def test_summarize_counts_groups_sizes_and_cache():
    records = [
        {"tic_id": 1, "role": "random", "size_bytes": 1000, "cached": True, "procver": "spoc-4.0.14-20200102"},
        {"tic_id": 2, "role": "random", "size_bytes": 3000, "cached": False, "procver": "spoc-4.0.14-20200102"},
        {"tic_id": 2, "role": "planet_host", "size_bytes": 2000, "cached": False, "procver": "spoc-4.0.14-20200102"},
    ]
    s = ss.summarize(records)
    assert s["n_files"] == 3 and s["n_tics"] == 2 and s["by_group"] == {"random": 2, "planet_host": 1}
    assert s["total_bytes"] == 6000 and s["mean_bytes"] == 2000 and s["min_bytes"] == 1000 and s["max_bytes"] == 3000
    assert s["cache_hits"] == 1 and s["procver"] == ["spoc-4.0.14-20200102"]

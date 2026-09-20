import numpy as np
import pytest

from tess_bench.binning import bin_curve, depth, revision


def test_edges_gaps_partial_and_center_contract():
    t = 1400 + np.array([0, 2, 10, 30, 32]) / 1440
    b = bin_curve(t, np.array([1, 3, 4, np.nan, 6]), 10)
    np.testing.assert_allclose(b.flux, [2, 4, np.nan, 6], equal_nan=True)
    np.testing.assert_array_equal(b.counts, [2, 1, 0, 1])
    assert b.gaps == [[2, 2]]
    np.testing.assert_allclose(b.centers, 1400 + np.array([5, 15, 25, 35]) / 1440)


@pytest.mark.parametrize("reducer,expected", [("mean", 4), ("median", 2)])
def test_reducer_and_nan(reducer, expected):
    b = bin_curve([0, .001, .002, .003], [1, 2, 9, np.nan], 10, reducer)
    assert b.flux[0] == expected
    assert b.counts[0] == 3


def test_cap_and_empty_bins_do_not_compress_time():
    b = bin_curve([0, 20000 * 10 / 1440], [1, 1])
    assert b.minutes == 20
    assert len(b.flux) == 10001
    assert b.gaps == [[1, 9999]]
    assert b.counts.sum() == 2


def test_unsorted_duplicate_times_are_aggregated():
    b = bin_curve([.02, 0, 0], [5, 1, 3], 10)
    assert b.flux[0] == 2
    assert b.counts.sum() == 3


def test_all_failed_flux_is_explicit_missing():
    b = bin_curve([0, .02], [np.nan, np.inf])
    assert np.isnan(b.flux).all()
    assert b.gaps == [[0, 2]]


@pytest.mark.parametrize("kwargs", [{"minutes": 0}, {"minutes": float("nan")}, {"max_points": 0}, {"reducer": "bad"}])
def test_bad_configuration(kwargs):
    with pytest.raises(ValueError):
        bin_curve([0], [1], **kwargs)


def test_revision_is_order_independent_but_tracks_rules_and_inputs():
    a = revision(["a", "b"], {"bin": 10})
    assert a == revision(["b", "a"], {"bin": 10})
    assert a != revision(["a", "b"], {"bin": 20})
    assert a != revision(["a", "c"], {"bin": 10})


def test_aligned_box_preserves_depth_and_short_event_can_disappear():
    t = np.arange(0, 4, 2 / 1440)
    phase = (t - .5 + 1) % 2 - 1
    f = 1 - .001 * (abs(phase) < .5 / 24)
    d, _, _ = depth(t, f, 2, .5, 1)
    b = bin_curve(t, f, 10)
    bd, _, _ = depth(b.centers, b.flux, 2, .5, 1)
    assert d == pytest.approx(.001)
    assert bd == pytest.approx(.001)
    # Median can erase a transit occupying only one of five samples.
    mean = bin_curve(np.arange(5) * 2 / 1440, [1, 1, .999, 1, 1], 10, "mean")
    median = bin_curve(np.arange(5) * 2 / 1440, [1, 1, .999, 1, 1], 10, "median")
    assert mean.flux[0] < 1
    assert median.flux[0] == 1


def test_insufficient_transit_is_not_zero_depth():
    measured, _, _ = depth(np.array([0, .1]), np.ones(2), 2, .5, 1)
    assert np.isnan(measured)


def test_cli_manifest_and_outputs_with_synthetic_input(tmp_path, monkeypatch):
    import csv
    import hashlib
    import json
    from types import SimpleNamespace
    from tess_bench import binning as mod
    from tess_fixture.targets import select_targets, iter_products

    target = select_targets(["toi270"])[0]
    raw = tmp_path / "raw"
    (raw / target.key).mkdir(parents=True)
    digest = hashlib.sha256(b"synthetic test only").hexdigest()
    expected = {}
    for _, sector, filename, _ in iter_products((target,)):
        (raw / target.key / filename).write_bytes(b"synthetic test only")
        expected[filename] = digest
    monkeypatch.setattr(mod.dl, "load_expected_checksums", lambda _: expected)
    monkeypatch.setattr(mod, "load_sector", lambda path: SimpleNamespace(tic_id=target.tic_id, sector=int(path.name.split('-s')[1][:4])))
    t = np.arange(1400, 1404, 2 / 1440)
    sector = np.full(len(t), 3)
    # Only one sector in synthetic baseline; loader metadata still checks three.
    monkeypatch.setattr(mod, "build_baseline", lambda *a: SimpleNamespace(time=t, flux=np.ones(len(t)), sector_of_point=sector, sectors=(3,)))
    monkeypatch.setattr(mod, "preprocess", lambda *a: SimpleNamespace(flux_det=np.ones(len(t)), kept=np.ones(len(t), bool), status="ok", failures=[]))
    monkeypatch.setattr(mod.mf, "code_info", lambda _: {"git_commit": None, "git_branch": None, "git_dirty": None})
    assert mod.main(["--target", "toi270", "--raw", str(raw), "--results", str(tmp_path / "out")]) == 0
    out = next((tmp_path / "out/binning").iterdir())
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["task"] == "S15P21C206-114"
    assert manifest["config"]["selected_targets"] == ["toi270"]
    for entry in manifest["outputs"]:
        from pathlib import Path
        assert hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest() == entry["sha256"]
    with (out / "metrics.csv").open() as stream:
        rows = list(csv.DictReader(stream))
    assert {r["kind"] for r in rows} == {"reference", "injection_post_preprocess"}
    assert len([r for r in rows if r["kind"] == "injection_post_preprocess"]) == 16 * 8
    assert list(out.glob("*.svg"))

from dataclasses import replace

import numpy as np
import pytest

from astro_kernel.preprocessing import SectorInput, prepare_silver, detrend_silver
from tess_fixture.lightcurve import SectorCurve, build_baseline
from tess_bench.preprocess import Setting, preprocess
from tess_bench.silver_regression import compare_results, verify_snapshot


@pytest.mark.parametrize("seed", [7, 42, 119])
def test_complete_synthetic_pipeline_matches_independent_reference(seed):
    rng = np.random.default_rng(seed)
    current, old = [], []
    for sector in (1, 2):
        t = sector * 10 + np.arange(1600) / 720
        t[1000:] += 0.75  # split inside Sector
        flux = 10000 * (1 + .003 * np.sin(t * 2) + rng.normal(0, .0003, len(t)))
        flux[np.abs((t - t[300] + .25) % .5 - .25) < .02] *= .998
        err, q, cad = np.ones(len(t)), np.zeros(len(t), dtype=int), np.arange(len(t))
        q[5] = 1
        flux[10] = np.nan
        current.append(SectorInput(1, sector, str(sector), t, flux, err, q, cad))
        old.append(SectorCurve(1, sector, str(sector), t, flux, err, q, cad, {}))
    b = prepare_silver(current)
    reference = build_baseline(old)
    np.testing.assert_array_equal(b.time, reference.time)
    np.testing.assert_array_equal(b.flux, reference.flux)
    result = detrend_silver(b.time, b.flux, b.sector)
    prior = preprocess(reference.time, reference.flux, reference.sector_of_point,
                       Setting("biweight_1.0d", detrend_method="biweight", window_days=1.0))
    assert all(compare_results(prior, result).values())
    assert result.status == prior.status == "ok"


def test_snapshot_detects_tampering(tmp_path):
    from tess_fixture.manifest import file_entry
    p = tmp_path / "source"
    p.write_bytes(b"original")
    entries = [file_entry(p)]
    verify_snapshot(entries)
    p.write_bytes(b"changed")
    with pytest.raises(ValueError, match="input changed"):
        verify_snapshot(entries)


def test_mismatch_not_accepted():
    t = np.arange(600) / 720
    result = detrend_silver(t, 1 + np.sin(t * 100) * .001, np.ones(600, dtype=int))
    changed = replace(result, trend=result.trend + 1e-15)
    assert not compare_results(result, changed)["trend"]


def test_runner_writes_plan_and_manifest_with_synthetic_fits(tmp_path, monkeypatch):
    import json
    from pathlib import Path
    from astropy.io import fits
    from tess_fixture.download import sha256_of
    from tess_fixture.targets import Target, product_filename
    from tess_bench import silver_regression as runner

    root = tmp_path
    bench, fixture = root / "experiments/tess-bench", root / "experiments/tess-fixture"
    (bench / "configs").mkdir(parents=True)
    (fixture / "configs").mkdir(parents=True)
    (root / "libs/astro-kernel").mkdir(parents=True)
    # Only this synthetic runner test uses a small catalog; production has no subset flag.
    settings = Path(runner.BENCH / "configs/preprocess_settings_v1.json").read_bytes()
    (bench / "configs/preprocess_settings_v1.json").write_bytes(settings)
    grid = dict(grid_id="test", version="1.1.0", model="box", period_days=[.5],
                duration_hours=[.5], depth_ppm=[1000], phase_fraction={"middle": .5})
    (fixture / "configs/injection_grid_v1.json").write_text(json.dumps(grid))
    for path in (bench / "uv.lock", bench / "pyproject.toml", fixture / "pyproject.toml",
                 root / "libs/astro-kernel/pyproject.toml"):
        path.write_text("synthetic test")
    target = Target("synthetic", "Synthetic", 123, "test", (3,))
    monkeypatch.setattr(runner, "ROOT", root)
    monkeypatch.setattr(runner, "BENCH", bench)
    monkeypatch.setattr(runner, "FIXTURE", fixture)
    monkeypatch.setattr(runner, "TARGETS", ("synthetic",))
    monkeypatch.setattr(runner, "select_targets", lambda keys: (target,))
    raw = tmp_path / "raw"
    (raw / target.key).mkdir(parents=True)
    t = np.arange(1000) / 720
    primary = fits.PrimaryHDU()
    primary.header.update(TICID=123, SECTOR=3, PROCVER="synthetic-test")
    lc = fits.BinTableHDU.from_columns([
        fits.Column(name="TIME", format="D", unit="d", array=t),
        fits.Column(name="PDCSAP_FLUX", format="D", unit="e-/s", array=1000 + np.sin(t * 100)),
        fits.Column(name="PDCSAP_FLUX_ERR", format="D", unit="e-/s", array=np.ones(len(t))),
        fits.Column(name="QUALITY", format="J", array=np.zeros(len(t), dtype=int)),
        fits.Column(name="CADENCENO", format="J", array=np.arange(len(t))),
    ])
    lc.header.update(TIMESYS="TDB", BJDREFI=2457000, BJDREFF=0., TIMEUNIT="d", TIMEDEL=1/720)
    path = raw / target.key / product_filename(123, 3)
    fits.HDUList([primary, lc]).writeto(path)
    (fixture / "checksums.json").write_text(json.dumps(dict(files=[dict(filename=path.name, sha256=sha256_of(path))])))
    assert runner.run(raw, tmp_path / "results") == 0
    out = next((tmp_path / "results").iterdir())
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["passed"] and manifest["task"] == "S15P21C206-119"
    assert manifest["plan"]["sha256"] == sha256_of(out / "plan.json")
    assert manifest["product_metadata"][0]["PROCVER"] == "synthetic-test"
    plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
    assert plan["tolerance"]["atol"] == 0
    for entry in manifest["outputs"]:
        assert entry["sha256"] == sha256_of(Path(entry["path"]))

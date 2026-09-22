import numpy as np
import pytest

from tess_bench.segmentation_regression import compare_segments, require


def test_irregular_bins_and_empty_edges_match_114():
    t = np.array([0, 2, 10, 20, 40, 42]) / 1440
    segment, error = compare_segments(t, np.array([np.nan, 1., 3., np.nan, 4., 5.]))
    assert segment.gaps == [[2, 3]] and error < 1e-14


def test_run_checks_survive_optimized_python():
    with pytest.raises(ValueError, match="failure"):
        require(False, "failure")


def test_driver_with_synthetic_inputs_writes_verified_manifest(tmp_path, monkeypatch):
    import json
    from copy import deepcopy
    from types import SimpleNamespace
    from astro_kernel.iteration import ITERATION_VERSION
    from astro_kernel.transit_model import model_flux
    from tess_bench import segmentation_regression as r
    t = (np.arange(4320) + .5) * 2 / 1440
    model = dict(shape="box", baseline={"kind": "unity"}, residual_model_version="box-divide-v0",
                 parameters=dict(period_days=2., epoch_btjd=0., duration_hours=2., depth_ppm=1000.))
    f = model_flux(t, model) + np.random.default_rng(123).normal(0, .0001, len(t))
    peak = dict(peak_id="peak-0", step=0, **model["parameters"], snr=20., sde=10., bls_power=100.,
                n_transits=3, original_snr=20., validated_on_original=True, transit_model=model)
    source = dict(iteration_version=ITERATION_VERSION, complete=True, status="ok", termination="no_quality_peak",
                  time_start_btjd=float(t[0]), time_end_btjd=float(t[-1]), accepted=[peak],
                  input_snapshot_id="snapshot", preprocessing_version="silver", iteration_config_sha256="fixture",
                  candidate_quality_version="fixture", qa_failed_step=-1)
    target = SimpleNamespace(key="synthetic", tic_id=123)
    (tmp_path / target.key).mkdir()
    (tmp_path / target.key / "fixture.fits").write_bytes(b"synthetic sentinel, never parsed as FITS")
    monkeypatch.setattr(r, "select_targets", lambda _: [target])
    monkeypatch.setattr(r, "iter_products", lambda _: [(target, 1, "fixture.fits", "synthetic")])
    base = SimpleNamespace(time=t, flux=f, sector_of_point=np.ones(len(t), dtype=int))
    monkeypatch.setattr(r.reference, "build_bls_inputs", lambda *a, **k:
        SimpleNamespace(baselines={"realclean": base}, groups={"realclean": {str(i): [] for i in range(4)}}))
    monkeypatch.setattr(r.reference, "detrend_silver", lambda *a:
        SimpleNamespace(time=t, flux_det=f, status="ok", version="synthetic"))
    monkeypatch.setattr(r.reference, "iterate_bls", lambda *a, **k: deepcopy(source))
    r.run(tmp_path, tmp_path / "results", [target.key])
    out = next((tmp_path / "results").iterdir())
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["passed"] and manifest["n_curves"] == 4
    rows = json.loads((out / "comparisons.json").read_text())
    assert all(row["status"] == "ready" and row["compared_stages"] == 2 for row in rows)
    r.verify_snapshot([manifest["plan"], *manifest["outputs"]])

from pathlib import Path
import csv
import hashlib
import json

import numpy as np
import pytest

from astronet_eval import bls, convert as cv, labels as lb
from tess_bench.preprocess import Setting
from tess_fixture.lightcurve import Baseline
from tess_fixture.targets import TARGETS_BY_KEY

JUNK_CFG = {"period_min_days": 0.5, "n_periods": 3000, "durations_days": [0.05, 0.08, 0.12, 0.2]}


def _baseline(period=None, t0=1402.0, dur_h=2.0, depth=3e-3, noise=3e-4, seed=1, tic_id=259377017, n_days=20.0):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, 2.0 / 1440)
    f = 1 + rng.normal(0, noise, size=t.shape)
    if period:
        phase = ((t - t0) / period + 0.5) % 1.0 - 0.5
        f[np.abs(phase * period) < dur_h / 48] *= 1 - depth
    return Baseline(tic_id=tic_id, sectors=(3,), time=t, flux=f, sector_of_point=np.full(t.shape, 3),
                    normalization_median={3: 1.0}, n_raw=len(t), n_valid=len(t), source_files=("synthetic",))


def test_strongest_peak_recovers_injected_period_and_epoch():
    b = _baseline(period=3.0)
    peak = bls.strongest_peak(b.time, b.flux, n_periods=3000, period_max_days=6.0)
    assert peak.period_days == pytest.approx(3.0, rel=0.01)
    dist = ((peak.epoch_btjd - 1402.0) / 3.0 + 0.5) % 1.0 - 0.5
    assert abs(dist * 3.0) < 2.0 / 24                      # 통과 중심이 지속시간 안
    assert peak.depth > 0 and peak.power > 0


def test_geometry_at_known_period_fills_epoch_and_duration():
    b = _baseline(period=1.2683900573, dur_h=1.5, depth=0.05)
    peak = bls.geometry_at_known_period(b.time, b.flux, 1.2683900573)
    assert peak.period_days == 1.2683900573
    dist = ((peak.epoch_btjd - 1402.0) / peak.period_days + 0.5) % 1.0 - 0.5
    assert abs(dist * peak.period_days) < 1.0 / 24
    assert 0.02 <= peak.duration_days <= 0.12 and peak.depth == pytest.approx(0.05, rel=0.2)


def test_prepare_curve_drops_nan_and_keeps_counts():
    b = _baseline()
    pc = cv.prepare_curve(b, "toi270-real", Setting("none", detrend_method="none"))
    assert pc.baseline_id == "toi270-real" and pc.tic_id == 259377017 and pc.sectors == (3,)
    assert np.isfinite(pc.flux).all() and pc.n_kept <= pc.n_baseline_points == len(b.time)


def test_complete_geometry_only_fills_missing():
    b = _baseline(period=1.2683900573, dur_h=1.5, depth=0.05)
    curve = cv.prepare_curve(b, "cm_dra-real", Setting("none", detrend_method="none"))
    eb = lb.eb_placeholders([TARGETS_BY_KEY["cm_dra"]], snapshot="x")[0]
    filled = cv.complete_geometry(eb, curve)
    assert filled.epoch_btjd is not None and filled.duration_hours is not None and filled.depth_ppm > 0
    pc = lb.Candidate(**{**eb.__dict__, "candidate_id": "x", "label": "PC", "epoch_btjd": 1402.0, "duration_hours": 1.5,
                         "depth_ppm": 50000.0, "geometry_source": "archive"})
    assert cv.complete_geometry(pc, curve).epoch_btjd == 1402.0          # 있는 값은 건드리지 않음


def test_junk_from_noise_and_residual_and_convert(tmp_path: Path):
    target = TARGETS_BY_KEY["toi270"]
    setting = Setting("none", detrend_method="none")
    real = cv.prepare_curve(_baseline(period=3.0, depth=3e-3), "toi270-real", setting)
    noise = cv.prepare_curve(_baseline(period=None, seed=7), "toi270-noise7", setting)

    junk = cv.junk_from_noise(target, noise, 7, JUNK_CFG, training_overlap="unknown")
    assert junk.label == "junk" and junk.in_truth and junk.candidate_id == "toi270-junk-noise7"
    assert junk.baseline_id == "toi270-noise7" and junk.epoch_btjd is not None

    known = [lb.Candidate(candidate_id="toi270-pc-x", label="PC", in_truth=True, label_source="t", label_snapshot="t",
                          tic_id=target.tic_id, target_key="toi270", baseline_id="toi270-real", split=lb.split_for_tic(target.tic_id),
                          training_overlap="unknown", source_name="x", period_days=3.0, epoch_btjd=1402.0, duration_hours=2.0,
                          depth_ppm=3000.0, geometry_source="archive")]
    unv, note = cv.junk_from_residual(target, real, known, JUNK_CFG, training_overlap="unknown")
    assert unv is not None and unv.label == "junk_unverified" and not unv.in_truth and "removed=1" in note
    # 알려진 3일 신호를 제거했으므로 잔차 최강 피크는 3일(및 별칭)이 아니어야 한다
    ratio = unv.period_days / 3.0
    assert min(abs(ratio - k) for k in (0.5, 1.0, 2.0)) > 0.02

    rows = [cv.convert_candidate(c, real if c.baseline_id.endswith("real") else noise, cv.ViewSpec(), tmp_path / "npz")
            for c in known + [junk, unv]]
    assert all(r["status"] == "ok" for r in rows)
    probe = np.load(rows[0]["npz_path"])
    assert probe["global_view"].shape == (201,) and probe["local_view"].shape == (61,) and probe["global_view"].dtype == np.float32
    assert int(probe["tic_id"]) == target.tic_id and str(probe["candidate_id"]) == "toi270-pc-x"
    assert len(rows[0]["global_sha256"]) == 64
    assert 98 <= rows[0]["global_argmin_bin"] <= 102 and 28 <= rows[0]["local_argmin_bin"] <= 32   # 심은 통과가 중심에 옴

    missing = lb.Candidate(**{**known[0].__dict__, "candidate_id": "toi270-eb-y", "epoch_btjd": None})
    r = cv.convert_candidate(missing, real, cv.ViewSpec(), tmp_path / "npz")
    assert r["status"] == "input_incomplete" and r["reason"] == "missing_geometry" and r["npz_path"] == ""
    r = cv.convert_candidate(known[0], real, cv.ViewSpec(min_in_transit_points=10_000), tmp_path / "npz")
    assert r["status"] == "input_incomplete" and r["reason"] == "too_few_transit_points" and r["npz_path"] == ""


def test_junk_from_residual_reports_removal_failure_instead_of_raising():
    target = TARGETS_BY_KEY["toi270"]
    real = cv.prepare_curve(_baseline(period=3.0), "toi270-real", Setting("none", detrend_method="none"))
    bad = lb.Candidate(candidate_id="bad", label="PC", in_truth=True, label_source="t", label_snapshot="t", tic_id=target.tic_id,
                       target_key="toi270", baseline_id="toi270-real", split="calibration", training_overlap="unknown",
                       source_name="x", period_days=0.05, epoch_btjd=1402.0, duration_hours=2.0, depth_ppm=3000.0, geometry_source="archive")
    unv, note = cv.junk_from_residual(target, real, [bad], JUNK_CFG, training_overlap="unknown")
    assert unv is None and note.startswith("removal_failed:invalid_parameter")


def test_convert_manifest_hashes_npz_file_not_view_and_preserves_failures(tmp_path, monkeypatch):
    from astronet_eval import cli

    target = TARGETS_BY_KEY["toi270"]
    candidate = lb.Candidate(
        candidate_id="toi270-pc-test", label="PC", in_truth=True, label_source="synthetic",
        label_snapshot="test", tic_id=target.tic_id, target_key="toi270", baseline_id="toi270-real",
        split=lb.split_for_tic(target.tic_id), training_overlap="unknown", source_name="test",
        period_days=3.0, epoch_btjd=1402.0, duration_hours=2.0, depth_ppm=3000.0,
        geometry_source="synthetic",
    )
    missing = lb.Candidate(**{**candidate.__dict__, "candidate_id": "missing", "epoch_btjd": None})
    labels_path = lb.write_labels([candidate, missing], tmp_path / "labels.csv")
    curve = cv.prepare_curve(_baseline(period=3.0), "toi270-real", Setting("none", detrend_method="none"))
    monkeypatch.setattr(cli, "_fixture_inputs", lambda *args: [])
    monkeypatch.setattr(cv, "prepare_target", lambda *args: {"toi270-real": curve})
    # User owns Git commands; a synthetic test must never invoke them.
    monkeypatch.setattr(cli.mf, "code_info", lambda *args: {"git_commit": None, "git_dirty": None})
    results = tmp_path / "results"
    assert cli.main(["convert", "--labels", str(labels_path), "--results", str(results)]) == 0
    manifest = json.loads(next((results / "manifests").glob("convert-*.json")).read_text(encoding="utf-8"))
    for entry in manifest["outputs"]:
        artifact = Path(entry["path"])
        assert entry["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
        assert entry["size_bytes"] == artifact.stat().st_size
    outputs = {entry["kind"]: entry for entry in manifest["outputs"]}
    assert len(manifest["outputs"]) == 2  # CSV and one successful NPZ; no failed-candidate NPZ.
    with Path(outputs["conversions"]["path"]).open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    assert rows[1]["status"] == "input_incomplete"
    assert rows[1]["npz_path"] == ""
    with np.load(outputs["npz"]["path"], allow_pickle=False) as arrays:
        assert rows[0]["global_sha256"] == hashlib.sha256(arrays["global_view"].tobytes()).hexdigest()
    assert outputs["npz"]["sha256"] != rows[0]["global_sha256"]

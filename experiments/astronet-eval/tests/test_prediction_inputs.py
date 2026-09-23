"""Calibration-only adapter checks; no TensorFlow, model inference, or Git."""
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import numpy as np
import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("candidate_runner", SCRIPTS / "predict_candidates.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_inputs(tmp_path):
    rows, entries = [], []
    (tmp_path / "npz").mkdir()
    for i, tic in enumerate([259377017, 259377017, 307210830]):
        cid = "candidate-" + str(i)
        g, l = np.zeros(201, np.float32) + i, np.zeros(61, np.float32) + i
        row = dict(candidate_id=cid, tic_id=str(tic), label="PC", in_truth="true",
                   split="calibration" if i < 2 else "evaluation", status="ok", reason="",
                   global_sha256=hashlib.sha256(g.tobytes()).hexdigest(),
                   local_sha256=hashlib.sha256(l.tobytes()).hexdigest(),
                   npz_path="C:/old-laptop/" + cid + ".npz")
        rows.append(row)
        if i < 2:
            path = tmp_path / "npz" / (cid + ".npz")
            np.savez(path, candidate_id=cid, tic_id=tic, label="PC", global_view=g, local_view=l)
            entries.append(dict(kind="npz", candidate_id=cid, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    manifest = tmp_path / "convert.json"
    write_metadata(tmp_path, rows, entries, manifest)
    return rows, entries, manifest


def write_metadata(root, rows, entries, manifest):
    with (root / "conversions.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    manifest.write_text(json.dumps({"outputs": entries + [dict(kind="conversions",
        sha256=hashlib.sha256((root / "conversions.csv").read_bytes()).hexdigest())]}), encoding="utf-8")


def test_preserves_same_tic_candidates_and_never_loads_evaluation_npz(tmp_path, runner):
    _, _, manifest = make_inputs(tmp_path)
    result = runner.calibration_inputs(tmp_path, manifest)
    assert [r[0]["candidate_id"] for r in result] == ["candidate-0", "candidate-1"]
    assert result[0][1]["global_view"][0] == 0
    assert result[1][1]["global_view"][0] == 1


@pytest.mark.parametrize("problem", ["csv", "npz", "duplicate", "split", "array"])
def test_rejects_corruption_and_split_leakage(tmp_path, runner, problem):
    rows, entries, manifest = make_inputs(tmp_path)
    if problem == "csv":
        with (tmp_path / "conversions.csv").open("a") as fh:
            fh.write("corrupted")
    elif problem == "npz":
        (tmp_path / "npz/candidate-0.npz").write_bytes(b"corrupted")
    else:
        if problem == "duplicate":
            rows.append(rows[0])
        elif problem == "split":
            rows[0]["split"] = "evaluation"
        else:
            rows[0]["global_sha256"] = "wrong"
        write_metadata(tmp_path, rows, entries, manifest)
    with pytest.raises(ValueError):
        runner.calibration_inputs(tmp_path, manifest)


def test_input_failure_kept_without_zero_score(tmp_path, runner):
    rows, entries, manifest = make_inputs(tmp_path)
    rows[0].update(status="input_incomplete", reason="missing_geometry")
    write_metadata(tmp_path, rows, entries, manifest)
    selected = runner.calibration_inputs(tmp_path, manifest)
    assert selected[0][1] is None
    assert selected[0][0]["reason"] == "missing_geometry"


def test_threshold_boundaries_and_input_binding(tmp_path, runner):
    source, assets, path = [tmp_path / name for name in ('input.json', 'assets.json', 'plan.json')]
    source.write_text('{}'); assets.write_text('{}')
    predictions = tmp_path / 'predictions.csv'
    predictions.write_text('calibration fixture')
    calibration = tmp_path / 'manifest.json'
    plan = dict(threshold_version='test', lower=0, upper=.3,
                calibration_predictions_sha256=runner.digest(predictions),
                conversion_manifest_sha256=runner.digest(source), assets_sha256=runner.digest(assets))
    calibration.write_text(json.dumps(dict(status='completed', split='calibration',
        predictions_sha256=runner.digest(predictions), conversion_manifest_sha256=runner.digest(source),
        assets_sha256=runner.digest(assets))))
    path.write_text(json.dumps(plan))
    loaded = runner.load_thresholds(path, source, assets, calibration)
    assert runner.decision_band(0, loaded) == 'review'
    assert runner.decision_band(.2999, loaded) == 'review'
    assert runner.decision_band(.3, loaded) == 'approved'
    source.write_text('{"changed":true}')
    with pytest.raises(ValueError, match='binding'):
        runner.load_thresholds(path, source, assets, calibration)


@pytest.mark.parametrize('problem', ['missing_manifest', 'missing_csv', 'plan_hash', 'missing_hash',
    'manifest_hash', 'split', 'status', 'conversion', 'model'])
def test_calibration_provenance_rejected(tmp_path, runner, problem):
    source, assets, plan_path, manifest, predictions = [tmp_path / name for name in
        ('convert.json', 'assets.json', 'plan.json', 'manifest.json', 'predictions.csv')]
    source.write_text('{}'); assets.write_text('{}'); predictions.write_text('fixed calibration')
    plan = dict(threshold_version='test', lower=0, upper=.3,
        calibration_predictions_sha256=runner.digest(predictions),
        conversion_manifest_sha256=runner.digest(source), assets_sha256=runner.digest(assets))
    cal = dict(status='completed', split='calibration', predictions_sha256=runner.digest(predictions),
        conversion_manifest_sha256=runner.digest(source), assets_sha256=runner.digest(assets))
    if problem == 'plan_hash': plan['calibration_predictions_sha256'] = 'wrong'
    if problem == 'missing_hash': del plan['calibration_predictions_sha256']
    if problem == 'manifest_hash': cal['predictions_sha256'] = 'wrong'
    if problem == 'split': cal['split'] = 'evaluation'
    if problem == 'status': cal['status'] = 'failed'
    if problem == 'conversion': cal['conversion_manifest_sha256'] = 'other'
    if problem == 'model': cal['assets_sha256'] = 'other'
    manifest.write_text(json.dumps(cal)); plan_path.write_text(json.dumps(plan))
    if problem == 'missing_manifest': manifest = tmp_path / 'absent.json'
    if problem == 'missing_csv': predictions.unlink()
    with pytest.raises(ValueError):
        runner.load_thresholds(plan_path, source, assets, manifest)


def test_evaluation_selects_only_evaluation_candidates(tmp_path, runner):
    rows, entries, manifest = make_inputs(tmp_path)
    # Use the evaluation row as an explicit input failure: no array loading required.
    rows[2].update(status='input_incomplete', reason='missing_geometry')
    write_metadata(tmp_path, rows, entries, manifest)
    result = runner.calibration_inputs(tmp_path, manifest, 'evaluation')
    assert len(result) == 1 and result[0][0]['candidate_id'] == 'candidate-2'


def test_evaluation_manifest_records_verified_calibration_hash(tmp_path, runner, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace
    source, assets, plan_path, calibration = [tmp_path / n for n in
        ('convert.json', 'assets.json', 'plan.json', 'calibration.json')]
    source.write_text('{}')
    (tmp_path / 'predictions.csv').write_text('calibration fixture')
    (tmp_path / 'conversions.csv').write_text('input fixture')
    assets.write_text(json.dumps(dict(repo_commit=runner.COMMIT, checkpoint=runner.CHECKPOINT,
                                     image=runner.IMAGE, files=[])))
    plan = dict(threshold_version='test', lower=0, upper=.3,
        calibration_predictions_sha256=runner.digest(tmp_path / 'predictions.csv'),
        conversion_manifest_sha256=runner.digest(source), assets_sha256=runner.digest(assets))
    plan_path.write_text(json.dumps(plan))
    calibration.write_text(json.dumps(dict(status='completed', split='calibration',
        predictions_sha256=plan['calibration_predictions_sha256'],
        conversion_manifest_sha256=plan['conversion_manifest_sha256'], assets_sha256=plan['assets_sha256'])))
    metadata = dict(candidate_id='failed-input', tic_id='123', label='PC', in_truth='true',
                    split='evaluation', status='input_incomplete', reason='missing_geometry')
    monkeypatch.setattr(runner, 'calibration_inputs', lambda *args: [(metadata, None)])
    monkeypatch.setattr(runner, 'build_graph', lambda *args: (object(),
        {'global_view': object(), 'local_view': object()}, None, SimpleNamespace(restore=lambda *a: None)))
    fake_tf = SimpleNamespace(__version__='1.15.5', ConfigProto=lambda **kw: None,
                              Session=lambda **kw: nullcontext(object()))
    monkeypatch.setitem(sys.modules, 'tensorflow', fake_tf)
    monkeypatch.setitem(sys.modules, 'astronet', SimpleNamespace(models=SimpleNamespace(get_model_config=lambda *a: {})))
    monkeypatch.setitem(sys.modules, 'astronet.util', SimpleNamespace(configdict=SimpleNamespace(ConfigDict=lambda x: x)))
    out = tmp_path / 'out'
    monkeypatch.setattr(sys, 'argv', ['predict_candidates.py', '--run-dir', str(tmp_path),
        '--conversion-manifest', str(source), '--model-root', str(tmp_path), '--output-dir', str(out),
        '--split', 'evaluation', '--threshold-plan', str(plan_path), '--calibration-manifest', str(calibration)])
    runner.main()
    report = json.loads((out / 'manifest.json').read_text())
    assert report['calibration_manifest_sha256'] == runner.digest(calibration)
    assert report['threshold_plan'] == plan and report['status'] == 'completed'
    assert report['n_scored'] == 0  # synthetic input failure; no inference performed

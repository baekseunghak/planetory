"""126 state/provenance regression without real checkpoint inference."""
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest


@pytest.fixture
def batch(monkeypatch):
    scripts = Path(__file__).resolve().parents[1] / 'scripts'
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location('internal_batch_test', scripts / 'internal_batch.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def candidates():
    return [(dict(candidate_id='a', tic_id='1', status='ok', reason='',
                  global_sha256='a'*64, local_sha256='b'*64),
             dict(global_view=np.zeros(201, np.float32), local_view=np.zeros(61, np.float32))),
            (dict(candidate_id='b', tic_id='1', status='input_incomplete', reason='flat_view'), None)]


def test_zero_is_success_and_missing_input_is_null(batch):
    rows = batch.infer_rows(candidates(), lambda arrays: 0.)
    assert rows[0]['score'] == 0 and rows[0]['status'] == 'completed'
    assert rows[1]['score'] is None and rows[1]['reason'] == 'flat_view'
    assert all(not {'decision_band', 'verdict', 'threshold_version', 'applied_at'} & r.keys() for r in rows)
    assert batch.compare_runs(rows, rows)['inference_reproducible']


@pytest.mark.parametrize('value', [float('nan'), float('inf'), -0.1, 1.1])
def test_invalid_prediction_is_failure_not_zero(batch, value):
    row = batch.infer_rows(candidates(), lambda _: value)[0]
    assert row['status'] == 'inference_failed' and row['score'] is None


def test_predict_exception_is_recorded_without_message(batch):
    def fail(_):
        raise RuntimeError('do not serialize arbitrary exception details')
    rows = batch.infer_rows(candidates(), fail)
    assert rows[0]['reason'] == 'RuntimeError'
    assert not batch.compare_runs(rows, rows)['inference_reproducible']


def test_reproducibility_detects_score_and_identity_changes(batch):
    a = batch.infer_rows(candidates(), lambda _: .1)
    b = batch.infer_rows(candidates(), lambda _: .2)
    assert batch.compare_runs(a, b)['mismatches'] == ['a']
    with pytest.raises(ValueError, match='candidate_set_changed'):
        batch.compare_runs(a, b[:1])
    with pytest.raises(ValueError, match='duplicate_candidate_id'):
        batch.compare_runs(a + a, b)


def test_execute_preserves_two_runs_and_detects_input_mutation(batch, tmp_path, monkeypatch):
    source = tmp_path / 'source'
    source.write_text('fixed')
    monkeypatch.setattr(batch, 'snapshot_inputs', lambda *args:
                        (candidates()[:1], {str(source): batch.digest(source)}))
    calls = []
    @contextmanager
    def predictor(root):
        calls.append(root)
        yield lambda _: 0.
    out = tmp_path / 'out'
    report = batch.execute(tmp_path, tmp_path, source, out, predictor)
    assert len(calls) == 2 and report['verification_passed']
    assert report['publishable'] is False
    for name, sha in report['outputs'].items():
        assert batch.digest(out / name) == sha
    with pytest.raises(FileExistsError):
        batch.execute(tmp_path, tmp_path, source, out, predictor)
    @contextmanager
    def mutator(root):
        source.write_text('changed')
        yield lambda _: 0.
    with pytest.raises(ValueError, match='input_changed'):
        batch.execute(tmp_path, tmp_path, source, tmp_path / 'bad', mutator)
    assert not (tmp_path / 'bad/manifest.json').exists()
    assert json.loads((tmp_path / 'bad/failure.json').read_text())['status'] == 'failed'


def test_model_missing_checkpoint_fails_before_inference(batch, tmp_path):
    conversion = tmp_path / 'convert.json'
    conversion.write_text(json.dumps({'outputs': []}))
    (tmp_path / 'assets.json').write_text(json.dumps(dict(repo_commit=batch.COMMIT,
        image=batch.IMAGE, checkpoint=batch.CHECKPOINT, files=[])))
    with pytest.raises(ValueError, match='incomplete_or_duplicate_model_assets'):
        batch.snapshot_inputs(tmp_path, tmp_path, conversion)


def test_duplicate_npz_manifest_fails(batch, tmp_path):
    conversion = tmp_path / 'convert.json'
    conversion.write_text(json.dumps({'outputs': [dict(kind='npz', candidate_id='a')] * 2}))
    with pytest.raises(ValueError, match='duplicate_npz_manifest_entry'):
        batch.snapshot_inputs(tmp_path, tmp_path, conversion)

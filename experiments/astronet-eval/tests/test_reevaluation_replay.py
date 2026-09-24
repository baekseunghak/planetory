import json
import pytest
from astronet_eval.reevaluation_replay import replay, sha, write


def source(tmp_path):
    folder = tmp_path / 'source'
    folder.mkdir()
    rows = [dict(candidate_id='fixture-c1', status='completed', score=0.,
                 input_version='v1', input_hashes={'global_sha256': 'a'*64}, model_version='original')]
    for n in (1, 2):
        write(folder / f'predictions-{n}.json', rows)
    write(folder / 'manifest.json', dict(status='completed', internal_only=True, publishable=False,
          verification_passed=True, candidate_count=1,
          outputs={f'predictions-{n}.json': sha(folder / f'predictions-{n}.json') for n in (1, 2)}))
    return folder


def test_replay_preserves_zero_and_source_files(tmp_path):
    folder = source(tmp_path)
    before = {p.name: sha(p) for p in folder.iterdir()}
    out = tmp_path / 'out'
    report = replay(folder, out)
    assert report['candidates'] == 1 and report['attempts'] == 4
    assert report['internal_only'] and not report['publishable']
    assert before == {p.name: sha(p) for p in folder.iterdir()}
    history = json.loads((out / 'histories.json').read_text())[0]['history']
    assert [a['score'] for a in history['attempts']] == [0., 0., None, 0.]
    for name, digest in report['outputs'].items():
        assert sha(out / name) == digest


def test_changed_input_rejected(tmp_path):
    folder = source(tmp_path)
    (folder / 'predictions-1.json').write_text('[]')
    with pytest.raises(ValueError, match='checksum'):
        replay(folder, tmp_path / 'out')


def test_existing_output_not_overwritten(tmp_path):
    folder = source(tmp_path)
    out = tmp_path / 'out'
    replay(folder, out)
    with pytest.raises(FileExistsError):
        replay(folder, out)

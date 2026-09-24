"""126 internal-only inference on verified 118-format views (Python >=3.6).

No threshold plan, service database, Gold writer, or publication interface.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import platform
import sys

import numpy as np

from prepare_model import COMMIT, IMAGE, CHECKPOINT
from predict_candidates import build_graph, calibration_inputs, digest

VERSION = "astronet-internal-batch-1.0.0"
INPUT_VERSION = "astronet-triage-global201-local61-conversion-manifest-v1"
SEMANTICS = "PC/EB versus junk triage score; not planet probability; not PC versus EB"


def infer_rows(selected, predict):
    rows = []
    for metadata, arrays in selected:
        row = dict(candidate_id=metadata['candidate_id'], tic_id=metadata['tic_id'],
                   status='input_incomplete', reason=metadata.get('reason') or 'input_incomplete',
                   score=None, input_version=INPUT_VERSION, model_version=COMMIT + ':' + CHECKPOINT,
                   input_hashes={k: metadata.get(k) for k in ('global_sha256', 'local_sha256')})
        if arrays is not None:
            try:
                score = float(predict(arrays))
                if not np.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError('invalid_score')
                row.update(status='completed', reason=None, score=score)
            except Exception as exc:
                # Exception class is enough for diagnosis; never serialize arbitrary messages.
                row.update(status='inference_failed', reason=type(exc).__name__, score=None)
        rows.append(row)
    return rows


def compare_runs(first, second):
    def keyed(rows):
        out = {r['candidate_id']: r for r in rows}
        if len(out) != len(rows):
            raise ValueError('duplicate_candidate_id')
        return out
    a, b = keyed(first), keyed(second)
    if a.keys() != b.keys():
        raise ValueError('candidate_set_changed')
    mismatches, scored = [], 0
    for cid in sorted(a):
        # Exact comparison is deliberately limited to this pinned CPU/environment.
        if a[cid] != b[cid]:
            mismatches.append(cid)
        if a[cid]['status'] == b[cid]['status'] == 'completed':
            scored += 1
    return dict(equal=not mismatches, scored_pairs=scored, mismatches=mismatches,
                inference_reproducible=not mismatches and scored > 0,
                comparison='exact score/status/input identity; same pinned CPU environment')


def snapshot_inputs(root, run_dir, conversion_manifest):
    conversion = json.loads(conversion_manifest.read_text(encoding='utf-8'))
    npz_ids = [e['candidate_id'] for e in conversion['outputs'] if e.get('kind') == 'npz']
    if len(npz_ids) != len(set(npz_ids)):
        raise ValueError('duplicate_npz_manifest_entry')
    assets_path = root / 'assets.json'
    assets = json.loads(assets_path.read_text(encoding='utf-8'))
    if (assets['repo_commit'], assets['checkpoint'], assets['image']) != (COMMIT, CHECKPOINT, IMAGE):
        raise ValueError('unexpected_model_version')
    entries = assets['files']
    names = [e['path'] for e in entries]
    required = {'LICENSE', CHECKPOINT + '.index', CHECKPOINT + '.data-00000-of-00001', 'astronet/models.py'}
    if len(names) != len(set(names)) or not required.issubset(names):
        raise ValueError('incomplete_or_duplicate_model_assets')
    paths = [assets_path, conversion_manifest, run_dir / 'conversions.csv', Path(__file__),
             Path(__file__).with_name('predict_candidates.py'), Path(__file__).with_name('prepare_model.py')]
    for entry in entries:
        path = (root / entry['path']).resolve()
        path.relative_to(root.resolve())
        if digest(path) != entry['sha256']:
            raise ValueError('model_checksum_mismatch')
        paths.append(path)
    selected = []
    for split in ('calibration', 'evaluation'):
        selected.extend(calibration_inputs(run_dir, conversion_manifest, split))
    for metadata, arrays in selected:
        if arrays is not None:
            paths.append(run_dir / 'npz' / (metadata['candidate_id'] + '.npz'))
    snapshot = {str(p.resolve()): digest(p) for p in paths}
    return selected, snapshot


@contextmanager
def tensorflow_predictor(root):
    sys.path.insert(0, str(root.resolve()))
    import tensorflow as tf
    from astronet import models
    from astronet.util import configdict
    if tf.__version__ != '1.15.5':
        raise ValueError('unexpected_tensorflow_version')
    config = configdict.ConfigDict(models.get_model_config('AstroCNNModel', 'local_global'))
    graph, placeholders, model, saver = build_graph(tf, models, config)
    if set(placeholders) != {'global_view', 'local_view'}:
        raise ValueError('unexpected_input_features')
    with tf.Session(graph=graph, config=tf.ConfigProto(device_count={'GPU': 0},
                    intra_op_parallelism_threads=1, inter_op_parallelism_threads=1)) as session:
        saver.restore(session, str(root / CHECKPOINT))
        yield lambda arrays: session.run(model.predictions,
            {placeholders[k]: arrays[k][None, :] for k in placeholders})[0][0]


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def execute(root, run_dir, conversion_manifest, output, factory=tensorflow_predictor):
    output.mkdir(parents=True, exist_ok=False)
    try:
        selected, snapshot = snapshot_inputs(root, run_dir, conversion_manifest)
        plan = dict(task='S15P21C206-126', runner_version=VERSION, internal_only=True,
                    publishable=False, score_semantics=SEMANTICS, input_version=INPUT_VERSION,
                    source_scope='118-format evaluation candidates reused for execution regression, not a new independent evaluation',
                    repo_commit=COMMIT, checkpoint=CHECKPOINT, image=IMAGE, input_hashes=snapshot,
                    repeats=2, python=platform.python_version(), numpy=np.__version__,
                    platform=platform.platform(), device='CPU', threads=1)
        write_json(output / 'plan.json', plan)
        plan_hash = digest(output / 'plan.json')
        runs = []
        for i in range(2):
            with factory(root) as predict:
                rows = infer_rows(selected, predict)
            write_json(output / ('predictions-{}.json'.format(i + 1)), rows)
            runs.append(rows)
        comparison = compare_runs(*runs)
        write_json(output / 'comparison.json', comparison)
        if any(digest(Path(p)) != h for p, h in snapshot.items()) or digest(output / 'plan.json') != plan_hash:
            raise ValueError('input_changed_during_run')
        failures = sum(r['status'] != 'completed' for r in runs[0])
        files = ['plan.json', 'predictions-1.json', 'predictions-2.json', 'comparison.json']
        manifest = dict(task='S15P21C206-126', status='completed', internal_only=True, publishable=False,
                        candidate_count=len(selected), non_scored_count=failures,
                        verification_passed=comparison['inference_reproducible'] and failures == 0,
                        tensorflow=getattr(sys.modules.get('tensorflow'), '__version__', 'test-double'),
                        outputs={name: digest(output / name) for name in files})
        write_json(output / 'manifest.json', manifest)
        return manifest
    except Exception as exc:
        write_json(output / 'failure.json', dict(status='failed', reason=type(exc).__name__))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-root', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--conversion-manifest', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    report = execute(args.model_root, args.run_dir, args.conversion_manifest, args.output_dir)
    print(json.dumps(report, indent=2))
    if not report['verification_passed']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()

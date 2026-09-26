"""130 saved-score replay; fixture identities and thresholds, never service output."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from astro_kernel import ai_reevaluation as kernel


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n', encoding='utf-8')


def check(condition):
    if not condition:
        raise ValueError("replay_invariant_failed")


def replay(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    paths = [source / n for n in ('manifest.json', 'predictions-1.json', 'predictions-2.json')]
    hashes = {str(p): sha(p) for p in paths}
    manifest = json.loads(paths[0].read_text(encoding='utf-8'))
    if not (manifest.get('status') == 'completed' and manifest.get('internal_only') is True
            and manifest.get('publishable') is False and manifest.get('verification_passed') is True):
        raise ValueError('verified_internal_run_required')
    for path in paths[1:]:
        if manifest['outputs'][path.name] != hashes[str(path)]:
            raise ValueError('prediction_checksum_mismatch')
    rows = json.loads(paths[1].read_text(encoding='utf-8'))
    if rows != json.loads(paths[2].read_text(encoding='utf-8')):
        raise ValueError('source_sessions_differ')
    if not rows or len(rows) != manifest['candidate_count'] or len({r['candidate_id'] for r in rows}) != len(rows):
        raise ValueError('candidate_set_mismatch')
    output.mkdir(parents=True, exist_ok=False)
    code = {str(p): sha(p) for p in (Path(__file__).resolve(), Path(kernel.__file__).resolve())}
    write(output / 'plan.json', dict(task='S15P21C206-130', internal_only=True, publishable=False,
          fixture_ids_only=True, inputs=hashes, code=code,
          scope='Saved scores; synthetic model-change/failure callbacks, not new model inference'))
    reports = []
    try:
        for index, row in enumerate(rows, 1):
            if row['status'] != 'completed':
                raise ValueError('completed_score_required')
            # Source model_version is opaque provenance, not a verified checkpoint digest.
            # Controlled identifiers below are deliberately marked fixtures.
            args = dict(model_version='fixture-model-1', checkpoint_sha256='a'*64,
                        input_version=row['input_version'], input_sha256=hashlib.sha256(
                            json.dumps(row['input_hashes'], sort_keys=True).encode()).hexdigest(),
                        score_semantics='PC/EB versus junk; not planet probability',
                        threshold_version='fixture-threshold-1', lower=.2, upper=.8)
            first_intent = kernel.request(index, 1, **args)
            def step(state, wanted, attempt, callback):
                return kernel.reevaluate(state, wanted, attempt, callback, expected_revision=state['revision'])
            def stored(_):
                return dict(score=row['score'], raw_output={'source_row': row})
            first = step(kernel.empty_history(index), first_intent, 'initial', stored)
            if first['current'] != 'initial':
                raise ValueError('invalid_saved_score')
            changed = kernel.request(index, 2, **dict(args, threshold_version='fixture-threshold-2', upper=.6))
            def forbidden(_):
                raise AssertionError('unexpected_inference')
            second = step(first, changed, 'threshold', forbidden)
            check(second['current'] == 'threshold')
            check(second['attempts'][-1]['score'] == row['score'])
            check(second['attempts'][-1]['reused_from'] == 'initial')
            check(step(second, changed, 'duplicate', forbidden) == second)
            model_change = kernel.request(index, 3, **dict(args, model_version='fixture-model-2'))
            def fail(_):
                raise RuntimeError('controlled failure')
            failed = step(second, model_change, 'failed', fail)
            check(failed['current'] == 'threshold')
            recovered = step(failed, model_change, 'retry', stored)
            check(recovered['current'] == 'retry')
            check(recovered['attempts'][:3] == failed['attempts'])
            check(step(recovered, first_intent, 'old-event', forbidden) == recovered)
            reports.append(dict(source_candidate_id=row['candidate_id'], fixture_candidate_id=index,
                                source_model_version=row['model_version'], history=recovered))
        for p, digest in {**hashes, **code}.items():
            if sha(Path(p)) != digest:
                raise ValueError('input_or_code_changed')
        write(output / 'histories.json', reports)
        report = dict(task='S15P21C206-130', status='completed', internal_only=True, publishable=False,
                      fixture_ids_only=True, candidates=len(reports),
                      attempts=sum(len(r['history']['attempts']) for r in reports),
                      outputs={n: sha(output / n) for n in ('plan.json', 'histories.json')})
        write(output / 'manifest.json', report)
        return report
    except Exception as exc:
        write(output / 'failure.json', dict(status='failed', reason=type(exc).__name__))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-run', required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    output = root / 'results' / 'reevaluation-130' / ('run-' + stamp + '-' + uuid4().hex[:8])
    print(json.dumps(replay(args.source_run, output), indent=2))
    print('Results:', output)


if __name__ == '__main__':
    main()

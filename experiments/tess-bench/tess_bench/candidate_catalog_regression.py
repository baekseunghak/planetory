"""122 saved-real-curve catalog/113 contract integration; never publishes or allocates DB IDs."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.transit_model import parse_transit_model
from tess_fixture.targets import select_targets

ROOT = Path(__file__).resolve().parents[3]


def entry(path):
    return dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def verify(entries):
    for item in entries:
        if entry(Path(item['path']))['sha256'] != item['sha256']:
            raise ValueError(f"snapshot changed: {item['path']}")


def run(source, results):
    import jsonschema
    source = source.resolve()
    manifest_path = source / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('passed') is not True or manifest.get('task') != 'S15P21C206-122':
        raise ValueError('a passing 122 numerical regression manifest is required')
    verify([manifest['plan'], *manifest['outputs']])
    schema_path = ROOT / 'contracts/gold/transit-model.schema.json'
    schema = json.loads(schema_path.read_text(encoding='utf-8'))
    inputs = [entry(manifest_path), entry(schema_path), *manifest['outputs']]
    inputs += [entry(path) for path in sorted((ROOT / 'libs/astro-kernel/astro_kernel').glob('*.py'))]
    inputs.append(entry(Path(__file__)))
    import csv
    rows = list(csv.DictReader((source / 'comparisons.csv').open(encoding='utf-8', newline='')))
    if len(rows) != manifest['n_curves']:
        raise ValueError('comparison row count disagrees with manifest')
    out = results / ('run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task='S15P21C206-122', scope='saved real curve catalog and same-result new-bundle identity retry',
                identity_approval='synthetic-contract-test-not-production-approval', fixture_ids_only=True,
                inputs=inputs, limitation='does not establish approval, Sector-change accuracy or Gold publication')
    (out / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    plan_entry = entry(out / 'plan.json')
    counts, proofs = Counter(), []
    try:
        for index, row in enumerate(rows):
            path = (source / row['output']).resolve()
            if path.parent != source or str(path) not in {str(Path(item['path']).resolve()) for item in manifest['outputs']}:
                raise ValueError('curve must be a verified manifest output')
            iteration = json.loads(path.read_text(encoding='utf-8'))
            tic = select_targets([row['target']])[0].tic_id
            kwargs = dict(tic_id=tic, bundle_id=100 + index)
            proposal = build_candidate_catalog(iteration, **kwargs)
            allocation = {peak: 10000 + index * 100 + n for n, peak in enumerate(proposal['needed_new_peak_ids'])}
            unapproved = build_candidate_catalog(iteration, new_candidate_ids=allocation, **kwargs)
            assert unapproved['status'] == 'held' and not unapproved['lifecycle_actions']
            assert unapproved['candidates'] == [] and unapproved['publishable'] is False
            current = build_candidate_catalog(iteration, new_candidate_ids=allocation,
                identity_approval=plan['identity_approval'], **kwargs)
            retry = None
            if current['catalog_ready']:
                assert current['status'] == 'ready' and current['candidates']
                assert all(action['action'] == 'add' for action in current['lifecycle_actions'])
                for candidate in current['candidates']:
                    jsonschema.Draft202012Validator(schema).validate(candidate['transit_model'])
                    parse_transit_model(candidate['transit_model'])
                    assert candidate['transit_model']['candidate_id'] == f"c-{candidate['candidate_id']}"
                previous = {key: current[key] for key in ('tic_id', 'bundle_id', 'complete', 'time_start_btjd',
                            'time_end_btjd', 'candidates', 'candidate_aliases')}
                retry = build_candidate_catalog(iteration, previous, tic_id=tic, bundle_id=1000 + index,
                    identity_approval=plan['identity_approval'])
                assert retry['catalog_ready'] and not retry['needed_new_peak_ids']
                assert len(retry['lifecycle_actions']) == len(current['candidates'])
                assert all(action['action'] == 'keep' for action in retry['lifecycle_actions'])
                assert sorted(c['candidate_id'] for c in retry['candidates']) == sorted(c['candidate_id'] for c in current['candidates'])
                counts['ready'] += 1
                counts['kept_candidate_ids'] += len(retry['candidates'])
            else:
                assert current['status'] == 'held' and not current['lifecycle_actions'] and current['candidates'] == []
                counts['held'] += 1
                counts.update(current['reasons'])
            assert current['publishable'] is False
            proofs.append(dict(target=row['target'], group=row['group'], unapproved=unapproved, current=current, retry=retry))
        verify(inputs + [plan_entry])
        proof_path = out / 'proofs.json'
        proof_path.write_text(json.dumps(proofs, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        result = dict(task='S15P21C206-122', passed=True, plan=plan_entry, n_curves=len(proofs),
                      counts=dict(counts), outputs=[entry(proof_path)])
        (out / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result, indent=2))
        print(f"PASS: {out / 'manifest.json'}")
    except BaseException as exc:
        (out / 'failure.json').write_text(json.dumps(dict(passed=False, plan=plan_entry, reason=str(exc))) + '\n', encoding='utf-8')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--results', type=Path, default=ROOT / 'experiments/tess-bench/results/candidate-catalog-regression')
    args = parser.parse_args()
    run(args.source, args.results)


if __name__ == '__main__':
    main()

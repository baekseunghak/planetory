"""Recount saved 243 CSVs without FITS, BLS, or operational adoption."""
import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path


def summarize(folder):
    folder = Path(folder)
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['status'] != 'completed' or manifest['subset']:
        raise ValueError('full_completed_run_required')
    # Original absolute paths are provenance, never destinations on the reviewer's PC.
    entries = [manifest['plan'], *manifest['outputs']]
    for name in ('plan.json', 'comparisons.csv', 'peaks.csv'):
        matches = [e for e in entries if e['path'].replace('\\', '/').split('/')[-1] == name]
        if len(matches) != 1 or hashlib.sha256((folder / name).read_bytes()).hexdigest() != matches[0]['sha256']:
            raise ValueError(f'checksum_mismatch:{name}')
    rows = list(csv.DictReader((folder / 'comparisons.csv').open(encoding='utf-8', newline='')))
    keys = [(r['target'], r['baseline'], r['group'], r['method'], r['dy'], r['threshold']) for r in rows]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate_comparison')
    curves = Counter(k[:3] for k in keys)
    if len(rows) != manifest['comparison_rows'] or len(curves) != manifest['curves'] or set(curves.values()) != {81}:
        raise ValueError('incomplete_comparisons')
    totals = defaultdict(Counter)
    paired = defaultdict(dict)
    for r in rows:
        kind = 'noise' if r['baseline'].startswith('noise') else 'real'
        key = (r['method'], r['dy'], r['threshold'])
        a = totals[key]
        if r['control'] == 'True':
            a[kind + '_controls'] += 1
            a[kind + '_control_peaks'] += int(r['selected_peaks'])
        else:
            for field in ('signals_in_range', 'direct', 'alias'):
                a[kind + '_' + field] += int(r[field])
        if key in (('global', 'global', '6.0'), ('running_median', 'global', '8.0')):
            paired[(r['target'], r['baseline'], r['group'])][r['method']] = r
    differences = []
    for key, pair in sorted(paired.items()):
        old, new = pair['global'], pair['running_median']
        differences.append(dict(target=key[0], baseline=key[1], group=key[2],
            direct_before=int(old['direct']), direct_after=int(new['direct']),
            direct_delta=int(new['direct']) - int(old['direct']),
            alias_delta=int(new['alias']) - int(old['alias']),
            control=old['control'] == 'True',
            selected_delta=int(new['selected_peaks']) - int(old['selected_peaks'])))
    return dict(scope='CSV verification only; NPZ and source input hashes require original run files',
        curves=len(curves), comparison_rows=len(rows),
        totals=[dict(method=k[0], dy=k[1], threshold=k[2], **v) for k, v in sorted(totals.items())],
        paired_curves=differences)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.folder), indent=2))


if __name__ == '__main__':
    main()

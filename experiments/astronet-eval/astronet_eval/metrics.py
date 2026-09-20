"""Summarize saved scores; evaluation uses its frozen plan, never retunes it."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def binary_metrics(positives, negatives, thresholds):
    """AP uses tied-score groups; PR trapezoids start at recall=0, precision=1."""
    pairs = [(s, True) for s in positives] + [(s, False) for s in negatives]
    if not all(math.isfinite(s) and 0 <= s <= 1 for s, _ in pairs):
        raise ValueError("Scores must be finite probabilities in [0, 1]")
    tp = fp = 0
    previous_recall, previous_precision = 0.0, 1.0
    ap = auc = 0.0
    points = []
    for score in sorted({s for s, _ in pairs}, reverse=True):
        tp += sum(y for s, y in pairs if s == score)
        fp += sum(not y for s, y in pairs if s == score)
        recall = tp / len(positives) if positives else None
        precision = tp / (tp + fp)
        if recall is not None:
            ap += (recall - previous_recall) * precision
            auc += (recall - previous_recall) * (precision + previous_precision) / 2
            previous_recall = recall
        previous_precision = precision
        points.append(dict(threshold=score, precision=precision, recall=recall))
    counts = []
    for threshold in thresholds:
        if not math.isfinite(threshold) or not 0 <= threshold <= 1:
            raise ValueError("Invalid diagnostic threshold")
        tp = sum(s >= threshold for s in positives)
        fp = sum(s >= threshold for s in negatives)
        counts.append(dict(threshold=threshold, tp=tp, fp=fp, fn=len(positives)-tp, tn=len(negatives)-fp,
                           recall=tp/len(positives) if positives else None,
                           precision=tp/(tp+fp) if tp+fp else None))
    return dict(n_positive=len(positives), n_negative=len(negatives),
                average_precision=ap if positives else None,
                pr_auc_trapezoid=auc if positives else None, pr_points=points, thresholds=counts)


def summarize(rows, thresholds, split='calibration', plan=None):
    if split not in ('calibration', 'evaluation'):
        raise ValueError('Unknown split')
    seen = set()
    groups = {}
    for row in rows:
        if row['candidate_id'] in seen or row['split'] != split:
            raise ValueError('Duplicate candidate or unexpected split')
        seen.add(row['candidate_id'])
        label = row['label']
        if label not in ('PC', 'EB', 'junk', 'junk_unverified'):
            raise ValueError('Unknown label')
        if row['in_truth'] != ('false' if label == 'junk_unverified' else 'true'):
            raise ValueError('Label/truth disagreement')
        group = groups.setdefault(label, dict(total=0, scored=0, failures={}, scores=[], bands={}))
        group['total'] += 1
        if row['status'] == 'ok':
            score = float(row['score'])
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError('Invalid score')
            group['scores'].append(score)
            group['scored'] += 1
            if plan:
                band = 'below' if score < plan['lower'] else 'approved' if score >= plan['upper'] else 'review'
                if row.get('decision_band') != band:
                    raise ValueError('Decision band disagrees with frozen plan')
                group['bands'][band] = group['bands'].get(band, 0) + 1
        else:
            if row['score'] != '':
                raise ValueError('Failed input must have a blank score')
            reason = row['status'] + ':' + row['reason']
            group['failures'][reason] = group['failures'].get(reason, 0) + 1
    positives = [s for label in ('PC', 'EB') for s in groups.get(label, {}).get('scores', [])]
    negatives = groups.get('junk', {}).get('scores', [])
    return dict(split=split, success_n=sum(g['scored'] for g in groups.values()), total_n=len(rows),
                by_label=groups, binary_scored_only=binary_metrics(positives, negatives, thresholds),
                note='PC/EB vs junk. Failed inputs excluded from score metrics, counted separately. No service threshold selected.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--threshold', type=float, action='append', default=[])
    args = parser.parse_args()
    path = args.run_dir / 'predictions.csv'
    raw = path.read_bytes()
    manifest = json.loads((args.run_dir / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['status'] != 'completed' or manifest['split'] not in ('calibration', 'evaluation'):
        raise ValueError('Expected completed prediction manifest')
    if hashlib.sha256(raw).hexdigest() != manifest['predictions_sha256']:
        raise ValueError('Predictions checksum mismatch')
    plan = None
    thresholds = args.threshold
    if manifest['split'] == 'evaluation':
        plan_bytes = (args.run_dir / 'threshold_plan.json').read_bytes()
        if hashlib.sha256(plan_bytes).hexdigest() != manifest['threshold_plan_sha256']:
            raise ValueError('Threshold plan checksum mismatch')
        plan = json.loads(plan_bytes)
        if plan != manifest['threshold_plan'] or not 0 <= plan['lower'] < plan['upper'] <= 1:
            raise ValueError('Invalid or conflicting frozen plan')
        if plan['conversion_manifest_sha256'] != manifest['conversion_manifest_sha256'] or plan['assets_sha256'] != manifest['assets_sha256']:
            raise ValueError('Frozen plan input/model mismatch')
        if thresholds:
            raise ValueError('Evaluation uses only the frozen upper threshold')
        thresholds = [plan['upper']]
    with path.open(encoding='utf-8', newline='') as fh:
        report = summarize(list(csv.DictReader(fh)), thresholds, manifest['split'], plan)
    if (report['total_n'], report['success_n']) != (manifest['n_candidates'], manifest['n_scored']):
        raise ValueError('Manifest candidate counts mismatch')
    report.update(predictions_sha256=manifest['predictions_sha256'], wall_seconds=manifest['wall_seconds'])
    print(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()

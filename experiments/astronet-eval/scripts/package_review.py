"""Verify saved results and copy only small evidence into a portable review ZIP.

No inference. Historical manifests remain byte-for-byte unchanged.
"""
import argparse
import csv
import json
from pathlib import Path
import zipfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from predict_candidates import digest, load_thresholds
from astronet_eval.metrics import summarize


def package(calibration, evaluation, conversion, assets, output):
    plan_path = evaluation / 'threshold_plan.json'
    plan = load_thresholds(plan_path, conversion, assets, calibration / 'manifest.json')
    reports = {}
    for split, directory in (('calibration', calibration), ('evaluation', evaluation)):
        manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
        if manifest.get('status') != 'completed' or manifest.get('split') != split:
            raise ValueError('Invalid saved manifest: ' + split)
        if digest(directory / 'predictions.csv') != manifest['predictions_sha256']:
            raise ValueError('Predictions hash mismatch: ' + split)
        for key in ('conversion_manifest_sha256', 'assets_sha256'):
            if manifest[key] != plan[key]:
                raise ValueError('Saved input/model mismatch: ' + split)
        if split == 'evaluation':
            if manifest['threshold_plan'] != plan or manifest['threshold_plan_sha256'] != digest(plan_path):
                raise ValueError('Saved threshold mismatch')
            if ('calibration_manifest_sha256' in manifest and
                    manifest['calibration_manifest_sha256'] != digest(calibration / 'manifest.json')):
                raise ValueError('Saved calibration manifest mismatch')
        with (directory / 'predictions.csv').open(encoding='utf-8', newline='') as f:
            rows = list(csv.DictReader(f))
        report = summarize(rows, [plan['upper']], split, plan if split == 'evaluation' else None)
        if (report['total_n'], report['success_n']) != (manifest['n_candidates'], manifest['n_scored']):
            raise ValueError('Candidate counts mismatch')
        reports[split] = report
    paths = {
        'calibration/predictions.csv': calibration / 'predictions.csv',
        'calibration/manifest.json': calibration / 'manifest.json',
        'evaluation/predictions.csv': evaluation / 'predictions.csv',
        'evaluation/manifest.json': evaluation / 'manifest.json',
        'evaluation/threshold_plan.json': plan_path,
        'common/convert-manifest.json': conversion,
        'common/assets.json': assets,
    }
    # Snapshot bytes once, so hashes describe exactly what is put in the ZIP.
    import hashlib
    payloads = {name: path.read_bytes() for name, path in paths.items()}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
    if any(digest(paths[name]) != value for name, value in hashes.items()):
        raise ValueError('Evidence changed during packaging')
    audit = dict(task='S15P21C206-118', verification='posthoc_saved_result_audit_not_inference',
                 calibration_manifest_sha256=hashes['calibration/manifest.json'],
                 hashes=hashes, metrics=reports,
                 note='Original manifests unchanged. Historical evaluation did not perform the new preflight.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in payloads.items():
            archive.writestr(name, data)
        archive.writestr('verification.json', json.dumps(audit, ensure_ascii=False, indent=2, allow_nan=False))
    print(json.dumps(audit, ensure_ascii=False, indent=2, allow_nan=False))
    print('ZIP: {}\nSHA256: {}'.format(output, digest(output)))
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('calibration-run', 'evaluation-run', 'conversion-manifest', 'assets', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    package(args.calibration_run, args.evaluation_run, args.conversion_manifest, args.assets, args.output)


if __name__ == '__main__':
    main()

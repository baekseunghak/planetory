"""Replay saved first-step removal for 1 d / 8 h injections, without BLS search or Git."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from astro_kernel import remove_transit_models
from . import iterate as it


def measure(t, flux, candidate):
    """Measure absolute baseline and removal offset separately; do not change QA."""
    residual = np.asarray(remove_transit_models(t, flux, [candidate.model('diagnostic')]).flux_residual)
    phase = np.abs(it.bl._phase_distance(t, candidate.period_days, candidate.epoch_btjd))
    duration = candidate.duration_hours / 24
    inside = phase < duration / 2
    outside = phase >= duration
    mean, z = it.window_offset(t, residual, candidate.period_days, candidate.epoch_btjd, duration)
    out = {}
    for name, values in [('before', flux), ('after', residual)]:
        for region, mask in [('inside', inside), ('outside', outside)]:
            values_region = values[mask & np.isfinite(values)]
            out[f'{name}_{region}_n'] = int(values_region.size)
            out[f'{name}_{region}_mean_ppm'] = float(np.mean(values_region - 1) * 1e6) if values_region.size else float('nan')
    out['after_inside_minus_outside_ppm'] = out['after_inside_mean_ppm'] - out['after_outside_mean_ppm']
    out['window_offset_z'] = z
    out['window_offset_rel'] = mean / (candidate.depth_ppm / 1e6)
    out['edge_excess'] = it.edge_excess(t, residual, candidate.period_days, candidate.epoch_btjd, duration)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    from . import cli
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    params = manifest['config']['parameters']
    if params['baselines'] != ['realclean'] or params.get('tamper_depth_factor') is not None:
        raise ValueError('diagnosis requires an untampered realclean-only source run')
    for entry in manifest['inputs'] + manifest['outputs']:
        if hashlib.sha256(Path(entry['path']).read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f"source checksum mismatch: {entry['path']}")
    inputs = {x['role']: Path(x['path']) for x in manifest['inputs'] if 'role' in x}
    cfg, _ = cli.bl.load_bls_settings(inputs['bls_settings'], [params['setting']])
    pre = cli.Setting(setting_id=cfg['preprocess_setting_id'], **params['preprocess_setting'])
    bi = cli.build_bls_inputs(params['target'], params['stage'], cfg, pre, inputs['grid'], cli.DEFAULT_RAW, noise_seeds=[])
    if bi.known_models != params['known_signals_removed']:
        raise ValueError('Archive removal models differ from source manifest')
    selected = {gid: members for gid, members in bi.groups['realclean'].items()
                if len(members) == 1 and members[0].period_days == 1 and members[0].duration_hours == 8}
    if len(selected) != 12:
        raise ValueError(f'expected 12 single injections, found {len(selected)}')
    bi.groups['realclean'] = selected
    source = Path(next(x['path'] for x in manifest['outputs'] if x['kind'] == 'steps'))
    with source.open(encoding='utf-8', newline='') as stream:
        steps = {r['group_id']: r for r in csv.DictReader(stream)
                 if r['step'] == '0' and r['status'] in ('accepted', 'qa_failed')}
    if not set(selected) <= steps.keys():
        raise ValueError('source first-step candidates are missing')
    cli.preprocess_groups(bi)
    rows = []
    for gid in selected:
        saved = steps[gid]
        candidate = it.Candidate(0, **{k: float(saved[k]) for k in
            ('period_days', 'epoch_btjd', 'duration_hours', 'depth_ppm', 'sde', 'snr')},
            n_transits=int(saved['n_transits']), rank=int(saved['rank']))
        t, f = bi.prepared['realclean', gid]
        values = measure(t, f, candidate)
        reproduced = all(np.isclose(values[k], float(saved[k]), rtol=1e-7, atol=1e-8, equal_nan=True)
                         for k in ('window_offset_z', 'window_offset_rel', 'edge_excess'))
        rows.append(dict(group_id=gid, source_status=saved['status'], source_failures=saved['qa_failures'],
                         duration_hours=candidate.duration_hours, depth_ppm=candidate.depth_ppm,
                         source_metrics_reproduced=reproduced, **values))
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    outdir = cli.DEFAULT_RESULTS / 'diagnostics' / f'iterate-{manifest["run_id"][:8]}-{stamp}'
    outdir.mkdir(parents=True, exist_ok=False)
    output = outdir / 'window_offsets.csv'
    with output.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    fingerprint = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    provenance = {'task': 'S15P21C206-111 diagnostic', 'source_run_id': manifest['run_id'],
                  'source_manifest_sha256': fingerprint(args.manifest), 'output_sha256': fingerprint(output),
                  'source_metrics_reproduced': all(r['source_metrics_reproduced'] for r in rows),
                  'code_sha256': {str(p.relative_to(cli.REPO_DIR)): fingerprint(p)
                     for folder in (cli.PKG_DIR / 'tess_bench', cli.FIXTURE_DIR / 'tess_fixture',
                                    cli.REPO_DIR / 'libs/astro-kernel/astro_kernel') for p in sorted(folder.glob('*.py'))}}
    (outdir / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    print(f'12 curves; source metrics reproduced: {provenance["source_metrics_reproduced"]}')
    print(output)
    if not provenance['source_metrics_reproduced']:
        raise SystemExit('Replay mismatch: retain output and investigate before interpreting offsets')


if __name__ == '__main__':
    main()

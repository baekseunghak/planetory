"""128: reconstruct injected observation windows and replay saved 111 candidates.

User-run experiment: detrending and 10-minute binning, never a new BLS search.
Source recovery labels measure agreement only, not user-selection accuracy.
"""
import argparse
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timezone
from importlib.metadata import version
import json
from pathlib import Path
import subprocess
import time
from uuid import uuid4

import numpy as np
from astro_kernel.transit_model import remove_transit_models
from tess_fixture import inject as inj
from tess_fixture.lightcurve import build_baseline, load_sector, synthetic_noise_baseline
from .binning import bin_curve
from .candidate_identity_audit import read_csv
from .matching_evidence import audit, key, sha
from .preprocess import Setting, preprocess

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / 'experiments/tess-bench'
API = ROOT / 'docs/api/exploration'


def observation(baseline, flux):
    """API 6.2 windows use bin starts, not model-evaluation bin centers."""
    windows, bounds, bins = [], [], []
    for sector in baseline.sectors:
        mask = baseline.sector_of_point == sector
        b = bin_curve(baseline.time[mask], flux[mask], minutes=10, reducer='mean')
        if b.minutes != 10:
            raise ValueError('sector exceeds 20000 bins; never widen operational cadence')
        valid = np.flatnonzero(b.counts > 0)
        for part in np.split(valid, np.where(np.diff(valid) > 1)[0] + 1):
            if len(part):
                windows.append([b.start + int(part[0]) / 144, b.start + int(part[-1]) / 144])
        bounds.extend([b.start, b.start + len(b.counts) / 144])
        bins.append(dict(sector=int(sector), n_points=len(b.counts), n_empty=int((b.counts == 0).sum())))
    return dict(foldReferenceTimeBtjd=float(np.median(baseline.time)),
                observationBounds=[min(bounds), max(bounds)], observedWindows=sorted(windows),
                cadenceDays=1 / 144), bins


def selection(period, epoch, duration_hours, reference):
    width = duration_hours / 24 / period
    center = ((epoch - reference) / period) % 1
    start = (center - width / 2) % 1
    return dict(periodDays=period, phaseStart=start, phaseEnd=start + width, sourcePeakGridIndex=None)


def snapshot(paths):
    return [dict(path=str(p.resolve()), sha256=sha(p.read_bytes())) for p in sorted(set(paths))]


def assert_snapshot(records):
    for r in records:
        if sha(Path(r['path']).read_bytes()) != r['sha256']:
            raise ValueError(f"snapshot changed: {r['path']}")


def preflight(path):
    evidence = audit(path)  # validates clean source, three output hashes and links
    manifest = json.loads(path.read_bytes())
    params = manifest['config']['parameters']
    if params['setting_params']['period_max_rule'] != 'baseline/3':
        raise ValueError('unsupported source period grid')
    inputs = [r for r in manifest['inputs'] if r['role'] in ('raw_product', 'grid')]
    if not any(r['role'] == 'raw_product' for r in inputs) or sum(r['role'] == 'grid' for r in inputs) != 1:
        raise ValueError('raw products and one injection grid required')
    assert_snapshot(inputs)
    outputs = [Path(r['path']) for r in manifest['outputs']]
    return manifest, evidence, snapshot([path, *outputs, *(Path(r['path']) for r in inputs)])


def build_run(manifest, evidence, *, log=print):
    params = manifest['config']['parameters']
    raw = [Path(r['path']) for r in manifest['inputs'] if r['role'] == 'raw_product']
    grid_path = next(Path(r['path']) for r in manifest['inputs'] if r['role'] == 'grid')
    strict = build_baseline([load_sector(p) for p in raw])
    models = params['known_signals_removed']
    clean_flux = remove_transit_models(strict.time, strict.flux, models).flux_residual if models else strict.flux
    baselines = {'realclean': replace(strict, flux=clean_flux)}
    for seed in params['noise_seeds']:
        baselines[f'noise{seed}'] = synthetic_noise_baseline(strict, seed=seed)
    if set(params['baselines']) != set(baselines):
        raise ValueError('only realclean/noise injected source runs supported')
    pre = Setting(setting_id='source-manifest', **params['preprocess_setting'])
    grid = inj.load_grid(grid_path)
    if inj.grid_set_id(grid) != params['grid_set_id']:
        raise ValueError('injection grid version mismatch')
    steps_path = next(Path(r['path']) for r in manifest['outputs'] if r['kind'] == 'steps')
    accepted = defaultdict(list)
    for row in read_csv(steps_path):
        if row['status'] == 'accepted':
            accepted[key(row)].append(row)
    measured = defaultdict(list)
    for row in evidence['measurements']:
        measured[(row['baseline_id'], row['group_id'])].append(row)
    curves = []
    matches_path = next(Path(r['path']) for r in manifest['outputs'] if r['kind'] == 'matches')
    source_truth = {r['injection_id']: r for r in read_csv(matches_path)}
    for name, baseline in baselines.items():
        baseline_id = f"{params['target']}-{name}"
        members = defaultdict(list)
        for row in inj.build_catalog(grid, baseline, baseline_id, params['grid_set_id']):
            members[row.group_id].append(row)
        wanted = [(k, values) for k, values in measured.items() if k[0] == baseline_id]
        for index, ((_, gid), truths) in enumerate(wanted, 1):
            if gid not in members:
                raise ValueError('source group missing from reconstructed catalog')
            by_id = {r.injection_id: r for r in members[gid]}
            injected = inj.inject_group(baseline, members[gid])
            prepared = preprocess(baseline.time, injected, baseline.sector_of_point, pre)
            flux = np.where(prepared.kept, prepared.flux_det, np.nan)
            bundle, bins = observation(baseline, flux)
            bundle['periodGrid'] = dict(periodMinDays=params['setting_params']['period_min_days'],
                                        periodMaxDays=params['baseline_days'] / 3)
            candidates = [dict(id=f"c-{int(r['step']) + 1}", periodDays=float(r['period_days']),
                               epochBtjd=float(r['epoch_btjd']), durationHours=float(r['duration_hours']))
                          for r in accepted[(baseline_id, gid, params['setting'])]]
            submissions = []
            for truth in truths:
                r = by_id[truth['injection_id']]
                for field in ('period_days', 'duration_hours', 'depth_ppm'):
                    if getattr(r, field) != float(source_truth[r.injection_id][field]):
                        raise ValueError(f'reconstructed injection differs: {field}')
                for variant, factor, offset in [('truth', 1, 0), ('half-period', .5, 0),
                                                ('double-period', 2, 0), ('offset-probe', 1, .5)]:
                    submissions.append(dict(injection_id=r.injection_id, variant=variant,
                        reference_candidate_111=f"c-{truth['step'] + 1}",
                        selection=selection(r.period_days * factor, r.t0_btjd + offset * r.period_days,
                                            r.duration_hours, bundle['foldReferenceTimeBtjd'])))
            curves.append(dict(id=f"{manifest['run_id']}:{baseline_id}:{gid}", bundle=bundle,
                               bins=bins, candidates=candidates, submissions=submissions))
            if index % 20 == 0 or index == len(wanted):
                log(f"{params['target']}/{name}: {index}/{len(wanted)} observation windows", flush=True)
    if sum(len(c['submissions']) for c in curves) != 4 * len(evidence['measurements']):
        raise ValueError('reconstructed truth count mismatch')
    return curves


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, action='append', required=True)
    parser.add_argument('--output-root', type=Path, default=BENCH / 'results/matching-replay')
    args = parser.parse_args()
    sources = [preflight(p) for p in args.manifest]
    if len({m['run_id'] for m, _, _ in sources}) != len(sources):
        raise ValueError('duplicate run')
    paths = list(args.manifest)
    for m, _, inputs in sources:
        assert_snapshot(inputs)
        paths.extend(Path(r['path']) for r in inputs)
    for package in [BENCH / 'tess_bench', ROOT / 'experiments/tess-fixture/tess_fixture',
                    ROOT / 'libs/astro-kernel/astro_kernel']:
        paths.extend(package.rglob('*.py'))
    paths.extend([API / name for name in ['matching-replay.cjs', 'matching-v0.cjs', 'matching-rules.v0.json']])
    paths.extend([BENCH / 'uv.lock', BENCH / 'pyproject.toml'])
    plan = dict(schema='planetory.matching-replay-plan.v1', snapshots=snapshot(paths),
                source_runs=[e for _, e, _ in sources],
                packages={p: version(p) for p in ['numpy', 'scipy', 'astropy']},
                limitation='reconstructed fixture bins; not published Gold or full user matching accuracy')
    out = args.output_root / ('run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    write = lambda p, obj: p.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    write(out / 'plan.json', plan)
    started = time.perf_counter()
    try:
        for _, _, inputs in sources:
            assert_snapshot(inputs)
        curves = [c for m, e, _ in sources for c in build_run(m, e)]
        write(out / 'input.json', dict(schema='planetory.matching-replay-input.v1', curves=curves))
        subprocess.run(['node', str(API / 'matching-replay.cjs'), str(out / 'input.json'), str(out / 'result.json')], check=True)
        assert_snapshot(plan['snapshots'])
        write(out / 'manifest.json', dict(status='completed', plan_sha256=sha((out / 'plan.json').read_bytes()),
              curves=len(curves), submissions=sum(len(c['submissions']) for c in curves),
              wall_s=time.perf_counter() - started, outputs=snapshot([out / 'input.json', out / 'result.json'])))
        print(f"Completed: {out}")
    except Exception as exc:
        write(out / 'failure.json', dict(status='failed', error=type(exc).__name__, message=str(exc)))
        raise


if __name__ == '__main__':
    main()

"""109 fixed-sample kernel measurement. No external labels or publication claims."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4
import numpy as np

from astro_kernel.bls import QUALITY_VERSION, RUNNING_MEDIAN_QUALITY_VERSION, period_grid
from astro_kernel.iteration import iterate_bls
from astro_kernel.preprocessing import detrend_silver
from astro_kernel.segmentation import bin_sector
from astro_kernel.discoverability import evaluate, provided_arrays, RULE
from tess_fixture.lightcurve import load_sector, build_baseline
from tess_fixture.service_sample import load_sample_config
from .population import BENCH, FIXTURE, preflight


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def measure(path, snapshot, quality_version):
    return measure_sectors([path], snapshot, quality_version)


def measure_sectors(paths, snapshot, quality_version):
    base = build_baseline([load_sector(path) for path in paths])
    prepared = detrend_silver(base.time, base.flux, base.sector_of_point)
    if prepared.status != 'ok' or prepared.failures:
        return dict(status='held', reason='preprocessing_failed', n_accepted=None,
                    n_discoverable=None)
    iteration = iterate_bls(prepared.time, prepared.flux_det,
        sector=base.sector_of_point, baseline_time=prepared.time,
        input_snapshot_id=snapshot, preprocessing_version=prepared.version,
        quality_version=quality_version)
    if not iteration['complete']:
        return dict(status='held', reason=iteration['termination'], n_accepted=None,
                    n_discoverable=None, iteration=iteration)
    segments = []
    for sector in np.unique(base.sector_of_point):
        mask = base.sector_of_point == sector
        segment = bin_sector(prepared.time[mask], prepared.flux_det[mask])
        segments.append(dict(sector=int(sector), **segment.values()))
    time, flux, _ = provided_arrays(segments)
    accepted = iteration['accepted']
    periods = period_grid(0.5, max([40.] + [1.15*c['period_days'] for c in accepted]),
                          5000, spacing='log')
    evaluations = []
    for candidate in [None, *accepted]:
        previous = [c['transit_model'] for c in accepted
                    if candidate and c['step'] < candidate['step']]
        verdict, _, _ = evaluate(time, flux, previous,
            candidate['transit_model'] if candidate else None, periods)
        evaluations.append(dict(step=candidate['step'] if candidate else None, **verdict))
    complete = all(v['status'] == 'measured' for v in evaluations)
    return dict(status='measured' if complete else 'held', reason=None if complete else 'provided_measurement_failed',
        n_accepted=len(accepted), n_discoverable=sum(v['discoverable'] is True for v in evaluations[1:]) if complete else None,
        iteration=iteration, evaluations=evaluations,
        **({'segment': {k:v for k,v in segments[0].items() if k != 'sector'}}
           if len(segments) == 1 else {'segments': segments}),
        external_labels_verified=False, publishable=False)


def summarize(rows):
    summary = {}
    for group in sorted({r['group'] for r in rows}):
        selected = [r for r in rows if r['group'] == group]
        valid = [r for r in selected if r['status'] == 'measured']
        zero = sum(r['n_accepted'] == 0 for r in valid)
        visible = sum(r['n_discoverable'] > 0 for r in valid)
        summary[group] = dict(selected=len(selected), measured=len(valid), held=len(selected)-len(valid),
            zero_accepted=zero, zero_accepted_fraction=zero/len(valid) if valid else None,
            with_discoverable=visible, with_discoverable_fraction=visible/len(valid) if valid else None)
    return summary


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--limit', type=int)
    p.add_argument('--quality-version', choices=[QUALITY_VERSION, RUNNING_MEDIAN_QUALITY_VERSION], default=QUALITY_VERSION)
    a = p.parse_args()
    config = FIXTURE/'configs/service_sample_v1.json'
    checksums = FIXTURE/'service_sample_checksums.json'
    sample = load_sample_config(config)
    if a.limit is not None and not 1 <= a.limit <= len(sample.members): p.error('invalid limit')
    members = sample.members[:a.limit] if a.limit else sample.members
    if len({m.tic_id for m in members}) != len(members): p.error('one Sector per TIC required')
    inputs = preflight(sample, members, FIXTURE/'sample_service', checksums)
    paths = [Path(i['path']) for i in inputs] + [config, checksums, BENCH/'uv.lock']
    paths += list((BENCH/'tess_bench').glob('*.py'))
    paths += list((FIXTURE/'tess_fixture').glob('*.py'))
    paths += list((BENCH.parents[1]/'libs/astro-kernel/astro_kernel').rglob('*.py'))
    hashes = {str(f.resolve()):digest(f) for f in paths}
    out = BENCH/'results/population-kernel'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    def write(name, value):
        (out/name).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False)+'\n', encoding='utf-8')
    write('plan.json',dict(task='S15P21C206-109', quality_version=a.quality_version,
        provided_rule=RULE, inputs=hashes, subset=a.limit is not None,
        members=[dict(tic_id=m.tic_id,sector=m.sector,group=m.group) for m in members],
        external_labels_verified=False, publishable=False, interval_masks='none; no evidence supplied'))
    plan_hash = digest(out/'plan.json')
    print('Plan fixed:',out/'plan.json',flush=True)
    rows=[]
    try:
        for m in members:
            path=FIXTURE/'sample_service'/str(m.tic_id)/sample.filename(m)
            row=dict(tic_id=m.tic_id,sector=m.sector,group=m.group,
                     **measure(path,hashes[str(path.resolve())],a.quality_version))
            rows.append(row); write('stars.json',rows)
            print(m.tic_id,row['status'],row['n_accepted'],row['n_discoverable'],flush=True)
        assert digest(out/'plan.json') == plan_hash, 'plan changed'
        for name,h in hashes.items():
            if digest(Path(name)) != h: raise ValueError('input changed: '+name)
        write('summary.json',dict(groups=summarize(rows),service_supply_confirmed=False,
            limitation='Single Sector fixed sample; no identity reconciliation, external label or tutorial acceptance.'))
        write('manifest.json',dict(status='completed',outputs={n:digest(out/n) for n in ['plan.json','stars.json','summary.json']},publishable=False))
    except Exception as exc:
        write('failure.json',dict(status='failed',reason=type(exc).__name__))
        raise
    print('Completed:',out,flush=True)

if __name__ == '__main__': main()

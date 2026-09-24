"""Descriptive suitability audit of saved 109 arrays; no new BLS or acceptance thresholds."""
import json
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path
import numpy as np
from astro_kernel.discoverability import provided_arrays
from astro_kernel.transit_model import remove_transit_models
from .population_kernel import BENCH, digest
from .tutorial_review import CASES, saved_case


def window_stats(time, flux, candidate):
    p=candidate['period_days']; epoch=candidate['epoch_btjd']
    width=candidate['duration_hours']/48
    phase=(time-epoch+p/2)%p-p/2
    finite=np.isfinite(flux)
    primary=finite&(np.abs(phase)<width)
    secondary=finite&(np.abs(np.abs(phase)-p/2)<width)
    outside=finite&~primary&~secondary
    if not outside.any() or not primary.any():
        return dict(status='not_measurable')
    baseline=float(np.median(flux[outside]))
    scatter=float(1.4826*np.median(np.abs(flux[outside]-baseline)))
    def depth(mask):
        return float((baseline-np.median(flux[mask]))*1e6) if mask.any() else None
    cycles=np.rint((time-epoch)/p).astype(np.int64)
    return dict(status='measured',primary_points=int(primary.sum()),secondary_points=int(secondary.sum()),
                primary_depth_ppm=depth(primary),secondary_depth_ppm=depth(secondary),
                odd_depth_ppm=depth(primary&(cycles%2==1)),even_depth_ppm=depth(primary&(cycles%2==0)),
                outside_mad_ppm=scatter*1e6,
                limitation='Descriptive medians, not significance or EB classification; secondary window fixed at phase 0.5 may miss eccentric eclipses.')


def initial_peak_options(row, candidate):
    initial=next(v for v in row['evaluations'] if v['step'] is None)
    maxp=max([40.]+[1.15*c['period_days'] for c in row['iteration']['accepted']])
    cell=np.log(maxp/.5)/4999
    return [v for v in initial['qualified_peaks']
            if abs(np.log(v['period_days']/candidate['period_days']))/cell<=3]


def run():
    out=BENCH/'results/tutorial-suitability'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:8])
    out.mkdir(parents=True,exist_ok=False)
    rows=[]; hashes={}
    for role,_,run_id,tic,sectors,steps in CASES:
        folder=BENCH/'results/tutorial-screening'/run_id
        row=saved_case(folder,tic,sectors)
        for name in ['manifest.json','screening.json','plan.json']:
            hashes[str((folder/name).resolve())]=digest(folder/name)
        t,f,_=provided_arrays(row.get('segments') or [dict(sector=sectors[0],**row['segment'])])
        # Include the first L98-59 signal as an alternative to the step-2 candidate.
        for c in row['iteration']['accepted']:
            if c['step'] not in ([0,2] if role==2 else steps): continue
            previous=[a['transit_model'] for a in row['iteration']['accepted'] if a['step']<c['step']]
            residual=remove_transit_models(t,f,previous).flux_residual
            rows.append(dict(role=role,tic_id=tic,sectors=sectors,step=c['step'],period_days=c['period_days'],
                             source_run=run_id,prior_removals=len(previous),initial_peak_options=initial_peak_options(row,c),
                             initial=window_stats(t,f,c),after_prior_removals=window_stats(t,residual,c),
                             acceptance='not_automatically_decided'))
    for path,h in hashes.items():
        if digest(Path(path))!=h: raise ValueError('source changed')
    (out/'metrics.json').write_text(json.dumps(rows,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    (out/'manifest.json').write_text(json.dumps(dict(status='completed',publishable=False,source_hashes=hashes,
        code_hashes={str(p.resolve()):digest(p) for p in [Path(__file__),BENCH/'tess_bench/tutorial_review.py']},
        outputs={'metrics.json':digest(out/'metrics.json')},
        limitation='Saved 10-minute arrays only; no fresh search, diagnostic-kernel parity, frontend usability or label approval.'),indent=2)+'\n',encoding='utf-8')
    print(out)


if __name__=='__main__': run()

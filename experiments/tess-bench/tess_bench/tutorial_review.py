"""Review saved tutorial measurements; never run BLS or publish labels."""
import csv
import html
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
from astro_kernel.discoverability import provided_arrays
from astro_kernel.transit_model import remove_transit_models
from tess_fixture.lightcurve import load_sector, build_baseline
from .population_kernel import BENCH, FIXTURE, digest
from .external_matching import pair_metrics, RULE

CASES = [
    (1, 'Clear planet', 'run-20260923T135324Z-7c50fe29',149603524,[2],[0]),
    (2, 'Shallow planet', 'run-20260923T135324Z-7c50fe29',307210830,[2],[0]),
    (3, 'Nonplanet signal', 'run-20260923T143214Z-3ad74275',279569718,[3],[0]),
    (4, 'Deeper nonplanet signal', 'run-20260923T143214Z-3ad74275',300871545,[3],[0]),
    (5, 'Two nonplanet signals', 'run-20260923T141857Z-6c50ac38',278956474,[3],[0,1]),
]


def checked_json(path, expected=None):
    if expected is not None and digest(path) != expected:
        raise ValueError('checksum mismatch: '+str(path))
    return json.loads(path.read_text(encoding='utf-8'))


def saved_case(folder, tic, sectors):
    manifest=checked_json(folder/'manifest.json')
    if manifest['status']!='completed': raise ValueError('incomplete run')
    for name, expected in manifest['outputs'].items():
        if Path(name).name!=name: raise ValueError('unsafe output name')
        checked_json(folder/name,expected)
    rows=checked_json(folder/'screening.json')
    matches=[r for r in rows if r['tic_id']==tic and r.get('sectors',[r.get('sector')])==sectors]
    if len(matches)!=1 or matches[0]['status']!='measured': raise ValueError('unique measured case required')
    return matches[0]


def folded_svg(time, flux, candidate, title, full_orbit=False):
    p=candidate['period_days']; duration=candidate['duration_hours']
    phase=((time-candidate['epoch_btjd']+p/2)%p-p/2)*24
    limit=p*12 if full_orbit else min(p*12,2*duration)
    mask=np.isfinite(flux)&(np.abs(phase)<=limit)
    x=phase[mask]; y=(flux[mask]-1)*1e6
    if not len(x): raise ValueError('empty fold')
    lo=min(float(y.min()),-candidate['depth_ppm'])*1.05
    hi=max(float(y.max()),100.)*1.05
    # Preserve all finite points; no connecting lines, smoothing or interpolation.
    px=lambda v: 65+(v+limit)/(2*limit)*680
    py=lambda v: 255-(v-lo)/(hi-lo)*195
    svg=['<svg xmlns="http://www.w3.org/2000/svg" width="800" height="310" viewBox="0 0 800 310">',
         '<rect width="800" height="310" fill="white"/>',
         f'<text x="20" y="23" font-size="16">{html.escape(title)}</text>',
         f'<text x="20" y="44" font-size="12">10-minute mean; {len(x)} points; P={p:.7f} d; depth={candidate["depth_ppm"]:.0f} ppm</text>']
    for value in np.linspace(lo,hi,5):
        svg.append(f'<path d="M65 {py(value):.2f}H745" stroke="#ddd"/><text x="2" y="{py(value):.2f}" font-size="10">{value:.0f}</text>')
    svg.append(f'<path d="M65 {py(0):.2f}H745" stroke="#444"/>')
    for value in [-duration/2,duration/2]:
        svg.append(f'<path d="M{px(value):.2f} 60V255" stroke="#a34a1c" stroke-dasharray="4 4"/>')
    for a,b in zip(x,y): svg.append(f'<circle cx="{px(a):.2f}" cy="{py(b):.2f}" r="1.6" fill="#2464a0" opacity=".6"/>')
    svg.append(f'<text x="65" y="279" font-size="12">{-limit:.2f} h</text><text x="720" y="279" font-size="12">{limit:.2f} h</text>')
    svg.append('<text x="210" y="301" font-size="12">Phase hours; dashed lines = fitted window, not external truth</text></svg>')
    return '\n'.join(svg)


def run():
    out=BENCH/'results/tutorial-review'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:8])
    out.mkdir(parents=True,exist_ok=False)
    archive_folder=FIXTURE/'results/external-catalog/run-20260922T075631Z-46337bcc'
    archive_manifest=checked_json(archive_folder/'manifest.json')
    record=archive_manifest['sources']['nea_pscomppars']
    archive_file=archive_folder/record['file']
    if digest(archive_file)!=record['sha256']: raise ValueError('Archive checksum mismatch')
    with archive_file.open(encoding='utf-8',newline='') as f: archive=list(csv.DictReader(f))
    source_hashes={str(archive_file.resolve()):digest(archive_file),str((archive_folder/'manifest.json').resolve()):digest(archive_folder/'manifest.json')}
    report=[]; body=['<h1>109 tutorial review — provisional</h1><p>Saved results only. No BLS rerun. No publication approval. Folded plots cannot establish chronological gap readability.</p>']
    for role,title,run_id,tic,sectors,steps in CASES:
        folder=BENCH/'results/tutorial-screening'/run_id
        row=saved_case(folder,tic,sectors)
        for name in ['manifest.json','plan.json','screening.json','inputs.json']:
            source_hashes[str((folder/name).resolve())]=digest(folder/name)
        files={r['path']:r for r in checked_json(folder/'inputs.json') if r['tic_id']==tic and r['sector'] in sectors}
        if len(files)!=len(sectors): raise ValueError('input sector coverage mismatch')
        for name,r in files.items():
            if digest(Path(name))!=r['sha256']: raise ValueError('raw input changed')
            source_hashes[name]=r['sha256']
        observed=build_baseline([load_sector(Path(name)) for name in files]).time
        segments=row.get('segments') or [dict(sector=sectors[0],**row['segment'])]
        time,flux,_=provided_arrays(segments)
        body.append(f'<h2>{role}. {title} — TIC {tic}, S{sectors}</h2>')
        item=dict(role=role,tic_id=tic,sectors=sectors,source_run=run_id,publishable=False,steps=[])
        accepted=row['iteration']['accepted']
        for step in steps:
            candidates=[c for c in accepted if c['step']==step]
            if len(candidates)!=1: raise ValueError('missing accepted step')
            c=candidates[0]
            verdicts=[v for v in row['evaluations'] if v['step']==step]
            if len(verdicts)!=1 or verdicts[0]['discoverable'] is not True: raise ValueError('not discoverable')
            previous=[v['transit_model'] for v in accepted if v['step']<step]
            residual=remove_transit_models(time,flux,previous).flux_residual
            checks=[]
            for ext in archive:
                if ext['tic_id']!=f'TIC {tic}' or ext['tran_flag']!='1': continue
                if ext['pl_tranmid_systemref']!='BJD-TDB':
                    checks.append(dict(name=ext['pl_name'],status='unverified_time_standard'))
                    continue
                other=dict(period_days=float(ext['pl_orbper']),epoch_btjd=float(ext['pl_tranmid'])-2457000,duration_hours=float(ext['pl_trandur']))
                metrics=pair_metrics(c,other,observed)
                direct=(metrics['identity_distance']<=RULE['identity_tolerance'] and metrics['duration_ratio']<=RULE['duration_ratio_max'] and metrics['shared_points']>=RULE['min_shared_points'] and metrics['observed_jaccard'] is not None and metrics['observed_jaccard']>=RULE['observed_jaccard_min'])
                checks.append(dict(name=ext['pl_name'],status='pairwise_direct' if direct else 'not_direct',**metrics))
            detail=dict(step=step,period_days=c['period_days'],depth_ppm=c['depth_ppm'],prior_removals=len(previous),discoverable=True,external_checks=checks or [dict(status='external_time_or_ephemeris_unverified')],qualified_peaks=verdicts[0]['qualified_peaks'])
            item['steps'].append(detail)
            body.append(f'<p>Step {step}; requires {len(previous)} prior removals. External: {html.escape(json.dumps(detail["external_checks"]))}</p>')
            for label,values in [('initial',flux),('after_prior_removals',residual)]:
                name=f'role{role}-step{step}-{label}.svg'
                (out/name).write_text(folded_svg(time,values,c,f'{title}: {label}'),encoding='utf-8')
                body.append(f'<img src="{name}" alt="{label}" style="max-width:100%">')
            name=f'role{role}-step{step}-full_orbit.svg'
            (out/name).write_text(folded_svg(time,residual,c,f'{title}: full orbit after prior removals',full_orbit=True),encoding='utf-8')
            body.append(f'<img src="{name}" alt="full orbit" style="max-width:100%">')
            body.append('<details><summary>Saved qualified peaks (not a full power spectrum)</summary><pre>'+html.escape(json.dumps(detail['qualified_peaks'],indent=2))+'</pre></details>')
        report.append(item)
    (out/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    (out/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>109 tutorial review</title><style>body{font:16px sans-serif;max-width:1000px;margin:30px auto}pre{white-space:pre-wrap}p{overflow-wrap:anywhere}</style>'+''.join(body),encoding='utf-8')
    for name,h in source_hashes.items():
        if digest(Path(name))!=h: raise ValueError('source changed during review')
    manifest=dict(status='completed',publishable=False,source_hashes=source_hashes,review_code_sha256=digest(Path(__file__)),limitation='Historical source-code hashes are preserved in input plans; not compared with current code. Pairwise checks do not approve operational snapshot or roles.',outputs={p.name:digest(p) for p in out.iterdir() if p.is_file()})
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(out)


if __name__=='__main__': run()

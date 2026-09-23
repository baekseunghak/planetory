"""Saved-data label evidence and secondary-eclipse review; never publish labels."""
import csv
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime, timezone
from uuid import uuid4
import numpy as np
from astro_kernel.discoverability import provided_arrays
from tess_fixture.lightcurve import load_sector, build_baseline
from .population_kernel import BENCH, FIXTURE, digest
from .tutorial_review import CASES, checked_json, saved_case, folded_svg
from .external_matching import pair_metrics, RULE

# Demangeon et al. 2021, Table 3 pp.36-37: all three quantities from one solution.
L98 = dict(period_days=3.6906777, epoch_btjd=1367.27375, duration_hours=1.346,
           time_system='BTJD-TDB', name='L 98-59 c',
           source='https://www.eso.org/public/archives/releases/sciencepapers/eso2112/eso2112a.pdf',
           locator='Table 3, PDF pages 36-37')


def link(candidate, reference, times):
    if reference.get('time_system') != 'BTJD-TDB':
        return dict(status='hold', reason='unverified_time_standard')
    m=pair_metrics(candidate, reference, times)
    passed=(m['identity_distance']<=RULE['identity_tolerance'] and
            m['duration_ratio']<=RULE['duration_ratio_max'] and
            m['shared_points']>=RULE['min_shared_points'] and
            m['observed_jaccard'] is not None and
            m['observed_jaccard']>=RULE['observed_jaccard_min'])
    return dict(status='pairwise_direct' if passed else 'not_direct', **m)


def secondary_cycles(time, flux, candidate):
    """Fixed half-period window with adjacent baseline; no optimized epoch/window."""
    p=candidate['period_days']; center=candidate['epoch_btjd']+p/2
    half=candidate['duration_hours']/48
    cycles=np.rint((time-center)/p).astype(int)
    delta=time-(center+cycles*p)
    rows=[]
    for k in np.unique(cycles):
        finite=np.isfinite(flux)&(cycles==k)
        inside=finite&(np.abs(delta)<half)
        outside=finite&(np.abs(delta)>=2*half)&(np.abs(delta)<4*half)
        n=int(inside.sum()); b=int(outside.sum())
        depth=float((np.median(flux[outside])-np.median(flux[inside]))*1e6) if n and b else None
        rows.append(dict(cycle=int(k),inside_points=n,baseline_points=b,depth_ppm=depth))
    return rows


def diagnostic_link(candidate, reference, times):
    """Keep unknown time as a hold even when conditional arithmetic agrees."""
    result=link(candidate,reference,times)
    return dict(formal=result,conditional_metrics=pair_metrics(candidate,reference,times),
                assumption='Conditional metrics assume a common time scale; they do not resolve it.')


def dv_reference(path, tic, planet_number, fit='allTransitsFit'):
    ns={'d':'http://www.nasa.gov/2018/TESS/DV'}
    root=ET.parse(path).getroot()
    if root.get('ticId')!=str(tic) or root.get('simData')!='false': raise ValueError('wrong DV target')
    nodes=[p for p in root.findall('d:planetResults',ns) if p.get('planetNumber')==str(planet_number)]
    if len(nodes)!=1: raise ValueError('unique DV planet required')
    node=nodes[0].find('d:'+fit,ns)
    if node is None or node.get('fullConvergence')!='true': raise ValueError('unconverged DV fit')
    values={p.get('name'):float(p.get('value')) for p in node.findall('d:modelParameters/d:modelParameter',ns)}
    result=dict(period_days=values['orbitalPeriodDays'],epoch_btjd=values['transitEpochBtjd'],
        duration_hours=values['transitDurationHours'],time_system='BTJD-TDB',
        source='mast:TESS/product/'+path.name,fit=fit,planet_number=planet_number,
        time_document='https://ntrs.nasa.gov/api/citations/20205008729/downloads/EXP-TESS-ARC-ICD-TM-0014-Rev-F_v2.pdf')
    if not all(np.isfinite(result[k]) for k in ('period_days','epoch_btjd','duration_hours')) or min(result['period_days'],result['duration_hours'])<=0:
        raise ValueError('invalid DV parameters')
    return result


def run():
    out=BENCH/'results/tutorial-labels'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:8])
    out.mkdir(parents=True,exist_ok=False)
    hashes={}; reports=[]
    def track(path):
        hashes[str(path.resolve())]=digest(path)
    source=FIXTURE/'results/external-catalog/run-20260922T075631Z-46337bcc'
    manifest=checked_json(source/'manifest.json'); track(source/'manifest.json')
    raw=source/manifest['sources']['exofop_toi']['file']
    if digest(raw)!=manifest['sources']['exofop_toi']['sha256']: raise ValueError('ExoFOP checksum mismatch')
    track(raw)
    with raw.open(encoding='utf-8',newline='') as f: labels=list(csv.DictReader(f))
    tce_folder=FIXTURE/'results/external-catalog/run-20260922T075142Z-85fe81f7'
    tm=checked_json(tce_folder/'manifest.json'); track(tce_folder/'manifest.json')
    tce_file=tce_folder/tm['sources']['mast_tce_s1_s13']['file']
    if digest(tce_file)!=tm['sources']['mast_tce_s1_s13']['sha256']: raise ValueError('TCE checksum mismatch')
    track(tce_file)
    with tce_file.open(encoding='utf-8',newline='') as f:
        tces=list(csv.DictReader(line for line in f if not line.startswith('#')))
    eb_file=BENCH/'results/tutorial-catalogs/tess-ebs-v1.0.csv'
    if digest(eb_file)!='97e81f6c01716a431379ab6bd37d1182b611a485107110e0eba830f817ba7a8f': raise ValueError('EB checksum mismatch')
    track(eb_file)
    with eb_file.open(encoding='utf-8',newline='') as f: eb=list(csv.DictReader(f))
    dv_paths={}
    for tic,expected in [(279569718,'b06d571056ddc1c2d7c574cbabcbd5e4376f56752053a3842efab6f298ed3198'),
                         (278956474,'c3d97b748729f8ba7368bcf45947164732c36c3d033e7e6ddd1a1d2e2a7fa771')]:
        path=BENCH/'results/tutorial-catalogs'/f'tess2018206190142-s0001-s0013-{tic:016d}-00226_dvr.xml'
        if digest(path)!=expected: raise ValueError('DV XML checksum mismatch')
        track(path); dv_paths[tic]=path
        for suffix in ('observations','products'): track(BENCH/'results/tutorial-catalogs'/f'{tic}-{suffix}.json')
    alerts=BENCH/'results/tutorial-catalogs/alerts-v9.csv'
    dvs=BENCH/'results/tutorial-catalogs/toi184-dvs.pdf'
    for path,expected in [(alerts,'753318841c12f02dbeefe4bc6f2912af980e566248e55d549273b57d224add7e'),
                          (dvs,'03dc81063a42218ec7e8ed3476179b882dd4257ee8962a5515b480472cb0160c')]:
        if digest(path)!=expected: raise ValueError('SPOC reference checksum mismatch')
        track(path)
    with alerts.open(encoding='utf-8',newline='') as f:
        spoc=[r for r in csv.DictReader(f) if r['#tic_id']=='300871545' and r['toi_id']=='184.01']
    if len(spoc)!=1: raise ValueError('unique SPOC reference required')
    for role,_,run_id,tic,sectors,steps in CASES:
        if role not in (2,3,4,5): continue
        folder=BENCH/'results/tutorial-screening'/run_id
        row=saved_case(folder,tic,sectors)
        for name in ('manifest.json','plan.json','inputs.json','screening.json'): track(folder/name)
        files=list({r['path']:r for r in checked_json(folder/'inputs.json') if r['tic_id']==tic and r['sector'] in sectors}.values())
        if sorted(r['sector'] for r in files)!=sorted(sectors): raise ValueError('input coverage mismatch')
        for r in files:
            path=Path(r['path'])
            if digest(path)!=r['sha256']: raise ValueError('FITS checksum mismatch')
            track(path)
        times=build_baseline([load_sector(Path(r['path'])) for r in files]).time
        candidate=next(c for c in row['iteration']['accepted'] if c['step']==0)
        refs=[{k:r[k] for k in ('TIC ID','TOI','TESS Disposition','TFOPWG Disposition','Epoch (BJD)','Period (days)','Duration (hours)','Comments')}
              for r in labels if r['TIC ID']==str(tic)]
        item=dict(role=role,tic_id=tic,external_rows=refs,publishable=False)
        if role==2:
            item.update(reference=L98,connection=link(candidate,L98,times))
        elif role==4:
            a=spoc[0]
            reference=dict(period_days=float(a['Period']),epoch_btjd=float(a['Epoc']),duration_hours=float(a['Duration']),
                time_system='BTJD-TDB',source='https://stdatu.stsci.edu/prepds/tess-data-alerts/index.html',
                time_basis='SPOC product convention; DVS explicitly identifies epoch as BTJD; NASA SDPDD transitEpochBtjd unit is BTJD (TDB)',
                time_document='https://ntrs.nasa.gov/api/citations/20205008729/downloads/EXP-TESS-ARC-ICD-TM-0014-Rev-F_v2.pdf')
            item.update(reference=reference,connection=link(candidate,reference,times),
                label_link=dict(status='manual_evidence_chain',key='TIC 300871545 / TOI 184.01',
                    historical_label=a['Disposition'],current_label=refs[0]['TFOPWG Disposition'],
                    limitation='Historical SPOC ephemeris and current ExoFOP label are separate records; current ExoFOP BJD epoch remains unverified. Not an approved 124 snapshot.'))
            t,f,_=provided_arrays(row.get('segments') or [dict(sector=sectors[0],**row['segment'])])
            item['secondary_cycles']=secondary_cycles(t,f,candidate)
            secondary=dict(candidate,epoch_btjd=candidate['epoch_btjd']+candidate['period_days']/2,depth_ppm=860.)
            (out/'role4-secondary.svg').write_text(folded_svg(t,f,secondary,'Role 4: secondary zoom; fixed P/2, not a fitted secondary'),encoding='utf-8')
        else:
            external=[]
            for a in tces:
                if a['ticid']!=str(tic): continue
                # Offset redundancy verifies units only, not the underlying clock scale.
                if not np.isclose(float(a['tce_time0'])-float(a['tce_time0bt']),2457000.,rtol=0,atol=1e-6):
                    raise ValueError('TCE epoch offset mismatch')
                external.append(dict(external_id=a['tceid'],period_days=float(a['tce_period']),
                    epoch_btjd=float(a['tce_time0bt']),duration_hours=float(a['tce_duration']),
                    time_system='unverified',source=tm['sources']['mast_tce_s1_s13']['requested_url']))
            item['eb_catalog_rows']=[r for r in eb if r['tess_id']==str(tic)]
            item['tce_checks']=[dict(step=c['step'],reference=a,**diagnostic_link(c,a,times))
                for c in row['iteration']['accepted'] if c['step'] in steps for a in external]
            if role==5:
                # Figure 3 ephemerides; Table 2 durations. Distinct fits, explicitly not one solution.
                literature=[dict(name='A',period_days=5.488,epoch_btjd=1327.9619,duration_hours=5.43),
                            dict(name='B',period_days=5.67435,epoch_btjd=1330.6875,duration_hours=3.34)]
                for a in literature:
                    a.update(time_system='unverified',source='https://arxiv.org/pdf/2006.08979',
                        locator='Figure 3 ephemerides, Table 2 duration; mixed fits for diagnostic comparison only')
                item['literature_checks']=[dict(step=c['step'],reference=a,**diagnostic_link(c,a,times))
                    for c in row['iteration']['accepted'] if c['step'] in steps for a in literature]
                item['label_evidence']='Rowden et al. identifies two eclipsing binaries A and B. TCE B is half-period; no automatic harmonic approval.'
            else:
                item['label_evidence']='TESS-EBs catalog membership; no ExoFOP row is not evidence for none or planet.'
            item['connection']=dict(status='hold',reason='Time-scale provenance for these exact external ephemerides is not verified; conditional comparisons are not formal direct matches')
            # New evidence supersedes the earlier conditional CSV comparison, retained above for audit.
            primary=dv_reference(dv_paths[tic],tic,1)
            item['dv_primary']=dict(reference=primary,connection=link(candidate,primary,times))
            item['connection']=dict(item['dv_primary']['connection'])
            if role==5:
                b=dv_reference(dv_paths[tic],tic,2,'evenTransitsFit')
                derived=dict(b,period_days=2*b['period_days'],derivation='2 * evenTransitsFit orbitalPeriodDays; epoch and duration unchanged',
                    authorization_scope='Tutorial evidence for TIC 278956474 B only, not automatic alias resolution',
                    physical_period_basis='Rowden 2020 section 2.1 and Table 2 identify B as a half-period SPOC detection')
                second=next(c for c in row['iteration']['accepted'] if c['step']==1)
                item['dv_b_manual']=dict(reference=derived,original_reference=b,numerical_check=link(second,derived,times),
                    status='manual_harmonic_evidence',publishable=False)
                item['connection']=dict(status='manual_evidence_chain',
                    reason='A uses direct DV model; B requires documented target-specific physical-period interpretation. Not generic direct-match approval.')
        reports.append(item)
    for path,h in hashes.items():
        if digest(Path(path))!=h: raise ValueError('source changed')
    (out/'report.json').write_text(json.dumps(reports,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    outputs={p.name:digest(p) for p in out.iterdir() if p.is_file()}
    (out/'manifest.json').write_text(json.dumps(dict(status='completed',publishable=False,source_hashes=hashes,
        reference=L98,code_sha256=digest(Path(__file__)),outputs=outputs,
        limitation='Literature values manually transcribed. Pairwise numerical evidence is not snapshot approval or frontend usability validation.'),indent=2)+'\n',encoding='utf-8')
    print(out)


if __name__=='__main__': run()

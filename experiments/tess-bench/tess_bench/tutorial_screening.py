"""109 tutorial screening; raw data acquisition and experiment are explicit CLI actions."""
import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4
from tess_fixture.targets import TARGETS, product_filename, product_url, MAST_DOWNLOAD_BASE
from tess_fixture.download import download_product, validate_product
from .population_kernel import measure, measure_sectors, digest, BENCH, FIXTURE
from astro_kernel.bls import QUALITY_VERSION

EXTRA = [(311183180,5),(143022742,4)]
EB_CATALOG_SHA256 = '97e81f6c01716a431379ab6bd37d1182b611a485107110e0eba830f817ba7a8f'
EB_TICS = [30313682,272357134,279569718,350480660,300871545,287328866]


def eb_catalog_path():
    return BENCH/'results/tutorial-catalogs/tess-ebs-v1.0.csv'


def eb_selections():
    path=eb_catalog_path()
    if digest(path) != EB_CATALOG_SHA256:
        raise ValueError('EB catalog snapshot mismatch')
    with path.open(encoding='utf-8',newline='') as stream:
        rows=list(csv.DictReader(stream))
    selected=[]
    for tic in EB_TICS:
        matches=[r for r in rows if r['tess_id']==str(tic) and r['signal_id']=='1']
        if len(matches)!=1 or '3' not in matches[0]['sectors'].split(','):
            raise ValueError('EB catalog selection mismatch')
        selected.append(dict(key=str(tic),tic_id=tic,sectors=[3],kind='eb_catalog_screening',
                             catalog_row=matches[0],catalog_sha256=EB_CATALOG_SHA256,
                             reference_use='selection only; epoch time scale unverified',
                             outside_initial_collection=False))
    return selected
# Exact products read from the official Sector 31 LC list on 2026-09-23.
SECTOR31_LIST = 'https://archive.stsci.edu/missions/tess/download_scripts/sector/tesscurl_sector_31_lc.sh'
SECTOR31_PRODUCTS = {
    311183180: 'tess2020294194027-s0031-0000000311183180-0198-s_lc.fits',
    143022742: 'tess2020294194027-s0031-0000000143022742-0198-s_lc.fits',
}


def combined_selections():
    return [dict(key=t.key, tic_id=t.tic_id, sectors=list(t.sectors),
                 kind='combined_fixture') for t in TARGETS if len(t.sectors) > 1] + [
        dict(key=str(t), tic_id=t, sectors=[s,31], kind='multiple_fp_combined',
             outside_initial_collection=True, product_list=SECTOR31_LIST) for t,s in EXTRA]


def literature_selections():
    """A documented double EB, not an automatically approved FP mapping."""
    return [dict(key='278956474', tic_id=278956474, sectors=sectors,
                 kind='literature_double_eb',
                 source='https://arxiv.org/abs/2006.08979v1',
                 reference_periods_days=[5.488,5.674],
                 reference_use='target selection only; no verified epoch/duration mapping',
                 outside_initial_collection=False)
            for sectors in ([3],[4],[5],[3,4,5])]


def product(tic, sector):
    if sector == 31:
        name = SECTOR31_PRODUCTS[tic]
        return name, MAST_DOWNLOAD_BASE + name
    return product_filename(tic,sector), product_url(tic,sector)


def obtain(item, sector, fetch):
    name, uri = product(item['tic_id'], sector)
    existing = FIXTURE/'sample_raw'/item['key']/name
    path = existing if existing.is_file() else BENCH/'results/tutorial-inputs'/item['key']/name
    if not path.is_file() and not fetch:
        raise FileNotFoundError('Input missing; rerun with --download: '+str(path))
    if not path.is_file():
        download_product(uri,path,item['tic_id'],sector)
    validate_product(path,item['tic_id'],sector)
    return dict(path=str(path.resolve()),sha256=digest(path),tic_id=item['tic_id'],
                sector=sector,source_uri=uri)

def selections():
    return [dict(key=t.key,tic_id=t.tic_id,sector=s,kind='existing_fixture') for t in TARGETS for s in t.sectors] + [dict(key=str(t),tic_id=t,sector=s,kind='multiple_fp_screening') for t,s in EXTRA]

def run(fetch=False, combined=False, literature=False, eb_catalog=False):
    combined = combined or literature or eb_catalog
    targets = eb_selections() if eb_catalog else literature_selections() if literature else combined_selections() if combined else selections()
    out=BENCH/'results/tutorial-screening'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex[:8])
    out.mkdir(parents=True,exist_ok=False)
    def write(n,v): (out/n).write_text(json.dumps(v,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    code=[Path(__file__),BENCH/'tess_bench/population_kernel.py',BENCH/'uv.lock']
    code+=list((FIXTURE/'tess_fixture').rglob('*.py'))
    code+=list((BENCH.parents[1]/'libs/astro-kernel/astro_kernel').rglob('*.py'))
    if eb_catalog: code.append(eb_catalog_path())
    hashes={str(p.resolve()):digest(p) for p in code}
    plan=dict(task='S15P21C206-109',purpose='screening only; not tutorial approval',quality_version=QUALITY_VERSION,targets=targets,code_hashes=hashes,publishable=False,combined=combined)
    write('plan.json',plan); plan_hash=digest(out/'plan.json')
    print('Plan fixed:',out/'plan.json',flush=True)
    rows=[]; inputs=[]
    try:
        for item in plan['targets']:
            records=[obtain(item,s,fetch) for s in (item['sectors'] if combined else [item['sector']])]
            inputs.extend(records); write('inputs.json',inputs)
            if combined:
                import hashlib
                snapshot=hashlib.sha256(json.dumps(records,sort_keys=True).encode()).hexdigest()
                result=measure_sectors([Path(r['path']) for r in records],snapshot,QUALITY_VERSION)
            else:
                result=measure(Path(records[0]['path']),records[0]['sha256'],QUALITY_VERSION)
            rows.append(dict(**item,**result)); write('screening.json',rows)
            print(item['key'],item.get('sectors',item.get('sector')),result['status'],result['n_accepted'],result['n_discoverable'],flush=True)
        for p,h in hashes.items():
            if digest(Path(p))!=h: raise ValueError('code changed during run')
        for r in inputs:
            if digest(Path(r['path']))!=r['sha256']: raise ValueError('input changed during run')
        if digest(out/'plan.json')!=plan_hash:raise ValueError('plan changed')
        write('manifest.json',dict(status='completed',publishable=False,outputs={n:digest(out/n) for n in ['plan.json','inputs.json','screening.json']},limitation='Screening only; no external ephemeris matching, distinct FP proof or tutorial acceptance. Missing products fail visibly.'))
    except Exception as exc:
        write('failure.json',dict(status='failed',reason=type(exc).__name__,completed_products=len(rows)))
        raise
    print('Completed:',out,flush=True)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--download',action='store_true')
    mode=p.add_mutually_exclusive_group()
    mode.add_argument('--combined',action='store_true',help='Combine observed Sectors; bin separately without filling inter-Sector gaps')
    mode.add_argument('--literature',action='store_true',help='Screen documented double EB TIC 278956474 in S3/S4/S5 and combined')
    mode.add_argument('--eb-catalog',action='store_true',help='Screen six S3 EB targets from the pinned MAST catalog snapshot')
    a=p.parse_args();run(a.download,a.combined,a.literature,a.eb_catalog)

if __name__=='__main__': main()

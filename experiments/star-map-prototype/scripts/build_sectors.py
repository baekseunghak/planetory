"""Generate representative TESS CCD boundaries from the pinned archival WCS."""
import argparse
import json, urllib.request, zipfile, io, bz2, hashlib
from pathlib import Path
import numpy as np
from astropy.wcs import WCS, Sip

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data', type=Path, default=Path(__file__).resolve().parents[1]/'shared/data.js')
parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parents[1]/'shared')
args=parser.parse_args()
out=args.output_dir
out.mkdir(parents=True, exist_ok=True)
meta=json.load(urllib.request.urlopen('https://pypi.org/pypi/tesswcs/1.9.0/json'))
release=next(x for x in meta['urls'] if x['filename'].endswith('.whl'))
payload=urllib.request.urlopen(release['url']).read()
expected='12cba259a2a16177e3447b8b0e78cd0f5815c36a9090f1cd8540ab04242193c1'
if hashlib.sha256(payload).hexdigest()!=expected or release['digests']['sha256']!=expected:
    raise ValueError('tesswcs wheel checksum mismatch')
archive=zipfile.ZipFile(io.BytesIO(payload))
db=json.loads(bz2.decompress(archive.read('tesswcs/data/TESS_wcs_data.json.bz2')))
license_file=next(x for x in archive.namelist() if x.endswith('/LICENSE'))
(out/'tesswcs-LICENSE.txt').write_bytes(archive.read(license_file))
stars=json.loads(args.data.read_text(encoding='utf-8').split('=',1)[1].strip().rstrip(';'))
result=[]; checks=[]
for sector in [2,3,4,5,8,16]:
    row=db[str(sector)]
    entry={'sector':sector,'ra':row['ra'],'dec':row['dec'],'roll':row['roll'],'ccds':[]}
    for camera in range(1,5):
        for ccd in range(1,5):
            raw=row[str(camera)][str(ccd)]
            w=WCS(naxis=2)
            w.wcs.ctype=['RA---TAN-SIP','DEC--TAN-SIP']; w.wcs.cunit=['deg','deg']; w.wcs.radesys='ICRS'
            w.wcs.crpix=raw['crpix0']; w.wcs.crval=raw['crval0']; w.wcs.cdelt=[1,1]; w.wcs.pc=raw['cd']
            w.sip=Sip(*[np.asarray(raw['sip_'+s]) for s in ['a','b','ap','bp']], raw['crpix0'])
            # Science imaging area: FITS one-based columns 45..2092, rows 1..2048.
            # Sample pixel boundaries, not overscan, at 32 points per CCD edge.
            x0,x1,y0,y1=44.5,2092.5,.5,2048.5
            t=np.linspace(0,1,32,endpoint=False)
            pix=np.concatenate([np.column_stack((x0+(x1-x0)*t,np.full_like(t,y0))),np.column_stack((np.full_like(t,x1),y0+(y1-y0)*t)),np.column_stack((x1-(x1-x0)*t,np.full_like(t,y1))),np.column_stack((np.full_like(t,x0),y1-(y1-y0)*t))])
            world=w.all_pix2world(pix,1)
            center=w.all_pix2world([[(x0+x1)/2,(y0+y1)/2]],1)[0]
            entry['ccds'].append({'camera':camera,'ccd':ccd,'center':np.round(center,7).tolist(),'boundary':np.round(world,7).tolist()})
            for star in stars:
                obs=next((o for o in star['observations'] if o['sector']==sector and o['camera']==camera and o['ccd']==ccd),None)
                if obs:
                    pixel=w.all_world2pix([[star['ra'],star['dec']]],1)[0]
                    assert x0<=pixel[0]<=x1 and y0<=pixel[1]<=y1, (star['tic'],sector,pixel)
                    checks.append({'tic':star['tic'],'sector':sector,'camera':camera,'ccd':ccd,'pixel':pixel.tolist(),'inside':True})
    result.append(entry)
(out/'sectors.js').write_text('window.PLANETORY_SECTORS='+json.dumps(result,separators=(',',':'))+';\n',encoding='utf-8')
(out/'sector-validation.json').write_text(json.dumps({'source':'tesswcs 1.9.0 archival WCS database','wheel_sha256':hashlib.sha256(payload).hexdigest(),'checks':checks},indent=2),encoding='utf-8')
print('Generated',len(result),'sectors /',sum(len(x['ccds']) for x in result),'CCDs; verified',len(checks),'observations.')

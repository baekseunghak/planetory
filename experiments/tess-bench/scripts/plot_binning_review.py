"""114 review figures from saved outputs only; no preprocessing or experiment rerun."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import zipfile

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, out = args.source, args.output
    manifest_path = source / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    expected = {Path(e['path']).name: e['sha256'] for e in manifest['outputs']}
    names = ['l98_59-s2-10m-mean.npz', 'segments.csv', 'metrics.csv']
    for name in names:
        if sha(source / name) != expected[name]:
            raise ValueError('Source checksum mismatch: ' + name)
    def read(name):
        with (source / name).open(encoding='utf-8', newline='') as fh:
            return list(csv.DictReader(fh))
    def selected(row):
        return row['target'] == 'l98_59' and row['sector'] == '2' and float(row['requested_minutes']) == 10 and row['reducer'] == 'mean'
    segment, = [r for r in read('segments.csv') if selected(r)]
    case, = [r for r in read('metrics.csv') if selected(r) and r['kind'] == 'reference' and r['case'] == 'L 98-59 d']
    period, epoch, duration = [float(case[k]) for k in ('period_days', 'epoch_btjd', 'duration_hours')]
    with np.load(source / names[0], allow_pickle=False) as z:
        t, f, bt, bf = [z[k].copy() for k in ('raw_time', 'raw_flux', 'bin_center', 'flux')]
    gaps = json.loads(segment['gaps'])
    gap_indices = {i for a, b in gaps for i in range(a, b+1)}
    if gap_indices != set(np.flatnonzero(~np.isfinite(bf))):
        raise ValueError('Gap/NaN mismatch')
    halfbin = float(segment['actual_minutes']) / 2880
    centers = epoch + np.arange(np.ceil((bt[0]-epoch)/period), np.floor((bt[-1]-epoch)/period)+1) * period
    # Closest observed transit to the reference epoch; do not select by visual depth.
    observed = [c for c in centers if np.any(np.isfinite(bf) & (abs(bt-c) < duration/48))]
    if not observed:
        raise ValueError('No observed reference transit')
    center = min(observed, key=lambda c: abs(c-epoch))
    out.mkdir(parents=True, exist_ok=False)
    outputs = []
    for title, filename, limits in [
        ('Full Sector 2 time series', 'l98_59-s2-10m-mean-timeseries', (bt[0]-halfbin, bt[-1]+halfbin)),
        ('Observed transit detail', 'l98_59-s2-10m-mean-transit-detail', (center-.12, center+.12)),
    ]:
        fig, ax = plt.subplots(figsize=(12, 4.8), layout='constrained')
        for times, flux, color, label, size in [(t,f,'#7b8794','Preprocessed observations',7),(bt,bf,'#c64616','10 min mean',16)]:
            mask = np.isfinite(flux) & (times >= limits[0]) & (times <= limits[1])
            ax.scatter(times[mask], (flux[mask]-1)*1e6, s=size, color=color, alpha=.65, label=label, linewidths=0)
        labelled = False
        for a,b in gaps:
            left,right=bt[a]-halfbin,bt[b]+halfbin
            if right >= limits[0] and left <= limits[1]:
                ax.axvspan(left,right,color='#91b5d6',alpha=.35,label='Empty bin interval' if not labelled else None)
                labelled=True
        labelled=False
        for c in centers:
            for boundary in (c-duration/48,c+duration/48):
                if limits[0] <= boundary <= limits[1]:
                    ax.axvline(boundary,color='#75439a',linestyle='--',linewidth=1,label='L 98-59 d reference boundary' if not labelled else None)
                    labelled=True
        ax.axhline(0,color='#333333',linewidth=.8,label='0 ppm baseline')
        ax.set(xlim=limits,xlabel='Time (BTJD; not phase folded)',ylabel='Flux - 1 (ppm)',title='L 98-59 / S2 / 10 min mean — '+title)
        ax.ticklabel_format(useOffset=False,style='plain',axis='x')
        ax.grid(alpha=.2)
        ax.legend(loc='best',fontsize=8)
        fig.suptitle('Real observed background; all finite points in window. Dashed boundaries are reference guides, not fitted edges.',fontsize=9)
        for ext in ('svg','png'):
            path=out/(filename+'.'+ext)
            fig.savefig(path,dpi=150)
            outputs.append({'path':path.name,'sha256':sha(path)})
        plt.close(fig)
    report={'task':'S15P21C206-114','kind':'saved-output-review-figures','source_manifest_sha256':sha(manifest_path),
            'source_run':source.name,'inputs':[{'path':name,'sha256':sha(source/name)} for name in names],
            'plotter_sha256':sha(Path(__file__)),'numpy':np.__version__,'matplotlib':matplotlib.__version__,
            'actual_minutes':float(segment['actual_minutes']),'empty_bins':len(gap_indices),'gaps':gaps,
            'reference':case,'detail_center_btjd':float(center),'outputs':outputs,
            'note':'No binning or inference rerun. Injection difference figures remove OOT background and do not measure real readability.'}
    (out/'manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (out/'README.txt').write_text('114 second review: SVG + PNG of real L 98-59 S2.\nBlue shading: empty bins; points are never connected.\nPurple dashed lines: reference L 98-59 d boundaries, NOT measured ingress/egress.\nOther planets and real background remain. No experiment rerun.\nOriginal case3/case7 are paired differences: zero out-of-transit background, unsuitable for real readability conclusions.\n',encoding='utf-8')
    archive=out.with_suffix('.zip')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED) as z:
        for path in sorted(out.iterdir()): z.write(path,path.name)
    print('Review archive:',archive)
    print('SHA256:',sha(archive))


if __name__ == '__main__':
    main()

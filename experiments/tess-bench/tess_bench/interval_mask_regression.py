"""245: source-pinned Sector 3 ACS mask provenance and numerical regression."""
import argparse
import hashlib
import json
import sys
import platform
import importlib.metadata
from pathlib import Path
from dataclasses import asdict
import numpy as np
from astropy.io import fits
from astro_kernel.fits_adapter import parse_spoc_hdul
from astro_kernel.preprocessing import IntervalMask, preprocess_silver, exclusion_ledger, MASK_CONTRACT_VERSION

SOURCES = {
    "tess_sector_03_drn04_v02.pdf": "5a825ad259483b0a8d1e9922b66e962752047f9046fe5b2bcc43442b4bfebffa",
    "tess_reprocessing-sector_1_13_drn42_v02.pdf": "20fbfdd24157119be69a13b08ca91d51d01a6f690a69cf8f051e7959fa1fb2da",
}
RANGES = [(111297,114077), (120979,121787), (128764,130988)]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(raw, evidence, output):
    sources=[]
    for name,digest in SOURCES.items():
        path=evidence/name
        if sha(path)!=digest:
            raise ValueError("source snapshot checksum mismatch")
        sources.append(dict(path=str(path),sha256=digest))
    paths=sorted(raw.rglob("*s0003*lc.fits"))
    if not paths:
        raise ValueError("Sector 3 FITS required")
    output.mkdir(parents=True,exist_ok=False)
    inputs=[dict(path=str(path),sha256=sha(path)) for path in paths]
    root = Path(__file__).resolve().parents[3]
    code_paths = [Path(__file__), root/"libs/astro-kernel/astro_kernel/preprocessing.py",
                  root/"libs/astro-kernel/astro_kernel/fits_adapter.py",
                  root/"experiments/tess-bench/uv.lock"]
    code = [dict(path=str(p), sha256=sha(p)) for p in code_paths]
    plan = dict(inputs=inputs, sources=sources, code=code,
                environment=dict(python=sys.version, platform=platform.platform(),
                                 packages={k:importlib.metadata.version(k) for k in ("numpy", "astropy")}),
                mask_contract_version=MASK_CONTRACT_VERSION,
                mask_settings=dict(ranges=RANGES, coordinate="cadenceno", closed="both",
                                   version="sector3-acs-dr42-review-v1", expected_data_rel=42),
                tolerance=dict(rtol=0, atol=0, equal_nan=True))
    (output/"plan.json").write_text(json.dumps(plan,indent=2),encoding="utf-8")
    records=[]
    ledgers=[]
    for path,entry in zip(paths,inputs):
        with fits.open(path,memmap=False) as h:
            if h[0].header.get("DATA_REL")!=42:
                raise ValueError("this regression only validates DR42")
            c,meta=parse_spoc_hdul(h,product_id=path.name,source_sha256=entry["sha256"])
        masks=[IntervalMask(f"s3-acs-{i}",path.name,3,entry["sha256"],"cadenceno",a,b,"both","acs_testing",
               "https://archive.stsci.edu/missions/tess/doc/tess_drn/tess_sector_03_drn04_v02.pdf",
               SOURCES["tess_sector_03_drn04_v02.pdf"],"sector3-acs-dr42-review-v1") for i,(a,b) in enumerate(RANGES)]
        a,da=preprocess_silver([c]); b,db=preprocess_silver([c],interval_masks=masks)
        ledger=exclusion_ledger(b,db)
        assert len(ledger)+int(db.kept.sum())==len(c.time)
        for row in ledger:
            i=row["source_row"]
            assert row["cadenceno"]==int(c.cadenceno[i]) and row["original_quality"]==int(c.quality[i])
        ledgers.extend(ledger)
        equal = all(np.array_equal(getattr(a,k),getattr(b,k),equal_nan=True)
                    for k in ("time","flux","flux_err","sector","source_row","cadenceno","original_quality"))
        equal = equal and all(np.array_equal(getattr(da,k),getattr(db,k),equal_nan=True)
                              for k in ("trend","flux_det","kept","segment_id","segment_edges","noise_scatter"))
        equal = equal and da.status == db.status
        assert equal, "DR42 sample contains newly excluded rows; review required"
        record=dict(product=path.name,sha256=entry["sha256"],data_rel=42,procver=meta["PROCVER"],raw=len(c.time),
                    interval_rows=sum(bool(r["interval_ids"]) for r in b.excluded),newly_excluded=len(a.time)-len(b.time),
                    prepared=len(b.time),kept=int(db.kept.sum()),status=db.status,numerical_equal=equal,masks=[asdict(m) for m in masks])
        records.append(record)
    for entry in inputs+sources+code:
        assert sha(Path(entry["path"]))==entry["sha256"]
    (output/"exclusions.json").write_text(json.dumps(ledgers,allow_nan=False),encoding="utf-8")
    (output/"report.json").write_text(json.dumps(records,indent=2),encoding="utf-8")
    (output/"manifest.json").write_text(json.dumps(dict(completed=True,exclusions_sha256=sha(output/"exclusions.json"),report_sha256=sha(output/"report.json"),
      plan_sha256=sha(output/"plan.json"),scope="DR42 Sector3 provenance; no new quality cuts or BLS improvement claim"),indent=2),encoding="utf-8")
    print(json.dumps([{k:v for k,v in r.items() if k != "masks"} for r in records]))


if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--raw",type=Path,required=True);p.add_argument("--evidence",type=Path,required=True);p.add_argument("--output",type=Path,required=True)
    a=p.parse_args()
    new_output = not a.output.exists()
    try:
        run(a.raw,a.evidence,a.output)
    except Exception as exc:
        if new_output and a.output.is_dir() and (a.output/"plan.json").is_file() and not (a.output/"manifest.json").exists():
            (a.output/"failure.json").write_text(json.dumps(dict(completed=False,error=str(exc))),encoding="utf-8")
        raise

"""112 observed-window diagnostics on known synthetic cases and approved 111 pairs."""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from astro_kernel.transit_model import phase_distance_days
from tess_fixture import inject as inj, manifest as mf
from .candidate_identity import window_evidence, harmonic_equivalence
from .candidate_identity_audit import audit, read_csv
from .cli import build_bls_inputs
from .bls import load_bls_settings
from .preprocess import load_settings, preprocess
from .silver_regression import BENCH, FIXTURE, ROOT, verify_snapshot


def synthetic_cases():
    t = np.arange(0., 80., 1/720)
    a = dict(period_days=4., epoch_btjd=1., duration_hours=3.)
    for name, period, epoch, depth_a, depth_b, masking in (
        ("single_with_double_alias", 8., 1., .002, 0., False),
        ("two_exact_resonant", 8., 1., .002, .001, False),
        ("two_offset_epoch", 8., 2., .002, .001, False),
        ("two_close_periods", 4.03, 1., .002, .001, False),
        ("weak_resonant", 8., 1., .002, .000002, False),
        ("identical_windows", 4., 1., .002, 0., False),
        ("masked_distinguishing_windows", 8., 1., .002, .001, True),
        ("equal_primary_secondary", 8., 1., .002, 0., False),
    ):
        b = dict(period_days=period, epoch_btjd=epoch, duration_hours=3.)
        ma = np.abs(phase_distance_days(t,4.,1.)) < 3/48
        mb = np.abs(phase_distance_days(t,period,epoch)) < 3/48
        for seed in range(10):
            f = (1.-depth_a*ma)*(1.-depth_b*mb) + np.random.default_rng(seed).normal(0,.0002,len(t))
            if masking:
                f[ma != mb] = np.nan
            yield name, seed, t, f, a, b, depth_b > 0


def equivalence_cases(seeds):
    """Separate calibration/test seeds; below-margin stress is not hidden."""
    t=np.arange(0.,80.,1/720)
    a=dict(period_days=4.,epoch_btjd=1.,duration_hours=3.,depth_ppm=2000.,
           validated_on_original=True,peak_id="short")
    b=dict(a,period_days=8.,peak_id="long")
    ms=np.abs(phase_distance_days(t,4.,1.))<3/48
    ml=np.abs(phase_distance_days(t,8.,1.))<3/48
    for name,depth,noise,variant in (
        ("precise_single",0.,.1,"box"),
        ("typical_single",0.,200.,"box"),
        ("precise_weak_two",2.,.1,"box"),
        ("typical_weak_two",2.,200.,"box"),
        ("strong_two",1000.,200.,"box"),
        ("missing_windows",0.,.1,"masked"),
        ("red_noise_single",0.,.1,"red"),
        ("trapezoid_single",0.,.1,"trapezoid"),
        ("equal_eclipse",0.,.1,"box"),
        ("below_margin_two",.05,.1,"box"),
    ):
        for seed in seeds:
            rng=np.random.default_rng(seed)
            signal=ms.astype(float)
            if variant=="trapezoid":
                phase=np.abs(phase_distance_days(t,4.,1.))
                signal=np.clip((3/48-phase)/(3/48*.2),0,1)
            f=(1-.002*signal)*(1-depth*1e-6*ml)+rng.normal(0,noise*1e-6,len(t))
            if variant=="masked": f[ms&~ml]=np.nan
            if variant=="red":
                # Correlated within blocks and across adjacent blocks.
                knots=np.arange(0,81,.5)
                f+=np.interp(t,knots,rng.normal(0,20e-6,len(knots)))
            yield name,seed,t,f,a,b


def run_equivalence(output):
    output.mkdir(parents=True,exist_ok=False)
    entries=[mf.file_entry(Path(__file__)),mf.file_entry(Path(__file__).with_name("candidate_identity.py")),
             mf.file_entry(ROOT/"libs/astro-kernel/astro_kernel/transit_model.py"),mf.file_entry(BENCH/"uv.lock")]
    margins=[.1,.25,.5,1.]
    plan=dict(task="S15P21C206-112",inputs=entries,calibration_seeds=list(range(20)),
              test_seeds=list(range(1000,1080)),margins_ppm=margins,
              selection="smallest margin merging >=19/20 precise singles and zero >=2ppm two-signal calibration cases",
              protected_second_depth_ppm=2.,below_margin_stress_depth_ppm=.05,
              environment=mf.environment_info(("numpy","scipy","astropy")),
              limitation="synthetic photometric equivalence only; no universal physical identity claim")
    (output/"plan.json").write_text(json.dumps(plan,indent=2)+"\n",encoding="utf-8")
    plan_entry=mf.file_entry(output/"plan.json")
    results=[]
    for name,seed,t,f,a,b in equivalence_cases(range(20)):
        for margin in margins:
            results.append(dict(split="calibration",case=name,seed=seed,margin_ppm=margin,
                                evidence=harmonic_equivalence(t,f,a,b,margin_ppm=margin)))
    viable=[]
    for margin in margins:
        rows=[r for r in results if r["margin_ppm"]==margin]
        success=sum(r["case"]=="precise_single" and r["evidence"]["automatic_merge"] for r in rows)
        false=sum(r["case"] in ("precise_weak_two","typical_weak_two","strong_two")
                  and r["evidence"]["automatic_merge"] for r in rows)
        if success>=19 and false==0: viable.append(margin)
    selected=min(viable) if viable else None
    # Selection is frozen before unseen seeds are generated/evaluated.
    (output/"selection.json").write_text(json.dumps(dict(selected_margin_ppm=selected),indent=2)+"\n",encoding="utf-8")
    selection_entry=mf.file_entry(output/"selection.json")
    if selected is not None:
        for name,seed,t,f,a,b in equivalence_cases(range(1000,1080)):
            results.append(dict(split="test",case=name,seed=seed,margin_ppm=selected,
                                evidence=harmonic_equivalence(t,f,a,b,margin_ppm=selected)))
    summary={}
    for split in ("calibration","test"):
        grouped=defaultdict(list)
        for row in results:
            if row["split"]==split and row["margin_ppm"]==selected: grouped[row["case"]].append(row["evidence"])
        summary[split]={k:dict(cases=len(v),merges=sum(r["automatic_merge"] for r in v),
                              statuses=dict(Counter(r["status"] for r in v))) for k,v in grouped.items()}
    verify_snapshot(entries+[plan_entry,selection_entry])
    for name,data in (("evidence.json",results),("summary.json",dict(selected_margin_ppm=selected,results=summary))):
        (output/name).write_text(json.dumps(data,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    (output/"manifest.json").write_text(json.dumps(dict(completed=True,rule_approved=False,plan=plan_entry,
        outputs=[mf.file_entry(output/n) for n in ("selection.json","evidence.json","summary.json")]),indent=2)+"\n",encoding="utf-8")
    print(json.dumps(dict(selected_margin_ppm=selected,results=summary),indent=2),flush=True)


def run(source, output, equivalence_margin_ppm=None):
    approved = audit(source)
    cfg, _ = load_bls_settings(BENCH/"configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH/"configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    cache = {target: build_bls_inputs(target,"evaluation",cfg,pre[0],
             FIXTURE/"configs/injection_grid_v1.json",FIXTURE/"sample_raw",
             noise_seeds=[20260910],include_raw_real=True)
             for target in sorted({p["baseline_id"].split("-",1)[0] for p in approved["pairs"]})}
    raw_entries = [record for bi in cache.values() for record in bi.inputs]
    files = sorted((BENCH/"tess_bench").glob("*.py"))
    files += sorted((FIXTURE/"tess_fixture").glob("*.py"))
    files += sorted((ROOT/"libs/astro-kernel/astro_kernel").glob("*.py"))
    files += [BENCH/"configs/bls_settings_v1.json", BENCH/"configs/preprocess_settings_v1.json",
              FIXTURE/"configs/injection_grid_v1.json", FIXTURE/"references.csv", BENCH/"uv.lock"]
    files += sorted(source.glob("*/*.csv")) + sorted(source.glob("*/manifest.json")) + [source/"checksums.json"]
    entries = [mf.file_entry(p) for p in files] + raw_entries
    output.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-112", inputs=entries, seeds=list(range(10)),
                diagnostic_snr_thresholds=[3,5,7],
                equivalence_margin_ppm=equivalence_margin_ppm,
                environment=mf.environment_info(("numpy","astropy","scipy")),
                limits="conditional box depth evidence only; no automatic merge or accepted scientific gate")
    (output/"plan.json").write_text(json.dumps(plan,indent=2)+"\n",encoding="utf-8")
    plan_entry = mf.file_entry(output/"plan.json")
    results = []
    for name, seed, t, f, a, b, two in synthetic_cases():
        results.append(dict(source="synthetic", case=name, seed=seed, injected_second=two,
                            evidence=window_evidence(t,f,a,b)))
    # Reconstruct only approved accepted-pair curves, never rerun the 111 search.
    for pair in approved["pairs"]:
        target, baseline_kind = pair["baseline_id"].split("-",1)
        bi = cache[target]
        manifest = json.loads((source/pair["run"]/"manifest.json").read_text())
        old_raw = {Path(r["path"].replace("\\","/")).name:r["sha256"] for r in manifest["inputs"] if r.get("role")=="raw_product"}
        for record in bi.inputs:
            if old_raw.get(Path(record["path"]).name) != record["sha256"]:
                raise ValueError("raw fixture differs from approved 111 input")
        baseline = bi.baselines[baseline_kind]
        members = bi.groups[baseline_kind][pair["group_id"]]
        flux = inj.inject_group(baseline,members) if members else baseline.flux.copy()
        det = preprocess(baseline.time,flux,baseline.sector_of_point,pre[0])
        if det.status != "ok":
            raise ValueError("reconstruction preprocessing failure")
        rows = read_csv(source/pair["run"]/"steps.csv")
        selected = []
        for step in (pair["step_a"],pair["step_b"]):
            row, = [r for r in rows if r["baseline_id"]==pair["baseline_id"] and r["group_id"]==pair["group_id"]
                    and r["status"]=="accepted" and int(r["step"])==step]
            selected.append(dict({k:float(row[k]) for k in ("period_days","epoch_btjd","duration_hours","depth_ppm")},
                                 validated_on_original=approved["counts"]["original_validation_failed"]==0))
        result=dict(source="approved_111_reconstructed",pair=pair,
                    evidence=window_evidence(det.time,det.flux_det,*selected))
        if equivalence_margin_ppm is not None:
            result["equivalence"]=harmonic_equivalence(det.time,det.flux_det,*selected,margin_ppm=equivalence_margin_ppm)
        results.append(result)
    verify_snapshot(entries + [plan_entry])
    report = dict(approved_counts=approved["counts"], raw_inputs=raw_entries, results=results,
                  automatic_merge_enabled=False,
                  limitation="reconstructed with current preprocessing, not an independent scientific label set")
    (output/"evidence.json").write_text(json.dumps(report,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    groups = defaultdict(list)
    for row in results:
        groups[row.get("case", "approved_111")].append(row["evidence"])
    summary = {name: dict(cases=len(rows), statuses=dict(Counter(r["status"] for r in rows)),
        both_depths_supported={str(s):sum(r["status"]=="measured" and min(r["conditional_snr"])>=s
                                         for r in rows) for s in (3,5,7)}) for name,rows in groups.items()}
    (output/"summary.json").write_text(json.dumps(summary,indent=2)+"\n",encoding="utf-8")
    manifest = dict(plan=plan_entry,outputs=[mf.file_entry(output/name) for name in ("evidence.json","summary.json")],
                    cases=len(results),completed=True,rule_approved=False)
    (output/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n",encoding="utf-8")
    print(f"Completed {len(results)} cases: {output}",flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path)
    parser.add_argument("--equivalence",action="store_true",help="prespecified synthetic equivalence calibration and test")
    parser.add_argument("--margin-ppm",type=float,help="explicit experimental margin for approved 111 pair recheck")
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():
        parser.error("output must be a new directory")
    if not args.equivalence and args.source is None:
        parser.error("--source required unless --equivalence is used")
    try:
        if args.equivalence:
            run_equivalence(args.output)
        else:
            run(args.source,args.output,args.margin_ppm)
    except BaseException as exc:
        if args.output.exists() and not (args.output/"manifest.json").exists():
            with (args.output/"failure.json").open("x",encoding="utf-8") as stream:
                json.dump({"completed":False,"error":str(exc)},stream)
        raise


if __name__ == "__main__":
    main()

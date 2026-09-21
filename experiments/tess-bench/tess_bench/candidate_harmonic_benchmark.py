"""112 observed-window diagnostics on known synthetic cases and approved 111 pairs."""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from astro_kernel.transit_model import phase_distance_days
from tess_fixture import inject as inj, manifest as mf
from .candidate_identity import window_evidence
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


def run(source, output):
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
            selected.append({k:float(row[k]) for k in ("period_days","epoch_btjd","duration_hours")})
        results.append(dict(source="approved_111_reconstructed",pair=pair,
                            evidence=window_evidence(det.time,det.flux_det,*selected)))
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
    parser.add_argument("--source",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    if args.output.exists():
        parser.error("output must be a new directory")
    try:
        run(args.source,args.output)
    except BaseException as exc:
        if args.output.exists() and not (args.output/"manifest.json").exists():
            with (args.output/"failure.json").open("x",encoding="utf-8") as stream:
                json.dump({"completed":False,"error":str(exc)},stream)
        raise


if __name__ == "__main__":
    main()

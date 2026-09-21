"""112: two real Sector subsets for identity calibration, not an approved rule."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import time

from tess_fixture import manifest as mf
from tess_fixture.lightcurve import build_baseline
from tess_fixture.targets import select_targets
from .cli import _load_fixture_inputs
from .bls import load_bls_settings
from .iterate import IterateConfig, iterate_curve
from .preprocess import load_settings, preprocess
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot
from .candidate_identity import distance, reconcile


def compare_bundles(a, b):
    if a["tic_id"] != b["tic_id"]:
        raise ValueError("bundles must belong to the same TIC")
    old = [dict(c, candidate_id=f"fixture-{a['tic_id']}-{i}") for i,c in enumerate(a["candidates"])
           if c["validated_on_original"]]
    new = [c for c in b["candidates"] if c["validated_on_original"]]
    start, end = min(a["start_btjd"], b["start_btjd"]), max(a["end_btjd"], b["end_btjd"])
    # QA failure preserves the previous accepted steps but cannot justify retiring
    # a previously published identity. Computation completion is not publication.
    completeness = {name: record["termination"] in ("no_quality_peak", "duplicate_or_harmonic_only")
                    and record["qa_failed_step"] < 0
                    and all(c["validated_on_original"] for c in record["candidates"])
                    for name,record in (("A",a),("B",b))}
    complete = all(completeness.values())
    return dict(old_count=len(old), new_count=len(new), old_complete=completeness["A"],
                new_complete=completeness["B"], comparison_complete=complete,
                distance_matrix=[[distance(x,y,start,end) for y in new] for x in old],
                sweep={str(t):reconcile(old,new,start,end,tolerance=t,new_complete=bool(complete))
                       for t in (.125,.25,.5,1.)}, rule_approved=False)


def run(output, target_key="toi270"):
    target = select_targets([target_key])[0]
    curves, inputs = _load_fixture_inputs(target, FIXTURE / "sample_raw")
    sectors = sorted(c.sector for c in curves)
    if len(sectors) < 2 or len(set(sectors)) != len(sectors):
        raise ValueError("at least two unique sectors required")
    config_path = BENCH / "configs/bls_settings_v1.json"
    preprocess_path = BENCH / "configs/preprocess_settings_v1.json"
    _, settings = load_bls_settings(config_path, ["poc_linear20k"])
    _, pre = load_settings(preprocess_path, ["biweight_1.0d"])
    cfg = IterateConfig(qa_window_offset_reference="unity", qa_window_offset_rel_depth=0.1,
                        refine_duration_max_hours=12, refine_duration_span=(0.5, 2.0))
    code_paths = sorted((BENCH / "tess_bench").glob("*.py"))
    code_paths += sorted((FIXTURE / "tess_fixture").glob("*.py"))
    code_paths += sorted((ROOT / "libs/astro-kernel/astro_kernel").glob("*.py"))
    entries = inputs + [mf.file_entry(p) for p in code_paths + [config_path, preprocess_path, BENCH / "uv.lock"]]
    output.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-112", inputs=entries, iteration_config=asdict(cfg),
                bls_config=settings[0].params(), preprocess_config=asdict(pre[0]),
                target=target.key, subsets={"A": sectors[:-1], "B": sectors},
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                limitation="real observation comparison; no candidate identity truth or automatic threshold approval")
    (output / "plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    plan_entry = mf.file_entry(output / "plan.json")
    print(f"Plan: {output / 'plan.json'}", flush=True)
    started = time.perf_counter()
    bundles = {}
    try:
        for name, sectors in plan["subsets"].items():
            baseline = build_baseline([c for c in curves if c.sector in sectors])
            det = preprocess(baseline.time, baseline.flux, baseline.sector_of_point, pre[0])
            if det.status != "ok":
                raise ValueError(f"{name}: preprocessing {det.status}")
            result = iterate_curve(det.time, det.flux_det, settings[0], cfg)
            # Raw step NaNs follow 111's experiment serialization; these are not Gold JSON.
            record = dict(bundle=name, sectors=sectors, tic_id=target.tic_id,
                          start_btjd=float(baseline.time.min()), end_btjd=float(baseline.time.max()),
                          termination=result.termination, qa_failed_step=result.qa_failed_step,
                          candidates=[asdict(c) for c in result.accepted],
                          steps=[asdict(s) for s in result.steps])
            (output / f"bundle-{name}.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
            bundles[name] = record
            print(f"{name}: {len(result.accepted)} candidates; {result.termination}", flush=True)
        comparison = compare_bundles(bundles["A"], bundles["B"])
        (output / "identity-sweep.json").write_text(json.dumps(comparison,indent=2,allow_nan=False)+"\n",encoding="utf-8")
        verify_snapshot(entries + [plan_entry])
        manifest = dict(task="S15P21C206-112", execution_completed=True, identity_rule_approved=False,
                        wall_s=time.perf_counter()-started, plan=plan_entry,
                        outputs=[mf.file_entry(output / name) for name in ("bundle-A.json", "bundle-B.json", "identity-sweep.json")])
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    except BaseException as exc:
        (output / "failure.json").write_text(json.dumps({"error":str(exc)}), encoding="utf-8")
        raise


def compare_saved_runs(runs, output):
    """Re-evaluate immutable bundle outputs without rerunning BLS."""
    entries, records = [], []
    for directory in runs:
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not manifest.get("execution_completed"):
            raise ValueError("incomplete source execution")
        bundles = []
        for name in ("bundle-A.json", "bundle-B.json"):
            path = directory / name
            recorded, = [e for e in manifest["outputs"] if Path(e["path"]).name == name]
            entry = mf.file_entry(path)
            if recorded["sha256"] != entry["sha256"]:
                raise ValueError("bundle checksum mismatch")
            entries.append(entry)
            bundles.append(json.loads(path.read_text(encoding="utf-8")))
        entries.append(mf.file_entry(manifest_path))
        records.append(dict(source=str(directory), tic_id=bundles[0]["tic_id"],
                            sectors=[b["sectors"] for b in bundles],
                            terminations=[b["termination"] for b in bundles],
                            comparison=compare_bundles(*bundles)))
    entries += [mf.file_entry(Path(__file__)),mf.file_entry(Path(__file__).with_name("candidate_identity.py"))]
    output.mkdir(parents=True,exist_ok=False)
    report = dict(task="S15P21C206-112",inputs=entries,records=records,rule_approved=False)
    (output / "comparison.json").write_text(json.dumps(report,indent=2,allow_nan=False)+"\n",encoding="utf-8")
    verify_snapshot(entries)
    (output / "manifest.json").write_text(json.dumps(dict(completed=True,
        outputs=[mf.file_entry(output/"comparison.json")]),indent=2)+"\n",encoding="utf-8")
    print(f"Compared {len(records)} saved runs: {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", choices=("toi270","toi451","wasp62","pi_men"), default="toi270")
    parser.add_argument("--compare-runs", nargs="+", type=Path, help="compare saved bundle outputs without BLS")
    args = parser.parse_args()
    if args.compare_runs:
        compare_saved_runs(args.compare_runs,args.output)
    else:
        run(args.output, args.target)


if __name__ == "__main__":
    main()

"""Audit saved 123/124 results and replay 125 projection; no BLS or DB writes."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import numpy as np

from astro_kernel.candidate_catalog import build_candidate_catalog
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.targets import select_targets, iter_products

from .serialization import assemble

ROOT = Path(__file__).resolve().parents[3]


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def entry(path):
    path = Path(path).resolve()
    return dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def audit(folder):
    m = read(folder / "manifest.json")
    if m.get("passed") is not True:
        raise ValueError("upstream_run_not_passed")
    entries = m["outputs"] + ([m["plan"]] if "plan" in m else [])
    verified = {str((folder / "manifest.json").resolve()): entry(folder / "manifest.json")}
    for e in entries:
        p = Path(e["path"]).resolve()
        if p.parent != folder.resolve() or entry(p)["sha256"] != e["sha256"]:
            raise ValueError("upstream_output_checksum_or_path_mismatch")
        verified[str(p)] = entry(p)
    return verified


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def run(segmentation, external, output):
    inputs = {**audit(segmentation), **audit(external)}
    def saved(folder, name):
        p = (folder / name).resolve()
        if str(p) not in inputs:
            raise ValueError("unregistered_output")
        return p
    comparisons = read(saved(segmentation, "comparisons.json"))
    proofs = read(saved(external, "proofs.json"))
    lookup = {(p["target"], p["group"]): p for p in proofs}
    if len(lookup) != len(proofs):
        raise ValueError("duplicate_curve_key")
    plan = read(saved(segmentation, "plan.json"))
    raw_hashes = {str(Path(p["path"]).resolve()): p["sha256"] for p in plan["inputs"]}
    out = output / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    results, totals, baselines = [], Counter(), {}
    for n, comparison in enumerate(comparisons):
        key = (comparison["target"], comparison["group"])
        proof = lookup[key]
        curve = read(saved(segmentation, f"curve-{n:03d}.json"))
        disc = curve["result"]
        if disc["status"] != "ready":
            totals["upstream_held"] += 1
            results.append(dict(target=key[0], group=key[1], status="upstream_held", reasons=disc["reasons"]))
            continue
        if key[0] not in baselines:
            curves = []
            for target, _, filename, _ in iter_products(select_targets([key[0]])):
                p = ROOT / "experiments/tess-fixture/sample_raw" / target.key / filename
                e = entry(p)
                if raw_hashes.get(e["path"]) != e["sha256"]:
                    raise ValueError("raw_fits_checksum_mismatch")
                inputs[e["path"]] = e
                curves.append(load_sector(p))
            baselines[key[0]] = build_baseline(curves)
        base = baselines[key[0]]
        ids = {c["peak_id"]: c["candidate_id"] for c in disc["proposed_candidates"]}
        cat = build_candidate_catalog(curve["source"], tic_id=disc["tic_id"], bundle_id=disc["bundle_id"],
                                      new_candidate_ids=ids, identity_approval=plan["identity_approval"])
        if sorted(ids.values()) != sorted(proof["candidate_ids"]):
            raise ValueError("124_candidate_ids_differ")
        with np.load(saved(segmentation, f"curve-{n:03d}-00.npz"), allow_pickle=False) as arrays:
            pg = dict(candidate_id=None, periods=arrays["periods"].tolist(), power=arrays["power"].tolist())
        versions = dict(preprocessing=curve["source"]["preprocessing_version"],
            bls_config=curve["source"]["bls_config_version"], residual_model=curve["source"]["residual_model_version"],
            periodogram_config="provided-bls-1.0.0", candidate_quality=disc["candidate_quality_revision"],
            external_matching=proof["controlled_external"]["direct"]["matching_rule_version"],
            ai_model="fixture-policy-only", ai_threshold="fixture-policy-only")
        common = dict(catalog=cat, segmented=dict(segments=curve["segments"], quarantined=[]), discovery=disc,
            periodogram=pg, segment_ids={str(s["sector"]): i + 1 for i, s in enumerate(curve["segments"])},
            input_snapshot_ids=["regression-plan:sha256:" + inputs[str((segmentation / "plan.json").resolve())]["sha256"]],
            calculation_versions=versions, fold_reference_time_btjd=float(np.median(np.unique(base.time))),
            base_days=float(np.ptp(base.time)), fine_tune=plan["fine_tune"],
            ai_policy=dict(status="policy_not_executed", decision_reference="125-controlled-regression-only",
                           model_version="fixture-policy-only", threshold_version="fixture-policy-only"))
        actual = assemble(**common, external=proof["actual_external"])
        if actual.get("reason") != "external_not_ready" or actual["payload"] is not None:
            raise ValueError("actual_external_hold_not_preserved")
        controlled = assemble(**common, external=proof["controlled_external"]["direct"])
        if controlled["status"] != "validated":
            raise ValueError("controlled_projection_failed:" + controlled["reason"])
        write(out / f"controlled-{n:03d}.json", controlled)
        totals.update(actual_external_rejected=1, controlled_validated=1, candidates=len(ids))
        results.append(dict(target=key[0], group=key[1], actual=actual, controlled_file=f"controlled-{n:03d}.json"))
    for e in inputs.values():
        if entry(e["path"])["sha256"] != e["sha256"]:
            raise ValueError("input_changed_during_replay")
    write(out / "report.json", dict(counts=dict(totals), curves=results, fixture_ids_only=True,
        controlled_labels_only=True, database_verified=False, publishable=False))
    write(out / "manifest.json", dict(task="S15P21C206-125", status="completed", passed=True,
        scope="saved-output projection; not DB or external scientific validation", inputs=list(inputs.values()),
        code=[entry(Path(__file__)), entry(Path(__file__).with_name("serialization.py")), entry(Path(__file__).with_name("canonical.py")),
              entry(ROOT / "libs/astro-kernel/astro_kernel/gold_serialization.py"),
              entry(ROOT / "libs/astro-kernel/astro_kernel/gold_canonical.py")],
        outputs=[entry(p) for p in sorted(out.glob("*.json"))]))
    print(json.dumps(dict(totals)))
    print(f"Report: {out}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--segmentation", type=Path, required=True)
    p.add_argument("--external", type=Path, required=True)
    p.add_argument("--output", type=Path, default=Path("results/connection-125"))
    a = p.parse_args()
    run(a.segmentation.resolve(), a.external.resolve(), a.output)


if __name__ == "__main__":
    main()

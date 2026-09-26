"""79 real-data replay: saved 116 rows + local 123 run + FITS -> 124 -> 125 -> 79.

No download, BLS, Git or DB writes. External rows come from the checksum-listed
116 review ZIP (the audit already hash-checked the raw exports). Observation
times are rebuilt from FITS exactly as 124 did and must hash to the saved 124
proofs, so the only intended difference from 2026-09-22 is the time rule.
Fixture IDs only; one 79 run per injection variant (each star appears once).
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4
import zipfile

import numpy as np

from astro_kernel.candidate_aggregation import AI_NOT_EXECUTED, AI_POLICY, aggregate
from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.external_catalog import MATCH_VERSION, TIME_RULE_VERSION, join_catalog
from astro_kernel.preprocessing import detrend_silver
from tess_fixture import inject
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.targets import iter_products, select_targets
from .bls import load_bls_settings
from .cli import build_bls_inputs
from .external_catalog_regression import ROOT, _entry, _write, normalize_sources
from .preprocess import load_settings

FIXTURE = ROOT / "experiments/tess-fixture"
BENCH = ROOT / "experiments/tess-bench"
# Recorded in docs/data/tess-external-catalog-contract.md (116) and -implementation.md (124).
REVIEW_SHA256 = {"review-116-6348c862.zip": "368d8a03c7f64805c7d266442de9122445b08d13605be37c46538f0c2f76c658",
                 "review-124-696cda44.zip": "b680566200d6a4808c46c166ad5f4eacf67d0097324c0dc1fe6d288833b8e08a"}


def zip_members(path):
    """Members of a review ZIP whose own hash was recorded, each checked against its checksums.json."""
    if _entry(Path(path))["sha256"] != REVIEW_SHA256.get(Path(path).name):
        raise ValueError("review ZIP is not the recorded 116/124 attachment")
    with zipfile.ZipFile(path) as archive:
        listed = json.loads(archive.read("checksums.json"))
        hashes = listed if isinstance(listed, dict) else {e["file"]: e["sha256"] for e in listed}
        if set(archive.namelist()) != set(hashes) | {"checksums.json"}:
            raise ValueError("unlisted ZIP member")
        blobs = {name: archive.read(name) for name in hashes}
    if any(hashlib.sha256(data).hexdigest() != hashes[name] for name, data in blobs.items()):
        raise ValueError("ZIP member checksum mismatch")
    return blobs


def saved_sources(review_116, workdir):
    """116 audit rows with their source manifests re-pointed to verified local copies."""
    blobs = zip_members(review_116)
    audited = json.loads(blobs["source-audit.json"])
    for source in audited["sources"].values():
        run_id = Path(source["source_manifest"]).parent.name.rsplit("-", 1)[-1]
        data = blobs[f"source-manifest-{run_id}.json"]
        if hashlib.sha256(data).hexdigest() != source["source_manifest_sha256"]:
            raise ValueError("116 source manifest checksum mismatch")
        local = workdir / f"source-manifest-{run_id}.json"
        local.write_bytes(data)
        source["source_manifest"] = str(local)
    return audited


def segmentation_run(folder):
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("passed") is not True:
        raise ValueError("123 run did not pass")
    for e in manifest["outputs"] + [manifest["plan"]]:
        path = Path(e["path"])
        if path.parent.resolve() != folder.resolve() or _entry(path)["sha256"] != e["sha256"]:
            raise ValueError("123 output checksum or path mismatch")
    return manifest


def variant(group):
    return group.rsplit("-", 1)[-1] if group.startswith("injection_grid") else group


def run(review_116, review_124, segmentation, results):
    out = results / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    audited = saved_sources(review_116, out)
    reports, deliveries = normalize_sources(audited)
    old = {(p["target"], p["group"]): p for p in json.loads(zip_members(review_124)["proofs.json"])}
    seg_manifest = segmentation_run(segmentation)
    plan = json.loads((segmentation / "plan.json").read_text(encoding="utf-8"))
    comparisons = json.loads((segmentation / "comparisons.json").read_text(encoding="utf-8"))
    cfg, _ = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    snapshots = sorted(f"external:{name}:sha256:{d['snapshot']['sha256']}"
                       for name, d in deliveries.items() if d["status"] == "ready")
    plan_id = "regression-plan:sha256:" + seg_manifest["plan"]["sha256"]
    runs, versions, curves, bls, baselines = defaultdict(list), set(), [], {}, {}
    for n, item in enumerate(comparisons):
        key = (item["target"], item["group"])
        before = old[key]
        curve = json.loads((segmentation / f"curve-{n:03d}.json").read_text(encoding="utf-8"))
        disc = curve["result"]
        ids = {c["peak_id"]: c["candidate_id"] for c in disc["proposed_candidates"]}
        catalog = build_candidate_catalog(curve["source"], tic_id=disc["tic_id"], bundle_id=disc["bundle_id"],
                                          new_candidate_ids=ids or None, identity_approval=plan["identity_approval"])
        record = dict(target=key[0], group=key[1], tic_id=disc["tic_id"], bundle_id=disc["bundle_id"],
                      before=dict(status=before["actual_external"]["status"],
                                  reasons=before["actual_external"]["reasons"]))
        inputs = dict(catalog=catalog, discovery=disc,
                      segmented=dict(segments=curve["segments"], quarantined=[]))
        if disc["status"] == "ready":
            if sorted(ids.values()) != sorted(before["candidate_ids"]):
                raise ValueError("123 candidate IDs differ from saved 124")
            if key[0] not in bls:
                bls[key[0]] = build_bls_inputs(key[0], "tuning", cfg, pre[0], FIXTURE / "configs/injection_grid_v1.json",
                                               FIXTURE / "sample_raw", noise_seeds=[])
                baselines[key[0]] = build_baseline([load_sector(FIXTURE / "sample_raw" / t.key / f)
                                                    for t, _, f, _ in iter_products(select_targets([key[0]]))])
            bi = bls[key[0]]
            base = bi.baselines["realclean"]
            members = bi.groups["realclean"][key[1]]
            prepared = detrend_silver(base.time, inject.inject_group(base, members) if members else base.flux.copy(),
                                      base.sector_of_point)
            times = prepared.time[np.isfinite(prepared.flux_det)]
            digest = hashlib.sha256(np.asarray(times, dtype="<f8").tobytes()).hexdigest()
            if digest != before["observed_times_sha256"]:
                raise ValueError("observation times differ from saved 124: " + "/".join(key))
            external = join_catalog(catalog, deliveries, times, required_sources=list(deliveries),
                                    approval="79-real-replay-116-contract")
            with np.load(segmentation / f"curve-{n:03d}-00.npz", allow_pickle=False) as arrays:
                periodogram = dict(candidate_id=None, periods=arrays["periods"].tolist(), power=arrays["power"].tolist())
            fold_base = baselines[key[0]]
            inputs.update(external=external, periodogram=periodogram,
                          segment_ids={str(s["sector"]): disc["bundle_id"] * 10 + i + 1
                                       for i, s in enumerate(curve["segments"])},
                          input_snapshot_ids=[plan_id, *snapshots],
                          fold_reference_time_btjd=float(np.median(np.unique(fold_base.time))),
                          base_days=float(np.ptp(fold_base.time)), fine_tune=plan["fine_tune"])
            record["after"] = dict(status=external["status"], reasons=external["reasons"],
                                   dispositions={r["candidate_id"]: r["disposition"] for r in external["rows"]},
                                   observed_times_sha256=digest)
            versions.add((curve["source"]["preprocessing_version"], curve["source"]["bls_config_version"],
                          curve["source"]["residual_model_version"]))
        runs[variant(key[1])].append(dict(tic_id=disc["tic_id"], inputs=inputs))
        curves.append(record)
    if len(versions) != 1:
        raise ValueError("one run must share its rule versions")
    preprocessing, bls_config, residual = versions.pop()
    run_versions = dict(preprocessing=preprocessing, bls_config=bls_config, residual_model=residual,
                        periodogram_config="provided-bls-1.0.0", external_matching=MATCH_VERSION,
                        ai_model=AI_NOT_EXECUTED, ai_threshold=AI_NOT_EXECUTED)
    summary = {}
    for name, items in sorted(runs.items()):
        dataset = aggregate(run_id=f"79-real-replay-{name}", silver_attempt=f"tess-bench-123:{segmentation.name}",
                            targets=[r["tic_id"] for r in items], results=items,
                            calculation_versions=run_versions, ai_policy=AI_POLICY)
        _write(out / f"candidates-{name}.json", dataset)
        m = dataset["manifest"]
        summary[name] = dict(status=dataset["status"], reason=dataset.get("reason"),
                             counts=m and m["counts"], stars=m and m["stars"],
                             candidate_count=m and m["candidate_count"],
                             discoverable_ready_tic_count=m and m["discoverable_ready_tic_count"])
    moved = Counter((c["before"]["status"], c.get("after", {}).get("status", "upstream_held")) for c in curves)
    _write(out / "report.json", dict(task="S15P21C206-79", time_rule_version=TIME_RULE_VERSION,
        normalization={k: v["counts"] for k, v in reports.items()}, external_before_after=
        {f"{a}->{b}": n for (a, b), n in sorted(moved.items())}, curves=curves, runs=summary,
        fixture_ids_only=True, publishable=False))
    inputs = [_entry(p) for p in (Path(review_116), Path(review_124), segmentation / "manifest.json",
                                  Path(__file__), ROOT / "libs/astro-kernel/astro_kernel/external_catalog.py",
                                  ROOT / "libs/astro-kernel/astro_kernel/candidate_aggregation.py",
                                  ROOT / "libs/astro-kernel/astro_kernel/gold_serialization.py")]
    _write(out / "manifest.json", dict(task="S15P21C206-79", status="completed", passed=True, inputs=inputs,
        outputs=[_entry(p) for p in sorted(out.glob("*.json")) if p.name != "manifest.json"]))
    print(json.dumps(dict(normalization={k: v["counts"] for k, v in reports.items()},
                          external=dict(moved and {f"{a}->{b}": n for (a, b), n in moved.items()}),
                          runs={k: (v["status"], v["counts"]) for k, v in summary.items()}), ensure_ascii=False))
    print(f"Completed: {out}")
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-116", type=Path, required=True, help="MR !187 review-116-6348c862.zip")
    parser.add_argument("--review-124", type=Path, required=True, help="MR !190 review-124-696cda44.zip")
    parser.add_argument("--segmentation", type=Path, required=True, help="passing 123 segmentation_regression run")
    parser.add_argument("--output", type=Path, default=BENCH / "results/aggregation-replay-79")
    args = parser.parse_args()
    run(args.review_116, args.review_124, args.segmentation.resolve(), args.output)


if __name__ == "__main__":
    main()

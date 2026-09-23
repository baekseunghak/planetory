"""124 user-run replay of saved 122 candidates; no BLS, downloads, Git or DB.

Real observation times are reconstructed from checksum-verified original FITS
and the same preprocessing inputs. Existing fixture IDs are preserved verbatim.
Controlled external rows test transitions; real 116 rows are reported separately.
"""
import argparse
from collections import Counter
from copy import deepcopy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
from uuid import uuid4
import zipfile

import numpy as np

from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.external_catalog import build_snapshot, content_hash, join_catalog, code_snapshot
from astro_kernel.preprocessing import detrend_silver
from tess_fixture.external_catalog_audit import audit
from tess_fixture import inject
from tess_fixture.targets import select_targets, iter_products
from .bls import load_bls_settings
from .cli import build_bls_inputs
from .preprocess import load_settings
from .external_catalog_regression import ROOT, _entry, _write, normalize_sources

FIXTURE = ROOT / "experiments/tess-fixture"
BENCH = ROOT / "experiments/tess-bench"


def load_review(path, expected_sha256):
    if _entry(path)["sha256"] != expected_sha256:
        raise ValueError("review ZIP checksum mismatch")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or sum(i.file_size for i in archive.infolist()) > 32_000_000:
            raise ValueError("duplicate or oversized ZIP")
        hashes = json.loads(archive.read("checksums.json"))
        if set(names) != set(hashes) | {"checksums.json"}:
            raise ValueError("unlisted ZIP member")
        blobs = {name: archive.read(name) for name in hashes}
        if any(hashlib.sha256(data).hexdigest() != hashes[name] for name, data in blobs.items()):
            raise ValueError("ZIP member checksum mismatch")
    objects = {name: json.loads(data) for name, data in blobs.items() if name.endswith(".json")}
    for prefix in ("iteration", "catalog"):
        manifest = objects[f"{prefix}/manifest.json"]
        if manifest.get("passed") is not True or manifest.get("task") != "S15P21C206-122":
            raise ValueError("passing 122 manifests required")
        for entry in [manifest["plan"], *manifest["outputs"]]:
            name = prefix + "/" + entry["path"].replace("\\", "/").rsplit("/", 1)[-1]
            if hashes.get(name) != entry["sha256"]:
                raise ValueError("122 manifest/member mismatch")
    if objects["catalog/plan.json"].get("fixture_ids_only") is not True:
        raise ValueError("this regression expects explicitly marked fixture IDs")
    comparisons = list(csv.DictReader(io.StringIO(blobs["iteration/comparisons.csv"].decode("utf-8-sig"))))
    proofs = objects["catalog/proofs.json"]
    if len(comparisons) != len(proofs) or len(proofs) != objects["iteration/manifest.json"]["n_curves"]:
        raise ValueError("122 curve count mismatch")
    for item, proof in zip(comparisons, proofs, strict=True):
        if (item["target"], item["group"]) != (proof["target"], proof["group"]):
            raise ValueError("122 proof/curve order mismatch")
        iteration = objects["iteration/" + item["output"]]
        old = proof["current"]
        allocations = {c["peak_id"]: c["candidate_id"] for c in old["candidates"]}
        rebuilt = build_candidate_catalog(iteration, tic_id=old["tic_id"], bundle_id=old["bundle_id"],
            new_candidate_ids=allocations, identity_approval=objects["catalog/plan.json"]["identity_approval"])
        for key in ("catalog_ready", "candidates", "reasons"):
            if rebuilt[key] != old[key]:
                raise ValueError("current 122 reconstruction differs: " + key)
    return objects, comparisons, hashes


def control_scenarios(catalog, times):
    """Actual candidate models/IDs with explicitly artificial external labels."""
    rows = [dict(tic_id=str(catalog["tic_id"]), external_id="fixture-" + str(c["candidate_id"]),
        period_days=c["period_days"], epoch_btjd=c["epoch_btjd"], duration_hours=c["duration_hours"],
        time_system="BTJD-TDB", raw_disposition="CP") for c in catalog["candidates"] if c["status"] == "active"]
    def source(values, complete=True, timestamp="2026-09-22T00:00:00Z"):
        return build_snapshot(source="controlled_fixture", scope=[str(catalog["tic_id"])], rows=values,
            raw_sha256=content_hash(values), retrieved_at=timestamp, source_uri="fixture:124-controlled",
            source_table="controlled_fixture", time_evidence="generated from 122 BTJD models; not an external observation",
            complete=complete, validated=True)
    def joined(delivery, previous=None):
        return join_catalog(catalog, {"controlled_fixture": delivery}, times,
            required_sources=["controlled_fixture"], approval="synthetic-contract-test-not-production-approval", previous=previous)
    first = joined(source(rows))
    if first["status"] != "ready" or {r["candidate_id"] for r in first["rows"]} != {r["candidate_id"] for r in catalog["candidates"] if r["status"] == "active"}:
        raise AssertionError("controlled direct join failed")
    retry = joined(source(rows, timestamp="2026-09-23T00:00:00Z"), first)
    assert not retry["changes"] and not retry["history"] and not retry["reference_changes"]
    updated = deepcopy(rows)
    updated[0]["raw_disposition"] = "FP"
    changed = joined(source(updated), first)
    assert changed["status"] == "ready" and len(changed["history"]) == 2
    changed_retry = joined(source(updated), changed)
    assert not changed_retry["changes"] and not changed_retry["history"]
    missing = joined(source([]), first)
    assert missing["status"] == "ready" and all(r["disposition"] == "none" for r in missing["rows"])
    assert len(missing["reference_changes"]) == len(rows)
    failed = joined(source([], complete=False), first)
    duplicate = joined(source(rows + [rows[0]]), first)
    ambiguous = joined(source(rows + [dict(rows[0], external_id="fixture-ambiguous")]), first)
    alias_rows = [dict(rows[0], period_days=rows[0]["period_days"] * 2)]
    alias = joined(source(alias_rows), first)
    for held in (failed, duplicate, ambiguous, alias):
        assert held["status"] == "hold" and held["retained_previous"] == first
        assert not held["rows"] and not held["changes"] and not held["history"] and not held["reference_changes"]
    return dict(direct=first, retry=retry, changed=changed, changed_retry=changed_retry,
                disappeared=missing, failed=failed, duplicate=duplicate, ambiguous=ambiguous, alias=alias)


def run(review_zip, expected_sha256, manifests, raw, results):
    objects, comparisons, hashes = load_review(review_zip, expected_sha256)
    audited = audit(manifests)
    reports, deliveries = normalize_sources(audited)
    targets = list(dict.fromkeys(r["target"] for r in comparisons))
    paths = [Path(review_zip), *map(Path, manifests)]
    # Check the original FITS and the reconstruction modules against 122, not
    # merely against the current fixture registry.
    originals = objects["iteration/plan.json"]["inputs"]
    def original_hash(suffix):
        matches = [e["sha256"] for e in originals if e["path"].replace("\\", "/").endswith(suffix)]
        if len(matches) != 1:
            raise ValueError("unique 122 source entry required: " + suffix)
        return matches[0]
    for target, _, filename, _ in iter_products(select_targets(targets)):
        path = raw / target.key / filename
        if _entry(path)["sha256"] != original_hash("/" + filename):
            raise ValueError("122 FITS checksum mismatch")
        paths.append(path)
    for relative in ("experiments/tess-fixture/references.csv", "experiments/tess-fixture/configs/injection_grid_v1.json",
        "experiments/tess-bench/configs/bls_settings_v1.json", "experiments/tess-bench/configs/preprocess_settings_v1.json",
        "experiments/tess-bench/tess_bench/cli.py", "experiments/tess-bench/tess_bench/bls.py",
        "experiments/tess-bench/tess_bench/preprocess.py", "experiments/tess-fixture/tess_fixture/inject.py",
        "experiments/tess-fixture/tess_fixture/lightcurve.py", "libs/astro-kernel/astro_kernel/preprocessing.py",
        "libs/astro-kernel/astro_kernel/transit_model.py"):
        if _entry(ROOT / relative)["sha256"] != original_hash(relative):
            raise ValueError("122 observation reconstruction input changed: " + relative)
        paths.append(ROOT / relative)
    for source in audited["sources"].values():
        manifest_path = Path(source["source_manifest"])
        meta = json.loads(manifest_path.read_bytes())
        paths.extend(manifest_path.parent / s["file"] for s in meta["sources"].values() if "file" in s)
    for folder in (ROOT / "libs/astro-kernel/astro_kernel", BENCH / "tess_bench", FIXTURE / "tess_fixture"):
        paths.extend(folder / p for p in code_snapshot(folder))
    paths.extend([BENCH / "uv.lock", BENCH / "pyproject.toml"])
    inputs = [_entry(p) for p in sorted(set(paths))]
    out = results / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    _write(out / "plan.json", dict(task="S15P21C206-124", inputs=inputs, source_members=hashes,
        fixture_ids_only=True, scope="122 saved realclean/injected candidates; same fixture IDs; controlled and real external rows separated",
        limitation="no operating DB ID allocation/publication, no BLS rerun"))
    print(f"Plan fixed: {out / 'plan.json'}", flush=True)
    proofs, counts = [], Counter()
    try:
        cfg, _ = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
        _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
        for target in targets:
            bi = build_bls_inputs(target, "tuning", cfg, pre[0], FIXTURE / "configs/injection_grid_v1.json", raw, noise_seeds=[])
            baseline = bi.baselines["realclean"]
            for index, item in enumerate(comparisons):
                if item["target"] != target:
                    continue
                catalog = objects["catalog/proofs.json"][index]["current"]
                before = content_hash(catalog)
                if not catalog["catalog_ready"]:
                    held = join_catalog(catalog, deliveries, [], required_sources=list(deliveries), approval="fixture-replay")
                    assert held["status"] == "hold" and not held["rows"]
                    proofs.append(dict(target=target, group=item["group"], candidate_ready=False, actual_external=held))
                    counts["upstream_held"] += 1
                    continue
                members = bi.groups["realclean"][item["group"]]
                flux = inject.inject_group(baseline, members) if members else baseline.flux.copy()
                prepared = detrend_silver(baseline.time, flux, baseline.sector_of_point)
                if prepared.status != "ok":
                    raise ValueError("preprocessing failed")
                times = prepared.time[np.isfinite(prepared.flux_det)]
                if float(prepared.time[0]) != catalog["time_start_btjd"] or float(prepared.time[-1]) != catalog["time_end_btjd"]:
                    raise ValueError("observation baseline differs from 122")
                actual = join_catalog(catalog, deliveries, times, required_sources=list(deliveries), approval="fixture-replay-116-contract")
                controlled = control_scenarios(catalog, times)
                assert content_hash(catalog) == before
                proof = dict(target=target, group=item["group"], candidate_ready=True,
                    candidate_ids=[c["candidate_id"] for c in catalog["candidates"]],
                    observed_points=len(times), observed_times_sha256=hashlib.sha256(np.asarray(times, dtype="<f8").tobytes()).hexdigest(),
                    actual_external=actual, controlled_external=controlled)
                proofs.append(proof)
                counts["ready_catalogs"] += 1
                counts["candidates"] += len(catalog["candidates"])
                counts["controlled_scenarios"] += len(controlled)
                counts["actual_" + actual["status"]] += 1
                print(f"{target}/{item['group']}: {len(catalog['candidates'])} IDs retained; scenarios passed; external={actual['status']}", flush=True)
        _write(out / "proofs.json", proofs)
        _write(out / "sources.json", dict(normalization=reports, deliveries=deliveries))
        if any(_entry(e["path"]) != e for e in inputs):
            raise ValueError("input changed during run")
        _write(out / "manifest.json", dict(task="S15P21C206-124", status="completed", passed=True,
            fixture_ids_only=True, counts=dict(counts), inputs=inputs,
            outputs=[_entry(out / p) for p in ("plan.json", "proofs.json", "sources.json")]))
        print(json.dumps(dict(counts)), flush=True)
        print(f"Completed: {out}", flush=True)
    except BaseException as exc:
        _write(out / "failure.json", dict(task="S15P21C206-124", passed=False, error_type=type(exc).__name__))
        raise
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-zip", type=Path, required=True)
    parser.add_argument("--catalog-zip-sha256", required=True)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--output", type=Path, default=BENCH / "results/external-catalog-candidate-regression")
    args = parser.parse_args()
    run(args.catalog_zip, args.catalog_zip_sha256, args.manifest, args.raw, args.output)


if __name__ == "__main__":
    main()

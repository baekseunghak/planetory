"""123 vs frozen 114/115 references. Run FITS experiments explicitly; never downloads."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import io
import json
import time
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from uuid import uuid4
from zipfile import ZipFile

import numpy as np

from astro_kernel import discoverability as kernel
from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.segmentation import bin_sector, segment_revision
from tess_fixture import manifest as mf
from tess_fixture.targets import iter_products, select_targets
from . import discoverability as reference
from .binning import bin_curve, scatter
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def compare_segments(t, f):
    old, new = bin_curve(t, f, minutes=10., reducer="mean"), bin_sector(t, f)
    require(old.minutes == 10., "reference widened its bins")
    np.testing.assert_array_equal(old.counts, new.counts)
    np.testing.assert_array_equal(old.centers, new.centers)
    np.testing.assert_allclose(old.flux, new.flux, rtol=1e-12, atol=1e-14, equal_nan=True)
    np.testing.assert_allclose(scatter(old.flux), new.flux_scatter, rtol=1e-10, atol=1e-14)
    require(old.gaps == new.gaps, "gap mismatch")
    delta = float(np.nanmax(np.abs(old.flux - new.flux)))
    return new, delta


def audit_saved_115(zip_path):
    """No FITS or BLS execution: verify bytes and reclassify archived periodograms."""
    with ZipFile(zip_path) as archive:
        manifests = [n for n in archive.namelist() if n.endswith("/manifest.json")]
        require(len(manifests) == 1, "one run manifest required")
        prefix = manifests[0].rsplit("/", 1)[0] + "/"
        manifest = json.loads(archive.read(manifests[0]))
        require(manifest["task"] == "S15P21C206-115" and manifest["status"] == "completed", "not a passing 115 run")
        for entry in [manifest["plan"], *manifest["outputs"]]:
            raw = archive.read(prefix + PureWindowsPath(entry["path"]).name)
            require(hashlib.sha256(raw).hexdigest() == entry["sha256"], "archived checksum mismatch")
        rows = json.loads(archive.read(prefix + "measurements.json"))
        for row in rows:
            require(row["status"] == "measured", "saved replay currently requires measured periodograms")
            with np.load(io.BytesIO(archive.read(prefix + row["output"])), allow_pickle=False) as arrays:
                pg = SimpleNamespace(**{k: arrays[k] for k in
                    ("periods", "power", "snr", "sde", "epoch_btjd", "duration_hours")})
                verdict = kernel.classify(pg, arrays["time"], arrays["flux"],
                    row["candidate"]["transit_model"] if row["candidate"] else None, kernel.RULE)
                require(all(row[key] == value for key, value in verdict.items()), "saved verdict mismatch")
        summary = reference.summarize(rows)
        require(summary == manifest["summary"], "summary mismatch")
        print(json.dumps(dict(scope="saved 115 periodograms only; no FITS/BLS replay",
                              compared_rows=len(rows), summary=summary), ensure_ascii=False))


def run(raw, results, targets):
    started = time.monotonic()
    cfg = json.loads(reference.CONFIG.read_text(encoding="utf-8"))
    paths = [raw / target.key / filename for target, _, filename, _ in iter_products(select_targets(targets))]
    paths += [FIXTURE / "checksums.json", FIXTURE / "references.csv", BENCH / "uv.lock",
              BENCH / "pyproject.toml", ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "configs", FIXTURE / "configs", BENCH / "tess_bench",
                      FIXTURE / "tess_fixture", ROOT / "libs/astro-kernel/astro_kernel"):
        paths += sorted(directory.glob("*.json" if directory.name == "configs" else "*.py"))
    entries = [mf.file_entry(p) for p in sorted(set(paths))]
    out = results / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-123", inputs=entries, targets=targets, rule=kernel.RULE,
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                reference_config=cfg, fine_tune={"half_width_cells": 3},
                tolerances=dict(flux_rtol=1e-12, flux_atol=1e-14, scatter_rtol=1e-10, scatter_atol=1e-14),
                limitation="local reference parity, not operational QA tolerance approval or Gold publication",
                identity_approval="synthetic-regression-only", discoverability_approval="synthetic-regression-only")
    write_json(out / "plan.json", plan)
    plan_entry = mf.file_entry(out / "plan.json")
    print(f"Plan: {out / 'plan.json'}", flush=True)
    rows = []
    try:
        bls_cfg, _ = reference.load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
        _, pre = reference.load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
        for target_key in targets:
            target = select_targets([target_key])[0]
            inputs = reference.build_bls_inputs(target_key, "tuning", bls_cfg, pre[0],
                FIXTURE / "configs/injection_grid_v1.json", raw, noise_seeds=[])
            base = inputs.baselines["realclean"]
            groups = [(gid, members) for gid, members in inputs.groups["realclean"].items() if not members or len(members) == 2]
            require(len(groups) == 4, "expected four groups")
            for gid, members in groups:
                flux = reference.inj.inject_group(base, members) if members else base.flux.copy()
                prepared = reference.detrend_silver(base.time, flux, base.sector_of_point)
                require(prepared.status == "ok", "preprocessing failed")
                segments, max_delta = [], 0.
                for sector in np.unique(base.sector_of_point):
                    selected = base.sector_of_point == sector
                    binned, delta = compare_segments(prepared.time[selected], prepared.flux_det[selected])
                    max_delta = max(max_delta, delta)
                    products = {filename: next(e["sha256"] for e in entries if Path(e["path"]).name == filename)
                                for _, s, filename, _ in iter_products([target]) if s == sector}
                    revision = segment_revision(tic_id=int(target.tic_id), sector=int(sector),
                        snapshot_id=plan_entry["sha256"], products=products,
                        preprocessing_version=prepared.version,
                        preprocessing_parameters=dict(setting="biweight_1.0d", interval_masks=[], fixture_group=gid))
                    segments.append(dict(tic_id=int(target.tic_id), sector=int(sector), binning_revision=revision, **binned.values()))
                source = reference.iterate_bls(prepared.time, prepared.flux_det, sector=base.sector_of_point,
                    baseline_time=prepared.time, input_snapshot_id=plan_entry["sha256"], preprocessing_version=prepared.version)
                n = len(rows)
                kwargs = dict(tic_id=int(target.tic_id), bundle_id=100 + n)
                initial = build_candidate_catalog(source, **kwargs)
                ids = {peak: 10000 + n * 100 + i for i, peak in enumerate(initial["needed_new_peak_ids"])}
                catalog = build_candidate_catalog(source, **kwargs, new_candidate_ids=ids,
                                                  identity_approval=plan["identity_approval"])
                # Re-evaluate the SAME identified candidates under the frozen 115
                # grid. This is a comparison snapshot, never an existing DB Bundle.
                rt, rf, _ = reference.provided_curve(prepared.time, prepared.flux_det, base.sector_of_point, 10.)
                old_periods = reference.period_grid(.5, max([40.] + [r["period_days"] for r in source["accepted"]]), 5000, spacing="log")
                old_evaluations, old_candidates = [], []
                if catalog["catalog_ready"]:
                    for c in catalog["proposed_candidates"]:
                        if c["status"] != "active":
                            continue
                        prior = [r["transit_model"] for r in source["accepted"] if r["step"] < c["removal_step"]]
                        verdict, _, _ = reference.evaluate(rt, rf, prior, c["transit_model"], cfg, old_periods)
                        old_evaluations.append(dict(candidate_id=c["candidate_id"], **verdict))
                        old_candidates.append(dict(deepcopy(c), discoverable=verdict["discoverable"]))
                old_snapshot = None
                if old_candidates and all(type(c["discoverable"]) is bool for c in old_candidates):
                    old_snapshot = dict(tic_id=int(target.tic_id), bundle_id=100000 + n, complete=True,
                        candidates=old_candidates, candidate_quality_revision="115-comparison-" + plan_entry["sha256"])
                result = kernel.prepare_discoverability(dict(segments=segments, quarantined=[]), catalog,
                    fine_tune=plan["fine_tune"], candidate_quality_version=source["candidate_quality_version"],
                    rule_approval=plan["discoverability_approval"], previous_bundle=old_snapshot)
                # 115 uses the original 114 binned values, making this an end-to-end
                # check of the tiny mean differences as well as classification.
                for verdict, artifact in zip(result["evaluations"], result["periodograms"], strict=True):
                    c = next((c for c in catalog["proposed_candidates"] if c["candidate_id"] == verdict["candidate_id"]), None)
                    prior = [r["transit_model"] for r in source["accepted"] if c and r["step"] < c["removal_step"]]
                    model = c["transit_model"] if c else None
                    # Same new grid for implementation parity; old/new policy
                    # differences belong in changes, not in the parity assertion.
                    periods = reference.period_grid(.5, result["period_max_days"], 5000, spacing="log")
                    expected, residual, pg = reference.evaluate(rt, rf, prior, model, cfg, periods)
                    require(expected["status"] == verdict["status"] and expected["discoverable"] == verdict["discoverable"], "115 verdict mismatch")
                    require(expected.get("matched_grid_indices") == verdict.get("matched_grid_indices"), "matched peaks differ")
                    require([p["grid_index"] for p in expected["qualified_peaks"]] == [p["grid_index"] for p in verdict["qualified_peaks"]], "quality peaks differ")
                    np.testing.assert_allclose(artifact["flux"], residual, rtol=1e-12, atol=1e-14, equal_nan=True)
                    if pg is not None:
                        np.testing.assert_allclose(artifact["periodogram"].power, pg.power, rtol=1e-8, atol=1e-10)
                    stage = len(list(out.glob(f"curve-{n:03d}-*.npz")))
                    arrays = dict(time=artifact["time"], flux=artifact["flux"], periods=periods)
                    if artifact["periodogram"] is not None:
                        arrays.update(power=artifact["periodogram"].power, snr=artifact["periodogram"].snr, sde=artifact["periodogram"].sde)
                    np.savez_compressed(out / f"curve-{n:03d}-{stage:02d}.npz", **arrays)
                write_json(out / f"curve-{n:03d}.json", dict(source=source, segments=segments,
                    comparison_scope="same-ID synthetic Bundle transition; not member reopening or DB publication",
                    previous_grid_max_days=float(old_periods[-1]), previous_evaluations=old_evaluations,
                    result={k: v for k, v in result.items() if k != "periodograms"}))
                rows.append(dict(target=target_key, group=gid, passed=True, max_bin_flux_abs_error=max_delta,
                                 status=result["status"], reasons=result["reasons"], changes=result["changes"],
                                 compared_stages=len(result["evaluations"])))
                print(f"{target_key}/{gid}: parity passed, {result['status']}", flush=True)
        verify_snapshot(entries + [plan_entry])
        write_json(out / "comparisons.json", rows)
        outputs = [mf.file_entry(p) for p in sorted(out.iterdir()) if p.name != "plan.json"]
        write_json(out / "manifest.json", dict(task="S15P21C206-123", passed=True, n_curves=len(rows),
            wall_seconds=time.monotonic() - started, plan=plan_entry, outputs=outputs))
        print(f"PASS: {out / 'manifest.json'}", flush=True)
    except BaseException as exc:
        write_json(out / "failure.json", dict(passed=False, reason=str(exc), completed_curves=len(rows)))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=BENCH / "results/segmentation-regression")
    parser.add_argument("--targets", nargs="+", choices=reference.TARGETS, default=list(reference.TARGETS))
    parser.add_argument("--saved-115", type=Path, help="verify saved ZIP only; never runs FITS experiment")
    args = parser.parse_args()
    if args.saved_115:
        audit_saved_115(args.saved_115)
    else:
        run(args.raw, args.results, args.targets)


if __name__ == "__main__":
    main()

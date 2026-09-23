"""122 real FITS parity against the approved 111 loop, without truth-assisted QA."""
import argparse
from dataclasses import asdict, replace
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from uuid import uuid4

import numpy as np
from astro_kernel.iteration import iterate_bls
from astro_kernel.bls import search_bls, QUALITY_VERSION, RUNNING_MEDIAN_QUALITY_VERSION
from astro_kernel.transit_model import remove_transit_models
from astro_kernel.preprocessing import detrend_silver
from tess_fixture import inject as inj, manifest as mf
from tess_fixture.targets import select_targets, iter_products
from .bls import load_bls_settings
from .cli import build_bls_inputs
from .iterate import IterateConfig, iterate_curve
from .preprocess import load_settings
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot, write_csv

TARGETS = ("toi270", "toi451", "wasp62", "pi_men")


def compare(reference, actual):
    """Require identical decisions and compare every reference metric and residual."""
    for candidate in actual["accepted"]:
        power = candidate.get("bls_power")
        if type(power) not in (int, float) or not np.isfinite(power) or power <= 0:
            raise AssertionError("accepted candidate requires finite positive bls_power")
    for key in ("termination", "qa_failed_step"):
        if actual[key] != getattr(reference, key):
            raise AssertionError(f"{key}: {actual[key]!r} != {getattr(reference, key)!r}")
    actual_steps = actual["steps"]
    if reference.termination == "candidate_validation_failed":
        # 111 only changed its top-level termination. 122 now records the final
        # original-validation failure explicitly, preserving the search history.
        last = actual_steps[-1]
        failed = [c.step for c in reference.accepted if c.validated_on_original is False]
        expected = dict(phase="original_validation", status="error",
                        reason="candidate_validation_failed", failed_candidate_steps=failed,
                        search_termination=reference.steps[-1].reason)
        if not failed or any(last.get(key) != value for key, value in expected.items()):
            raise AssertionError("inconsistent original-validation terminal record")
        actual_steps = actual_steps[:-1]
    for collection in ("accepted", "steps"):
        records = actual_steps if collection == "steps" else actual[collection]
        for index, (old, new) in enumerate(zip(getattr(reference, collection), records, strict=True)):
            for key, value in asdict(old).items():
                if key == "bls_elapsed_s":
                    continue
                other = new[key]
                if isinstance(value, float):
                    if not np.isfinite(value):
                        if other is not None:
                            raise AssertionError(f"{collection}[{index}].{key}: expected null")
                    else:
                        np.testing.assert_allclose(other, value, rtol=1e-12, atol=0,
                                                   err_msg=f"{collection}[{index}].{key}")
                elif other != value:
                    raise AssertionError(f"{collection}[{index}].{key}: {other!r} != {value!r}")
    np.testing.assert_allclose(actual["residual"], reference.residual, rtol=1e-12, atol=0, equal_nan=True)


DIAGNOSTIC_FIELDS = ("period_days", "epoch_btjd", "duration_hours", "sector_stats",
                     "sector_consistency_status", "mask_dropped_fraction", "diagnostic_reasons")


def compare_diagnostic(expected, actual, path="search_diagnostics"):
    """Compare nested 120 diagnostics without allowing omitted/null measurements."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or actual.keys() != expected.keys():
            raise AssertionError(f"{path}: diagnostic keys differ")
        for key in expected:
            compare_diagnostic(expected[key], actual[key], f"{path}.{key}")
    elif isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            raise AssertionError(f"{path}: diagnostic rows differ")
        for index, (left, right) in enumerate(zip(expected, actual, strict=True)):
            compare_diagnostic(left, right, f"{path}[{index}]")
    elif isinstance(expected, float):
        if type(actual) not in (int, float) or not np.isfinite(actual):
            raise AssertionError(f"{path}: finite measurement required")
        np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=0, err_msg=path)
    elif type(actual) is not type(expected) or actual != expected:
        raise AssertionError(f"{path}: {actual!r} != {expected!r}")


def compare_search_diagnostics(time, flux, sector, baseline_time, reference, actual, *,
                               input_snapshot_id, preprocessing_version, quality_version=QUALITY_VERSION):
    # Rebuild each pre-removal residual from 111's accepted models, not from
    # actual's model/diagnostic fields. Direct 120 calls are the transfer oracle.
    current = np.asarray(flux, dtype=float).copy()
    for expected_candidate, candidate in zip(reference.accepted, actual["accepted"], strict=True):
        searched = search_bls(time, current, sector=sector, baseline_time=baseline_time,
                              input_snapshot_id=input_snapshot_id,
                              preprocessing_version=preprocessing_version, quality_version=quality_version)
        if searched["status"] == "failed":
            raise AssertionError("diagnostic reference search failed")
        peaks = [peak for peak in searched["peaks"] if peak["rank"] == expected_candidate.rank]
        if len(peaks) != 1:
            raise AssertionError("reference coarse rank not found")
        expected = {key: peaks[0][key] for key in DIAGNOSTIC_FIELDS}
        compare_diagnostic(expected, candidate.get("search_diagnostics"))
        current = remove_transit_models(time, current,
            [expected_candidate.model(f"reference-step-{expected_candidate.step}")]).flux_residual


def reference_iteration(time, flux, setting, cfg, quality_version):
    if quality_version == QUALITY_VERSION:
        return iterate_curve(time, flux, setting, cfg, keep_residual=True)
    # Isolated benchmark adapter: retain the 111 loop/QA, replace only its SDE
    # using the independent 243 experimental definition, never the kernel helper.
    from unittest.mock import patch
    from . import bls as reference_bls
    from .sde_review import sde_arrays
    original = reference_bls.run_bls
    def reviewed_search(*args, **kwargs):
        kwargs["keep_periodogram"] = True
        result = original(*args, **kwargs)
        scores = sde_arrays(result.periods, result.power)["running_median"]
        result.peaks[:] = [replace(p, sde=float(scores[np.searchsorted(result.periods, p.period_days)]))
                           for p in result.peaks]
        return result
    with patch.object(reference_bls, "run_bls", reviewed_search):
        return iterate_curve(time, flux, setting, cfg, keep_residual=True)


def run(raw, results, targets=TARGETS, quality_version=QUALITY_VERSION):
    cfg, settings = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    approved = IterateConfig(qa_window_offset_rel_depth=0.1, refine_duration_span=(0.5, 2.0),
                             refine_duration_max_hours=12.0)
    if quality_version == RUNNING_MEDIAN_QUALITY_VERSION:
        approved = replace(approved, sde_min=8.0)
    paths = [raw / target.key / filename for target, _, filename, _ in iter_products(select_targets(list(targets)))]
    paths += [FIXTURE / "checksums.json", FIXTURE / "references.csv", FIXTURE / "configs/injection_grid_v1.json",
              BENCH / "uv.lock", BENCH / "pyproject.toml", ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "configs", BENCH / "tess_bench", FIXTURE / "tess_fixture", ROOT / "libs/astro-kernel/astro_kernel"):
        paths += sorted(directory.glob("*.json" if directory.name == "configs" else "*.py"))
    entries = [mf.file_entry(path) for path in paths]
    out = results / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-243" if quality_version == RUNNING_MEDIAN_QUALITY_VERSION else "S15P21C206-122", candidate_quality_version=quality_version, inputs=entries, targets=list(targets),
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                reference_settings=settings[0].params(), iteration_settings=approved.params(),
                rtol=1e-12, atol=0,
                diagnostic_baseline="prepared.time: post-baseline input before detrend masking; not original FITS QUALITY rows",
                diagnostic_reference="direct 120 search on sequentially removed 111 accepted models",
                scope="realclean: no injection plus all three registered two-signal groups; no holdout; no truth-assisted QA",
                limitation="current-reference parity on existing fixtures, not reproduction of the full 111 oracle-assisted experiment")
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    plan_entry = mf.file_entry(out / "plan.json")
    print(f"Plan: {out / 'plan.json'}", flush=True)
    started = time.perf_counter()
    rows = []
    try:
        for target in targets:
            bi = build_bls_inputs(target, "tuning", cfg, pre[0], FIXTURE / "configs/injection_grid_v1.json", raw, noise_seeds=[])
            baseline = bi.baselines["realclean"]
            groups = [(gid, members) for gid, members in bi.groups["realclean"].items() if not members or len(members) == 2]
            if len(groups) != 4:
                raise ValueError("expected three registered pairs and one unmodified realclean curve")
            for gid, members in groups:
                flux = inj.inject_group(baseline, members) if members else baseline.flux.copy()
                prepared = detrend_silver(baseline.time, flux, baseline.sector_of_point)
                if prepared.status != "ok":
                    raise ValueError(f"preprocessing failed: {target}/{gid}")
                reference = reference_iteration(prepared.time, prepared.flux_det, settings[0], approved, quality_version)
                actual = iterate_bls(prepared.time, prepared.flux_det, sector=baseline.sector_of_point,
                                     baseline_time=prepared.time,
                                     input_snapshot_id=plan_entry["sha256"], preprocessing_version=prepared.version,
                                     keep_residual=True, quality_version=quality_version)
                compare(reference, actual)
                compare_search_diagnostics(prepared.time, prepared.flux_det, baseline.sector_of_point,
                    prepared.time, reference, actual, input_snapshot_id=plan_entry["sha256"],
                    preprocessing_version=prepared.version, quality_version=quality_version)
                record = {key: value for key, value in actual.items() if key != "residual"}
                filename = f"curve-{len(rows):03d}.json"
                (out / filename).write_text(json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
                rows.append(dict(target=target, group=gid, passed=True, termination=actual["termination"],
                                 n_accepted=len(actual["accepted"]), qa_failed_step=actual["qa_failed_step"], output=filename))
                print(f"{target}/{gid}: parity passed ({actual['termination']}, {len(actual['accepted'])} accepted)", flush=True)
        verify_snapshot(entries + [plan_entry])
        write_csv(out / "comparisons.csv", rows)
        manifest = dict(task=plan["task"], candidate_quality_version=quality_version, passed=True, plan=plan_entry, n_curves=len(rows),
                        wall_s=time.perf_counter() - started,
                        outputs=[mf.file_entry(path) for path in sorted(out.glob("curve-*.json"))] + [mf.file_entry(out / "comparisons.csv")])
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"PASS: {out / 'manifest.json'}", flush=True)
    except BaseException as exc:
        (out / "failure.json").write_text(json.dumps(dict(passed=False, plan=plan_entry, completed_curves=len(rows), reason=str(exc)), indent=2) + "\n", encoding="utf-8")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=BENCH / "results/iteration-kernel-regression")
    parser.add_argument("--targets", nargs="+", choices=tuple(dict.fromkeys((*TARGETS, "l98_59", "cm_dra", "wasp18", "toi700", "hd21749"))), default=list(TARGETS))
    parser.add_argument("--quality-version", choices=[QUALITY_VERSION, RUNNING_MEDIAN_QUALITY_VERSION], default=QUALITY_VERSION)
    args = parser.parse_args()
    run(args.raw, args.results, args.targets, args.quality_version)


if __name__ == "__main__":
    main()

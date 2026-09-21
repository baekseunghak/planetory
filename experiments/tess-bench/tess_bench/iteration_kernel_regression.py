"""122 real FITS parity against the approved 111 loop, without truth-assisted QA."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from uuid import uuid4

import numpy as np
from astro_kernel.iteration import iterate_bls
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
    for collection in ("accepted", "steps"):
        for index, (old, new) in enumerate(zip(getattr(reference, collection), actual[collection], strict=True)):
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


def run(raw, results, targets=TARGETS):
    cfg, settings = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    approved = IterateConfig(qa_window_offset_rel_depth=0.1, refine_duration_span=(0.5, 2.0),
                             refine_duration_max_hours=12.0)
    paths = [raw / target.key / filename for target, _, filename, _ in iter_products(select_targets(list(targets)))]
    paths += [FIXTURE / "checksums.json", FIXTURE / "references.csv", FIXTURE / "configs/injection_grid_v1.json",
              BENCH / "uv.lock", BENCH / "pyproject.toml", ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "configs", BENCH / "tess_bench", FIXTURE / "tess_fixture", ROOT / "libs/astro-kernel/astro_kernel"):
        paths += sorted(directory.glob("*.json" if directory.name == "configs" else "*.py"))
    entries = [mf.file_entry(path) for path in paths]
    out = results / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-122", inputs=entries, targets=list(targets),
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                reference_settings=settings[0].params(), iteration_settings=approved.params(),
                rtol=1e-12, atol=0,
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
                reference = iterate_curve(prepared.time, prepared.flux_det, settings[0], approved, keep_residual=True)
                actual = iterate_bls(prepared.time, prepared.flux_det, sector=baseline.sector_of_point,
                                     input_snapshot_id=plan_entry["sha256"], preprocessing_version=prepared.version,
                                     keep_residual=True)
                compare(reference, actual)
                record = {key: value for key, value in actual.items() if key != "residual"}
                filename = f"curve-{len(rows):03d}.json"
                (out / filename).write_text(json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
                rows.append(dict(target=target, group=gid, passed=True, termination=actual["termination"],
                                 n_accepted=len(actual["accepted"]), qa_failed_step=actual["qa_failed_step"], output=filename))
                print(f"{target}/{gid}: parity passed ({actual['termination']}, {len(actual['accepted'])} accepted)", flush=True)
        verify_snapshot(entries + [plan_entry])
        write_csv(out / "comparisons.csv", rows)
        manifest = dict(task="S15P21C206-122", passed=True, plan=plan_entry, n_curves=len(rows),
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
    parser.add_argument("--targets", nargs="+", choices=TARGETS, default=list(TARGETS))
    args = parser.parse_args()
    run(args.raw, args.results, args.targets)


if __name__ == "__main__":
    main()

"""120 user-run D04 parity check on tuning fixtures; no Git or downloads."""
import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import numpy as np

from astro_kernel.bls import search_bls
from astro_kernel.preprocessing import detrend_silver
from tess_fixture import inject as inj, manifest as mf
from tess_fixture.targets import select_targets, iter_products
from .bls import load_bls_settings, run_bls
from .bls_match import match_injection
from .cli import build_bls_inputs
from .preprocess import load_settings, preprocess
from .silver_regression import ROOT, BENCH, FIXTURE, verify_snapshot, write_csv


def compare(reference, actual):
    """Compare the full grid and every ranked peak, including gate decisions."""
    np.testing.assert_array_equal(actual["periodogram"].periods, reference.periods)
    np.testing.assert_allclose(actual["periodogram"].power, reference.power, rtol=1e-12, atol=0)
    if actual["status"] == "failed":
        raise ValueError("kernel peak failure")
    for peak, old in zip(actual["peaks"], reference.peaks, strict=True):
        for key in ("period_days", "epoch_btjd", "duration_hours", "depth", "depth_err",
                    "power", "sde", "snr", "n_transits", "n_in_transit", "mask_dropped_fraction"):
            np.testing.assert_allclose(peak[key], getattr(old, key), rtol=1e-12, atol=0)
        if (peak["status"] == "accepted") != (old.snr >= 7 and old.sde >= 6):
            raise ValueError("quality gate mismatch")


def run(raw, results):
    cfg, settings = load_bls_settings(BENCH / "configs/bls_settings_v1.json", ["poc_linear20k"])
    _, pre = load_settings(BENCH / "configs/preprocess_settings_v1.json", ["biweight_1.0d"])
    targets = cfg["stages"]["tuning"]["targets"]
    paths = [raw / target.key / filename for target, _, filename, _ in
             iter_products(select_targets(targets))]
    paths += [FIXTURE / "checksums.json", FIXTURE / "references.csv",
              FIXTURE / "configs/injection_grid_v1.json", BENCH / "uv.lock",
              BENCH / "pyproject.toml", ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "configs", BENCH / "tess_bench", FIXTURE / "tess_fixture",
                      ROOT / "libs/astro-kernel/astro_kernel"):
        paths += sorted(directory.glob("*.json" if directory.name == "configs" else "*.py"))
    entries = [mf.file_entry(path) for path in paths]
    out = results / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-120", inputs=entries, targets=targets,
                environment=mf.environment_info(("numpy", "astropy", "scipy")),
                reference_settings=settings[0].params(), rtol=1e-12, atol=0,
                scope="tuning realclean + seed 20260910; all registered injection groups; no holdout",
                limitation="current reference parity, not new independent evaluation or historical environment reproduction")
    (out / "plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    plan_entry = mf.file_entry(out / "plan.json")
    print(f"Plan: {out / 'plan.json'}", flush=True)
    started = time.perf_counter()
    rows, matches = [], []
    try:
        for target in targets:
            bi = build_bls_inputs(target, "tuning", cfg, pre[0],
                                  FIXTURE / "configs/injection_grid_v1.json", raw, noise_seeds=[20260910])
            for bkey, groups in bi.groups.items():
                baseline = bi.baselines[bkey]
                for gid, members in groups.items():
                    flux = inj.inject_group(baseline, members) if members else baseline.flux.copy()
                    old_pre = preprocess(baseline.time, flux, baseline.sector_of_point, pre[0])
                    new_pre = detrend_silver(baseline.time, flux, baseline.sector_of_point)
                    if old_pre.status != "ok" or new_pre.status != "ok":
                        raise ValueError(f"preprocessing failed: {target}/{bkey}/{gid}")
                    np.testing.assert_array_equal(old_pre.kept, new_pre.kept)
                    np.testing.assert_array_equal(old_pre.flux_det, new_pre.flux_det)
                    reference = run_bls(old_pre.time, old_pre.flux_det, settings[0],
                                        baseline_time=baseline.time, keep_periodogram=True)
                    actual = search_bls(new_pre.time, new_pre.flux_det, sector=baseline.sector_of_point,
                                        baseline_time=baseline.time, input_snapshot_id=plan_entry["sha256"],
                                        preprocessing_version=new_pre.version)
                    compare(reference, actual)
                    rows.append(dict(target=target, baseline=bkey, group=gid, passed=True,
                                     status=actual["status"], n_accepted=actual["n_accepted"]))
                    old_peaks = [p for p in reference.peaks if p.snr >= 7 and p.sde >= 6]
                    new_peaks = [SimpleNamespace(**p) for p in actual["accepted_peaks"]]
                    for member in members:
                        old_match = match_injection(baseline.time, member, old_peaks)
                        new_match = match_injection(baseline.time, member, new_peaks)
                        if (old_match.match, old_match.matched_rank) != (new_match.match, new_match.matched_rank):
                            raise ValueError("injection recovery mismatch")
                        matches.append(dict(target=target, baseline=bkey, **new_match.as_row()))
            print(f"{target}: parity passed", flush=True)
        verify_snapshot(entries + [plan_entry])
        write_csv(out / "comparisons.csv", rows)
        write_csv(out / "matches.csv", matches)
        manifest = dict(task="S15P21C206-120", passed=True, plan=plan_entry,
                        n_curves=len(rows), n_signals=len(matches), wall_s=time.perf_counter() - started,
                        outputs=[mf.file_entry(out / name) for name in ("comparisons.csv", "matches.csv")])
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"PASS: {out / 'manifest.json'}", flush=True)
    except BaseException as exc:
        (out / "failure.json").write_text(json.dumps(dict(passed=False, reason=str(exc))), encoding="utf-8")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=BENCH / "results/bls-kernel-regression")
    args = parser.parse_args()
    run(args.raw, args.results)


if __name__ == "__main__":
    main()

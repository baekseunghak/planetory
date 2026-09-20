"""119 parity regression against D03. User-run real-data validation, no BLS.

The plan (all file hashes, environment and exact-equality criterion) is saved
before numerical work. No Git subprocess or download is performed.
"""
import argparse
import csv
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np
from astropy.io import fits

from astro_kernel.fits_adapter import parse_spoc_hdul
from astro_kernel.preprocessing import prepare_silver, detrend_silver, preprocessing_config
from tess_fixture import download as dl, inject as inj, manifest as mf
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.targets import select_targets, iter_products
from .preprocess import load_settings, preprocess
from .metrics import signal_metrics, summarize

ROOT = Path(__file__).resolve().parents[3]
BENCH = ROOT / "experiments/tess-bench"
FIXTURE = ROOT / "experiments/tess-fixture"
TARGETS = ("toi270", "toi451", "wasp62", "pi_men")


def exact(a, b):
    return bool(np.array_equal(np.asarray(a), np.asarray(b), equal_nan=True))


def compare_results(reference, actual):
    fields = ("time", "flux_in", "trend", "flux_det", "kept", "segment_id", "segment_edges", "noise_scatter")
    return {name: exact(getattr(reference, name), getattr(actual, name)) for name in fields}


def write_csv(path, rows):
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def verify_snapshot(entries):
    for entry in entries:
        if dl.sha256_of(Path(entry["path"])) != entry["sha256"]:
            raise ValueError(f"input changed: {entry['path']}")


def run(raw, results):
    settings_path = BENCH / "configs/preprocess_settings_v1.json"
    grid_path = FIXTURE / "configs/injection_grid_v1.json"
    checksums_path = FIXTURE / "checksums.json"
    expected = dl.load_expected_checksums(checksums_path)
    _, settings = load_settings(settings_path, ["biweight_1.0d"])
    setting = settings[0]
    expected_params = dict(quality_bitmask=None, gap_days=0.5, split_sectors=False,
                           detrend_method="biweight", window_days=1.0, sigma_upper=5.0,
                           min_points=500, biweight_stride=10, edge_mask_hours=0.0,
                           stage1_method=None, stage1_window_days=None)
    if setting.params() != expected_params:
        raise ValueError("D03 reference setting changed; review before running")
    grid = inj.load_grid(grid_path)
    if grid["version"] != "1.1.0":
        raise ValueError("expected injection grid 1.1.0")
    products, entries = [], []
    for target, sector, filename, _ in iter_products(select_targets(list(TARGETS))):
        path = raw / target.key / filename
        if filename not in expected:
            raise ValueError(f"unregistered fixture checksum: {filename}")
        entry = mf.file_entry(path, target=target.key, sector=sector, role="raw_product")
        if entry["sha256"] != expected[filename]:
            raise ValueError(f"fixture checksum mismatch: {filename}")
        products.append((target, path))
        entries.append(entry)
    source_paths = [settings_path, grid_path, checksums_path, BENCH / "uv.lock",
                    BENCH / "pyproject.toml", FIXTURE / "pyproject.toml",
                    ROOT / "libs/astro-kernel/pyproject.toml"]
    for directory in (BENCH / "tess_bench", FIXTURE / "tess_fixture",
                      ROOT / "libs/astro-kernel/astro_kernel"):
        source_paths.extend(sorted(directory.glob("*.py")))
    entries.extend(mf.file_entry(p, role="code_or_config") for p in source_paths)
    environment = mf.environment_info(("numpy", "astropy", "scipy"))
    plan = dict(task="S15P21C206-119", inputs=entries, environment=environment,
                settings=preprocessing_config(), reference_params=setting.params(),
                targets=TARGETS, grid_version=grid["version"],
                tolerance=dict(rtol=0, atol=0, equal_nan=True,
                               reason="same float64 arithmetic in the same Python/NumPy process"),
                scope="real baseline + 108 single + 3 pair groups per target; no noise/BLS",
                limitations=["not a repeat of the historical execution environment",
                             "grid 1.1.0; historical rounded tables are context, not exact arrays"])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = results / f"run-{stamp}-{uuid4().hex[:8]}"
    out.mkdir(parents=True, exist_ok=False)
    plan_path = out / "plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    plan_entry = mf.file_entry(plan_path, role="preregistered_plan")
    print(f"Plan fixed: {plan_path}", flush=True)
    started = time.perf_counter()
    comparisons, metric_rows, summaries, metadata = [], [], [], []
    try:
        verify_snapshot(entries)
        for key in TARGETS:
            paths = [p for target, p in products if target.key == key]
            curves, reference_curves = [], []
            for path in paths:
                with fits.open(path, memmap=False) as hdul:
                    curve, meta = parse_spoc_hdul(hdul, product_id=path.name)
                expected_entry = next(e for e in entries if e["path"] == str(path))
                if (curve.tic_id != select_targets([key])[0].tic_id or
                        curve.sector != expected_entry["sector"]):
                    raise ValueError("TIC/Sector mismatch")
                curves.append(curve)
                reference_curves.append(load_sector(path))
                metadata.append(dict(product_id=path.name, **meta))
            prepared = prepare_silver(curves)
            baseline = build_baseline(reference_curves)
            if not all((exact(prepared.time, baseline.time), exact(prepared.flux, baseline.flux),
                        exact(prepared.sector, baseline.sector_of_point),
                        prepared.normalization_median == baseline.normalization_median)):
                raise ValueError(f"baseline mismatch: {key}")
            rows = inj.build_catalog(grid, baseline, f"{key}-real", inj.grid_set_id(grid))
            groups = {"baseline": []}
            for row in rows:
                groups.setdefault(row.group_id, []).append(row)
            by_impl = {"reference": [], "kernel": []}
            for group_id, members in groups.items():
                flux = inj.inject_group(baseline, members)
                old = preprocess(baseline.time, flux, baseline.sector_of_point, setting)
                new = detrend_silver(prepared.time, flux, prepared.sector)
                checks = compare_results(old, new)
                checks["failures"] = old.failures == new.failures
                checks["status"] = old.status == new.status
                comparisons.append(dict(target=key, group_id=group_id, passed=all(checks.values()), **checks))
                for impl, result in (("reference", old), ("kernel", new)):
                    for member in members:
                        row = signal_metrics(result, members, member).as_row()
                        by_impl[impl].append(row)
                        metric_rows.append(dict(target=key, implementation=impl, **row))
            old_summary, new_summary = (summarize(by_impl[k]) for k in ("reference", "kernel"))
            summary_match = all(exact(old_summary[k], new_summary[k]) for k in old_summary)
            for impl, summary in (("reference", old_summary), ("kernel", new_summary)):
                summaries.append(dict(target=key, implementation=impl, summary_match=summary_match, **summary))
            count = sum(c["passed"] for c in comparisons if c["target"] == key)
            print(f"{key}: {count}/{len(groups)} curves equal; summary={summary_match}", flush=True)
        verify_snapshot(entries + [plan_entry])
        write_csv(out / "comparisons.csv", comparisons)
        write_csv(out / "metrics.csv", metric_rows)
        write_csv(out / "summary.csv", summaries)
        passed = all(r["passed"] for r in comparisons) and all(r["summary_match"] for r in summaries)
        manifest = dict(schema="planetory.silver-regression.v1", task="S15P21C206-119",
                        passed=passed, plan=plan_entry, inputs=entries, environment=environment,
                        code_identity="file SHA-256 (Git not invoked)", product_metadata=metadata,
                        wall_s=time.perf_counter() - started,
                        outputs=[mf.file_entry(out / name) for name in ("comparisons.csv", "metrics.csv", "summary.csv")])
        (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"passed={passed}; {out / 'manifest.json'}", flush=True)
        return 0 if passed else 1
    except Exception as exc:
        (out / "failure.json").write_text(json.dumps(dict(status="failed", reason=str(exc),
                                                         plan=plan_entry), ensure_ascii=False, indent=2), encoding="utf-8")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=BENCH / "results/silver-regression")
    args = parser.parse_args()
    return run(args.raw, args.results)


if __name__ == "__main__":
    sys.exit(main())

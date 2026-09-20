"""114: sector binning experiment, independent of BLS/holdout selection.

Run with ``python -m tess_bench.binning --target l98_59``.
This is an experimental rule proposal, not the production Gold writer.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import shlex
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.stats import binned_statistic

from tess_fixture import download as dl, manifest as mf
from tess_fixture.lightcurve import build_baseline, load_sector
from tess_fixture.targets import iter_products, select_targets
from .preprocess import load_settings, preprocess

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT.parent / "tess-fixture"


@dataclass
class Binned:
    start: float
    minutes: float
    flux: np.ndarray
    counts: np.ndarray

    @property
    def centers(self):
        return self.start + (np.arange(len(self.flux)) + 0.5) * self.minutes / 1440

    @property
    def gaps(self):
        empty = np.flatnonzero(self.counts == 0)
        return [[int(a[0]), int(a[-1])] for a in np.split(empty, np.where(np.diff(empty) > 1)[0] + 1) if len(a)]


def bin_curve(t, f, minutes=10.0, reducer="mean", max_points=20000, *, bounds=None):
    """Left-closed/right-open bins; last observed point always included.

    Anchor at first baseline point, including points rejected by detrending.
    Expand by an integer multiple of requested cadence until the cap is met.
    Missing/failed flux is never interpolated; counts retain partial bins.
    """
    t, f = np.asarray(t, dtype=float), np.asarray(f, dtype=float)
    if t.ndim != 1 or t.shape != f.shape or not len(t) or not np.all(np.isfinite(t)):
        raise ValueError("nonempty aligned 1D arrays and finite time required")
    if not np.isfinite(minutes) or minutes <= 0 or reducer not in ("mean", "median"):
        raise ValueError("invalid bin configuration")
    if isinstance(max_points, bool) or not isinstance(max_points, int) or max_points < 1:
        raise ValueError("max_points must be a positive integer")
    start, end = (float(t.min()), float(t.max())) if bounds is None else bounds
    if not np.isfinite([start, end]).all() or start > t.min() or end < t.max():
        raise ValueError("bounds must contain every time")
    span = (end - start) * 1440
    multiplier = max(1, math.floor(span / (minutes * max_points)) + 1)
    actual = minutes * multiplier
    # Snap floating point representations of exact edges, within 1e-8 bin.
    scaled = (t - start) * 1440 / actual
    scaled = np.where(np.abs(scaled - np.rint(scaled)) < 1e-8, np.rint(scaled), scaled)
    ids = np.floor(scaled).astype(np.int64)
    n = int(math.floor(span / actual + 1e-8)) + 1
    while n > max_points:
        multiplier += 1
        actual = minutes * multiplier
        scaled = (t - start) * 1440 / actual
        scaled = np.where(np.abs(scaled - np.rint(scaled)) < 1e-8, np.rint(scaled), scaled)
        ids = np.floor(scaled).astype(np.int64)
        n = int(math.floor(span / actual + 1e-8)) + 1
    valid = np.isfinite(f)
    counts = np.bincount(ids[valid], minlength=n)
    values = np.full(n, np.nan)
    if valid.any():
        values = binned_statistic(ids[valid], f[valid], statistic=reducer,
                                  bins=np.arange(n + 1) - 0.5).statistic
    return Binned(float(start), float(actual), values, counts)


def phase(t, period, epoch):
    return (np.asarray(t) - epoch + period / 2) % period - period / 2


def depth(t, f, period, epoch, duration):
    """Local OOT median minus transit median; NaN if undersampled."""
    d = np.abs(phase(t, period, epoch))
    valid = np.isfinite(f)
    inside = valid & (d < duration / 48)
    outside = valid & (d >= duration / 24) & (d < min(2 * duration / 24, period / 2))
    if inside.sum() < 3 or outside.sum() < 3:
        return float("nan"), int(inside.sum()), int(outside.sum())
    return float(np.median(f[outside]) - np.median(f[inside])), int(inside.sum()), int(outside.sum())


def scatter(f):
    finite = np.asarray(f)[np.isfinite(f)]
    return float(1.4826 * np.median(np.abs(finite - np.median(finite)))) if len(finite) else None


def revision(inputs, params):
    payload = json.dumps({"inputs": sorted(inputs), "params": params}, sort_keys=True,
                         separators=(",", ":"), allow_nan=False)
    return "bin-exp-v1-" + hashlib.sha256(payload.encode()).hexdigest()[:20]


def write_csv(path, rows):
    if not rows:
        raise ValueError(f"no rows for {path.name}")
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def plot_fold(path, title, t, f, bt, bf, period, epoch, duration):
    """Small standalone SVG diagnostic; finite points only, no gap interpolation."""
    series = []
    for times, flux, color in ((t, f, "#8899aa"), (bt, bf, "#d04a22")):
        x = phase(times, period, epoch) * 24
        keep = np.isfinite(flux) & (abs(x) <= duration * 2)
        x, y = x[keep], (flux[keep] - 1) * 1e6
        order = np.argsort(x)
        # Preview only: keep at most 1500 evenly indexed points in phase order.
        order = order[np.linspace(0, max(0, len(order) - 1), min(len(order), 1500), dtype=int)]
        series.append((x[order], y[order], color))
    values = np.concatenate([s[1] for s in series])
    lo, hi = (float(values.min()), float(values.max())) if len(values) else (-1, 1)
    pad = max((hi - lo) * .05, 1)
    lo, hi = lo - pad, hi + pad
    points = []
    for x, y, color in series:
        for xx, yy in zip(x, y):
            points.append(f'<circle cx="{70+(xx/(4*duration)+.5)*760:.2f}" cy="{330-(yy-lo)/(hi-lo)*250:.2f}" r="1.7" fill="{color}"/>')
    path.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="410" viewBox="0 0 900 410">'
        '<rect width="900" height="410" fill="white"/><g font-family="sans-serif" font-size="13">'
        f'<text x="20" y="25">{html.escape(title)}</text>'
        '<text x="20" y="48">Gray: pre-binning; orange: binned. Preview sampled; metrics use all points.</text>'
        f'<text x="20" y="75">flux - 1 (ppm), range {lo:.1f} .. {hi:.1f}</text>'
        '<path d="M70 80V330H830" fill="none" stroke="#333"/>'
        + ''.join(points) + f'<text x="70" y="360">{-2*duration:g} h</text><text x="440" y="360">0</text>'
        f'<text x="780" y="360">{2*duration:g} h</text><text x="250" y="390">Phase relative to transit center (hours)</text></g></svg>', encoding="utf-8")


def run(args):
    started = time.perf_counter()
    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    inj = cfg["injection"]
    if (not cfg["bin_minutes"] or not cfg["reducers"] or not inj["duration_hours"]
            or not inj["epoch_offset_minutes"] or not 0 < inj["depth_ppm"] < 1e6
            or not np.isfinite(inj["period_days"]) or inj["period_days"] <= 0
            or any(not np.isfinite(d) or not 0 < d / 24 < inj["period_days"] for d in inj["duration_hours"])
            or not np.isfinite(inj["epoch_offset_minutes"]).all()):
        raise ValueError("invalid experiment grid")
    for minutes in cfg["bin_minutes"]:
        for reducer in cfg["reducers"]:
            bin_curve([0], [1], minutes, reducer, cfg["max_points"])
    keys = args.target or cfg["targets"]
    if not set(keys) <= set(cfg["targets"]) or len(keys) != len(set(keys)):
        raise ValueError("only unique targets from the fixed nine-star set are allowed")
    targets = select_targets(keys)
    settings_path = ROOT / "configs/preprocess_settings_v1.json"
    _, settings = load_settings(settings_path, [cfg["preprocess_setting"]])
    setting = settings[0]
    checksums_path, refs_path = FIXTURE / "checksums.json", FIXTURE / "references.csv"
    expected = dl.load_expected_checksums(checksums_path)
    products = list(iter_products(targets))
    # Preflight the entire selected set before allocating a run or doing science.
    inputs = [mf.file_entry(p) for p in (args.config, settings_path, checksums_path, refs_path)]
    for target, sector, filename, url in products:
        path = args.raw / target.key / filename
        if not path.is_file():
            raise ValueError(f"missing {path}; download {target.key} with tess_fixture first")
        entry = mf.file_entry(path, target=target.key, sector=sector, source_uri=url)
        if filename not in expected or entry["sha256"] != expected[filename]:
            raise ValueError(f"unregistered/mismatched checksum: {filename}")
        inputs.append(entry)
    if args.check_inputs:
        print(f"inputs verified: {len(products)} FITS, {len(targets)} targets; no experiment run")
        return 0
    with refs_path.open(encoding="utf-8", newline="") as stream:
        references = list(csv.DictReader(stream))
    run_id = mf.new_run_id()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = args.results / "binning" / f"run-{stamp}-{run_id[:8]}"
    out.mkdir(parents=True, exist_ok=False)
    segment_rows, metric_rows, skipped = [], [], []
    code_files = [Path(__file__), ROOT / "tess_bench/preprocess.py", FIXTURE / "tess_fixture/lightcurve.py",
                  FIXTURE / "tess_fixture/targets.py", FIXTURE / "tess_fixture/manifest.py", ROOT / "uv.lock"]
    code_entries = [mf.file_entry(p, role="implementation") for p in code_files]
    inj = cfg["injection"]
    for target in targets:
        target_started = time.perf_counter()
        curves = [load_sector(args.raw / target.key / filename)
                  for _, sector, filename, url in iter_products((target,))]
        if any(c.tic_id != target.tic_id or c.sector != s for c, s in zip(curves, target.sectors)):
            raise ValueError("FITS TIC/Sector mismatch")
        baseline = build_baseline(curves, setting.quality_bitmask)
        processed = preprocess(baseline.time, baseline.flux, baseline.sector_of_point, setting)
        geometry = []
        for ref in (r for r in references if r["target_key"] == target.key):
            try:
                p, e, d = float(ref["pl_orbper"]), float(ref["pl_tranmid"]) - 2457000, float(ref["pl_trandur"])
                if ref["tran_flag"] != "1" or not np.isfinite([p, e, d]).all() or not 0 < d / 24 < p:
                    raise ValueError("non-transiting or invalid geometry")
                geometry.append((ref["pl_name"], p, e, d))
            except (ValueError, KeyError):
                skipped.append({"target": target.key, "name": ref.get("pl_name", ""), "reason": "non_transiting_or_missing_geometry"})
        for sector in baseline.sectors:
            mask = baseline.sector_of_point == sector
            t, f = baseline.time[mask], processed.flux_det[mask].copy()
            f[~processed.kept[mask]] = np.nan
            for minutes in cfg["bin_minutes"]:
                for reducer in cfg["reducers"]:
                    b = bin_curve(t, f, minutes, reducer, cfg["max_points"])
                    params = {"preprocess": setting.params(), "reducer": reducer, "requested_minutes": minutes,
                              "actual_minutes": b.minutes, "cap": cfg["max_points"], "version": cfg["version"],
                              "anchor": "first_quality_valid_sector_time", "interval": "left_closed_right_open",
                              "scatter": "1.4826*MAD_of_finite_binned_flux", "partial": "retain_with_count"}
                    hashes = [i["sha256"] for i in inputs if i.get("target") == target.key and i.get("sector") == sector]
                    hashes += [i["sha256"] for i in code_entries]
                    rev = revision(hashes, params)
                    stem = f"{target.key}-s{sector}-{minutes}m-{reducer}"
                    np.savez_compressed(out / f"{stem}.npz", raw_time=t, raw_flux=f, bin_center=b.centers,
                                        flux=b.flux, counts=b.counts)
                    segment_rows.append({"target": target.key, "tic_id": target.tic_id, "sector": sector,
                        "requested_minutes": minutes, "actual_minutes": b.minutes, "reducer": reducer,
                        "start_btjd": b.start, "n_points": len(b.flux), "n_input": len(t), "n_kept": int(np.isfinite(f).sum()),
                        "n_empty": int((b.counts == 0).sum()), "min_nonempty_count": int(b.counts[b.counts > 0].min()) if b.counts.any() else 0,
                        "flux_scatter": scatter(b.flux), "gaps": json.dumps(b.gaps), "binning_revision": rev,
                        "preprocess_status": processed.status, "preprocess_failures": json.dumps(processed.failures),
                        "array_file": f"{stem}.npz"})
                    cases = [("reference", name, p, e, d) for name, p, e, d in geometry]
                    cases += [("injection_post_preprocess", f"d{d}-offset{offset}", inj["period_days"],
                               float(t[0] + 0.5 + offset / 1440), d)
                              for d in inj["duration_hours"] for offset in inj["epoch_offset_minutes"]]
                    for case_index, (kind, name, p, e, d) in enumerate(cases):
                        raw_values, bin_values = f, b.flux
                        if kind == "injection_post_preprocess":
                            signal = (np.abs(phase(t, p, e)) < d / 48) * inj["depth_ppm"] / 1e6
                            injected = f * (1 - signal)
                            other = bin_curve(t, injected, minutes, reducer, cfg["max_points"])
                            # Paired change on the same background. Mean subtraction is linear;
                            # median subtraction can retain background/reducer interactions.
                            raw_values, bin_values = 1 + injected - f, 1 + other.flux - b.flux
                        raw_depth, raw_n, raw_oot = depth(t, raw_values, p, e, d)
                        bin_depth, bin_n, bin_oot = depth(b.centers, bin_values, p, e, d)
                        ratio = bin_depth / raw_depth if np.isfinite(raw_depth) and raw_depth > 0 and np.isfinite(bin_depth) else float("nan")
                        metric_rows.append({"target": target.key, "sector": sector, "kind": kind, "case": name,
                            "period_days": p, "epoch_btjd": e, "duration_hours": d, "requested_minutes": minutes,
                            "actual_minutes": b.minutes, "reducer": reducer, "nominal_bins_per_transit": d * 60 / b.minutes,
                            "raw_depth_ppm": raw_depth * 1e6, "binned_depth_ppm": bin_depth * 1e6,
                            "depth_ratio": ratio, "raw_in_transit_points": raw_n, "binned_in_transit_points": bin_n,
                            "raw_oot_points": raw_oot, "binned_oot_points": bin_oot,
                            "metric_status": "measured" if np.isfinite(ratio) else "insufficient_or_nonpositive_reference_depth"})
                        if minutes == 10 and (kind == "reference" or (d in (0.5, 0.8) and name.endswith("offset0.0"))):
                            plot_fold(out / f"{stem}-case{case_index}.svg", f"{stem}: {kind} {name}",
                                      t, raw_values, b.centers, bin_values, p, e, d)
        print(f"{target.key}: {len(baseline.sectors)} sectors, {time.perf_counter()-target_started:.1f}s", flush=True)
    write_csv(out / "segments.csv", segment_rows)
    write_csv(out / "metrics.csv", metric_rows)
    (out / "skipped-references.json").write_text(json.dumps(skipped, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = mf.build_manifest(task="S15P21C206-114", command="python -m tess_bench.binning " + shlex.join(args.command_args),
        repo_dir=ROOT.parents[1], inputs=inputs + code_entries,
        config={"name": "binning_v1", "version": cfg["version"], "sha256": inputs[0]["sha256"],
                "parameters": cfg, "selected_targets": keys, "preprocess": setting.params(),
                "elapsed_seconds": time.perf_counter() - started},
        outputs=[mf.file_entry(p) for p in sorted(out.iterdir())], run_id=run_id,
        packages=("numpy", "scipy", "astropy"), notes="Experimental only; no adoption or discoverable judgment. No random draws.")
    mf.write_manifest(manifest, out / "manifest.json")
    print(f"{len(segment_rows)} segments/settings; {len(metric_rows)} measurements; {out}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", action="append", help="repeatable; default fixed nine stars")
    parser.add_argument("--config", type=Path, default=ROOT / "configs/binning_v1.json")
    parser.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    parser.add_argument("--results", type=Path, default=ROOT / "results")
    parser.add_argument("--check-inputs", action="store_true")
    args = parser.parse_args(argv)
    args.command_args = list(sys.argv[1:] if argv is None else argv)
    try:
        return run(args)
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())

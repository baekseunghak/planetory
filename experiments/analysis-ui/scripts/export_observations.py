"""Export local SPOC FITS into full-observation analysis UI fixtures.

No network access, source mutations, catalog labels, or fitted transit geometry.
Run with experiments/tess-bls/.venv/Scripts/python.exe on Windows.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time

import numpy as np
import pandas as pd
from astropy.io import fits

EXPERIMENT = Path(__file__).resolve().parents[1]
REPOSITORY = EXPERIMENT.parents[1]
WORKSPACE = REPOSITORY.parent
PIPELINE_PATH = REPOSITORY / "experiments/tess-bls/pipeline.py"
sys.path.insert(0, str(PIPELINE_PATH.parent))
from pipeline import bls_period_candidates, bls_periodogram, clean  # noqa: E402

TARGETS = (
    {"id": "toi270", "label": "TOI-270", "tic_id": "259377017", "folder": "toi270", "sectors": [3, 4, 5]},
    {"id": "l98-59", "label": "L 98-59", "tic_id": "307210830", "folder": "l98_59", "sectors": [2, 5, 8]},
    {"id": "cm-dra", "label": "CM Draconis", "tic_id": "199574208", "folder": "cm_dra", "sectors": [16]},
)
PROCESSING = {
    "version": "analysis-observation-export-v1",
    "flux_column": "PDCSAP_FLUX",
    "reference_rule": "float64 median of original QUALITY=0, finite TIME/PDCSAP_FLUX, positive PDCSAP_FLUX rows before clean; fixed for the bundle",
    "clean": {"savgol_window_days": 2.0, "sigma_upper": 5.0, "min_points": 500},
    "normalization": "per-Sector flux median, then segment Savitzky-Golay degree 2 detrending; upper-only 5-MAD clipping via tess-bls/pipeline.clean",
    "gap_days": 0.5,
    "sampling": "none; every pipeline-cleaned point is exported once with original FITS row provenance",
    "bls": {"period_min": 0.5, "period_max": 40.0, "n_periods": 8000, "duration_grid_hours": np.geomspace(0.5, 8.0, 12).tolist(), "weighted": False},
    "peak_selection": "pipeline.bls_period_candidates, max 10, Rayleigh frequency separation 1/baseline; pipeline slider range/step",
}
SELECTION_RULES = {"version": "prototype-selection-v1", "min_width_phase": 0.001, "max_width_phase": 0.25}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def partition_rows(time_values, flux_values, quality_values):
    """Disjoint audit masks: every raw row belongs to exactly one input class."""
    t = np.asarray(time_values, dtype=np.float64)
    f = np.asarray(flux_values, dtype=np.float64)
    quality = np.asarray(quality_values)
    quality_ok = quality == 0
    finite = np.isfinite(t) & np.isfinite(f)
    return {
        "quality_nonzero": ~quality_ok,
        "nonfinite": quality_ok & ~finite,
        "nonpositive_flux": quality_ok & finite & (f <= 0),
        "eligible": quality_ok & finite & (f > 0),
    }


def fixed_reference(t):
    values = np.asarray(t, dtype=np.float64)
    if not len(values) or not np.all(np.isfinite(values)):
        raise ValueError("Reference input must contain finite eligible original times")
    return float(np.median(values))


def source_relative_path(path: Path) -> str:
    # Absolute machine-specific paths are never published in a browser payload.
    try:
        return path.resolve().relative_to(WORKSPACE).as_posix()
    except ValueError:
        return f"external-source/{path.parent.name}/{path.name}"


def read_target(target, source_root: Path):
    rows = []
    sources = []
    windows = []
    segments = []
    discovered_sectors = []
    paths = sorted((source_root / target["folder"]).glob("*_lc.fits"))
    if not paths:
        raise FileNotFoundError(f"No saved FITS: {source_root / target['folder']}")
    for source_index, path in enumerate(paths):
        with fits.open(path, mode="readonly", memmap=False) as hdul:
            primary, extension = hdul[0].header, hdul[1].header
            tic_id = str(primary["TICID"])
            sector = int(primary["SECTOR"])
            if tic_id != target["tic_id"] or sector not in target["sectors"]:
                raise ValueError(f"Unexpected TIC/Sector in {path.name}: {tic_id}/{sector}")
            if extension.get("BJDREFI") != 2457000 or extension.get("BJDREFF", 0.0) != 0.0:
                raise ValueError(f"Expected original BTJD time reference in {path.name}")
            table = hdul[1].data
            t = np.array(table["TIME"], dtype=np.float64)
            f = np.array(table["PDCSAP_FLUX"], dtype=np.float64)
            q = np.array(table["QUALITY"], dtype=np.int64)
            masks = partition_rows(t, f, q)
            eligible = masks["eligible"]
            if not eligible.any():
                raise ValueError(f"No eligible rows in {path.name}")
            kept_times = np.sort(t[eligible])
            windows.append({"source_index": source_index, "sector": sector, "start_btjd": float(kept_times[0]), "end_btjd": float(kept_times[-1])})
            split_at = np.flatnonzero(np.diff(kept_times) > PROCESSING["gap_days"]) + 1
            for segment_index, segment in enumerate(np.split(kept_times, split_at)):
                segments.append({"source_index": source_index, "sector": sector, "segment_index": segment_index, "start_btjd": float(segment[0]), "end_btjd": float(segment[-1]), "eligible_point_count": len(segment)})
            rows.append(pd.DataFrame({"time": t[eligible], "flux": f[eligible], "quality": q[eligible], "observation_group": sector, "source_index": source_index, "source_row": np.flatnonzero(eligible)}))
            sources.append({
                "source_index": source_index, "relative_path": source_relative_path(path), "sha256": sha256(path),
                "size_bytes": path.stat().st_size, "tic_id": tic_id, "sector": sector,
                "camera": int(primary["CAMERA"]), "ccd": int(primary["CCD"]),
                "origin": primary.get("ORIGIN"), "creator": primary.get("CREATOR"),
                "time_system": extension.get("TIMESYS"), "bjd_reference": 2457000.0,
                "raw_point_count": len(t), "eligible_point_count": int(eligible.sum()),
                "excluded_rows": {name: np.flatnonzero(mask).tolist() for name, mask in masks.items() if name != "eligible"},
            })
            discovered_sectors.append(sector)
    if sorted(discovered_sectors) != sorted(target["sectors"]):
        raise ValueError(f"Expected exactly one FITS per requested Sector for {target['id']}: {discovered_sectors}")
    return pd.concat(rows, ignore_index=True), sources, windows, segments


def clean_with_provenance(frame):
    """Reuse the pipeline and recover each retained original row without sampling."""
    reference = fixed_reference(frame["time"].to_numpy(np.float64))
    ordered = frame.sort_values("time", kind="stable").reset_index(drop=True)
    input_times = ordered["time"].to_numpy(np.float64)
    if np.any(np.diff(input_times) <= 0):
        # These presets have non-overlapping Sectors. Never silently merge duplicates.
        raise ValueError("Input timestamps must be unique for unambiguous source-row mapping")
    cleaned, clean_info = clean(frame, **PROCESSING["clean"])
    if cleaned is None:
        raise ValueError(f"Pipeline rejected data: {clean_info}")
    t, flux = (np.asarray(values, dtype=np.float64) for values in cleaned)
    if not np.all(np.isfinite(t)) or not np.all(np.isfinite(flux)) or not np.all(flux > 0):
        raise ValueError("Pipeline produced nonfinite or nonpositive observations")
    positions = np.searchsorted(input_times, t)
    if np.any(positions >= len(input_times)) or not np.array_equal(input_times[positions], t):
        raise ValueError("Cannot map cleaned timestamps back to exact original FITS rows")
    retained = ordered.iloc[positions].copy()
    keep = np.zeros(len(ordered), dtype=bool)
    keep[positions] = True
    rejected = ordered.loc[~keep]
    return t, flux, reference, retained, rejected, clean_info


def public_periodogram(periodogram):
    """Explicit allowlist: never export BLS fitted epoch, duration, or depth."""
    result = {"period_days": np.asarray(periodogram["periods"], dtype=np.float64).tolist(), "power": np.asarray(periodogram["power"], dtype=np.float64).tolist()}
    if not all(np.all(np.isfinite(values)) for values in result.values()):
        raise ValueError("Nonfinite BLS output cannot be published")
    return result


def export_target(target, source_root: Path):
    started = time.perf_counter()
    frame, sources, windows, segments = read_target(target, source_root)
    t, flux, reference, retained, rejected, clean_info = clean_with_provenance(frame)
    for source in sources:
        index = source["source_index"]
        source["retained_point_count"] = int((retained["source_index"] == index).sum())
        source["excluded_rows"]["upper_sigma_clip"] = rejected.loc[rejected["source_index"] == index, "source_row"].astype(int).tolist()
        excluded_count = sum(len(values) for values in source["excluded_rows"].values())
        if excluded_count + source["retained_point_count"] != source["raw_point_count"]:
            raise AssertionError("Raw row audit does not reconcile")
    bls_started = time.perf_counter()
    periodogram = bls_periodogram(t, flux, period_min=0.5, period_max=40.0, n_periods=8000)
    bls_seconds = time.perf_counter() - bls_started
    peaks = [{"id": item["candidate_id"], "rank": item["rank"], "period_days": item["period"], "relative_power": item["relative_power"], "period_min": item["slider_min"], "period_max": item["slider_max"], "period_step": item["slider_step"]} for item in bls_period_candidates(periodogram, count=10)]
    versions = {package: importlib.metadata.version(package) for package in ("numpy", "pandas", "scipy", "astropy")}
    config_identity = {"sources": [source["sha256"] for source in sources], "pipeline_sha256": sha256(PIPELINE_PATH), "exporter_sha256": sha256(Path(__file__)), "processing": PROCESSING, "selection_rules": SELECTION_RULES, "package_versions": versions}
    identity_hash = hashlib.sha256(json.dumps(config_identity, sort_keys=True).encode()).hexdigest()[:20]
    return {
        "schema_version": "analysis-observations-v1", "id": target["id"], "label": target["label"], "tic_id": target["tic_id"],
        "bundle_id": f"local-{target['id']}-{identity_hash}", "point_count": len(t), "sectors": target["sectors"],
        "time_btjd": t.tolist(), "normalized_flux": flux.tolist(), "fold_reference_time_btjd": reference,
        "point_source_index": retained["source_index"].astype(int).tolist(), "point_source_row": retained["source_row"].astype(int).tolist(),
        "observation_windows": windows, "observation_segments": segments,
        "periodogram": public_periodogram(periodogram), "peaks": peaks, "selection_rules": SELECTION_RULES,
        "provenance": {"generated_at": datetime.now(timezone.utc).isoformat(), "sources": sources, "processing": PROCESSING,
            "pipeline_relative_path": "Planetory/experiments/tess-bls/pipeline.py", "pipeline_sha256": config_identity["pipeline_sha256"],
            "exporter_sha256": config_identity["exporter_sha256"], "package_versions": versions,
            "quality_counts": {"raw": sum(source["raw_point_count"] for source in sources), "eligible_before_clean": len(frame), "retained": len(t), **{reason: sum(len(source["excluded_rows"][reason]) for source in sources) for reason in ("quality_nonzero", "nonfinite", "nonpositive_flux", "upper_sigma_clip")}},
            "clean_info": clean_info, "reference_population": "eligible_before_clean", "reference_is_fixed": True,
            "bls_seconds": round(bls_seconds, 3), "export_compute_seconds": round(time.perf_counter() - started, 3),
        },
    }


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=WORKSPACE / "archive/TESS_BLS_semi_auto/sample_raw/tess")
    parser.add_argument("--output", type=Path, default=EXPERIMENT / "public/observations")
    args = parser.parse_args()
    manifest = {"schema_version": "analysis-observations-v1", "targets": []}
    for target in TARGETS:
        print(f"Exporting {target['label']} from saved FITS...", flush=True)
        data = export_target(target, args.source_root)
        filename = f"{target['id']}.json"
        output_path = args.output / filename
        write_json(output_path, data)
        manifest["targets"].append({key: data[key] for key in ("id", "label", "tic_id", "point_count", "sectors")} | {"file": filename, "bundle_id": data["bundle_id"], "sha256": sha256(output_path), "size_bytes": output_path.stat().st_size})
        print(json.dumps({"id": target["id"], "quality_counts": data["provenance"]["quality_counts"], "fold_reference_time_btjd": data["fold_reference_time_btjd"], "bls_seconds": data["provenance"]["bls_seconds"], "size_bytes": output_path.stat().st_size}, ensure_ascii=False), flush=True)
    write_json(args.output / "manifest.json", manifest)
    print(f"Manifest: {args.output / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()

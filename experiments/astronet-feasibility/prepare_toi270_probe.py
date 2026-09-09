"""Prepare one Planetory TOI-270 BLS candidate for AstroNet-Triage.

This probe deliberately stops before TensorFlow serialization.  It runs in the
existing TESS PoC environment and writes the two arrays expected by the
official AstroNet-Triage checkpoint to an NPZ file.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits


ROOT = Path(__file__).resolve().parents[2]
TESS_BLS_DIR = ROOT / "experiments" / "tess-bls"
sys.path.insert(0, str(TESS_BLS_DIR))

from pipeline import bls_features, clean  # noqa: E402


def load_toi270() -> tuple[np.ndarray, np.ndarray, dict, list[int], int]:
    """Load and clean the three checked-in-location, git-ignored sample FITS."""
    data_dir = TESS_BLS_DIR / "sample_raw" / "tess" / "toi270"
    paths = sorted(data_dir.glob("*_lc.fits"))
    if not paths:
        raise FileNotFoundError(f"TOI-270 FITS files were not found under {data_dir}")

    frames: list[pd.DataFrame] = []
    sectors: list[int] = []
    tic_ids: set[int] = set()
    for path in paths:
        with fits.open(path, memmap=False) as hdul:
            table = hdul[1].data
            header = hdul[0].header
            sector = int(header["SECTOR"])
            tic_id = int(header["TICID"])
            frames.append(pd.DataFrame({
                "observation_group": sector,
                "time": np.asarray(table["TIME"], dtype=np.float64),
                "flux": np.asarray(table["PDCSAP_FLUX"], dtype=np.float64),
                "quality": np.asarray(table["QUALITY"], dtype=np.int64),
            }))
            sectors.append(sector)
            tic_ids.add(tic_id)

    if len(tic_ids) != 1:
        raise ValueError(f"Expected one TIC, found {sorted(tic_ids)}")

    cleaned, stats = clean(pd.concat(frames, ignore_index=True))
    if cleaned is None:
        raise RuntimeError(f"Cleaning failed: {stats}")
    time, flux = cleaned
    return time, flux, stats, sorted(sectors), tic_ids.pop()


def phase_fold(time: np.ndarray, flux: np.ndarray, period: float, t0: float):
    folded = (time + (period / 2 - t0)) % period - period / 2
    order = np.argsort(folded)
    return folded[order], flux[order]


def median_view(
    time: np.ndarray,
    flux: np.ndarray,
    *,
    num_bins: int,
    bin_width: float,
    t_min: float,
    t_max: float,
) -> np.ndarray:
    """Match AstroNet-Triage's overlapping-bin median view generation."""
    spacing = (t_max - t_min - bin_width) / (num_bins - 1)
    view = np.full(num_bins, np.nan, dtype=np.float64)
    for index in range(num_bins):
        left = t_min + index * spacing
        values = flux[(time >= left) & (time < left + bin_width)]
        if values.size:
            view[index] = np.median(values)

    valid = np.flatnonzero(np.isfinite(view))
    if not valid.size:
        raise ValueError("Every AstroNet view bin is empty")
    view = np.interp(np.arange(num_bins), valid, view[valid])
    view -= np.median(view)
    scale = abs(float(np.min(view)))
    if not np.isfinite(scale) or scale == 0:
        raise ValueError("AstroNet view cannot be normalized")
    return (view / scale).astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    time, flux, clean_stats, sectors, tic_id = load_toi270()
    candidate = bls_features(time, flux)
    period = candidate["period"]
    duration = candidate["duration_hr"] / 24.0
    t0 = candidate["t0"]
    folded_time, folded_flux = phase_fold(time, flux, period, t0)

    global_view = median_view(
        folded_time,
        folded_flux,
        num_bins=201,
        bin_width=period * 1.2 / 201,
        t_min=-period / 2,
        t_max=period / 2,
    )
    local_view = median_view(
        folded_time,
        folded_flux,
        num_bins=61,
        bin_width=duration * 0.16,
        t_min=max(-period / 2, -duration * 2),
        t_max=min(period / 2, duration * 2),
    )

    if global_view.shape != (201,) or local_view.shape != (61,):
        raise AssertionError("Unexpected AstroNet input shape")
    if not np.isfinite(global_view).all() or not np.isfinite(local_view).all():
        raise AssertionError("AstroNet input contains a non-finite value")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        args.output,
        global_view=global_view,
        local_view=local_view,
        tic_id=np.int64(tic_id),
        sectors=np.asarray(sectors, dtype=np.int64),
        period=np.float64(period),
        duration=np.float64(duration),
        t0=np.float64(t0),
    )
    print(f"TIC: {tic_id}")
    print(f"Sectors: {sectors}")
    print(f"Cleaned points: {len(time):,} / {clean_stats['raw']:,}")
    print(f"BLS period: {period:.9f} d")
    print(f"BLS t0: {t0:.9f} BTJD")
    print(f"BLS duration: {duration * 24:.3f} h")
    print(f"BLS depth: {candidate['depth']:.8f}")
    print(f"BLS SNR: {candidate['snr']:.3f}")
    print(f"Views: global={global_view.shape}, local={local_view.shape}")
    print(f"Saved: {args.output.resolve()}")


if __name__ == "__main__":
    main()

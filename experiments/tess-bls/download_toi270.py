# -*- coding: utf-8 -*-
"""Download the official TESS Sector 3-5 light curves for TOI-270.

This downloader intentionally uses fixed, official MAST product URLs instead of
the MAST search service.  It has no third-party dependencies and is safe to
rerun: completed nonempty files are treated as cache hits.
"""

from __future__ import annotations

import argparse
import os
import shutil
import time
import urllib.request
from pathlib import Path


TIC_ID = 259377017
USER_AGENT = "ssafy-exoplanet-poc/0.1"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "sample_raw" / "tess" / "toi270"

PRODUCTS = (
    (
        3,
        "tess2018263035959-s0003-0000000259377017-0123-s_lc.fits",
        "https://mast.stsci.edu/api/v0.1/Download/file/?uri="
        "mast:TESS/product/tess2018263035959-s0003-0000000259377017-0123-s_lc.fits",
    ),
    (
        4,
        "tess2018292075959-s0004-0000000259377017-0124-s_lc.fits",
        "https://mast.stsci.edu/api/v0.1/Download/file/?uri="
        "mast:TESS/product/tess2018292075959-s0004-0000000259377017-0124-s_lc.fits",
    ),
    (
        5,
        "tess2018319095959-s0005-0000000259377017-0125-s_lc.fits",
        "https://mast.stsci.edu/api/v0.1/Download/file/?uri="
        "mast:TESS/product/tess2018319095959-s0005-0000000259377017-0125-s_lc.fits",
    ),
)

# NASA Exoplanet Archive reference values for checking the PoC output.
EXPECTED_CONFIRMED_PERIODS_DAYS = (
    ("TOI-270 b", 3.35992),
    ("TOI-270 c", 5.66051),
    ("TOI-270 d", 11.38194),
)


def _primary_header(path: Path) -> dict[str, object]:
    """Read the first FITS header using only the standard library."""
    values: dict[str, object] = {}
    with path.open("rb") as handle:
        while True:
            block = handle.read(2880)
            if len(block) != 2880:
                raise ValueError("truncated FITS primary header")
            for offset in range(0, 2880, 80):
                card = block[offset:offset + 80].decode("ascii", "strict")
                key = card[:8].strip()
                if key == "END":
                    return values
                if card[8:10] != "= ":
                    continue
                raw = card[10:].split("/", 1)[0].strip()
                if raw in ("T", "F"):
                    values[key] = raw == "T"
                elif raw.startswith("'"):
                    values[key] = raw[1:].split("'", 1)[0].strip()
                else:
                    try:
                        values[key] = int(raw)
                    except ValueError:
                        values[key] = raw


def validate_product(path: Path, sector: int) -> None:
    if not path.is_file() or path.stat().st_size < 2880 or path.stat().st_size % 2880:
        raise ValueError("file size is not a complete FITS block sequence")
    header = _primary_header(path)
    if header.get("SIMPLE") is not True:
        raise ValueError("missing FITS SIMPLE header")
    if int(header.get("TICID", -1)) != TIC_ID:
        raise ValueError(f"unexpected TICID: {header.get('TICID')}")
    if int(header.get("SECTOR", -1)) != sector:
        raise ValueError(f"unexpected SECTOR: {header.get('SECTOR')}")


def download_product(url: str, destination: Path, sector: int, timeout: float = 120.0,
                     retries: int = 3) -> bool:
    """Download one product atomically; return True for an existing cache hit."""
    if destination.is_file() and destination.stat().st_size > 0:
        try:
            validate_product(destination, sector)
        except (OSError, ValueError) as exc:
            print(f"[invalid cache] {destination.name}: {exc}; downloading again")
        else:
            print(f"[cached] {destination.name} ({destination.stat().st_size:,} bytes)")
            return True

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        print(f"[download {attempt}/{retries}] {destination.name}")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                expected_size = response.headers.get("Content-Length")
                with partial.open("wb") as output:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())

            actual_size = partial.stat().st_size
            if expected_size is not None and actual_size != int(expected_size):
                raise RuntimeError(
                    f"incomplete download for {destination.name}: "
                    f"expected {int(expected_size):,} bytes, received {actual_size:,}"
                )
            validate_product(partial, sector)
            os.replace(partial, destination)
            print(f"[saved] {destination} ({actual_size:,} bytes)")
            return False
        except Exception as exc:
            last_error = exc
            partial.unlink(missing_ok=True)
            if attempt < retries:
                time.sleep(1.5 * attempt)
    raise RuntimeError(f"failed to download {destination.name}: {last_error}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"Download official TESS Sectors 3-5 LC FITS for TIC {TIC_ID}."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"destination directory (default: {DEFAULT_OUTPUT})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output.expanduser().resolve()

    print(f"TOI-270 / TIC {TIC_ID}")
    print(f"Output: {output_dir}")

    cache_hits = 0
    for sector, filename, url in PRODUCTS:
        print(f"Sector {sector}:")
        cache_hits += download_product(url, output_dir / filename, sector)

    print(f"Complete: {len(PRODUCTS)} files ({cache_hits} cached)")
    print("Expected confirmed periods (reference values for validating the PoC):")
    for planet, period_days in EXPECTED_CONFIRMED_PERIODS_DAYS:
        print(f"  {planet}: {period_days:.5f} days")


if __name__ == "__main__":
    main()

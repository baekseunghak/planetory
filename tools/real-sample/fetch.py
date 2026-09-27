"""Download the sample's SPOC 2-minute LC files from MAST into .cache/ (idempotent).

Only mast.stsci.edu is contacted. A file already in the cache is re-checked
(header TICID/SECTOR, and SHA-256 when the repo pins one) instead of fetched.
"""
import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

from astropy.io import fits

from stars import MAST_DOWNLOAD, STARS, product_filename

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / ".cache"
PINNED = [ROOT / "experiments/tess-fixture/checksums.json",
          ROOT / "experiments/tess-fixture/service_sample_checksums.json"]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned_checksums():
    out = {}
    for path in PINNED:
        for row in json.loads(path.read_text(encoding="utf-8"))["files"]:
            out[row["filename"]] = row["sha256"]
    return out


def check(path, tic, sector, expected):
    with fits.open(path, memmap=False) as hdul:
        header = hdul[0].header
        if int(header["TICID"]) != tic or int(header["SECTOR"]) != sector:
            raise ValueError(f"{path.name}: header TIC/Sector mismatch")
    digest = sha256(path)
    if expected and digest != expected:
        raise ValueError(f"{path.name}: SHA-256 differs from the repo pin")
    return digest


def fetch_all():
    CACHE.mkdir(exist_ok=True)
    pins = pinned_checksums()
    rows = []
    for star, sector in [(s, sector) for s in STARS for sector in s["sectors"]]:
        name = product_filename(star["tic"], sector)
        path = CACHE / name
        fetched = False
        if not path.exists():
            url = MAST_DOWNLOAD + name
            tmp = path.with_suffix(".part")
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=120) as response:
                        tmp.write_bytes(response.read())
                    break
                except Exception as exc:  # network hiccup: retry, then fail loudly
                    if attempt == 2:
                        raise RuntimeError(f"download failed: {url}: {exc}") from exc
                    time.sleep(2 + attempt * 3)
            tmp.replace(path)
            fetched = True
        digest = check(path, star["tic"], sector, pins.get(name))
        rows.append(dict(tic=star["tic"], sector=sector, file=name, bytes=path.stat().st_size,
                         sha256=digest, repo_pinned=name in pins, fetched_now=fetched))
        print(f"{'fetched' if fetched else 'cached '} {name} {path.stat().st_size / 1e6:.2f} MB"
              f"{' (repo pin ok)' if name in pins else ''}", flush=True)
    (CACHE / "downloads.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    total = sum(r["bytes"] for r in rows)
    print(f"{len(rows)} files, {total / 1e6:.1f} MB", flush=True)
    return rows


if __name__ == "__main__":
    sys.path.insert(0, str(HERE))
    fetch_all()

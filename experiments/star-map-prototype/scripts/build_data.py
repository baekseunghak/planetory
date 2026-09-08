"""Regenerate the small UI fixture from the seven official TESS FITS products."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
from astropy.io import fits

ROOT = Path(__file__).resolve().parents[1]
TARGETS = (
    ("toi270", "259377017", "TOI-270", 0, 0, 0),
    ("l98_59", "307210830", "L 98-59", 580, -205, 1),
    ("cm_dra", "199574208", "CM Draconis", 620, 235, 1),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "shared")
    args = parser.parse_args()
    stars, inputs = [], []
    for folder, tic, name, x, y, generation in TARGETS:
        # Use the sibling experiment's fixed official product list; never scan
        # arbitrary additional files and silently change this comparison fixture.
        source = ROOT.parent / "tess-bls" / f"download_{folder}.py"
        spec = importlib.util.spec_from_file_location(f"download_{folder}", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        star = {"tic": tic, "name": name}
        observations, curves = [], []
        for sector, filename, url in module.PRODUCTS:
            path = args.raw_dir / folder / filename
            module.validate_product(path, sector)
            with fits.open(path, memmap=False) as hdus:
                header, table = hdus[0].header, hdus[1].data
                if not observations:
                    star.update({key: float(header[field]) for key, field in (
                        ("ra", "RA_OBJ"), ("dec", "DEC_OBJ"),
                        ("tmag", "TESSMAG"), ("temperature", "TEFF"),
                        ("radius", "RADIUS"))})
                    star.update(x=x, y=y, generation=generation)
                time = np.asarray(table["TIME"], dtype=float)
                flux = np.asarray(table["PDCSAP_FLUX"], dtype=float)
                valid = (table["QUALITY"] == 0) & np.isfinite(time) & np.isfinite(flux)
                time, flux = time[valid], flux[valid]
                order = np.argsort(time, kind="stable")
                time, flux = time[order], flux[order]
                if len(time) < 1400 or np.median(flux) <= 0:
                    raise ValueError(f"Unexpected input for {filename}")
                indices = np.linspace(0, len(time) - 1, 1400).astype(int)
                normalized = flux / np.median(flux)
                points = [[round(float(time[i]), 5), round(float(normalized[i]), 6)]
                          for i in indices]
                observations.append({
                    "sector": int(header["SECTOR"]), "camera": int(header["CAMERA"]),
                    "ccd": int(header["CCD"]), "rows": len(table), "validRows": len(time),
                    "start": header["DATE-OBS"][:10], "end": header["DATE-END"][:10],
                    "file": filename,
                })
                curves.append({"sector": sector, "points": points})
            inputs.append({"file": filename, "url": url,
                           "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        star.update(observations=observations, curves=curves)
        stars.append(star)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "data.js").write_text(
        "window.PLANETORY_DATA=" + json.dumps(stars, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8")
    (args.output_dir / "data-provenance.json").write_text(
        json.dumps({"source": "MAST TESS SPOC", "inputs": inputs}, indent=2) + "\n", encoding="utf-8")
    print("Generated 3 stars / 7 observations / 9,800 light-curve points.")


if __name__ == "__main__":
    main()

"""Regression validation must still fail when Python assertions are disabled."""
import os
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPT = r'''
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from astro_kernel.preprocessing import SectorInput
from tess_bench import interval_mask_regression as runner

mode, root = sys.argv[1], Path(sys.argv[2])
root.mkdir()
raw = root / "raw"
raw.mkdir()
product = raw / "synthetic-s0003-lc.fits"
product.write_bytes(b"synthetic input")
evidence = root / "tess_sector_03_drn04_v02.pdf"
evidence.write_bytes(b"synthetic evidence")
output = root / "output"
quality = np.zeros(600, dtype=int)
quality[0] = 128
curve = SectorInput(1, 3, product.name, np.arange(600)/720,
                    1000+np.sin(np.arange(600)), np.ones(600), quality,
                    np.arange(600), runner.sha(product))
preprocess = runner.preprocess_silver
ledger = runner.exclusion_ledger

def preprocessing(*args, **kwargs):
    prepared, result = preprocess(*args, **kwargs)
    if kwargs.get("interval_masks"):
        if mode == "numerical":
            prepared.flux[0] += 1
        if mode == "snapshot":
            product.write_bytes(b"modified after plan")
    return prepared, result

def exclusions(*args):
    rows = ledger(*args)
    if mode == "count":
        rows.pop()
    if mode == "provenance":
        rows[0]["cadenceno"] += 1
    return rows

expected = {"count":"row conservation mismatch", "provenance":"provenance mismatch",
            "numerical":"numerical mismatch", "snapshot":"snapshot checksum mismatch"}
with patch.object(runner, "SOURCES", {evidence.name:runner.sha(evidence)}), \
     patch.object(runner.fits, "open") as opened, \
     patch.object(runner, "parse_spoc_hdul", return_value=(curve, {"PROCVER":"synthetic"})), \
     patch.object(runner, "preprocess_silver", side_effect=preprocessing), \
     patch.object(runner, "exclusion_ledger", side_effect=exclusions):
    opened.return_value.__enter__.return_value = [SimpleNamespace(header={"DATA_REL":42})]
    try:
        runner.run(raw, root, output)
    except ValueError as exc:
        if mode not in expected or expected[mode] not in str(exc):
            raise
        if (output/"manifest.json").exists():
            raise RuntimeError("failure published a success manifest")
    else:
        if mode != "valid":
            raise RuntimeError("mismatch accepted under optimized Python")
        manifest = json.loads((output/"manifest.json").read_text())
        if manifest["completed"] is not True:
            raise RuntimeError("valid control failed")
    if sys.flags.optimize != 1:
        raise RuntimeError("test must execute optimized Python")
'''


@pytest.mark.parametrize("mode", ["valid", "count", "provenance", "numerical", "snapshot"])
@pytest.mark.parametrize("optimization", ["flag", "environment"])
def test_runner_under_optimized_python(tmp_path, mode, optimization):
    env = os.environ.copy()
    env.pop("PYTHONOPTIMIZE", None)
    root = Path(__file__).resolve().parents[3]
    env["PYTHONPATH"] = os.pathsep.join([str(root/"libs/astro-kernel"), str(root/"experiments/tess-bench")])
    args = [sys.executable]
    if optimization == "flag":
        args.append("-O")
    else:
        env["PYTHONOPTIMIZE"] = "1"
    args += ["-c", SCRIPT, mode, str(tmp_path/"case")]
    result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr

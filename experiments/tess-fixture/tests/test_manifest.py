import json
from pathlib import Path

import pytest

from tess_fixture import manifest as mf

SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "schemas" / "run_manifest.schema.json").read_text(encoding="utf-8"))


def test_schema_required_keys_match_validator():
    assert tuple(SCHEMA["required"]) == mf.REQUIRED_TOP
    assert SCHEMA["properties"]["schema"]["const"] == mf.SCHEMA_ID


def test_build_and_write_manifest(tmp_path):
    inp = tmp_path / "in.bin"
    inp.write_bytes(b"abc")
    manifest = mf.build_manifest(
        task="test", command="python -m tess_fixture test", repo_dir=tmp_path,
        inputs=[mf.file_entry(inp, role="raw_product")],
        config={"name": "cfg", "version": "1", "sha256": "0" * 64},
        outputs=[],
    )
    path = mf.write_manifest(manifest, tmp_path / "m.json")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["schema"] == mf.SCHEMA_ID
    assert saved["inputs"][0]["sha256"] == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert saved["environment"]["packages"]["numpy"]
    assert "git_commit" in saved["code"]


def test_validate_rejects_missing_keys():
    with pytest.raises(ValueError):
        mf.validate_manifest({"schema": mf.SCHEMA_ID})
    with pytest.raises(ValueError):
        mf.validate_manifest({k: {} if k in ("code", "environment", "config") else [] if k in ("inputs", "outputs") else "x"
                              for k in mf.REQUIRED_TOP} | {"schema": mf.SCHEMA_ID})

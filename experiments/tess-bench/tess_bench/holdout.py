"""Pre-evaluation input/configuration lock for Jira 110. No Git or BLS calls."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from tess_fixture.targets import HOLDOUT_TARGETS, iter_products
from tess_fixture import references

ROOT = Path(__file__).resolve().parents[3]
CRITERIA = ROOT / "experiments/tess-bench/configs/holdout_criteria_v1.json"
LOCK = ROOT / "experiments/tess-bench/configs/holdout_lock_v1.json"
SEEDS = [20260910, 20260917, 20260918]


def text_digest(path: Path) -> str:
    # Git on Windows may rewrite LF/CRLF; hash decoded logical text.
    return hashlib.sha256(path.read_text(encoding="utf-8").encode("utf-8")).hexdigest()


def lock_paths(root: Path) -> list[Path]:
    names = ["experiments/tess-bench/configs/bls_settings_v1.json",
             "experiments/tess-bench/configs/preprocess_settings_v1.json",
             "experiments/tess-bench/configs/holdout_criteria_v1.json",
             "experiments/tess-fixture/configs/injection_grid_v1.json",
             "experiments/tess-fixture/checksums.json", "experiments/tess-fixture/references.csv",
             "experiments/tess-bench/uv.lock", "experiments/tess-fixture/uv.lock"]
    paths = [root / name for name in names]
    for package in ("experiments/tess-bench/tess_bench", "experiments/tess-fixture/tess_fixture",
                    "libs/astro-kernel/astro_kernel"):
        paths.extend(sorted((root / package).glob("*.py")))
    return paths


def build_lock(root: Path = ROOT) -> dict:
    fixture = root / "experiments/tess-fixture"
    checksums = json.loads((fixture / "checksums.json").read_text(encoding="utf-8"))
    by_name = {r["filename"]: r for r in checksums["files"]}
    refs = references.read_references(fixture / "references.csv")
    products = []
    for target, sector, filename, _ in iter_products(HOLDOUT_TARGETS):
        r = by_name.get(filename, {})
        if (r.get("tic_id") != target.tic_id or r.get("sector") != sector
                or not r.get("procver") or len(r.get("sha256", "")) != 64):
            raise ValueError(f"holdout product not pinned: {filename}")
        products.append({k: r[k] for k in ("filename", "tic_id", "sector", "sha256", "procver")})
    for target in HOLDOUT_TARGETS:
        rows = [r for r in refs if r["target_key"] == target.key]
        if not rows or any(not r.get("fetched_at") or r.get("tic_id") != f"TIC {target.tic_id}" for r in rows):
            raise ValueError(f"holdout reference query not pinned: {target.key}")
    return {"version": "1.0.0", "hash_method": "sha256-utf8-universal-newlines",
            "products": products,
            "files": {p.relative_to(root).as_posix(): text_digest(p) for p in lock_paths(root)}}


def validate_lock(path: Path = LOCK, root: Path = ROOT) -> dict:
    saved = json.loads(path.read_text(encoding="utf-8"))
    if saved != build_lock(root):
        raise ValueError("holdout lock mismatch: inputs/code/settings changed; do not evaluate or tune on results")
    return saved


def validate_run(args, cfg: dict, settings: list) -> None:
    target_keys = {t.key for t in HOLDOUT_TARGETS}
    if args.stage != "holdout":
        if args.target in target_keys:
            raise ValueError("holdout targets require --stage holdout")
        return
    if (args.target not in target_keys or [s.setting_id for s in settings] != ["poc_linear20k"]
            or args.no_noise or args.noise_seeds != SEEDS or args.limit != 0 or args.include_raw_real):
        raise ValueError("holdout requires its registered target, poc_linear20k, all groups, realclean and three fixed seeds")
    expected = {"settings": "experiments/tess-bench/configs/bls_settings_v1.json",
                "preprocess_settings": "experiments/tess-bench/configs/preprocess_settings_v1.json",
                "grid": "experiments/tess-fixture/configs/injection_grid_v1.json"}
    for field, name in expected.items():
        if getattr(args, field).resolve() != (ROOT / name).resolve():
            raise ValueError(f"holdout requires pinned {field}")
    if cfg["preprocess_setting_id"] != "biweight_1.0d":
        raise ValueError("holdout preprocessing mismatch")
    validate_lock()

import json
from types import SimpleNamespace

import numpy as np
import pytest

from tess_bench import cli, holdout as ho, bls
from tess_fixture.targets import HOLDOUT_TARGETS, TARGETS, select_targets


def args_for(target=HOLDOUT_TARGETS[0]):
    return cli.build_parser().parse_args([
        "bls", "--target", target.key, "--stage", "holdout", "--only", "poc_linear20k",
        "--noise-seeds", *map(str, ho.SEEDS)])


def test_holdout_registration_does_not_change_default_fixture():
    assert len(TARGETS) == 9
    assert select_targets(None) == TARGETS
    assert [(t.tic_id, t.sectors) for t in HOLDOUT_TARGETS] == [
        (268637577, (3,)), (100102268, (2, 3)), (219237079, (3, 4, 5)), (358253008, (2, 3, 4, 5))]
    for t in HOLDOUT_TARGETS:
        assert select_targets([t.key]) == (t,)


@pytest.mark.parametrize("field,value", [("no_noise", True), ("limit", 1),
    ("noise_seeds", [20260910]), ("include_raw_real", True), ("target", "toi270")])
def test_holdout_rejects_partial_or_altered_evaluation(field, value):
    args = args_for()
    setattr(args, field, value)
    cfg, settings = bls.load_bls_settings(args.settings, args.only)
    with pytest.raises(ValueError, match="holdout requires"):
        ho.validate_run(args, cfg, settings)


def test_holdout_cannot_be_used_for_tuning():
    args = args_for()
    args.stage = "tuning"
    cfg, settings = bls.load_bls_settings(args.settings, args.only)
    with pytest.raises(ValueError, match="require --stage holdout"):
        ho.validate_run(args, cfg, settings)


def test_lock_change_is_rejected(tmp_path):
    saved = ho.build_lock()
    path = tmp_path / "lock.json"
    path.write_text(json.dumps(saved), encoding="utf-8")
    assert ho.validate_lock(path) == saved
    saved["products"][0]["procver"] = "changed"
    path.write_text(json.dumps(saved), encoding="utf-8")
    with pytest.raises(ValueError, match="lock mismatch"):
        ho.validate_lock(path)


@pytest.mark.parametrize("target", HOLDOUT_TARGETS)
def test_cli_writes_holdout_manifest_without_running_science(monkeypatch, tmp_path, target):
    """Exercise actual CLI CSV/manifest writer; mock computation, never evaluate holdout."""
    # Exercise lock validation against an isolated current-code fixture. The
    # historical evaluation lock must remain unchanged as development continues.
    test_lock = tmp_path / "holdout_lock.json"
    test_lock.write_text(json.dumps(ho.build_lock()), encoding="utf-8")
    validate_lock = ho.validate_lock
    monkeypatch.setattr(ho, "LOCK", test_lock)
    monkeypatch.setattr(ho, "validate_lock", lambda: validate_lock(test_lock))
    args = args_for(target)
    args.results = tmp_path
    cfg, _ = bls.load_bls_settings(args.settings, args.only)
    strict = SimpleNamespace(time=np.array([1., 28.]), sectors=target.sectors, n_valid=2)
    baseline_keys = ["realclean", *[f"noise{s}" for s in ho.SEEDS]]
    bi = SimpleNamespace(target=target, strict=strict, stage_cfg=cfg["stages"]["holdout"],
        baselines={k: strict for k in baseline_keys}, groups={k: {} for k in baseline_keys},
        noise_seeds=ho.SEEDS, set_id="injection_grid_v1-1.1.0", known_models=[], known_skipped=[],
        inputs=[], prepared={}, n_groups=0)
    monkeypatch.setattr(cli, "build_bls_inputs", lambda *a, **kw: bi)
    monkeypatch.setattr(cli, "preprocess_groups", lambda *a, **kw: None)
    monkeypatch.setattr(cli, "_print_bls_final_table", lambda *a: None)
    monkeypatch.setattr(cli.mf, "code_info", lambda *a: {"git_commit": "test", "git_dirty": False})
    assert cli.cmd_bls(args) == 0
    man = json.loads(next((tmp_path / "manifests").glob("*.json")).read_text(encoding="utf-8"))
    p = man["config"]["parameters"]
    assert (p["target"], p["tic_id"], p["sectors"], p["stage"]) == (target.key, target.tic_id, list(target.sectors), "holdout")
    assert p["settings"] == ["poc_linear20k"]
    assert p["grid_set_id"] == "injection_grid_v1-1.1.0"
    assert p["noise_seeds"] == ho.SEEDS and p["baselines"] == baseline_keys
    assert {r["role"] for r in man["inputs"]} >= {"holdout_criteria", "holdout_lock", "references", "fixture_checksums"}
    assert all(r["sha256"] for r in man["outputs"])


def test_holdout_cli_stops_before_computation_on_lock_mismatch(monkeypatch):
    def reject_lock():
        raise ValueError("holdout lock mismatch")

    def unexpected_computation(*args, **kwargs):
        pytest.fail("holdout computation must not start after lock failure")

    monkeypatch.setattr(ho, "validate_lock", reject_lock)
    monkeypatch.setattr(cli, "build_bls_inputs", unexpected_computation)
    with pytest.raises(ValueError, match="holdout lock mismatch"):
        cli.cmd_bls(args_for())

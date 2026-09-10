"""S15P21C206-44 회귀 테스트: 통과 겹침 격자, 실행별 산출물 보존, 참고값 부분 갱신."""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

from tess_fixture import cli, inject as inj, references as refs
from tess_fixture.lightcurve import Baseline

PKG = Path(__file__).resolve().parents[1]
GRID_PATH = PKG / "configs" / "injection_grid_v1.json"


def _fake_baseline(n_days=27.0, cadence_min=2.0, seed=3):
    rng = np.random.default_rng(seed)
    t = np.arange(1400.0, 1400.0 + n_days, cadence_min / 1440.0)
    f = 1.0 + rng.normal(0, 5e-4, size=t.shape)
    return Baseline(tic_id=1, sectors=(3,), time=t, flux=f, sector_of_point=np.full(t.shape, 3),
                    normalization_median={3: 1.0}, n_raw=len(t), n_valid=len(t), source_files=("fake.fits",))


# ---------------------------------------------------------------- 1. 통과 겹침 격자

def test_grid_version_bumped_and_set_id_carries_version():
    grid = inj.load_grid(GRID_PATH)
    assert grid["version"] == "1.1.0"
    assert inj.grid_set_id(grid) == "injection_grid_v1-1.1.0"


def test_overlapping_pair_has_identical_t0_and_shared_transits():
    grid = inj.load_grid(GRID_PATH)
    base = _fake_baseline()
    rows = inj.build_catalog(grid, base, baseline_id="fake-real", set_id=inj.grid_set_id(grid))
    pair = [r for r in rows if r.phase_label == "overlapping_transits"]
    assert len(pair) == 2
    s1, s2 = sorted(pair, key=lambda r: r.period_days)
    assert s2.period_days == pytest.approx(2 * s1.period_days)
    assert s2.t0_btjd == pytest.approx(s1.t0_btjd)          # 1.0.0 에서는 2일 어긋났다
    overlap = inj.transit_overlap_mask(base.time, pair)
    assert overlap.sum() > 0
    # 신호 2(8일)의 모든 통과는 신호 1(4일)의 통과와 겹친다
    only_s2 = inj.box_model(base.time, inj.Signal(s2.period_days, s2.duration_hours, s2.depth_ppm, s2.phase_fraction), s2.t0_btjd) < 1
    assert overlap.sum() == only_s2.sum()


def test_overlapping_points_flux_is_product_of_both_models():
    grid = inj.load_grid(GRID_PATH)
    base = _fake_baseline()
    rows = inj.build_catalog(grid, base, baseline_id="fake-real", set_id=inj.grid_set_id(grid))
    pair = [r for r in rows if r.phase_label == "overlapping_transits"]
    injected = inj.inject_group(base, pair)
    ratio = injected / base.flux
    overlap = inj.transit_overlap_mask(base.time, pair)
    expected = np.prod([1 - r.depth_ppm * 1e-6 for r in pair])
    np.testing.assert_allclose(ratio[overlap], expected, rtol=1e-12)
    # 겹치지 않는 통과 구간은 한 모델 값만, 통과 밖은 1
    single = [1 - r.depth_ppm * 1e-6 for r in pair]
    others = ratio[~overlap]
    assert set(np.round(np.unique(others), 12)) <= {round(1.0, 12), *[round(v, 12) for v in single]}


# ---------------------------------------------------------------- 2. 실행별 산출물 보존

def test_inject_run_dir_is_unique_per_run():
    t = datetime(2026, 9, 10, 4, 5, 6, tzinfo=timezone.utc)
    a = cli.inject_run_dir(Path("res"), "set-1.1.0", "toi270", "aaaaaaaa-0000", t)
    b = cli.inject_run_dir(Path("res"), "set-1.1.0", "toi270", "bbbbbbbb-0000", t)
    assert a != b
    assert a.parent == b.parent == Path("res") / "injections" / "set-1.1.0" / "toi270"
    assert a.name == "run-20260910T040506Z-aaaaaaaa"


def test_manifest_path_follows_results_root(tmp_path):
    p = cli.manifest_path(tmp_path / "custom", "inject-toi270", "12345678-abcd")
    assert p == tmp_path / "custom" / "manifests" / "inject-toi270-12345678.json"


SAMPLE_READY = all((PKG / "sample_raw" / "toi270" / f).is_file() for f in (
    "tess2018263035959-s0003-0000000259377017-0123-s_lc.fits",
    "tess2018292075959-s0004-0000000259377017-0124-s_lc.fits",
    "tess2018319095959-s0005-0000000259377017-0125-s_lc.fits"))


def _sha256(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _snapshot(paths) -> dict[Path, str]:
    return {p: _sha256(p) for p in paths}


def _small_grid(tmp_path: Path) -> Path:
    """테스트 비용을 줄인 격자: 단일 2점 + 다중 쌍 1개. 실제 격자와 같은 스키마."""
    grid = {
        "grid_id": "test_grid", "version": "0.1.0", "model": "box",
        "period_days": [3.0], "duration_hours": [2.0], "depth_ppm": [1000],
        "phase_fraction": {"start": 0.1, "middle": 0.5},
        "multi_signal_pairs": [{"pair_id": "pair", "signals": [
            {"period_days": 4.0, "duration_hours": 3.0, "depth_ppm": 3000, "phase_fraction": 0.5},
            {"period_days": 8.0, "duration_hours": 3.0, "depth_ppm": 2000, "phase_fraction": 0.25}]}],
    }
    path = tmp_path / "test_grid.json"
    path.write_text(json.dumps(grid), encoding="utf-8")
    return path


@pytest.mark.skipif(not SAMPLE_READY, reason="TOI-270 FITS 표본이 sample_raw/ 에 없음 (download 먼저)")
def test_consecutive_inject_runs_preserve_previous_outputs(tmp_path):
    results = tmp_path / "results"
    grid = _small_grid(tmp_path)
    common = ["inject", "--target", "toi270", "--results", str(results), "--grid", str(grid), "--write-curves"]

    # 1차 실행: 단일 신호만, 잡음 바탕곡선 없음
    cli.main(common + ["--single-only", "--no-noise"])
    set_dir = results / "injections" / "test_grid-0.1.0" / "toi270"
    runs_after_first = sorted(set_dir.iterdir())
    assert len(runs_after_first) == 1
    first_run = runs_after_first[0]
    first_manifest = next((results / "manifests").glob("inject-toi270-*.json"))
    first_files = [first_run / "catalog.csv", *sorted(first_run.rglob("*.npz")), first_manifest]
    assert len([p for p in first_files if p.suffix == ".npz"]) == 1 + 2          # baseline + 단일 2 group
    before = _snapshot(first_files)

    # 2차 실행: 옵션을 바꿔(다중 쌍 포함, 잡음 seed 7) 같은 results 루트에 실행
    cli.main(common + ["--noise-seed", "7"])

    # 1차 산출물이 전부 남아 있고 바이트 단위로 같다
    for path, digest in before.items():
        assert path.is_file(), f"1차 산출물이 사라짐: {path}"
        assert _sha256(path) == digest, f"1차 산출물이 바뀜: {path}"

    # 같은 초에 두 번 실행되면 이름 정렬이 run_id 순이 되므로 순서에 의존하지 않는다
    runs = set(set_dir.iterdir())
    assert len(runs) == 2 and first_run in runs
    second_run = (runs - {first_run}).pop()
    manifests = sorted((results / "manifests").glob("inject-toi270-*.json"))
    assert len(manifests) == 2

    # 각 manifest 의 모든 outputs 는 자기 run_dir 안에 있고 실제 파일이다
    run_dirs = set()
    for m in manifests:
        data = json.loads(m.read_text(encoding="utf-8"))
        run_dir = Path(data["config"]["parameters"]["run_dir"])
        run_dirs.add(run_dir)
        assert run_dir.parent == set_dir
        assert data["outputs"], "outputs 가 비어 있음"
        for out in data["outputs"]:
            p = Path(out["path"])
            assert p.is_relative_to(run_dir), f"{p} 가 {run_dir} 밖에 있음"
            assert p.is_file(), f"outputs 경로가 실제 파일이 아님: {p}"
        listed = {Path(o["path"]) for o in data["outputs"]}
        assert listed == {run_dir / "catalog.csv", *run_dir.rglob("*.npz")}   # 디스크 산출물과 1:1
    assert run_dirs == runs

    # 1차 = 단일 2행, 2차 = (단일 2 + 쌍 2) × (real + noise) = 8행
    def _rows(run: Path) -> int:
        return sum(1 for _ in open(run / "catalog.csv", encoding="utf-8")) - 1
    assert _rows(first_run) == 2
    assert _rows(second_run) == 8
    assert len(sorted(second_run.rglob("*.npz"))) == 2 * (1 + 3)                 # 두 바탕곡선 × (baseline + 3 group)


# ---------------------------------------------------------------- 3. 참고값 부분 갱신

def _row(key, name, per):
    return {"target_key": key, "role": "r", "tic_id": "TIC 1", "hostname": name, "pl_name": f"{name} b",
            "pl_orbper": per, "fetched_at": "old"}


def test_merge_references_replaces_only_selected_targets():
    existing = [_row("toi270", "TOI-270", "3.36"), _row("toi270", "TOI-270", "5.66"),
                _row("cm_dra", "CM Dra", ""), _row("wasp18", "WASP-18", "0.94")]
    new = [dict(_row("cm_dra", "CM Dra", ""), fetched_at="new")]
    merged = refs.merge_references(existing, new, refreshed_keys={"cm_dra"}, key_order=["toi270", "cm_dra", "wasp18"])
    assert [r["target_key"] for r in merged] == ["toi270", "toi270", "cm_dra", "wasp18"]
    assert [r["fetched_at"] for r in merged if r["target_key"] == "cm_dra"] == ["new"]
    assert sum(1 for r in merged if r["target_key"] == "toi270") == 2


def test_merge_references_keeps_target_with_no_archive_rows():
    existing = [_row("toi270", "TOI-270", "3.36"), _row("cm_dra", "CM Dra", "")]
    # fetch_references 는 결과 0건이면 빈 자리표시 행을 만든다. 그 행이 그대로 남아야 한다.
    placeholder = {**_row("cm_dra", "CM Draconis", ""), "pl_name": "", "fetched_at": "new"}
    merged = refs.merge_references(existing, [placeholder], refreshed_keys={"cm_dra"}, key_order=["toi270", "cm_dra"])
    assert [r["target_key"] for r in merged] == ["toi270", "cm_dra"]
    assert merged[1]["fetched_at"] == "new" and merged[1]["pl_name"] == ""


def test_write_then_read_references_roundtrip(tmp_path):
    rows = [_row("toi270", "TOI-270", "3.36")]
    refs.write_references(rows, tmp_path / "r.csv")
    back = refs.read_references(tmp_path / "r.csv")
    assert back[0]["target_key"] == "toi270" and back[0]["pl_orbper"] == "3.36"

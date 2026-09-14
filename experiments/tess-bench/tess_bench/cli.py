# -*- coding: utf-8 -*-
"""벤치마크 명령행.

    python -m tess_bench preprocess --target toi270 [--only savgol_0.5d biweight_1.0d] [--limit 20]

실행 중 설정마다 진행 상황과 요약 수치를 터미널에 출력하고, 끝나면 설정별 요약표를 다시 보여준다.
산출물은 results/bench/<settings_id>-<version>/<target>/run-<UTC>-<id>/ 에 metrics.csv, summary.csv 로 남고
실행 manifest 는 results/manifests/ 에 남는다 (tess_fixture 의 스키마).
"""

from __future__ import annotations

import argparse
import csv
import shlex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from tess_fixture import download as dl
from tess_fixture import inject as inj
from tess_fixture import manifest as mf
from tess_fixture.lightcurve import Baseline, build_baseline, load_sector, synthetic_noise_baseline
from tess_fixture.targets import iter_products, select_targets

from . import metrics as mt
from .preprocess import Setting, load_settings, preprocess

PKG_DIR = Path(__file__).resolve().parent.parent            # experiments/tess-bench
REPO_DIR = PKG_DIR.parent.parent
FIXTURE_DIR = PKG_DIR.parent / "tess-fixture"
DEFAULT_RAW = FIXTURE_DIR / "sample_raw"
DEFAULT_GRID = FIXTURE_DIR / "configs" / "injection_grid_v1.json"
FIXTURE_CHECKSUMS = FIXTURE_DIR / "checksums.json"
DEFAULT_SETTINGS = PKG_DIR / "configs" / "preprocess_settings_v1.json"
DEFAULT_RESULTS = PKG_DIR / "results"
TASK = "S15P21C206-42"

SUMMARY_COLUMNS = ("setting_id", "factor", "baseline_id", "n_signals", "depth_ratio_median", "depth_ratio_0.5h",
                   "depth_ratio_2h", "depth_ratio_8h", "in_transit_kept_median", "oot_scatter_ppm_median",
                   "boundary_ratio_median", "failed_segments_per_curve", "edge_masked_fraction",
                   "n_points_after_quality", "elapsed_s")


def _command_line() -> str:
    return "python -m tess_bench " + " ".join(shlex.quote(a) for a in sys.argv[1:])


def _fmt(v, width=6, prec=2):
    return f"{v:{width}.{prec}f}" if isinstance(v, float) and np.isfinite(v) else f"{'nan':>{width}}"


def _print_setting_summary(setting: Setting, baseline_id: str, s: dict, elapsed: float) -> None:
    print(f"    [{baseline_id:<14}] 깊이보존 중앙값 {_fmt(s['depth_ratio_median'])} | 0.5h {_fmt(s['depth_ratio_0.5h'])} "
          f"| 2h {_fmt(s['depth_ratio_2h'])} | 8h {_fmt(s['depth_ratio_8h'])} | 통과점 유지 {_fmt(s['in_transit_kept_median'])} "
          f"| 잡음 {_fmt(s['oot_scatter_ppm_median'], 7, 0)} ppm | 경계 {_fmt(s['boundary_ratio_median'])} "
          f"| 실패구간 {s['failed_segments_per_curve']:>3} | 가장자리 제외 {s['edge_masked_fraction']*100:4.1f}% | {elapsed:5.1f}s")


def _print_final_table(summary_rows: list[dict]) -> None:
    print("\n=== 설정별 요약 (real 바탕곡선) ===")
    head = (f"{'설정':<26}{'요인':<10}{'깊이보존':>9}{'0.5h':>7}{'2h':>7}{'8h':>7}{'통과유지':>9}{'잡음ppm':>9}{'경계':>7}"
            f"{'실패':>6}{'제외%':>7}{'점수':>8}")
    print(head)
    print("-" * len(head))
    for r in summary_rows:
        if not r["baseline_id"].endswith("-real"):
            continue
        print(f"{r['setting_id']:<26}{r['factor']:<10}{_fmt(r['depth_ratio_median'], 9)}{_fmt(r['depth_ratio_0.5h'], 7)}"
              f"{_fmt(r['depth_ratio_2h'], 7)}{_fmt(r['depth_ratio_8h'], 7)}{_fmt(r['in_transit_kept_median'], 9)}"
              f"{_fmt(r['oot_scatter_ppm_median'], 9, 0)}{_fmt(r['boundary_ratio_median'], 7)}{r['failed_segments_per_curve']:>6}"
              f"{r['edge_masked_fraction']*100:>7.1f}{r['n_points_after_quality']:>8}")
    noise = [r for r in summary_rows if not r["baseline_id"].endswith("-real")]
    if noise:
        print("\n=== 잡음 바탕곡선 (순수 잡음 + 주입) ===")
        for r in noise:
            print(f"{r['setting_id']:<22}깊이보존 {_fmt(r['depth_ratio_median'])}  잡음 {_fmt(r['oot_scatter_ppm_median'], 7, 0)} ppm")
    print("\n읽는 법: 깊이보존 1.0 = 심은 깊이 그대로. 8h 열이 낮아지면 창이 짧아 긴 통과를 깎은 것. 통과유지가 1.0 아래면"
          " 마스크·clipping 이 통과 점을 지운 것(가장자리 제외 설정에서 봐야 할 열). 잡음은 낮을수록 좋지만"
          " 깊이보존과 함께 봐야 한다. 경계는 |flux−1| 중앙값/잡음 비율이라 순수 잡음이면 약 0.67(정규분포 기대값)이고,"
          " 그보다 눈에 띄게 크면 구간 경계 근처에 추세 잔여·왜곡이 있다는 뜻.")


def cmd_preprocess(args: argparse.Namespace) -> int:
    started = time.time()
    target = select_targets([args.target])[0]
    cfg, settings = load_settings(args.settings, args.only)
    grid = inj.load_grid(args.grid)
    expected = dl.load_expected_checksums(FIXTURE_CHECKSUMS)

    # 입력 FITS (fixture checksum 대조)
    curves, inputs = [], []
    for _, sector, filename, url in iter_products((target,)):
        path = args.raw / target.key / filename
        if not path.is_file():
            sys.exit(f"missing {path}; run `python -m tess_fixture download --target {target.key}` in tess-fixture first")
        digest = dl.sha256_of(path)
        if expected.get(filename) and expected[filename] != digest:
            sys.exit(f"checksum mismatch for {filename}")
        curves.append(load_sector(path))
        inputs.append({"path": str(path), "sha256": digest, "size_bytes": path.stat().st_size, "source_uri": url,
                       "tic_id": target.tic_id, "sector": sector, "role": "raw_product"})

    # 주입 목록은 fixture 와 같은 규칙(QUALITY==0 바탕곡선)으로 만든다 → tess_fixture inject 와 동일한 catalog
    strict = build_baseline(curves)
    set_id = inj.grid_set_id(grid)
    catalogs: dict[str, list[inj.InjectionRow]] = {
        "real": inj.build_catalog(grid, strict, baseline_id=f"{target.key}-real", set_id=set_id, include_multi=not args.single_only)}
    if not args.no_noise:
        catalogs[f"noise{args.noise_seed}"] = inj.build_catalog(
            grid, strict, baseline_id=f"{target.key}-noise{args.noise_seed}", set_id=set_id, include_multi=not args.single_only)
    if args.limit:
        for k, rows in catalogs.items():
            keep_groups = list(dict.fromkeys(r.group_id for r in rows))[:args.limit]
            catalogs[k] = [r for r in rows if r.group_id in keep_groups]

    run_id = mf.new_run_id()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.results / "bench" / f"{cfg['settings_id']}-{cfg['version']}" / target.key / f"run-{stamp}-{run_id[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    n_groups = sum(len({r.group_id for r in rows}) for rows in catalogs.values())
    print(f"target={target.key} sectors={list(strict.sectors)} points(QUALITY==0)={strict.n_valid:,} "
          f"settings={len(settings)} groups/setting={n_groups} run={run_dir.name}")

    baseline_cache: dict[tuple, Baseline] = {}

    def get_baseline(bitmask, noise_seed) -> Baseline:
        key = (bitmask, noise_seed)
        if key not in baseline_cache:
            real = baseline_cache.setdefault((bitmask, None), build_baseline(curves, quality_bitmask=bitmask))
            baseline_cache[key] = real if noise_seed is None else synthetic_noise_baseline(real, seed=noise_seed)
        return baseline_cache[key]

    metric_rows: list[dict] = []
    summary_rows: list[dict] = []
    for i, setting in enumerate(settings, 1):
        print(f"\n[{i}/{len(settings)}] {setting.setting_id:<22} ({setting.factor}) {setting.description}")
        t_setting = time.time()
        for baseline_key, rows in catalogs.items():
            seed = None if baseline_key == "real" else int(baseline_key.removeprefix("noise"))
            baseline = get_baseline(setting.quality_bitmask, seed)
            groups: dict[str, list[inj.InjectionRow]] = {}
            for r in rows:
                groups.setdefault(r.group_id, []).append(r)
            per_setting: list[dict] = []
            t0 = time.time()
            for g_i, (gid, members) in enumerate(groups.items(), 1):
                flux = inj.inject_group(baseline, members)
                result = preprocess(baseline.time, flux, baseline.sector_of_point, setting)
                for member in members:
                    m = mt.signal_metrics(result, members, member).as_row()
                    m.update({"setting_id": setting.setting_id, "factor": setting.factor, "baseline_id": f"{target.key}-{baseline_key}",
                              "n_points_after_quality": baseline.n_valid})
                    per_setting.append(m)
                if g_i % 25 == 0 or g_i == len(groups):
                    print(f"\r    [{baseline_key:<14}] {g_i:>4}/{len(groups)} groups  {time.time() - t0:5.1f}s", end="", flush=True)
            print()
            metric_rows.extend(per_setting)
            s = mt.summarize(per_setting)
            elapsed = time.time() - t0
            s.update({"setting_id": setting.setting_id, "factor": setting.factor, "baseline_id": f"{target.key}-{baseline_key}",
                      "n_points_after_quality": baseline.n_valid, "elapsed_s": round(elapsed, 2)})
            summary_rows.append(s)
            _print_setting_summary(setting, baseline_key, s, elapsed)
        print(f"    설정 소요 {time.time() - t_setting:5.1f}s")

    metrics_path = run_dir / "metrics.csv"
    with metrics_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(metric_rows[0].keys()))
        writer.writeheader()
        writer.writerows(metric_rows)
    summary_path = run_dir / "summary.csv"
    with summary_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(SUMMARY_COLUMNS), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(summary_rows)

    _print_final_table(summary_rows)

    manifest = mf.build_manifest(
        task=f"{TASK} preprocess", command=_command_line(), repo_dir=REPO_DIR, run_id=run_id,
        inputs=inputs + [mf.file_entry(args.grid, role="grid"), mf.file_entry(args.settings, role="settings")],
        config={"name": args.settings.name, "version": cfg["version"], "sha256": mf.file_entry(args.settings)["sha256"],
                "parameters": {"target": target.key, "settings": [s.setting_id for s in settings],
                               "setting_params": {s.setting_id: s.params() for s in settings},
                               "grid_set_id": set_id, "noise_seed": None if args.no_noise else args.noise_seed,
                               "single_only": args.single_only, "limit": args.limit, "run_dir": str(run_dir),
                               "n_points_quality0": strict.n_valid}},
        outputs=[mf.file_entry(metrics_path, kind="metrics", rows=len(metric_rows)),
                 mf.file_entry(summary_path, kind="summary", rows=len(summary_rows))],
        notes=f"total {time.time() - started:.1f}s",
        packages=("numpy", "scipy", "astropy"),      # savgol_filter 가 SciPy 라 버전을 함께 남긴다
    )
    mpath = mf.write_manifest(manifest, args.results / "manifests" / f"preprocess-{target.key}-{run_id[:8]}.json")
    print(f"\nmetrics:  {metrics_path}\nsummary:  {summary_path}\nmanifest: {mpath}\n총 소요 {time.time() - started:.1f}s")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tess_bench", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("preprocess", help="전처리·detrending 설정 비교 (S15P21C206-42)")
    p.add_argument("--target", required=True, help="fixture target key (예 toi270)")
    p.add_argument("--settings", type=Path, default=DEFAULT_SETTINGS)
    p.add_argument("--only", nargs="*", help="실행할 setting_id 만 고르기")
    p.add_argument("--grid", type=Path, default=DEFAULT_GRID)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--noise-seed", type=int, default=20260910)
    p.add_argument("--no-noise", action="store_true", help="잡음 바탕곡선 생략")
    p.add_argument("--single-only", action="store_true", help="다중 신호 쌍 생략")
    p.add_argument("--limit", type=int, default=0, help="바탕곡선당 처음 N group 만 (빠른 확인용)")
    p.set_defaults(func=cmd_preprocess)
    return parser


def main(argv: list[str] | None = None) -> int:
    # Windows 콘솔 기본 코드페이지(cp949)에서도 한글 진행 출력이 깨지지 않게 한다
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    args = build_parser().parse_args(argv)
    return args.func(args)

# -*- coding: utf-8 -*-
"""벤치마크 명령행.

    python -m tess_bench preprocess --target toi270 [--only savgol_0.5d biweight_1.0d] [--limit 20]
    python -m tess_bench bls --target toi270 --stage tuning [--only poc_linear20k ...] [--limit 20]
    python -m tess_bench bls-gates --run-dir results/bench/bls_grid_v1-1.0.0/toi270/run-<UTC>-<id>

실행 중 설정마다 진행 상황과 요약 수치를 터미널에 출력하고, 끝나면 설정별 요약표를 다시 보여준다.
산출물은 results/bench/<settings_id>-<version>/<target>/run-<UTC>-<id>/ 에 남고(preprocess: metrics.csv·summary.csv,
bls: peaks.csv·matches.csv·summary.csv, bls-gates: gates.csv) 실행 manifest 는 results/manifests/ 에 남는다 (tess_fixture 의 스키마).
"""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass, field
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

from . import bls as bl
from . import bls_dy as bd
from . import iterate as it
from . import bls_match as bm
from . import metrics as mt
from .preprocess import Setting, load_settings, preprocess

PKG_DIR = Path(__file__).resolve().parent.parent            # experiments/tess-bench
REPO_DIR = PKG_DIR.parent.parent
FIXTURE_DIR = PKG_DIR.parent / "tess-fixture"
DEFAULT_RAW = FIXTURE_DIR / "sample_raw"
DEFAULT_GRID = FIXTURE_DIR / "configs" / "injection_grid_v1.json"
FIXTURE_CHECKSUMS = FIXTURE_DIR / "checksums.json"
DEFAULT_SETTINGS = PKG_DIR / "configs" / "preprocess_settings_v1.json"
DEFAULT_BLS_SETTINGS = PKG_DIR / "configs" / "bls_settings_v1.json"
DEFAULT_RESULTS = PKG_DIR / "results"
TASK = "S15P21C206-42"
BLS_TASK = "S15P21C206-110"

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


# --------------------------------------------------------------------------- BLS 격자 벤치마크 (110)

BLS_SUMMARY_COLUMNS = ("setting_id", "factor", "baseline_id", "stage", "n_signals", "direct_recovery", "alias_inclusive_recovery",
                       "n_signals_in_range", "direct_recovery_in_range", "alias_inclusive_recovery_in_range",
                       "alias_recovery", "wrong_rate", "missed_rate", "matched_rank1_fraction", "period_rel_err_median_abs",
                       "epoch_err_hours_median", "duration_ratio_median", "depth_ratio_median",
                       "direct_period_<2d", "direct_period_2-10d", "direct_period_>=10d",
                       "direct_duration_<1h", "direct_duration_1-4h", "direct_duration_>=4h",
                       "direct_depth_<=1000ppm", "direct_depth_<=3000ppm", "direct_depth_>3000ppm",
                       "n_periods", "period_max_days", "bls_s_per_curve_median", "elapsed_s")


def _load_fixture_inputs(target, raw: Path) -> tuple[list, list[dict]]:
    expected = dl.load_expected_checksums(FIXTURE_CHECKSUMS)
    curves, inputs = [], []
    for _, sector, filename, url in iter_products((target,)):
        path = raw / target.key / filename
        if not path.is_file():
            sys.exit(f"missing {path}; run `python -m tess_fixture download --target {target.key}` in tess-fixture first")
        digest = dl.sha256_of(path)
        if expected.get(filename) and expected[filename] != digest:
            sys.exit(f"checksum mismatch for {filename}")
        curves.append(load_sector(path))
        inputs.append({"path": str(path), "sha256": digest, "size_bytes": path.stat().st_size, "source_uri": url,
                       "tic_id": target.tic_id, "sector": sector, "role": "raw_product"})
    return curves, inputs


def _print_bls_final_table(summary_rows: list[dict]) -> None:
    print("\n=== 설정별 요약 (realclean·real 바탕곡선, 게이트 없음 = 상위 5개 피크 안에 있는가) ===")
    head = (f"{'설정':<20}{'요인':<15}{'직접':>7}{'범위안':>7}{'alias포함':>10}{'틀림':>7}{'rank1':>7}{'|ΔP/P|':>9}{'epoch h':>9}"
            f"{'D비':>6}{'깊이비':>7}{'<=1000ppm':>10}{'>=10d':>7}{'격자점':>8}{'Pmax':>6}{'s/곡선':>8}")
    print(head); print("-" * len(head))
    for r in summary_rows:
        if "noise" in r["baseline_id"]:
            continue
        print(f"{r['setting_id']:<20}{r['factor']:<15}{_fmt(r['direct_recovery'],7)}{_fmt(r.get('direct_recovery_in_range', float('nan')),7)}"
              f"{_fmt(r['alias_inclusive_recovery'],10)}{_fmt(r['wrong_rate'],7)}"
              f"{_fmt(r['matched_rank1_fraction'],7)}{_fmt(r['period_rel_err_median_abs'],9,5)}{_fmt(r['epoch_err_hours_median'],9)}"
              f"{_fmt(r['duration_ratio_median'],6)}{_fmt(r['depth_ratio_median'],7)}{_fmt(r.get('direct_depth_<=1000ppm', float('nan')),10)}"
              f"{_fmt(r.get('direct_period_>=10d', float('nan')),7)}{r['n_periods']:>8}{_fmt(r.get('period_max_days', float('nan')),6,1)}{_fmt(r['bls_s_per_curve_median'],8,1)}")
    noise = [r for r in summary_rows if "noise" in r["baseline_id"]]
    if noise:
        print("\n=== 잡음 바탕곡선 (백색 잡음 + 주입) ===")
        for r in noise:
            print(f"{r['setting_id']:<20}{r['baseline_id'].rsplit('-',1)[1]:<14}직접 {_fmt(r['direct_recovery'])}  범위안 {_fmt(r.get('direct_recovery_in_range', float('nan')))}"
                  f"  alias포함 {_fmt(r['alias_inclusive_recovery'])}  s/곡선 {_fmt(r['bls_s_per_curve_median'],6,1)}")
    print("\n읽는 법: 직접 = 상위 5 피크 중 하나가 SRS 5.1 누적 오차 규칙(|ΔP|×N ≤ D/2)과 통과 창 중첩 ≥ 0.5 를 만족한 주입 비율."
          " 범위안 = 주입 주기가 그 설정의 탐색 상한(Pmax) 안인 신호만의 직접 회수율. 관측 기간이 짧은 별은 20일 주입이 범위 밖이라"
          " 전체 값이 낮게 나오므로 설정 비교는 범위안 열로 한다. alias포함 은 P/2·2P 로 잡힌 것까지. rank1 은 매칭 피크가 1위였던 비율."
          " 이 표에는 품질 게이트가 없다. 게이트별 회수율·가짜 후보 수·실제 곡선 잔여 피크 수는 `bls-gates` 로 같은 run 에서 계산한다.")


@dataclass
class BlsInputs:
    """`bls` 와 `bls-snr-dy` 가 공유하는 입력: 바탕곡선·주입 그룹·전처리 곡선."""
    target: object
    stage: str
    stage_cfg: dict
    pre: Setting
    set_id: str
    curves: list
    inputs: list[dict]
    strict: Baseline
    baselines: dict[str, Baseline]
    known_models: list[dict]
    known_skipped: list[dict]
    noise_seeds: list[int]
    groups: dict[str, dict[str, list]]
    prepared: dict[tuple[str, str], tuple[np.ndarray, np.ndarray]] = field(default_factory=dict)
    errors: dict[tuple[str, str], np.ndarray | None] = field(default_factory=dict)   # flux_err 방식용 점 오차(정제곡선 단위), 없으면 None

    @property
    def n_groups(self) -> int:
        return sum(len(g) for g in self.groups.values())


def build_bls_inputs(target_key: str, stage: str, cfg: dict, pre: Setting, grid_path: Path, raw: Path, *,
                     noise_seeds: list[int], include_raw_real: bool = False, limit: int = 0, log=print) -> BlsInputs:
    """바탕곡선(realclean·잡음·선택 real)과 주입 그룹을 만든다. 전처리는 `preprocess_groups` 에서."""
    target = select_targets([target_key])[0]
    stage_cfg = cfg["stages"][stage]
    grid = inj.load_grid(grid_path)
    curves, inputs = _load_fixture_inputs(target, raw)
    strict = build_baseline(curves)
    set_id = inj.grid_set_id(grid)
    if target.key not in stage_cfg["targets"]:
        log(f"주의: {target.key} 는 stage '{stage}' 의 별 목록 {stage_cfg['targets']} 에 없다. 결과에 stage 를 그대로 기록하되 해석 때 구분할 것.")

    # 바탕곡선: realclean(Archive 확인 행성을 121 astro-kernel 로 제거) 이 기본. 실제 행성이 상위 피크를 차지하면
    # 주입 회수율을 잴 수 없기 때문. 원본 real 은 --include-raw-real 로 추가(실제 신호와의 상호작용 관찰용).
    from dataclasses import replace as dc_replace
    from astro_kernel import remove_transit_models
    from tess_fixture import references as refs
    ref_rows = refs.read_references(FIXTURE_DIR / "references.csv")
    known_models, known_skipped = bl.known_signal_models(ref_rows, target.key)
    if known_models:
        cleaned = remove_transit_models(strict.time, strict.flux, known_models).flux_residual
        realclean = dc_replace(strict, flux=cleaned, source_files=tuple(f"{f} (known signals removed)" for f in strict.source_files))
        log(f"realclean: Archive 확인 행성 {len(known_models)}개 제거 {[m['candidate_id'] for m in known_models]}"
            + (f", 제외 {known_skipped}" if known_skipped else ""))
    else:
        realclean = strict
        log(f"realclean: 제거할 Archive 확인 행성 없음(식쌍성 등). real 과 동일" + (f", 제외 {known_skipped}" if known_skipped else ""))
    baselines: dict[str, Baseline] = {"realclean": realclean}
    if include_raw_real:
        baselines["real"] = strict
    seeds = list(dict.fromkeys(noise_seeds))
    for seed in seeds:
        baselines[f"noise{seed}"] = synthetic_noise_baseline(strict, seed=seed)
    groups: dict[str, dict[str, list[inj.InjectionRow]]] = {}
    for bkey, baseline in baselines.items():
        rows = inj.build_catalog(grid, baseline, baseline_id=f"{target.key}-{bkey}", set_id=set_id, include_multi=stage_cfg["include_multi"])
        rows = [r for r in rows if r.signal_index > 0 or r.phase_label in stage_cfg["phase_labels"] or r.group_id != r.injection_id]
        by_group: dict[str, list[inj.InjectionRow]] = {}
        for r in rows:
            by_group.setdefault(r.group_id, []).append(r)
        if limit:
            by_group = dict(list(by_group.items())[:limit])
        by_group["none"] = []                       # 주입 없는 순수 곡선: 잡음이면 가짜 후보 측정, real 이면 unknown_review
        groups[bkey] = by_group
    return BlsInputs(target=target, stage=stage, stage_cfg=stage_cfg, pre=pre, set_id=set_id, curves=curves, inputs=inputs, strict=strict,
                     baselines=baselines, known_models=known_models, known_skipped=known_skipped, noise_seeds=seeds, groups=groups)


def preprocess_groups(bi: BlsInputs, *, with_errors: bool = False) -> None:
    """전처리는 설정과 무관하므로 그룹마다 한 번만. with_errors 면 PDCSAP_FLUX_ERR 를 같은 추세로 나눈 점 오차도 남긴다."""
    err_norm = bd.baseline_flux_err(bi.curves, bi.strict) if with_errors else None
    noise_sigma = bi.strict.robust_scatter
    for bkey, by_group in bi.groups.items():
        baseline = bi.baselines[bkey]
        for gid, members in by_group.items():
            flux = inj.inject_group(baseline, members) if members else baseline.flux.copy()
            res = preprocess(baseline.time, flux, baseline.sector_of_point, bi.pre)
            kept = res.kept & np.isfinite(res.flux_det)
            bi.prepared[(bkey, gid)] = (res.time[kept], res.flux_det[kept])
            if with_errors:
                if bkey.startswith("noise"):
                    bi.errors[(bkey, gid)] = np.full(int(kept.sum()), noise_sigma)      # 합성 곡선: 생성 σ 가 참값
                else:
                    with np.errstate(invalid="ignore", divide="ignore"):
                        bi.errors[(bkey, gid)] = (err_norm / res.trend)[kept]


def cmd_bls(args: argparse.Namespace) -> int:
    started = time.time()
    cfg, settings = bl.load_bls_settings(args.settings, args.only)
    _, pre_settings = load_settings(args.preprocess_settings, [cfg["preprocess_setting_id"]])
    pre = pre_settings[0]
    bi = build_bls_inputs(args.target, args.stage, cfg, pre, args.grid, args.raw, noise_seeds=[] if args.no_noise else args.noise_seeds,
                          include_raw_real=args.include_raw_real, limit=args.limit)
    target, strict, baselines, groups, noise_seeds, set_id, known_models, known_skipped, inputs = (
        bi.target, bi.strict, bi.baselines, bi.groups, bi.noise_seeds, bi.set_id, bi.known_models, bi.known_skipped, bi.inputs)
    stage_cfg = bi.stage_cfg

    run_id = mf.new_run_id()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.results / "bench" / f"{cfg['settings_id']}-{cfg['version']}" / target.key / f"run-{stamp}-{run_id[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"target={target.key} stage={args.stage} sectors={list(strict.sectors)} points(QUALITY==0)={strict.n_valid:,} "
          f"baseline={strict.time.max()-strict.time.min():.1f}d preprocess={pre.setting_id} settings={len(settings)} groups={bi.n_groups} run={run_dir.name}")

    print("전처리 중...", end="", flush=True)
    t_pre = time.time()
    preprocess_groups(bi)
    prepared = bi.prepared
    print(f" {time.time()-t_pre:.1f}s ({len(prepared)} curves)")

    peak_rows: list[dict] = []
    match_rows: list[dict] = []
    summary_rows: list[dict] = []
    for i, setting in enumerate(settings, 1):
        print(f"\n[{i}/{len(settings)}] {setting.setting_id:<20} ({setting.factor}) {setting.description}")
        t_setting = time.time()
        for bkey, by_group in groups.items():
            baseline = baselines[bkey]
            bid = f"{target.key}-{bkey}"
            per_matches: list[dict] = []
            elapsed_list: list[float] = []
            n_periods = 0
            period_max = float("nan")
            pmax_setting = setting.period_max(float(np.nanmax(baseline.time) - np.nanmin(baseline.time)))
            t0 = time.time()
            for g_i, (gid, members) in enumerate(by_group.items(), 1):
                t_c, f_c = prepared[(bkey, gid)]
                try:
                    run = bl.run_bls(t_c, f_c, setting, baseline_time=baseline.time)
                except ValueError as exc:
                    peak_rows.append({"setting_id": setting.setting_id, "baseline_id": bid, "group_id": gid, "stage": args.stage,
                                      "is_pure_noise": str(bkey.startswith("noise") and not members).lower(), "n_points": int(t_c.size),
                                      "status": f"failed:{exc}", "rank": 0, **{k: "" for k in bl.PEAK_COLUMNS if k != "rank"},
                                      "n_periods": 0, "elapsed_s": ""})
                    for r in members:
                        match_rows.append({"setting_id": setting.setting_id, "baseline_id": bid, "stage": args.stage, "match": "missed",
                                           **{k: "" for k in bm.MATCH_COLUMNS if k not in ("match",)}, "injection_id": r.injection_id,
                                           "group_id": gid, "period_days": r.period_days, "duration_hours": r.duration_hours,
                                           "depth_ppm": r.depth_ppm, "phase_label": r.phase_label, "n_transits_in_window": r.n_transits_in_window,
                                           "period_max_days": round(pmax_setting, 4),
                                           "in_search_range": str(setting.period_min_days <= r.period_days <= pmax_setting).lower()})
                    continue
                elapsed_list.append(run.elapsed_s); n_periods = run.n_periods; period_max = run.period_max_days
                for p in run.peaks:
                    peak_rows.append({"setting_id": setting.setting_id, "baseline_id": bid, "group_id": gid, "stage": args.stage,
                                      "is_pure_noise": str(bkey.startswith("noise") and not members).lower(), "n_points": int(t_c.size),
                                      "status": "ok", **p.as_row(), "n_periods": run.n_periods, "elapsed_s": round(run.elapsed_s, 3)})
                for r in members:
                    m = bm.match_injection(t_c, r, run.peaks, window_overlap_min=cfg["matching"]["window_overlap_min"])
                    row = {"setting_id": setting.setting_id, "baseline_id": bid, "stage": args.stage, **m.as_row(),
                           "period_days": r.period_days, "duration_hours": r.duration_hours, "depth_ppm": r.depth_ppm,
                           "phase_label": r.phase_label, "n_transits_in_window": r.n_transits_in_window,
                           "period_max_days": round(run.period_max_days, 4),
                           "in_search_range": str(run.period_min_days <= r.period_days <= run.period_max_days).lower()}
                    match_rows.append(row); per_matches.append(row)
                if g_i % 10 == 0 or g_i == len(by_group):
                    print(f"\r    [{bkey:<14}] {g_i:>4}/{len(by_group)} curves  {time.time()-t0:6.1f}s", end="", flush=True)
            print()
            s = bm.summarize_matches(per_matches)
            s.update({"setting_id": setting.setting_id, "factor": setting.factor, "baseline_id": bid, "stage": args.stage,
                      "n_periods": n_periods, "period_max_days": period_max,
                      "bls_s_per_curve_median": float(np.median(elapsed_list)) if elapsed_list else float("nan"),
                      "elapsed_s": round(time.time() - t0, 2)})
            summary_rows.append(s)
            print(f"    [{bkey:<14}] 직접 {_fmt(s.get('direct_recovery', float('nan')))} 범위안 {_fmt(s.get('direct_recovery_in_range', float('nan')))}"
                  f"({s.get('n_signals_in_range', 0)}/{s.get('n_signals', 0)}) alias포함 {_fmt(s.get('alias_inclusive_recovery', float('nan')))} "
                  f"틀림 {_fmt(s.get('wrong_rate', float('nan')))} | |ΔP/P| {_fmt(s.get('period_rel_err_median_abs', float('nan')), 8, 5)} "
                  f"epoch {_fmt(s.get('epoch_err_hours_median', float('nan')), 5)}h | 격자 {n_periods:,}점 Pmax {_fmt(period_max, 5, 1)}d {_fmt(s['bls_s_per_curve_median'], 5, 1)}s/곡선")
        print(f"    설정 소요 {time.time() - t_setting:5.1f}s")

    peak_cols = ["setting_id", "baseline_id", "group_id", "stage", "is_pure_noise", "n_points", "status", *bl.PEAK_COLUMNS, "n_periods", "elapsed_s"]
    match_cols = ["setting_id", "baseline_id", "stage", *bm.MATCH_COLUMNS, "period_days", "duration_hours", "depth_ppm", "phase_label",
                  "n_transits_in_window", "period_max_days", "in_search_range"]
    peaks_path, matches_path, summary_path = run_dir / "peaks.csv", run_dir / "matches.csv", run_dir / "summary.csv"
    for path, cols, rows in ((peaks_path, peak_cols, peak_rows), (matches_path, match_cols, match_rows), (summary_path, list(BLS_SUMMARY_COLUMNS), summary_rows)):
        with path.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
            w.writeheader(); w.writerows(rows)
    _print_bls_final_table(summary_rows)

    manifest = mf.build_manifest(
        task=f"{BLS_TASK} bls", command=_command_line(), repo_dir=REPO_DIR, run_id=run_id,
        inputs=inputs + [mf.file_entry(args.grid, role="grid"), mf.file_entry(args.settings, role="bls_settings"),
                         mf.file_entry(args.preprocess_settings, role="preprocess_settings")],
        config={"name": args.settings.name, "version": cfg["version"], "sha256": mf.file_entry(args.settings)["sha256"],
                "parameters": {"target": target.key, "stage": args.stage, "stage_config": stage_cfg, "settings": [s.setting_id for s in settings],
                               "setting_params": {s.setting_id: s.params() for s in settings}, "preprocess_setting": pre.params(),
                               "grid_set_id": set_id, "noise_seeds": noise_seeds, "limit": args.limit,
                               "baselines": list(baselines), "known_signals_removed": known_models, "known_signals_skipped": known_skipped,
                               "matching": cfg["matching"], "sde_definition": cfg["sde_definition"], "run_dir": str(run_dir),
                               "n_points_quality0": strict.n_valid, "baseline_days": float(strict.time.max() - strict.time.min())}},
        outputs=[mf.file_entry(peaks_path, kind="peaks", rows=len(peak_rows)), mf.file_entry(matches_path, kind="matches", rows=len(match_rows)),
                 mf.file_entry(summary_path, kind="summary", rows=len(summary_rows))],
        notes=f"total {time.time() - started:.1f}s", packages=("numpy", "scipy", "astropy"),
    )
    mpath = mf.write_manifest(manifest, args.results / "manifests" / f"bls-{target.key}-{run_id[:8]}.json")
    print(f"\npeaks:    {peaks_path}\nmatches:  {matches_path}\nsummary:  {summary_path}\nmanifest: {mpath}\n총 소요 {time.time() - started:.1f}s")
    return 0


def _load_matches_in_range(run_dir: Path, settings_all, baseline_days: float | None) -> list[dict]:
    """matches.csv 를 읽고 in_search_range 열이 없는 옛 run 은 --baseline-days 로 채운다."""
    with (run_dir / "matches.csv").open(encoding="utf-8", newline="") as fh:
        matches = list(csv.DictReader(fh))
    if matches and "in_search_range" not in matches[0]:
        if baseline_days is None:
            print(f"주의: {run_dir.name} 의 matches.csv 에 in_search_range 열이 없다. 관측 기간을 주지 않아 전체 신호로 계산한다.")
        else:
            by_id = {s.setting_id: s for s in settings_all}
            for m in matches:
                s = by_id.get(m["setting_id"])
                pmax = s.period_max(baseline_days) if s else float("inf")
                m["in_search_range"] = str(float(m["period_days"]) <= pmax).lower()
    return matches


def cmd_bls_report(args: argparse.Namespace) -> int:
    """저장된 run 여러 개의 matches.csv 로 문서 5.1절 표(설정별·구간별 회수율)를 만든다. 재실행 없음.

    옛 run(in_search_range 열 없음)은 `--baseline-days` 를 run 순서대로 준다. 결과는 Markdown 표준 출력, `--out` 이면 파일.
    """
    cfg, settings_all = bl.load_bls_settings(args.settings)
    order = [s.setting_id for s in settings_all]
    rows: list[dict] = []
    bds = list(args.baseline_days or [])
    for i, run in enumerate(args.run_dir):
        rows.extend(_load_matches_in_range(Path(run), settings_all, bds[i] if i < len(bds) else None))
    rep = bm.report_tables(rows, baseline_filter=args.baseline, setting_order=order)
    md = bm.report_markdown(rep, compare=tuple(args.compare))
    if args.out:
        Path(args.out).write_text(md, encoding="utf-8", newline="\n"); print(f"report: {args.out}")
    else:
        print(md)
    if not rep["marginal_ok"]:
        print("주의: 구간표 주변합이 설정 사이에서 다르다. 쌍 분리나 범위 필터를 확인할 것.")
        return 1
    return 0


def cmd_bls_gates(args: argparse.Namespace) -> int:
    cfg, settings_all = bl.load_bls_settings(args.settings)
    g = cfg["gates"]
    with (args.run_dir / "peaks.csv").open(encoding="utf-8", newline="") as fh:
        peaks = [r for r in csv.DictReader(fh) if r["status"] == "ok"]
    with (args.run_dir / "matches.csv").open(encoding="utf-8", newline="") as fh:
        matches = [r for r in csv.DictReader(fh) if "noise" not in r["baseline_id"] or args.include_noise_signals]
    # 범위 안 신호만 회수율에 넣는다. 열이 없는 옛 run 은 --baseline-days 로 상한을 계산한다.
    if matches and "in_search_range" not in matches[0]:
        if args.baseline_days is None:
            print("주의: matches.csv 에 in_search_range 열이 없다. --baseline-days <관측 기간> 을 주면 설정별 상한으로 범위 안 신호를 고른다. 지금은 전체 신호로 계산.")
        else:
            by_id = {s.setting_id: s for s in settings_all}
            for m in matches:
                s = by_id.get(m["setting_id"])
                pmax = s.period_max(args.baseline_days) if s else float("inf")
                m["in_search_range"] = str(float(m["period_days"]) <= pmax).lower()
    if matches and "in_search_range" in matches[0]:
        matches = [m for m in matches if bm._truthy(m["in_search_range"])]
    table = bm.gate_table(peaks, matches, snr_thresholds=g["snr_thresholds"], sde_thresholds=g["sde_thresholds"], min_transits=g["min_transits"])
    out = args.run_dir / "gates.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(table[0].keys())); w.writeheader(); w.writerows(table)
    settings = sorted({r["setting_id"] for r in table})
    shown = [r for r in table if r["min_transits"] == ""]
    print(f"run={args.run_dir.name} settings={len(settings)} gates={len({r['gate'] for r in table})} 범위안 신호={table[0]['n_signals']} "
          f"잡음곡선={table[0]['n_noise_curves']} 실제곡선={table[0]['n_real_curves']} (아래는 통과 횟수 조건 없는 게이트만, 전체는 gates.csv)")
    print(f"{'gate':<22}" + "".join(f"{s[:22]:>24}" for s in settings))
    print(f"{'':<22}" + "".join(f"{'회수 | 가짜 | 잔여':>24}" for _ in settings))
    for gate in dict.fromkeys(r["gate"] for r in shown):
        cells = []
        for s in settings:
            r = next(x for x in shown if x["gate"] == gate and x["setting_id"] == s)
            cells.append(f"{_fmt(r['gated_recovery'],5)} | {_fmt(r['false_peaks_per_noise_curve'],4,1)} | {_fmt(r['residual_peaks_per_real_curve'],4,1)}".rjust(24))
        print(f"{gate:<22}" + "".join(cells))
    print("\n읽는 법: 회수 = 탐색 범위 안 주입 중 매칭 피크가 게이트를 통과한 비율. 가짜 = 순수 잡음 곡선 하나에서 게이트를 통과한 상위 피크 수(최대 5)."
          " 잔여 = 주입 없는 실제 곡선(알려진 행성 제거 후) 하나에서 게이트를 통과한 피크 수 — 자전 변광·제거 잔여·밝은 별 계통 오차가 후보로 남는 수."
          " 가짜와 잔여가 0 에 가까우면서 회수가 높은 게이트가 후보. 잔여는 미확인 신호일 수도 있어 가짜로 단정하지 않는다. 허용 목표는 TBD.")
    print(f"gates: {out}")
    return 0


def _run_manifest(run_dir: Path, results: Path) -> dict:
    """run 폴더 이름(run-<UTC>-<id8>)과 별 폴더로 manifest 를 찾는다."""
    target_key, id8 = run_dir.parent.name, run_dir.name.rsplit("-", 1)[-1]
    path = results / "manifests" / f"bls-{target_key}-{id8}.json"
    if not path.is_file():
        sys.exit(f"manifest not found: {path}")
    import json
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_bls_snr_dy(args: argparse.Namespace) -> int:
    """저장된 run 의 상위 피크 SNR 을 점 오차 방식 3개(global·flux_err·local)로 다시 계산하고 게이트 결과를 비교한다.

    재탐색은 하지 않는다. manifest 의 별·단계·seed·전처리 설정으로 같은 곡선을 다시 만들고(결정적), 피크 파라미터에서
    astropy `compute_stats` 로 depth/depth_err 를 낸다. global 은 저장된 snr 과 같아야 하며(재현 검사) 다르면 종료 코드 1.
    """
    started = time.time()
    run_dir: Path = args.run_dir
    man = _run_manifest(run_dir, args.results)
    prm = man["config"]["parameters"]
    cfg, settings_all = bl.load_bls_settings(args.settings)
    _, pre_settings = load_settings(args.preprocess_settings, [cfg["preprocess_setting_id"]])
    # 과거 run 에 다른 설정이 섞이지 않도록 manifest 와 현재 설정 파일·파라미터가 같은지 먼저 검사한다 (MR !77 리뷰).
    current_sha = {"grid": mf.file_entry(args.grid)["sha256"], "bls_settings": mf.file_entry(args.settings)["sha256"],
                   "preprocess_settings": mf.file_entry(args.preprocess_settings)["sha256"]}
    mismatches = bd.manifest_mismatches(prm, man.get("inputs", []), current_sha, grid_set_id=inj.grid_set_id(inj.load_grid(args.grid)),
                                        preprocess_params=pre_settings[0].params(), setting_params={s.setting_id: s.params() for s in settings_all})
    if mismatches:
        sys.exit(f"manifest 와 현재 설정이 다르다 ({', '.join(mismatches)}). 같은 설정 파일·격자로 실행하거나 run 을 다시 만들 것. 재계산을 중단한다.")
    print("manifest 동일성: grid·BLS 설정·전처리 설정 sha256, grid_set_id, 전처리·탐색 파라미터 일치")
    seeds = prm.get("noise_seeds", [prm["noise_seed"]] if prm.get("noise_seed") is not None else [])   # 조정 run(09-16) manifest 는 단수 키
    bi = build_bls_inputs(prm["target"], prm["stage"], cfg, pre_settings[0], args.grid, args.raw, noise_seeds=seeds,
                          include_raw_real="real" in prm.get("baselines", []), limit=int(prm.get("limit") or 0))
    print(f"run={run_dir.name} target={prm['target']} stage={prm['stage']} groups={bi.n_groups} window={args.window_days}d 전처리 중...", end="", flush=True)
    t0 = time.time()
    preprocess_groups(bi, with_errors=True)
    print(f" {time.time()-t0:.1f}s")

    with (run_dir / "peaks.csv").open(encoding="utf-8", newline="") as fh:
        peaks = [r for r in csv.DictReader(fh) if r["status"] == "ok"]
    if args.only:
        peaks = [r for r in peaks if r["setting_id"] in args.only]
    by_curve: dict[tuple[str, str, str], list[dict]] = {}
    for r in peaks:
        by_curve.setdefault((r["setting_id"], r["baseline_id"], r["group_id"]), []).append(r)
    target_key = bi.target.key
    out_rows: list[dict] = []
    for (sid, bid, gid), rows in by_curve.items():
        bkey = bid[len(target_key) + 1:]
        t_c, f_c = bi.prepared[(bkey, gid)]
        dys = bd.dy_arrays(t_c, f_c, bi.errors.get((bkey, gid)), window_days=args.window_days, min_points=args.min_points)
        snrs = {m: bd.recompute_snr(t_c, f_c, dys[m], rows) for m in bd.METHODS}
        for i, r in enumerate(rows):
            out_rows.append({"setting_id": sid, "baseline_id": bid, "group_id": gid, "rank": int(r["rank"]), "period_days": float(r["period_days"]),
                             "sde": float(r["sde"]), "snr_stored": float(r["snr"]),
                             **{f"snr_{m}": snrs[m][i] for m in bd.METHODS},
                             **{f"dy_{m}_median": float(np.median(dys[m])) for m in bd.METHODS}})
    snr_path = run_dir / "snr_dy.csv"
    with snr_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out_rows[0].keys())); w.writeheader(); w.writerows(out_rows)

    verdicts = bd.reproduction_verdict(out_rows)
    ok = bool(verdicts) and all(v["ok"] for v in verdicts)
    print(f"재현 검사 (설정별, global 재계산 vs 저장 snr): 중앙값 ≤ 1e-6, 1e-3 초과 비율 ≤ {bd.REPRODUCTION_COARSE_FRACTION_MAX:.0%}, 최대 < {bd.REPRODUCTION_ABS_MAX} — power() 위상 비닝 근사로 소수 피크만 다를 수 있다")
    for v in verdicts:
        print(f"  {v['setting_id']:<16} n={v['n']:>5} 중앙값 {v['median']:.2e} 1e-3 초과 {v['fraction_over_1e-3']:.1%} 최대 {v['max']:.2e} → {'일치' if v['ok'] else '불일치'}")

    matches = _load_matches_in_range(run_dir, settings_all, args.baseline_days)
    matches = [m for m in matches if "noise" not in m["baseline_id"]]
    if matches and "in_search_range" in matches[0]:
        matches = [m for m in matches if bm._truthy(m["in_search_range"])]
    snr_by = {(r["setting_id"], r["baseline_id"], r["group_id"], r["rank"]): r for r in out_rows}
    peaks_by_method = {}
    for m in bd.METHODS:
        rows = []
        for r in peaks:
            k = (r["setting_id"], r["baseline_id"], r["group_id"], int(r["rank"]))
            rows.append({**r, "snr": snr_by[k][f"snr_{m}"]})
        peaks_by_method[m] = rows
    table = bd.gate_comparison(peaks_by_method, matches, snr_min=args.snr_min, sde_min=args.sde_min)
    gates_path = run_dir / "gates_dy.csv"
    with gates_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(table[0].keys())); w.writeheader(); w.writerows(table)

    settings = sorted({r["setting_id"] for r in table})
    print(f"\n=== 게이트 비교 (회수 | 잡음 가짜/곡선 | 실제 잔여/곡선; 범위 안 신호 {table[0]['n_signals']}, 잡음곡선 {table[0]['n_noise_curves']}, 실제곡선 {table[0]['n_real_curves']}) ===")
    for sid in settings:
        print(f"[{sid}]")
        print(f"{'gate':<22}" + "".join(f"{m:>26}" for m in bd.METHODS))
        for gate in dict.fromkeys(r["gate"] for r in table if r["setting_id"] == sid):
            cells = []
            for m in bd.METHODS:
                r = next(x for x in table if x["method"] == m and x["setting_id"] == sid and x["gate"] == gate)
                cells.append(f"{_fmt(r['gated_recovery'],5)} | {_fmt(r['false_peaks_per_noise_curve'],4,1)} | {_fmt(r['residual_peaks_per_real_curve'],4,1)}".rjust(26))
            print(f"{gate:<22}" + "".join(cells))
    # 실제 none 곡선(잔여) 피크의 방식별 SNR — 어느 방식이 임의 피크를 낮추는지 직접 본다
    print("\n=== 실제 `none` 곡선 상위 피크의 SNR (방식별) ===")
    for r in sorted((x for x in out_rows if x["group_id"] == "none" and "noise" not in x["baseline_id"]), key=lambda x: (x["setting_id"], x["rank"])):
        print(f"  {r['setting_id']:<14} rank {r['rank']} P={r['period_days']:8.3f} d SDE={r['sde']:5.1f} "
              + " ".join(f"{m}={r[f'snr_{m}']:7.1f}" for m in bd.METHODS)
              + "  dy(med) " + " ".join(f"{m}={r[f'dy_{m}_median']:.2e}" for m in bd.METHODS))
    print(f"\nsnr_dy: {snr_path}\ngates_dy: {gates_path}\n총 소요 {time.time()-started:.1f}s")
    return 0 if ok else 1


def cmd_iterate(args: argparse.Namespace) -> int:
    """반복 BLS·고정 모델 제거 루프 벤치마크 (S15P21C206-111). 곡선마다 종료 사유·단계별 QA 수치·복구 결과를 기록한다."""
    started = time.time()
    cfg, settings = bl.load_bls_settings(args.settings, [args.setting])
    setting = settings[0]
    _, pre_settings = load_settings(args.preprocess_settings, [cfg["preprocess_setting_id"]])
    icfg = it.IterateConfig(snr_min=args.snr_min, sde_min=args.sde_min, min_transits=args.min_transits, max_candidates=args.max_candidates,
                            qa_window_offset_reference=args.window_offset_reference,
                            qa_window_offset_rel_depth=args.window_offset_rel_depth, refine_duration_max_hours=args.refine_duration_max_hours,
                            refine_duration_span=(0.5, 2.0) if args.refine_duration_max_hours > 0 else (0.7, 1.4),
                            continue_after_qa_fail=args.continue_after_qa_fail)
    bi = build_bls_inputs(args.target, args.stage, cfg, pre_settings[0], args.grid, args.raw, noise_seeds=[] if args.no_noise else args.noise_seeds,
                          include_raw_real=args.include_raw_real, limit=0)
    # 그룹 선택: pairs(쌍 주입) / singles(단일) / none(주입 없음) / all
    want = set(args.groups)
    for bkey, by_group in bi.groups.items():
        keep = {}
        for gid, members in by_group.items():
            kind = "none" if not members else ("pairs" if len(members) > 1 else "singles")
            if "all" in want or kind in want:
                keep[gid] = members
        if args.limit:
            pairs = {g: m for g, m in keep.items() if len(m) > 1}; rest = {g: m for g, m in keep.items() if len(m) <= 1}
            keep = {**pairs, **dict(list(rest.items())[:args.limit])}
        bi.groups[bkey] = keep
    run_id = mf.new_run_id()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = args.results / "bench" / f"bls_iterate_v1-{cfg['version']}" / bi.target.key / f"run-{stamp}-{run_id[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"target={bi.target.key} stage={args.stage} setting={setting.setting_id} gate=snr>={icfg.snr_min}&sde>={icfg.sde_min}&ntr>={icfg.min_transits} "
          f"max_candidates={icfg.max_candidates} groups={bi.n_groups} tamper={args.tamper_depth_factor} "
          f"opts(rel_depth={icfg.qa_window_offset_rel_depth}, reference={icfg.qa_window_offset_reference}, dur_max_h={icfg.refine_duration_max_hours}, continue={icfg.continue_after_qa_fail}) run={run_dir.name}")
    print("전처리 중...", end="", flush=True); t0 = time.time()
    preprocess_groups(bi)
    print(f" {time.time()-t0:.1f}s ({len(bi.prepared)} curves)")

    step_rows, iter_rows, match_rows = [], [], []
    for bkey, by_group in bi.groups.items():
        bid = f"{bi.target.key}-{bkey}"
        t_b = time.time()
        for g_i, (gid, members) in enumerate(by_group.items(), 1):
            t_c, f_c = bi.prepared[(bkey, gid)]
            truth = [(r.period_days, r.t0_btjd, r.duration_hours / 24.0) for r in members]
            kind = "none" if not members else ("pair:" + members[0].phase_label if len(members) > 1 else "single")
            res = it.iterate_curve(t_c, f_c, setting, icfg, truth=truth, tamper_depth_factor=args.tamper_depth_factor)
            matches = it.match_accepted(t_c, members, res.accepted, window_overlap_min=cfg["matching"]["window_overlap_min"])
            common = {"baseline_id": bid, "group_id": gid, "kind": kind, "setting_id": setting.setting_id}
            for s in res.steps:
                step_rows.append({**common, **s.as_row()})
            for m in matches:
                match_rows.append({**common, **m})
            iter_rows.append({**common, **it.summarize(res, matches),
                              "accepted_periods": ";".join(f"{c.period_days:.5f}" for c in res.accepted),
                              "blocked_periods": ";".join(f"{s.period_days:.5f}" for s in res.steps if s.status == "qa_failed"),
                              "accepted_original_snr": ";".join(f"{c.original_snr:.1f}" for c in res.accepted),
                              "elapsed_s": round(sum(s.bls_elapsed_s for s in res.steps if np.isfinite(s.bls_elapsed_s)), 2)})
            print(f"\r    [{bkey:<14}] {g_i:>4}/{len(by_group)} curves  {time.time()-t_b:6.1f}s", end="", flush=True)
        print()

    for name, rows in (("steps.csv", step_rows), ("iterations.csv", iter_rows), ("matches.csv", match_rows)):
        if rows:
            with (run_dir / name).open("w", newline="", encoding="utf-8") as fh:
                w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    # ---- 요약: 바탕곡선 × 종류별 종료 사유·회수·가짜 후보
    print("\n=== 곡선 종류별 요약 (종료 사유 수 | 정답 회수 | 가짜 후보 합 | QA 실패 곡선) ===")
    kinds = sorted({r["kind"] for r in iter_rows}, key=lambda k: ("none", "single", "pair").index(k.split(":")[0]) if k.split(":")[0] in ("none", "single", "pair") else 9)
    for bkey in bi.groups:
        bid = f"{bi.target.key}-{bkey}"
        for kind in kinds:
            rows = [r for r in iter_rows if r["baseline_id"] == bid and r["kind"] == kind]
            if not rows:
                continue
            term = {}
            for r in rows:
                term[r["termination"]] = term.get(r["termination"], 0) + 1
            n_inj = sum(r["n_injected"] for r in rows); n_rec = sum(r["n_recovered"] for r in rows)
            print(f"  [{bkey:<14}] {kind:<26} n={len(rows):>3} | " + ", ".join(f"{k}={v}" for k, v in sorted(term.items()))
                  + f" | 회수 {n_rec}/{n_inj} | 가짜 {sum(r['n_false_candidates'] for r in rows)} | QA실패 {sum(1 for r in rows if r['qa_failed_step'] >= 0)}")
    acc = [r for r in step_rows if r["status"] in ("accepted", "qa_failed")]
    if acc:
        def q(name):
            v = np.array([r[name] for r in acc], float); v = v[np.isfinite(v)]
            return (f"{name}: 중앙값 {np.median(v):.3f} 최소 {np.min(v):.3f} 최대 {np.max(v):.3f} "
                    f"절댓값최대 {np.max(np.abs(v)):.3f} (n={v.size})") if v.size else f"{name}: -"
        print("\n=== 제거 QA 원시 수치 (채택+실패 단계) ===")
        for name in ("power_ratio", "edge_excess", "window_offset_z", "window_offset_rel", "other_depth_log2_max", "overlap_fraction", "overlap_dev"):
            print("  " + q(name))
        fails = {}
        for r in acc:
            for f_ in filter(None, r["qa_failures"].split(",")):
                fails[f_] = fails.get(f_, 0) + 1
        print("  QA 실패 항목:", fails or "없음")

    manifest = mf.build_manifest(
        task="S15P21C206-111 iterate", command=_command_line(), repo_dir=REPO_DIR, run_id=run_id,
        inputs=bi.inputs + [mf.file_entry(args.grid, role="grid"), mf.file_entry(args.settings, role="bls_settings"), mf.file_entry(args.preprocess_settings, role="preprocess_settings"),
                           mf.file_entry(FIXTURE_DIR / "references.csv", role="references"), mf.file_entry(FIXTURE_CHECKSUMS, role="fixture_checksums")],
        config={"name": args.settings.name, "version": cfg["version"], "sha256": mf.file_entry(args.settings)["sha256"],
                "parameters": {"target": bi.target.key, "stage": args.stage, "setting": setting.setting_id, "setting_params": setting.params(),
                               "iterate": icfg.params(), "groups": sorted(want), "limit": args.limit, "tamper_depth_factor": args.tamper_depth_factor,
                               "iterate_config_version": f"bls_iterate_qa_v1/{icfg.fingerprint()[:12]}",
                               "iterate_config_sha256": icfg.fingerprint(), "grid_set_id": bi.set_id,
                               "noise_seeds": bi.noise_seeds, "baselines": list(bi.baselines), "known_signals_removed": bi.known_models,
                               "preprocess_setting": bi.pre.params(), "termination_reasons": list(it.TERMINATION_REASONS), "run_dir": str(run_dir),
                               "baseline_days": float(bi.strict.time.max() - bi.strict.time.min())}},
        outputs=[mf.file_entry(run_dir / n, kind=n.split(".")[0], rows=len(r)) for n, r in (("steps.csv", step_rows), ("iterations.csv", iter_rows), ("matches.csv", match_rows)) if r],
        notes=f"total {time.time() - started:.1f}s", packages=("numpy", "scipy", "astropy"),
    )
    mpath = mf.write_manifest(manifest, args.results / "manifests" / f"iterate-{bi.target.key}-{run_id[:8]}.json")
    print(f"\nsteps: {run_dir / 'steps.csv'}\niterations: {run_dir / 'iterations.csv'}\nmanifest: {mpath}\n총 소요 {time.time() - started:.1f}s")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tess_bench", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("bls", help="BLS 탐색 격자·목적함수 비교 (S15P21C206-110)")
    p.add_argument("--target", required=True, help="fixture target key (예 toi270)")
    p.add_argument("--stage", choices=["tuning", "evaluation"], default="tuning", help="주입 부분집합·별 목록 (설정 파일 stages)")
    p.add_argument("--settings", type=Path, default=DEFAULT_BLS_SETTINGS)
    p.add_argument("--preprocess-settings", type=Path, default=DEFAULT_SETTINGS)
    p.add_argument("--only", nargs="*", help="실행할 setting_id 만 고르기")
    p.add_argument("--grid", type=Path, default=DEFAULT_GRID)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--noise-seeds", type=int, nargs="*", default=[20260910], help="합성 잡음 바탕곡선 seed 목록 (여러 개면 가짜 후보 통계가 늘어남)")
    p.add_argument("--no-noise", action="store_true", help="잡음 바탕곡선 생략")
    p.add_argument("--include-raw-real", action="store_true", help="알려진 행성을 제거하지 않은 원본 real 바탕곡선도 추가 실행")
    p.add_argument("--limit", type=int, default=0, help="바탕곡선당 처음 N group 만 (빠른 확인용)")
    p.set_defaults(func=cmd_bls)

    p = sub.add_parser("bls-gates", help="저장된 bls 실행에 품질 게이트 조합을 적용 (재실행 없음)")
    p.add_argument("--run-dir", type=Path, required=True)
    p.add_argument("--settings", type=Path, default=DEFAULT_BLS_SETTINGS)
    p.add_argument("--include-noise-signals", action="store_true", help="잡음 바탕곡선의 주입 신호도 회수율에 포함")
    p.add_argument("--baseline-days", type=float, default=None, help="in_search_range 열이 없는 옛 run 에 관측 기간을 주어 범위 안 신호를 고른다")
    p.set_defaults(func=cmd_bls_gates)

    p = sub.add_parser("bls-snr-dy", help="저장된 bls run 의 상위 피크 SNR 을 점 오차 방식 3개(global·flux_err·local)로 재계산해 게이트를 비교 (재탐색 없음)")
    p.add_argument("--run-dir", type=Path, required=True)
    p.add_argument("--settings", type=Path, default=DEFAULT_BLS_SETTINGS)
    p.add_argument("--preprocess-settings", type=Path, default=DEFAULT_SETTINGS)
    p.add_argument("--grid", type=Path, default=DEFAULT_GRID)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--only", nargs="*", help="setting_id 만 고르기 (조정 run 의 9설정 중 일부)")
    p.add_argument("--window-days", type=float, default=1.0, help="local 방식 구간 폭(일)")
    p.add_argument("--min-points", type=int, default=20, help="local 구간 최소 점 수(미달이면 전역값)")
    p.add_argument("--snr-min", type=float, default=7.0)
    p.add_argument("--sde-min", type=float, default=6.0)
    p.add_argument("--baseline-days", type=float, default=None, help="in_search_range 열이 없는 옛 run 의 관측 기간")
    p.set_defaults(func=cmd_bls_snr_dy)

    p = sub.add_parser("iterate", help="반복 BLS·고정 모델 제거 루프 벤치마크: 종료 사유·제거 QA·복구 (S15P21C206-111)")
    p.add_argument("--target", required=True)
    p.add_argument("--stage", choices=["tuning", "evaluation"], default="evaluation")
    p.add_argument("--setting", default="poc_linear20k", help="BLS setting_id (110 수정 제안 기본값)")
    p.add_argument("--settings", type=Path, default=DEFAULT_BLS_SETTINGS)
    p.add_argument("--preprocess-settings", type=Path, default=DEFAULT_SETTINGS)
    p.add_argument("--grid", type=Path, default=DEFAULT_GRID)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--groups", nargs="+", default=["pairs", "singles", "none"], choices=["pairs", "singles", "none", "all"], help="돌릴 곡선 종류")
    p.add_argument("--limit", type=int, default=0, help="쌍은 전부, 단일·none 은 처음 N개만 (빠른 확인)")
    p.add_argument("--noise-seeds", type=int, nargs="*", default=[20260910])
    p.add_argument("--no-noise", action="store_true")
    p.add_argument("--include-raw-real", action="store_true", help="알려진 행성을 제거하지 않은 real 곡선 추가 (실제 행성 회수·잔여 고조파 시험)")
    p.add_argument("--snr-min", type=float, default=7.0)
    p.add_argument("--sde-min", type=float, default=6.0)
    p.add_argument("--min-transits", type=int, default=2)
    p.add_argument("--max-candidates", type=int, default=5)
    p.add_argument("--tamper-depth-factor", type=float, default=None, help="실패 사례: 1단계 제거 모델 깊이에 이 배수를 곱해 QA 실패·복구를 시험")
    p.add_argument("--window-offset-rel-depth", type=float, default=0.0, help="창 안 편향 QA 에 깊이 상대 허용(예 0.1). 0 은 z 만 (5절 실행값)")
    p.add_argument("--window-offset-reference", choices=["unity", "oot"], default="unity",
                   help="창 안 편향 기준: unity=기존 1, oot=바깥 평균·두 평균의 표본 오차 (실험 옵션)")
    p.add_argument("--refine-duration-max-hours", type=float, default=0.0, help="재적합 지속시간 상한(예 12). 주면 배수 범위도 0.5–2.0 으로 넓힌다. 0 은 5절 실행값")
    p.add_argument("--continue-after-qa-fail", action="store_true", help="QA 실패 피크를 제거 불가로 기록·제외하고 계속 탐색 (설계 변경 제안 시험)")
    p.set_defaults(func=cmd_iterate)

    p = sub.add_parser("bls-report", help="저장된 bls run 들의 matches.csv 로 문서 5.1절 회수율 표를 생성 (재실행 없음)")
    p.add_argument("--run-dir", nargs="+", required=True, help="run 디렉터리(여러 별)")
    p.add_argument("--baseline-days", nargs="*", type=float, default=None, help="옛 run 의 관측 기간(run-dir 순서대로). 새 run 은 생략")
    p.add_argument("--settings", type=Path, default=DEFAULT_BLS_SETTINGS)
    p.add_argument("--baseline", default="realclean", help="바탕곡선 종류 접미 (realclean|real|noise<seed>)")
    p.add_argument("--compare", nargs="+", default=["poc_linear20k", "linear50k"], help="구간표에 넣을 설정")
    p.add_argument("--out", default=None, help="Markdown 저장 경로 (없으면 표준 출력)")
    p.set_defaults(func=cmd_bls_report)

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

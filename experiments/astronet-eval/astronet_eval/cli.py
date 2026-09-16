# -*- coding: utf-8 -*-
"""명령행.

    python -m astronet_eval build-set  [--target toi270 ...] [--config configs/eval_set_v1.json] [--results results]
    python -m astronet_eval convert    --labels <run>/labels.csv [--results results]

build-set 은 fixture FITS 를 읽어 PC/EB/junk 후보 목록(labels.csv)을 만들고, convert 는 그 목록으로 후보별
201/61 view NPZ 와 conversions.csv 를 만든다. 둘 다 `<results>/manifests/` 에 실행 manifest(tess_fixture 스키마)를 남긴다.
TFRecord 변환은 TensorFlow 1 환경(WSL)에서 `scripts/write_tfrecords.py` 로 따로 한다.
"""

from __future__ import annotations

import argparse
import csv
import json
import shlex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from tess_fixture import download as dl
from tess_fixture import manifest as mf
from tess_fixture.targets import TARGETS, TARGETS_BY_KEY, iter_products, select_targets
from tess_bench.preprocess import load_settings

from . import convert as cv
from . import labels as lb
from .views import ViewSpec

PKG_DIR = Path(__file__).resolve().parent.parent          # experiments/astronet-eval
REPO_DIR = PKG_DIR.parent.parent
FIXTURE_DIR = PKG_DIR.parent / "tess-fixture"
DEFAULT_RAW = FIXTURE_DIR / "sample_raw"
FIXTURE_CHECKSUMS = FIXTURE_DIR / "checksums.json"
REFERENCES = FIXTURE_DIR / "references.csv"
TARGETS_PY = FIXTURE_DIR / "tess_fixture" / "targets.py"
DEFAULT_CONFIG = PKG_DIR / "configs" / "eval_set_v1.json"
DEFAULT_RESULTS = PKG_DIR / "results"
TASK = "S15P21C206-43"


def _command_line() -> str:
    return "python -m astronet_eval " + " ".join(shlex.quote(a) for a in sys.argv[1:])


def _load_config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _setting(cfg: dict):
    settings_path = (PKG_DIR / cfg["preprocess"]["settings_file"]).resolve()      # 설정 파일 경로는 패키지 루트 기준
    _, settings = load_settings(settings_path, [cfg["preprocess"]["setting_id"]])
    return settings[0], settings_path


def _fixture_inputs(targets, raw: Path) -> list[dict]:
    expected = dl.load_expected_checksums(FIXTURE_CHECKSUMS)
    inputs = []
    for target in targets:
        for _, sector, filename, url in iter_products((target,)):
            path = raw / target.key / filename
            if not path.is_file():
                sys.exit(f"missing {path}; run `python -m tess_fixture download --target {target.key}` in tess-fixture first")
            digest = dl.sha256_of(path)
            if expected.get(filename) and expected[filename] != digest:
                sys.exit(f"checksum mismatch for {filename}")
            inputs.append({"path": str(path), "sha256": digest, "size_bytes": path.stat().st_size, "source_uri": url,
                           "tic_id": target.tic_id, "sector": sector, "role": "raw_product"})
    return inputs


def _run_dir(results: Path, cfg: dict, name: str, run_id: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    d = results / "eval" / f"{cfg['set_id']}-{cfg['version']}" / f"{name}-{stamp}-{run_id[:8]}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _print_label_table(cands: list[lb.Candidate]) -> None:
    print(f"\n{'candidate_id':<34}{'label':<17}{'split':<13}{'period_d':>10}{'epoch':>12}{'dur_h':>7}{'depth_ppm':>10}  source")
    for c in cands:
        ep = "" if c.epoch_btjd is None else f"{c.epoch_btjd:12.4f}"
        du = "" if c.duration_hours is None else f"{c.duration_hours:7.2f}"
        de = "" if c.depth_ppm is None else f"{c.depth_ppm:10.0f}"
        print(f"{c.candidate_id:<34}{c.label:<17}{c.split:<13}{c.period_days:10.5f}{ep:>12}{du:>7}{de:>10}  {c.geometry_source}")


def cmd_build_set(args: argparse.Namespace) -> int:
    started = time.time()
    cfg = _load_config(args.config)
    setting, settings_path = _setting(cfg)
    targets = select_targets(args.target)
    seeds = cfg["labels"]["junk"]["noise_seeds"]
    overlap = cfg["split"]["training_overlap_default"]
    spec_junk = cfg["junk_bls"]
    inputs = _fixture_inputs(targets, args.raw)
    targets_sha = mf.file_entry(TARGETS_PY)["sha256"]

    # 1. Archive 행 → PC 후보, EB 자리표시
    with REFERENCES.open(encoding="utf-8", newline="") as fh:
        ref_rows = [r for r in csv.DictReader(fh) if r.get("target_key") in {t.key for t in targets}]
    pcs, skipped = lb.candidates_from_references(ref_rows, TARGETS_BY_KEY, training_overlap=overlap)
    ebs = lb.eb_placeholders(list(targets), snapshot=f"targets.py sha256 {targets_sha[:12]}", training_overlap=overlap)
    print(f"targets={len(targets)} archive_rows={len(ref_rows)} → PC={len(pcs)} EB={len(ebs)} skipped={len(skipped)}"
          f"  (preprocess={setting.setting_id})")
    for s in skipped:
        print(f"  skip {s.get('target_key'):<9} {s.get('pl_name') or '-':<14} {s['skip_reason']}")

    # 2. 곡선 준비 → EB 기하 보완, junk 후보
    all_cands: list[lb.Candidate] = list(pcs)
    curve_stats = []
    for i, target in enumerate(targets, 1):
        t0 = time.time()
        curves = cv.prepare_target(target, args.raw, setting, seeds)
        real = curves[f"{target.key}-real"]
        curve_stats.append({"baseline_id": real.baseline_id, "n_baseline": real.n_baseline_points, "n_kept": real.n_kept,
                            "status": real.preprocess_status, "n_failures": len(real.preprocess_failures)})
        known = [c for c in pcs if c.target_key == target.key]
        for eb in [c for c in ebs if c.target_key == target.key]:
            all_cands.append(cv.complete_geometry(eb, real))
            known.append(eb)
        for seed in seeds:
            all_cands.append(cv.junk_from_noise(target, curves[f"{target.key}-noise{seed}"], seed, spec_junk, training_overlap=overlap))
        unv, note = cv.junk_from_residual(target, real, known, spec_junk, training_overlap=overlap)
        if unv is not None:
            all_cands.append(unv)
        print(f"[{i}/{len(targets)}] {target.key:<9} kept={real.n_kept:>6}/{real.n_baseline_points:<6} PC={len([c for c in known if c.label=='PC'])} "
              f"EB={len([c for c in known if c.label=='EB'])} junk={len(seeds)} unverified={'1' if unv else '0 ('+note+')'}  {time.time()-t0:5.1f}s")

    lb.check_split_integrity(all_cands)
    run_id = mf.new_run_id()
    run_dir = _run_dir(args.results, cfg, "set", run_id)
    labels_path = lb.write_labels(all_cands, run_dir / "labels.csv")
    with (run_dir / "skipped_references.csv").open("w", newline="", encoding="utf-8") as fh:
        if skipped:
            w = csv.DictWriter(fh, fieldnames=list(skipped[0].keys()))
            w.writeheader(); w.writerows(skipped)
    summary = lb.summarize(all_cands)
    (run_dir / "summary.json").write_text(json.dumps({**summary, "curves": curve_stats}, ensure_ascii=False, indent=2), encoding="utf-8")
    _print_label_table(all_cands)
    print(f"\nsummary: {json.dumps(summary['by_label_split'], ensure_ascii=False)}  in_truth={summary['in_truth']} tics={summary['n_tics']}")

    manifest = mf.build_manifest(
        task=f"{TASK} build-set", command=_command_line(), repo_dir=REPO_DIR, run_id=run_id,
        inputs=inputs + [mf.file_entry(REFERENCES, role="references"), mf.file_entry(TARGETS_PY, role="targets"),
                         mf.file_entry(settings_path, role="preprocess_settings")],
        config={"name": args.config.name, "version": cfg["version"], "sha256": mf.file_entry(args.config)["sha256"],
                "parameters": {"targets": [t.key for t in targets], "noise_seeds": seeds, "preprocess_setting": setting.params(),
                               "junk_bls": spec_junk, "split": cfg["split"], "run_dir": str(run_dir)}},
        outputs=[mf.file_entry(labels_path, kind="labels", rows=len(all_cands)), mf.file_entry(run_dir / "summary.json", kind="summary")],
        notes=f"PC={len(pcs)} EB={len(ebs)} junk={len(targets)*len(seeds)} unverified={sum(c.label=='junk_unverified' for c in all_cands)}; {time.time()-started:.0f}s",
        packages=("numpy", "astropy", "scipy"),
    )
    path = mf.write_manifest(manifest, args.results / "manifests" / f"build-set-{run_id[:8]}.json")
    print(f"labels:   {labels_path}\nmanifest: {path}")
    return 0


def cmd_convert(args: argparse.Namespace) -> int:
    started = time.time()
    cfg = _load_config(args.config)
    setting, settings_path = _setting(cfg)
    v = cfg["views"]
    spec = ViewSpec(global_bins=v["global_bins"], global_bin_width_factor=v["global_bin_width_factor"], local_bins=v["local_bins"],
                    local_bin_width_factor=v["local_bin_width_factor"], local_half_range_durations=v["local_half_range_durations"],
                    min_in_transit_points=v["min_in_transit_points"])
    cands = lb.read_labels(args.labels)
    target_keys = list(dict.fromkeys(c.target_key for c in cands))
    targets = [TARGETS_BY_KEY[k] for k in target_keys]
    seeds = sorted({int(c.baseline_id.rsplit("noise", 1)[1]) for c in cands if "-noise" in c.baseline_id})
    inputs = _fixture_inputs(targets, args.raw)

    run_id = mf.new_run_id()
    run_dir = _run_dir(args.results, cfg, "convert", run_id)
    npz_dir = run_dir / "npz"
    rows = []
    print(f"candidates={len(cands)} targets={len(targets)} views={spec.global_bins}/{spec.local_bins} preprocess={setting.setting_id}")
    for i, target in enumerate(targets, 1):
        t0 = time.time()
        curves = cv.prepare_target(target, args.raw, setting, seeds)
        mine = [c for c in cands if c.target_key == target.key]
        ok = 0
        for c in mine:
            row = cv.convert_candidate(c, curves[c.baseline_id], spec, npz_dir)
            rows.append(row)
            ok += row["status"] == "ok"
            flag = "ok " if row["status"] == "ok" else "FAIL"
            print(f"    {flag} {c.candidate_id:<34}{c.label:<17}" + (f"pts={row['n_points']:>6} in_transit={row['n_in_transit']:>4} empty_g/l={row['n_empty_global_bins']}/{row['n_empty_local_bins']} "
                                                                f"argmin_g/l={row['global_argmin_bin']}/{row['local_argmin_bin']}"
                                                                if row["status"] == "ok" else f"reason={row['reason']}"))
        print(f"[{i}/{len(targets)}] {target.key:<9} {ok}/{len(mine)} ok  {time.time()-t0:5.1f}s")

    conv_path = run_dir / "conversions.csv"
    with conv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cv.CONVERSION_COLUMNS)
        w.writeheader(); w.writerows(rows)
    n_ok = sum(r["status"] == "ok" for r in rows)
    reasons: dict[str, int] = {}
    for r in rows:
        if r["status"] != "ok":
            reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
    print(f"\nconverted {n_ok}/{len(rows)}  failures={reasons}")
    print("읽는 법: in_transit 는 접은 뒤 |위상 거리| < duration/2 인 점 수. empty_g/l 은 보간 전 빈 bin 수로, 클수록 관측 공백이"
          " view 에 영향을 준 것. argmin_g/l 은 최솟값 bin 위치로 PC/EB 라면 100/30 근처가 정상이고, 멀면 epoch 외삽 오차나"
          " 신호가 잡음보다 약한 경우(junk 는 무작위). FAIL 은 점수 0 이 아니라 input_incomplete 로 118 에 전달된다.")

    manifest = mf.build_manifest(
        task=f"{TASK} convert", command=_command_line(), repo_dir=REPO_DIR, run_id=run_id,
        inputs=inputs + [mf.file_entry(args.labels, role="labels"), mf.file_entry(settings_path, role="preprocess_settings")],
        config={"name": args.config.name, "version": cfg["version"], "sha256": mf.file_entry(args.config)["sha256"],
                "parameters": {"views": v, "preprocess_setting": setting.params(), "noise_seeds": seeds, "run_dir": str(run_dir),
                               "model": cfg["model"]}},
        outputs=[mf.file_entry(conv_path, kind="conversions", rows=len(rows))]
                + [{"path": r["npz_path"], "sha256": r["global_sha256"], "kind": "npz", "candidate_id": r["candidate_id"]} for r in rows if r["status"] == "ok"],
        notes=f"ok={n_ok} failed={len(rows)-n_ok} reasons={reasons}; {time.time()-started:.0f}s",
        packages=("numpy", "astropy", "scipy"),
    )
    path = mf.write_manifest(manifest, args.results / "manifests" / f"convert-{run_id[:8]}.json")
    print(f"conversions: {conv_path}\nnpz:         {npz_dir}\nmanifest:    {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m astronet_eval", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("build-set", help="PC/EB/junk 라벨 목록 생성 (fixture FITS 필요)")
    p.add_argument("--target", nargs="*", help="target key (기본: 전체 9별)")
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.set_defaults(func=cmd_build_set)
    p = sub.add_parser("convert", help="labels.csv → 후보별 201/61 NPZ")
    p.add_argument("--labels", type=Path, required=True)
    p.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.set_defaults(func=cmd_convert)
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    return args.func(args)

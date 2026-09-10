# -*- coding: utf-8 -*-
"""명령행 진입점.

    python -m tess_fixture targets
    python -m tess_fixture download [--target toi270 ...] [--output sample_raw]
    python -m tess_fixture references [--output references.csv]
    python -m tess_fixture inject --target toi270 [--grid configs/injection_grid_v1.json] [--noise-seed 20260910]

모든 쓰기 명령은 results/manifests/ 에 실행 manifest 를 남긴다.
"""

from __future__ import annotations

import argparse
import shlex
import sys
from pathlib import Path

from . import download as dl
from . import inject as inj
from . import manifest as mf
from . import references as refs
from .lightcurve import build_baseline, load_sector, synthetic_noise_baseline
from .targets import TARGETS, iter_products, select_targets

PKG_DIR = Path(__file__).resolve().parent.parent          # experiments/tess-fixture
REPO_DIR = PKG_DIR.parent.parent                          # 저장소 최상위
DEFAULT_RAW = PKG_DIR / "sample_raw"
DEFAULT_RESULTS = PKG_DIR / "results"
CHECKSUMS = PKG_DIR / "checksums.json"
REFERENCES = PKG_DIR / "references.csv"
DEFAULT_GRID = PKG_DIR / "configs" / "injection_grid_v1.json"
TASK = "S15P21C206-41"


def _command_line() -> str:
    return "python -m tess_fixture " + " ".join(shlex.quote(a) for a in sys.argv[1:])


def cmd_targets(_: argparse.Namespace) -> int:
    print(f"{'key':<10}{'TIC':>11}  {'sectors':<14}{'role':<34}name")
    for t in TARGETS:
        print(f"{t.key:<10}{t.tic_id:>11}  {','.join(map(str, t.sectors)):<14}{t.role:<34}{t.name}")
    print(f"\n{sum(len(t.sectors) for t in TARGETS)} products, {len(TARGETS)} targets")
    return 0


def cmd_download(args: argparse.Namespace) -> int:
    targets = select_targets(args.target)
    expected = dl.load_expected_checksums(CHECKSUMS) if not args.ignore_checksums else {}
    records = dl.download_targets(targets, args.output, expected=expected)
    dl.write_checksums(records, CHECKSUMS)
    manifest = mf.build_manifest(
        task=f"{TASK} download", command=_command_line(), repo_dir=REPO_DIR,
        inputs=[{"path": r["source_uri"], "sha256": r["sha256"], "size_bytes": r["size_bytes"], "source_uri": r["source_uri"],
                 "tic_id": r["tic_id"], "sector": r["sector"], "procver": r["procver"], "role": "raw_product"} for r in records],
        config={"name": "targets.py", "version": "1", "sha256": mf.file_entry(PKG_DIR / "tess_fixture" / "targets.py")["sha256"],
                "parameters": {"target": args.target or "all", "output": str(args.output)}},
        outputs=[mf.file_entry(CHECKSUMS, kind="checksums", rows=len(records))]
                + [{"path": r["path"], "sha256": r["sha256"], "size_bytes": r["size_bytes"], "kind": "raw_product"} for r in records],
        notes=f"{len(records)} files, {sum(r['cached'] for r in records)} cache hits",
    )
    path = mf.write_manifest(manifest, DEFAULT_RESULTS / "manifests" / f"download-{manifest['run_id'][:8]}.json")
    print(f"checksums: {CHECKSUMS}\nmanifest:  {path}")
    return 0


def cmd_references(args: argparse.Namespace) -> int:
    rows = refs.fetch_references(select_targets(args.target))
    refs.write_references(rows, args.output)
    manifest = mf.build_manifest(
        task=f"{TASK} references", command=_command_line(), repo_dir=REPO_DIR,
        inputs=[{"path": refs.TAP_SYNC, "sha256": "0" * 64, "role": "remote_service",
                 "source_uri": refs.TAP_SYNC}],
        config={"name": "pscomppars query", "version": "1", "sha256": "0" * 64,
                "parameters": {"columns": list(refs.COLUMNS)}},
        outputs=[mf.file_entry(args.output, kind="references", rows=len(rows))],
        notes="NASA Exoplanet Archive TAP 결과. 원격 서비스라 입력 checksum 은 0 으로 채움",
    )
    path = mf.write_manifest(manifest, DEFAULT_RESULTS / "manifests" / f"references-{manifest['run_id'][:8]}.json")
    print(f"references: {args.output} ({len(rows)} rows)\nmanifest:   {path}")
    return 0


def cmd_inject(args: argparse.Namespace) -> int:
    target = select_targets([args.target])[0]
    grid = inj.load_grid(args.grid)
    expected = dl.load_expected_checksums(CHECKSUMS)
    curves, inputs = [], []
    for _, sector, filename, url in iter_products((target,)):
        path = args.raw / target.key / filename
        if not path.is_file():
            sys.exit(f"missing {path}; run `python -m tess_fixture download --target {target.key}` first")
        digest = dl.sha256_of(path)
        if expected.get(filename) and expected[filename] != digest:
            sys.exit(f"checksum mismatch for {filename}: {digest} != {expected[filename]}")
        curves.append(load_sector(path))
        inputs.append({"path": str(path), "sha256": digest, "size_bytes": path.stat().st_size, "source_uri": url,
                       "tic_id": target.tic_id, "sector": sector, "role": "raw_product"})
    real = build_baseline(curves)
    set_id = f"{grid['grid_id']}"
    out_root = args.results / "injections" / set_id / target.key
    outputs, all_rows = [], []

    baselines = [("real", real)]
    if not args.no_noise:
        baselines.append((f"noise{args.noise_seed}", synthetic_noise_baseline(real, seed=args.noise_seed)))
    for baseline_id, baseline in baselines:
        rows = inj.build_catalog(grid, baseline, baseline_id=f"{target.key}-{baseline_id}", set_id=set_id,
                                 include_multi=not args.single_only)
        all_rows.extend(rows)
        if args.write_curves:
            for p in inj.write_injected_curves(baseline, rows, out_root / baseline_id):
                outputs.append({"path": str(p), "size_bytes": p.stat().st_size, "kind": "curves"})
        print(f"[{baseline_id}] points={baseline.n_valid:,} scatter={baseline.robust_scatter*1e6:.0f}ppm "
              f"rows={len(rows)} groups={len({r.group_id for r in rows})}")
    catalog_path = out_root / "catalog.csv"
    inj.write_catalog(all_rows, catalog_path)
    outputs.insert(0, mf.file_entry(catalog_path, kind="catalog", rows=len(all_rows)))

    manifest = mf.build_manifest(
        task=f"{TASK} inject", command=_command_line(), repo_dir=REPO_DIR,
        inputs=inputs + [mf.file_entry(args.grid, role="grid")],
        config={"name": args.grid.name, "version": grid["version"], "sha256": inj.grid_sha256(args.grid),
                "parameters": {"target": target.key, "noise_seed": None if args.no_noise else args.noise_seed,
                               "single_only": args.single_only, "write_curves": args.write_curves,
                               "baseline_rule": "QUALITY==0 & finite(TIME,PDCSAP_FLUX), per-sector median normalization, no detrending",
                               "sectors": list(real.sectors), "normalization_median": real.normalization_median,
                               "n_raw": real.n_raw, "n_valid": real.n_valid}},
        outputs=outputs,
    )
    path = mf.write_manifest(manifest, DEFAULT_RESULTS / "manifests" / f"inject-{target.key}-{manifest['run_id'][:8]}.json")
    print(f"catalog:  {catalog_path} ({len(all_rows)} rows)\nmanifest: {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tess_fixture", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("targets", help="표본 목록 출력").set_defaults(func=cmd_targets)

    p = sub.add_parser("download", help="공식 MAST SPOC LC 다운로드·검증")
    p.add_argument("--target", nargs="*", help="target key (기본: 전체)")
    p.add_argument("--output", type=Path, default=DEFAULT_RAW)
    p.add_argument("--ignore-checksums", action="store_true", help="checksums.json 과 비교하지 않음")
    p.set_defaults(func=cmd_download)

    p = sub.add_parser("references", help="NASA Exoplanet Archive 참고값 갱신")
    p.add_argument("--target", nargs="*")
    p.add_argument("--output", type=Path, default=REFERENCES)
    p.set_defaults(func=cmd_references)

    p = sub.add_parser("inject", help="합성 감광 주입 목록·곡선 생성")
    p.add_argument("--target", required=True, help="바탕곡선으로 쓸 target key")
    p.add_argument("--grid", type=Path, default=DEFAULT_GRID)
    p.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument("--noise-seed", type=int, default=20260910)
    p.add_argument("--no-noise", action="store_true", help="합성 잡음 바탕곡선 생략")
    p.add_argument("--single-only", action="store_true", help="다중 신호 쌍 생략")
    p.add_argument("--write-curves", action="store_true", help="주입 곡선 NPZ 저장 (기본은 catalog 만)")
    p.set_defaults(func=cmd_inject)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)

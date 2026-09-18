"""`python -m ingestion` 명령행 진입점."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import supervisor, tess

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "service-v1.json"


def source_list(args: argparse.Namespace) -> int:
    config = tess.load_config(args.config)
    value = tess.build_source_list(config)
    tess.write_json_atomic(value, args.output)
    print(
        f"SOURCE_LIST_OK products={value['product_count']} sha256={value['source_list_sha256']} output={args.output}"
    )
    return 0


def download(args: argparse.Namespace) -> int:
    source = tess.load_source_list(args.source_list)
    config = tess.load_config(args.config)
    checksums = tess.load_checksums(args.checksums)
    summary, exit_code = tess.run_download(
        source,
        args.output,
        args.events,
        worker_slot=args.worker_slot,
        sectors=set(args.sector) if args.sector else None,
        checksums=checksums,
        checksums_only=args.checksums_only,
        limit=args.limit,
        retries=int(config["max_retries"]),
        max_part_bytes=int(config["max_part_bytes"]),
        disk_stop_fraction=float(config["disk_stop_fraction"]),
        max_consecutive_failures=int(config["max_consecutive_failures"]),
        concurrency=int(config.get("download_concurrency", 1)),
    )
    tess.write_json_atomic(summary, args.run_manifest)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return exit_code


def audit(args: argparse.Namespace) -> int:
    source = tess.load_source_list(args.source_list)
    checksums = tess.load_checksums(args.checksums)
    summary, exit_code = tess.audit_download(
        source,
        args.output,
        args.events,
        worker_slot=args.worker_slot,
        sectors=set(args.sector) if args.sector else None,
        checksums=checksums,
        checksums_only=args.checksums_only,
        limit=args.limit,
    )
    tess.write_json_atomic(summary, args.audit_manifest)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return exit_code


def supervise(args: argparse.Namespace) -> int:
    config = tess.load_config(args.config)
    source = tess.load_source_list(args.source_list)
    if source["source_list_sha256"] != args.expected_source_list_sha256:
        raise ValueError("source list checksum does not match --expected-source-list-sha256")
    try:
        return supervisor.run_supervisor(
            config,
            source,
            args.output,
            args.run_root,
            worker_slot=args.worker_slot,
            sectors=args.sector,
        )
    except supervisor.AlreadyRunning as error:
        print(f"SUPERVISOR_ALREADY_RUNNING {error}")
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m ingestion")
    sub = parser.add_subparsers(dest="command", required=True)

    command = sub.add_parser("source-list", help="MAST bulk script에서 고정 원천 목록 생성")
    command.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    command.add_argument("--output", type=Path, required=True)
    command.set_defaults(func=source_list)

    command = sub.add_parser("download", help="원천 목록의 SPOC LC를 재개 가능하게 다운로드·검증")
    command.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    command.add_argument("--source-list", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--events", type=Path, required=True)
    command.add_argument("--run-manifest", type=Path, required=True)
    command.add_argument("--worker-slot", type=int, help="1~5. 생략하면 모든 항목을 순차 실행")
    command.add_argument("--sector", type=int, action="append", help="대상 Sector. 여러 번 지정 가능")
    command.add_argument("--checksums", type=Path)
    command.add_argument("--checksums-only", action="store_true", help="checksum 파일에 있는 항목만 실행")
    command.add_argument("--limit", type=int, help="선택된 목록의 앞 N개만 실행")
    command.set_defaults(func=download)

    command = sub.add_parser("audit", help="완료 이벤트와 FITS·checksum·snapshot ID 전수 감사")
    command.add_argument("--source-list", type=Path, required=True)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--events", type=Path, required=True)
    command.add_argument("--audit-manifest", type=Path, required=True)
    command.add_argument("--worker-slot", type=int, help="1~5. 생략하면 모든 항목")
    command.add_argument("--sector", type=int, action="append", help="대상 Sector. 여러 번 지정 가능")
    command.add_argument("--checksums", type=Path)
    command.add_argument("--checksums-only", action="store_true")
    command.add_argument("--limit", type=int, help="선택된 목록의 앞 N개만 감사")
    command.set_defaults(func=audit)

    command = sub.add_parser("supervise", help="완료될 때까지 Sector를 재개·감사하는 systemd 감독 루프")
    command.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    command.add_argument("--source-list", type=Path, required=True)
    command.add_argument("--expected-source-list-sha256", required=True)
    command.add_argument("--output", type=Path, required=True)
    command.add_argument("--run-root", type=Path, required=True)
    command.add_argument("--worker-slot", type=int, required=True)
    command.add_argument("--sector", type=int, action="append", required=True)
    command.set_defaults(func=supervise)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

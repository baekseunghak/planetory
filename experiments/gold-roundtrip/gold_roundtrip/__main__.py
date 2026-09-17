"""python -m gold_roundtrip build|vectors|roundtrip"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parents[1]
REPO = PKG_DIR.parents[1]
DEFAULT_PAYLOAD = PKG_DIR / "fixtures" / "gold-toi270-s3.json"
DEFAULT_VECTORS = REPO / "contracts" / "gold" / "examples" / "array-checksum-vectors.v0.json"
DEFAULT_RECORD_VECTORS = REPO / "contracts" / "gold" / "examples" / "record-checksum-vectors.v0.json"


def cmd_build(args):
    from . import build_payload as bp
    payload = bp.build(args.target, args.sector)
    bp.write(payload, args.out)
    seg = payload["segments"][0]
    print(f"payload: {args.out} ({args.out.stat().st_size/1024:.0f} KB) sector={seg['sector']} n_points={seg['n_points']} nulls={sum(v is None for v in seg['flux'])} "
          f"gaps={len(seg['gaps'])} candidates={len(payload['candidates'])} fold_ref={payload['bundle']['fold_reference_time_btjd']:.6f} bundle_version={payload['bundle']['bundle_version'][:16]}...")
    return 0


def cmd_vectors(args):
    from . import vectors
    vectors.write(args.out)
    vectors.write_records(args.records_out)
    print(f"vectors: {args.out}\nrecord vectors: {args.records_out}")
    return 0


def cmd_roundtrip(args):
    from . import roundtrip
    payload = json.loads(args.payload.read_text(encoding="utf-8"))
    from urllib.parse import urlparse
    target = urlparse(args.url or os.environ.get("DATABASE_URL", roundtrip.DEFAULT_URL))
    print(f"roundtrip: {args.payload.name} -> {target.hostname}:{target.port}{target.path}")
    result = roundtrip.run(payload, url=args.url, keep_schema=args.keep_schema)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"report: {args.report}")
    print(f"{len(result['checks'])} checks, {result['n_failed']} failed, decision={result.get('decision')}, PostgreSQL: {(result['postgresql'] or '-')[:22]}")
    return 1 if result["n_failed"] else 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="gold_roundtrip")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="fixture FITS → Gold payload 예제 JSON")
    b.add_argument("--target", default="toi270"); b.add_argument("--sector", type=int, default=3)
    b.add_argument("--out", type=Path, default=DEFAULT_PAYLOAD); b.set_defaults(func=cmd_build)
    v = sub.add_parser("vectors", help="언어 간 checksum 대조 벡터 파일 생성")
    v.add_argument("--out", type=Path, default=DEFAULT_VECTORS); v.add_argument("--records-out", type=Path, default=DEFAULT_RECORD_VECTORS); v.set_defaults(func=cmd_vectors)
    r = sub.add_parser("roundtrip", help="격리 스키마에 V1~V8 적용 → 적재 → 조회 비교")
    r.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD); r.add_argument("--url", default=None)
    r.add_argument("--keep-schema", action="store_true"); r.add_argument("--report", type=Path, default=PKG_DIR / "results" / "roundtrip-report.json")
    r.set_defaults(func=cmd_roundtrip)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

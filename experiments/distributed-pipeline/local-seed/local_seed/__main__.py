"""로컬 시드 명령.

    uv run python -m local_seed plan      # 정답표만 출력한다(DB 불필요)
    uv run python -m local_seed seed      # 로컬 DB 에 적재한다

접속은 SEED_DATABASE_URL, 없으면 루트 Compose service-db 로컬 기본값을 쓴다. 백엔드의 DATABASE_URL 은
JDBC 형식이라 섞지 않는다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time

import psycopg

from .catalog import CATALOG
from .load import SeedError, apply_settings, connect, notify_backend, notify_targets, preflight, publish_star
from .payload import GenerationError, build_all

INTENT_KO = {"deep_confirmed": "깊은 확정", "shallow_confirmed": "얕은 확정", "fp": "오검출", "deep_fp": "깊은 오검출",
             "multi_fp": "복수 오검출"}
ROLE_KO = {"tutorial": "튜토리얼", "challenge": "챌린지", "pool": "일반"}
SHAPE_KO = {"box": "", "u": " · U자", "v": " · V자", "real": " · 실제 곡선"}


def default_url() -> str:
    password = os.environ.get("POSTGRES_PASSWORD", "ssafy")          # 루트 Compose 와 같은 로컬 기본값
    port = os.environ.get("POSTGRES_PORT", "15432")
    return f"postgresql://planetory:{password}@127.0.0.1:{port}/planetory_poc"


def role_text(p: dict) -> str:
    if p["role"] == "tutorial":
        return f"튜토리얼 {p['tutorial_seq']} ({INTENT_KO[p['tutorial_intent']]})"
    return ROLE_KO[p["role"]]


def print_plan(payloads: list[dict]) -> None:
    print("별 | TIC | 역할 | 섹터 | 신호(제거 순서) 주기 d · 첫 통과 BTJD · 지속 h · 깊이 ppm · 판정 · 발견 가능")
    for p in payloads:
        sectors = ",".join(str(s["sector"]) for s in p["segments"])
        print(f"{p['label']} | {p['tic_id']} | {role_text(p)} | {sectors} | {p['description']}")
        for c in p["candidates"]:
            r = c["record"]
            ai = f" · AI {c['ai']['verdict']} {c['ai']['score']}" if c["ai"] else ""
            note = f" · {c['note']}" if c["note"] else ""
            print(f"    {c['key']} (step {r['removal_step']}) {r['period_days']} · {r['epoch_btjd']} · "
                  f"{r['duration_hours']} · {r['depth_ppm']:.0f} · {c['disposition']['disposition']} · "
                  f"{'예' if r['discoverable'] else '아니오'}{SHAPE_KO[c['shape']]}{ai}{note}")
        if p["residual_peaks"]:
            print("    box 모델로 빼도 남는 봉우리: " + ", ".join(
                f"{r['period_days']} d({r['from']}, SNR {r['snr']})" for r in p["residual_peaks"]))


def build() -> list[dict]:
    started = time.monotonic()
    print(f"Gold 생성 중… (합성 {len(CATALOG)}개 + 실제 곡선 1개, BLS·discoverable 계산)", flush=True)
    payloads = build_all()
    print(f"생성 완료 {time.monotonic() - started:.1f}s", flush=True)
    return payloads


def cmd_plan(_args) -> int:
    print_plan(build())
    return 0


def cmd_seed(args) -> int:
    url = args.database_url or os.environ.get("SEED_DATABASE_URL") or default_url()
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if args.notify_backend and not token:
        print("--notify-backend 에는 INTERNAL_SERVICE_TOKEN 이 필요하다. 적재하지 않았다.", file=sys.stderr)
        return 2
    # 실제 접속 주소를 먼저 확인하고(connect), 마이그레이션 상태를 본 뒤에 생성한다. 막힐 일을 생성 전에 알린다.
    with connect(url, args.schema, allow_non_local=args.allow_non_local) as conn:
        target = preflight(conn, args.schema, require_flyway=not args.skip_migration_check)
        version = f"V{target.flyway_version}" if target.flyway_version is not None else "기록 없음"
        print(f"대상: {conn.info.hostaddr or conn.info.host}:{conn.info.port}/{conn.info.dbname} 스키마 {target.schema}, "
              f"마이그레이션 {version}, "
              f"Gold 역할 {'planetory_gold_writer' if target.use_writer_role else '연결 계정(역할 전환 불가)'}")
        for warning in target.warnings:
            print(f"주의: {warning}")
        payloads = build()
        results = []
        for p in payloads:
            result = publish_star(conn, p, target)
            results.append(result)
            extra = f", 이전 판 {result.archived_bundle_ids} archived" if result.archived_bundle_ids else ""
            print(f"  {p['label']} TIC {p['tic_id']} {role_text(p)}: {result.code} b-{result.bundle_id}{extra}")
        if not args.no_settings:
            for s in apply_settings(conn, payloads, dt.date.today()):
                print(f"  {s.name}: {s.code} {s.detail}")
    if args.notify_backend:
        failed = 0
        for bundle_id, ok, outcome in notify_backend(args.notify_backend, token, notify_targets(results)):
            print(f"  후처리 b-{bundle_id}: {outcome}")
            failed += not ok
        if failed:
            print(f"판 전환 후처리 {failed}건이 실패했다. 백엔드를 확인한 뒤 같은 명령을 다시 실행하면 current 판 전체에 "
                  "다시 알린다(후처리는 여러 번 받아도 결과가 같다).", file=sys.stderr)
            return 1
    elif any(r.code == "PUBLISHED" for r in results):
        print("새 판을 게시했다. 이미 가입한 회원이 있으면 --notify-backend 로 판 전환 후처리를 부른다.")
    print("완료. 백엔드를 띄우고 OAuth 로 가입하면 튜토리얼 1번 별이 열린다. 정답표: python -m local_seed plan")
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(prog="python -m local_seed", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="정답표 출력").set_defaults(func=cmd_plan)
    seed = sub.add_parser("seed", help="로컬 DB 에 적재")
    seed.add_argument("--database-url", help="postgresql://… (기본 SEED_DATABASE_URL 또는 로컬 Compose)")
    seed.add_argument("--schema", default="public", help="대상 스키마(기본 public)")
    seed.add_argument("--allow-non-local", action="store_true",
                      help="실제 접속 주소가 이 PC(루프백·Unix 소켓)가 아닌 DB 도 허용")
    seed.add_argument("--skip-migration-check", action="store_true",
                      help="flyway_schema_history 없이 마이그레이션 SQL 을 직접 적용한 검증용 스키마")
    seed.add_argument("--no-settings", action="store_true", help="튜토리얼·챌린지 설정을 넣지 않는다")
    seed.add_argument("--notify-backend", metavar="URL",
                      help="current 판마다 POST /internal/bundles/{id}/activated (토큰은 INTERNAL_SERVICE_TOKEN, "
                           "실패하면 종료 코드 1, 다시 실행하면 다시 알린다)")
    seed.set_defaults(func=cmd_seed)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (GenerationError, SeedError) as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1
    except psycopg.OperationalError as e:
        print(f"DB 에 연결하지 못했다. service-db 가 떠 있는지 확인한다: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

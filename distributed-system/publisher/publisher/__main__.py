"""Publisher 진입점 [S15P21C206-262].

  python -m publisher mock-load --tic 900000008,900000027
  python -m publisher mock-purge-sql
  python -m publisher notify --bundle b-12

접속은 libpq 환경변수(PGHOST·PGDATABASE·PGUSER·PGPASSWORD)를 따른다. 적재 계정은
planetory_gold_writer 멤버여야 한다. 소유자로 붙으면 권한 분리가 무력화된다.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .notify import TOKEN_HEADER, notify_backend  # noqa: F401  TOKEN_HEADER는 테스트가 쓴다


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="publisher")
    sub = parser.add_subparsers(dest="command", required=True)
    load = sub.add_parser("mock-load", help="목업 Gold를 운영 더미 별에 게시한다")
    load.add_argument("--tic", required=True, help="쉼표로 나눈 TIC 목록. stars에 이미 있어야 한다")
    sub.add_parser("mock-purge-sql", help="목업 삭제 SQL을 출력한다. service-db의 psql로 넘긴다")
    resend = sub.add_parser("notify", help="이미 current인 판의 전환을 Backend에 다시 알린다")
    resend.add_argument("--bundle", required=True, help="판 id. b-12 또는 12")
    args = parser.parse_args(argv)

    if args.command == "notify":
        # DB는 건드리지 않는다. 판을 다시 싣지 않고 알림만 보낸다.
        return 0 if notify([int(args.bundle.removeprefix("b-"))]) else 1

    if args.command == "mock-purge-sql":
        # 삭제는 소유자로 한다. 판 전환 때 V23 트리거가 쓴 알림 행을 gold_writer는 지울 수 없다.
        # 소유자 비밀번호를 이 컨테이너에 주지 않도록 SQL만 내보내고 service-db 안에서 실행한다.
        sys.stdout.write((Path(__file__).parent / "mock_purge.sql").read_text(encoding="utf-8"))
        return 0

    import psycopg

    from . import load as loader, mock_source

    tics = [int(t) for t in args.tic.split(",") if t.strip()]
    with psycopg.connect("", autocommit=True) as conn:
        target = loader.preflight(conn)
        print(f"대상 {conn.info.host}/{conn.info.dbname}, 마이그레이션 V{target.flyway_version}, "
              f"Gold 역할 {'planetory_gold_writer' if target.use_writer_role else '연결 계정(역할 전환 불가)'}")
        for warning in target.warnings:
            print(f"주의: {warning}")
        results = []
        for payload in mock_source.payloads(tics):
            result = loader.publish_star(conn, payload, target, retire_reason="Gold 목업 새 판 게시")
            results.append(result)
            print(f"  {result.label}: {result.code} b-{result.bundle_id}")
    # 이미 current인 판도 다시 알린다. 앞선 알림이 실패했어도 같은 명령을 다시 돌리면 복구된다.
    # 토큰이 없어 알림을 생략한 것은 실패가 아니다. 적재는 끝났고 DB의 current가 정본이다.
    sent = notify(loader.notify_targets(results))
    return 0 if sent or not os.environ.get("INTERNAL_SERVICE_TOKEN") else 1


def notify(bundle_ids: list[int]) -> bool:
    """커밋 뒤 Backend에 전환을 알린다. 실패해도 DB 전환은 되돌리지 않는다(정본). 모두 보냈으면 True.

    알림은 후처리를 빨리 시작하려는 신호일 뿐이고 정본은 DB의 current다. 토큰이 없으면 Backend가
    내부 경로 전체를 막으므로 보내지 않는다. 같은 판을 여러 번 알려도 Backend는 200이다.
    """
    if not bundle_ids:
        return True
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if not token:
        ids = ", ".join(f"b-{i}" for i in bundle_ids)
        print(f"  알림 생략: INTERNAL_SERVICE_TOKEN이 없다. {ids}는 DB에서 이미 current다."
              f" 토큰을 넣은 뒤 `python -m publisher notify --bundle b-<id>`로 보내거나 적재를 다시 돌린다.")
        return False
    ok = True
    for bundle_id, sent, outcome in notify_backend(os.environ.get("BACKEND_URL", "http://backend:8080"),
                                                   token, bundle_ids):
        print(f"  알림 b-{bundle_id}: {outcome}")
        ok &= sent
    if not ok:
        print("  알림 일부가 실패했다. DB 전환은 그대로다. Backend를 확인한 뒤 같은 명령을 다시 돌린다.")
    return ok


if __name__ == "__main__":
    raise SystemExit(main())

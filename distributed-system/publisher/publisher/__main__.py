"""Publisher 진입점 [S15P21C206-262].

  python -m publisher mock-load --tic 900000008,900000027
  python -m publisher mock-purge-sql
  python -m publisher notify --bundle b-12

접속은 libpq 환경변수(PGHOST·PGDATABASE·PGUSER·PGPASSWORD)를 따른다. 적재 계정은
planetory_gold_writer 멤버여야 한다. 소유자로 붙으면 권한 분리가 무력화된다.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

TOKEN_HEADER = "X-Planetory-Service-Token"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="publisher")
    sub = parser.add_subparsers(dest="command", required=True)
    load = sub.add_parser("mock-load", help="목업 Gold를 더미 별에 게시한다")
    load.add_argument("--tic", required=True, help="쉼표로 나눈 TIC 목록. stars에 이미 있어야 한다")
    sub.add_parser("mock-purge-sql", help="목업 삭제 SQL을 출력한다. service-db의 psql로 넘긴다")
    resend = sub.add_parser("notify", help="이미 current인 판의 전환을 Backend에 다시 알린다")
    resend.add_argument("--bundle", required=True, help="판 id. b-12 또는 12")
    args = parser.parse_args(argv)

    if args.command == "notify":
        # 적재를 다시 돌리면 판이 이미 있어 알림을 건너뛴다. 토큰 없이 적재했거나 알림이 실패한
        # 판은 이 명령으로만 다시 알릴 수 있다. DB는 건드리지 않는다.
        return 0 if notify(int(args.bundle.removeprefix("b-"))) else 1

    if args.command == "mock-purge-sql":
        # 삭제는 소유자로 한다. 판 전환 때 V23 트리거가 쓴 알림 행을 gold_writer는 지울 수 없다.
        # 소유자 비밀번호를 이 컨테이너에 주지 않도록 SQL만 내보내고 service-db 안에서 실행한다.
        sys.stdout.write((Path(__file__).parent / "mock_purge.sql").read_text(encoding="utf-8"))
        return 0

    import psycopg

    from . import load as loader, mock_source

    tics = [int(t) for t in args.tic.split(",") if t.strip()]
    with psycopg.connect("", autocommit=True) as conn:
        for payload in mock_source.payloads(tics):
            result = loader.publish(conn, payload)
            print(f"TIC {result.tic_id}: b-{result.bundle_id} {result.status}"
                  f" ({'게시' if result.applied else '이미 있음, 바꾸지 않음'})")
            if result.applied:
                notify(result.bundle_id)
    return 0


def notify(bundle_id: int) -> bool:
    """커밋 뒤 Backend에 전환을 알린다. 실패해도 DB 전환은 되돌리지 않는다(정본). 보냈으면 True.

    알림은 후처리를 빨리 시작하려는 신호일 뿐이고 정본은 DB의 current다. 토큰이 없으면 Backend가
    내부 경로 전체를 막으므로 보내지 않는다. 같은 판을 여러 번 알려도 Backend는 200이다.
    """
    resend = f"python -m publisher notify --bundle b-{bundle_id}"
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if not token:
        print(f"  알림 생략: INTERNAL_SERVICE_TOKEN이 없다. b-{bundle_id}는 DB에서 이미 current다."
              f" 토큰을 넣은 뒤 `{resend}`로 보낸다.")
        return False
    url = f"{os.environ.get('BACKEND_URL', 'http://backend:8080')}/internal/bundles/b-{bundle_id}/activated"
    request = urllib.request.Request(url, method="POST", headers={TOKEN_HEADER: token})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                print(f"  알림: {json.load(response)}")
                return True
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"  알림 실패({attempt + 1}/3): {error}")
            time.sleep(2 ** attempt)
    # 적재를 다시 돌려도 판이 이미 있어 publish가 applied=False로 끝나므로 알림이 다시 가지 않는다.
    print(f"  알림을 포기한다. b-{bundle_id}는 DB에서 current다. `{resend}`로 다시 보낸다.")
    return False


if __name__ == "__main__":
    raise SystemExit(main())

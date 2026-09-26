"""Publisher 진입점 [S15P21C206-262, S15P21C206-272].

  python -m publisher mock-load --tic 900000008,900000027
  python -m publisher mock-purge-sql
  python -m publisher notify --bundle b-12
  python -m publisher tutorial-build --inputs <FITS·원천 폴더> --out <폴더> --label-approval <승인 근거>
  python -m publisher load-payload <payload JSON 파일 또는 폴더>...
  python -m publisher tutorial-switch-sql
  python -m publisher supply-report --manifest candidates.json   [S15P21C206-79]
  python -m publisher publish-run --run-id <id> --aggregation <79 집계 출력> --metadata <별 메타데이터> --approval <근거>
                                                                  [S15P21C206-276]

접속은 libpq 환경변수(PGHOST·PGDATABASE·PGUSER·PGPASSWORD)를 따른다. 적재 계정은
planetory_gold_writer 멤버여야 한다. 소유자로 붙으면 권한 분리가 무력화된다. tutorial-build는 DB에 붙지 않고
astropy·scipy가 있는 로컬 환경에서 돌린다(이미지에는 BLS 의존성이 없다). supply-report는
보고 로그인(planetory_reporter, supply.REPORT_TABLES의 SELECT만)으로 읽기만 한다.
"""

from __future__ import annotations

import argparse
import json
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
    build = sub.add_parser("tutorial-build", help="고정 FITS로 튜토리얼 5종 payload를 만든다. DB에 붙지 않는다")
    build.add_argument("--inputs", required=True, type=Path, help="FITS·외부 원천 폴더. tutorial.json의 checksum으로 대조한다")
    build.add_argument("--out", required=True, type=Path, help="payload JSON을 쓸 폴더")
    build.add_argument("--label-approval", required=True, help="튜토리얼 판정 규칙(tutorial-label-v1) 승인 근거")
    publish = sub.add_parser("load-payload", help="payload JSON을 게시한다. 별 등록(star)을 함께 싣는다")
    publish.add_argument("paths", nargs="+", type=Path, help="payload JSON 파일 또는 그 파일들이 든 폴더")
    sub.add_parser("tutorial-switch-sql", help="튜토리얼 1~5 전환 SQL을 출력한다. service-db의 소유자 psql로 넘긴다")
    report = sub.add_parser("supply-report", help="DEC-01 공급 집계 기록을 JSON으로 출력한다. DB는 읽기만 한다")
    report.add_argument("--manifest", required=True, help="79 후보 집계 출력 또는 그 manifest JSON 파일. -는 표준 입력")
    run = sub.add_parser("publish-run", help="배치 run의 ready 별을 첫 게시한다. run 기록 JSON을 표준 출력에 낸다")
    run.add_argument("--run-id", required=True, help="게시할 run ID. 집계 출력의 run_id와 같아야 한다")
    run.add_argument("--aggregation", required=True, help="79 후보 집계 출력 JSON 파일. -는 표준 입력")
    run.add_argument("--metadata", required=True, type=Path, help="TIC별 별 속성·Sector별 관측 원천 JSON 파일")
    run.add_argument("--approval", required=True, help="게시 승인 근거. manifest.publish.approval에 남는다")
    args = parser.parse_args(argv)

    if args.command == "supply-report":
        return supply_report(args.manifest)

    if args.command == "publish-run":
        return publish_run(args)

    if args.command == "notify":
        # DB는 건드리지 않는다. 판을 다시 싣지 않고 알림만 보낸다.
        return 0 if notify([int(args.bundle.removeprefix("b-"))]) else 1

    if args.command in ("mock-purge-sql", "tutorial-switch-sql"):
        # 삭제·튜토리얼 설정은 소유자로 한다. 판 전환 때 V23 트리거가 쓴 알림 행과 회원 기록, tutorial_stars를
        # gold_writer는 바꿀 수 없다. 소유자 비밀번호를 이 컨테이너에 주지 않도록 SQL만 내보내고 service-db 안에서 실행한다.
        name = "mock_purge.sql" if args.command == "mock-purge-sql" else "tutorial_switch.sql"
        sys.stdout.write((Path(__file__).parent / name).read_text(encoding="utf-8"))
        return 0

    if args.command == "tutorial-build":
        from . import tutorial_source

        args.out.mkdir(parents=True, exist_ok=True)
        for payload in tutorial_source.build(args.inputs, args.label_approval):
            path = args.out / f"tutorial-{payload['bundle']['manifest']['publish']['seq']}-{payload['tic_id']}.json"
            path.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            print(f"  {payload['label']}: 후보 {len(payload['candidates'])}개 → {path}")
        return 0

    import psycopg

    from . import load as loader, mock_source

    if args.command == "mock-load":
        payloads = mock_source.payloads(int(t) for t in args.tic.split(",") if t.strip())
        reason = "Gold 목업 새 판 게시"
    else:
        files = [f for p in args.paths for f in (sorted(p.glob("*.json")) if p.is_dir() else [p])]
        payloads = (json.loads(f.read_text(encoding="utf-8")) for f in files)
        reason = "Publisher 새 판 게시"
    with psycopg.connect("", autocommit=True) as conn:
        target = loader.preflight(conn)
        print(f"대상 {conn.info.host}/{conn.info.dbname}, 마이그레이션 V{target.flyway_version}, "
              f"Gold 역할 {'planetory_gold_writer' if target.use_writer_role else '연결 계정(역할 전환 불가)'}")
        for warning in target.warnings:
            print(f"주의: {warning}")
        results = []
        for payload in payloads:
            result = loader.publish_star(conn, payload, target, retire_reason=reason)
            results.append(result)
            print(f"  {result.label}: {result.code} b-{result.bundle_id}")
    # 이미 current인 판도 다시 알린다. 앞선 알림이 실패했어도 같은 명령을 다시 돌리면 복구된다.
    # 토큰이 없어 알림을 생략한 것은 실패가 아니다. 적재는 끝났고 DB의 current가 정본이다.
    sent = notify(loader.notify_targets(results))
    return 0 if sent or not os.environ.get("INTERNAL_SERVICE_TOKEN") else 1


def supply_report(path: str) -> int:
    """79 manifest와 서비스 DB를 대사한 DEC-01 기록을 표준 출력에 낸다. 기록을 냈으면 0이다(판정은 verdict).

    path가 -이면 표준 입력에서 읽는다. 컨테이너에 파일을 마운트하지 않고 넘길 수 있다.
    """
    import datetime as dt

    import psycopg

    from . import supply

    data = json.loads(sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8"))
    manifest = data["manifest"] if "manifest" in data else data
    if not manifest:
        print(f"집계할 manifest가 없다. 거절된 run이다: {data.get('reason')}", file=sys.stderr)
        return 1
    with psycopg.connect("", autocommit=True) as conn:
        slots, rows = supply.read_database(conn, [s["tic_id"] for s in manifest["stars"]])
    at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        record = supply.supply_record(manifest, rows, slots, at)
    except ValueError as exc:
        print(f"집계할 수 없는 manifest다: {exc}", file=sys.stderr)
        return 1
    json.dump(record, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


DONE = {"PUBLISHED", "ALREADY_PUBLISHED", "BUNDLE_SUPERSEDED"}
DATA_FAILURE = 65   # 같은 입력으로는 다시 돌려도 실패한다. Silver 제어기와 같은 뜻이다(Airflow가 재시도하지 않는다).


def publish_run(args) -> int:
    """배치 run 게시 [S15P21C206-276]. run 기록을 표준 출력에, 진행 메시지를 표준 오류에 낸다.

    종료 코드: 모든 별이 끝났으면 0, 일시 장애나 알림 실패가 있으면 1(같은 명령을 다시 돌린다. 끝난 별은
    ALREADY_PUBLISHED다), 그 밖의 거절만 남았으면 65다.
    """
    import datetime as dt

    import psycopg

    from . import load as loader

    now = lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")  # noqa: E731
    started = now()
    aggregation = json.loads(sys.stdin.read() if args.aggregation == "-" else Path(args.aggregation).read_text(encoding="utf-8"))
    metadata = json.loads(args.metadata.read_text(encoding="utf-8"))
    with psycopg.connect("", autocommit=True) as conn:
        target = loader.preflight(conn)
        print(f"대상 {conn.info.dbname}, 마이그레이션 V{target.flyway_version}", file=sys.stderr)
        for warning in target.warnings:
            print(f"주의: {warning}", file=sys.stderr)
        record = run_record(conn, target, aggregation, metadata, run_id=args.run_id, approval=args.approval)
    record["notify"] = notify_record([s["bundle_id"] for s in record["stars"] if s["code"] in ("PUBLISHED", "ALREADY_PUBLISHED")])
    record.update(started_at=started, finished_at=now())
    json.dump(record, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return exit_code(record)


def run_record(conn, target, aggregation: dict, metadata: dict, *, run_id: str, approval: str) -> dict:
    """run 검사를 통과한 ready 별을 하나씩 첫 게시하고 별별 결과를 모은다. 알림은 부르는 쪽이 붙인다."""
    from . import load as loader, run_source

    manifest = aggregation.get("manifest") or {}
    record = {"run_id": run_id, "silver_attempt": manifest.get("silver_attempt"),
              "aggregator_version": manifest.get("aggregator_version"), "approval": approval,
              "flyway_version": target.flyway_version, "status": "rejected", "stars": []}
    if manifest.get("run_id") != run_id:
        return {**record, "reason": f"집계 출력의 run_id({manifest.get('run_id')})가 --run-id와 다르다"}
    try:
        items = run_source.star_payloads(aggregation, metadata, approval)
    except run_source.PublishRejected as exc:
        return {**record, "reason": str(exc)}
    for tic, item in items:
        row = loader.publish_outcome(conn, tic, item, target, first_publish_only=True, retire_reason="배치 run 게시")
        if isinstance(item, dict):
            row["confirmed_without_archive"] = run_source.confirmed_without_archive(item)
        print(f"  TIC {tic}: {row['code']} {'b-' + str(row['bundle_id']) if row['bundle_id'] else row['detail']}",
              file=sys.stderr)
        record["stars"].append(row)
    codes = [s["code"] for s in record["stars"]]
    return {**record, "status": "published", "counts": {c: codes.count(c) for c in sorted(set(codes))}}


def notify_record(bundle_ids: list[int]) -> dict:
    """판 전환 알림 결과. 토큰이 없으면 보내지 않는다(실패가 아니다. DB의 current가 정본이다)."""
    if not bundle_ids:
        return {"status": "none", "results": []}
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if not token:
        return {"status": "skipped_no_token", "results": []}
    results = [{"bundle_id": b, "sent": sent, "outcome": outcome} for b, sent, outcome in
               notify_backend(os.environ.get("BACKEND_URL", "http://backend:8080"), token, bundle_ids)]
    return {"status": "sent" if all(r["sent"] for r in results) else "partial", "results": results}


def exit_code(record: dict) -> int:
    codes = {s["code"] for s in record["stars"]}
    if "PUBLISH_ROLLED_BACK" in codes or record.get("notify", {}).get("status") == "partial":
        return 1
    return DATA_FAILURE if record["status"] == "rejected" or codes - DONE else 0


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

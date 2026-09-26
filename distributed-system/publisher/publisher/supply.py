"""DEC-01 공급 집계: 게시 뒤 서비스 DB와 79 run manifest를 대사해 운영 집계 기록을 만든다 [S15P21C206-79].

  python -m publisher supply-report --manifest <79 후보 집계 출력 또는 그 manifest JSON>

정본은 docs/data/tess-service-scope-v1.md 7.1절(DEC-01)과 contracts/gold/README.md 4.3절이다. 공급 TIC은
이 run에서 ready이고, 이 run의 판이 current이며, DEC-01 공급 자격(published 별, active이고 discoverable인
후보)을 만족하고, 사용 중인(active) 튜토리얼 별이 아닌 TIC이다. Backend 발견 풀(OPS-08)은 후보를 보지 않아
이 조건과 다르며 튜토리얼 active 기준만 같다. 이 run의 대상이 아닌 별(목업 등)은
세지 않는다. 읽기만 한다. REPORT_TABLES의 SELECT만 가진 보고 로그인(planetory_reporter)으로 붙는다.
Gold 쓰기 계정은 tutorial_stars 권한이 없고, 앱 역할(planetory_app)은 쓰기 권한까지 있어 보고용으로 쓰지 않는다.
"""

from __future__ import annotations

import hashlib
import json

VERSION = "dec01-supply-79-v1"
THRESHOLD = 100                  # DEC-01 일반 탐사 고유 TIC 하한
TUTORIAL_SEQS = [1, 2, 3, 4, 5]  # DEC-01 튜토리얼 5종
# 보고 로그인에 줄 SELECT 전부. infra/service README의 계정 준비와 test_load가 이 목록을 쓴다.
REPORT_TABLES = ("tutorial_stars", "stars", "publication_bundles", "candidates")

TUTORIAL_SQL = "SELECT seq, tic_id FROM tutorial_stars WHERE active ORDER BY seq"
STAR_SQL = """
SELECT s.tic_id, s.service_status, b.bundle_version,
       EXISTS (SELECT 1 FROM candidates c
                WHERE c.tic_id = s.tic_id AND c.status = 'active' AND c.discoverable) AS discoverable
  FROM stars s
  LEFT JOIN publication_bundles b ON b.tic_id = s.tic_id AND b.status = 'current'
 WHERE s.tic_id = ANY(%s)
"""
STAR_FIELDS = ("tic_id", "service_status", "bundle_version", "discoverable")


def read_database(conn, tic_ids):
    """읽기 전용 스냅샷 하나에서 활성 튜토리얼 슬롯과 대상·튜토리얼 별의 상태를 읽는다.

    READ COMMITTED는 문장마다 스냅샷을 새로 잡는다. 두 조회 사이에 튜토리얼 전환이 커밋되면 한 기록에
    두 시점이 섞이므로 REPEATABLE READ로 한 시점에 묶는다.
    """
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        slots = dict(conn.execute(TUTORIAL_SQL).fetchall())
        rows = conn.execute(STAR_SQL, (sorted(set(tic_ids) | set(slots.values())),)).fetchall()
    return slots, [dict(zip(STAR_FIELDS, r)) for r in rows]


def supply_record(manifest, star_rows, tutorial_slots, aggregated_at):
    """DEC-01 운영 집계 기록. tutorial_slots는 활성 슬롯 {seq: tic_id}, star_rows는 read_database 결과다.

    ready인데 이 run의 판이 current가 아니면 게시 누락이다. 누락이 있거나 manifest가 미완료면 공급량을
    확정하지 않는다(verdict=undetermined). 통과는 공급 ≥ 100이고 튜토리얼 1~5번이 모두 제공 가능할 때만이다.
    """
    stars = {r["tic_id"]: r for r in star_rows}

    def servable(tic):
        r = stars.get(tic)
        return bool(r) and r["service_status"] == "published" and r["bundle_version"] is not None \
            and r["discoverable"] is True

    by_status = {}
    for s in manifest["stars"]:
        by_status.setdefault(s["status"], []).append(s["tic_id"])
    expected = {b["tic_id"]: b["bundle_version"] for b in manifest["bundles"]}
    tutorial = set(tutorial_slots.values())
    ready = sorted(by_status.get("ready", []))
    # 커널은 ready마다 번들을 남기지만 스키마로는 표현하지 못한다. 손으로 고친 manifest를 거른다.
    if set(ready) - expected.keys():
        raise ValueError(f"ready인데 manifest 번들이 없다: {sorted(set(ready) - expected.keys())}")
    missing = [t for t in ready if (stars.get(t) or {}).get("bundle_version") != expected[t]]
    published = [t for t in ready if t not in missing]
    offered = [t for t in published if servable(t)]
    supply = [t for t in offered if t not in tutorial]
    ready_seqs = sorted(seq for seq, tic in tutorial_slots.items() if servable(tic))
    tutorials_ok = ready_seqs == TUTORIAL_SEQS
    determined = manifest["complete"] is True and not missing
    count = lambda status: len(by_status.get(status, []))  # noqa: E731
    return dict(
        version=VERSION, aggregated_at=aggregated_at, run_id=manifest["run_id"],
        silver_attempt=manifest["silver_attempt"], aggregator_version=manifest["aggregator_version"],
        manifest_sha256=hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                                  separators=(",", ":")).encode("utf-8")).hexdigest(),
        candidates_sha256=manifest["candidates_sha256"], calculation_versions=manifest["calculation_versions"],
        counts=dict(total=manifest["target_tic_count"], ready=count("ready"), unprocessed=count("unprocessed"),
                    failed=count("request_failed") + count("rejected"), held=count("held"),
                    no_signal=count("no_signal"), publish_missing=len(missing),
                    not_servable=len(published) - len(offered), tutorial_excluded=len(offered) - len(supply),
                    supply=len(supply)),
        supply_tic_ids=supply, publish_missing_tic_ids=missing,
        tutorial=dict(active_seqs=sorted(tutorial_slots), ready_seqs=ready_seqs, complete=tutorials_ok),
        threshold=THRESHOLD, determined=determined,
        verdict="undetermined" if not determined else
                "pass" if len(supply) >= THRESHOLD and tutorials_ok else "short")

"""일회용 스키마에 저장소 마이그레이션 전체를 적용하고 시드를 적재·재적재한다.

LOCAL_SEED_TEST_DATABASE_URL 이 없으면 건너뛴다. 테스트는 새 스키마를 만들고 끝나면 지운다. 공유·운영 DB 를
가리키지 않는다. 마이그레이션은 Flyway 없이 파일 순서대로 실행한다(마이그레이션 SQL 은 Flyway 전용 문법을 쓰지
않는다 — 백엔드 개발 환경 안내 V9 절).
"""
import copy
import datetime as dt
import os
import re
import secrets
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from local_seed.load import (SeedError, apply_settings, connect, preflight, publish_star,
                             repository_migration_version)

URL = os.environ.get("LOCAL_SEED_TEST_DATABASE_URL")
MIGRATIONS = Path(__file__).resolve().parents[4] / "apps" / "backend" / "src" / "main" / "resources" / "db" / "migration"
TABLES = ("stars", "observation_datasets", "publication_bundles", "light_curve_segments", "periodograms", "candidates",
          "candidate_dispositions", "external_signal_references", "ai_executions", "ai_evaluations",
          "candidate_status_history", "tutorial_stars", "challenge_rounds")
TODAY = dt.date(2026, 9, 23)

pytestmark = pytest.mark.skipif(not URL, reason="LOCAL_SEED_TEST_DATABASE_URL 이 없다")


def migration_files() -> list[Path]:
    versioned = sorted(MIGRATIONS.glob("V*__*.sql"), key=lambda p: int(re.match(r"V(\d+)__", p.name).group(1)))
    return versioned + sorted(MIGRATIONS.glob("R__*.sql"))


@pytest.fixture(scope="module")
def db():
    schema = f"seed_it_{secrets.token_hex(4)}"
    admin = psycopg.connect(URL, autocommit=True)
    admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        with admin.transaction():
            admin.execute(sql.SQL("SET LOCAL search_path TO {}, public").format(sql.Identifier(schema)))
            admin.execute("SET LOCAL planetory.tutorial_skip_after = '3'")     # local 프로필과 같은 값
            for path in migration_files():
                admin.execute(path.read_text(encoding="utf-8"))
        conn = connect(URL, schema)
        target = preflight(conn, schema, require_flyway=False)
        yield conn, target
        conn.close()
    finally:
        admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
        admin.close()


def counts(conn) -> dict[str, int]:
    return {t: conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(t))).fetchone()[0]
            for t in TABLES}


def test_first_seed_publishes_every_star(db, payloads):
    conn, target = db
    assert target.use_writer_role, "planetory_gold_writer 역할로 적재해야 권한 경계를 확인할 수 있다"
    results = [publish_star(conn, p, target) for p in payloads]
    assert {r.code for r in results} == {"PUBLISHED"}
    assert [s.code for s in apply_settings(conn, payloads, TODAY)] == ["SET"] * 6

    n_candidates = sum(len(p["candidates"]) for p in payloads)
    got = counts(conn)
    assert got["stars"] == got["publication_bundles"] == got["periodograms"] == len(payloads)
    assert got["candidates"] == got["candidate_dispositions"] == n_candidates
    assert got["light_curve_segments"] == got["observation_datasets"] == sum(len(p["segments"]) for p in payloads)
    assert got["tutorial_stars"] == 5 and got["challenge_rounds"] == 1

    # 백엔드가 읽는 조건: 공개된 별마다 current 판 하나, manifest 의 세그먼트·미세 조정·격자 규칙.
    rows = conn.execute("""
        SELECT s.tic_id, b.manifest, (SELECT count(*) FROM light_curve_segments g
                                        WHERE g.id IN (SELECT jsonb_array_elements_text(b.manifest->'segment_ids')::bigint)
                                          AND g.tic_id = s.tic_id)
          FROM stars s JOIN publication_bundles b ON b.tic_id = s.tic_id AND b.status = 'current'
         WHERE s.service_status = 'published'""").fetchall()
    assert len(rows) == len(payloads)
    for _, manifest, n_segments in rows:
        assert n_segments == len(manifest["segment_ids"])
        assert manifest["fine_tune"]["half_width_cells"] == 3 and manifest["period_grid"]["spacing"] == "log"
    first = conn.execute("SELECT tic_id FROM tutorial_stars WHERE seq = 1 AND active").fetchone()[0]
    assert first == next(p["tic_id"] for p in payloads if p["tutorial_seq"] == 1)


def test_rerun_changes_nothing(db, payloads):
    conn, target = db
    before = counts(conn)
    assert {publish_star(conn, p, target).code for p in payloads} == {"ALREADY_PUBLISHED"}
    assert [s.code for s in apply_settings(conn, payloads, TODAY)] == ["KEPT"] * 6
    assert counts(conn) == before


def test_same_version_with_other_content_is_rejected(db, payloads):
    conn, target = db
    before = counts(conn)
    changed = copy.deepcopy(payloads[0])
    changed["bundle"]["payload_digest"] = "0" * 64
    with pytest.raises(SeedError) as caught:
        publish_star(conn, changed, target)
    assert caught.value.code == "IDEMPOTENCY_CONFLICT"
    assert counts(conn) == before


def test_new_seed_version_replaces_bundle_and_retires_candidates(db, payloads):
    conn, target = db
    original = next(p for p in payloads if p["label"] == "SYN-07")
    old_bundle = conn.execute("SELECT id FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
                              (original["tic_id"],)).fetchone()[0]
    segments_before = counts(conn)["light_curve_segments"]
    upgraded = copy.deepcopy(original)
    upgraded["bundle"]["bundle_version"] = "pv1-" + "1" * 64
    upgraded["bundle"]["payload_digest"] = upgraded["bundle"]["manifest"]["local_seed"]["payload_digest"] = "v2"

    result = publish_star(conn, upgraded, target)
    assert result.code == "PUBLISHED" and result.archived_bundle_ids == [old_bundle]
    assert len(result.retired_candidate_ids) == len(original["candidates"])
    status = conn.execute("SELECT status FROM publication_bundles WHERE id = %s", (old_bundle,)).fetchone()[0]
    assert status == "archived"
    assert conn.execute("SELECT count(*) FROM periodograms WHERE bundle_id = %s", (old_bundle,)).fetchone()[0] == 0
    history = conn.execute("SELECT count(*) FROM candidate_status_history WHERE bundle_id = %s AND new_value = 'retired'",
                           (result.bundle_id,)).fetchone()[0]
    assert history == len(original["candidates"])
    assert counts(conn)["light_curve_segments"] == segments_before        # 같은 곡선은 다시 쓴다
    # 교체된 판을 다시 보내도 current 로 되돌리지 않는다(BUNDLE_SUPERSEDED).
    assert publish_star(conn, original, target).code == "BUNDLE_SUPERSEDED"


def test_existing_operator_settings_are_not_overwritten(db, payloads):
    conn, _ = db
    other = next(p["tic_id"] for p in payloads if p["role"] == "pool")
    conn.execute("UPDATE tutorial_stars SET tic_id = %s WHERE seq = 5", (other,))
    results = {s.name: s.code for s in apply_settings(conn, payloads, TODAY)}
    assert results.pop("튜토리얼 5") == "CONFLICT"
    assert set(results.values()) == {"KEPT"}
    assert conn.execute("SELECT tic_id FROM tutorial_stars WHERE seq = 5").fetchone()[0] == other


def test_refuses_database_behind_repository_migrations(db):
    """마이그레이션이 덜 된 DB 에 먼저 넣으면 이후 마이그레이션이 데이터 위에서 멈출 수 있다."""
    conn, target = db
    conn.execute("CREATE TABLE flyway_schema_history (installed_rank INT, version TEXT, success BOOLEAN)")
    try:
        conn.execute("INSERT INTO flyway_schema_history VALUES (1, '1', true)")
        with pytest.raises(SeedError) as caught:
            preflight(conn, target.schema, require_flyway=True)
        assert caught.value.code == "MIGRATION_BEHIND"
        latest = repository_migration_version()
        conn.execute("UPDATE flyway_schema_history SET version = %s", (str(latest),))
        assert preflight(conn, target.schema, require_flyway=True).flyway_version == latest
    finally:
        conn.execute("DROP TABLE flyway_schema_history")

"""Publisher 적재를 실제 PostgreSQL에서 검사한다 [S15P21C206-86].

PUBLISHER_TEST_DATABASE_URL이 없으면 건너뛴다. 새 스키마를 만들어 저장소 마이그레이션 전체를 파일 순서대로
적용하고(Flyway 없이. 마이그레이션 SQL은 Flyway 전용 문법을 쓰지 않는다), 끝나면 지운다. 역할을 만드는
마이그레이션이 있어 소유자(superuser)로 접속한다. 공유·운영 DB를 가리키지 않는다. CI는 validate:publisher가
일회용 postgres 서비스로 돌린다.

테스트마다 다른 TIC를 써서 서로가 만든 행을 보지 않는다.
"""

from __future__ import annotations

import copy
import os
import re
import secrets
import threading
import time
import unittest
from pathlib import Path

from astro_kernel.gold_canonical import array_checksum, normalize_array

URL = os.environ.get("PUBLISHER_TEST_DATABASE_URL")
MIGRATIONS = Path(__file__).resolve().parents[2] / "apps" / "backend" / "src" / "main" / "resources" / "db" / "migration"

if URL:
    import psycopg
    from psycopg import sql

    from publisher import load, mock_source
    from publisher.load import PublishError, preflight, publish_star

SCHEMA = f"publisher_it_{secrets.token_hex(4)}"
COUNTS = {
    "bundles": "SELECT count(*) FROM publication_bundles WHERE tic_id = %s",
    "current": "SELECT count(*) FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
    "staging": "SELECT count(*) FROM publication_bundles WHERE tic_id = %s AND status = 'staging'",
    "segments": "SELECT count(*) FROM light_curve_segments WHERE tic_id = %s",
    "observations": "SELECT count(*) FROM observation_datasets WHERE tic_id = %s",
    "periodograms": "SELECT count(*) FROM periodograms p JOIN publication_bundles b ON b.id = p.bundle_id "
                    "WHERE b.tic_id = %s",
    "candidates": "SELECT count(*) FROM candidates WHERE tic_id = %s",
    "active": "SELECT count(*) FROM candidates WHERE tic_id = %s AND status = 'active'",
    "dispositions": "SELECT count(*) FROM candidate_dispositions d JOIN candidates c ON c.id = d.candidate_id "
                    "WHERE c.tic_id = %s",
    "history": "SELECT count(*) FROM candidate_status_history h JOIN candidates c ON c.id = h.candidate_id "
               "WHERE c.tic_id = %s",
    "external": "SELECT count(*) FROM external_signal_references WHERE tic_id = %s",
}


def migration_files() -> list[Path]:
    versioned = sorted(MIGRATIONS.glob("V*__*.sql"), key=lambda p: int(re.match(r"V(\d+)__", p.name).group(1)))
    return versioned + sorted(MIGRATIONS.glob("R__*.sql"))


def connect(**kwargs):
    return psycopg.connect(URL, options=f"-c search_path={SCHEMA},public", **kwargs)


def setUpModule():
    if not URL:
        return
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(SCHEMA)))
    with connect() as admin:           # 마이그레이션 전체를 한 트랜잭션으로. 실패하면 반쯤 만든 스키마가 남지 않는다.
        for path in migration_files():
            admin.execute(path.read_text(encoding="utf-8"))


def tearDownModule():
    if not URL:
        return
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(SCHEMA)))


def payload(tic: int) -> dict:
    return next(mock_source.payloads([tic]))


def new_version(p: dict, suffix: str) -> dict:
    """같은 세그먼트로 만든 다음 판. 어댑터처럼 요약을 다시 계산해 싣는다."""
    q = copy.deepcopy(p)
    q["bundle"]["bundle_version"] += suffix
    q["bundle"]["payload_digest"] = load.payload_digest(q)
    return q


@unittest.skipUnless(URL, "PUBLISHER_TEST_DATABASE_URL이 없다")
class PublishStarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = connect(autocommit=True)
        cls.target = preflight(cls.conn, require_flyway=False)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def star(self, tic: int) -> int:
        self.conn.execute("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (%s, 0, 'published')",
                          (tic,))
        return tic

    def counts(self, tic: int) -> dict[str, int]:
        return {name: self.conn.execute(q, (tic,)).fetchone()[0] for name, q in COUNTS.items()}

    def test_first_publish_writes_every_gold_table_through_writer_role(self):
        tic = self.star(900_000_101)
        p = payload(tic)
        self.assertTrue(self.target.use_writer_role, "planetory_gold_writer로 써야 권한 경계가 검사된다")

        result = publish_star(self.conn, p, self.target)

        self.assertEqual(result.code, "PUBLISHED")
        n_candidates = len(p["candidates"])
        self.assertEqual(self.counts(tic), {
            "bundles": 1, "current": 1, "staging": 0, "segments": len(p["segments"]),
            "observations": len(p["segments"]), "periodograms": 1, "candidates": n_candidates,
            "active": n_candidates, "dispositions": n_candidates, "history": 0,
            "external": sum(1 for c in p["candidates"] if c["external"])})
        manifest = self.conn.execute("SELECT manifest FROM publication_bundles WHERE id = %s",
                                     (result.bundle_id,)).fetchone()[0]
        self.assertEqual(len(manifest["segment_ids"]), len(p["segments"]))
        self.assertEqual(manifest["publish"]["payload_digest"], load.payload_digest(p))
        self.assertIn(f"periodogram:{result.bundle_id}:power", manifest["array_checksums"])

    def test_rerun_of_same_payload_changes_nothing(self):
        tic = self.star(900_000_102)
        p = payload(tic)
        first = publish_star(self.conn, p, self.target)
        before = self.counts(tic)

        again = publish_star(self.conn, copy.deepcopy(p), self.target)

        self.assertEqual((again.code, again.bundle_id), ("ALREADY_PUBLISHED", first.bundle_id))
        self.assertEqual(self.counts(tic), before)

    def test_same_version_with_other_content_is_an_idempotency_conflict(self):
        tic = self.star(900_000_103)
        p = payload(tic)
        publish_star(self.conn, p, self.target)
        before = self.counts(tic)
        changed = copy.deepcopy(p)
        changed["bundle"]["base_days"] += 0.001
        changed["bundle"]["payload_digest"] = None      # 적재가 새로 계산한다

        with self.assertRaises(PublishError) as caught:
            publish_star(self.conn, changed, self.target)

        self.assertEqual(caught.exception.code, "IDEMPOTENCY_CONFLICT")
        self.assertEqual(self.counts(tic), before)

    def test_adapter_digest_that_disagrees_with_the_loader_rule_is_rejected_before_writing(self):
        tic = self.star(900_000_104)
        p = payload(tic)
        p["bundle"]["payload_digest"] = "0" * 64

        with self.assertRaises(PublishError) as caught:
            publish_star(self.conn, p, self.target)

        self.assertEqual(caught.exception.code, "PUBLISH_REJECTED")
        self.assertEqual(self.counts(tic)["bundles"], 0)

    def test_database_enforces_the_retry_key(self):
        tic = self.star(900_000_105)
        result = publish_star(self.conn, payload(tic), self.target)

        # 적재 코드를 거치지 않는 쓰기(수동 백필·복구)도 DB가 막아야 한다(V8). 다른 제약에 먼저 걸리지 않게
        # 같은 행을 상태만 바꿔 복제한다.
        with self.assertRaises(psycopg.errors.UniqueViolation):
            self.conn.execute("""
                INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd,
                                                base_days)
                SELECT tic_id, bundle_version, 'archived', manifest, fold_reference_time_btjd, base_days
                  FROM publication_bundles WHERE id = %s""", (result.bundle_id,))

    def test_next_version_reuses_unchanged_segments_and_archives_the_previous_bundle(self):
        tic = self.star(900_000_106)
        p = payload(tic)
        first = publish_star(self.conn, p, self.target)

        second = publish_star(self.conn, new_version(p, "-next"), self.target)

        self.assertEqual(second.code, "PUBLISHED")
        self.assertEqual(second.archived_bundle_ids, [first.bundle_id])
        n_candidates = len(p["candidates"])
        got = self.counts(tic)
        self.assertEqual(got["segments"], len(p["segments"]), "같은 자연 키의 세그먼트는 새로 만들지 않는다")
        self.assertEqual((got["bundles"], got["current"], got["periodograms"]), (2, 1, 1))
        self.assertEqual((got["candidates"], got["active"], got["history"]), (2 * n_candidates, n_candidates,
                                                                              n_candidates))
        status = self.conn.execute("SELECT status FROM publication_bundles WHERE id = %s",
                                   (first.bundle_id,)).fetchone()[0]
        self.assertEqual(status, "archived")
        ids = [self.conn.execute("SELECT manifest -> 'segment_ids' FROM publication_bundles WHERE id = %s",
                                 (r.bundle_id,)).fetchone()[0] for r in (first, second)]
        self.assertEqual(ids[0], ids[1])

    def test_changed_segment_under_the_same_natural_key_is_an_idempotency_conflict(self):
        tic = self.star(900_000_107)
        p = payload(tic)
        first = publish_star(self.conn, p, self.target)
        before = self.counts(tic)
        q = copy.deepcopy(p)
        seg = q["segments"][0]
        i = next(i for i, v in enumerate(seg["flux"]) if v is not None)
        seg["flux"][i] += 1e-3
        seg["checksum"] = array_checksum(normalize_array(seg["flux"]))
        q = new_version(q, "-flux-changed")

        with self.assertRaises(PublishError) as caught:
            publish_star(self.conn, q, self.target)

        self.assertEqual(caught.exception.code, "IDEMPOTENCY_CONFLICT")
        self.assertEqual(self.counts(tic), before)
        current = self.conn.execute("SELECT id FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
                                    (tic,)).fetchone()[0]
        self.assertEqual(current, first.bundle_id)

    def test_failure_after_staging_leaves_no_staging_bundle_and_keeps_current(self):
        tic = self.star(900_000_108)
        p = payload(tic)
        first = publish_star(self.conn, p, self.target)
        before = self.counts(tic)
        q = copy.deepcopy(p)
        # 판·세그먼트·주기도·후보를 모두 넣은 뒤 같은 트랜잭션의 조회 검사에서 멈추게 한다.
        q["bundle"]["manifest"]["record_checksums"]["candidates"] = "0" * 64
        q = new_version(q, "-broken")

        with self.assertRaises(PublishError) as caught:
            publish_star(self.conn, q, self.target)

        self.assertEqual(caught.exception.code, "PUBLISH_REJECTED")
        self.assertEqual(self.counts(tic), before)
        current = self.conn.execute("SELECT id FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
                                    (tic,)).fetchone()[0]
        self.assertEqual(current, first.bundle_id)

    def test_array_length_and_unit_range_violations_roll_back_everything_written_before(self):
        # 배열 길이(n_periods == power 길이)와 단위 범위(0 < 최소 주기 < 최대 주기)는 DB CHECK가 강제한다(V1).
        # 주기도는 세그먼트·판 뒤에 들어가므로, 걸리면 앞서 넣은 행까지 전부 되돌아가야 한다.
        for tic, name, change in ((900_000_110, "n_periods", lambda pg: pg.update(n_periods=pg["n_periods"] + 1)),
                                  (900_000_111, "period range",
                                   lambda pg: pg.update(period_min_days=pg["period_max_days"]))):
            with self.subTest(name):
                self.star(tic)
                p = payload(tic)
                change(p["periodogram"])

                with self.assertRaises(psycopg.errors.CheckViolation):
                    publish_star(self.conn, p, self.target)

                got = self.counts(tic)
                self.assertEqual((got["bundles"], got["segments"], got["observations"]), (0, 0, 0))

    def test_concurrent_publishes_of_one_payload_are_serialized_into_one_bundle(self):
        tic = self.star(900_000_109)
        p = payload(tic)
        results, errors = [], []

        def publish():
            try:
                with connect(autocommit=True) as conn:
                    results.append(publish_star(conn, copy.deepcopy(p), preflight(conn, require_flyway=False)).code)
            except Exception as exc:  # noqa: BLE001  스레드 밖에서 실패로 보이게 모은다
                errors.append(exc)

        # 잠금을 먼저 쥐어 두 게시가 반드시 겹치게 만든다. 둘 다 잠금을 기다리는 것을 본 뒤에 놓는다.
        with connect() as holder:
            holder.execute("SELECT pg_advisory_xact_lock(%s)", (tic,))
            threads = [threading.Thread(target=publish) for _ in range(2)]
            for t in threads:
                t.start()
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                waiting = self.conn.execute("""
                    SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                       AND objid = %s""", (tic & 0xFFFFFFFF,)).fetchone()[0]
                if waiting == 2:
                    break
                time.sleep(0.05)
            self.assertEqual(waiting, 2, "두 게시가 같은 TIC 잠금을 기다려야 한다")
            holder.commit()
        for t in threads:
            t.join(timeout=60)

        self.assertEqual(errors, [])
        self.assertEqual(sorted(results), ["ALREADY_PUBLISHED", "PUBLISHED"])
        got = self.counts(tic)
        self.assertEqual((got["bundles"], got["current"], got["candidates"]), (1, 1, len(p["candidates"])))

    def test_many_stars_publish_independently(self):
        tics = [self.star(900_000_200 + i) for i in range(20)]

        codes = [publish_star(self.conn, p, self.target).code for p in mock_source.payloads(tics)]

        self.assertEqual(codes, ["PUBLISHED"] * len(tics))
        for tic in tics:
            got = self.counts(tic)
            self.assertEqual((got["bundles"], got["current"], got["periodograms"]), (1, 1, 1), tic)


if __name__ == "__main__":
    unittest.main()

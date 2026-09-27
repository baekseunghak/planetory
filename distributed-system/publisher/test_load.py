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
import tempfile
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

    from publisher import load, mock_source, run_source
    from publisher.load import PublishError, preflight, publish_star
    from test_run_source import synthetic_run, write_ready

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
            "external": sum(len(c["external"]) for c in p["candidates"]) + len(p["external_only"])})
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

    def run_payload(self, tic: int) -> dict:
        """합성 run의 배치 payload [S15P21C206-276]. 게시 전 검사를 통과한 것이어야 한다."""
        with tempfile.TemporaryDirectory() as tmp:
            _, items = run_source.read_ready(write_ready(Path(tmp), *synthetic_run(tic)), "run-fixture", "unittest-only")
            [(_, p)] = list(items)
        self.assertIsInstance(p, dict, p)
        return p

    def test_run_payload_registers_a_new_discoverable_star_as_published_with_every_external_reference(self):
        tic = 990_000_101
        p = self.run_payload(tic)

        result = publish_star(self.conn, p, self.target, first_publish_only=True)

        self.assertEqual(result.code, "PUBLISHED")
        # 합성 후보는 discoverable이다. 찾을 수 있는 후보가 있는 새 별만 published로 등록한다.
        self.assertEqual(self.conn.execute("SELECT service_status, confirmed_count FROM stars WHERE tic_id = %s",
                                           (tic,)).fetchone(), ("published", 1))
        # 후보 하나에 두 원천, 후보와 대응하지 않은 행 하나. 266은 archive·정확한 행성명·활성 확정 후보로 찾는다.
        refs = self.conn.execute("""
            SELECT e.source, e.external_id, c.status, c.is_confirmed
              FROM external_signal_references e LEFT JOIN candidates c ON c.id = e.candidate_id
             WHERE e.tic_id = %s ORDER BY 1, 2""", (tic,)).fetchall()
        self.assertEqual(refs, [("archive", f"TIC {tic} b", "active", True), ("toi", f"{tic}.01", "active", True),
                                ("toi", f"{tic}.02", None, None)])
        again = publish_star(self.conn, self.run_payload(tic), self.target, first_publish_only=True)
        self.assertEqual((again.code, again.bundle_id), ("ALREADY_PUBLISHED", result.bundle_id))

    def test_run_payload_keeps_the_public_status_and_known_values_of_an_existing_star(self):
        tic = self.star(990_000_102)
        self.conn.execute("UPDATE stars SET teff_k = 5800, radius_rsun = 1.0, tmag = 9.5 WHERE tic_id = %s", (tic,))

        publish_star(self.conn, self.run_payload(tic), self.target, first_publish_only=True)

        # 배치 run은 별 속성의 원천이 없어 NULL을 보낸다. 이미 있는 값은 그대로 둔다.
        self.assertEqual(self.conn.execute("SELECT service_status, teff_k, radius_rsun, tmag FROM stars WHERE tic_id = %s",
                                           (tic,)).fetchone(), ("published", 5800, 1.0, 9.5))

    def test_initial_status_applies_to_new_stars_only(self):
        # 찾을 수 있는 후보가 없는 새 별(run_source가 initial_status=hidden을 준다)은 hidden으로 등록한다.
        fresh = 990_000_105
        p = self.run_payload(fresh)
        p["star"]["initial_status"] = "hidden"
        publish_star(self.conn, p, self.target, first_publish_only=True)
        # 기존 별은 initial_status가 published여도 운영자가 둔 공개 상태를 그대로 둔다.
        kept = 990_000_106
        self.conn.execute("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (%s, 0, 'hidden')", (kept,))
        q = self.run_payload(kept)
        self.assertEqual(q["star"]["initial_status"], "published")
        publish_star(self.conn, q, self.target, first_publish_only=True)

        got = dict(self.conn.execute("SELECT tic_id, service_status FROM stars WHERE tic_id = ANY(%s)",
                                     ([fresh, kept],)).fetchall())
        self.assertEqual(got, {fresh: "hidden", kept: "hidden"})

    def test_an_unexpected_error_is_one_rejected_row_not_a_stopped_run(self):
        from publisher.load import publish_outcome

        tic = 990_000_104
        broken = {k: v for k, v in self.run_payload(tic).items() if k != "segments"}

        row = publish_outcome(self.conn, tic, broken, self.target, first_publish_only=True)

        self.assertEqual(row["code"], "PUBLISH_REJECTED")
        self.assertIn("KeyError", row["detail"])
        self.assertEqual(self.counts(tic)["bundles"], 0)

    def test_first_publish_only_leaves_a_star_with_a_current_bundle_alone(self):
        tic = self.star(990_000_103)
        first = publish_star(self.conn, payload(tic), self.target)   # 튜토리얼 별처럼 이미 current가 있다
        before = self.counts(tic)

        with self.assertRaises(PublishError) as caught:
            publish_star(self.conn, self.run_payload(tic), self.target, first_publish_only=True)

        self.assertEqual(caught.exception.code, "PUBLISH_REJECTED")
        self.assertEqual(self.counts(tic), before)
        current = self.conn.execute("SELECT id FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
                                    (tic,)).fetchone()[0]
        self.assertEqual(current, first.bundle_id)

    def test_publish_run_records_every_star_and_one_failure_does_not_stop_the_next(self):
        from publisher.__main__ import exit_code, run_record

        fresh, has_current, broken = 990_000_201, 990_000_202, 990_000_203
        run, meta = synthetic_run(fresh, has_current, broken)
        publish_star(self.conn, payload(self.star(has_current)), self.target)   # 튜토리얼 별처럼 current가 있다
        next(b for b in run["bundles"] if b["bundle"]["tic_id"] == broken)["segments"][0]["flux"][0] = 1.5
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ready = write_ready(Path(tmp.name), run, meta)

        first = run_record(self.conn, self.target, ready, run_id="run-fixture", approval="unittest-only")

        self.assertEqual(first["status"], "published")
        got = {s["tic_id"]: s for s in first["stars"]}
        self.assertEqual({t: s["code"] for t, s in got.items()},
                         {fresh: "PUBLISHED", has_current: "PUBLISH_REJECTED", broken: "PUBLISH_REJECTED"})
        self.assertEqual(got[fresh]["confirmed_without_archive"], 0)
        self.assertEqual((got[has_current]["current_kept"], got[broken]["current_kept"]), (True, False))
        self.assertEqual(first["counts"], {"PUBLISHED": 1, "PUBLISH_REJECTED": 2})
        self.assertEqual(self.counts(broken)["bundles"], 0, "게시 전 검사에 걸린 별은 DB에 쓰지 않는다")
        self.assertEqual(exit_code({**first, "notify": {"status": "none"}}), 65)
        manifest = self.conn.execute("SELECT manifest -> 'publish' FROM publication_bundles WHERE id = %s",
                                     (got[fresh]["bundle_id"],)).fetchone()[0]
        self.assertEqual((manifest["run_id"], manifest["approval"]), ("run-fixture", "unittest-only"))

        again = run_record(self.conn, self.target, ready, run_id="run-fixture", approval="unittest-only")
        self.assertEqual({s["tic_id"]: (s["code"], s["bundle_id"]) for s in again["stars"]}[fresh],
                         ("ALREADY_PUBLISHED", got[fresh]["bundle_id"]))

        wrong = run_record(self.conn, self.target, ready, run_id="other-run", approval="unittest-only")
        self.assertEqual((wrong["status"], wrong["stars"]), ("rejected", []))


@unittest.skipUnless(URL, "PUBLISHER_TEST_DATABASE_URL이 없다")
class SupplyReadTest(unittest.TestCase):
    """supply-report의 조회 [S15P21C206-79]. 최소 권한 보고 역할로 읽히고, 활성 튜토리얼만 슬롯으로 본다."""

    def test_report_role_reads_current_versions_and_active_tutorial_slots_only(self):
        from publisher import supply

        with connect(autocommit=True) as conn:
            target = preflight(conn, require_flyway=False)
            tics = [900_000_311, 900_000_312, 900_000_313]
            for tic in tics[:2]:
                conn.execute("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (%s, 0, 'published')",
                             (tic,))
            published = {p["tic_id"]: p for p in mock_source.payloads(tics[:2])}
            for p in published.values():
                publish_star(conn, p, target)
            conn.execute("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES "
                         "(1, %s, 'deep_confirmed', true), (2, %s, 'shallow_confirmed', false)", tuple(tics[:2]))
            # 운영 보고 로그인과 같은 최소 권한: 스키마 USAGE와 REPORT_TABLES SELECT만.
            role = sql.Identifier(f"supply_reporter_{secrets.token_hex(3)}")
            conn.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(role))
            conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(SCHEMA), role))
            conn.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(
                sql.SQL(", ").join(map(sql.Identifier, supply.REPORT_TABLES)), role))
            try:
                conn.execute(sql.SQL("SET ROLE {}").format(role))
                slots, rows = supply.read_database(conn, tics)
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute("SELECT 1 FROM submissions LIMIT 1")
            finally:
                conn.execute("RESET ROLE")
                conn.execute("DELETE FROM tutorial_stars WHERE seq IN (1, 2)")
                conn.execute(sql.SQL("DROP OWNED BY {}").format(role))
                conn.execute(sql.SQL("DROP ROLE {}").format(role))

        self.assertEqual(slots, {1: tics[0]})
        got = {r["tic_id"]: r for r in rows}
        self.assertEqual(set(got), set(tics[:2]), "stars에 없는 TIC은 행이 없다")
        for tic, p in published.items():
            self.assertEqual((got[tic]["service_status"], got[tic]["bundle_version"]),
                             ("published", p["bundle"]["bundle_version"]))
            self.assertEqual(got[tic]["discoverable"], any(c["record"]["discoverable"] for c in p["candidates"]))

SWITCH_SQL = Path(__file__).resolve().parent / "publisher" / "tutorial_switch.sql"
TUTORIAL_TICS = (149603524, 307210830, 279569718, 300871545, 278956474)
OLD_FIRST, REWARD = 900_000_301, 900_000_302


def switch_body() -> str:
    """psql 메타 명령을 뺀 전환 본문. BEGIN과 COMMIT/ROLLBACK은 테스트가 쥔다."""
    text = SWITCH_SQL.read_text(encoding="utf-8")
    return text[text.index("\nBEGIN;") + len("\nBEGIN;"):text.index("\n\\if :apply")]


@unittest.skipUnless(URL, "PUBLISHER_TEST_DATABASE_URL이 없다")
class TutorialSwitchTest(unittest.TestCase):
    """tutorial_switch.sql의 옛 1번 성과 정리 [S15P21C206-272, !226 백승학 리뷰]. 매 테스트를 rollback한다."""

    @classmethod
    def setUpClass(cls):
        cls.conn = connect(autocommit=True)
        target = preflight(cls.conn, require_flyway=False)
        for tic in (*TUTORIAL_TICS, OLD_FIRST, REWARD):
            cls.conn.execute("INSERT INTO stars(tic_id, confirmed_count, service_status) VALUES (%s, 0, 'published')",
                             (tic,))
            publish_star(cls.conn, payload(tic), target)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.conn.execute("BEGIN")
        self.addCleanup(self.conn.execute, "ROLLBACK")
        c = self.conn
        c.execute("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (1, %s, 'deep_confirmed', true)",
                  (OLD_FIRST,))
        self.user = c.execute("INSERT INTO users(provider, provider_user_id, nickname) VALUES ('test', %s, 't272') "
                              "RETURNING id", (secrets.token_hex(4),)).fetchone()[0]
        self.unlock(OLD_FIRST, "tutorial", 0)
        bundle, candidate = self.current(OLD_FIRST)
        sub = self.submission(OLD_FIRST, bundle, candidate)
        achievement = c.execute("INSERT INTO user_candidate_achievements(user_id, candidate_id, achievement_type, "
                                "recognized_submission_id, recognized_at) VALUES (%s, %s, 'confirmed', %s, now()) "
                                "RETURNING id", (self.user, candidate, sub)).fetchone()[0]
        self.unlock(REWARD, "achievement", 1, achievement)

    def current(self, tic) -> tuple[int, int]:
        return self.conn.execute("SELECT b.id, c.id FROM publication_bundles b JOIN candidates c ON c.tic_id = b.tic_id "
                                 "WHERE b.tic_id = %s AND b.status = 'current' LIMIT 1", (tic,)).fetchone()

    def unlock(self, tic, reason, ordinal, achievement=None):
        self.conn.execute(
            "INSERT INTO star_unlocks(user_id, tic_id, unlock_reason, trigger_achievement_id, seq, depth_z, unlocked_at, "
            "world_x, world_y, layout_version, layout_ordinal) VALUES (%s, %s, %s, %s, %s, 0, now(), 0, 0, 'test', %s)",
            (self.user, tic, reason, achievement, 0 if achievement else None, ordinal))
        self.conn.execute("INSERT INTO user_star_progress(user_id, tic_id) VALUES (%s, %s)", (self.user, tic))

    def submission(self, tic, bundle, candidate=None) -> int:
        kind = ("candidate", "LIKELY_PLANET", 1.0, 0.1, 0.2, "matched", "recognized") if candidate else \
               ("skipped", None, None, None, None, "skipped", "none")
        return self.conn.execute(
            "INSERT INTO submissions(user_id, tic_id, bundle_id, request_id, submission_kind, curve_step, "
            "removed_candidate_ids, user_judgment, submitted_period, phase_start, phase_end, match_result, "
            "achievement_result, matched_candidate_id, fold_reference_time_btjd, evidence_checks, "
            "residual_model_version, periodogram_config_version, rule_version) "
            "VALUES (%s, %s, %s, gen_random_uuid(), %s, 0, '{}', %s, %s, %s, %s, %s, %s, %s, 0, '[]', 't', 't', 'rule-0') "
            "RETURNING id", (self.user, tic, bundle, kind[0], *kind[1:], candidate)).fetchone()[0]

    def count(self, table, tic) -> int:
        return self.conn.execute(f"SELECT count(*) FROM {table} WHERE user_id = %s AND tic_id = %s",
                                 (self.user, tic)).fetchone()[0]

    def test_reward_star_without_member_records_is_cleared_and_member_moves(self):
        self.conn.execute(switch_body())

        self.assertEqual(self.count("star_unlocks", REWARD), 0)
        self.assertEqual(self.count("star_unlocks", TUTORIAL_TICS[0]), 1)
        self.assertEqual(self.count("submissions", OLD_FIRST), 0)

    def test_member_records_on_reward_star_stop_the_switch(self):
        self.submission(REWARD, self.current(REWARD)[0])   # 보상 별에서 이어 한 탐사. 외래 키로는 막히지 않는다.

        with self.assertRaisesRegex(psycopg.errors.RaiseException, "성과로 열린 별"):
            self.conn.execute(switch_body())


if __name__ == "__main__":
    unittest.main()

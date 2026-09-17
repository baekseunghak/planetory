"""독립 PostgreSQL round-trip: 격리 스키마에 V1~V8 을 적용하고 payload 를 적재한 뒤 다시 읽어 계약대로 보존됐는지 검사한다.

접속: 환경변수 DATABASE_URL (기본 postgresql://planetory:ssafy@127.0.0.1:15432/planetory_poc — 개발 셋업 문서의 로컬 Compose 기본값.
      `localhost` 를 쓰면 Windows 에서 IPv6 ::1 을 먼저 시도해 접속당 약 2분 지연된다).
스키마: gold_rt_<hex> 를 만들고 search_path 를 그 스키마로 둔 채 마이그레이션 SQL 파일을 그대로 실행한다(Flyway 없이).
        V1 의 `CREATE EXTENSION pg_trgm WITH SCHEMA public` 은 컨테이너 소유 계정이라 통과한다.
검사(check)는 하나씩 결과를 기록하고 마지막에 요약한다. 실패해도 계속 진행해 보고서에 남긴다.
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
import time
from decimal import Decimal
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from jsonschema import Draft202012Validator
from psycopg import sql
from psycopg.types.json import Jsonb

from . import qa
from .canonical import array_checksum, bundle_version, normalize_array, record_checksum

REPO = Path(__file__).resolve().parents[3]
MIGRATIONS = sorted((REPO / "apps" / "backend" / "src" / "main" / "resources" / "db" / "migration").glob("V*.sql"),
                    key=lambda p: int(re.match(r"V(\d+)__", p.name).group(1)))
SCHEMA_JSON = json.loads((REPO / "contracts" / "gold" / "transit-model.schema.json").read_text(encoding="utf-8"))
DEFAULT_URL = "postgresql://planetory:ssafy@127.0.0.1:15432/planetory_poc"   # localhost 는 ::1 먼저 시도해 2분 대기 (컨테이너는 127.0.0.1 만 바인딩)


class Report:
    def __init__(self):
        self.checks: list[dict] = []

    def add(self, name: str, ok: bool, detail: str = ""):
        self.checks.append({"check": name, "ok": bool(ok), "detail": detail})
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if not c["ok"]]


def connect(url: str | None = None) -> psycopg.Connection:
    return psycopg.connect(url or os.environ.get("DATABASE_URL", DEFAULT_URL), autocommit=False)


def apply_migrations(conn: psycopg.Connection, schema: str) -> None:
    with conn.cursor() as cur:
        cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        cur.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
        for m in MIGRATIONS:
            cur.execute(m.read_text(encoding="utf-8"))
    conn.commit()


def _floats(arr):
    return [None if v is None else float(v) for v in arr]


def num(v):
    """float64 → NUMERIC 열 파라미터. float8 로 바인딩하면 PostgreSQL 서버의 float8→numeric 변환이 15 유효숫자로 반올림해
    왕복이 깨진다(드라이버 문제가 아님). 최단 왕복 십진 표기(repr, 최대 17 유효숫자)를 Decimal 로 바인딩하면 NUMERIC → float64 가
    비트 동일하다. Java 는 BigDecimal.valueOf(x), Spark JDBC 도 double 바인딩을 피해야 한다(publication-qa 3.1절 9항)."""
    return None if v is None else Decimal(repr(float(v)))


def run(payload: dict, *, url: str | None = None, keep_schema: bool = False) -> dict:
    schema = f"gold_rt_{secrets.token_hex(4)}"
    rep = Report()
    started = datetime.now(timezone.utc)
    # 0) 공개 전 QA (publication-qa.md 2절). 하나라도 실패하면 PUBLISH_REJECTED: DB 에 넣지 않는다.
    pre_checks = qa.validate_payload(payload)
    for c in pre_checks:
        rep.add("qa:" + c["check"], c["ok"], c["detail"])
    if qa.failed(pre_checks):
        rep.add("publish_decision", False, "PUBLISH_REJECTED - payload QA 실패, 적재하지 않음")
        return {"schema": None, "kept": False, "started_at": started.isoformat(timespec="seconds"), "postgresql": None,
                "migrations": [m.name for m in MIGRATIONS], "checks": rep.checks, "n_failed": len(rep.failed), "decision": "PUBLISH_REJECTED"}
    conn = connect(url)
    try:
        t0 = time.time()
        apply_migrations(conn, schema)
        rep.add("migrations_applied", True, f"{len(MIGRATIONS)} files -> schema {schema} ({time.time()-t0:.1f}s)")
        with conn.cursor(binary=True) as cur:
            cur.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
            star, bundle, seg, pg, cands = payload["star"], payload["bundle"], payload["segments"][0], payload["periodogram"], payload["candidates"]

            cur.execute("INSERT INTO stars(tic_id, teff_k, radius_rsun, tmag, confirmed_count, service_status) VALUES (%s,%s,%s,%s,%s,%s)",
                        (star["tic_id"], star["teff_k"], star["radius_rsun"], star["tmag"], star["confirmed_count"], star["service_status"]))

            # 1) 세그먼트 (판에 묶이지 않음). flux 는 정규화된 float32 값, NULL 은 SQL NULL.
            flux_norm = normalize_array(seg["flux"])
            cur.execute("INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, flux_scatter, gaps)"
                        " VALUES (%s,%s,%s,%s,%s,%s,%s::real[],%s,%s) RETURNING id",
                        (seg["tic_id"], seg["sector"], seg["binning_revision"], seg["start_btjd"], seg["bin_minutes"], seg["n_points"],
                         flux_norm, num(seg["flux_scatter"]), Jsonb(seg["gaps"])))
            segment_id = cur.fetchone()[0]

            # 2) 판(staging) — manifest 의 segment_ids·array_checksums 를 DB id 로 채운다
            manifest = json.loads(json.dumps(bundle["manifest"]))
            manifest["segment_ids"] = [segment_id]
            flux_ck = array_checksum(flux_norm)
            manifest["array_checksums"] = {f"segment:{segment_id}:flux": flux_ck}
            semantic = {"input_snapshot_ids": manifest["input_snapshot_ids"],
                        "segments": [{"tic_id": seg["tic_id"], "sector": seg["sector"], "binning_revision": seg["binning_revision"]}],
                        "calculation_versions": manifest["calculation_versions"]}
            bv = bundle_version(semantic)
            rep.add("bundle_version_matches_69_rule", bv == bundle["bundle_version"], bv)
            cur.execute("INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
                        " VALUES (%s,%s,'staging',%s,%s,%s) RETURNING id",
                        (bundle["tic_id"], bv, Jsonb(manifest), bundle["fold_reference_time_btjd"], num(bundle["base_days"])))
            bundle_id = cur.fetchone()[0]

            # 3) 주기도 (판 단위). NULL 금지.
            power_norm = normalize_array(pg["power"], allow_null=False)
            cur.execute("INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power) VALUES (%s,%s,%s,%s,%s::real[])",
                        (bundle_id, num(pg["period_min_days"]), num(pg["period_max_days"]), pg["n_periods"], power_norm))
            manifest["array_checksums"][f"periodogram:{bundle_id}:power"] = array_checksum(power_norm)
            cur.execute("UPDATE publication_bundles SET manifest = %s WHERE id = %s", (Jsonb(manifest), bundle_id))

            # 4) 후보 — transit_model 은 계약 1.0 검사 뒤 DB id 로 candidate_id 를 채운다
            validator = Draft202012Validator(SCHEMA_JSON)
            cand_ids = []
            for c in cands:
                cur.execute("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd, duration_hours, depth_ppm,"
                            " bls_power, transit_model, discoverable, is_confirmed) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                            (bundle["tic_id"], c["status"], bundle_id, c["removal_step"], num(c["period_days"]), num(c["epoch_btjd"]), num(c["duration_hours"]),
                             num(c["depth_ppm"]), num(c["bls_power"]), Jsonb(c["transit_model"]), c["discoverable"], c["is_confirmed"]))
                cid = cur.fetchone()[0]
                tm = {**c["transit_model"], "candidate_id": f"c-{cid}"}
                errors = list(validator.iter_errors(tm))
                rep.add(f"transit_model_schema_{c['local_key']}", not errors, "; ".join(e.message for e in errors)[:200])
                cur.execute("UPDATE candidates SET transit_model = %s WHERE id = %s", (Jsonb(tm), cid))
                cand_ids.append(cid)
            # 4b) 외부 상태 행. 후보 자연 키(period, epoch) 로 candidate_id 를 찾는다.
            key_to_id = {(c["period_days"], c["epoch_btjd"]): cid for c, cid in zip(cands, cand_ids)}
            for e in payload.get("external_statuses", []):
                ck = e.get("candidate_key")
                cid = key_to_id.get((ck["period_days"], ck["epoch_btjd"])) if ck else None
                cur.execute("INSERT INTO external_signal_references(candidate_id, source, external_id, disposition, period_days, fetched_on, tic_id, epoch_btjd)"
                            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", (cid, e["source"], e["external_id"], e["disposition"], num(e["period_days"]), e["fetched_on"], bundle["tic_id"], num(e["epoch_btjd"])))

            # 5) 적재는 아직 commit 하지 않는다. 69: 적재 → 검증 → archived/current 전환을 **한 트랜잭션**에서, staging 독립 commit 없음.
            #    아래 읽기·검증은 같은 트랜잭션 안에서 자기 INSERT 를 보며 수행하고, 하나라도 실패하면 전부 rollback 한다.
            rep.add("staging_loaded_uncommitted", True, f"bundle_id={bundle_id} (검증 뒤 전환·commit)")

            # ---------------- 읽기 (바이너리 프로토콜, 같은 트랜잭션) ----------------
            cur.execute("SELECT fold_reference_time_btjd, base_days, manifest, status FROM publication_bundles WHERE id=%s", (bundle_id,))
            fold_db, base_db, manifest_db, status_db = cur.fetchone()
            rep.add("fold_reference_time_btjd_float64_exact", fold_db == bundle["fold_reference_time_btjd"], repr(fold_db))
            rep.add("base_days_numeric_roundtrip", float(base_db) == float(bundle["base_days"]), str(base_db))
            rep.add("status_staging_before_transition", status_db == "staging")
            rep.add("manifest_jsonb_roundtrip", manifest_db == manifest, "8 required keys + checksums")

            cur.execute("SELECT flux, n_points, gaps, start_btjd, flux_scatter FROM light_curve_segments WHERE id=%s", (segment_id,))
            flux_db, n_db, gaps_db, start_db, scatter_db = cur.fetchone()
            flux_db = _floats(flux_db)
            rep.add("flux_length_equals_n_points", len(flux_db) == n_db == seg["n_points"], f"{len(flux_db)}")
            rep.add("flux_null_positions_preserved", [v is None for v in flux_db] == [v is None for v in flux_norm])
            # NULL 해시값 0x7FC00000 은 NaN 비트와 같다. 조회한 배열에 NaN·±Inf 가 있으면 checksum 비교 전에 실패시킨다(3.1절 7항).
            rep.add("flux_db_values_finite_or_null", all(v is None or math.isfinite(v) for v in flux_db), "DB 에 NaN·Inf 가 저장돼 있으면 checksum 이 NULL 과 같아져 위장될 수 있음")
            rep.add("flux_float32_values_exact", flux_db == flux_norm, "REAL[] 왕복 후 float32 값 비트 동일(정규화 배열 기준)")
            rep.add("flux_checksum_recomputed_from_db", array_checksum(flux_db) == flux_ck, flux_ck[:23] + "...")
            rep.add("gaps_equal_null_runs_both_directions", gaps_db == qa.null_runs(flux_db) == seg["gaps"], f"gaps={gaps_db[:3]}... null_runs={qa.null_runs(flux_db)[:3]}...")
            rep.add("start_btjd_float64_exact", start_db == seg["start_btjd"])

            cur.execute("SELECT power, n_periods, period_min_days, period_max_days FROM periodograms WHERE bundle_id=%s", (bundle_id,))
            power_db, npg_db, pmin_db, pmax_db = cur.fetchone()
            power_db = _floats(power_db)
            rep.add("power_length_equals_n_periods", len(power_db) == npg_db == pg["n_periods"])
            rep.add("power_db_values_finite", all(v is not None and math.isfinite(v) for v in power_db))
            rep.add("power_no_null_in_db", all(v is not None for v in power_db))
            rep.add("power_float32_values_exact", power_db == power_norm)
            rep.add("power_checksum_recomputed_from_db", array_checksum(power_db) == manifest["array_checksums"][f"periodogram:{bundle_id}:power"])
            rep.add("period_grid_numeric_roundtrip", float(pmin_db) == pg["period_min_days"] and float(pmax_db) == pg["period_max_days"])

            cur.execute("SELECT id, transit_model, removal_step FROM candidates WHERE updated_bundle_id=%s ORDER BY removal_step", (bundle_id,))
            rows = cur.fetchall()
            rep.add("candidates_count", len(rows) == len(cands))
            rep.add("transit_model_candidate_id_matches_db_id", all(r[1]["candidate_id"] == f"c-{r[0]}" for r in rows))
            rep.add("transit_model_jsonb_numeric_roundtrip",
                    all(r[1]["parameters"] == cands[i]["transit_model"]["parameters"] for i, r in enumerate(rows)), "JSONB 숫자 보존")
            # 레코드 checksum 을 DB 행에서 재계산 (DB id 제외 규칙은 canonical.RECORD_RULES)
            cur.execute("SELECT status, removal_step, period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed"
                        " FROM candidates WHERE updated_bundle_id=%s", (bundle_id,))
            db_cands = [{"status": r[0], "removal_step": int(r[1]), "period_days": float(r[2]), "epoch_btjd": float(r[3]), "duration_hours": float(r[4]),
                         "depth_ppm": float(r[5]), "bls_power": float(r[6]), "transit_model": r[7], "discoverable": r[8], "is_confirmed": r[9]} for r in cur.fetchall()]
            rep.add("numeric_columns_float64_roundtrip", all(d["period_days"] == c["period_days"] and d["epoch_btjd"] == c["epoch_btjd"] and d["depth_ppm"] == c["depth_ppm"]
                                                              for d, c in zip(sorted(db_cands, key=lambda x: x["removal_step"]), cands)),
                    "NUMERIC 열에 최단 왕복 표기(Decimal(repr)) 로 넣으면 float64 비트 동일")
            rep.add("candidates_checksum_recomputed_from_db", record_checksum("candidates", db_cands) == manifest["record_checksums"]["candidates"])
            cur.execute("SELECT e.source, e.external_id, e.disposition, e.period_days, e.fetched_on, e.epoch_btjd, c.period_days, c.epoch_btjd"
                        " FROM external_signal_references e LEFT JOIN candidates c ON c.id = e.candidate_id WHERE e.tic_id=%s", (bundle["tic_id"],))
            db_ext = [{"source": r[0], "external_id": r[1], "disposition": r[2], "period_days": (float(r[3]) if r[3] is not None else None),
                       "fetched_on": r[4].isoformat(), "epoch_btjd": (float(r[5]) if r[5] is not None else None),
                       "candidate_key": ({"period_days": float(r[6]), "epoch_btjd": float(r[7])} if r[6] is not None else None)} for r in cur.fetchall()]
            rep.add("external_statuses_checksum_recomputed_from_db", record_checksum("external_statuses", db_ext) == manifest["record_checksums"]["external_statuses"],
                    f"{len(db_ext)} rows")

            # ---------------- 계약 위반 시도 (각각 savepoint 안에서) ----------------
            def expect_error(name, statement, params, needle):
                cur.execute("SAVEPOINT sp")
                try:
                    cur.execute(statement, params); ok = False; detail = "no error"
                except psycopg.Error as e:
                    ok = needle in str(e); detail = type(e).__name__
                cur.execute("ROLLBACK TO SAVEPOINT sp")
                rep.add(name, ok, detail)

            expect_error("duplicate_tic_bundle_version_rejected_V8",
                         "INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days) VALUES (%s,%s,'staging',%s,%s,%s)",
                         (bundle["tic_id"], bv, Jsonb(manifest), fold_db, base_db), "uq_publication_bundles_tic_bundle_version")
            bad_manifest = {k: v for k, v in manifest.items() if k != "period_grid"}
            expect_error("manifest_missing_key_rejected_V3",
                         "INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days) VALUES (%s,%s,'staging',%s,%s,%s)",
                         (bundle["tic_id"], bv + "-y", Jsonb(bad_manifest), fold_db, base_db), "ck_publication_bundles_manifest_shape")
            expect_error("flux_length_mismatch_rejected_V1_check",
                         "INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, gaps) VALUES (%s,99,'x',1.0,10,3,%s::real[],'[]')",
                         (seg["tic_id"], [1.0, 1.0]), "light_curve_segments")
            expect_error("periodogram_bad_range_rejected",
                         "INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power) VALUES (%s, 5, 1, 1, %s::real[])",
                         (bundle_id, [1.0]), "periodograms")

            # ---------------- 역할 경계 (V2) ----------------
            cur.execute("SAVEPOINT roles")
            cur.execute("SET ROLE planetory_app")
            try:
                cur.execute("UPDATE candidates SET discoverable = false WHERE id=%s", (cand_ids[0],)); app_blocked = False
            except psycopg.errors.InsufficientPrivilege:
                app_blocked = True
            cur.execute("ROLLBACK TO SAVEPOINT roles"); cur.execute("RESET ROLE")
            rep.add("planetory_app_cannot_write_gold", app_blocked)
            cur.execute("SAVEPOINT roles2")
            cur.execute("SET ROLE planetory_gold_writer")
            try:
                cur.execute("UPDATE candidates SET discoverable = discoverable WHERE id=%s", (cand_ids[0],)); writer_ok = True
            except psycopg.errors.InsufficientPrivilege:
                writer_ok = False
            cur.execute("ROLLBACK TO SAVEPOINT roles2"); cur.execute("RESET ROLE")
            rep.add("planetory_gold_writer_can_write_gold", writer_ok)

            # ---------------- 결정: 모든 검사 통과 → 전환 + 단일 commit, 아니면 rollback ----------------
            if rep.failed:
                conn.rollback()
                rep.add("publish_decision", False, f"PUBLISH_REJECTED - {len(rep.failed)}건 실패, 트랜잭션 rollback(staging 도 남지 않음)")
            else:
                # 69: 부분 유일 인덱스 때문에 기존 current 를 먼저 archived 로 바꾸고 신규를 current 로 올린다.
                cur.execute("UPDATE publication_bundles SET status='archived' WHERE tic_id=%s AND status='current'", (bundle["tic_id"],))
                cur.execute("UPDATE publication_bundles SET status='current', published_at=now() WHERE id=%s", (bundle_id,))
                cur.execute("SELECT status FROM publication_bundles WHERE id=%s", (bundle_id,))
                status_after = cur.fetchone()[0]
                conn.commit()
                rep.add("current_transition_committed_after_checks", status_after == "current", f"bundle_id={bundle_id}, 단일 commit")
                cur.execute("SELECT count(*) FROM publication_bundles WHERE tic_id=%s AND status='current'", (bundle["tic_id"],))
                rep.add("exactly_one_current_after_commit", cur.fetchone()[0] == 1)
                # current 가 생긴 뒤에만 의미 있는 검사: 같은 TIC 의 두 번째 current 는 부분 유일 인덱스가 거절한다.
                expect_error("second_current_rejected_partial_unique_index",
                             "INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days) VALUES (%s,%s,'current',%s,%s,%s)",
                             (bundle["tic_id"], bv + "-x", Jsonb(manifest), fold_db, base_db), "uq_publication_bundles_current")
                conn.commit()
    finally:
        conn.rollback()                                   # 중단된 트랜잭션이면 DROP 이 InFailedSqlTransaction 으로 실패하므로 먼저 되돌린다
        if not keep_schema:
            with conn.cursor() as cur:
                cur.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema)))
            conn.commit()
        conn.close()
    with connect(url) as c2, c2.cursor() as cur:
        cur.execute("SELECT version()"); pg_version = cur.fetchone()[0]
    return {"schema": schema, "kept": keep_schema, "started_at": started.isoformat(timespec="seconds"), "postgresql": pg_version,
            "migrations": [m.name for m in MIGRATIONS], "checks": rep.checks, "n_failed": len(rep.failed),
            "decision": "PUBLISHED" if not rep.failed else "PUBLISH_REJECTED"}

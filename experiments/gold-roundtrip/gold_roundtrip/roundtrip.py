"""독립 PostgreSQL round-trip: 격리 스키마에 V1~V8 을 적용하고 payload 를 적재한 뒤 다시 읽어 계약대로 보존됐는지 검사한다.

접속: 환경변수 DATABASE_URL (기본 postgresql://planetory:ssafy@127.0.0.1:15432/planetory_poc — 개발 셋업 문서의 로컬 Compose 기본값.
      `localhost` 를 쓰면 Windows 에서 IPv6 ::1 을 먼저 시도해 접속당 약 2분 지연된다).
스키마: gold_rt_<hex> 를 만들고 search_path 를 그 스키마로 둔 채 마이그레이션 SQL 파일을 그대로 실행한다(Flyway 없이).
        V1 의 `CREATE EXTENSION pg_trgm WITH SCHEMA public` 은 컨테이너 소유 계정이라 통과한다.
검사(check)는 하나씩 결과를 기록하고 마지막에 요약한다. 실패해도 계속 진행해 보고서에 남긴다.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from jsonschema import Draft202012Validator
from psycopg import sql
from psycopg.types.json import Jsonb

from .canonical import array_checksum, bundle_version, normalize_array

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


def run(payload: dict, *, url: str | None = None, keep_schema: bool = False) -> dict:
    schema = f"gold_rt_{secrets.token_hex(4)}"
    rep = Report()
    started = datetime.now(timezone.utc)
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
                         flux_norm, seg["flux_scatter"], Jsonb(seg["gaps"])))
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
                        (bundle["tic_id"], bv, Jsonb(manifest), bundle["fold_reference_time_btjd"], bundle["base_days"]))
            bundle_id = cur.fetchone()[0]

            # 3) 주기도 (판 단위)
            power_norm = normalize_array(pg["power"])
            cur.execute("INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power) VALUES (%s,%s,%s,%s,%s::real[])",
                        (bundle_id, pg["period_min_days"], pg["period_max_days"], pg["n_periods"], power_norm))
            manifest["array_checksums"][f"periodogram:{bundle_id}:power"] = array_checksum(power_norm)
            cur.execute("UPDATE publication_bundles SET manifest = %s WHERE id = %s", (Jsonb(manifest), bundle_id))

            # 4) 후보 — transit_model 은 계약 1.0 검사 뒤 DB id 로 candidate_id 를 채운다
            validator = Draft202012Validator(SCHEMA_JSON)
            cand_ids = []
            for c in cands:
                cur.execute("INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd, duration_hours, depth_ppm,"
                            " bls_power, transit_model, discoverable, is_confirmed) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                            (bundle["tic_id"], c["status"], bundle_id, c["removal_step"], c["period_days"], c["epoch_btjd"], c["duration_hours"],
                             c["depth_ppm"], c["bls_power"], Jsonb(c["transit_model"]), c["discoverable"], c["is_confirmed"]))
                cid = cur.fetchone()[0]
                tm = {**c["transit_model"], "candidate_id": f"c-{cid}"}
                errors = list(validator.iter_errors(tm))
                rep.add(f"transit_model_schema_{c['local_key']}", not errors, "; ".join(e.message for e in errors)[:200])
                cur.execute("UPDATE candidates SET transit_model = %s WHERE id = %s", (Jsonb(tm), cid))
                cand_ids.append(cid)

            # 5) current 전환 (기존 current 없음 → 바로 전환). 순서 규칙은 69: 기존 current 를 먼저 archived 로.
            cur.execute("UPDATE publication_bundles SET status='archived' WHERE tic_id=%s AND status='current'", (bundle["tic_id"],))
            cur.execute("UPDATE publication_bundles SET status='current', published_at=now() WHERE id=%s", (bundle_id,))
            conn.commit()
            rep.add("staging_to_current_committed", True, f"bundle_id={bundle_id}")

            # ---------------- 읽기 (바이너리 프로토콜) ----------------
            cur.execute("SELECT fold_reference_time_btjd, base_days, manifest, status FROM publication_bundles WHERE id=%s", (bundle_id,))
            fold_db, base_db, manifest_db, status_db = cur.fetchone()
            rep.add("fold_reference_time_btjd_float64_exact", fold_db == bundle["fold_reference_time_btjd"], repr(fold_db))
            rep.add("base_days_numeric_roundtrip", float(base_db) == float(bundle["base_days"]), str(base_db))
            rep.add("status_current", status_db == "current")
            rep.add("manifest_jsonb_roundtrip", manifest_db == manifest, "8 required keys + checksums")

            cur.execute("SELECT flux, n_points, gaps, start_btjd, flux_scatter FROM light_curve_segments WHERE id=%s", (segment_id,))
            flux_db, n_db, gaps_db, start_db, scatter_db = cur.fetchone()
            flux_db = _floats(flux_db)
            rep.add("flux_length_equals_n_points", len(flux_db) == n_db == seg["n_points"], f"{len(flux_db)}")
            rep.add("flux_null_positions_preserved", [v is None for v in flux_db] == [v is None for v in flux_norm])
            rep.add("flux_float32_values_exact", flux_db == flux_norm, "REAL[] 왕복 후 float32 값 비트 동일(정규화 배열 기준)")
            rep.add("flux_checksum_recomputed_from_db", array_checksum(flux_db) == flux_ck, flux_ck[:23] + "...")
            rep.add("gaps_match_null_runs", gaps_db == seg["gaps"] and all(all(flux_db[i] is None for i in range(a, b + 1)) for a, b in gaps_db))
            rep.add("start_btjd_float64_exact", start_db == seg["start_btjd"])

            cur.execute("SELECT power, n_periods, period_min_days, period_max_days FROM periodograms WHERE bundle_id=%s", (bundle_id,))
            power_db, npg_db, pmin_db, pmax_db = cur.fetchone()
            power_db = _floats(power_db)
            rep.add("power_length_equals_n_periods", len(power_db) == npg_db == pg["n_periods"])
            rep.add("power_float32_values_exact", power_db == power_norm)
            rep.add("power_checksum_recomputed_from_db", array_checksum(power_db) == manifest["array_checksums"][f"periodogram:{bundle_id}:power"])
            rep.add("period_grid_numeric_roundtrip", float(pmin_db) == pg["period_min_days"] and float(pmax_db) == pg["period_max_days"])

            cur.execute("SELECT id, transit_model, removal_step FROM candidates WHERE updated_bundle_id=%s ORDER BY removal_step", (bundle_id,))
            rows = cur.fetchall()
            rep.add("candidates_count", len(rows) == len(cands))
            rep.add("transit_model_candidate_id_matches_db_id", all(r[1]["candidate_id"] == f"c-{r[0]}" for r in rows))
            rep.add("transit_model_jsonb_numeric_roundtrip",
                    all(r[1]["parameters"] == cands[i]["transit_model"]["parameters"] for i, r in enumerate(rows)), "JSONB 숫자 보존")

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
            expect_error("second_current_rejected_partial_unique_index",
                         "INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days) VALUES (%s,%s,'current',%s,%s,%s)",
                         (bundle["tic_id"], bv + "-x", Jsonb(manifest), fold_db, base_db), "uq_publication_bundles_current")
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
            conn.commit()
    finally:
        if not keep_schema:
            with conn.cursor() as cur:
                cur.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(sql.Identifier(schema)))
            conn.commit()
        conn.close()
    with connect(url) as c2, c2.cursor() as cur:
        cur.execute("SELECT version()"); pg_version = cur.fetchone()[0]
    return {"schema": schema, "kept": keep_schema, "started_at": started.isoformat(timespec="seconds"), "postgresql": pg_version,
            "migrations": [m.name for m in MIGRATIONS], "checks": rep.checks, "n_failed": len(rep.failed)}

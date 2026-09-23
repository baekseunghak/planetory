"""로컬 PostgreSQL 적재.

Gold 는 Publisher 계약과 같은 순서로 넣는다(contracts/gold/README.md 5·6절, publication-qa.md 2절).
별마다 한 트랜잭션에서 `pg_advisory_xact_lock(tic_id)` → staging 적재 → 같은 트랜잭션 안의 조회 검사 →
기존 current 를 archived 로 바꾼 뒤 새 판을 current 로 올리고 한 번 commit 한다. 가능하면
`planetory_gold_writer` 역할로 넣어 Publisher 권한 밖의 테이블을 건드리지 않았음을 DB 가 확인하게 한다.

같은 (tic_id, bundle_version) 이 이미 current 이고 내용 요약이 같으면 건너뛴다(ALREADY_PUBLISHED). 내용이
다르면 IDEMPOTENCY_CONFLICT 로 멈춘다. 시드 규칙이 바뀌어 bundle_version 이 달라지면 새 판을 게시하고 이전
판의 후보는 retired 로 바꾼다(실제 Publisher 의 후보 동일성 판단은 하지 않는다).

튜토리얼·챌린지 설정은 운영자가 SQL 로 넣는 데이터라 Gold 트랜잭션과 분리해 연결 계정으로 넣는다.
이미 다른 별로 설정돼 있으면 바꾸지 않고 알린다.
"""
from __future__ import annotations

import datetime as dt
import ipaddress
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

from .canonical import array_checksum, normalize_array, record_checksum

REQUIRED_TABLES = ("stars", "observation_datasets", "publication_bundles", "light_curve_segments", "periodograms",
                   "candidates", "candidate_dispositions", "external_signal_references", "ai_executions",
                   "ai_evaluations", "candidate_status_history", "tutorial_stars", "challenge_rounds",
                   "operation_settings")
DISPOSITION_RULE_VERSION = "rule-0"
CHALLENGE_DAYS = 28
MIGRATIONS = Path(__file__).resolve().parents[4] / "apps" / "backend" / "src" / "main" / "resources" / "db" / "migration"


def repository_migration_version() -> int:
    return max(int(re.match(r"V(\d+)__", p.name).group(1)) for p in MIGRATIONS.glob("V*__*.sql"))


class SeedError(RuntimeError):
    """적재를 멈춰야 하는 상태. code 는 Publisher 계약의 결과 코드를 따른다."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


@dataclass
class StarResult:
    tic_id: int
    label: str
    code: str                      # PUBLISHED | ALREADY_PUBLISHED | BUNDLE_SUPERSEDED
    bundle_id: int
    archived_bundle_ids: list[int] = field(default_factory=list)
    retired_candidate_ids: list[int] = field(default_factory=list)


def num(value) -> Decimal | None:
    """float64 를 NUMERIC 열에 넣을 때 최단 왕복 표기로 바인딩한다(publication-qa.md 3.1절 9항)."""
    return None if value is None else Decimal(repr(float(value)))


def is_local_endpoint(host: str, hostaddr: str) -> bool:
    """연결된 곳이 이 PC 인지 본다.

    URL 문자열로 판정하지 않는다. libpq 는 hostaddr·service 파일·PGHOST 환경변수 때문에 URL 의 host 와 다른
    곳에 붙을 수 있다. 그래서 연결이 성립한 뒤의 값을 받는다. TCP 연결이면 실제로 붙은 숫자 주소(hostaddr)가
    루프백이어야 하고, 주소가 없으면 Unix 소켓 경로여야 한다.
    """
    if hostaddr:
        try:
            address = ipaddress.ip_address(hostaddr)
        except ValueError:
            return False
        return (getattr(address, "ipv4_mapped", None) or address).is_loopback
    return host.startswith(("/", "@"))


def connect(url: str, schema: str, *, allow_non_local: bool = False) -> psycopg.Connection:
    """연결한 뒤 실제 접속 주소가 이 PC 가 아니면 아무것도 읽거나 쓰기 전에 닫는다."""
    conn = psycopg.connect(url, autocommit=True)
    endpoint = conn.info.hostaddr or conn.info.host
    if not allow_non_local and not is_local_endpoint(conn.info.host, conn.info.hostaddr):
        conn.close()
        raise SeedError("NOT_LOCAL", f"실제 접속 주소 {endpoint}:{conn.info.port} 가 이 PC 가 아니다. 공유·운영 DB 에는 "
                                     "적재하지 않는다(정말 필요하면 --allow-non-local)")
    conn.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(schema)))
    return conn


def notify_targets(results: list[StarResult]) -> list[int]:
    """판 전환 후처리를 알릴 판. 이번에 게시한 판뿐 아니라 이미 current 인 판도 넣는다.

    후처리는 같은 판에 여러 번 와도 결과가 같다(탐사 API 10장). 앞선 실행에서 알림이 실패했어도 같은 명령을 다시
    실행하면 복구된다. 교체된 판(BUNDLE_SUPERSEDED)에는 알리지 않는다(Gold 계약 6절).
    """
    return [r.bundle_id for r in results if r.code in ("PUBLISHED", "ALREADY_PUBLISHED")]


@dataclass
class Target:
    schema: str
    flyway_version: int | None
    use_writer_role: bool
    warnings: list[str] = field(default_factory=list)


def preflight(conn: psycopg.Connection, schema: str, *, require_flyway: bool) -> Target:
    """시드를 넣을 DB 가 이 저장소의 마이그레이션까지 올라와 있는지 본다.

    뒤처진 DB 에 먼저 넣으면 이후 마이그레이션이 데이터 위에서 돌아 멈출 수 있다(V4·V7·V9 처럼 기존 행을
    거절하는 방식). 그래서 백엔드를 먼저 띄워 Flyway 를 끝낸 DB 에만 넣는다.
    """
    missing = [t for t in REQUIRED_TABLES
               if conn.execute("SELECT to_regclass(%s)", (f"{schema}.{t}",)).fetchone()[0] is None]
    if missing:
        raise SeedError("SCHEMA_MISSING", f"{schema} 스키마에 테이블이 없다: {', '.join(missing)}. "
                                          "백엔드를 한 번 실행해 Flyway 마이그레이션을 적용한다")
    version, warnings = None, []
    if conn.execute("SELECT to_regclass(%s)", (f"{schema}.flyway_schema_history",)).fetchone()[0] is not None:
        history = sql.Identifier(schema, "flyway_schema_history")
        failed = conn.execute(sql.SQL("SELECT count(*) FROM {} WHERE NOT success").format(history)).fetchone()[0]
        if failed:
            raise SeedError("MIGRATION_FAILED", f"실패한 마이그레이션 {failed}건이 기록돼 있다")
        version = conn.execute(sql.SQL("SELECT max(version::int) FROM {} WHERE version IS NOT NULL")
                               .format(history)).fetchone()[0]
    elif require_flyway:
        raise SeedError("SCHEMA_MISSING", "flyway_schema_history 가 없다. 백엔드 Flyway 가 만든 DB 에만 적재한다")
    if require_flyway:
        latest = repository_migration_version()
        if version is None or version < latest:
            raise SeedError("MIGRATION_BEHIND", f"DB 마이그레이션이 V{version}이고 저장소 최신은 V{latest}다. "
                                                "이 저장소의 백엔드를 한 번 띄워 마이그레이션을 끝낸 뒤 다시 실행한다")
        if version > latest:
            warnings.append(f"DB 마이그레이션 V{version}이 이 저장소 최신 V{latest}보다 앞선다. 다른 브랜치의 "
                            "마이그레이션이 적용된 DB 일 수 있다")
    if not conn.execute("SELECT EXISTS(SELECT 1 FROM operation_settings)").fetchone()[0]:
        raise SeedError("SCHEMA_MISSING", "operation_settings 에 규칙이 없다(V9 의 rule-0 이 필요하다)")
    # 역할이 없으면 pg_has_role 이 오류를 내므로 CASE 로 먼저 거른다(AND 는 평가 순서를 보장하지 않는다).
    use_writer = conn.execute("""
        SELECT CASE WHEN r.rolsuper THEN true
                    WHEN NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'planetory_gold_writer') THEN false
                    ELSE pg_has_role(current_user, 'planetory_gold_writer', 'MEMBER') END
          FROM pg_roles r WHERE r.rolname = current_user""").fetchone()[0]
    return Target(schema=schema, flyway_version=version, use_writer_role=bool(use_writer), warnings=warnings)


def _read_segment_checksum(cur, segment_id: int) -> str:
    flux = cur.execute("SELECT flux FROM light_curve_segments WHERE id = %s", (segment_id,)).fetchone()[0]
    return array_checksum(normalize_array(flux))


def publish_star(conn: psycopg.Connection, payload: dict, target: Target) -> StarResult:
    tic = payload["tic_id"]
    bundle = payload["bundle"]
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (tic,))
        if target.use_writer_role:
            cur.execute("SET LOCAL ROLE planetory_gold_writer")
        row = cur.execute("""
            SELECT id, status, manifest -> 'local_seed' ->> 'payload_digest'
              FROM publication_bundles WHERE tic_id = %s AND bundle_version = %s""",
                          (tic, bundle["bundle_version"])).fetchone()
        if row:
            bundle_id, status, digest = row
            if digest != bundle["payload_digest"]:
                raise SeedError("IDEMPOTENCY_CONFLICT",
                                f"TIC {tic} 판 {bundle['bundle_version'][:16]}…의 내용이 이번 계산과 다르다. "
                                "로컬 DB 를 초기화한 뒤 다시 적재한다")
            if status == "current":
                return StarResult(tic, payload["label"], "ALREADY_PUBLISHED", bundle_id)
            if status == "archived":
                return StarResult(tic, payload["label"], "BUNDLE_SUPERSEDED", bundle_id)
            raise SeedError("PUBLISH_REJECTED", f"TIC {tic} 에 commit 된 staging 판 {bundle_id} 이 있다")

        star = payload["star"]
        cur.execute("""
            INSERT INTO stars(tic_id, teff_k, radius_rsun, tmag, confirmed_count, service_status)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (tic_id) DO UPDATE SET teff_k = EXCLUDED.teff_k, radius_rsun = EXCLUDED.radius_rsun,
                tmag = EXCLUDED.tmag, confirmed_count = EXCLUDED.confirmed_count,
                service_status = EXCLUDED.service_status""",
                    (tic, num(star["teff_k"]), num(star["radius_rsun"]), num(star["tmag"]),
                     star["confirmed_count"], star["service_status"]))

        segment_ids, array_checksums = [], {}
        for seg in payload["segments"]:
            obs = seg["observation"]
            cur.execute("""
                INSERT INTO observation_datasets(tic_id, sector, start_btjd, end_btjd, cadence, source_version,
                                                 time_system)
                VALUES (%s, %s, %s, %s, %s, %s, 'BTJD')
                ON CONFLICT (tic_id, sector, source_version) DO NOTHING""",
                        (tic, seg["sector"], num(obs["start_btjd"]), num(obs["end_btjd"]), obs["cadence"],
                         obs["source_version"]))
            existing = cur.execute("""
                SELECT id FROM light_curve_segments WHERE tic_id = %s AND sector = %s AND binning_revision = %s""",
                                   (tic, seg["sector"], seg["binning_revision"])).fetchone()
            if existing:
                # 세그먼트는 판에 묶이지 않는 불변 행이다. 같은 자연 키면 내용도 같아야 다시 쓴다.
                if _read_segment_checksum(cur, existing[0]) != seg["checksum"]:
                    raise SeedError("IDEMPOTENCY_CONFLICT",
                                    f"TIC {tic} 섹터 {seg['sector']} 세그먼트 내용이 다르다. 로컬 DB 를 초기화한다")
                segment_id = existing[0]
            else:
                segment_id = cur.execute("""
                    INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd, bin_minutes,
                                                     n_points, flux, flux_scatter, gaps)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::real[], %s, %s) RETURNING id""",
                                         (tic, seg["sector"], seg["binning_revision"], seg["start_btjd"],
                                          seg["bin_minutes"], seg["n_points"], seg["flux"],
                                          num(seg["flux_scatter"]), Jsonb(seg["gaps"]))).fetchone()[0]
            segment_ids.append(segment_id)
            array_checksums[f"segment:{segment_id}:flux"] = seg["checksum"]

        manifest = {**bundle["manifest"], "segment_ids": segment_ids, "array_checksums": array_checksums}
        bundle_id = cur.execute("""
            INSERT INTO publication_bundles(tic_id, bundle_version, status, manifest, fold_reference_time_btjd,
                                            base_days)
            VALUES (%s, %s, 'staging', %s, %s, %s) RETURNING id""",
                                (tic, bundle["bundle_version"], Jsonb(manifest), bundle["fold_reference_time_btjd"],
                                 num(bundle["base_days"]))).fetchone()[0]
        pg = payload["periodogram"]
        cur.execute("""
            INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power)
            VALUES (%s, %s, %s, %s, %s::real[])""",
                    (bundle_id, num(pg["period_min_days"]), num(pg["period_max_days"]), pg["n_periods"], pg["power"]))
        manifest["array_checksums"][f"periodogram:{bundle_id}:power"] = pg["checksum"]
        cur.execute("UPDATE publication_bundles SET manifest = %s WHERE id = %s", (Jsonb(manifest), bundle_id))

        retired = [r[0] for r in cur.execute(
            "UPDATE candidates SET status = 'retired' WHERE tic_id = %s AND status = 'active' RETURNING id",
            (tic,)).fetchall()]
        for candidate_id in retired:
            cur.execute("""
                INSERT INTO candidate_status_history(candidate_id, bundle_id, field, old_value, new_value, changed_at,
                                                     rule_version, reason)
                VALUES (%s, %s, 'status', 'active', 'retired', now(), %s, 'local-seed 규칙 변경으로 새 판 게시')""",
                        (candidate_id, bundle_id, DISPOSITION_RULE_VERSION))

        execution_id = None
        for candidate in payload["candidates"]:
            rec = candidate["record"]
            candidate_id = cur.execute("""
                INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd,
                                       duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                                       (tic, rec["status"], bundle_id, rec["removal_step"], num(rec["period_days"]),
                                        num(rec["epoch_btjd"]), num(rec["duration_hours"]), num(rec["depth_ppm"]),
                                        num(rec["bls_power"]), Jsonb(rec["transit_model"]), rec["discoverable"],
                                        rec["is_confirmed"])).fetchone()[0]
            cur.execute("UPDATE candidates SET transit_model = %s WHERE id = %s",
                        (Jsonb({**rec["transit_model"], "candidate_id": f"c-{candidate_id}"}), candidate_id))
            d = candidate["disposition"]
            cur.execute("""
                INSERT INTO candidate_dispositions(candidate_id, disposition, answer_class, planet_truth, rule_version,
                                                   applied_at, source_refs)
                VALUES (%s, %s, %s, %s, %s, now(), %s)""",
                        (candidate_id, d["disposition"], d["answer_class"], d["planet_truth"],
                         DISPOSITION_RULE_VERSION, Jsonb(d["source_refs"])))
            if candidate["external"]:
                e = candidate["external"]
                cur.execute("""
                    INSERT INTO external_signal_references(candidate_id, source, external_id, disposition, period_days,
                                                           fetched_on, tic_id, epoch_btjd)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                            (candidate_id, e["source"], e["external_id"], e["disposition"], num(e["period_days"]),
                             dt.date.fromisoformat(e["fetched_on"]), tic, num(e["epoch_btjd"])))
            if candidate["ai"]:
                a = candidate["ai"]
                if execution_id is None:
                    execution_id = cur.execute("""
                        INSERT INTO ai_executions(model_version, checkpoint, status, started_at, error, duration_ms)
                        VALUES (%s, NULL, %s, now(), NULL, 0) RETURNING id""",
                                               (a["model_version"], a["status"])).fetchone()[0]
                cur.execute("""
                    INSERT INTO ai_evaluations(candidate_id, execution_id, score, verdict, threshold_version,
                                               raw_output)
                    VALUES (%s, %s, %s, %s, %s, %s)""",
                            (candidate_id, execution_id, num(a["score"]), a["verdict"], a["threshold_version"],
                             Jsonb({"synthetic": True})))

        _verify_staging(cur, payload, bundle_id, manifest)

        archived = [r[0] for r in cur.execute(
            "UPDATE publication_bundles SET status = 'archived' WHERE tic_id = %s AND status = 'current' RETURNING id",
            (tic,)).fetchall()]
        if archived:
            # archived 판의 주기도는 지우고 제출이 참조하는 판 행은 남긴다(ERD publication_bundles).
            cur.execute("DELETE FROM periodograms WHERE bundle_id = ANY(%s)", (archived,))
        cur.execute("UPDATE publication_bundles SET status = 'current', published_at = now() WHERE id = %s",
                    (bundle_id,))
        currents = cur.execute("SELECT count(*) FROM publication_bundles WHERE tic_id = %s AND status = 'current'",
                               (tic,)).fetchone()[0]
        if currents != 1:
            raise SeedError("PUBLISH_REJECTED", f"TIC {tic} current 판이 {currents}개다")
        return StarResult(tic, payload["label"], "PUBLISHED", bundle_id, archived, retired)


def _verify_staging(cur, payload: dict, bundle_id: int, manifest: dict) -> None:
    """적재한 행을 같은 트랜잭션에서 다시 읽어 계약대로 들어갔는지 본다. 실패하면 전부 rollback 된다."""
    tic = payload["tic_id"]
    problems = []
    for segment_id in manifest["segment_ids"]:
        flux, n_points, gaps = cur.execute(
            "SELECT flux, n_points, gaps FROM light_curve_segments WHERE id = %s", (segment_id,)).fetchone()
        flux = normalize_array(flux)
        if array_checksum(flux) != manifest["array_checksums"][f"segment:{segment_id}:flux"]:
            problems.append(f"segment {segment_id} flux checksum")
        runs, start = [], None
        for i, v in enumerate(flux + [0.0]):
            if v is None and start is None:
                start = i
            elif v is not None and start is not None:
                runs.append([start, i - 1])
                start = None
        if runs != gaps or len(flux) != n_points:
            problems.append(f"segment {segment_id} gaps/n_points")
    power = cur.execute("SELECT power FROM periodograms WHERE bundle_id = %s", (bundle_id,)).fetchone()[0]
    if array_checksum(normalize_array(power, allow_null=False)) != manifest["array_checksums"][
            f"periodogram:{bundle_id}:power"]:
        problems.append("periodogram power checksum")

    rows = cur.execute("""
        SELECT id, status, removal_step, period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,
               discoverable, is_confirmed
          FROM candidates WHERE updated_bundle_id = %s""", (bundle_id,)).fetchall()
    candidates = [{"status": r[1], "removal_step": int(r[2]), "period_days": float(r[3]), "epoch_btjd": float(r[4]),
                   "duration_hours": float(r[5]), "depth_ppm": float(r[6]), "bls_power": float(r[7]),
                   "transit_model": r[8], "discoverable": r[9], "is_confirmed": r[10]} for r in rows]
    if any(r[8].get("candidate_id") != f"c-{r[0]}" for r in rows):
        problems.append("transit_model.candidate_id")
    external = [{"source": r[0], "external_id": r[1], "disposition": r[2], "period_days": float(r[3]),
                 "epoch_btjd": float(r[4]), "fetched_on": r[5].isoformat(),
                 "candidate_key": {"period_days": float(r[6]), "epoch_btjd": float(r[7])}}
                for r in cur.execute("""
        SELECT e.source, e.external_id, e.disposition, e.period_days, e.epoch_btjd, e.fetched_on, c.period_days,
               c.epoch_btjd
          FROM external_signal_references e JOIN candidates c ON c.id = e.candidate_id
         WHERE c.updated_bundle_id = %s""", (bundle_id,)).fetchall()]
    ai = [{"candidate_key": {"period_days": float(r[0]), "epoch_btjd": float(r[1])}, "model_version": r[2],
           "status": r[3], "score": float(r[4]), "verdict": r[5], "threshold_version": r[6]}
          for r in cur.execute("""
        SELECT c.period_days, c.epoch_btjd, x.model_version, x.status, e.score, e.verdict, e.threshold_version
          FROM ai_evaluations e JOIN ai_executions x ON x.id = e.execution_id JOIN candidates c ON c.id = e.candidate_id
         WHERE c.updated_bundle_id = %s""", (bundle_id,)).fetchall()]
    for kind, rows_ in (("candidates", candidates), ("external_statuses", external), ("ai_results", ai)):
        if record_checksum(kind, rows_) != manifest["record_checksums"][kind]:
            problems.append(f"{kind} record checksum")
    dispositions = cur.execute("""
        SELECT count(*) FROM candidate_dispositions d JOIN candidates c ON c.id = d.candidate_id
         WHERE c.updated_bundle_id = %s""", (bundle_id,)).fetchone()[0]
    if dispositions != len(payload["candidates"]):
        problems.append("candidate_dispositions count")
    if problems:
        raise SeedError("PUBLISH_REJECTED", f"TIC {tic} 적재 검사 실패: {', '.join(problems)}")


@dataclass
class SettingResult:
    name: str
    code: str                      # SET | KEPT | CONFLICT
    detail: str = ""


def apply_settings(conn: psycopg.Connection, payloads: list[dict], today: dt.date) -> list[SettingResult]:
    """튜토리얼 1~5 와 진행 중 챌린지 회차. 운영자 데이터라 이미 다른 값이 있으면 바꾸지 않는다."""
    results: list[SettingResult] = []
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("LOCK TABLE tutorial_stars, challenge_rounds IN SHARE ROW EXCLUSIVE MODE")
        existing = {r[0]: r[1:] for r in cur.execute(
            "SELECT seq, tic_id, intent, active FROM tutorial_stars").fetchall()}
        for p in sorted((p for p in payloads if p["tutorial_seq"]), key=lambda p: p["tutorial_seq"]):
            seq, tic, intent = p["tutorial_seq"], p["tic_id"], p["tutorial_intent"]
            name = f"튜토리얼 {seq}"
            if seq not in existing:
                cur.execute("INSERT INTO tutorial_stars(seq, tic_id, intent, active) VALUES (%s, %s, %s, true)",
                            (seq, tic, intent))
                results.append(SettingResult(name, "SET", f"{p['label']} (TIC {tic}, {intent})"))
            elif existing[seq][:2] == (tic, intent):
                note = "" if existing[seq][2] else " - 비활성 상태라 가입해도 열리지 않는다"
                results.append(SettingResult(name, "KEPT", f"{p['label']} (TIC {tic}){note}"))
            else:
                results.append(SettingResult(name, "CONFLICT", f"이미 TIC {existing[seq][0]} ({existing[seq][1]}) 이라 "
                                                               "바꾸지 않았다"))
        (challenge,) = [p for p in payloads if p["role"] == "challenge"]
        active = cur.execute("SELECT id, round_no, target_tic_id FROM challenge_rounds WHERE status = 'active'"
                             ).fetchone()
        if active is None:
            round_no = cur.execute("SELECT COALESCE(max(round_no), 0) + 1 FROM challenge_rounds").fetchone()[0]
            cur.execute("""
                INSERT INTO challenge_rounds(round_no, starts_on, ends_on, target_tic_id, description, status)
                VALUES (%s, %s, %s, %s, %s, 'active')""",
                        (round_no, today, today + dt.timedelta(days=CHALLENGE_DAYS - 1), challenge["tic_id"],
                         f"로컬 통합 테스트용 합성 챌린지({challenge['label']})"))
            results.append(SettingResult("챌린지 회차", "SET",
                                         f"{round_no}회차 active, {challenge['label']} (TIC {challenge['tic_id']})"))
        elif active[2] == challenge["tic_id"]:
            results.append(SettingResult("챌린지 회차", "KEPT", f"{active[1]}회차 active, {challenge['label']}"))
        else:
            results.append(SettingResult("챌린지 회차", "CONFLICT",
                                         f"{active[1]}회차가 이미 TIC {active[2]} 로 진행 중이라 바꾸지 않았다"))
    return results


def notify_backend(base_url: str, token: str, bundle_ids: list[int]) -> list[tuple[int, bool, str]]:
    """커밋 뒤 판 전환 후처리를 부른다(탐사 API 10장). 실패해도 DB 전환은 되돌리지 않고 결과로 알린다."""
    outcomes = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 내부 호출은 시스템 프록시를 타지 않는다
    for bundle_id in bundle_ids:
        request = urllib.request.Request(f"{base_url.rstrip('/')}/internal/bundles/b-{bundle_id}/activated",
                                         method="POST", headers={"X-Planetory-Service-Token": token})
        try:
            with opener.open(request, timeout=15) as response:
                outcomes.append((bundle_id, 200 <= response.status < 300, f"HTTP {response.status}"))
        except urllib.error.HTTPError as e:
            outcomes.append((bundle_id, False, f"HTTP {e.code}"))
        except urllib.error.URLError as e:
            outcomes.append((bundle_id, False, f"연결 실패: {e.reason}"))
    return outcomes

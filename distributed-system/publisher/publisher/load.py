"""Gold 판 게시: 적재·조회 검사·current 전환을 한 트랜잭션으로 [S15P21C206-262].

적재 단계는 S15P21C206-256(MR !201)의 로컬 시드(experiments/distributed-pipeline/local-seed/local_seed/load.py)
에서 옮겼다. 운영 서비스 DB 적재의 정본 위치가 여기라서다(S15P21C206-86·87). 로컬 전용 접속 제한과
튜토리얼·챌린지 설정은 시드의 몫이라 옮기지 않았다. 입력이 어디서 왔는지는 모른다. 목업은 mock_source,
튜토리얼은 tutorial_source, 배치 run은 run_source가 같은 payload를 만든다(payload 모양은 README).

절차의 정본은 docs/architecture/system-architecture.md 「공개」, database-erd.md 결정 12, contracts/gold다.
  - 별마다 한 트랜잭션. pg_advisory_xact_lock(tic_id)으로 같은 별의 게시를 줄 세운다.
  - planetory_gold_writer 권한으로 쓴다(SET LOCAL ROLE). Publisher 권한 밖의 테이블을 DB가 막는다.
  - (tic_id, bundle_version)이 이미 있으면 내용 요약(payload_digest)을 대조한다. 같으면 재시도로 보고
    아무것도 바꾸지 않는다. 다르면 IDEMPOTENCY_CONFLICT로 멈춘다. 요약 규칙은 적재가 가진다(S15P21C206-86).
  - staging 적재 → 같은 트랜잭션 안 조회 검사 → 기존 current를 archived → 새 판을 current. 부분 유일
    인덱스(current는 TIC당 하나)가 즉시 검사라 archived가 먼저다.

checksum은 공용 astro_kernel.gold_canonical로 계산한다. 시드의 canonical과 같은 값을 낸다(2026-09-24 fixture로
곡선·주기도·후보·외부 라벨·AI 기록 checksum 대조).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

import psycopg
from astro_kernel.gold_canonical import array_checksum, normalize_array, record_checksum
from psycopg.types.json import Jsonb

REQUIRED_TABLES = ("stars", "observation_datasets", "publication_bundles", "light_curve_segments", "periodograms",
                   "candidates", "candidate_dispositions", "external_signal_references", "ai_executions",
                   "ai_evaluations", "candidate_status_history", "operation_settings")
DISPOSITION_RULE_VERSION = "rule-0"
# 이미지가 Backend 마이그레이션 목록을 여기 둔다(Dockerfile). DB가 이보다 뒤처지면 적재하지 않는다.
MIGRATIONS = Path(os.environ.get("PUBLISHER_MIGRATIONS_DIR", "/app/migrations"))


class PublishError(RuntimeError):
    """적재를 멈춰야 하는 상태. code는 Publisher 계약의 결과 코드를 따른다."""

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


@dataclass
class Target:
    flyway_version: int | None
    use_writer_role: bool
    warnings: list[str] = field(default_factory=list)


def num(value) -> Decimal | None:
    """float64를 NUMERIC 열에 넣을 때 최단 왕복 표기로 바인딩한다(publication-qa.md 3.1절 9항)."""
    return None if value is None else Decimal(repr(float(value)))


def payload_digest(payload: dict) -> str:
    """같은 bundle_version의 재요청이 같은 의미의 판인지 가리는 요약 [S15P21C206-86].

    I02-2 규칙대로 판 버전, 접기 기준 시각·base_days, 세그먼트 자연 키와 배열 checksum, 주기도·레코드 checksum으로
    만든다. DB가 만드는 id(판·세그먼트·주기도, manifest의 segment_ids)는 넣지 않는다. 규칙은 적재가 가진다. 입력
    어댑터가 값을 주면 이 값과 같아야 한다. 시각·base_days는 float로 받는다(repr이 요약에 들어간다).

    로컬 시드(local_seed/payload.py)와 목업(mock_source)이 먼저 적재한 행과 같은 값을 내야 하므로 식을 바꾸지 않는다.
    """
    bundle = payload["bundle"]
    return hashlib.sha256(json.dumps({
        "bundle_version": bundle["bundle_version"],
        "fold_reference_time_btjd": repr(bundle["fold_reference_time_btjd"]), "base_days": repr(bundle["base_days"]),
        "segments": [[s["sector"], s["binning_revision"], s["checksum"]] for s in payload["segments"]],
        "power": payload["periodogram"]["checksum"], "records": bundle["manifest"]["record_checksums"]},
        sort_keys=True).encode("utf-8")).hexdigest()


def repository_migration_version() -> int | None:
    versions = [int(m.group(1)) for p in MIGRATIONS.glob("V*__*.sql") if (m := re.match(r"V(\d+)__", p.name))]
    return max(versions) if versions else None


def notify_targets(results: list[StarResult]) -> list[int]:
    """판 전환을 알릴 판. 이번에 게시한 판뿐 아니라 이미 current인 판도 넣는다.

    후처리는 같은 판에 여러 번 와도 결과가 같다(탐사 API 10장). 앞선 실행에서 알림이 실패했어도 같은 명령을
    다시 돌리면 복구된다. 교체된 판(BUNDLE_SUPERSEDED)에는 알리지 않는다(Gold 계약 6절).
    """
    return [r.bundle_id for r in results if r.code in ("PUBLISHED", "ALREADY_PUBLISHED")]


def preflight(conn: psycopg.Connection, *, require_flyway: bool = True) -> Target:
    """DB가 적재를 받을 상태인지 본다. 뒤처진 DB에 먼저 넣으면 이후 마이그레이션이 데이터 위에서 멈출 수 있다."""
    missing = [t for t in REQUIRED_TABLES if conn.execute("SELECT to_regclass(%s)", (t,)).fetchone()[0] is None]
    if missing:
        raise PublishError("SCHEMA_MISSING", f"테이블이 없다: {', '.join(missing)}. Backend Flyway를 먼저 적용한다")
    version, warnings = None, []
    if conn.execute("SELECT to_regclass('flyway_schema_history')").fetchone()[0] is not None:
        # Flyway 이력은 소유자 테이블이라 gold_writer 권한 밖이다. 운영 적재 계정에는 SELECT만 따로 준다(README).
        # 권한이 없다고 버전 확인을 건너뛰지 않는다. 뒤처진 DB에 싣는 쪽이 더 위험하다.
        try:
            failed = conn.execute("SELECT count(*) FROM flyway_schema_history WHERE NOT success").fetchone()[0]
            version = conn.execute(
                "SELECT max(version::int) FROM flyway_schema_history WHERE version IS NOT NULL").fetchone()[0]
        except psycopg.errors.InsufficientPrivilege:
            raise PublishError("MIGRATION_UNREADABLE", "적재 계정이 flyway_schema_history를 읽지 못한다. "
                                                       "소유자로 GRANT SELECT ON flyway_schema_history TO <적재 계정>을 "
                                                       "실행한다") from None
        if failed:
            raise PublishError("MIGRATION_FAILED", f"실패한 마이그레이션 {failed}건이 기록돼 있다")
    elif require_flyway:
        raise PublishError("SCHEMA_MISSING", "flyway_schema_history가 없다. Backend Flyway가 만든 DB에만 적재한다")
    if require_flyway:
        latest = repository_migration_version()
        if latest is None:
            raise PublishError("MIGRATION_UNKNOWN", f"{MIGRATIONS}에 마이그레이션 목록이 없다. 이미지가 잘못 만들어졌다")
        if version is None or version < latest:
            raise PublishError("MIGRATION_BEHIND", f"DB 마이그레이션이 V{version}이고 이 이미지 기준은 V{latest}다. "
                                                   "Backend를 먼저 배포해 마이그레이션을 끝낸다")
        if version > latest:
            warnings.append(f"DB 마이그레이션 V{version}이 이 이미지 기준 V{latest}보다 앞선다. 이미지가 낡았을 수 있다")
    # 처분 행이 rule_version='rule-0'을 쓰는데 이 열에는 외래 키가 없다. DB가 막지 않으므로 여기서 본다.
    # operation_settings도 gold_writer 권한 밖이라 운영 적재 계정에는 SELECT를 따로 준다(README).
    try:
        has_rule = conn.execute("SELECT EXISTS(SELECT 1 FROM operation_settings)").fetchone()[0]
    except psycopg.errors.InsufficientPrivilege:
        raise PublishError("MIGRATION_UNREADABLE", "적재 계정이 operation_settings를 읽지 못한다. "
                                                   "소유자로 GRANT SELECT ON operation_settings TO <적재 계정>을 "
                                                   "실행한다") from None
    if not has_rule:
        raise PublishError("SCHEMA_MISSING", "operation_settings에 규칙이 없다(V9의 rule-0이 필요하다)")
    # 역할이 없으면 pg_has_role이 오류를 내므로 CASE로 먼저 거른다(AND는 평가 순서를 보장하지 않는다).
    use_writer = conn.execute("""
        SELECT CASE WHEN r.rolsuper THEN true
                    WHEN NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'planetory_gold_writer') THEN false
                    ELSE pg_has_role(current_user, 'planetory_gold_writer', 'MEMBER') END
          FROM pg_roles r WHERE r.rolname = current_user""").fetchone()[0]
    return Target(flyway_version=version, use_writer_role=bool(use_writer), warnings=warnings)


def _read_segment_checksum(cur, segment_id: int) -> str:
    flux = cur.execute("SELECT flux FROM light_curve_segments WHERE id = %s", (segment_id,)).fetchone()[0]
    return array_checksum(normalize_array(flux))


def publish_star(conn: psycopg.Connection, payload: dict, target: Target, *,
                 retire_reason: str = "Publisher 새 판 게시", first_publish_only: bool = False) -> StarResult:
    """first_publish_only면 current 판이 있는 별에는 새 판을 올리지 않는다(PUBLISH_REJECTED, 기존 current 유지).

    배치 run 게시(run_source)가 쓴다. 갱신 게시의 후보 동일성 대조가 생기기 전까지다[S15P21C206-276].
    튜토리얼 별은 늘 current가 있어 이 규칙으로 함께 빠진다.
    """
    tic = payload["tic_id"]
    bundle = payload["bundle"]
    digest = payload_digest(payload)
    if bundle.get("payload_digest") not in (None, digest):
        # 어댑터가 다른 식으로 요약했다. 그대로 두면 같은 판을 다른 판으로(또는 반대로) 판정한다.
        raise PublishError("PUBLISH_REJECTED", f"TIC {tic} 입력 어댑터의 payload_digest가 적재 규칙과 다르다")
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (tic,))
        if target.use_writer_role:
            cur.execute("SET LOCAL ROLE planetory_gold_writer")
        # 시드가 먼저 넣은 행은 요약을 manifest.local_seed에 두었다. 같은 판을 다시 만나도 알아보게 둘 다 읽는다.
        row = cur.execute("""
            SELECT id, status, COALESCE(manifest -> 'publish' ->> 'payload_digest',
                                        manifest -> 'local_seed' ->> 'payload_digest')
              FROM publication_bundles WHERE tic_id = %s AND bundle_version = %s""",
                          (tic, bundle["bundle_version"])).fetchone()
        if row:
            bundle_id, status, stored_digest = row
            if stored_digest != digest:
                raise PublishError("IDEMPOTENCY_CONFLICT",
                                   f"TIC {tic} 판 {bundle['bundle_version'][:16]}…의 내용이 이번 payload와 다르다")
            if status == "current":
                return StarResult(tic, payload["label"], "ALREADY_PUBLISHED", bundle_id)
            if status == "archived":
                return StarResult(tic, payload["label"], "BUNDLE_SUPERSEDED", bundle_id)
            raise PublishError("PUBLISH_REJECTED", f"TIC {tic}에 commit된 staging 판 {bundle_id}이 있다")
        if first_publish_only and cur.execute(
                "SELECT 1 FROM publication_bundles WHERE tic_id = %s AND status = 'current'", (tic,)).fetchone():
            raise PublishError("PUBLISH_REJECTED", f"TIC {tic}에 current 판이 있다. 갱신 게시는 후보 동일성 대조 전이라 "
                                                   "싣지 않는다")

        star = payload.get("star")
        if star is None:
            # 별 등록 없이 싣는 입력(목업). 기존 별 행을 덮어쓰지 않는다.
            if cur.execute("SELECT 1 FROM stars WHERE tic_id = %s", (tic,)).fetchone() is None:
                raise PublishError("STAR_MISSING", f"TIC {tic}이 stars에 없다. 이 payload는 별을 등록하지 않는다")
        else:
            # service_status가 None이면 새 별은 hidden으로 등록하고 기존 별의 공개 상태는 그대로 둔다(배치 run).
            status = star.get("service_status")
            cur.execute("""
                INSERT INTO stars(tic_id, teff_k, radius_rsun, tmag, confirmed_count, service_status)
                VALUES (%s, %s, %s, %s, %s, COALESCE(%s, 'hidden'))
                ON CONFLICT (tic_id) DO UPDATE SET teff_k = EXCLUDED.teff_k, radius_rsun = EXCLUDED.radius_rsun,
                    tmag = EXCLUDED.tmag, confirmed_count = EXCLUDED.confirmed_count,
                    service_status = COALESCE(%s, stars.service_status)""",
                        (tic, num(star["teff_k"]), num(star["radius_rsun"]), num(star["tmag"]),
                         star["confirmed_count"], status, status))

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
                    raise PublishError("IDEMPOTENCY_CONFLICT", f"TIC {tic} 섹터 {seg['sector']} 세그먼트 내용이 다르다")
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

        manifest = {**bundle["manifest"], "segment_ids": segment_ids, "array_checksums": array_checksums,
                    "publish": {**bundle["manifest"].get("publish", {}), "payload_digest": digest}}
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

        # ponytail: 이전 판의 후보를 전부 은퇴시킨다. 후보 동일성 대조(후보 정정 계약)는 운영 Publisher 과제다.
        retired = [r[0] for r in cur.execute(
            "UPDATE candidates SET status = 'retired' WHERE tic_id = %s AND status = 'active' RETURNING id",
            (tic,)).fetchall()]
        for candidate_id in retired:
            cur.execute("""
                INSERT INTO candidate_status_history(candidate_id, bundle_id, field, old_value, new_value, changed_at,
                                                     rule_version, reason)
                VALUES (%s, %s, 'status', 'active', 'retired', now(), %s, %s)""",
                        (candidate_id, bundle_id, DISPOSITION_RULE_VERSION, retire_reason))

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
            # transit model 계약 1.0은 candidate_id를 요구한다. DB id가 생긴 뒤에만 채울 수 있다.
            cur.execute("UPDATE candidates SET transit_model = %s WHERE id = %s",
                        (Jsonb({**rec["transit_model"], "candidate_id": f"c-{candidate_id}"}), candidate_id))
            d = candidate["disposition"]
            cur.execute("""
                INSERT INTO candidate_dispositions(candidate_id, disposition, answer_class, planet_truth, rule_version,
                                                   applied_at, source_refs)
                VALUES (%s, %s, %s, %s, %s, now(), %s)""",
                        (candidate_id, d["disposition"], d["answer_class"], d["planet_truth"],
                         DISPOSITION_RULE_VERSION, Jsonb(d["source_refs"])))
            for e in candidate["external"]:
                _insert_external(cur, tic, candidate_id, e)
            if candidate.get("ai"):
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
                             Jsonb(a.get("raw_output", {}))))
        # 우리 후보와 직접 대응하지 않은 외부 신호(124 external_only). 판 열이 없어 넣은 id로 다시 읽는다.
        external_only = [_insert_external(cur, tic, None, e) for e in payload.get("external_only", [])]

        _verify_staging(cur, payload, bundle_id, manifest, external_only)

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
            raise PublishError("PUBLISH_REJECTED", f"TIC {tic} current 판이 {currents}개다")
        return StarResult(tic, payload["label"], "PUBLISHED", bundle_id, archived, retired)


def publish_outcome(conn: psycopg.Connection, tic: int, item, target: Target, **kwargs) -> dict:
    """run 기록 한 행을 만든다. 한 별의 실패가 다음 별을 막지 않는다[S15P21C206-276].

    item은 payload 또는 게시 전 거절(code 속성이 있는 예외)이다. 결과 코드는 Gold 계약 6절을 따른다. DB 제약 위반은
    같은 입력이 반복해 실패하므로 PUBLISH_REJECTED, 연결이 끊긴 일시 장애는 같은 판으로 다시 돌릴 PUBLISH_ROLLED_BACK이다.
    둘 다 트랜잭션이 rollback돼 기존 current가 남는다.
    """
    row = {"tic_id": tic, "code": None, "bundle_id": None, "detail": None}
    if isinstance(item, Exception):
        return {**row, "code": item.code, "detail": str(item)}
    try:
        result = publish_star(conn, item, target, **kwargs)
        return {**row, "code": result.code, "bundle_id": result.bundle_id}
    except PublishError as exc:
        return {**row, "code": exc.code, "detail": str(exc)}
    except (psycopg.IntegrityError, psycopg.DataError) as exc:
        return {**row, "code": "PUBLISH_REJECTED", "detail": f"DB 제약 위반: {exc}"}
    except psycopg.OperationalError as exc:
        return {**row, "code": "PUBLISH_ROLLED_BACK", "detail": f"일시 장애: {exc}"}


def _insert_external(cur, tic: int, candidate_id: int | None, e: dict) -> int:
    return cur.execute("""
        INSERT INTO external_signal_references(candidate_id, source, external_id, disposition, period_days,
                                               fetched_on, tic_id, epoch_btjd)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                       (candidate_id, e["source"], e["external_id"], e["disposition"], num(e["period_days"]),
                        dt.date.fromisoformat(e["fetched_on"]), tic, num(e["epoch_btjd"]))).fetchone()[0]


def _verify_staging(cur, payload: dict, bundle_id: int, manifest: dict, external_only: list[int]) -> None:
    """적재한 행을 같은 트랜잭션에서 다시 읽어 계약대로 들어갔는지 본다. 실패하면 전부 rollback된다."""
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
                 "candidate_key": None if r[6] is None else {"period_days": float(r[6]), "epoch_btjd": float(r[7])}}
                for r in cur.execute("""
        SELECT e.source, e.external_id, e.disposition, e.period_days, e.epoch_btjd, e.fetched_on, c.period_days,
               c.epoch_btjd
          FROM external_signal_references e LEFT JOIN candidates c ON c.id = e.candidate_id
         WHERE c.updated_bundle_id = %s OR e.id = ANY(%s)""", (bundle_id, external_only)).fetchall()]
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
        raise PublishError("PUBLISH_REJECTED", f"TIC {tic} 적재 검사 실패: {', '.join(problems)}")

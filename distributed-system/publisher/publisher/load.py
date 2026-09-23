"""Gold 판 게시: 적재·current 전환을 한 트랜잭션으로 [S15P21C206-262].

입력은 Gold payload 한 건이다(experiments/gold-roundtrip이 만드는 모양, contracts/gold). 이 모듈은
payload를 어디서 가져왔는지 모른다. 목업은 mock_source가, 운영은 HDFS Gold reader가 같은 모양을 만든다.

절차의 정본은 docs/architecture/system-architecture.md 「공개」와 database-erd.md 결정 12다.
  - planetory_gold_writer 계정으로 쓴다.
  - 같은 TIC의 게시는 pg_advisory_xact_lock(tic_id)으로 줄 세운다.
  - (tic_id, bundle_version)이 이미 있으면 같은 게시의 재시도다. 아무것도 바꾸지 않는다.
    archived 판의 늦은 재시도도 현재 판을 되돌리지 않는다.
  - staging 적재 → 기존 current를 archived → 새 판을 current. 전부 한 트랜잭션이다.
    부분 유일 인덱스(current는 TIC당 하나)의 즉시 검사 때문에 archived가 먼저다.

게시 전 QA(publication-qa.md 2절)는 여기서 하지 않는다. 입력 쪽 책임이다. 목업 payload는
gold-roundtrip에서 QA와 왕복 검사를 통과한 것이다.
"""

from __future__ import annotations

from dataclasses import dataclass

from psycopg.types.json import Jsonb


@dataclass(frozen=True)
class Result:
    tic_id: int
    bundle_id: int
    bundle_version: str
    # 이번 호출이 판을 current로 올렸으면 True. 같은 판의 재시도면 False다.
    applied: bool
    status: str


def publish(conn, payload: dict) -> Result:
    bundle = payload["bundle"]
    tic = bundle["tic_id"]
    version = bundle["bundle_version"]
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (tic,))
        cur.execute(
            "SELECT id, status FROM publication_bundles WHERE tic_id = %s AND bundle_version = %s",
            (tic, version),
        )
        existing = cur.fetchone()
        if existing:
            return Result(tic, existing[0], version, False, existing[1])

        # ponytail: 별 등록과 후보 갱신·은퇴는 하지 않는다. 등록된 별에 처음 싣는 경우만 다룬다.
        # 기존 후보가 있는 별에 그대로 넣으면 후보가 중복된다. 운영 Publisher는 후보 정정 계약
        # (docs/architecture/candidate-correction-contract.md)을 따라 대조해야 한다.
        cur.execute("SELECT 1 FROM stars WHERE tic_id = %s", (tic,))
        if cur.fetchone() is None:
            raise ValueError(f"TIC {tic}이 stars에 없다. 별 등록은 이 적재의 범위가 아니다.")
        cur.execute("SELECT count(*) FROM candidates WHERE tic_id = %s", (tic,))
        if cur.fetchone()[0]:
            raise ValueError(f"TIC {tic}에 이미 후보가 있다. 후보 대조 없이 덧붙이지 않는다.")

        segment_ids, checksums = [], {}
        for seg in payload["segments"]:
            segment_id = _segment(cur, tic, seg)
            segment_ids.append(segment_id)
            key = f"segment:{seg['sector']}:{seg['binning_revision']}:flux"
            checksums[f"segment:{segment_id}:flux"] = payload["checksums"][key]

        # segment_ids·array_checksums는 DB id로 채운다. payload에는 id가 없다.
        manifest = {**bundle["manifest"], "segment_ids": segment_ids, "array_checksums": checksums}
        cur.execute(
            "INSERT INTO publication_bundles"
            "(tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days)"
            " VALUES (%s, %s, 'staging', %s, %s, %s) RETURNING id",
            (tic, version, Jsonb(manifest), bundle["fold_reference_time_btjd"], bundle["base_days"]),
        )
        bundle_id = cur.fetchone()[0]

        pg = payload["periodogram"]
        cur.execute(
            "INSERT INTO periodograms(bundle_id, period_min_days, period_max_days, n_periods, power)"
            " VALUES (%s, %s, %s, %s, %s::real[])",
            (bundle_id, pg["period_min_days"], pg["period_max_days"], pg["n_periods"], pg["power"]),
        )
        checksums[f"periodogram:{bundle_id}:power"] = payload["checksums"]["periodogram:power"]
        cur.execute(
            "UPDATE publication_bundles SET manifest = %s WHERE id = %s",
            (Jsonb({**manifest, "array_checksums": checksums}), bundle_id),
        )

        for c in payload["candidates"]:
            cur.execute(
                "INSERT INTO candidates(tic_id, status, updated_bundle_id, removal_step, period_days,"
                " epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
                (tic, c["status"], bundle_id, c["removal_step"], c["period_days"], c["epoch_btjd"],
                 c["duration_hours"], c["depth_ppm"], c["bls_power"], Jsonb(c["transit_model"]),
                 c["discoverable"], c["is_confirmed"]),
            )
            candidate_id = cur.fetchone()[0]
            # transit model 계약 1.0은 candidate_id를 요구한다. DB id가 생긴 뒤에만 채울 수 있다.
            cur.execute(
                "UPDATE candidates SET transit_model = %s WHERE id = %s",
                (Jsonb({**c["transit_model"], "candidate_id": f"c-{candidate_id}"}), candidate_id),
            )

        cur.execute(
            "UPDATE publication_bundles SET status = 'archived' WHERE tic_id = %s AND status = 'current'",
            (tic,),
        )
        # 판 행은 과거 제출 참조를 위해 남기되 archived 판의 주기도는 정리한다(정본).
        cur.execute(
            "DELETE FROM periodograms WHERE bundle_id IN"
            " (SELECT id FROM publication_bundles WHERE tic_id = %s AND status = 'archived')",
            (tic,),
        )
        cur.execute(
            "UPDATE publication_bundles SET status = 'current', published_at = now() WHERE id = %s",
            (bundle_id,),
        )
    return Result(tic, bundle_id, version, True, "current")


def _segment(cur, tic: int, seg: dict) -> int:
    """세그먼트는 판에 묶이지 않고 자연 키 (tic_id, sector, binning_revision)로 공유된다."""
    cur.execute(
        "INSERT INTO light_curve_segments(tic_id, sector, binning_revision, start_btjd, bin_minutes,"
        " n_points, flux, flux_scatter, gaps) VALUES (%s, %s, %s, %s, %s, %s, %s::real[], %s, %s)"
        " ON CONFLICT (tic_id, sector, binning_revision) DO NOTHING RETURNING id",
        (tic, seg["sector"], seg["binning_revision"], seg["start_btjd"], seg["bin_minutes"],
         seg["n_points"], seg["flux"], seg["flux_scatter"], Jsonb(seg["gaps"])),
    )
    row = cur.fetchone()
    if row:
        return row[0]
    # ponytail: 같은 자연 키면 같은 곡선이라고 보고 점 수만 대조한다. 운영은 flux checksum으로 대조한다.
    cur.execute(
        "SELECT id, n_points FROM light_curve_segments"
        " WHERE tic_id = %s AND sector = %s AND binning_revision = %s",
        (tic, seg["sector"], seg["binning_revision"]),
    )
    segment_id, n_points = cur.fetchone()
    if n_points != seg["n_points"]:
        raise ValueError(f"세그먼트 {segment_id}의 점 수({n_points})가 payload({seg['n_points']})와 다르다.")
    return segment_id

"""배치 run 입력 어댑터: 79 후보 집계 출력의 번들을 load.publish_star payload로 바꾼다 [S15P21C206-276].

mock_source 자리의 운영 입력이다. 입력은 astro_kernel.candidate_aggregation.aggregate 출력(run manifest, 별마다 125
assemble 번들, 후보 표)과, 80이 함께 넘길 별마다의 메타데이터 {"star": 별 속성, "observations": Sector별 관측 원천}이다.
HDFS 위치와 파일 형식은 80이 정한다(contracts/gold 4.3절). 여기서는 읽은 뒤의 검사와 변환만 하고 DB에 붙지 않는다.

  - run 검사: run manifest와 번들·후보 표가 서로 맞는지 본다. 어긋나면 run 전체를 싣지 않는다.
  - 별 검사: 번들이 자기 manifest의 배열·레코드 checksum과 맞는지, Gold 계약 4장 값 범위 안인지, 첫 게시 판인지 본다.
    걸리면 그 별만 PUBLISH_REJECTED다. 계약 밖의 QA 기준값은 데이터 담당(125·117) 합의 전이라 두지 않는다.
  - payload_digest를 주지 않는다(README 「payload 모양」). 별은 service_status 없이 싣는다. 새 별은 hidden이다.
  - 첫 게시만 한다. 적재는 first_publish_only로 부른다. ponytail: 갱신 게시는 후보 정정 계약의 동일성 대조가 생기면 연다.
"""

from __future__ import annotations

import math
from typing import Iterator

from astro_kernel.candidate_aggregation import SCHEMA_VERSION, VERSION as AGGREGATOR_VERSION
from astro_kernel.external_catalog import content_hash
from astro_kernel.gold_canonical import array_checksum, normalize_array, record_checksum

from .mock_source import RECORD_FIELDS

JIRA = "S15P21C206-276"
EXTERNAL_FIELDS = ("source", "external_id", "disposition", "period_days", "epoch_btjd", "fetched_on")
MALFORMED = (KeyError, TypeError, AttributeError, ValueError)


class PublishRejected(ValueError):
    """게시 전 검사에 걸린 입력. DB에 쓰지 않는다. 결과 코드는 PUBLISH_REJECTED다."""

    code = "PUBLISH_REJECTED"


def _require(condition, detail: str) -> None:
    if not condition:
        raise PublishRejected(detail)


def _finite(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _positive(value) -> bool:
    return _finite(value) and value > 0


def check_run(aggregation: dict) -> dict[int, dict]:
    """run manifest와 번들·후보 표가 맞으면 ready 별의 {tic: 번들}을 돌려준다. 어긋나면 run 전체를 거절한다."""
    try:
        m = aggregation["manifest"]
        _require(aggregation["status"] in ("complete", "incomplete") and m,
                 f"게시할 수 없는 run이다: {aggregation['status']} {aggregation.get('reason')}")
        _require((m["schema_version"], m["aggregator_version"]) == (SCHEMA_VERSION, AGGREGATOR_VERSION),
                 f"모르는 집계 형식이다: {m['schema_version']} {m['aggregator_version']}")
        bundles = aggregation["bundles"]
        _require([(s["tic_id"], s["bundle_id"], s["bundle_version"], s["record_checksums"]) for s in m["bundles"]] ==
                 [(b["bundle"]["tic_id"], b["bundle"]["id"], b["bundle"]["bundle_version"],
                   b["bundle"]["manifest"]["record_checksums"]) for b in bundles], "번들이 run manifest와 다르다")
        by_tic = {b["bundle"]["tic_id"]: b for b in bundles}
        _require(len(by_tic) == len(bundles) and by_tic.keys() == {s["tic_id"] for s in m["stars"] if s["status"] == "ready"},
                 "ready 별과 번들이 다르다")
        rows = aggregation["candidates"]
        _require(len(rows) == m["candidate_count"] and content_hash(rows) == m["candidates_sha256"],
                 "후보 표가 run manifest와 다르다")
        _require(sorted((r["tic_id"], r["candidate_id"]) for r in rows) ==
                 sorted((tic, c["id"]) for tic, b in by_tic.items() for c in b["candidates"] if c["status"] == "active"),
                 "후보 표와 번들의 활성 후보가 다르다")
    except MALFORMED as exc:
        if isinstance(exc, PublishRejected):
            raise
        raise PublishRejected(f"run 입력 형식이 맞지 않는다: {exc!r}") from None
    return by_tic


def check_bundle(gold: dict) -> None:
    """번들이 자기 manifest와 맞고 Gold 계약 4장 값 범위 안인 첫 게시 판인지 본다. 아니면 PublishRejected."""
    bundle, manifest = gold["bundle"], gold["bundle"]["manifest"]
    tic = bundle["tic_id"]
    # 은퇴 후보, 이전 값이 있는 이력 제안, keep/retire 수명 조치는 이전 판이 있다는 뜻이다.
    # 새 후보의 첫 판정 이력(old_value=None)은 첫 게시에도 나온다.
    _require(all(c["status"] == "active" for c in gold["candidates"])
             and all(h["old_value"] is None for h in gold["history_proposals"])
             and all(a["action"] == "add" for a in gold["lifecycle_actions"]),
             f"TIC {tic}: 갱신 판은 후보 동일성 대조 전이라 싣지 않는다")
    sums = {f"segment:{s['id']}:flux": array_checksum(normalize_array(s["flux"])) for s in gold["segments"]}
    sums[f"periodogram:{bundle['id']}:power"] = array_checksum(normalize_array(gold["periodogram"]["power"],
                                                                               allow_null=False))
    _require(sums == manifest["array_checksums"], f"TIC {tic}: 배열 checksum이 manifest와 다르다")
    records = {"candidates": gold["candidates"], "external_statuses": gold["external_statuses"],
               "ai_results": gold["ai_results"]}
    _require({kind: record_checksum(kind, rows) for kind, rows in records.items()} == manifest["record_checksums"],
             f"TIC {tic}: 레코드 checksum이 manifest와 다르다")
    # Gold 계약 4장 가운데 DB CHECK가 막지 않는 값만 본다. 배열 길이·bin 간격·주기 범위는 V1 CHECK가 막는다.
    _require(_finite(bundle["fold_reference_time_btjd"]) and _positive(bundle["base_days"]),
             f"TIC {tic}: 기준 시각이나 base_days가 범위 밖이다")
    for c in gold["candidates"]:
        _require(_positive(c["period_days"]) and _finite(c["epoch_btjd"]) and _positive(c["duration_hours"])
                 and _positive(c["depth_ppm"]) and c["depth_ppm"] < 1_000_000 and _finite(c["bls_power"]),
                 f"TIC {tic} 후보 {c['id']}: 값이 Gold 계약 범위 밖이다")


def gold_body(gold: dict, observations: dict[str, dict]) -> dict:
    """125 번들을 payload의 판 본문으로 바꾼다. DB id가 들어간 키는 적재가 다시 만든다. tutorial_source도 쓴다.

    observations는 Sector(문자열 키)별 관측 원천 {"cadence", "source_version"}이다. 외부 참조는 후보마다 목록으로
    붙이고, 후보와 직접 대응하지 않은 124 external_only 행은 external_only로 따로 싣는다.
    """
    segments = [{**{k: s[k] for k in ("sector", "binning_revision", "start_btjd", "bin_minutes", "n_points",
                                         "flux", "flux_scatter", "gaps")},
                 "checksum": array_checksum(s["flux"]),
                 "observation": {"start_btjd": round(s["start_btjd"], 6),
                                 "end_btjd": round(s["start_btjd"] + s["n_points"] * s["bin_minutes"] / 1440, 6),
                                 **{k: observations[str(s["sector"])][k] for k in ("cadence", "source_version")}}}
                for s in gold["segments"]]
    dispositions = {d["candidate_id"]: d for d in gold["candidate_dispositions"]}
    references: dict[int | None, list[dict]] = {}
    for r in gold["external_statuses"]:
        references.setdefault(r["candidate_id"], []).append({k: r[k] for k in EXTERNAL_FIELDS})
    candidates = []
    for c in sorted(gold["candidates"], key=lambda c: c["removal_step"]):
        d = dispositions[c["id"]]
        candidates.append({
            "record": {k: c[k] for k in RECORD_FIELDS},
            "disposition": {k: d[k] for k in ("disposition", "answer_class", "planet_truth", "source_refs")},
            "external": references.pop(c["id"], []),
            "ai": None})
    external_only = references.pop(None, [])
    if references:
        raise ValueError(f"번들에 없는 후보의 외부 참조가 있다: {sorted(references)}")
    pg, bundle = gold["periodogram"], gold["bundle"]
    return {
        "segments": segments,
        "bundle": {"bundle_version": bundle["bundle_version"],
                   "manifest": {k: v for k, v in bundle["manifest"].items() if k not in ("segment_ids", "array_checksums")},
                   "fold_reference_time_btjd": bundle["fold_reference_time_btjd"], "base_days": bundle["base_days"]},
        "periodogram": {"period_min_days": pg["period_min_days"], "period_max_days": pg["period_max_days"],
                        "n_periods": pg["n_periods"], "power": pg["power"], "checksum": array_checksum(pg["power"])},
        "candidates": candidates,
        "external_only": external_only,
    }


def to_payload(gold: dict, meta: dict, run: dict) -> dict:
    """한 별의 payload. meta는 {"star": {teff_k, radius_rsun, tmag}, "observations": {Sector: {cadence, source_version}}}."""
    body = gold_body(gold, meta["observations"])
    tic = gold["bundle"]["tic_id"]
    body["bundle"]["manifest"]["publish"] = {"jira": JIRA, "source": "run", "run_id": run["run_id"],
                                             "silver_attempt": run["silver_attempt"],
                                             "aggregator_version": run["aggregator_version"]}
    return {"tic_id": tic, "label": f"run {run['run_id']} TIC {tic}",
            "star": {**{k: meta["star"][k] for k in ("teff_k", "radius_rsun", "tmag")},
                     "confirmed_count": sum(c["record"]["is_confirmed"] for c in body["candidates"]),
                     "service_status": None},
            **body}


def star_payloads(aggregation: dict, metadata: dict[str, dict]) -> Iterator[tuple[int, dict | PublishRejected]]:
    """ready 별마다 (tic, payload) 또는 (tic, PublishRejected)를 TIC 순서로 낸다. metadata 키는 TIC 문자열이다.

    run 검사가 실패하면 별을 하나도 내지 않고 PublishRejected를 던진다.
    """
    bundles = check_run(aggregation)
    for tic in sorted(bundles):
        try:
            check_bundle(bundles[tic])
            yield tic, to_payload(bundles[tic], metadata[str(tic)], aggregation["manifest"])
        except PublishRejected as exc:
            yield tic, exc
        except MALFORMED as exc:
            yield tic, PublishRejected(f"TIC {tic}: 입력 형식이 맞지 않는다: {exc!r}")

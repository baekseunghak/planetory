"""배치 run 입력 어댑터: 80 게시 준비 폴더의 번들을 load.publish_star payload로 바꾼다 [S15P21C206-276].

mock_source 자리의 운영 입력이다. 입력은 80 gate가 통과시킨 publish-ready를 Node 1 로컬로 받은 폴더다(80과 합의).

  <폴더>/_READY.json          publish-ready marker(schema planetory.tess-publish-ready.v1). files에 part마다 sha256·bytes·lines
  <폴더>/manifest/part-*      한 줄 = 79 run manifest
  <폴더>/candidates/part-*    한 줄 = 79 후보 행
  <폴더>/bundles/part-*       한 줄 = {"tic_id", "payload": 125 번들, "metadata": {"star", "observations"}}

  - 검사 분담: 후보 표 재해시와 schema·payload 재계산은 80 gate가 한다. 여기서는 전송 무결성(files의 sha256·bytes·
    lines), manifest 한 줄·번들 수, 번들 줄마다 run manifest 항목 대조와 별 검사를 한다.
  - 별 검사: 번들이 자기 manifest의 배열·레코드 checksum과 맞는지, Gold 계약 4장 값 범위 안인지, 첫 게시 판인지 본다.
    걸리면 그 별만 PUBLISH_REJECTED다. 계약 밖의 QA 기준값은 데이터 담당(125·117) 합의 전이라 두지 않는다.
  - 번들은 줄 단위로 읽는다. 메모리는 별 하나 크기다. DB에 붙지 않는다.
  - payload_digest를 주지 않는다(README 「payload 모양」). 별은 service_status 없이 싣는다. 새 별은 찾을 수 있는(discoverable) 후보가 있으면 published, 없으면
    hidden이다(initial_status). 기존 별의 공개 상태는 바꾸지 않는다.
  - 첫 게시만 한다. 적재는 first_publish_only로 부른다. ponytail: 갱신 게시는 후보 정정 계약의 동일성 대조가 생기면 연다.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path, PurePosixPath
from typing import Iterator

from astro_kernel.candidate_aggregation import SCHEMA_VERSION, VERSION as AGGREGATOR_VERSION
from astro_kernel.gold_canonical import array_checksum, normalize_array, record_checksum

from .mock_source import RECORD_FIELDS

JIRA = "S15P21C206-276"
READY_SCHEMA = "planetory.tess-publish-ready.v1"
PARTS = ("manifest", "candidates", "bundles")
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


def read_ready(folder: Path, run_id: str, approval: str) -> tuple[dict, Iterator[tuple[int | None, dict | PublishRejected]]]:
    """게시 준비 폴더를 검사하고 (run manifest, 별마다 (tic, payload 또는 PublishRejected))를 돌려준다.

    run 단위 검사는 부를 때 바로 한다. 실패하면 별을 하나도 내지 않고 PublishRejected를 던진다. 번들 수를 먼저 맞추고
    줄마다 manifest 항목에 한 번씩만 대응시키므로, 끝까지 읽으면 ready 별 전부를 정확히 한 번 본 것이다.
    """
    _require(isinstance(approval, str) and approval.strip(), "게시 승인 근거가 필요하다")
    try:
        marker = json.loads((folder / "_READY.json").read_text(encoding="utf-8"))
        _require(marker["schema"] == READY_SCHEMA, f"모르는 publish-ready 형식이다: {marker['schema']}")
        _require(marker["run_id"] == run_id, f"publish-ready의 run_id({marker['run_id']})가 --run-id와 다르다")
        files = marker["files"]
        for rel, spec in files.items():
            _check_file(folder, rel, spec)
        parts = {p: sorted(rel for rel in files if rel.startswith(p + "/")) for p in PARTS}
        manifest_lines = [line for rel in parts["manifest"] for line in _lines(folder / rel)]
        _require(len(manifest_lines) == 1, f"manifest가 {len(manifest_lines)}줄이다")
        m = json.loads(manifest_lines[0])
        _require((m["schema_version"], m["aggregator_version"]) == (SCHEMA_VERSION, AGGREGATOR_VERSION),
                 f"모르는 집계 형식이다: {m['schema_version']} {m['aggregator_version']}")
        _require(m["run_id"] == run_id, f"run manifest의 run_id({m['run_id']})가 --run-id와 다르다")
        _require(marker["counts"] == m["counts"], "publish-ready counts가 run manifest counts와 다르다")
        entries = {e["tic_id"]: e for e in m["bundles"]}
        _require(len(entries) == len(m["bundles"]) == m["counts"]["ready"]
                 == sum(files[rel]["lines"] for rel in parts["bundles"]), "번들 수가 run manifest와 다르다")
    except (*MALFORMED, OSError) as exc:
        if isinstance(exc, PublishRejected):
            raise
        raise PublishRejected(f"게시 준비 폴더를 읽지 못했다: {exc!r}") from None
    seen: set[int] = set()
    lines = (line for rel in parts["bundles"] for line in _lines(folder / rel))
    return m, (_star(line, entries, seen, m, approval) for line in lines)


def _check_file(folder: Path, rel: str, spec: dict) -> None:
    path = PurePosixPath(rel)
    _require(len(path.parts) == 2 and path.parts[0] in PARTS and path.parts[1] not in (".", ".."),
             f"files에 모르는 경로가 있다: {rel}")
    digest, size, lines = hashlib.sha256(), 0, 0
    with open(folder / rel, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
            size += len(chunk)
            lines += chunk.count(b"\n")
    _require((digest.hexdigest(), size, lines) == (spec["sha256"], spec["bytes"], spec["lines"]),
             f"{rel}이 publish-ready files의 sha256·bytes·lines와 다르다")


def _lines(path: Path) -> Iterator[str]:
    with open(path, encoding="utf-8") as f:
        yield from f


def _star(line: str, entries: dict, seen: set, m: dict, approval: str) -> tuple[int | None, dict | PublishRejected]:
    tic = None
    try:
        row = json.loads(line)
        tic, gold = row["tic_id"], row["payload"]
        entry = entries.get(tic)
        _require(entry is not None and tic not in seen, f"TIC {tic}: run manifest에 없거나 두 번 나온 번들이다")
        seen.add(tic)
        b = gold["bundle"]
        _require((b["tic_id"], b["id"], b["bundle_version"], b["manifest"]["record_checksums"]) ==
                 (tic, entry["bundle_id"], entry["bundle_version"], entry["record_checksums"]),
                 f"TIC {tic}: 번들이 run manifest 항목과 다르다")
        check_bundle(gold)
        return tic, to_payload(gold, row["metadata"], m, approval)
    except PublishRejected as exc:
        return tic, exc
    except MALFORMED as exc:
        return tic, PublishRejected(f"TIC {tic}: 입력 형식이 맞지 않는다: {exc!r}")


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


def to_payload(gold: dict, meta: dict, run: dict, approval: str) -> dict:
    """한 별의 payload. meta는 {"star": {teff_k, radius_rsun, tmag}, "observations": {Sector: {cadence, source_version}}}.

    approval은 게시 승인 근거다. manifest.publish에 남는다(payload_digest 재료가 아니다).
    """
    body = gold_body(gold, meta["observations"])
    tic = gold["bundle"]["tic_id"]
    body["bundle"]["manifest"]["publish"] = {"jira": JIRA, "source": "run", "run_id": run["run_id"],
                                             "silver_attempt": run["silver_attempt"],
                                             "aggregator_version": run["aggregator_version"], "approval": approval}
    # 새 별은 회원이 찾을 수 있는 후보가 있을 때만 공개한다. 찾을 것이 없는 별은 탐사가 곧바로 끝나 등록할 의미가
    # 없다(공급 자격도 active·discoverable 후보 1개 이상). 기존 별의 공개 상태는 적재가 그대로 둔다.
    discoverable = any(c["record"]["discoverable"] for c in body["candidates"])
    return {"tic_id": tic, "label": f"run {run['run_id']} TIC {tic}",
            "star": {**{k: meta["star"][k] for k in ("teff_k", "radius_rsun", "tmag")},
                     "confirmed_count": sum(c["record"]["is_confirmed"] for c in body["candidates"]),
                     "service_status": None, "initial_status": "published" if discoverable else "hidden"},
            **body}


def confirmed_without_archive(payload: dict) -> int:
    """archive 참조가 없는 확정 후보 수. 266 NASA 설명은 이 참조로만 원천을 찾으므로 그 후보에서는 열리지 않는다."""
    return sum(c["record"]["is_confirmed"] and not any(e["source"] == "archive" for e in c["external"])
               for c in payload["candidates"])

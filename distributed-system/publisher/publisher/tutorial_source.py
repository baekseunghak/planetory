"""튜토리얼 입력 어댑터: 고정 FITS에 운영 커널을 돌려 튜토리얼 5종의 Gold payload를 만든다 [S15P21C206-272].

mock_source와 같은 모양의 payload를 낸다. load.publish_star는 둘을 구분하지 않는다. 대상·입력 checksum·외부 라벨은
tutorial.json이 정본이다(선정 S15P21C206-109, 판정 규칙 tutorial-label-v1).

  - FITS와 외부 원천 파일은 저장소에 두지 않는다. 호출자가 폴더를 주고 여기서 checksum을 대조한다.
  - 계산은 공용 astro_kernel만 쓴다. 119 전처리 → 122 반복 BLS·후보표 → 123 세그먼트·제공 해상도 판정 → 124 외부
    조인 → 125 assemble. 실험 코드(experiments/tess-bench)는 부르지 않는다.
  - 커널은 DB가 예약한 ID를 받는다. 튜토리얼 별은 이전 판이 없는 최초 게시라 판·후보·세그먼트에 1부터 고정 임시 ID를
    주고, 적재 때 DB가 실제 ID를 붙인다. 레코드 checksum은 ID와 transit_model.candidate_id를 빼고 계산하므로
    assemble의 값을 적재 검사에 그대로 쓴다. ponytail: 이전 판이 생기면(재게시) DB 예약 ID와 previous_bundle을 넘겨야 한다.
  - 모든 활성 후보가 튜토리얼 외부 행과 직접 대응하고 판정이 intent와 맞을 때만 payload를 낸다.
"""

from __future__ import annotations

import csv
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from astro_kernel import discoverability
from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.discoverability import prepare_discoverability
from astro_kernel.external_catalog import build_snapshot, join_catalog, normalize_export_row
from astro_kernel.gold_serialization import assemble
from astro_kernel.iteration import iterate_bls
from astro_kernel.preprocessing import preprocess_silver, preprocessing_config
from astro_kernel.segmentation import segment_silver

from .mock_source import payload_digest
from .run_source import gold_body

TUTORIAL = Path(__file__).parent / "tutorial.json"
PROVISIONAL_ID = 1
FINE_TUNE = {"half_width_cells": 3}
DISPOSITION_BY_INTENT = {"deep_confirmed": "confirmed", "shallow_confirmed": "confirmed",
                         "fp": "fp", "deep_fp": "fp", "multi_fp": "fp"}


class TutorialError(RuntimeError):
    """게시하면 안 되는 입력·계산 결과."""


def load_tutorial() -> dict:
    return json.loads(TUTORIAL.read_text(encoding="utf-8"))


def verified(folder: Path, name: str, sha256: str) -> Path:
    path = folder / name
    if not path.is_file():
        raise TutorialError(f"{name}이 {folder}에 없다")
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
        raise TutorialError(f"{name}의 checksum이 tutorial.json과 다르다")
    return path


def _dv_model(path: Path, tic: str, planet: int, fit: str) -> tuple[float, float, float]:
    """SPOC DV 보고서에서 행성 적합 모델을 읽는다. transitEpochBtjd는 BTJD(TDB)다(NASA ICD Rev F)."""
    root = ET.parse(path).getroot()
    if root.get("ticId") != tic or root.get("simData") != "false":
        raise TutorialError(f"{path.name}이 TIC {tic}의 실제 DV 보고서가 아니다")
    for results in root.iter():
        if results.tag.endswith("planetResults") and results.get("planetNumber") == str(planet):
            model = next(child for child in results if child.tag.endswith(fit))
            if model.get("fullConvergence") != "true":
                raise TutorialError(f"{path.name} planet {planet} {fit}이 수렴하지 않았다")
            values = {p.get("name"): float(p.get("value")) for p in model.iter() if p.tag.endswith("modelParameter")}
            return values["orbitalPeriodDays"], values["transitEpochBtjd"], values["transitDurationHours"]
    raise TutorialError(f"{path.name}에 planet {planet}이 없다")


def external_rows(star: dict, path: Path) -> list[dict]:
    """외부 원천 파일에서 124 정규화 행을 만든다. PDF(Demangeon)만 tutorial.json에 옮겨 적은 값을 쓴다."""
    tic, rows = str(star["tic_id"]), []
    for spec in star["external"]["rows"]:
        if spec["read"] == "pscomppars":
            with path.open(encoding="utf-8", newline="") as f:
                raw = [r for r in csv.DictReader(f) if r["pl_name"] == spec["pl_name"]]
            normalized = normalize_export_row("nea_pscomppars", raw[0]) if len(raw) == 1 else {"status": "missing"}
            if normalized["status"] != "normalized" or normalized["tic_id"] != tic:
                raise TutorialError(f"{spec['pl_name']} Archive 행을 정규화하지 못했다: {normalized.get('reason')}")
            row = dict(normalized["row"])
        elif spec["read"] == "dv_xml":
            period, epoch, duration = _dv_model(path, tic, spec["planet"], spec["fit"])
            row = dict(external_id=spec["external_id"], period_days=period * spec.get("period_multiplier", 1),
                       epoch_btjd=epoch, duration_hours=duration)
        elif spec["read"] == "alerts_csv":
            with path.open(encoding="utf-8", newline="") as f:
                raw = [r for r in csv.DictReader(f) if r["#tic_id"] == tic and r["toi_id"] == spec["toi_id"]]
            if len(raw) != 1:
                raise TutorialError(f"TOI {spec['toi_id']} 행이 하나가 아니다")
            row = dict(external_id=spec["external_id"], period_days=float(raw[0]["Period"]),
                       epoch_btjd=float(raw[0]["Epoc"]), duration_hours=float(raw[0]["Duration"]))
        elif spec["read"] == "manual":
            row = {k: spec[k] for k in ("external_id", "period_days", "epoch_btjd", "duration_hours")}
        else:
            raise TutorialError(f"모르는 읽기 방식: {spec['read']}")
        rows.append({**row, "tic_id": tic, "time_system": "BTJD-TDB", "raw_disposition": spec["label"],
                     "source_row_updated_at": None})
    return rows


def _ready(stage: str, result: dict, *, key: str = "status", value: str = "ready") -> dict:
    if result.get(key) != value:
        raise TutorialError(f"{stage}: {result.get(key)} {result.get('reasons') or result.get('reason') or ''}")
    return result


def assemble_star(star: dict, folder: Path, tutorial: dict, label_approval: str) -> tuple[dict, dict]:
    """한 별의 assemble 결과와 FITS 헤더의 별 속성을 돌려준다."""
    from astropy.io import fits  # BLS 선택 의존성. 적재만 하는 이미지에는 없다.

    from astro_kernel.fits_adapter import parse_spoc_hdul

    tic, product, ext = star["tic_id"], star["product"], star["external"]
    approvals, ai = tutorial["approvals"], tutorial["ai_policy"]
    fits_path = verified(folder, product["filename"], product["sha256"])
    with fits.open(fits_path) as hdul:
        sector_input, meta = parse_spoc_hdul(hdul, product_id=product["filename"], source_sha256=product["sha256"])
        header = hdul[0].header
        attributes = {"teff_k": header.get("TEFF"), "radius_rsun": header.get("RADIUS"), "tmag": header.get("TESSMAG")}
    if (int(meta["TICID"]), int(meta["SECTOR"]), str(meta["PROCVER"]).strip()) != (tic, product["sector"], product["procver"]):
        raise TutorialError(f"{product['filename']} 헤더의 TIC·Sector·PROCVER가 tutorial.json과 다르다")

    prepared, detrended = preprocess_silver([sector_input])
    if detrended.status != "ok":
        raise TutorialError(f"TIC {tic} 전처리 실패: {detrended.status}")
    snapshot = f"{product['filename']}:sha256:{product['sha256']}"
    # 탐색 품질은 기본 v0(gate_v1)이다. 109 선정 실측이 이 버전이다(243 v1 결과로 간주하지 않는다).
    iteration = iterate_bls(prepared.time, detrended.flux_det, sector=prepared.sector, baseline_time=prepared.time,
                            input_snapshot_id=snapshot, preprocessing_version=detrended.version)
    _ready("122 반복 탐색", iteration, key="complete", value=True)
    first = build_candidate_catalog(iteration, tic_id=tic, bundle_id=PROVISIONAL_ID)
    ids = {peak: i + 1 for i, peak in enumerate(first["needed_new_peak_ids"])}
    catalog = _ready("122 후보표", build_candidate_catalog(
        iteration, tic_id=tic, bundle_id=PROVISIONAL_ID, new_candidate_ids=ids,
        identity_approval=approvals["identity"]), key="catalog_ready", value=True)
    segmented = segment_silver(prepared, detrended, snapshot_id=snapshot,
                               product_checksums={product["filename"]: product["sha256"]},
                               preprocessing_parameters=preprocessing_config())
    discovery = _ready("123 제공 해상도", prepare_discoverability(
        segmented, catalog, fine_tune=FINE_TUNE, candidate_quality_version=iteration["candidate_quality_version"],
        rule_approval=approvals["discoverability"]))

    delivery = _ready("124 외부 snapshot", build_snapshot(
        source=ext["source"], scope=[str(tic)], rows=external_rows(star, verified(folder, ext["file"], ext["sha256"])),
        raw_sha256=ext["sha256"], retrieved_at=ext["retrieved_at"], source_uri=ext["uri"], source_table=ext["table"],
        time_evidence=ext["time_evidence"], complete=True, validated=True))
    external = _ready("124 외부 조인", join_catalog(
        catalog, {ext["source"]: delivery}, prepared.time, required_sources=[ext["source"]],
        approval=f"{approvals['external_contract']}; {tutorial['label_rule']['version']}: {label_approval}"))
    unmatched = [r["candidate_id"] for r in external["rows"] if len(r["source_refs"]["refs"]) != 1]
    wanted = DISPOSITION_BY_INTENT[star["intent"]]
    if unmatched or any(r["disposition"] != wanted for r in external["rows"]):
        raise TutorialError(f"TIC {tic}: 튜토리얼 외부 행과 직접 대응하지 않은 후보 {unmatched} 또는 {wanted}가 아닌 판정")
    if star["intent"] == "multi_fp" and len(external["rows"]) < 2:
        raise TutorialError(f"TIC {tic}: multi_fp인데 FP 후보가 {len(external['rows'])}개다")

    original = discovery["periodograms"][0]
    if original["candidate_id"] is not None:
        raise TutorialError("123 결과의 첫 주기도가 제거 전 원본이 아니다")
    source = delivery["snapshot"]
    result = assemble(
        catalog=catalog, segmented=segmented, discovery=discovery, external=external,
        periodogram=dict(candidate_id=None, periods=original["periodogram"].periods.tolist(),
                         power=original["periodogram"].power.tolist()),
        segment_ids={str(s["sector"]): i + 1 for i, s in enumerate(sorted(segmented["segments"], key=lambda s: s["sector"]))},
        input_snapshot_ids=[snapshot, f"{source['snapshot_id']}:sha256:{source['sha256']}"],
        calculation_versions=dict(preprocessing=detrended.version, bls_config=iteration["bls_config_version"],
                                  residual_model=iteration["residual_model_version"],
                                  periodogram_config=discoverability.NUMERICAL_VERSION,
                                  candidate_quality=discovery["candidate_quality_revision"],
                                  ai_model=ai["model_version"], ai_threshold=ai["threshold_version"],
                                  external_matching=external["matching_rule_version"]),
        fold_reference_time_btjd=float(np.median(np.unique(prepared.time))), base_days=float(np.ptp(prepared.time)),
        ai_policy=ai, fine_tune=FINE_TUNE)
    return _ready("125 직렬화", result, value="validated"), attributes


def to_payload(result: dict, star: dict, attributes: dict, publish: dict) -> dict:
    """assemble 결과를 load.publish_star의 payload로 바꾼다. 판 본문 변환은 배치 run과 같은 run_source.gold_body다."""
    gold = result["payload"]
    body = gold_body(gold, {str(s["sector"]): {"cadence": "120s", "source_version": star["product"]["procver"]}
                            for s in gold["segments"]})
    bundle = body["bundle"]
    digest = payload_digest(bundle["bundle_version"], bundle["fold_reference_time_btjd"], bundle["base_days"],
                            body["segments"], body["periodogram"]["checksum"], bundle["manifest"]["record_checksums"])
    bundle["manifest"]["publish"] = {"payload_digest": digest, **publish}
    bundle["payload_digest"] = digest
    return {
        "tic_id": star["tic_id"], "label": f"튜토리얼 {star['seq']} {star['name']} (TIC {star['tic_id']})",
        "star": {**attributes, "confirmed_count": sum(c["record"]["is_confirmed"] for c in body["candidates"]),
                 "service_status": "published"},
        **body,
    }


def build(folder: Path, label_approval: str) -> list[dict]:
    """tutorial.json의 5개 별 payload를 만든다. 하나라도 실패하면 아무것도 내지 않는다."""
    if not label_approval.strip():
        raise TutorialError("튜토리얼 판정 규칙의 승인 근거가 필요하다(--label-approval)")
    tutorial = load_tutorial()
    code = {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
            for name in ("tutorial.json", "tutorial_source.py")}
    payloads = []
    for star in sorted(tutorial["stars"], key=lambda s: s["seq"]):
        result, attributes = assemble_star(star, folder, tutorial, label_approval)
        payloads.append(to_payload(result, star, attributes, {
            "jira": tutorial["jira"], "source": "tutorial", "seq": star["seq"], "intent": star["intent"],
            "selection": tutorial["selection"], "label_rule": tutorial["label_rule"]["version"],
            "label_approval": label_approval, "code_sha256": code}))
    return payloads

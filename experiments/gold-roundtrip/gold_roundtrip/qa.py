"""새 판 공개 전 payload 검사 (publication-qa.md 2절). DB 에 넣기 전에 Publisher 가 수행할 검사를 그대로 구현한다.

각 검사는 (이름, 통과 여부, 상세) 로 기록되고, 하나라도 실패하면 새 판은 PUBLISH_REJECTED 다.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from jsonschema import Draft202012Validator

from .canonical import ArrayCanonicalError, array_checksum, bundle_version, normalize_array, record_checksum

REPO = Path(__file__).resolve().parents[3]
SCHEMA_JSON = json.loads((REPO / "contracts" / "gold" / "transit-model.schema.json").read_text(encoding="utf-8"))
LC_SNAPSHOT_RE = re.compile(r"^lc:spoc:s\d{4}:sha256:[0-9a-f]{64}:procver:.+$")
ARCHIVE_SNAPSHOT_RE = re.compile(r"^archive:[a-z0-9_]+:sha256:[0-9a-f]{64}$")
MANIFEST_REQUIRED = ("segment_ids", "array_checksums", "residual_model_version", "periodogram_config_version", "binning", "period_grid", "fine_tune", "curve_steps")
N_PERIODS = 5000
PERIOD_MIN_DAYS = 0.5


def null_runs(values: list) -> list[list[int]]:
    runs, run = [], None
    for i, v in enumerate(values):
        if v is None:
            run = [i, i] if run is None else [run[0], i]
        elif run is not None:
            runs.append(run); run = None
    if run is not None:
        runs.append(run)
    return runs


def validate_payload(payload: dict) -> list[dict]:
    checks: list[dict] = []

    def add(name, ok, detail=""):
        checks.append({"check": name, "ok": bool(ok), "detail": str(detail)})

    seg_list, pg, cands, bundle = payload["segments"], payload["periodogram"], payload["candidates"], payload["bundle"]
    m = bundle["manifest"]
    add("manifest_required_keys", all(k in m for k in MANIFEST_REQUIRED), [k for k in MANIFEST_REQUIRED if k not in m])
    add("fold_reference_time_finite_float", isinstance(bundle["fold_reference_time_btjd"], float) and math.isfinite(bundle["fold_reference_time_btjd"]))

    for seg in seg_list:
        tag = f"segment:{seg['sector']}:{seg['binning_revision']}"
        try:
            norm = normalize_array(seg["flux"])                     # NULL 허용, NaN·Inf·overflow 거절
            add(f"{tag}:flux_values_valid", True)
        except ArrayCanonicalError as e:
            add(f"{tag}:flux_values_valid", False, f"{e.code} at {e.index}"); norm = None
        add(f"{tag}:flux_length_equals_n_points", len(seg["flux"]) == seg["n_points"], f"{len(seg['flux'])} vs {seg['n_points']}")
        runs = null_runs(seg["flux"])
        add(f"{tag}:gaps_equal_null_runs_both_directions", [list(g) for g in seg["gaps"]] == runs, f"gaps={seg['gaps']} null_runs={runs}")
        add(f"{tag}:gaps_in_range", all(0 <= a <= b < seg["n_points"] for a, b in seg["gaps"]))
        if norm is not None:
            key = f"{tag}:flux"
            add(f"{tag}:flux_checksum_matches", payload["checksums"].get(key) == array_checksum(norm), payload["checksums"].get(key, "")[:23])
        add(f"{tag}:start_btjd_finite", math.isfinite(seg["start_btjd"]) and seg["bin_minutes"] > 0)

    try:
        pnorm = normalize_array(pg["power"], allow_null=False)      # NULL 금지
        add("power_no_null_and_finite", True)
        add("power_checksum_matches", payload["checksums"].get("periodogram:power") == array_checksum(pnorm))
    except ArrayCanonicalError as e:
        add("power_no_null_and_finite", False, f"{e.code} at {e.index}")
    add("power_length_equals_n_periods", len(pg["power"]) == pg["n_periods"] == N_PERIODS)
    longest = max((c["period_days"] for c in cands), default=0.0)
    add("period_grid_rule", pg["period_min_days"] == PERIOD_MIN_DAYS and pg["period_max_days"] == max(40.0, round(longest * 1.15, 3)) and m["period_grid"]["spacing"] == "log",
        f"max={pg['period_max_days']} longest={longest}")

    validator = Draft202012Validator(SCHEMA_JSON)
    for c in cands:
        errors = list(validator.iter_errors({**c["transit_model"], "candidate_id": "c-0"}))
        add(f"transit_model_schema:{c.get('local_key', c.get('removal_step'))}", not errors, "; ".join(e.message for e in errors)[:160])
    steps = sorted(c["removal_step"] for c in cands)
    add("removal_steps_contiguous_from_zero", steps == list(range(len(cands))), steps)

    rc = m.get("record_checksums", {})
    add("candidates_checksum_matches", rc.get("candidates") == record_checksum("candidates", cands))
    add("ai_results_checksum_matches", rc.get("ai_results") == record_checksum("ai_results", payload.get("ai_results", [])))
    add("external_statuses_checksum_matches", rc.get("external_statuses") == record_checksum("external_statuses", payload.get("external_statuses", [])))

    semantic = {"input_snapshot_ids": m["input_snapshot_ids"],
                "segments": [{"tic_id": s["tic_id"], "sector": s["sector"], "binning_revision": s["binning_revision"]} for s in seg_list],
                "calculation_versions": m["calculation_versions"]}
    add("bundle_version_matches_69_rule", bundle_version(semantic) == bundle["bundle_version"])
    # 내용 기반 *형식* 검사: 형식이 계약과 같은지만 본다. 해시가 실제 원천 내용과 맞는지는 원천을 다시 읽어야 알 수 있어 여기서 증명하지 않는다.
    ids = m["input_snapshot_ids"]
    add("input_snapshot_ids_content_based_format",
        len(ids) >= 2 and any(LC_SNAPSHOT_RE.match(i) for i in ids) and any(ARCHIVE_SNAPSHOT_RE.match(i) for i in ids)
        and all(LC_SNAPSHOT_RE.match(i) or ARCHIVE_SNAPSHOT_RE.match(i) for i in ids), ids)

    exp = payload.get("expected_residuals", {}).get("cases", {})
    add("expected_residuals_present", {"remove_none", "remove_first", "remove_first_two", "remove_first_two_reversed", "remove_all"} <= set(exp))
    if "remove_first_two" in exp and "remove_first_two_reversed" in exp:
        add("residual_order_invariant", exp["remove_first_two"]["residual_checksum_f64"] == exp["remove_first_two_reversed"]["residual_checksum_f64"])
    return checks


def failed(checks: list[dict]) -> list[dict]:
    return [c for c in checks if not c["ok"]]

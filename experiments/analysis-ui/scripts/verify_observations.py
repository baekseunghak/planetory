"""Verify generated observations against every original FITS row, without BLS rerun."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.metadata
import json
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits

import export_observations as exporter


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer_array(values, name):
    require(all(type(value) is int for value in values), f"{name}: expected JSON integer rows")
    return np.asarray(values, dtype=np.int64)


def check_no_answers(value):
    if isinstance(value, dict):
        forbidden = {"t0", "epoch", "duration", "depth", "disposition", "transit_time"}
        require(not forbidden.intersection(value), "Fitted answer/classification field exposed")
        for nested in value.values():
            check_no_answers(nested)
    elif isinstance(value, list):
        for nested in value:
            check_no_answers(nested)


def verify_target(target, entry, source_root, output):
    path = output / entry["file"]
    require(path.parent.resolve() == output.resolve(), "Target file must be in the output folder")
    require(exporter.sha256(path) == entry["sha256"], "Target JSON differs from manifest hash")
    require(path.stat().st_size == entry["size_bytes"], "Target JSON byte count differs")
    data = json.loads(path.read_text(encoding="utf-8"))
    for field in ("id", "label", "tic_id", "point_count", "sectors", "bundle_id"):
        require(data[field] == entry[field], f"Manifest/target mismatch: {field}")
    require(data["id"] == target["id"] and data["tic_id"] == target["tic_id"], "Unexpected target identity")
    require(data["sectors"] == target["sectors"], "Unexpected target Sectors")
    require(data["schema_version"] == "analysis-observations-v1", "Unsupported observation schema")
    provenance = data["provenance"]
    require(provenance["pipeline_sha256"] == exporter.sha256(exporter.PIPELINE_PATH), "Pipeline changed; regenerate or verify with the recorded version")
    require(provenance["exporter_sha256"] == exporter.sha256(Path(exporter.__file__)), "Exporter differs from recorded version")
    require(provenance["processing"] == exporter.PROCESSING, "Processing configuration mismatch")
    for package, version in provenance["package_versions"].items():
        require(importlib.metadata.version(package) == version, f"Recorded {package} version required for exact cleaning comparison")
    t = np.asarray(data["time_btjd"], dtype=np.float64)
    flux = np.asarray(data["normalized_flux"], dtype=np.float64)
    source_indices = integer_array(data["point_source_index"], "source_index")
    source_rows = integer_array(data["point_source_row"], "source_row")
    n = data["point_count"]
    require(all(len(values) == n for values in (t, flux, source_indices, source_rows)), "Observation array length mismatch")
    require(np.all(np.isfinite(t)) and np.all(np.isfinite(flux)) and np.all(flux > 0), "Invalid observation values")
    require(np.all(np.diff(t) > 0), "Observations must remain unique and time-ordered")

    frames, source_results, observed_sectors = [], [], []
    calculated_counts = {key: 0 for key in ("raw", "eligible_before_clean", "retained", "quality_nonzero", "nonfinite", "nonpositive_flux", "upper_sigma_clip")}
    sources = provenance["sources"]
    require(set(source_indices.tolist()) == set(range(len(sources))), "Missing or unknown source index")
    for source_index, source in enumerate(sources):
        require(source["source_index"] == source_index, "Unordered source metadata")
        source_path = source_root / target["folder"] / Path(source["relative_path"]).name
        require(exporter.sha256(source_path) == source["sha256"], f"Source hash mismatch: {source_path.name}")
        require(source_path.stat().st_size == source["size_bytes"], "Source byte count mismatch")
        with fits.open(source_path, mode="readonly", memmap=False) as hdul:
            header, time_header, raw = hdul[0].header, hdul[1].header, hdul[1].data
            require(str(header["TICID"]) == target["tic_id"], "Original TIC differs")
            require(int(header["SECTOR"]) == source["sector"], "Original Sector differs")
            require(time_header["BJDREFI"] == 2457000 and time_header.get("BJDREFF", 0.0) == 0.0, "Original TIME is not expected BTJD")
            raw_t, raw_f = np.asarray(raw["TIME"], dtype=np.float64), np.asarray(raw["PDCSAP_FLUX"], dtype=np.float64)
            raw_q = np.asarray(raw["QUALITY"], dtype=np.int64)
            quality_ok = raw_q == 0
            finite = np.isfinite(raw_t) & np.isfinite(raw_f)
            # Independently derive the raw input masks rather than trusting JSON counts.
            input_masks = {"quality_nonzero": ~quality_ok, "nonfinite": quality_ok & ~finite, "nonpositive_flux": quality_ok & finite & (raw_f <= 0)}
            eligible = quality_ok & finite & (raw_f > 0)
            selected = source_indices == source_index
            rows = source_rows[selected]
            require(np.all((rows >= 0) & (rows < len(raw))), "Source row out of bounds")
            require(np.array_equal(raw_t[rows], t[selected]), "Output TIME differs from original FITS row")
            require(np.all(eligible[rows]), "Output contains an ineligible original row")
            assigned = np.zeros(len(raw), dtype=np.int64)
            np.add.at(assigned, rows, 1)
            for reason, excluded_values in source["excluded_rows"].items():
                require(reason in (*input_masks, "upper_sigma_clip"), "Unknown row exclusion reason")
                excluded = integer_array(excluded_values, reason)
                require(np.all((excluded >= 0) & (excluded < len(raw))), "Excluded source row out of bounds")
                np.add.at(assigned, excluded, 1)
                calculated_counts[reason] += len(excluded)
                if reason in input_masks:
                    require(np.array_equal(np.sort(excluded), np.flatnonzero(input_masks[reason])), f"Incorrect {reason} mask")
                else:
                    require(np.all(eligible[excluded]), "Clipped rows must pass original input filtering")
            require(np.all(assigned == 1), "Raw rows are missing, duplicated, or in overlapping masks")
            require(source["raw_point_count"] == len(raw), "Raw count mismatch")
            require(source["eligible_point_count"] == int(eligible.sum()), "Eligible count mismatch")
            require(source["retained_point_count"] == int(selected.sum()), "Retained count mismatch")
            calculated_counts["raw"] += len(raw)
            calculated_counts["eligible_before_clean"] += int(eligible.sum())
            calculated_counts["retained"] += int(selected.sum())
            frames.append(pd.DataFrame({"time": raw_t[eligible], "flux": raw_f[eligible], "quality": raw_q[eligible], "observation_group": int(header["SECTOR"])}))
            observed_sectors.append(int(header["SECTOR"]))
            source_results.append({"basename": source_path.name, "sha256": source["sha256"], "sector": source["sector"], "raw": len(raw), "eligible": int(eligible.sum()), "retained": int(selected.sum()), "upper_sigma_clip": len(source["excluded_rows"]["upper_sigma_clip"])})
    require(sorted(observed_sectors) == sorted(target["sectors"]), "Original Sector set mismatch")
    require(calculated_counts == provenance["quality_counts"], "Aggregate quality counts mismatch")
    frame = pd.concat(frames, ignore_index=True)
    original_reference = float(np.median(frame["time"].to_numpy(np.float64)))
    require(original_reference.hex() == float(data["fold_reference_time_btjd"]).hex(), "Reference differs at float64 precision")
    require(provenance["reference_population"] == "eligible_before_clean" and provenance["reference_is_fixed"] is True, "Reference rule not pinned")
    # Re-run only deterministic cleaning, using all eligible source rows from all Sectors.
    recomputed, _ = exporter.clean(frame, **provenance["processing"]["clean"])
    require(recomputed is not None, "Source cleaning failed")
    require(np.array_equal(recomputed[0], t), "Whole-data cleaning TIME output differs")
    require(np.array_equal(recomputed[1], flux), "Whole-data cleaned flux differs at float64 precision")
    periods = np.asarray(data["periodogram"]["period_days"], dtype=np.float64)
    power = np.asarray(data["periodogram"]["power"], dtype=np.float64)
    require(periods.shape == power.shape == (8000,), "Expected all 8,000 BLS points")
    require(np.all(np.isfinite(periods)) and np.all(np.isfinite(power)), "Nonfinite BLS values")
    require(np.array_equal(periods, np.linspace(0.5, 40.0, 8000)), "BLS period grid differs")
    check_no_answers(data)
    return {"id": target["id"], "label": target["label"], "bundle_id": data["bundle_id"], "counts": calculated_counts, "reference": original_reference, "reference_hex": original_reference.hex(), "sources": source_results, "bytes": path.stat().st_size, "BLS_points": len(periods), "recorded_bls_seconds": provenance["bls_seconds"]}


def report_markdown(results):
    lines = ["# TESS 관측 export 검증 기록", "", f"검증 시각: {datetime.now(timezone.utc).isoformat()}", "", "`scripts/verify_observations.py`를 실제 로컬 FITS 7개와 생성 JSON 전체에 실행한 결과입니다. 원본·생성 데이터는 읽기만 했습니다.", "", "| 대상 | 원본 행 | 정제 전 유효점 | 출력 점 | 상단 clip | 고정 기준 시각 (BTJD) | BLS 점 |", "|---|---:|---:|---:|---:|---:|---:|"]
    for result in results:
        counts = result["counts"]
        lines.append(f"| {result['label']} | {counts['raw']:,} | {counts['eligible_before_clean']:,} | {counts['retained']:,} | {counts['upper_sigma_clip']:,} | {result['reference']!r} | {result['BLS_points']:,} |")
    lines.extend(["", "검증 항목: manifest/원본 SHA-256, 파일 크기·TIC·Sector, 모든 출력점의 원본 TIME/행 일치, 품질·비유한·비양수·상단 clip 마스크의 정확한 분할, 기준 시각의 float64 일치, 전체 유효점 재정제 TIME/flux의 float64 완전 일치, 8,000개 BLS 격자·유한 power, fitted epoch/duration/depth·disposition 필드 미노출.", "", "BLS power를 다시 계산한 회귀 검증은 하지 않았습니다. 관측 구간의 과학적 적합성, 천체 분류의 정확성, 브라우저 렌더링·Worker·포인터 조작·UI 성능 검증도 이 기록의 범위가 아닙니다.", "", "CM Dra는 원본 필터를 통과한 14,900점 중 기존 pipeline.clean의 상단 5-MAD 규칙으로 3,342점이 제외되었습니다. 출력 11,558점은 이 정제 결과 전체이며, 원본 유효점 전체와는 구분해야 합니다. 이 검증은 기존 정제 재현성을 확인하며 해당 clipping의 과학적 적절성을 보증하지 않습니다.", "", "## 원본 파일별 추적", "", "| 원본 파일명 | Sector | 원본 | 유효 | 출력 | 상단 clip | SHA-256 |", "|---|---:|---:|---:|---:|---:|---|"])
    for result in results:
        for source in result["sources"]:
            lines.append(f"| `{source['basename']}` | {source['sector']} | {source['raw']} | {source['eligible']} | {source['retained']} | {source['upper_sigma_clip']} | `{source['sha256']}` |")
    lines.extend(["", "## Bundle과 정밀도", "", "| 대상 | Bundle | 기준 시각 float64 hex |", "|---|---|---|"])
    for result in results:
        lines.append(f"| {result['label']} | `{result['bundle_id']}` | `{result['reference_hex']}` |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=exporter.WORKSPACE / "archive/TESS_BLS_semi_auto/sample_raw/tess")
    parser.add_argument("--output", type=Path, default=exporter.EXPERIMENT / "public/observations", help="Existing generated JSON directory; read only")
    parser.add_argument("--report", type=Path, help="Optional Markdown evidence report to write")
    args = parser.parse_args()
    manifest = json.loads((args.output / "manifest.json").read_text(encoding="utf-8"))
    entries = {entry["id"]: entry for entry in manifest["targets"]}
    require(len(entries) == len(manifest["targets"]) == len(exporter.TARGETS), "Missing or duplicate manifest target")
    require(set(entries) == {target["id"] for target in exporter.TARGETS}, "Unexpected manifest target set")
    results = []
    for target in exporter.TARGETS:
        result = verify_target(target, entries[target["id"]], args.source_root, args.output)
        results.append(result)
        print(json.dumps({"id": result["id"], "verified_points": result["counts"]["retained"], "whole_data_cleaning_exact": True, "source_hashes_and_masks_exact": True, "reference_float64_exact": True, "BLS_points": result["BLS_points"]}), flush=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report_markdown(results), encoding="utf-8")
        print(f"Report: {args.report}", flush=True)


if __name__ == "__main__":
    main()

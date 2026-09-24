"""Build versioned TESS Silver curves and initial BLS results per TIC.

The public boundary of this job is the Parquet schema returned by ``_schemas``.
Each TIC produces exactly one manifest row, so a data/science failure can be
retried without discarding successful TICs from the same Spark application.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Mapping

import numpy as np

from astro_kernel.bls import BlsError, QUALITY_VERSION, SEARCH_VERSION, search_bls
from astro_kernel.iteration import ITERATION_VERSION, iterate_bls
from astro_kernel.preprocessing import (
    MASK_CONTRACT_VERSION,
    PREPROCESS_VERSION,
    IntervalMask,
    PreprocessError,
    SectorInput,
    exclusion_ledger,
    preprocess_silver,
)


BRONZE_SCHEMA_VERSION = "planetory.tess-bronze.v1"
SILVER_MANIFEST_SCHEMA_VERSION = "planetory.tess-silver-stage.v4"
SILVER_SUMMARY_SCHEMA_VERSION = "planetory.tess-silver-summary.v4"
# Iteration stops the kernel reached by its own quality verdict. They are science outcomes of a
# completed run, not processing failures: the same input and config always give the same answer.
ITERATION_QA_STOP_TERMINATIONS = frozenset({"removal_qa_failed", "candidate_validation_failed"})
SILVER_TERMINAL_SCHEMA_VERSION = "planetory.tess-silver-terminal.v1"
PROVENANCE_STATUS = "quality0_baseline_pending_interval_mask"
MASKED_PROVENANCE_STATUS = "interval_mask_contract_applied"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
RUN_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z")
VERSION_RE = re.compile(r"[A-Za-z0-9._-]+")
REQUIRED_BRONZE_COLUMNS = {
    "tic_id",
    "sector",
    "product_id",
    "time",
    "flux",
    "flux_err",
    "quality",
    "cadenceno",
    "raw_sha256",
    "input_snapshot_id",
    "schema_version",
    "pipeline_version",
}


class SilverContractError(RuntimeError):
    """A deterministic application-level input/output contract violation."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


@dataclass(frozen=True)
class TicStageResult:
    """One isolated TIC result consumed by the Silver Parquet outputs."""

    target: tuple | None
    periodogram: tuple | None
    manifest: tuple
    iteration: tuple | None = None
    iteration_manifest: tuple | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _clean_message(value: object) -> str:
    return " ".join(str(value).split())[:500]


def input_snapshot_id(rows: Iterable[Mapping[str, Any]]) -> str:
    """Hash the sorted Bronze product lineage for one TIC."""
    values = []
    for row in rows:
        product_id = str(row.get("product_id", "")).strip()
        snapshot = str(row.get("input_snapshot_id", "")).strip()
        raw_sha256 = str(row.get("raw_sha256", "")).strip()
        if not product_id or not snapshot or not SHA256_RE.fullmatch(raw_sha256):
            raise PreprocessError("invalid_lineage", product_id or "missing product_id")
        values.append(f"{product_id}\t{snapshot}\t{raw_sha256}")
    if not values:
        raise PreprocessError("empty_input", "no Bronze products")
    digest = hashlib.sha256(("\n".join(sorted(values)) + "\n").encode()).hexdigest()
    return f"bronze-products-sha256:{digest}"


def _json(value: object) -> str:
    def convert(item: object) -> object:
        if isinstance(item, np.ndarray):
            return [convert(child) for child in item.tolist()]
        if isinstance(item, np.generic):
            return item.item()
        if isinstance(item, dict):
            return {str(key): convert(child) for key, child in item.items()}
        if isinstance(item, (list, tuple)):
            return [convert(child) for child in item]
        return item

    return json.dumps(convert(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def _floats(value: object) -> list[float]:
    return np.asarray(value, dtype=float).tolist()


def _ints(value: object) -> list[int]:
    return np.asarray(value, dtype=np.int64).tolist()


def _strict_exclusions(rows: Iterable[Mapping[str, Any]]) -> list[dict]:
    """Encode preparation exclusions the way ``exclusion_ledger`` does.

    Real SPOC curves carry NaN times in data gaps. Strict JSON has no NaN, so a
    non-finite original time becomes null plus its original spelling.
    """
    encoded = []
    for row in rows:
        item = dict(row)
        value = item.get("original_time")
        if isinstance(value, float) and not np.isfinite(value):
            item["original_time_nonfinite"] = "NaN" if np.isnan(value) else "+Infinity" if value > 0 else "-Infinity"
            item["original_time"] = None
        encoded.append(item)
    return encoded


def _target_row(prepared: object, detrended: object, snapshot: str) -> tuple:
    ledger = exclusion_ledger(prepared, detrended)
    kept_count = int(np.asarray(detrended.kept).sum())
    if int(prepared.n_raw) != kept_count + len(ledger):
        raise PreprocessError("provenance_mismatch", "raw rows must equal kept rows plus exclusions")
    provenance_status = MASKED_PROVENANCE_STATUS if prepared.interval_masks else PROVENANCE_STATUS
    return (
        int(prepared.tic_id),
        snapshot,
        str(detrended.version),
        str(detrended.status),
        provenance_status,
        _floats(prepared.time),
        _floats(prepared.flux),
        _floats(prepared.flux_err),
        _ints(prepared.sector),
        [str(value) for value in prepared.product_id],
        _ints(prepared.source_row),
        _ints(prepared.cadenceno),
        _ints(prepared.original_quality),
        _floats(detrended.trend),
        _floats(detrended.flux_det),
        np.asarray(detrended.kept, dtype=bool).tolist(),
        _ints(detrended.segment_id),
        _json(prepared.normalization_median),
        _json(_strict_exclusions(prepared.excluded)),
        _json(detrended.failures),
        MASK_CONTRACT_VERSION,
        _json(prepared.interval_masks),
        _json(ledger),
        int(prepared.n_raw),
        int(len(prepared.time)),
        kept_count,
        int(len(ledger)),
    )


def _periodogram_row(tic_id: int, result: Mapping[str, Any]) -> tuple:
    periodogram = result["periodogram"]
    return (
        tic_id,
        str(result["input_snapshot_id"]),
        str(result["status"]),
        str(result["preprocessing_version"]),
        str(result["bls_config_version"]),
        str(result["candidate_quality_version"]),
        _floats(periodogram.periods),
        _floats(periodogram.power),
        _floats(periodogram.epoch_btjd),
        _floats(periodogram.duration_hours),
        _floats(periodogram.depth),
        _floats(periodogram.depth_err),
        _floats(periodogram.snr),
        _floats(periodogram.sde),
        np.asarray(periodogram.valid_input, dtype=bool).tolist(),
        _json(periodogram.config),
        _json(result["peaks"]),
        _json(result["accepted_peaks"]),
        int(result["n_input"]),
        int(result["n_valid"]),
        int(result["n_accepted"]),
    )


def science_audit(result: TicStageResult) -> dict[str, Any]:
    """Return bounded Canary evidence without retaining the large Parquet outputs."""
    manifest = result.manifest
    audit: dict[str, Any] = {
        "tic_id": int(manifest[3]),
        "status": str(manifest[5]),
        "input_snapshot_id": manifest[7],
        "provenance_status": manifest[12],
        "mask_contract_version": manifest[13],
        "interval_mask_count": int(manifest[14]),
        "error_code": manifest[18],
        "error_detail": manifest[19],
    }
    if result.target is not None:
        audit.update({
            "sectors": sorted(set(int(value) for value in result.target[8])),
            "raw_observation_count": int(result.target[23]),
            "prepared_observation_count": int(result.target[24]),
            "kept_observation_count": int(result.target[25]),
            "excluded_observation_count": int(result.target[26]),
        })
    if result.periodogram is not None:
        peaks = json.loads(result.periodogram[17])[:5]
        audit.update({
            "input_count": int(result.periodogram[18]),
            "valid_input_count": int(result.periodogram[19]),
            "accepted_peak_count": int(result.periodogram[20]),
            "accepted_peaks": [
                {key: peak.get(key) for key in (
                    "rank", "period_days", "epoch_btjd", "duration_hours", "depth",
                    "snr", "sde", "n_transits", "sector_consistency_status",
                )}
                for peak in peaks
            ],
        })
    if result.iteration_manifest is not None:
        audit.update(iteration_status=result.iteration_manifest[5],
                     iteration_error_code=result.iteration_manifest[18])
    if result.iteration is not None:
        audit.update(iteration_termination=result.iteration[3],
                     iteration_complete=result.iteration[4],
                     iteration_accepted_count=result.iteration[5])
    return audit


def _manifest_row(
    *,
    run_id: str,
    attempt_id: str,
    tic_id: int,
    status: str,
    retryable: bool,
    snapshot: str | None,
    pipeline_version: str,
    preprocessing_version: str | None,
    target_location: str | None,
    periodogram_location: str | None,
    provenance_status: str = PROVENANCE_STATUS,
    interval_mask_count: int = 0,
    stage: str = "initial_bls",
    iteration_location: str | None = None,
    error_code: str | None = None,
    error_detail: object | None = None,
) -> tuple:
    return (
        SILVER_MANIFEST_SCHEMA_VERSION,
        run_id,
        attempt_id,
        tic_id,
        stage,
        status,
        retryable,
        snapshot,
        pipeline_version,
        preprocessing_version,
        SEARCH_VERSION,
        QUALITY_VERSION,
        provenance_status,
        MASK_CONTRACT_VERSION,
        interval_mask_count,
        target_location,
        periodogram_location,
        iteration_location,
        error_code,
        None if error_detail is None else _clean_message(error_detail),
    )


def process_tic(
    rows: Iterable[Mapping[str, Any]],
    *,
    run_id: str,
    attempt_id: str,
    pipeline_version: str,
    target_location: str,
    periodogram_location: str,
    iteration_location: str | None = None,
    interval_masks: Iterable[IntervalMask] = (),
    preprocess: Callable[..., tuple[Any, Any]] = preprocess_silver,
    search: Callable[..., Mapping[str, Any]] = search_bls,
    iterate: Callable[..., Mapping[str, Any]] = iterate_bls,
) -> TicStageResult:
    """Run one TIC without allowing its data/science failure to abort siblings."""
    tic_id = -1
    snapshot = None
    target = None
    provenance_status = PROVENANCE_STATUS
    interval_mask_count = 0
    reading_bronze = True  # a KeyError/TypeError/ValueError here means a malformed Bronze row
    try:
        products = sorted((dict(row) for row in rows), key=lambda row: (row["sector"], row["product_id"]))
        tic_id = int(products[0]["tic_id"]) if products else -1
        if tic_id <= 0 or any(int(row["tic_id"]) != tic_id for row in products):
            raise PreprocessError("mixed_tic", "one positive TIC per call")
        snapshot = input_snapshot_id(products)
        curves = [
            SectorInput(
                tic_id=tic_id,
                sector=int(row["sector"]),
                product_id=str(row["product_id"]),
                time=np.asarray(row["time"]),
                flux=np.asarray(row["flux"]),
                flux_err=np.asarray(row["flux_err"]),
                quality=np.asarray(row["quality"]),
                cadenceno=np.asarray(row["cadenceno"]),
                source_sha256=str(row["raw_sha256"]),
            )
            for row in products
        ]
        reading_bronze = False
        prepared, detrended = preprocess(curves, interval_masks=tuple(interval_masks))
        interval_mask_count = len(prepared.interval_masks)
        provenance_status = MASKED_PROVENANCE_STATUS if interval_mask_count else PROVENANCE_STATUS
        target = _target_row(prepared, detrended, snapshot)
        if detrended.status != "ok":
            return TicStageResult(
                target,
                None,
                _manifest_row(
                    run_id=run_id,
                    attempt_id=attempt_id,
                    tic_id=tic_id,
                    status="failed",
                    retryable=False,
                    snapshot=snapshot,
                    pipeline_version=pipeline_version,
                    preprocessing_version=detrended.version,
                    target_location=target_location,
                    periodogram_location=None,
                    provenance_status=provenance_status,
                    interval_mask_count=interval_mask_count,
                    error_code=detrended.status,
                    error_detail=f"preprocessing status={detrended.status}",
                ),
            )
        result = search(
            prepared.time,
            detrended.flux_det,
            input_snapshot_id=snapshot,
            preprocessing_version=detrended.version,
            sector=prepared.sector,
            baseline_time=prepared.time,
        )
        periodogram = _periodogram_row(tic_id, result)
        status = str(result["status"])
        manifest_status = "succeeded" if status == "ok" else status
        if manifest_status not in {"succeeded", "no_quality_peak", "failed"}:
            raise BlsError("invalid_output", f"unknown BLS status={status}")
        initial_manifest = _manifest_row(
            run_id=run_id, attempt_id=attempt_id, tic_id=tic_id,
            status=manifest_status, retryable=False, snapshot=snapshot,
            pipeline_version=pipeline_version, preprocessing_version=detrended.version,
            target_location=target_location, periodogram_location=periodogram_location,
            provenance_status=provenance_status, interval_mask_count=interval_mask_count,
            error_code="bls_failed" if manifest_status == "failed" else None,
            error_detail="BLS returned failed peak geometry" if manifest_status == "failed" else None,
        )
        if manifest_status == "failed" or iteration_location is None:
            return TicStageResult(target, periodogram, initial_manifest)
        try:
            iteration = iterate(
                prepared.time, detrended.flux_det, input_snapshot_id=snapshot,
                preprocessing_version=detrended.version, sector=prepared.sector,
                baseline_time=prepared.time, initial_search=result,
            )
            if (iteration["input_snapshot_id"] != snapshot or
                    iteration["preprocessing_version"] != detrended.version or
                    iteration["iteration_version"] != ITERATION_VERSION or
                    iteration["bls_config_version"] != SEARCH_VERSION or
                    iteration["candidate_quality_version"] != QUALITY_VERSION or
                    iteration["status"] not in {"ok", "incomplete", "failed"} or
                    type(iteration["complete"]) is not bool or
                    iteration["complete"] != (iteration["status"] == "ok") or
                    (iteration["status"] == "ok") != (iteration["termination"] in
                        {"no_quality_peak", "duplicate_or_harmonic_only"}) or
                    (iteration["status"] == "incomplete") != (iteration["termination"] == "max_iterations_reached") or
                    not SHA256_RE.fullmatch(iteration["iteration_config_sha256"]) or
                    int(iteration["n_accepted"]) != len(iteration["accepted"])):
                raise BlsError("invalid_output", "iteration metadata or completion disagrees")
            iteration_row = (
                tic_id, snapshot, str(iteration["status"]), str(iteration["termination"]),
                iteration["complete"], int(iteration["n_accepted"]), ITERATION_VERSION,
                str(iteration["iteration_config_sha256"]), SEARCH_VERSION, QUALITY_VERSION,
                str(detrended.version), _json(iteration),
            )
            stage_status = "succeeded" if iteration["status"] == "ok" else str(iteration["status"])
            if stage_status == "failed" and iteration["termination"] in ITERATION_QA_STOP_TERMINATIONS:
                stage_status = "qa_stopped"
            stage_error = iteration["termination"] if stage_status != "succeeded" else None
            retryable = False
        except MemoryError:
            raise
        except Exception as exc:
            iteration_row = None
            stage_status, stage_error = "failed", getattr(exc, "code", "unexpected_iteration_error")
            retryable = not isinstance(exc, (BlsError, KeyError, TypeError, ValueError))
        iteration_manifest = _manifest_row(
            run_id=run_id, attempt_id=attempt_id, tic_id=tic_id,
            status=stage_status, retryable=retryable, snapshot=snapshot,
            pipeline_version=pipeline_version, preprocessing_version=detrended.version,
            target_location=target_location, periodogram_location=None,
            provenance_status=provenance_status, interval_mask_count=interval_mask_count,
            stage="iteration", iteration_location=iteration_location if iteration_row is not None else None,
            error_code=stage_error, error_detail=stage_error,
        )
        return TicStageResult(target, periodogram, initial_manifest, iteration_row, iteration_manifest)
    except MemoryError:
        raise
    except Exception as exc:  # one TIC failure must not discard sibling TICs
        if isinstance(exc, (PreprocessError, BlsError)) or (
                reading_bronze and isinstance(exc, (KeyError, TypeError, ValueError))):
            code, retryable, detail = getattr(exc, "code", "invalid_bronze_row"), False, exc
        else:
            # A defect in this code must not read as bad Bronze input; the 2026-09-23 Canary
            # NaN serialization bug was reported as invalid_bronze_row before this split.
            code, retryable, detail = "unexpected_processing_error", True, f"{type(exc).__name__}: {exc}"
        return TicStageResult(
            target,
            None,
            _manifest_row(
                run_id=run_id,
                attempt_id=attempt_id,
                tic_id=tic_id,
                status="failed",
                retryable=retryable,
                snapshot=snapshot,
                pipeline_version=pipeline_version,
                preprocessing_version=PREPROCESS_VERSION if target is not None else None,
                target_location=target_location if target is not None else None,
                periodogram_location=None,
                provenance_status=provenance_status,
                interval_mask_count=interval_mask_count,
                error_code=str(code),
                error_detail=detail,
            ),
        )


def _schemas(types: object) -> tuple[object, object, object, object, object]:
    array_double = types.ArrayType(types.DoubleType(), False)
    array_long = types.ArrayType(types.LongType(), False)
    target = types.StructType([
        types.StructField("tic_id", types.LongType(), False),
        types.StructField("input_snapshot_id", types.StringType(), False),
        types.StructField("preprocessing_version", types.StringType(), False),
        types.StructField("preprocessing_status", types.StringType(), False),
        types.StructField("provenance_status", types.StringType(), False),
        types.StructField("time", array_double, False),
        types.StructField("normalized_flux", array_double, False),
        types.StructField("flux_err", array_double, False),
        types.StructField("sector", array_long, False),
        types.StructField("product_id", types.ArrayType(types.StringType(), False), False),
        types.StructField("source_row", array_long, False),
        types.StructField("cadenceno", array_long, False),
        types.StructField("original_quality", array_long, False),
        types.StructField("trend", array_double, False),
        types.StructField("cleaned_flux", array_double, False),
        types.StructField("kept", types.ArrayType(types.BooleanType(), False), False),
        types.StructField("segment_id", array_long, False),
        types.StructField("normalization_median_json", types.StringType(), False),
        types.StructField("excluded_json", types.StringType(), False),
        types.StructField("detrend_failures_json", types.StringType(), False),
        types.StructField("mask_contract_version", types.StringType(), False),
        types.StructField("interval_masks_json", types.StringType(), False),
        types.StructField("exclusion_ledger_json", types.StringType(), False),
        types.StructField("raw_observation_count", types.LongType(), False),
        types.StructField("prepared_observation_count", types.LongType(), False),
        types.StructField("kept_observation_count", types.LongType(), False),
        types.StructField("excluded_observation_count", types.LongType(), False),
    ])
    periodogram = types.StructType([
        types.StructField("tic_id", types.LongType(), False),
        types.StructField("input_snapshot_id", types.StringType(), False),
        types.StructField("search_status", types.StringType(), False),
        types.StructField("preprocessing_version", types.StringType(), False),
        types.StructField("bls_config_version", types.StringType(), False),
        types.StructField("candidate_quality_version", types.StringType(), False),
        *[types.StructField(name, array_double, False) for name in (
            "period_days", "power", "epoch_btjd", "duration_hours", "depth", "depth_err", "snr", "sde"
        )],
        types.StructField("valid_input", types.ArrayType(types.BooleanType(), False), False),
        types.StructField("config_json", types.StringType(), False),
        types.StructField("peaks_json", types.StringType(), False),
        types.StructField("accepted_peaks_json", types.StringType(), False),
        types.StructField("input_count", types.LongType(), False),
        types.StructField("valid_input_count", types.LongType(), False),
        types.StructField("accepted_peak_count", types.LongType(), False),
    ])
    manifest = types.StructType([
        types.StructField("schema_version", types.StringType(), False),
        types.StructField("run_id", types.StringType(), False),
        types.StructField("attempt_id", types.StringType(), False),
        types.StructField("tic_id", types.LongType(), False),
        types.StructField("stage", types.StringType(), False),
        types.StructField("status", types.StringType(), False),
        types.StructField("retryable", types.BooleanType(), False),
        types.StructField("input_snapshot_id", types.StringType(), True),
        types.StructField("pipeline_version", types.StringType(), False),
        types.StructField("preprocessing_version", types.StringType(), True),
        types.StructField("bls_config_version", types.StringType(), False),
        types.StructField("candidate_quality_version", types.StringType(), False),
        types.StructField("provenance_status", types.StringType(), False),
        types.StructField("mask_contract_version", types.StringType(), False),
        types.StructField("interval_mask_count", types.LongType(), False),
        types.StructField("target_location", types.StringType(), True),
        types.StructField("periodogram_location", types.StringType(), True),
        types.StructField("iteration_location", types.StringType(), True),
        types.StructField("error_code", types.StringType(), True),
        types.StructField("error_detail", types.StringType(), True),
    ])
    summary = types.StructType([
        types.StructField("schema_version", types.StringType(), False),
        types.StructField("run_id", types.StringType(), False),
        types.StructField("attempt_id", types.StringType(), False),
        types.StructField("bronze_coverage_sha256", types.StringType(), False),
        types.StructField("bronze_coverage_ready_sha256", types.StringType(), False),
        types.StructField("bronze_pipeline_version", types.StringType(), False),
        types.StructField("pipeline_version", types.StringType(), False),
        types.StructField("selected_tics", types.LongType(), False),
        types.StructField("manifest_tics", types.LongType(), False),
        types.StructField("succeeded_tics", types.LongType(), False),
        types.StructField("no_quality_peak_tics", types.LongType(), False),
        types.StructField("failed_tics", types.LongType(), False),
        types.StructField("retryable_failed_tics", types.LongType(), False),
        types.StructField("iteration_tics", types.LongType(), False),
        types.StructField("iteration_succeeded_tics", types.LongType(), False),
        types.StructField("iteration_incomplete_tics", types.LongType(), False),
        types.StructField("iteration_qa_stopped_tics", types.LongType(), False),
        types.StructField("iteration_failed_tics", types.LongType(), False),
        types.StructField("contract_ok", types.BooleanType(), False),
        types.StructField("science_audit_json", types.StringType(), False),
        types.StructField("completed_at_utc", types.StringType(), False),
    ])
    iteration = types.StructType([
        types.StructField("tic_id", types.LongType(), False),
        types.StructField("input_snapshot_id", types.StringType(), False),
        types.StructField("status", types.StringType(), False),
        types.StructField("termination", types.StringType(), False),
        types.StructField("complete", types.BooleanType(), False),
        types.StructField("accepted_count", types.LongType(), False),
        types.StructField("iteration_version", types.StringType(), False),
        types.StructField("iteration_config_sha256", types.StringType(), False),
        types.StructField("bls_config_version", types.StringType(), False),
        types.StructField("candidate_quality_version", types.StringType(), False),
        types.StructField("preprocessing_version", types.StringType(), False),
        types.StructField("result_json", types.StringType(), False),
    ])
    return target, periodogram, manifest, summary, iteration


def _write_terminal_marker(spark: object, args: argparse.Namespace, error: SilverContractError) -> None:
    payload = json.dumps({
        "schema_version": SILVER_TERMINAL_SCHEMA_VERSION,
        "failure_type": "data_contract",
        "error_code": error.code,
        "error_detail": _clean_message(error),
        "run_id": args.run_id,
        "attempt_id": args.attempt_id,
        "completed_at_utc": utc_now(),
    }, sort_keys=True, separators=(",", ":"))
    spark.sparkContext.parallelize([payload], 1).saveAsTextFile(f"{args.output}/_TERMINAL")


def run(args: argparse.Namespace) -> None:
    from pyspark import StorageLevel
    from pyspark.sql import SparkSession, functions, types

    spark = SparkSession.builder.appName(f"S15P21C206-78-silver-{args.run_id}-{args.attempt_id}").getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    target_schema, periodogram_schema, manifest_schema, summary_schema, iteration_schema = _schemas(types)
    try:
        try:
            bronze = spark.read.parquet(*args.bronze_path)
            missing = sorted(REQUIRED_BRONZE_COLUMNS - set(bronze.columns))
            if missing:
                raise SilverContractError("bronze_missing_columns", ",".join(missing))
            if args.tic_id:
                bronze = bronze.filter(functions.col("tic_id").isin(args.tic_id))
            if args.retry_manifest:
                failed = spark.read.parquet(args.retry_manifest).filter(
                    functions.col("status").isin("failed", "incomplete")
                ).select("tic_id").distinct()
                bronze = bronze.join(failed, "tic_id", "inner")
            if bronze.filter(functions.col("schema_version") != BRONZE_SCHEMA_VERSION).limit(1).count():
                raise SilverContractError("bronze_schema_mismatch", BRONZE_SCHEMA_VERSION)
            if bronze.filter(functions.col("pipeline_version") != args.bronze_pipeline_version).limit(1).count():
                raise SilverContractError("bronze_pipeline_version_mismatch", args.bronze_pipeline_version)
            if bronze.filter(
                functions.col("tic_id").isNull()
                | (functions.col("tic_id") <= 0)
                | functions.col("sector").isNull()
                | ~functions.col("sector").between(1, 13)
            ).limit(1).count():
                raise SilverContractError("bronze_invalid_identity", "positive TIC and Sector 1 through 13 required")
            if not args.tic_id and not args.retry_manifest:
                sectors = {int(row[0]) for row in bronze.select("sector").distinct().toLocalIterator()}
                if sectors != set(range(1, 14)):
                    raise SilverContractError("bronze_sector_coverage_mismatch", str(sorted(sectors)))
            selected_ids = bronze.select("tic_id").distinct().cache()
            selected_tics = selected_ids.count()
            if selected_tics <= 0:
                raise SilverContractError("empty_tic_selection", "no TIC selected")
        except SilverContractError as exc:
            _write_terminal_marker(spark, args, exc)
            raise

        target_location = f"{args.final_output}/target_combined"
        periodogram_location = f"{args.final_output}/periodogram"
        iteration_location = f"{args.final_output}/iteration"
        grouped = bronze.rdd.map(
            lambda row: (int(row["tic_id"]), row.asDict(recursive=True))
        ).groupByKey(args.shuffle_partitions)
        results = grouped.map(
            lambda pair: process_tic(
                pair[1],
                run_id=args.run_id,
                attempt_id=args.attempt_id,
                pipeline_version=args.pipeline_version,
                target_location=target_location,
                periodogram_location=periodogram_location,
                iteration_location=iteration_location,
            )
        ).persist(StorageLevel.DISK_ONLY)

        targets = spark.createDataFrame(
            results.filter(lambda result: result.target is not None).map(lambda result: result.target),
            target_schema,
        )
        periodograms = spark.createDataFrame(
            results.filter(lambda result: result.periodogram is not None).map(lambda result: result.periodogram),
            periodogram_schema,
        )
        iterations = spark.createDataFrame(
            results.filter(lambda result: result.iteration is not None).map(lambda result: result.iteration),
            iteration_schema,
        )
        manifests = spark.createDataFrame(results.flatMap(
            lambda result: (result.manifest, result.iteration_manifest) if result.iteration_manifest is not None
            else (result.manifest,)
        ), manifest_schema)
        targets.coalesce(args.output_partitions).write.mode("errorifexists").parquet(
            f"{args.output}/target_combined"
        )
        periodograms.coalesce(args.output_partitions).write.mode("errorifexists").parquet(
            f"{args.output}/periodogram"
        )
        iterations.coalesce(args.output_partitions).write.mode("errorifexists").parquet(
            f"{args.output}/iteration"
        )
        written_iterations = spark.read.schema(iteration_schema).parquet(f"{args.output}/iteration")
        written_iteration_count = written_iterations.count()
        manifests.coalesce(args.manifest_partitions).write.mode("errorifexists").parquet(
            f"{args.output}/manifest"
        )

        written = spark.read.schema(manifest_schema).parquet(f"{args.output}/manifest")
        status_counts = {(row["stage"], row["status"]): int(row["count"])
                         for row in written.groupBy("stage", "status").count().collect()}
        initial_ids = written.filter(functions.col("stage") == "initial_bls").select("tic_id").cache()
        iteration_ids = written.filter(functions.col("stage") == "iteration").select("tic_id").cache()
        manifest_tics = initial_ids.distinct().count()
        iteration_tics = iteration_ids.distinct().count()
        missing_ids = [int(row[0]) for row in selected_ids.join(initial_ids, "tic_id", "left_anti").limit(5).collect()]
        unexpected_ids = [int(row[0]) for row in initial_ids.join(selected_ids, "tic_id", "left_anti").limit(5).collect()]
        expected_iteration = written.filter(
            (functions.col("stage") == "initial_bls") & functions.col("status").isin("succeeded", "no_quality_peak")
        ).select("tic_id")
        persisted_iteration_ids = written_iterations.select("tic_id")
        manifest_output_ids = written.filter(
            (functions.col("stage") == "iteration") & functions.col("iteration_location").isNotNull()
        ).select("tic_id")
        missing_iteration = expected_iteration.join(iteration_ids, "tic_id", "left_anti").limit(1).count()
        unexpected_iteration = iteration_ids.join(expected_iteration, "tic_id", "left_anti").limit(1).count()
        mismatched_iteration_output = (
            persisted_iteration_ids.join(manifest_output_ids, "tic_id", "left_anti").limit(1).count() or
            manifest_output_ids.join(persisted_iteration_ids, "tic_id", "left_anti").limit(1).count()
        )
        retryable_failed = written.filter(
            (functions.col("status") == "failed") & functions.col("retryable")
        ).select("tic_id").distinct().count()
        initial_status = lambda status: status_counts.get(("initial_bls", status), 0)
        iteration_status = lambda status: status_counts.get(("iteration", status), 0)
        failed_tics = initial_status("failed") + iteration_status("failed") + iteration_status("incomplete")
        contract_ok = (
            manifest_tics == selected_tics
            and written.count() == selected_tics + iteration_tics
            and sum(initial_status(status) for status in ("succeeded", "no_quality_peak", "failed")) == selected_tics
            and sum(iteration_status(status) for status in ("succeeded", "incomplete", "qa_stopped", "failed"))
            == iteration_tics
            and iteration_tics == initial_status("succeeded") + initial_status("no_quality_peak")
            and written_iteration_count == manifest_output_ids.count()
            and not mismatched_iteration_output
            and not missing_iteration and not unexpected_iteration
            and not missing_ids
            and not unexpected_ids
        )
        audit_json = "[]"
        if args.tic_id:
            audit_json = _json(sorted(results.map(science_audit).collect(), key=lambda row: row["tic_id"]))
        summary = (
            SILVER_SUMMARY_SCHEMA_VERSION,
            args.run_id,
            args.attempt_id,
            args.bronze_coverage_sha256,
            args.bronze_coverage_ready_sha256,
            args.bronze_pipeline_version,
            args.pipeline_version,
            selected_tics,
            manifest_tics,
            initial_status("succeeded"),
            initial_status("no_quality_peak"),
            failed_tics,
            retryable_failed,
            iteration_tics,
            iteration_status("succeeded"),
            iteration_status("incomplete"),
            iteration_status("qa_stopped"),
            iteration_status("failed"),
            contract_ok,
            audit_json,
            utc_now(),
        )
        spark.createDataFrame([summary], summary_schema).coalesce(1).write.mode("errorifexists").json(
            f"{args.output}/summary"
        )
        if not contract_ok:
            error = SilverContractError(
                "manifest_tic_count_mismatch",
                f"manifest TIC mismatch count={manifest_tics}/{selected_tics} "
                f"missing={missing_ids} unexpected={unexpected_ids}",
            )
            _write_terminal_marker(spark, args, error)
            raise error
        print(
            "SILVER_INITIAL_BLS_COMPLETE "
            f"selected={selected_tics} initial_succeeded={initial_status('succeeded')} "
            f"iteration_succeeded={iteration_status('succeeded')} "
            f"incomplete={iteration_status('incomplete')} qa_stopped={iteration_status('qa_stopped')} "
            f"failed={failed_tics}"
        )
        results.unpersist()
        selected_ids.unpersist()
        initial_ids.unpersist()
        iteration_ids.unpersist()
    finally:
        spark.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bronze-path", action="append", required=True)
    parser.add_argument("--bronze-coverage-sha256", required=True)
    parser.add_argument("--bronze-coverage-ready-sha256", required=True)
    parser.add_argument("--bronze-pipeline-version", required=True)
    parser.add_argument("--pipeline-version", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--final-output", required=True)
    parser.add_argument("--tic-id", type=int, action="append")
    parser.add_argument("--retry-manifest")
    parser.add_argument("--shuffle-partitions", type=int, default=200)
    parser.add_argument("--output-partitions", type=int, default=80)
    parser.add_argument("--manifest-partitions", type=int, default=8)
    args = parser.parse_args()
    for name in ("bronze_coverage_sha256", "bronze_coverage_ready_sha256"):
        if not SHA256_RE.fullmatch(getattr(args, name)):
            parser.error(f"--{name.replace('_', '-')} must be lowercase SHA-256")
    if not RUN_ID_RE.fullmatch(args.run_id) or not RUN_ID_RE.fullmatch(args.attempt_id):
        parser.error("run and attempt IDs must be UTC yyyyMMddTHHmmssZ")
    if not VERSION_RE.fullmatch(args.pipeline_version):
        parser.error("pipeline version contains unsupported characters")
    if not args.bronze_pipeline_version.strip():
        parser.error("Bronze pipeline version is required")
    if any(value <= 0 for value in (args.shuffle_partitions, args.output_partitions, args.manifest_partitions)):
        parser.error("partition counts must be positive")
    if args.tic_id and any(value <= 0 for value in args.tic_id):
        parser.error("--tic-id must be positive")
    if args.tic_id and len(args.tic_id) > 5:
        parser.error("--tic-id accepts at most five values")
    if args.tic_id and args.retry_manifest:
        parser.error("--tic-id and --retry-manifest are mutually exclusive")
    return args


if __name__ == "__main__":
    run(parse_args())

"""Convert one immutable TESS Raw Sector to product-row Bronze Parquet."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
from datetime import datetime, timezone
from typing import Any

from astro_kernel.fits_adapter import parse_spoc_hdul
from astro_kernel.preprocessing import PreprocessError


BRONZE_SCHEMA_VERSION = "planetory.tess-bronze.v1"
BRONZE_TERMINAL_SCHEMA = "planetory.tess-bronze-terminal.v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
REQUIRED_MANIFEST_FIELDS = (
    "filename",
    "tic_id",
    "sector",
    "size_bytes",
    "sha256",
    "bundle_location",
    "sequence_key",
    "offset_start",
    "offset_end",
    "input_snapshot_id",
    "source_list_sha256",
    "worker_slot",
)


class ManifestContractError(RuntimeError):
    """A deterministic manifest violation that must not be retried unchanged."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


def _clean_message(value: object) -> str:
    return " ".join(str(value).split())[:500]


def _hash_values(values: list[str]) -> str:
    return hashlib.sha256(("\n".join(sorted(values)) + "\n").encode()).hexdigest()


def _error(
    *,
    sector: int,
    product_id: str | None,
    raw_release: str,
    entry: dict[str, Any] | None,
    stage: str,
    code: str,
    detail: object,
) -> tuple:
    return (
        sector,
        product_id,
        raw_release,
        None if entry is None else entry.get("bundle_location"),
        None if entry is None else entry.get("sha256"),
        stage,
        code,
        _clean_message(detail),
    )


def transform_record(
    key: object,
    payload: object,
    manifest: dict[str, dict[str, Any]],
    *,
    expected_sector: int,
    raw_release: str,
    pipeline_version: str,
) -> tuple[str, tuple | None, tuple | None, str]:
    """Return a tagged success/error row without leaking FITS contents."""
    product_id = str(key)
    entry = manifest.get(product_id)
    if entry is None:
        error = _error(
            sector=expected_sector,
            product_id=product_id,
            raw_release=raw_release,
            entry=None,
            stage="input",
            code="manifest_entry_missing",
            detail="SequenceFile key is absent from manifest",
        )
        return "error", None, error, product_id

    try:
        raw = bytes(payload)
        if len(raw) != int(entry["size_bytes"]):
            raise PreprocessError("raw_size_mismatch", product_id)
        digest = hashlib.sha256(raw).hexdigest()
        if digest != entry["sha256"]:
            raise PreprocessError("raw_sha256_mismatch", product_id)

        try:
            from astropy.io import fits

            with fits.open(io.BytesIO(raw), memmap=False, lazy_load_hdus=False) as hdul:
                curve, meta = parse_spoc_hdul(hdul, product_id=product_id)
        except PreprocessError:
            raise
        except Exception as exc:
            raise PreprocessError("fits_open_failed", type(exc).__name__) from exc

        if curve.sector != expected_sector or int(entry["sector"]) != expected_sector:
            raise PreprocessError("sector_identity_mismatch", product_id)
        if curve.tic_id != int(entry["tic_id"]):
            raise PreprocessError("tic_identity_mismatch", product_id)

        row = (
            int(curve.tic_id),
            int(curve.sector),
            product_id,
            [float(x) for x in curve.time],
            [float(x) for x in curve.flux],
            [float(x) for x in curve.flux_err],
            [int(x) for x in curve.quality],
            [int(x) for x in curve.cadenceno],
            len(curve.time),
            str(meta["PROCVER"]),
            str(meta["TIMESYS"]),
            int(meta["BJDREFI"]),
            float(meta["BJDREFF"]),
            str(meta["TIMEUNIT"]),
            float(meta["TIMEDEL"]),
            str(meta["FLUX_UNIT"]),
            raw_release,
            int(entry["size_bytes"]),
            entry["sha256"],
            entry["bundle_location"],
            entry["sequence_key"],
            int(entry["offset_start"]),
            int(entry["offset_end"]),
            entry["input_snapshot_id"],
            entry["source_list_sha256"],
            int(entry["worker_slot"]),
            BRONZE_SCHEMA_VERSION,
            pipeline_version,
        )
        return "success", row, None, product_id
    except PreprocessError as exc:
        stage = "raw_checksum" if exc.code.startswith("raw_") else "fits_parse"
        error = _error(
            sector=expected_sector,
            product_id=product_id,
            raw_release=raw_release,
            entry=entry,
            stage=stage,
            code=exc.code,
            detail=exc,
        )
        return "error", None, error, product_id
    except Exception as exc:
        error = _error(
            sector=expected_sector,
            product_id=product_id,
            raw_release=raw_release,
            entry=entry,
            stage="fits_parse",
            code="unexpected_parse_error",
            detail=type(exc).__name__,
        )
        return "error", None, error, product_id


def _schemas(types: object) -> tuple[object, object, object]:
    bronze = types.StructType(
        [
            types.StructField("tic_id", types.LongType(), False),
            types.StructField("sector", types.IntegerType(), False),
            types.StructField("product_id", types.StringType(), False),
            types.StructField("time", types.ArrayType(types.DoubleType(), False), False),
            types.StructField("flux", types.ArrayType(types.DoubleType(), False), False),
            types.StructField("flux_err", types.ArrayType(types.DoubleType(), False), False),
            types.StructField("quality", types.ArrayType(types.LongType(), False), False),
            types.StructField("cadenceno", types.ArrayType(types.LongType(), False), False),
            types.StructField("observation_count", types.IntegerType(), False),
            types.StructField("procver", types.StringType(), False),
            types.StructField("timesys", types.StringType(), False),
            types.StructField("bjdrefi", types.LongType(), False),
            types.StructField("bjdreff", types.DoubleType(), False),
            types.StructField("timeunit", types.StringType(), False),
            types.StructField("timedel", types.DoubleType(), False),
            types.StructField("flux_unit", types.StringType(), False),
            types.StructField("raw_release", types.StringType(), False),
            types.StructField("raw_size_bytes", types.LongType(), False),
            types.StructField("raw_sha256", types.StringType(), False),
            types.StructField("bundle_location", types.StringType(), False),
            types.StructField("sequence_key", types.StringType(), False),
            types.StructField("offset_start", types.LongType(), False),
            types.StructField("offset_end", types.LongType(), False),
            types.StructField("input_snapshot_id", types.StringType(), False),
            types.StructField("source_list_sha256", types.StringType(), False),
            types.StructField("worker_slot", types.IntegerType(), False),
            types.StructField("schema_version", types.StringType(), False),
            types.StructField("pipeline_version", types.StringType(), False),
        ]
    )
    errors = types.StructType(
        [
            types.StructField("sector", types.IntegerType(), False),
            types.StructField("product_id", types.StringType(), True),
            types.StructField("raw_release", types.StringType(), False),
            types.StructField("bundle_location", types.StringType(), True),
            types.StructField("raw_sha256", types.StringType(), True),
            types.StructField("error_stage", types.StringType(), False),
            types.StructField("error_code", types.StringType(), False),
            types.StructField("error_detail", types.StringType(), False),
        ]
    )
    summary = types.StructType(
        [
            types.StructField("schema", types.StringType(), False),
            types.StructField("run_id", types.StringType(), False),
            types.StructField("sector", types.IntegerType(), False),
            types.StructField("raw_path", types.StringType(), False),
            types.StructField("raw_release", types.StringType(), False),
            types.StructField("raw_ready_sha256", types.StringType(), False),
            types.StructField("source_list_sha256", types.StringType(), False),
            types.StructField("input_snapshot_count", types.LongType(), False),
            types.StructField("input_snapshots_sha256", types.StringType(), False),
            types.StructField("pipeline_version", types.StringType(), False),
            types.StructField("expected_products", types.LongType(), False),
            types.StructField("sequence_products", types.LongType(), False),
            types.StructField("distinct_products", types.LongType(), False),
            types.StructField("success_products", types.LongType(), False),
            types.StructField("error_products", types.LongType(), False),
            types.StructField("observation_count", types.LongType(), False),
            types.StructField("contract_ok", types.BooleanType(), False),
            types.StructField("completed_at_utc", types.StringType(), False),
        ]
    )
    return bronze, errors, summary


def _manifest_map(frame: object, args: argparse.Namespace) -> tuple[dict, int, str, str, int]:
    from pyspark.sql import functions as functions

    missing_columns = sorted(set(REQUIRED_MANIFEST_FIELDS) - set(frame.columns))
    if missing_columns:
        raise ManifestContractError(
            "manifest_missing_columns",
            f"manifest missing columns: {','.join(missing_columns)}",
        )
    selected = frame.select(*REQUIRED_MANIFEST_FIELDS)
    null_expr = functions.lit(False)
    for name in REQUIRED_MANIFEST_FIELDS:
        null_expr = null_expr | functions.col(name).isNull()
    if selected.filter(null_expr).limit(1).count():
        raise ManifestContractError("manifest_null_required_fields", "manifest contains null required fields")
    if selected.filter(functions.col("sector") != args.sector).limit(1).count():
        raise ManifestContractError("manifest_sector_mismatch", "manifest sector mismatch")
    if selected.filter(functions.col("source_list_sha256") != args.source_list_sha256).limit(1).count():
        raise ManifestContractError("manifest_source_checksum_mismatch", "manifest source checksum mismatch")
    if selected.filter(functions.col("filename") != functions.col("sequence_key")).limit(1).count():
        raise ManifestContractError(
            "manifest_sequence_key_mismatch",
            "manifest filename and SequenceFile key differ",
        )
    if selected.count() != args.expected_products:
        raise ManifestContractError("manifest_product_count_mismatch", "manifest product count mismatch")
    if selected.select("sequence_key").distinct().count() != args.expected_products:
        raise ManifestContractError(
            "manifest_duplicate_sequence_keys",
            "manifest contains duplicate SequenceFile keys",
        )

    snapshots = [
        row[0]
        for row in selected.select("input_snapshot_id").distinct().toLocalIterator()
    ]
    input_snapshot_count = len(snapshots)
    input_snapshots_sha256 = _hash_values(snapshots)
    sequence_path = f"{args.raw_path}/bundle-*.seq"
    effective_expected = args.expected_products
    if args.canary_products:
        first_bundle = selected.orderBy("bundle_location").select("bundle_location").first()[0]
        selected = selected.filter(functions.col("bundle_location") == first_bundle).orderBy(
            "sequence_key"
        ).limit(args.canary_products)
        effective_expected = selected.count()
        if effective_expected <= 0:
            raise ManifestContractError("manifest_canary_empty", "canary manifest selection is empty")
        sequence_path = first_bundle
    manifest = {row["sequence_key"]: row.asDict(recursive=False) for row in selected.toLocalIterator()}
    return (
        manifest,
        input_snapshot_count,
        input_snapshots_sha256,
        sequence_path,
        effective_expected,
    )


def _write_terminal_marker(spark: object, args: argparse.Namespace, error: ManifestContractError) -> None:
    marker = {
        "schema": BRONZE_TERMINAL_SCHEMA,
        "failure_type": "data_contract",
        "error_stage": "manifest",
        "error_code": error.code,
        "error_detail": _clean_message(error),
        "sector": args.sector,
        "run_id": args.run_id,
        "completed_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
    }
    payload = json.dumps(marker, sort_keys=True, separators=(",", ":"))
    spark.sparkContext.parallelize([payload], 1).saveAsTextFile(f"{args.output}/_TERMINAL")


def run(args: argparse.Namespace) -> None:
    from pyspark import StorageLevel
    from pyspark.sql import SparkSession, functions, types

    spark = SparkSession.builder.appName(
        f"S15P21C206-77-bronze-{args.run_id}-s{args.sector:04d}"
    ).getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    bronze_schema, error_schema, summary_schema = _schemas(types)
    try:
        manifest_frame = spark.read.parquet(f"{args.raw_path}/manifest.parquet")
        try:
            (
                manifest,
                input_snapshot_count,
                input_snapshots_sha256,
                sequence_path,
                effective_expected,
            ) = _manifest_map(manifest_frame, args)
        except ManifestContractError as exc:
            _write_terminal_marker(spark, args, exc)
            raise
        broadcast = spark.sparkContext.broadcast(manifest)

        def parse_partition(rows: object) -> object:
            local_manifest = broadcast.value
            for key, payload in rows:
                yield transform_record(
                    key,
                    payload,
                    local_manifest,
                    expected_sector=args.sector,
                    raw_release=args.raw_release,
                    pipeline_version=args.pipeline_version,
                )

        sequence = spark.sparkContext.sequenceFile(
            sequence_path,
            "org.apache.hadoop.io.Text",
            "org.apache.hadoop.io.BytesWritable",
        )
        if args.canary_products:
            sequence = sequence.filter(lambda row: str(row[0]) in broadcast.value)
        tagged = sequence.mapPartitions(parse_partition).persist(StorageLevel.DISK_ONLY)
        counts = dict(tagged.map(lambda row: row[0]).countByValue())
        sequence_products = int(sum(counts.values()))
        distinct_products = int(tagged.map(lambda row: row[3]).distinct().count())
        success_products = int(counts.get("success", 0))
        error_products = int(counts.get("error", 0))

        success_rows = tagged.filter(lambda row: row[0] == "success").map(lambda row: row[1])
        error_rows = tagged.filter(lambda row: row[0] == "error").map(lambda row: row[2])
        contract_ok = sequence_products == distinct_products == effective_expected and error_products == 0
        if not (sequence_products == distinct_products == effective_expected):
            synthetic = _error(
                sector=args.sector,
                product_id=None,
                raw_release=args.raw_release,
                entry=None,
                stage="input",
                code="sequence_product_count_mismatch",
                detail=f"actual={sequence_products},expected={effective_expected},distinct={distinct_products}",
            )
            error_rows = error_rows.union(spark.sparkContext.parallelize([synthetic], 1))
            error_products += 1

        data = spark.createDataFrame(success_rows, bronze_schema)
        errors = spark.createDataFrame(error_rows, error_schema)
        output_data = f"{args.output}/data"
        output_errors = f"{args.output}/errors"
        data.coalesce(args.output_partitions).write.mode("errorifexists").parquet(output_data)
        errors.coalesce(1).write.mode("errorifexists").parquet(output_errors)

        written = spark.read.schema(bronze_schema).parquet(output_data)
        written_count = written.count()
        observation_count = int(
            written.agg(functions.coalesce(functions.sum("observation_count"), functions.lit(0))).first()[0]
        )
        if written_count != success_products:
            raise RuntimeError(f"written product count mismatch: {written_count} != {success_products}")

        contract_ok = contract_ok and written_count == effective_expected
        summary_row = (
            BRONZE_SCHEMA_VERSION,
            args.run_id,
            args.sector,
            args.raw_path,
            args.raw_release,
            args.raw_ready_sha256,
            args.source_list_sha256,
            input_snapshot_count,
            input_snapshots_sha256,
            args.pipeline_version,
            effective_expected,
            sequence_products,
            distinct_products,
            success_products,
            error_products,
            observation_count,
            contract_ok,
            datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        )
        spark.createDataFrame([summary_row], summary_schema).coalesce(1).write.mode(
            "errorifexists"
        ).json(f"{args.output}/summary")
        print(
            "BRONZE_CONVERT_COMPLETE "
            f"sector={args.sector} success={success_products} errors={error_products} "
            f"observations={observation_count} contract_ok={str(contract_ok).lower()}"
        )
        tagged.unpersist()
    finally:
        spark.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-path", required=True)
    parser.add_argument("--raw-release", required=True)
    parser.add_argument("--raw-ready-sha256", required=True)
    parser.add_argument("--source-list-sha256", required=True)
    parser.add_argument("--sector", type=int, required=True)
    parser.add_argument("--expected-products", type=int, required=True)
    parser.add_argument("--pipeline-version", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--output-partitions", type=int, default=40)
    parser.add_argument("--canary-products", type=int, default=0)
    args = parser.parse_args()
    for name in ("raw_ready_sha256", "source_list_sha256"):
        if not SHA256_RE.fullmatch(getattr(args, name)):
            parser.error(f"--{name.replace('_', '-')} must be lowercase SHA-256")
    if args.sector < 1 or args.expected_products <= 0 or args.output_partitions <= 0 or args.canary_products < 0:
        parser.error("counts and partition count must be positive")
    return args


if __name__ == "__main__":
    run(parse_args())

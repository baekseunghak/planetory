"""80 Gold stage: rebuild each star's 125 inputs from a finished Silver attempt and evaluate it with 79.

Pure per-star functions; nothing here imports Spark. The Spark driver reads the Silver
attempt, the Bronze product checksums and the run's external snapshots, calls these
on executors, keeps each payload there and hands only the light result to 79 combine().

Silver rows are reused as stored: preprocessing and BLS are not recomputed. The only
new science is the 123 provided-resolution evaluation (segments and the 5,000-point
original periodogram). IDs are provisional and unique within a run; the database
assigns real ones when the Publisher loads the bundle (276).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Mapping

import numpy as np

from astro_kernel.bls import QUALITY_VERSION, SEARCH_VERSION
from astro_kernel.candidate_aggregation import AI_NOT_EXECUTED, AI_POLICY, combine, evaluate
from astro_kernel.candidate_catalog import build_candidate_catalog
from astro_kernel.discoverability import NUMERICAL_VERSION, prepare_discoverability
from astro_kernel.external_catalog import (MATCH_VERSION, TIME_EVIDENCE, build_snapshot, content_hash,
                                           join_catalog, normalize_export_row)
from astro_kernel.iteration import ITERATION_VERSION
from astro_kernel.preprocessing import PREPROCESS_VERSION, preprocessing_config
from astro_kernel.segmentation import segment_silver
from astro_kernel.transit_model import DEFAULT_RESIDUAL_MODEL_VERSION

# The run-level versions 79 requires. Every star's Silver output must agree with them.
CALCULATION_VERSIONS = dict(
    preprocessing=PREPROCESS_VERSION, bls_config=SEARCH_VERSION,
    residual_model=DEFAULT_RESIDUAL_MODEL_VERSION, periodogram_config=NUMERICAL_VERSION,
    external_matching=MATCH_VERSION, ai_model=AI_NOT_EXECUTED, ai_threshold=AI_NOT_EXECUTED)
RUN_POLICY = dict(calculation_versions=CALCULATION_VERSIONS, ai_policy=AI_POLICY)
FINE_TUNE = {"half_width_cells": 3}  # same value as the tutorial publication (272)
# Provisional IDs: bundle = TIC, candidates and segments = TIC * ID_SLOTS + n.
ID_SLOTS = 100
EXTERNAL_READY_SCHEMA = "planetory.tess-external-snapshot.v1"  # written by tess_external_ctl
GOLD_SUMMARY_SCHEMA = "planetory.tess-gold-summary.v1"
GOLD_TERMINAL_SCHEMA = "planetory.tess-gold-terminal.v1"
RUN_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z")
# The only Silver target_combined columns rebuild(), 123 and 124 read (about a third of the arrays).
CURVE_COLUMNS = ("tic_id", "input_snapshot_id", "preprocessing_status", "preprocessing_version", "time",
                 "sector", "product_id", "cleaned_flux", "kept", "interval_masks_json")


class GoldContractError(RuntimeError):
    """The Silver attempt was not produced with the rules this stage publishes with."""


def silver_state(stages: list[Mapping[str, Any]]) -> dict | None:
    """A 79 star for a TIC that Silver did not finish, or None when Silver finished it.

    stages are the TIC's Silver manifest rows. A deterministic failure is terminal
    (rejected). A retryable failure, or an iteration stopped at its step cap, stays
    unprocessed so the run cannot look complete before an operator retries Silver.
    """
    for row in sorted(stages, key=lambda r: r["stage"] != "initial_bls"):
        if row["status"] in ("failed", "incomplete"):
            reason = f"silver:{row['stage']}:{row['error_code'] or row['status']}"
            status = "unprocessed" if row["retryable"] or row["status"] == "incomplete" else "rejected"
            return dict(tic_id=int(row["tic_id"]), status=status, reasons=[reason], bundle=None, candidates=[])
    return None


def star(tic_id: int, iteration: Mapping[str, Any], row: Mapping[str, Any] | None, *,
         product_checksums: Mapping[str, str], deliveries: Mapping[str, Any],
         required_sources: list[str], approvals: Mapping[str, str]) -> dict:
    """79 evaluate() result for one star Silver finished.

    iteration is the parsed Silver result_json. row is the star's target_combined
    row; it may be None while the catalog is not ready, because held and no-signal
    stars never need their curves. product_checksums maps this star's Bronze
    product_id to raw SHA-256. A kernel error in one star rejects only that star.
    """
    tic = int(tic_id)
    _check_versions(iteration)
    try:
        cat = _catalog(tic, iteration, approvals["identity"])
        if cat.get("catalog_ready") is not True:
            return evaluate(tic_id=tic, inputs=dict(catalog=cat), **RUN_POLICY)
        if row is None:
            raise GoldContractError(f"ready catalog without Silver curve tic={tic}")
        if int(row["tic_id"]) != tic or row["input_snapshot_id"] != iteration["input_snapshot_id"]:
            raise GoldContractError(f"Silver curve and iteration disagree tic={tic}")
        return evaluate(tic_id=tic, inputs=_inputs(tic, cat, iteration, row, product_checksums,
                                                   deliveries, required_sources, approvals), **RUN_POLICY)
    except (ValueError, TypeError, KeyError, AttributeError, IndexError, ArithmeticError) as exc:
        # Kernel contract errors (ValueError subclasses) and malformed kernel input isolate the star,
        # as Silver isolates a TIC. Anything else stops the run in evaluate_row.
        return dict(tic_id=tic, status="rejected", reasons=[f"gold:{type(exc).__name__}:{str(exc)[:200]}"],
                    payload=None, bundle=None, candidates=[])


def rebuild(row: Mapping[str, Any]) -> tuple[SimpleNamespace, SimpleNamespace]:
    """A Silver target_combined row back to the 119 fields segment_silver and 124 read.

    Only CURVE_COLUMNS are read, so the job never loads or shuffles the other Silver arrays;
    fields nothing downstream reads stay absent rather than invented.
    """
    time = np.asarray(row["time"], dtype=float)
    prepared = SimpleNamespace(
        tic_id=int(row["tic_id"]), time=time,
        sector=np.asarray(row["sector"], dtype=np.int64),
        product_id=np.asarray(row["product_id"], dtype=object),
        interval_masks=tuple(json.loads(row["interval_masks_json"])),
    )
    detrended = SimpleNamespace(
        time=time,
        flux_det=np.asarray(row["cleaned_flux"], dtype=float),
        kept=np.asarray(row["kept"], dtype=bool),
        status=row["preprocessing_status"], version=row["preprocessing_version"],
    )
    return prepared, detrended


def _check_versions(iteration: Mapping[str, Any]) -> None:
    expected = dict(iteration_version=ITERATION_VERSION, bls_config_version=SEARCH_VERSION,
                    candidate_quality_version=QUALITY_VERSION, preprocessing_version=PREPROCESS_VERSION,
                    residual_model_version=DEFAULT_RESIDUAL_MODEL_VERSION)
    wrong = sorted(key for key, value in expected.items() if iteration.get(key) != value)
    if wrong:
        raise GoldContractError(f"Silver iteration versions differ from this Gold stage: {wrong}")


def _catalog(tic: int, iteration: Mapping[str, Any], approval: str) -> dict:
    first = build_candidate_catalog(iteration, tic_id=tic, bundle_id=tic)
    peaks = first["needed_new_peak_ids"]
    if len(peaks) >= ID_SLOTS:
        raise ValueError("more new candidates than provisional ID slots")
    ids = {peak: tic * ID_SLOTS + n for n, peak in enumerate(peaks, 1)}
    return build_candidate_catalog(iteration, tic_id=tic, bundle_id=tic, new_candidate_ids=ids,
                                   identity_approval=approval)


def _inputs(tic, cat, iteration, row, product_checksums, deliveries, required_sources, approvals) -> dict:
    prepared, detrended = rebuild(row)
    segmented = segment_silver(prepared, detrended, snapshot_id=row["input_snapshot_id"],
                               product_checksums=dict(product_checksums),
                               preprocessing_parameters=preprocessing_config())
    discovery = prepare_discoverability(segmented, cat, fine_tune=FINE_TUNE,
                                        candidate_quality_version=iteration["candidate_quality_version"],
                                        rule_approval=approvals["discoverability"])
    external = join_catalog(cat, dict(deliveries), prepared.time, required_sources=list(required_sources),
                            approval=approvals["external"])
    inputs = dict(catalog=cat, segmented=segmented, discovery=discovery, external=external)
    if discovery.get("status") != "ready" or external.get("status") != "ready":
        return inputs  # 79 holds the star before 125, so the remaining arguments are never read
    original = discovery["periodograms"][0]
    if original["candidate_id"] is not None:
        raise ValueError("first 123 periodogram is not the original curve")
    sectors = sorted(s["sector"] for s in segmented["segments"])
    if len(sectors) >= ID_SLOTS:
        raise ValueError("more segments than provisional ID slots")
    inputs.update(
        periodogram=dict(candidate_id=None, periods=original["periodogram"].periods.tolist(),
                         power=original["periodogram"].power.tolist()),
        segment_ids={str(sector): tic * ID_SLOTS + n for n, sector in enumerate(sectors, 1)},
        # Per product file, as the tutorial publication records it, then the joined external snapshots.
        input_snapshot_ids=[f"{pid}:sha256:{sha}" for pid, sha in sorted(product_checksums.items())]
        + [f"{s['snapshot_id']}:sha256:{s['sha256']}" for _, s in sorted(external["snapshots"].items())],
        fold_reference_time_btjd=float(np.median(np.unique(prepared.time))),
        base_days=float(np.ptp(prepared.time)),
        fine_tune=FINE_TUNE,
    )
    return inputs


def parse_source(name: str, data: bytes, entry: Mapping[str, Any]) -> dict:
    """One collected source file, normalized with the 124 kernel and grouped by TIC.

    entry is the collector's _READY record for the file; the bytes must match its
    SHA-256. Every row with a TIC becomes a normalized or a held row. A row whose TIC
    cannot be read leaves the whole source unvalidated, so a changed export format
    turns into request_failed instead of a false "no external label".
    """
    if name not in TIME_EVIDENCE:
        raise GoldContractError(f"unsupported external source: {name}")
    if not all(isinstance(entry.get(key), str) for key in ("sha256", "requested_url", "retrieved_at")):
        raise GoldContractError(f"external source record is incomplete source={name}")
    if hashlib.sha256(data).hexdigest() != entry.get("sha256"):
        raise GoldContractError(f"external source checksum mismatch source={name}")
    try:
        lines = data.decode("utf-8-sig").splitlines(keepends=True)[int(entry["preamble_lines"]):]
        rows = list(csv.DictReader(io.StringIO("".join(lines)), strict=True))
    except (UnicodeError, csv.Error, KeyError, TypeError, ValueError) as exc:  # a broken file never heals on restart
        raise GoldContractError(f"external source unreadable source={name}: {exc}") from exc
    if len(rows) != entry.get("row_count"):
        raise GoldContractError(f"external source row count differs from the collector source={name}")
    by_tic: dict[str, tuple[list, list]] = {}
    unattributed = 0
    for raw in rows:
        record = normalize_export_row(name, raw)
        tic = record["tic_id"]
        if tic is None:
            unattributed += 1
        elif record["status"] == "normalized":
            by_tic.setdefault(tic, ([], []))[0].append(record["row"])
        else:  # held or excluded (e.g. not transiting): kept so it blocks that star's classification
            by_tic.setdefault(tic, ([], []))[1].append(
                dict(tic_id=tic, external_id=record["external_id"], reason=record["reason"]))
    return dict(source=name, source_uri=entry["requested_url"], source_table=name,
                retrieved_at=entry["retrieved_at"], time_evidence=TIME_EVIDENCE[name], complete=True,
                validated=unattributed == 0, file_sha256=entry["sha256"], unattributed=unattributed, by_tic=by_tic)


def select_sources(marker: Mapping[str, Any], files: Mapping[str, bytes], required: list[str]) -> dict:
    """The run's sources from the collector marker and the raw files beside it."""
    entries = marker.get("sources")
    if marker.get("schema") != EXTERNAL_READY_SCHEMA or not isinstance(entries, dict) or sorted(entries) != sorted(required):
        raise GoldContractError(f"external snapshot does not cover exactly {sorted(required)}")
    missing = sorted(name for name in entries if f"{name}.csv" not in files)
    if missing:
        raise GoldContractError(f"external source files missing: {missing}")
    return {name: parse_source(name, files[f"{name}.csv"], entry) for name, entry in entries.items()}


def read_hdfs_file(context, path: str) -> bytes:
    """A whole HDFS file through the Hadoop FileSystem API.

    textFile and binaryFiles go through FileInputFormat, which drops names starting with
    '_' or '.', so they report a marker such as _READY.json as a missing input path.
    """
    jvm = context._jvm
    hadoop_path = jvm.org.apache.hadoop.fs.Path(path)
    stream = hadoop_path.getFileSystem(context._jsc.hadoopConfiguration()).open(hadoop_path)
    try:
        return bytes(jvm.org.apache.commons.io.IOUtils.toByteArray(stream))
    finally:
        stream.close()


def load_sources(spark, external: str, required: list[str]) -> dict:
    try:
        marker = json.loads(read_hdfs_file(spark.sparkContext, f"{external}/_READY.json"))
    except ValueError as exc:
        raise GoldContractError(f"external marker is not JSON: {exc}") from exc
    files = {path.rsplit("/", 1)[-1]: bytes(data)
             for path, data in spark.sparkContext.binaryFiles(f"{external}/sources").collect()}
    return select_sources(marker if isinstance(marker, dict) else {}, files, required)


def deliveries(tic: int, sources: Mapping[str, Mapping[str, Any]]) -> dict:
    """Per-star 124 snapshots from the run's source documents.

    raw_sha256 is the hash of this star's own rows, so a re-download that leaves them
    unchanged keeps the snapshot and bundle_version; the file checksum stays in the run
    record. A whole-file hash would republish every star on each download.
    """
    key, out = str(tic), {}
    for name, source in sources.items():
        rows, held = (sorted(part, key=lambda r: str(r.get("external_id")))
                      for part in source["by_tic"].get(key, ([], [])))
        out[name] = build_snapshot(
            source=name, scope=[key], rows=rows, held_rows=held,
            raw_sha256=content_hash(dict(rows=rows, held_rows=held)),
            retrieved_at=source["retrieved_at"], source_uri=source["source_uri"],
            source_table=source["source_table"], time_evidence=source["time_evidence"],
            complete=source["complete"], validated=source["validated"])
    return out


def metadata(payload: Mapping[str, Any], products: list[Mapping[str, Any]]) -> dict:
    """What the Publisher needs beside the 125 payload (276): per-Sector cadence and SPOC PROCVER.

    Star attributes (TEFF, RADIUS, TESSMAG) are not in Bronze, so they stay null.
    """
    observations: dict[str, dict] = {}
    for product in products:
        value = {"cadence": f"{round(float(product['timedel']) * 86400)}s", "source_version": product["procver"]}
        if observations.setdefault(str(product["sector"]), value) != value:
            raise GoldContractError(f"Sector products disagree on cadence or PROCVER tic={payload['bundle']['tic_id']}")
    sectors = {str(segment["sector"]) for segment in payload["segments"]}
    if not sectors <= observations.keys():
        raise GoldContractError(f"published Sector without a Bronze product tic={payload['bundle']['tic_id']}")
    return {"star": {"teff_k": None, "radius_rsun": None, "tmag": None},
            "observations": {sector: observations[sector] for sector in sorted(sectors, key=int)}}


def evaluate_row(row: Mapping[str, Any], sources, required_sources, approvals) -> dict:
    """Executor side of one joined Silver row; a run contract error comes back as data."""
    tic = int(row["tic_id"])
    products = [dict(p.asDict() if hasattr(p, "asDict") else p) for p in row["products"] or []]
    try:
        result = star(tic, json.loads(row["result_json"]), row if row["time"] is not None else None,
                      product_checksums={p["product_id"]: p["raw_sha256"] for p in products},
                      deliveries=deliveries(tic, sources), required_sources=required_sources, approvals=approvals)
        if result["payload"] is not None:
            result["metadata"] = metadata(result["payload"], products)
        return result
    except GoldContractError as exc:
        # Raising here would only make Spark retry the task; the driver stops the run instead.
        return dict(tic_id=tic, contract_error=str(exc))
    except Exception as exc:  # e.g. unreadable result_json: deterministic, so a restart would repeat it
        return dict(tic_id=tic, contract_error=f"unexpected {type(exc).__name__}: {str(exc)[:200]}")


def bundle_line(result: Mapping[str, Any]) -> str:
    """One star of the bundles output: what the Publisher streams line by line (276)."""
    return _dumps({"tic_id": result["tic_id"], "payload": result["payload"], "metadata": result["metadata"]})


def light(result: Mapping[str, Any]) -> dict:
    """What leaves an executor: everything except the 125 payload and Publisher metadata."""
    return {key: value for key, value in result.items() if key not in ("payload", "metadata")}


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _write_line(spark, path: str, value: Mapping[str, Any]) -> None:
    spark.sparkContext.parallelize([_dumps(value)], 1).saveAsTextFile(path)


def run(args: argparse.Namespace) -> None:
    from pyspark import StorageLevel
    from pyspark.sql import SparkSession, functions as F

    spark = SparkSession.builder.appName(f"S15P21C206-80-gold-{args.run_id}-{args.attempt_id}").getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    # The curve join's hash shuffle on tic_id is the only one the heavy rows go through: keep its
    # partition count as the evaluate parallelism instead of paying a second repartition shuffle.
    spark.conf.set("spark.sql.shuffle.partitions", str(args.shuffle_partitions))
    spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "false")
    silver = args.silver_attempt
    try:
        try:
            sources = load_sources(spark, args.external, args.required_source)
            manifest = spark.read.parquet(f"{silver}/manifest")
            iteration = spark.read.parquet(f"{silver}/iteration")
            expected = (ITERATION_VERSION, SEARCH_VERSION, QUALITY_VERSION, PREPROCESS_VERSION)
            versions = {tuple(r) for r in iteration.select(
                "iteration_version", "bls_config_version", "candidate_quality_version",
                "preprocessing_version").distinct().collect()}
            if versions - {expected}:
                raise GoldContractError(f"Silver versions {sorted(versions)} differ from {expected}")
            targets = manifest.filter(F.col("stage") == "initial_bls").select("tic_id").distinct()
            if args.exclude_tic:
                targets = targets.filter(~F.col("tic_id").isin(args.exclude_tic))
            if args.tic_id:
                targets = targets.filter(F.col("tic_id").isin(args.tic_id))
            targets = targets.cache()
            target_ids = sorted(int(row[0]) for row in targets.collect())
            if not target_ids:
                raise GoldContractError("no target TIC selected")
        except GoldContractError as exc:
            _write_line(spark, f"{args.output}/_TERMINAL", _terminal(args, exc))
            raise

        stages = manifest.join(targets, "tic_id", "left_semi").groupBy("tic_id").agg(
            F.collect_list(F.struct("tic_id", "stage", "status", "retryable", "error_code")).alias("stages"))
        unfinished = stages.rdd.map(lambda r: silver_state([s.asDict() for s in r["stages"]])).filter(bool).collect()
        unfinished_ids = spark.createDataFrame([(s["tic_id"],) for s in unfinished], "tic_id long")
        finished = (iteration.join(targets, "tic_id", "left_semi").join(unfinished_ids, "tic_id", "left_anti")
                    .select("tic_id", "complete", "accepted_count", "result_json"))
        # Only complete iterations with accepted peaks can reach 125; the rest never read curves.
        need = finished.filter(F.col("complete") & (F.col("accepted_count") > 0)).select("tic_id")
        curves = (spark.read.parquet(f"{silver}/target_combined").select(*CURVE_COLUMNS)
                  .join(need, "tic_id", "left_semi"))
        products = (spark.read.parquet(*args.bronze_path).join(need, "tic_id", "left_semi").groupBy("tic_id")
                    .agg(F.collect_list(F.struct("product_id", "raw_sha256", "sector", "procver", "timedel"))
                         .alias("products")))
        rows = finished.join(curves, "tic_id", "left").join(products, "tic_id", "left")

        shared = spark.sparkContext.broadcast(sources)
        required = list(args.required_source)
        approvals = dict(identity=args.approval_identity, discoverability=args.approval_discoverability,
                         external=args.approval_external)
        results = rows.rdd.map(lambda row: evaluate_row(row, shared.value, required, approvals)).persist(
            StorageLevel.DISK_ONLY)
        print(f"GOLD_STARS_EVALUATED count={results.count()}", flush=True)
        try:
            errors = results.filter(lambda r: "contract_error" in r).map(lambda r: r["contract_error"]).take(5)
            if errors:
                raise GoldContractError("; ".join(errors))
            # JSON Lines, one star per line, so the Publisher streams them with the standard library (276).
            results.filter(lambda r: r["payload"] is not None).map(bundle_line).coalesce(
                args.output_partitions).saveAsTextFile(f"{args.output}/bundles")
            # ponytail: the driver holds every light result (rows and checksums, no payload), a few
            # hundred MB for a 1~13 run; stream manifest parts from executors if that ceiling is hit.
            out = combine(run_id=args.run_id, silver_attempt=silver.removeprefix("hdfs://planetory"),
                          targets=target_ids, stars=results.map(light).collect() + unfinished, **RUN_POLICY)
            if out["status"] == "rejected":
                raise GoldContractError(f"79 combine rejected the run: {out['reason']}")
        except GoldContractError as exc:
            _write_line(spark, f"{args.output}/_TERMINAL", _terminal(args, exc))
            raise
        m = out["manifest"]
        _write_line(spark, f"{args.output}/manifest", m)
        spark.sparkContext.parallelize([_dumps(r) for r in out["candidates"]], args.output_partitions).saveAsTextFile(
            f"{args.output}/candidates")
        written_bundles = spark.sparkContext.textFile(f"{args.output}/bundles").count()
        written_candidates = spark.sparkContext.textFile(f"{args.output}/candidates").count()
        summary = dict(schema=GOLD_SUMMARY_SCHEMA, run_id=args.run_id, attempt_id=args.attempt_id,
                       status=out["status"], complete=m["complete"], counts=m["counts"],
                       target_tic_count=m["target_tic_count"], candidate_count=m["candidate_count"],
                       candidates_sha256=m["candidates_sha256"], written_bundles=written_bundles,
                       written_candidates=written_candidates, completed_at_utc=_utc_now(),
                       contract_ok=written_bundles == m["counts"]["ready"] == len(m["bundles"])
                       and written_candidates == m["candidate_count"])
        _write_line(spark, f"{args.output}/summary", summary)
        if not summary["contract_ok"]:
            error = GoldContractError(f"written outputs disagree with the manifest: {summary}")
            _write_line(spark, f"{args.output}/_TERMINAL", _terminal(args, error))
            raise error
        print(f"GOLD_COMPLETE status={out['status']} counts={json.dumps(m['counts'], sort_keys=True)}", flush=True)
        results.unpersist()
    finally:
        spark.stop()


def _terminal(args: argparse.Namespace, error: Exception) -> dict:
    return dict(schema=GOLD_TERMINAL_SCHEMA, failure_type="data_contract", error_detail=str(error)[:500],
                run_id=args.run_id, attempt_id=args.attempt_id, completed_at_utc=_utc_now())


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--silver-attempt", required=True)
    parser.add_argument("--bronze-path", action="append", required=True)
    parser.add_argument("--external", required=True)
    parser.add_argument("--required-source", action="append", required=True)
    parser.add_argument("--exclude-tic", type=int, action="append", default=[])
    parser.add_argument("--tic-id", type=int, action="append")
    parser.add_argument("--approval-identity", required=True)
    parser.add_argument("--approval-discoverability", required=True)
    parser.add_argument("--approval-external", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--shuffle-partitions", type=int, default=400)
    parser.add_argument("--output-partitions", type=int, default=40)
    args = parser.parse_args(argv)
    if not RUN_ID_RE.fullmatch(args.run_id) or not RUN_ID_RE.fullmatch(args.attempt_id):
        parser.error("run and attempt IDs must be UTC yyyyMMddTHHmmssZ")
    if len(set(args.required_source)) != len(args.required_source):
        parser.error("--required-source must not repeat")
    if not all(value.strip() for value in (args.approval_identity, args.approval_discoverability,
                                            args.approval_external)):
        parser.error("approval references must not be empty")
    if args.tic_id and (len(args.tic_id) > 5 or any(value <= 0 for value in args.tic_id)):
        parser.error("--tic-id accepts at most five positive values")
    if args.shuffle_partitions <= 0 or args.output_partitions <= 0:
        parser.error("partition counts must be positive")
    return args


if __name__ == "__main__":
    run(parse_args())

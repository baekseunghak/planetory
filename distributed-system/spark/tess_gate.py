"""80 publish-ready gate: re-read a committed Gold attempt and check schema, counts and checksums.

It runs as its own Spark application after the attempt is committed, so neither a writer
bug nor storage damage can mark a run ready. It only writes a verdict; the controller alone
writes the publish-ready marker, and only when the verdict has no error.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from itertools import islice
from typing import Any, Iterable, Mapping

from jsonschema import Draft202012Validator

from astro_kernel.gold_canonical import array_checksum, bundle_version, normalize_array, record_checksum

GATE_VERSION = "publish-gate-80-v1"
VERDICT_SCHEMA = "planetory.tess-gold-gate-verdict.v1"
MAX_ERRORS = 20
RECORD_KINDS = ("candidates", "ai_results", "external_statuses")


def validator(schema: Mapping[str, Any], name: str) -> Draft202012Validator:
    """One part of the 79 publication-candidates schema (manifest or candidate)."""
    return Draft202012Validator({"$defs": schema["$defs"], "$ref": f"#/$defs/{name}"})


def schema_errors(check: Draft202012Validator, value: Any, label: str) -> list[str]:
    return [f"{label}: {error.message}"[:300] for error in islice(check.iter_errors(value), 3)]


def check_manifest(manifest: Mapping[str, Any], marker: Mapping[str, Any], check: Draft202012Validator) -> list[str]:
    """The 79 manifest is schema-valid, complete and agrees with the committed attempt marker."""
    errors = schema_errors(check, manifest, "manifest")
    if errors:
        return errors
    for key in ("run_id", "target_tic_count", "counts", "candidate_count", "candidates_sha256"):
        if manifest[key] != marker.get(key):
            errors.append(f"manifest {key} differs from the attempt marker")
    bundles = manifest["bundles"]
    if manifest["complete"] is not True:
        errors.append("run is incomplete: request_failed or unprocessed targets remain")
    if sum(manifest["counts"].values()) != manifest["target_tic_count"]:
        errors.append("manifest counts do not add up to the targets")
    if manifest["counts"]["ready"] != len(bundles) or len({b["tic_id"] for b in bundles}) != len(bundles):
        errors.append("manifest bundles do not match the ready count one per star")
    if sum(b["active_candidates"] for b in bundles) != manifest["candidate_count"]:
        errors.append("manifest active candidates do not add up to the candidate count")
    return errors


def verify_payload(payload: Mapping[str, Any]) -> list[str]:
    """Recompute a 125 payload's own array and record checksums and its bundle version."""
    bundle, manifest = payload["bundle"], payload["bundle"]["manifest"]
    errors = []
    arrays = {f"segment:{s['id']}:flux": (s["flux"], True) for s in payload["segments"]}
    arrays[f"periodogram:{bundle['id']}:power"] = (payload["periodogram"]["power"], False)
    if set(arrays) != set(manifest["array_checksums"]):
        errors.append("array checksum keys differ")
    for key, (values, nullable) in sorted(arrays.items()):
        if array_checksum(normalize_array(values, allow_null=nullable)) != manifest["array_checksums"].get(key):
            errors.append(f"array checksum mismatch {key}")
    for kind in RECORD_KINDS:
        if record_checksum(kind, payload[kind]) != manifest["record_checksums"].get(kind):
            errors.append(f"record checksum mismatch {kind}")
    semantic = dict(input_snapshot_ids=manifest["input_snapshot_ids"], segments=payload["segments"],
                    calculation_versions=manifest["calculation_versions"])
    if bundle_version(semantic) != bundle["bundle_version"]:
        errors.append("bundle_version does not match its inputs")
    if manifest["segment_ids"] != [s["id"] for s in payload["segments"]]:
        errors.append("segment ids differ from the manifest")
    if any(item["tic_id"] != bundle["tic_id"] for item in [*payload["segments"], *payload["candidates"]]):
        errors.append("segment or candidate belongs to another star")
    return errors


def check_metadata(meta: Mapping[str, Any], payload: Mapping[str, Any]) -> list[str]:
    """Publisher metadata (276): one cadence and PROCVER per published Sector, star attributes present."""
    errors = []
    if set(meta["star"]) != {"teff_k", "radius_rsun", "tmag"}:
        errors.append("metadata star attributes differ")
    sectors = {str(s["sector"]) for s in payload["segments"]}
    if set(meta["observations"]) != sectors:
        errors.append("metadata Sectors differ from the payload segments")
    for value in meta["observations"].values():
        if not re.fullmatch(r"[1-9][0-9]*s", str(value.get("cadence"))) or not str(value.get("source_version") or "").strip():
            errors.append("metadata cadence or source_version is invalid")
            break
    return errors


def check_bundle(line: Mapping[str, Any], entry: Mapping[str, Any] | None, active_ids: Iterable[int]) -> list[str]:
    """One bundles line against its payload, the manifest entry and the candidate table."""
    tic = line.get("tic_id")
    if entry is None:
        return [f"tic {tic}: bundle is not in the manifest"]
    try:
        payload = line["payload"]
        bundle = payload["bundle"]
        errors = []
        if bundle["tic_id"] != tic:
            errors.append("line tic_id differs from the payload")
        if (entry["bundle_id"], entry["bundle_version"], entry["record_checksums"]) != (
                bundle["id"], bundle["bundle_version"], bundle["manifest"]["record_checksums"]):
            errors.append("payload differs from the manifest entry")
        statuses = [c["status"] for c in payload["candidates"]]
        active = sorted(c["id"] for c in payload["candidates"] if c["status"] == "active")
        if (entry["active_candidates"], entry["retired_candidates"]) != (len(active), statuses.count("retired")):
            errors.append("candidate counts differ from the manifest entry")
        if active != sorted(active_ids):
            errors.append("active candidates differ from the candidate table")
        errors += check_metadata(line["metadata"], payload) + verify_payload(payload)
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        errors = [f"malformed bundle line: {type(exc).__name__}"]
    return [f"tic {tic}: {error}" for error in errors]


def check_candidate(value: Mapping[str, Any], check: Draft202012Validator) -> list[str]:
    return schema_errors(check, value, f"candidate {value.get('candidate_id')}")


def parse(text: str) -> dict:
    """A JSON Lines row; a broken line becomes a row the checks reject, not a crash."""
    try:
        value = json.loads(text)
    except ValueError:
        return {"__unreadable__": True}
    return value if isinstance(value, dict) else {"__unreadable__": True}


def canonical(value: Mapping[str, Any]) -> str:
    """The item text 79 content_hash uses (ensure_ascii=False, sorted keys, compact)."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def stream_hash(items: Iterable[str]) -> str:
    """content_hash of a list whose items arrive in order, without holding the list."""
    digest, first = hashlib.sha256(b"["), True
    for item in items:
        digest.update(item.encode() if first else b"," + item.encode())
        first = False
    digest.update(b"]")
    return digest.hexdigest()


def read_hdfs_file(context, path: str) -> bytes:
    """A whole HDFS file through the Hadoop FileSystem API (same as tess_gold.read_hdfs_file).

    textFile goes through FileInputFormat, which drops names starting with '_' or '.', so
    it reports the attempt's _READY.json as a missing input path.
    """
    jvm = context._jvm
    hadoop_path = jvm.org.apache.hadoop.fs.Path(path)
    stream = hadoop_path.getFileSystem(context._jsc.hadoopConfiguration()).open(hadoop_path)
    try:
        return bytes(jvm.org.apache.commons.io.IOUtils.toByteArray(stream))
    finally:
        stream.close()


def run(args: argparse.Namespace) -> None:
    from pyspark import SparkFiles, StorageLevel
    from pyspark.sql import SparkSession

    spark = SparkSession.builder.appName(f"S15P21C206-80-gate-{args.run_id}").getOrCreate()
    context = spark.sparkContext
    context.setLogLevel("WARN")
    try:
        with open(SparkFiles.get(args.schema), encoding="utf-8") as stream:
            schema = json.load(stream)
        marker = json.loads(read_hdfs_file(context, f"{args.attempt}/_READY.json"))
        verdict = dict(schema=VERDICT_SCHEMA, gate_version=GATE_VERSION, run_id=args.run_id,
                       attempt=args.attempt.removeprefix("hdfs://planetory"))
        manifests = [parse(line) for line in context.textFile(f"{args.attempt}/manifest").collect()]
        errors = [] if len(manifests) == 1 and "__unreadable__" not in manifests[0] else ["manifest must be one JSON line"]
        if not errors:
            manifest = manifests[0]
            errors += check_manifest(manifest, marker, validator(schema, "manifest"))
        if not errors:
            shared = context.broadcast(schema)
            candidates = context.textFile(f"{args.attempt}/candidates").map(parse).persist(StorageLevel.DISK_ONLY)
            errors += candidates.mapPartitions(lambda rows: (
                error for check in [validator(shared.value, "candidate")]
                for row in rows for error in check_candidate(row, check))).take(MAX_ERRORS)
            if not errors:
                keys = candidates.map(lambda c: (c["tic_id"], c["candidate_id"]))
                count = keys.count()
                if count != manifest["candidate_count"] or keys.distinct().count() != count:
                    errors.append("candidate table count or uniqueness differs from the manifest")
                digest = stream_hash(candidates.sortBy(lambda c: (c["tic_id"], c["candidate_id"]))
                                     .map(canonical).toLocalIterator())
                if digest != manifest["candidates_sha256"]:
                    errors.append("candidate table hash differs from the manifest")
                entries = context.broadcast({b["tic_id"]: b for b in manifest["bundles"]})
                bundles = context.textFile(f"{args.attempt}/bundles").map(parse).map(
                    lambda b: (b.get("tic_id"), b)).persist(StorageLevel.DISK_ONLY)
                errors += bundles.leftOuterJoin(keys.groupByKey()).flatMap(lambda kv: check_bundle(
                    kv[1][0], entries.value.get(kv[0]), kv[1][1] or [])).take(MAX_ERRORS)
                stars = bundles.keys().distinct().count()
                if bundles.count() != manifest["counts"]["ready"] or stars != manifest["counts"]["ready"]:
                    errors.append("bundle table does not hold one bundle per ready star")
                if keys.keys().distinct().subtract(bundles.keys()).take(1):
                    errors.append("candidate rows exist for stars without a bundle")
                verdict.update(bundles=stars, candidates=count, candidates_sha256=digest)
        verdict.update(ok=not errors, errors=errors[:MAX_ERRORS],
                       checked_at_utc=datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
                           "+00:00", "Z"))
        text = json.dumps(verdict, sort_keys=True, separators=(",", ":"))
        spark.sparkContext.parallelize([text], 1).saveAsTextFile(f"{args.output}/verdict")
        print(f"GATE_VERDICT ok={verdict['ok']} errors={len(errors)}", flush=True)
    finally:
        spark.stop()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--schema", required=True, help="file name shipped with spark-submit --files")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(argv)


if __name__ == "__main__":
    run(parse_args())

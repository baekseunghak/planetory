#!/usr/bin/env python3
"""감사 완료된 TESS FITS를 재개 가능한 HDFS SequenceFile bundle로 적재한다."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from ingestion import tess

PLAN_SCHEMA = "planetory.tess-hdfs-plan.v2"
LEGACY_PLAN_SCHEMA = "planetory.tess-hdfs-plan.v1"
DONE_SCHEMA = "planetory.tess-hdfs-bundle.v1"
READY_SCHEMA = "planetory.tess-hdfs-release.v1"
COVERAGE_SCHEMA = "planetory.ingestion-coverage.v1"
HDFS_COVERAGE_SCHEMA = "planetory.tess-hdfs-coverage.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z$")
RELEASE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _plan_identity(value: dict) -> dict:
    identity = {
        "source_list_sha256": value["source_list_sha256"],
        "worker_slot": value["worker_slot"],
        "sector": value["sector"],
        "target_bundle_bytes": value["target_bundle_bytes"],
        "bundles": value["bundles"],
    }
    if value.get("schema") == PLAN_SCHEMA:
        identity.update({
            "run_id": value["run_id"],
            "release_id": value["release_id"],
            "sector_product_count": value["sector_product_count"],
            "replication": value["replication"],
        })
    return identity


def _plan_id(value: dict) -> str:
    return hashlib.sha256(
        json.dumps(_plan_identity(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _validate_plan(value: dict) -> None:
    schema = value.get("schema")
    if schema not in (LEGACY_PLAN_SCHEMA, PLAN_SCHEMA) or not SHA256_RE.fullmatch(
        str(value.get("source_list_sha256", ""))
    ):
        raise ValueError("invalid HDFS load plan")
    if not 1 <= int(value.get("worker_slot", 0)) <= 5 or int(value.get("sector", 0)) < 1:
        raise ValueError("invalid HDFS load plan worker or sector")
    if not 512 << 20 <= int(value.get("target_bundle_bytes", 0)) <= 1 << 30:
        raise ValueError("invalid HDFS load target bundle size")
    entries = []
    for index, bundle in enumerate(value.get("bundles", []), 1):
        if bundle.get("bundle_name") != f"bundle-w{int(value['worker_slot']):02d}-{index:05d}.seq":
            raise ValueError("invalid HDFS bundle name or order")
        bundle_entries = bundle.get("entries", [])
        if not bundle_entries or int(bundle.get("size_bytes", -1)) != sum(int(item.get("size_bytes", -1)) for item in bundle_entries):
            raise ValueError("HDFS bundle size mismatch")
        if int(bundle["size_bytes"]) > int(value["target_bundle_bytes"]):
            raise ValueError("HDFS bundle exceeds target size")
        entries.extend(bundle_entries)
    filenames = [item.get("filename") for item in entries]
    if not entries or len(entries) != int(value.get("product_count", -1)) or len(set(filenames)) != len(entries):
        raise ValueError("HDFS plan count or filename uniqueness mismatch")
    if sum(int(item.get("size_bytes", -1)) for item in entries) != int(value.get("total_bytes", -1)):
        raise ValueError("HDFS plan total bytes mismatch")
    if schema == PLAN_SCHEMA and (
        not RUN_ID_RE.fullmatch(str(value.get("run_id", "")))
        or not RELEASE_ID_RE.fullmatch(str(value.get("release_id", "")))
        or int(value.get("sector_product_count", -1)) < len(entries)
        or int(value.get("replication", -1)) != 2
    ):
        raise ValueError("invalid HDFS plan lineage")
    if any(
        int(item.get("sector", -1)) != int(value["sector"])
        or int(item.get("tic_id", 0)) < 1
        or int(item.get("size_bytes", 0)) < 1
        or not item.get("path")
        or not item.get("filename")
        or not SHA256_RE.fullmatch(str(item.get("sha256", "")))
        or not item.get("input_snapshot_id")
        for item in entries
    ):
        raise ValueError("invalid HDFS plan entry")
    if value.get("plan_id") != _plan_id(value):
        raise ValueError("HDFS plan ID mismatch")


def _latest_events(path: Path) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid event JSON at line {line_number}") from error
        if value.get("schema") != tess.EVENT_SCHEMA or "filename" not in value:
            raise ValueError(f"invalid event at line {line_number}")
        latest[str(value["filename"])] = value
    return latest


def build_plan(
    source_list_path: Path,
    events_path: Path,
    audit_manifest_path: Path,
    raw_root: Path,
    *,
    worker_slot: int,
    sector: int,
    target_bundle_bytes: int,
    run_id: str,
    release_id: str,
) -> dict:
    source = tess.load_source_list(source_list_path)
    audit = json.loads(audit_manifest_path.read_text(encoding="utf-8"))
    selected = sorted(
        tess.select_products(source, worker_slot=worker_slot, sectors={sector}),
        key=lambda item: item.filename,
    )
    sector_product_count = len(tess.select_products(source, worker_slot=None, sectors={sector}))
    if audit.get("schema") != "planetory.download-audit.v1":
        raise ValueError("unexpected download audit schema")
    if audit.get("source_list_sha256") != source["source_list_sha256"]:
        raise ValueError("download audit source checksum mismatch")
    if int(audit.get("worker_slot", -1)) != worker_slot or audit.get("sectors") != [sector]:
        raise ValueError("download audit worker or sector mismatch")
    if audit.get("errors") or int(audit.get("expected", -1)) != len(selected):
        raise ValueError("download audit did not cover the selected products")
    if int(audit.get("validated", -1)) != len(selected):
        raise ValueError("download audit is not fully validated")
    if not selected:
        raise ValueError("download audit selected no products")
    if target_bundle_bytes < 1:
        raise ValueError("target bundle bytes must be positive")

    latest = _latest_events(events_path)
    entries: list[dict] = []
    for product in selected:
        event = latest.get(product.filename)
        path = raw_root / f"sector={sector:04d}" / product.filename
        if not event or event.get("status") != "VALIDATED":
            raise ValueError(f"latest event is not VALIDATED: {product.filename}")
        if path.with_name(path.name + ".part").exists():
            raise ValueError(f"partial file remains: {path.name}.part")
        if not path.is_file() or path.stat().st_size != int(event.get("size_bytes", -1)):
            raise ValueError(f"validated file size mismatch: {product.filename}")
        digest = str(event.get("sha256", ""))
        if not SHA256_RE.fullmatch(digest):
            raise ValueError(f"invalid event checksum: {product.filename}")
        entries.append(
            {
                "path": str(path),
                "filename": product.filename,
                "tic_id": product.tic_id,
                "sector": sector,
                "size_bytes": path.stat().st_size,
                "sha256": digest,
                "input_snapshot_id": str(event.get("input_snapshot_id", "")),
            }
        )

    bundles: list[dict] = []
    current: list[dict] = []
    current_bytes = 0
    for entry in entries:
        if current and current_bytes + entry["size_bytes"] > target_bundle_bytes:
            bundles.append({"entries": current, "size_bytes": current_bytes})
            current, current_bytes = [], 0
        current.append(entry)
        current_bytes += entry["size_bytes"]
    if current:
        bundles.append({"entries": current, "size_bytes": current_bytes})

    for index, bundle in enumerate(bundles, 1):
        bundle["bundle_name"] = f"bundle-w{worker_slot:02d}-{index:05d}.seq"
    identity = {
        "source_list_sha256": source["source_list_sha256"],
        "run_id": run_id,
        "release_id": release_id,
        "worker_slot": worker_slot,
        "sector": sector,
        "sector_product_count": sector_product_count,
        "replication": 2,
        "target_bundle_bytes": target_bundle_bytes,
        "bundles": bundles,
    }
    value = {
        "schema": PLAN_SCHEMA,
        **identity,
        "product_count": len(entries),
        "total_bytes": sum(item["size_bytes"] for item in entries),
    }
    value["plan_id"] = _plan_id(value)
    return value


def validate_ready(ready: dict, plan: dict) -> None:
    """최종 Raw marker가 plan의 전체 lineage와 정확히 같은지 확인한다."""
    expected = {
        "schema": READY_SCHEMA,
        "source_list_sha256": plan["source_list_sha256"],
        "sector": int(plan["sector"]),
    }
    if plan.get("schema") == PLAN_SCHEMA:
        expected.update({
            "run_id": plan["run_id"],
            "release_id": plan["release_id"],
            "product_count": int(plan["sector_product_count"]),
            "replication": int(plan["replication"]),
        })
    try:
        actual = {
            "schema": ready.get("schema"),
            "source_list_sha256": ready.get("source_list_sha256"),
            "sector": int(ready.get("sector", -1)),
        }
        if plan.get("schema") == PLAN_SCHEMA:
            actual.update({
                "run_id": ready.get("run_id"),
                "release_id": ready.get("release_id"),
                "product_count": int(ready.get("product_count", -1)),
                "replication": int(ready.get("replication", -1)),
            })
    except (TypeError, ValueError) as error:
        raise RuntimeError("final Raw release does not match the local plan") from error
    if actual != expected:
        raise RuntimeError("final Raw release does not match the local plan")


def _restore_sample_indices(entry_count: int) -> list[int]:
    if entry_count < 1:
        raise ValueError("restore sample requires at least one entry")
    return sorted({0, entry_count // 2, entry_count - 1})


def load_coverage_map(path: Path, expected_sha256: str) -> dict:
    raw = path.read_bytes()
    if not SHA256_RE.fullmatch(expected_sha256) or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("coverage manifest checksum mismatch")
    value = json.loads(raw)
    if (
        value.get("schema") != COVERAGE_SCHEMA
        or value.get("passed") is not True
        or int(value.get("part_count", -1)) != 0
    ):
        raise ValueError("coverage manifest is not complete")

    run_sources: dict[str, str] = {}
    run_sectors: dict[str, set[int]] = {}
    declared_sectors: set[int] = set()
    for key in ("existing_run", "expansion_run"):
        run = value.get(key, {})
        run_id = str(run.get("run_id", ""))
        source_sha = str(run.get("source_list_sha256", ""))
        sectors = {int(sector) for sector in run.get("sectors", [])}
        if (
            not RUN_ID_RE.fullmatch(run_id)
            or not SHA256_RE.fullmatch(source_sha)
            or not sectors
            or run_id in run_sources
            or declared_sectors.intersection(sectors)
        ):
            raise ValueError(f"invalid coverage run: {key}")
        run_sources[run_id] = source_sha
        run_sectors[run_id] = sectors
        declared_sectors.update(sectors)
    expected_sectors = set(range(1, 14))
    if declared_sectors != expected_sectors:
        raise ValueError("coverage runs must cover Sector 1 through 13 exactly once")

    contexts = []
    seen: set[int] = set()
    for row in value.get("sectors", []):
        sector = int(row.get("sector", -1))
        run_id = str(row.get("run_id", ""))
        expected = int(row.get("expected", -1))
        validated = int(row.get("validated", -1))
        total_bytes = int(row.get("total_bytes", -1))
        if (
            sector not in expected_sectors
            or sector in seen
            or run_id not in run_sources
            or sector not in run_sectors.get(run_id, set())
            or expected < 1
            or validated != expected
            or total_bytes < 1
            or int(row.get("part_count", -1)) != 0
        ):
            raise ValueError(f"invalid coverage sector: {sector}")
        seen.add(sector)
        contexts.append({
            "sector": sector,
            "run_id": run_id,
            "release_id": run_id,
            "source_list_sha256": run_sources[run_id],
            "product_count": expected,
            "total_bytes": total_bytes,
        })
    contexts.sort(key=lambda row: int(row["sector"]))
    expected = sum(int(row["product_count"]) for row in contexts)
    total_bytes = sum(int(row["total_bytes"]) for row in contexts)
    if (
        seen != expected_sectors
        or int(value.get("expected", -1)) != expected
        or int(value.get("validated", -1)) != expected
        or int(value.get("total_bytes", -1)) != total_bytes
    ):
        raise ValueError("coverage totals do not match Sector records")
    return {
        "schema": "planetory.tess-hdfs-coverage-map.v1",
        "source_coverage_sha256": expected_sha256,
        "expected": expected,
        "validated": expected,
        "total_bytes": total_bytes,
        "sectors": contexts,
    }


def build_coverage_ready(path: Path, expected_sha256: str, hdfs: str) -> dict:
    coverage = load_coverage_map(path, expected_sha256)
    sectors = []
    for context in coverage["sectors"]:
        sector = int(context["sector"])
        location = f"/lake/raw/tess/release={context['release_id']}/sector={sector:04d}"
        ready_path = f"{location}/_READY.json"
        raw = _run([hdfs, "dfs", "-cat", ready_path]).stdout
        ready = json.loads(raw)
        plan = {
            "schema": PLAN_SCHEMA,
            "source_list_sha256": context["source_list_sha256"],
            "run_id": context["run_id"],
            "release_id": context["release_id"],
            "sector": sector,
            "sector_product_count": int(context["product_count"]),
            "replication": 2,
        }
        validate_ready(ready, plan)
        sectors.append({
            **context,
            "location": location,
            "ready_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        })
    return {
        "schema": HDFS_COVERAGE_SCHEMA,
        "source_coverage_sha256": expected_sha256,
        "expected": coverage["expected"],
        "validated": coverage["validated"],
        "total_bytes": coverage["total_bytes"],
        "replication": 2,
        "sectors": sectors,
    }


def _run(arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(arguments, text=True, capture_output=True, check=False)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(arguments)}\n{result.stderr.strip()}")
    return result


def _hdfs_exists(hdfs: str, path: str) -> bool:
    result = _run([hdfs, "dfs", "-test", "-e", path], check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(f"HDFS existence check failed: {path}\n{result.stderr.strip()}")
    return result.returncode == 0


def _hdfs_json(hdfs: str, path: str) -> dict:
    return json.loads(_run([hdfs, "dfs", "-cat", path]).stdout)


def _hdfs_checksum(hdfs: str, path: str) -> str:
    fields = _run([hdfs, "dfs", "-checksum", path]).stdout.strip().split()
    if len(fields) < 2:
        raise RuntimeError(f"invalid HDFS checksum output: {path}")
    return " ".join(fields[1:])


def _put_atomic(hdfs: str, local: Path, remote: str) -> None:
    partial = remote + ".part"
    if _hdfs_exists(hdfs, partial):
        _run([hdfs, "dfs", "-rm", "-f", partial])
    _run([hdfs, "dfs", "-put", str(local), partial])
    _run([hdfs, "dfs", "-mv", partial, remote])


def upload_plan(plan_path: Path, stage_uri: str, final_uri: str, classes: Path, hdfs: str) -> None:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    _validate_plan(plan)
    slot = int(plan["worker_slot"])
    if _hdfs_exists(hdfs, final_uri):
        ready_path = f"{final_uri}/_READY.json"
        if not _hdfs_exists(hdfs, ready_path):
            raise RuntimeError("final Raw exists without _READY.json")
        validate_ready(_hdfs_json(hdfs, ready_path), plan)
        print(f"UPLOAD_CACHED_FINAL {final_uri}", flush=True)
        return
    control = f"{stage_uri}/.control/worker={slot}"
    _run([hdfs, "dfs", "-mkdir", "-p", control])
    remote_plan = f"{control}/plan.json"
    if not _hdfs_exists(hdfs, remote_plan) or _hdfs_json(hdfs, remote_plan).get("plan_id") != plan["plan_id"]:
        raise RuntimeError("local and HDFS plans do not match")

    with tempfile.TemporaryDirectory(prefix="planetory-hdfs-load-") as temporary:
        root = Path(temporary)
        for bundle in plan["bundles"]:
            name = str(bundle["bundle_name"])
            remote = f"{stage_uri}/{name}"
            manifest_remote = f"{control}/{name}.manifest.jsonl"
            done_remote = f"{control}/{name}.done.json"
            if _hdfs_exists(hdfs, done_remote):
                done = _hdfs_json(hdfs, done_remote)
                expected_samples = [
                    bundle["entries"][index]["filename"]
                    for index in _restore_sample_indices(len(bundle["entries"]))
                ]
                if (
                    done.get("schema") == DONE_SCHEMA
                    and done.get("plan_id") == plan["plan_id"]
                    and _hdfs_exists(hdfs, remote)
                    and _hdfs_exists(hdfs, manifest_remote)
                    and (
                        plan.get("schema") == LEGACY_PLAN_SCHEMA
                        or done.get("restore_samples") == expected_samples
                    )
                ):
                    print(f"BUNDLE_CACHED {name}", flush=True)
                    continue
                raise RuntimeError(f"inconsistent completion marker: {done_remote}")

            # 현재 run의 정확한 bundle만 정리한다. 다른 run이나 최종 Raw는 건드리지 않는다.
            for orphan in (remote, remote + ".part", manifest_remote, manifest_remote + ".part"):
                if _hdfs_exists(hdfs, orphan):
                    _run([hdfs, "dfs", "-rm", "-f", orphan])

            rows = root / f"{name}.tsv"
            manifest = root / f"{name}.manifest.jsonl"
            with rows.open("w", encoding="utf-8", newline="\n") as handle:
                for entry in bundle["entries"]:
                    values = [
                        entry["path"], entry["filename"], str(entry["tic_id"]), str(entry["sector"]),
                        str(entry["size_bytes"]), entry["sha256"], entry["input_snapshot_id"],
                    ]
                    if any("\t" in value or "\n" in value for value in values):
                        raise ValueError(f"tab or newline in bundle input: {entry['filename']}")
                    handle.write("\t".join(values) + "\n")

            hadoop_classpath = os.environ.get("HADOOP_CLASSPATH") or _run(
                ["/opt/hadoop/bin/hadoop", "classpath"]
            ).stdout.strip()
            classpath = f"{classes}{os.pathsep}{hadoop_classpath}"
            _run([
                "java", "-cp", classpath, "TessSequenceFileTool", "write", str(rows), remote + ".part",
                str(manifest), f"{final_uri}/{name}", plan["source_list_sha256"], str(slot),
            ])
            _run([hdfs, "dfs", "-setrep", "-w", "2", remote + ".part"])
            if _run([hdfs, "dfs", "-stat", "%r", remote + ".part"]).stdout.strip() != "2":
                raise RuntimeError(f"replication is not 2: {name}")
            _run([hdfs, "dfs", "-mv", remote + ".part", remote])
            _put_atomic(hdfs, manifest, manifest_remote)

            manifest_rows = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines()]
            sample_indices = _restore_sample_indices(len(bundle["entries"]))
            for index in sample_indices:
                entry = bundle["entries"][index]
                extracted = root / f"{name}.sample-{index}"
                _run([
                    "java", "-cp", classpath, "TessSequenceFileTool", "extract", remote,
                    str(manifest_rows[index]["offset_start"]), entry["filename"], entry["sha256"], str(extracted),
                ])
                extracted.unlink()
            checksum = _hdfs_checksum(hdfs, remote)
            done = {
                "schema": DONE_SCHEMA,
                "plan_id": plan["plan_id"],
                "bundle_name": name,
                "entry_count": len(bundle["entries"]),
                "source_bytes": bundle["size_bytes"],
                "replication": 2,
                "hdfs_checksum": checksum,
                "sample_filename": bundle["entries"][0]["filename"],
                "sample_sha256": bundle["entries"][0]["sha256"],
                "restore_samples": [bundle["entries"][index]["filename"] for index in sample_indices],
            }
            done_local = root / f"{name}.done.json"
            atomic_json(done_local, done)
            _put_atomic(hdfs, done_local, done_remote)
            print(f"BUNDLE_UPLOADED {name} entries={len(bundle['entries'])}", flush=True)


def audit_stage(
    stage_uri: str,
    final_uri: str,
    source_sha: str,
    sector: int,
    worker_slots: list[int],
    hdfs: str,
    *,
    run_id: str | None = None,
    release_id: str | None = None,
) -> dict:
    listing = _run([hdfs, "dfs", "-find", stage_uri]).stdout.splitlines()
    if any(path.endswith(".part") for path in listing):
        raise RuntimeError("partial HDFS file remains")
    plans = []
    for slot in worker_slots:
        path = f"{stage_uri}/.control/worker={slot}/plan.json"
        if path not in listing:
            raise RuntimeError(f"missing worker plan: {path}")
        plan = _hdfs_json(hdfs, path)
        _validate_plan(plan)
        if (
            int(plan.get("worker_slot", -1)) != slot
            or int(plan.get("sector", -1)) != sector
            or plan.get("source_list_sha256") != source_sha
            or (
                plan.get("schema") == PLAN_SCHEMA
                and (plan.get("run_id") != run_id or plan.get("release_id") != release_id)
            )
        ):
            raise RuntimeError(f"invalid worker plan: {path}")
        plans.append(plan)

    expected_bundles = {bundle["bundle_name"]: (plan, bundle) for plan in plans for bundle in plan["bundles"]}
    expected_sequences = {f"{stage_uri}/{name}" for name in expected_bundles}
    expected_manifests = {
        f"{stage_uri}/.control/worker={plan['worker_slot']}/{name}.manifest.jsonl"
        for name, (plan, _) in expected_bundles.items()
    }
    expected_done = {
        f"{stage_uri}/.control/worker={plan['worker_slot']}/{name}.done.json"
        for name, (plan, _) in expected_bundles.items()
    }
    allowed = {
        stage_uri,
        f"{stage_uri}/.control",
        f"{stage_uri}/_READY.json",
        f"{stage_uri}/manifest.parquet",
        *expected_sequences,
        *expected_manifests,
        *expected_done,
        *(f"{stage_uri}/.control/worker={slot}" for slot in worker_slots),
        *(f"{stage_uri}/.control/worker={slot}/plan.json" for slot in worker_slots),
    }
    parquet_prefix = f"{stage_uri}/manifest.parquet/"
    unexpected = []
    for path in listing:
        if path in allowed:
            continue
        if path.startswith(parquet_prefix):
            name = path[len(parquet_prefix):]
            if name == "_SUCCESS" or name.startswith("part-"):
                continue
        unexpected.append(path)
    if unexpected:
        raise RuntimeError(f"unexpected HDFS artifact: {unexpected[0]}")
    actual_sequences = {path for path in listing if path.startswith(stage_uri + "/bundle-") and path.endswith(".seq")}
    actual_manifests = {path for path in listing if path.endswith(".manifest.jsonl")}
    actual_done = {path for path in listing if path.endswith(".done.json")}
    if (actual_sequences, actual_manifests, actual_done) != (expected_sequences, expected_manifests, expected_done):
        raise RuntimeError("unexpected or missing bundle artifacts")
    manifests: list[dict] = []
    for name, (plan, bundle) in expected_bundles.items():
        slot = int(plan["worker_slot"])
        sequence_path = f"{stage_uri}/{name}"
        manifest_path = f"{stage_uri}/.control/worker={slot}/{name}.manifest.jsonl"
        done_path = f"{stage_uri}/.control/worker={slot}/{name}.done.json"
        for required in (sequence_path, manifest_path, done_path):
            if required not in listing:
                raise RuntimeError(f"missing HDFS load artifact: {required}")
        done = _hdfs_json(hdfs, done_path)
        if done.get("schema") != DONE_SCHEMA or done.get("plan_id") != plan["plan_id"]:
            raise RuntimeError(f"invalid completion marker: {done_path}")
        if int(done.get("entry_count", -1)) != len(bundle["entries"]):
            raise RuntimeError(f"completion count mismatch: {name}")
        if int(done.get("source_bytes", -1)) != int(bundle["size_bytes"]) or int(done.get("replication", -1)) != 2:
            raise RuntimeError(f"completion size or replication mismatch: {name}")
        expected_samples = [
            bundle["entries"][index]["filename"]
            for index in _restore_sample_indices(len(bundle["entries"]))
        ]
        if plan.get("schema") == PLAN_SCHEMA and done.get("restore_samples") != expected_samples:
            raise RuntimeError(f"completion restore samples mismatch: {name}")
        if _run([hdfs, "dfs", "-stat", "%r", sequence_path]).stdout.strip() != "2":
            raise RuntimeError(f"replication is not 2: {name}")
        hdfs_checksum = _hdfs_checksum(hdfs, sequence_path)
        if not hdfs_checksum or done.get("hdfs_checksum") != hdfs_checksum:
            raise RuntimeError(f"HDFS checksum changed after completion: {name}")
        rows = _run([hdfs, "dfs", "-cat", manifest_path]).stdout.splitlines()
        if len(rows) != len(bundle["entries"]):
            raise RuntimeError(f"manifest count mismatch: {name}")
        expected = {entry["filename"]: entry for entry in bundle["entries"]}
        previous_end = -1
        for line in rows:
            row = json.loads(line)
            item = expected.get(row.get("filename"))
            if not item or any(row.get(field) != item[field] for field in (
                "tic_id", "sector", "size_bytes", "sha256", "input_snapshot_id"
            )):
                raise RuntimeError(f"manifest entry does not match plan: {name}")
            if row.get("bundle_location") != f"{final_uri}/{name}":
                raise RuntimeError(f"final bundle location mismatch: {name}")
            if (
                row.get("sequence_key") != row.get("filename")
                or row.get("source_list_sha256") != source_sha
                or int(row.get("worker_slot", -1)) != slot
            ):
                raise RuntimeError(f"manifest lineage mismatch: {name}")
            if int(row.get("offset_start", -1)) < 0 or int(row.get("offset_end", -1)) <= int(row["offset_start"]):
                raise RuntimeError(f"invalid SequenceFile offset: {name}")
            if int(row["offset_start"]) < previous_end:
                raise RuntimeError(f"overlapping SequenceFile offsets: {name}")
            previous_end = int(row["offset_end"])
            manifests.append(row)

    expected_count = sum(int(plan["product_count"]) for plan in plans)
    if any(
        plan.get("schema") == PLAN_SCHEMA
        and int(plan.get("sector_product_count", -1)) != expected_count
        for plan in plans
    ):
        raise RuntimeError("worker plans disagree with Sector product count")
    filenames = [row.get("filename") for row in manifests]
    if len(manifests) != expected_count or len(set(filenames)) != expected_count:
        raise RuntimeError("aggregate manifest count or uniqueness mismatch")
    fsck = _run([hdfs, "fsck", stage_uri, "-files", "-blocks"]).stdout
    if "Status: HEALTHY" not in fsck:
        raise RuntimeError("HDFS fsck did not report HEALTHY")
    return {
        "schema": "planetory.tess-hdfs-audit.v1",
        "source_list_sha256": source_sha,
        "sector": sector,
        "worker_slots": worker_slots,
        "product_count": expected_count,
        "bundle_count": len(expected_bundles),
        "total_bytes": sum(int(plan["total_bytes"]) for plan in plans),
        "status": "HEALTHY",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan")
    plan.add_argument("--source-list", type=Path, required=True)
    plan.add_argument("--events", type=Path, required=True)
    plan.add_argument("--audit-manifest", type=Path, required=True)
    plan.add_argument("--raw-root", type=Path, required=True)
    plan.add_argument("--worker-slot", type=int, required=True)
    plan.add_argument("--sector", type=int, required=True)
    plan.add_argument("--run-id", required=True)
    plan.add_argument("--release-id", required=True)
    plan.add_argument("--target-bundle-bytes", type=int, required=True)
    plan.add_argument("--output", type=Path, required=True)
    upload = commands.add_parser("upload")
    upload.add_argument("--plan", type=Path, required=True)
    upload.add_argument("--stage-uri", required=True)
    upload.add_argument("--final-uri", required=True)
    upload.add_argument("--classes", type=Path, required=True)
    upload.add_argument("--hdfs", default="/opt/hadoop/bin/hdfs")
    audit = commands.add_parser("audit")
    audit.add_argument("--stage-uri", required=True)
    audit.add_argument("--final-uri", required=True)
    audit.add_argument("--source-sha", required=True)
    audit.add_argument("--run-id", required=True)
    audit.add_argument("--release-id", required=True)
    audit.add_argument("--sector", type=int, required=True)
    audit.add_argument("--worker-slot", type=int, action="append", required=True)
    audit.add_argument("--hdfs", default="/opt/hadoop/bin/hdfs")
    audit.add_argument("--output", type=Path)
    ready = commands.add_parser("ready")
    ready.add_argument("--ready-json", type=Path, required=True)
    ready.add_argument("--run-id", required=True)
    ready.add_argument("--release-id", required=True)
    ready.add_argument("--source-sha", required=True)
    ready.add_argument("--sector", type=int, required=True)
    ready.add_argument("--product-count", type=int, required=True)
    ready.add_argument("--replication", type=int, default=2)
    coverage_map = commands.add_parser("coverage-map")
    coverage_map.add_argument("--coverage-manifest", type=Path, required=True)
    coverage_map.add_argument("--expected-sha", required=True)
    coverage_ready = commands.add_parser("coverage-ready")
    coverage_ready.add_argument("--coverage-manifest", type=Path, required=True)
    coverage_ready.add_argument("--expected-sha", required=True)
    coverage_ready.add_argument("--hdfs", default="/opt/hadoop/bin/hdfs")
    coverage_ready.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if args.command == "plan":
        if not 512 << 20 <= args.target_bundle_bytes <= 1 << 30:
            raise ValueError("production target bundle size must be between 512 MiB and 1 GiB")
        value = build_plan(
            args.source_list, args.events, args.audit_manifest, args.raw_root,
            worker_slot=args.worker_slot, sector=args.sector, target_bundle_bytes=args.target_bundle_bytes,
            run_id=args.run_id, release_id=args.release_id,
        )
        atomic_json(args.output, value)
        print(
            f"PLAN_OK plan_id={value['plan_id']} products={value['product_count']} "
            f"bundles={len(value['bundles'])} bytes={value['total_bytes']}"
        )
        return 0
    if args.command == "upload":
        upload_plan(args.plan, args.stage_uri.rstrip("/"), args.final_uri.rstrip("/"), args.classes, args.hdfs)
        print("UPLOAD_OK")
        return 0
    if args.command == "ready":
        validate_ready(json.loads(args.ready_json.read_text(encoding="utf-8")), {
            "schema": PLAN_SCHEMA,
            "run_id": args.run_id,
            "release_id": args.release_id,
            "source_list_sha256": args.source_sha,
            "sector": args.sector,
            "sector_product_count": args.product_count,
            "replication": args.replication,
        })
        print("READY_OK")
        return 0
    if args.command == "coverage-map":
        print(json.dumps(load_coverage_map(args.coverage_manifest, args.expected_sha), sort_keys=True))
        return 0
    if args.command == "coverage-ready":
        value = build_coverage_ready(args.coverage_manifest, args.expected_sha, args.hdfs)
        atomic_json(args.output, value)
        print(json.dumps(value, sort_keys=True))
        return 0
    value = audit_stage(
        args.stage_uri.rstrip("/"), args.final_uri.rstrip("/"), args.source_sha,
        args.sector, args.worker_slot, args.hdfs, run_id=args.run_id, release_id=args.release_id,
    )
    if args.output:
        atomic_json(args.output, value)
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

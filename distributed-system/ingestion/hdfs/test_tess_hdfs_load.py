import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("tess_hdfs_load", Path(__file__).with_name("tess_hdfs_load.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)
from ingestion import tess


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        self.products = []
        for tic in (41, 42, 43):
            filename = f"tess2018263035959-s0003-{tic:016d}-0123-s_lc.fits"
            self.products.append(tess.Product(3, tic, filename, "mast:TESS/product/" + filename, base + filename, 1))
        self.source = {
            "schema": tess.SOURCE_LIST_SCHEMA,
            "worker_count": 5,
            "product_count": len(self.products),
            "source_list_sha256": tess._source_list_hash(self.products),
            "products": [item.__dict__ for item in self.products],
        }
        self.source_path = self.root / "source.json"
        tess.write_json_atomic(self.source, self.source_path)
        raw = self.root / "raw" / "sector=0003"
        raw.mkdir(parents=True)
        events = []
        for index, product in enumerate(self.products, 1):
            path = raw / product.filename
            path.write_bytes(bytes([index]) * 4)
            events.append({
                "schema": tess.EVENT_SCHEMA,
                "filename": product.filename,
                "status": "VALIDATED",
                "size_bytes": 4,
                "sha256": f"{index:064x}",
                "input_snapshot_id": f"snapshot-{index}",
            })
        self.events_path = self.root / "events.jsonl"
        self.events_path.write_text("".join(json.dumps(row) + "\n" for row in events), encoding="utf-8")
        self.audit_path = self.root / "audit.json"
        tess.write_json_atomic({
            "schema": "planetory.download-audit.v1",
            "source_list_sha256": self.source["source_list_sha256"],
            "worker_slot": 1,
            "sectors": [3],
            "expected": 3,
            "validated": 3,
            "errors": [],
        }, self.audit_path)

    def tearDown(self):
        self.temporary.cleanup()

    def test_plan_is_deterministic_and_bounded(self):
        arguments = (self.source_path, self.events_path, self.audit_path, self.root / "raw")
        first = MODULE.build_plan(*arguments, worker_slot=1, sector=3, target_bundle_bytes=8)
        second = MODULE.build_plan(*arguments, worker_slot=1, sector=3, target_bundle_bytes=8)
        self.assertEqual(first["plan_id"], second["plan_id"])
        self.assertEqual(first["product_count"], 3)
        self.assertEqual([len(item["entries"]) for item in first["bundles"]], [2, 1])
        self.assertEqual([item["bundle_name"] for item in first["bundles"]], [
            "bundle-w01-00001.seq", "bundle-w01-00002.seq",
        ])

    def test_plan_rejects_incomplete_audit(self):
        value = json.loads(self.audit_path.read_text(encoding="utf-8"))
        value["validated"] = 2
        tess.write_json_atomic(value, self.audit_path)
        with self.assertRaisesRegex(ValueError, "not fully validated"):
            MODULE.build_plan(
                self.source_path, self.events_path, self.audit_path, self.root / "raw",
                worker_slot=1, sector=3, target_bundle_bytes=8,
            )

    def test_plan_validation_rejects_tampering(self):
        value = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, self.root / "raw",
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
        )
        MODULE._validate_plan(value)
        value["total_bytes"] += 1
        with self.assertRaisesRegex(ValueError, "total bytes"):
            MODULE._validate_plan(value)

    def test_stage_audit_matches_plan_manifest_checksum_and_rf2(self):
        entry = {
            "path": "/raw/one.fits", "filename": "one.fits", "tic_id": 41, "sector": 3,
            "size_bytes": 4, "sha256": "1" * 64, "input_snapshot_id": "snapshot-1",
        }
        plan = {
            "schema": MODULE.PLAN_SCHEMA, "source_list_sha256": "b" * 64,
            "worker_slot": 1, "sector": 3, "product_count": 1, "total_bytes": 4,
            "target_bundle_bytes": 512 << 20,
            "bundles": [{"bundle_name": "bundle-w01-00001.seq", "size_bytes": 4, "entries": [entry]}],
        }
        plan["plan_id"] = MODULE._plan_id(plan)
        manifest = {
            **{key: entry[key] for key in ("filename", "tic_id", "sector", "size_bytes", "sha256", "input_snapshot_id")},
            "bundle_location": "hdfs://planetory/final/bundle-w01-00001.seq",
            "sequence_key": "one.fits", "offset_start": 100, "offset_end": 200,
            "source_list_sha256": "b" * 64, "worker_slot": 1,
        }
        done = {
            "schema": MODULE.DONE_SCHEMA, "plan_id": plan["plan_id"], "entry_count": 1,
            "source_bytes": 4, "replication": 2, "hdfs_checksum": "MD5 checksum-line",
        }
        listing = [
            "/stage/.control/worker=1/plan.json", "/stage/bundle-w01-00001.seq",
            "/stage/.control/worker=1/bundle-w01-00001.seq.manifest.jsonl",
            "/stage/.control/worker=1/bundle-w01-00001.seq.done.json",
        ]

        def hdfs_json(_, path):
            return plan if path.endswith("plan.json") else done

        def run(arguments, check=True):
            tail = arguments[1:]
            if tail == ["dfs", "-find", "/stage"]:
                output = "\n".join(listing) + "\n"
            elif tail[:3] == ["dfs", "-stat", "%r"]:
                output = "2\n"
            elif tail[:2] == ["dfs", "-checksum"]:
                output = f"{tail[2]}\tMD5\tchecksum-line\n"
            elif tail[:2] == ["dfs", "-cat"]:
                output = json.dumps(manifest) + "\n"
            elif tail[:2] == ["fsck", "/stage"]:
                output = "Status: HEALTHY\n"
            else:
                raise AssertionError(arguments)
            return CompletedProcess(arguments, 0, output, "")

        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=run):
            result = MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs")
        self.assertEqual(result["product_count"], 1)
        self.assertEqual(result["status"], "HEALTHY")


if __name__ == "__main__":
    unittest.main()

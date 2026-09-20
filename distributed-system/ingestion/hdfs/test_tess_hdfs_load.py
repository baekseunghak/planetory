import importlib.util
import hashlib
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
sys.modules["tess_hdfs_load"] = MODULE
RUNALL_SPEC = importlib.util.spec_from_file_location("tess_hdfs_runall", Path(__file__).with_name("tess_hdfs_runall.py"))
RUNALL = importlib.util.module_from_spec(RUNALL_SPEC)
assert RUNALL_SPEC.loader
RUNALL_SPEC.loader.exec_module(RUNALL)
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

    def _coverage_fixture(self):
        config = json.loads((ROOT / "config" / "service-v1.json").read_text(encoding="utf-8"))
        counts = {int(row["sector"]): int(row["expected_count"]) for row in config["sectors"]}
        old_run = "20260918T080417Z"
        new_run = "20260919T005932Z"
        sectors = [{
            "sector": sector,
            "expected": counts[sector],
            "validated": counts[sector],
            "total_bytes": counts[sector] * 4,
            "part_count": 0,
            "run_id": old_run if sector in (3, 4, 5) else new_run,
            "source_list_sha256": "a" * 64 if sector in (3, 4, 5) else "b" * 64,
        } for sector in range(1, 14)]
        coverage = {
            "schema": "planetory.ingestion-coverage.v1",
            "existing_run": {"run_id": old_run, "sectors": [3, 4, 5], "source_list_sha256": "a" * 64},
            "expansion_run": {
                "run_id": new_run,
                "sectors": [1, 2, 6, 7, 8, 9, 10, 11, 12, 13],
                "source_list_sha256": "b" * 64,
            },
            "expected": sum(counts.values()),
            "validated": sum(counts.values()),
            "total_bytes": sum(row["total_bytes"] for row in sectors),
            "part_count": 0,
            "passed": True,
            "sectors": sectors,
        }
        path = self.root / "coverage.json"
        path.write_text(json.dumps(coverage, sort_keys=True) + "\n", encoding="utf-8")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_plan_is_deterministic_and_bounded(self):
        arguments = (self.source_path, self.events_path, self.audit_path, self.root / "raw")
        options = {
            "worker_slot": 1,
            "sector": 3,
            "target_bundle_bytes": 8,
            "run_id": "20260918T080417Z",
            "release_id": "20260918T080417Z",
        }
        first = MODULE.build_plan(*arguments, **options)
        second = MODULE.build_plan(*arguments, **options)
        self.assertEqual(first["plan_id"], second["plan_id"])
        self.assertEqual(first["schema"], "planetory.tess-hdfs-plan.v2")
        self.assertEqual(first["run_id"], options["run_id"])
        self.assertEqual(first["release_id"], options["release_id"])
        self.assertEqual(first["sector_product_count"], 3)
        self.assertEqual(first["replication"], 2)
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
                run_id="20260918T080417Z", release_id="20260918T080417Z",
            )

    def test_plan_validation_rejects_tampering(self):
        value = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, self.root / "raw",
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
            run_id="20260918T080417Z", release_id="20260918T080417Z",
        )
        MODULE._validate_plan(value)
        value["total_bytes"] += 1
        with self.assertRaisesRegex(ValueError, "total bytes"):
            MODULE._validate_plan(value)

    def test_ready_contract_checks_all_lineage_fields(self):
        plan = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, self.root / "raw",
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
            run_id="20260918T080417Z", release_id="20260918T080417Z",
        )
        ready = {
            "schema": "planetory.tess-hdfs-release.v1",
            "run_id": plan["run_id"],
            "release_id": plan["release_id"],
            "source_list_sha256": plan["source_list_sha256"],
            "sector": plan["sector"],
            "product_count": plan["sector_product_count"],
            "replication": plan["replication"],
        }
        MODULE.validate_ready(ready, plan)
        for field in ready:
            changed = dict(ready)
            changed[field] = "wrong" if isinstance(changed[field], str) else -1
            with self.subTest(field=field), self.assertRaisesRegex(RuntimeError, "final Raw release"):
                MODULE.validate_ready(changed, plan)

    def test_restore_samples_cover_first_middle_and_last(self):
        self.assertEqual(MODULE._restore_sample_indices(1), [0])
        self.assertEqual(MODULE._restore_sample_indices(2), [0, 1])
        self.assertEqual(MODULE._restore_sample_indices(5), [0, 2, 4])

    def test_coverage_map_uses_sector_run_lineage(self):
        path, digest = self._coverage_fixture()
        result = MODULE.load_coverage_map(path, digest)
        self.assertEqual(result["expected"], 247824)
        self.assertEqual([row["sector"] for row in result["sectors"]], list(range(1, 14)))
        self.assertEqual(result["sectors"][2]["run_id"], "20260918T080417Z")
        self.assertEqual(result["sectors"][2]["source_list_sha256"], "a" * 64)
        self.assertEqual(result["sectors"][0]["run_id"], "20260919T005932Z")
        self.assertEqual(result["sectors"][0]["source_list_sha256"], "b" * 64)

        value = json.loads(path.read_text(encoding="utf-8"))
        value["sectors"][2]["run_id"] = value["expansion_run"]["run_id"]
        path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        changed_digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "invalid coverage sector"):
            MODULE.load_coverage_map(path, changed_digest)

    def test_hdfs_coverage_ready_validates_every_sector_release(self):
        path, digest = self._coverage_fixture()
        coverage = MODULE.load_coverage_map(path, digest)
        contexts = {int(row["sector"]): row for row in coverage["sectors"]}

        def run(arguments, check=True):
            self.assertEqual(arguments[1:3], ["dfs", "-cat"])
            sector = int(arguments[3].split("sector=")[-1].split("/")[0])
            context = contexts[sector]
            ready = {
                "schema": MODULE.READY_SCHEMA,
                "run_id": context["run_id"],
                "release_id": context["release_id"],
                "source_list_sha256": context["source_list_sha256"],
                "sector": sector,
                "product_count": context["product_count"],
                "replication": 2,
            }
            return CompletedProcess(arguments, 0, json.dumps(ready, sort_keys=True) + "\n", "")

        with mock.patch.object(MODULE, "_run", side_effect=run):
            ready = MODULE.build_coverage_ready(path, digest, "hdfs")
        self.assertEqual(ready["schema"], MODULE.HDFS_COVERAGE_SCHEMA)
        self.assertEqual(ready["expected"], 247824)
        self.assertEqual(len(ready["sectors"]), 13)

    def test_stage_audit_matches_plan_manifest_checksum_and_rf2(self):
        entry = {
            "path": "/raw/one.fits", "filename": "one.fits", "tic_id": 41, "sector": 3,
            "size_bytes": 4, "sha256": "1" * 64, "input_snapshot_id": "snapshot-1",
        }
        plan = {
            "schema": MODULE.LEGACY_PLAN_SCHEMA, "source_list_sha256": "b" * 64,
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

        listing.append("/stage/unexpected.bin")
        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=run):
            with self.assertRaisesRegex(RuntimeError, "unexpected HDFS artifact"):
                MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs")

    def test_server_runall_uses_exact_worker_internal_ips(self):
        value = {
            "schema": RUNALL.CONFIG_SCHEMA,
            "run_id": "20260919T005932Z",
            "expected_source_list_sha256": "a" * 64,
            "expected_coverage_sha256": "b" * 64,
            "code_release_id": "20260920T120000Z",
            "code_release": "/opt/planetory-hdfs-load/releases/20260920T120000Z",
            "coverage_manifest": "/etc/planetory/tess-hdfs-runall/coverage.json",
            "target_bundle_bytes": 512 << 20,
            "minimum_worker_free_gib": 100,
            "workers": [
                {"slot": slot, "internal_ip": f"10.20.{slot + 1}.10"}
                for slot in range(1, 6)
            ],
        }
        RUNALL.validate_config(value)
        arguments = RUNALL.ssh_arguments(value["workers"][0], "hostname -s")
        self.assertIn("-n", arguments)
        self.assertIn("10.20.1.10", arguments)
        self.assertEqual(arguments[-2], "planetory-admin@10.20.2.10")
        self.assertNotIn("tailscale", " ".join(arguments))
        value["workers"][0]["internal_ip"] = "100.64.0.2"
        with self.assertRaisesRegex(ValueError, "exact five Worker internal IPs"):
            RUNALL.validate_config(value)

    def test_server_runall_accepts_ha_safe_mode_output(self):
        self.assertTrue(RUNALL.safe_mode_is_off(
            "Safe mode is OFF in master-1/10.20.1.10:8020\n"
            "Safe mode is OFF in worker-2/10.20.2.10:8020\n"
        ))
        self.assertFalse(RUNALL.safe_mode_is_off("Safe mode is OFF\nSafe mode is ON\n"))

    def test_server_runall_mounts_manifest_from_immutable_release(self):
        source = Path(RUNALL.__file__).read_text(encoding="utf-8")
        self.assertIn(
            'spark_script = Path(config["code_release"]) / "hdfs" / "manifest_to_parquet.py"',
            source,
        )
        self.assertNotIn("shutil.copyfile", source)


if __name__ == "__main__":
    unittest.main()

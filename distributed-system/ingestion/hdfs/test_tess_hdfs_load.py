import importlib.util
import hashlib
import inspect
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
    def test_server_runall_rejects_mismatched_stage_lineage_before_coverage(self):
        config = {
            "run_id": "20260919T005932Z", "expected_source_list_sha256": "a" * 64,
            "code_release": "/opt/planetory-hdfs-load/releases/20260919T005932Z",
        }
        with mock.patch.object(MODULE, "load_coverage_map") as coverage:
            with self.assertRaisesRegex(ValueError, "run_id differs"):
                RUNALL.coordinator(config, [3], expected_run_id="20260922T000000Z")
            with self.assertRaisesRegex(ValueError, "source checksum differs"):
                RUNALL.coordinator(config, [3], expected_source_sha="b" * 64)
            with self.assertRaisesRegex(ValueError, "code release differs"):
                RUNALL.coordinator(config, [3], expected_code_release="/opt/planetory-hdfs-load/releases/other")
            coverage.assert_not_called()

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

    def test_coverage_map_rejects_duplicate_sector_inside_run(self):
        path, _ = self._coverage_fixture()
        value = json.loads(path.read_text(encoding="utf-8"))
        value["existing_run"]["sectors"].append(3)
        path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "invalid coverage run"):
            MODULE.load_coverage_map(path, digest)

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

        def audit(stage_uri, final_uri, source_sha, sector, worker_slots, hdfs, **lineage):
            context = contexts[sector]
            self.assertEqual(stage_uri, final_uri.removeprefix("hdfs://planetory"))
            self.assertEqual(source_sha, context["source_list_sha256"])
            self.assertEqual(worker_slots, [1, 2, 3, 4, 5])
            self.assertEqual(lineage, {"run_id": context["run_id"], "release_id": context["release_id"]})
            return {
                "product_count": context["product_count"],
                "total_bytes": context["total_bytes"],
                "status": "HEALTHY",
            }

        with (
            mock.patch.object(MODULE, "_run", side_effect=run),
            mock.patch.object(MODULE, "_hdfs_exists", return_value=True),
            mock.patch.object(MODULE, "audit_stage", side_effect=audit) as audit_mock,
        ):
            ready = MODULE.build_coverage_ready(path, digest, "hdfs")
        self.assertEqual(ready["schema"], MODULE.HDFS_COVERAGE_SCHEMA)
        self.assertEqual(ready["expected"], 247824)
        self.assertEqual(len(ready["sectors"]), 13)
        self.assertEqual(audit_mock.call_count, 13)

    def test_hdfs_coverage_ready_rejects_audit_byte_mutation(self):
        path, digest = self._coverage_fixture()
        coverage = MODULE.load_coverage_map(path, digest)
        contexts = {int(row["sector"]): row for row in coverage["sectors"]}

        def run(arguments, check=True):
            sector = int(arguments[3].split("sector=")[-1].split("/")[0])
            context = contexts[sector]
            ready = {
                "schema": MODULE.READY_SCHEMA, "run_id": context["run_id"],
                "release_id": context["release_id"], "source_list_sha256": context["source_list_sha256"],
                "sector": sector, "product_count": context["product_count"], "replication": 2,
            }
            return CompletedProcess(arguments, 0, json.dumps(ready), "")

        context = contexts[1]
        audit = {
            "product_count": context["product_count"],
            "total_bytes": context["total_bytes"] + 1,
            "status": "HEALTHY",
        }
        with (
            mock.patch.object(MODULE, "_run", side_effect=run),
            mock.patch.object(MODULE, "_hdfs_exists", return_value=True),
            mock.patch.object(MODULE, "audit_stage", return_value=audit),
            self.assertRaisesRegex(RuntimeError, "audit differs from coverage"),
        ):
            MODULE.build_coverage_ready(path, digest, "hdfs")

    def test_hdfs_coverage_ready_reuse_still_requires_parquet_success(self):
        path, digest = self._coverage_fixture()
        context = MODULE.load_coverage_map(path, digest)["sectors"][0]
        ready = {
            "schema": MODULE.READY_SCHEMA, "run_id": context["run_id"],
            "release_id": context["release_id"], "source_list_sha256": context["source_list_sha256"],
            "sector": context["sector"], "product_count": context["product_count"], "replication": 2,
        }
        with (
            mock.patch.object(MODULE, "_run", return_value=CompletedProcess([], 0, json.dumps(ready), "")),
            mock.patch.object(MODULE, "_hdfs_exists", return_value=False),
            mock.patch.object(MODULE, "audit_stage") as audit_stage,
            self.assertRaisesRegex(RuntimeError, "no Parquet success marker"),
        ):
            MODULE.build_coverage_ready(path, digest, "hdfs", reuse_sector_audits=True)
        audit_stage.assert_not_called()

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
        self.assertEqual((result["fast_bundles"], result["full_bundles"]), (0, 1))

        done["manifest_checksum"] = "MD5 checksum-line"
        calls = []
        def tracked_run(arguments, check=True):
            calls.append(arguments)
            return run(arguments, check=check)
        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=tracked_run):
            result = MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs", fast=True)
        self.assertEqual(result["product_count"], 1)
        self.assertEqual((result["fast_bundles"], result["full_bundles"]), (1, 0))
        self.assertFalse(any(arguments[1:3] == ["dfs", "-cat"] for arguments in calls))

        done["manifest_checksum"] = "changed"
        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=run):
            with self.assertRaisesRegex(RuntimeError, "manifest checksum changed"):
                MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs", fast=True)
        del done["manifest_checksum"]
        calls.clear()
        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=tracked_run):
            result = MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs", fast=True)
        self.assertEqual((result["fast_bundles"], result["full_bundles"]), (0, 1))
        self.assertTrue(any(arguments[1:3] == ["dfs", "-cat"] for arguments in calls))

        listing.append("/stage/unexpected.bin")
        with mock.patch.object(MODULE, "_hdfs_json", side_effect=hdfs_json), mock.patch.object(MODULE, "_run", side_effect=run):
            with self.assertRaisesRegex(RuntimeError, "unexpected HDFS artifact"):
                MODULE.audit_stage("/stage", "hdfs://planetory/final", "b" * 64, 3, [1], "hdfs")

        listing[-1] = "/stage/manifest.parquet/part-00000/hidden.bin"
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

        value["workers"] = [
            {"slot": slot, "internal_ip": f"10.20.{slot + 1}.10"}
            for slot in range(1, 6)
        ] + [{"slot": 1, "internal_ip": "10.20.2.10"}]
        with self.assertRaisesRegex(ValueError, "exact five Worker internal IPs"):
            RUNALL.validate_config(value)

    def test_single_sector_runall_uses_immutable_context_without_legacy_coverage(self):
        run_id = "20260922T120000Z"
        context = {
            "sector": 14, "run_id": run_id, "release_id": run_id,
            "source_list_sha256": "a" * 64, "product_count": 42, "total_bytes": 4200,
        }
        config = {
            "schema": RUNALL.CONFIG_SCHEMA, "run_id": run_id,
            "expected_source_list_sha256": "a" * 64,
            "code_release_id": run_id,
            "code_release": f"/opt/planetory-hdfs-load/releases/{run_id}",
            "target_bundle_bytes": 512 << 20, "minimum_worker_free_gib": 100,
            "workers": [{"slot": slot, "internal_ip": f"10.20.{slot + 1}.10"} for slot in range(1, 6)],
            "sector_contexts": [context],
        }
        RUNALL.validate_config(config)
        with (
            mock.patch.object(RUNALL.loader, "load_coverage_map") as legacy_coverage,
            mock.patch.object(RUNALL, "process_sector") as process,
            mock.patch.object(RUNALL, "finalize_coverage") as final_coverage,
        ):
            RUNALL.coordinator(config, [14])
        legacy_coverage.assert_not_called()
        process.assert_called_once_with(config, context, cleanup_source=None)
        final_coverage.assert_not_called()
        with self.assertRaisesRegex(ValueError, "must not reuse legacy coverage"):
            RUNALL.validate_config({**config, "expected_coverage_sha256": "b" * 64})
        with self.assertRaisesRegex(ValueError, "no legacy coverage"):
            RUNALL.finalize_coverage(config)

    def test_server_hdfs_exists_distinguishes_absence_from_command_failure(self):
        with mock.patch.object(RUNALL, "hdfs", return_value=CompletedProcess([], 1, "", "")):
            self.assertFalse(RUNALL.hdfs_exists("/missing"))
        with (
            mock.patch.object(RUNALL, "hdfs", return_value=CompletedProcess([], 255, "", "namenode unavailable")),
            self.assertRaisesRegex(RuntimeError, "existence check failed"),
        ):
            RUNALL.hdfs_exists("/unknown")

    def test_cached_raw_cleanup_can_audit_when_hdfs_crosses_admission_threshold(self):
        def response(arguments, **_kwargs):
            if arguments[0] == "haadmin":
                output = "active\n" if arguments[-1] == "nn1" else "standby\n"
            elif arguments[0] == "getconf":
                output = "2\n" if arguments[-1] == "dfs.replication" else "107374182400\n"
            elif arguments[0] == "dfsadmin" and arguments[1] == "-safemode":
                output = "Safe mode is OFF\nSafe mode is OFF\n"
            elif arguments[0] == "dfsadmin":
                output = "Live datanodes (5):\n"
            else:
                output = "Filesystem Size Used Available Use%\nhdfs://planetory 1000 800 200 80%\n"
            return CompletedProcess(arguments, 0, output, "")

        with mock.patch.object(RUNALL, "hdfs", side_effect=response):
            RUNALL.preflight(0)
            with self.assertRaisesRegex(RuntimeError, "75 percent"):
                RUNALL.preflight(100)

    def test_server_coordinator_skips_capacity_for_cached_sector_and_marks_complete(self):
        context = {
            "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
            "source_list_sha256": "a" * 64, "sector": 1,
            "product_count": 1, "total_bytes": 4,
        }
        config = {
            "run_id": context["run_id"], "expected_source_list_sha256": context["source_list_sha256"],
            "expected_coverage_sha256": "b" * 64, "coverage_manifest": "coverage.json",
        }
        with (
            mock.patch.object(RUNALL.loader, "load_coverage_map", return_value={"sectors": [context]}),
            mock.patch.object(RUNALL, "hdfs_exists", return_value=True),
            mock.patch.object(RUNALL, "preflight") as preflight,
            mock.patch.object(RUNALL, "commit_sector"),
            mock.patch.object(RUNALL, "commit_coverage") as commit_coverage,
            mock.patch.object(RUNALL.loader, "atomic_json") as atomic_json,
        ):
            RUNALL.coordinator(config)
        self.assertEqual(preflight.call_args_list, [mock.call(0), mock.call(0)])
        commit_coverage.assert_called_once_with(config, reuse_sector_audits=True)
        self.assertEqual(atomic_json.call_args.args[0], RUNALL.completion_path(config))

    def test_standalone_coverage_command_reaudits_every_sector(self):
        config = {"run_id": "20260919T005932Z", "expected_coverage_sha256": "b" * 64}
        with (
            mock.patch.object(RUNALL, "preflight"),
            mock.patch.object(RUNALL, "commit_coverage") as commit_coverage,
            mock.patch.object(RUNALL.loader, "atomic_json"),
        ):
            RUNALL.finalize_coverage(config)
        commit_coverage.assert_called_once_with(config, reuse_sector_audits=False)

    def test_server_coordinator_cleans_sources_only_after_raw_commit(self):
        context = {
            "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
            "source_list_sha256": "a" * 64, "sector": 1,
            "product_count": 1, "total_bytes": 4,
        }
        workers = [{"slot": slot, "internal_ip": f"10.20.{slot + 1}.10"} for slot in (1, 2)]
        config = {
            "run_id": context["run_id"], "expected_source_list_sha256": context["source_list_sha256"],
            "expected_coverage_sha256": "b" * 64, "coverage_manifest": "coverage.json",
            "cleanup_source_after_commit": True, "workers": workers,
        }
        events = []
        with (
            mock.patch.object(RUNALL.loader, "load_coverage_map", return_value={"sectors": [context]}),
            mock.patch.object(RUNALL, "hdfs_exists", return_value=True),
            mock.patch.object(RUNALL, "preflight"),
            mock.patch.object(RUNALL, "commit_sector", side_effect=lambda *_: events.append("commit")),
            mock.patch.object(
                RUNALL, "cleanup_worker",
                side_effect=lambda _, __, worker: events.append(f"cleanup-{worker['slot']}"),
            ),
            mock.patch.object(RUNALL, "commit_coverage"),
            mock.patch.object(RUNALL.loader, "atomic_json"),
        ):
            RUNALL.coordinator(config)
        self.assertEqual(events, ["commit", "cleanup-1", "cleanup-2"])

    def test_server_coordinator_runs_only_requested_sector_and_defers_coverage(self):
        contexts = [
            {
                "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
                "source_list_sha256": "a" * 64, "sector": sector,
                "product_count": 1, "total_bytes": 4,
            }
            for sector in (1, 2)
        ]
        config = {
            "run_id": contexts[0]["run_id"],
            "expected_source_list_sha256": contexts[0]["source_list_sha256"],
            "expected_coverage_sha256": "b" * 64,
            "coverage_manifest": "coverage.json",
        }
        with (
            mock.patch.object(RUNALL.loader, "load_coverage_map", return_value={"sectors": contexts}),
            mock.patch.object(RUNALL, "process_sector") as process_sector,
            mock.patch.object(RUNALL, "finalize_coverage") as finalize_coverage,
        ):
            RUNALL.coordinator(config, [2])
        process_sector.assert_called_once_with(config, contexts[1], cleanup_source=None)
        finalize_coverage.assert_not_called()

    def test_cleanup_sector_uses_fast_final_audit_and_all_workers(self):
        context = {
            "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
            "source_list_sha256": "a" * 64, "sector": 7,
            "product_count": 5, "total_bytes": 20,
        }
        config = {"workers": [{"slot": slot} for slot in range(1, 6)]}
        cleaned = []
        with (
            mock.patch.object(RUNALL, "hdfs_exists", return_value=True),
            mock.patch.object(RUNALL, "preflight"),
            mock.patch.object(RUNALL, "commit_sector") as commit,
            mock.patch.object(RUNALL, "cleanup_worker", side_effect=lambda _, __, worker: cleaned.append(worker["slot"])),
        ):
            RUNALL.process_sector(config, context, cleanup_source=True)
        commit.assert_called_once_with(config, context, fast_cached=True)
        self.assertEqual(set(cleaned), set(range(1, 6)))

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

    def test_server_runall_streams_every_ready_marker_as_hdfs_user(self):
        ready = {"schema": "test", "product_count": 1, "note": "검증"}
        with mock.patch.object(RUNALL, "hdfs") as hdfs:
            RUNALL.hdfs_put_json(ready, "/stage/_READY.json.part")
        payload = json.dumps(ready, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        hdfs.assert_called_once_with(
            ["dfs", "-put", "-", "/stage/_READY.json.part"],
            input_text=payload,
        )
        self.assertIn("검증", payload)
        self.assertNotIn("\\u", payload)
        self.assertIn("hdfs_put_json(ready", inspect.getsource(RUNALL.commit_sector))
        self.assertIn("hdfs_put_json(ready", inspect.getsource(RUNALL.commit_coverage))

    def test_server_runall_forwards_hdfs_stdin_and_propagates_failure(self):
        failure = CompletedProcess([RUNALL.HDFS], 1, "", "permission denied")
        with mock.patch.object(RUNALL.subprocess, "run", return_value=failure) as process:
            with self.assertRaisesRegex(RuntimeError, "command failed.*dfs -put - /stage/marker"):
                RUNALL.hdfs(["dfs", "-put", "-", "/stage/marker"], input_text="{}\n", echo=False)
        process.assert_called_once_with(
            [
                "/usr/bin/sudo", "-u", "hdfs", "/usr/bin/env",
                f"JAVA_HOME={RUNALL.JAVA_HOME}", f"HADOOP_CONF_DIR={RUNALL.HADOOP_CONF_DIR}",
                RUNALL.HDFS, "dfs", "-put", "-", "/stage/marker",
            ],
            text=True, encoding="utf-8", capture_output=True, check=False, input="{}\n",
        )

    def test_server_runall_commits_sector_ready_marker_in_atomic_order(self):
        context = {
            "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
            "source_list_sha256": "a" * 64, "sector": 7, "product_count": 19_995,
            "total_bytes": 4,
        }
        config = {"code_release": "/opt/planetory-hdfs-load/releases/test"}
        stage, final, _ = RUNALL.context_paths(context)
        part = f"{stage}/_READY.json.part"
        marker = f"{stage}/_READY.json"
        ready = {
            "schema": MODULE.READY_SCHEMA, "run_id": context["run_id"],
            "release_id": context["release_id"],
            "source_list_sha256": context["source_list_sha256"], "sector": 7,
            "product_count": 19_995, "replication": 2,
        }
        events = []

        def exists(path):
            return path in {part, marker, f"{stage}/manifest.parquet/_SUCCESS"}

        def hdfs(arguments, **_):
            event = ("hdfs", *arguments)
            events.append(event)
            output = "Status: HEALTHY\nUnder-replicated blocks: 0\n" if arguments[0] == "fsck" else ""
            return CompletedProcess(arguments, 0, output, "")

        with (
            mock.patch.object(RUNALL.shutil, "chown"),
            mock.patch.object(RUNALL, "hdfs_exists", side_effect=exists),
            mock.patch.object(RUNALL, "audit", return_value={"product_count": 19_995, "total_bytes": 4}),
            mock.patch.object(RUNALL, "run", return_value=CompletedProcess([], 0, "", "")),
            mock.patch.object(RUNALL, "hdfs", side_effect=hdfs),
            mock.patch.object(
                RUNALL, "hdfs_put_json", side_effect=lambda value, path: events.append(("put", path, value)),
            ),
            mock.patch.object(
                RUNALL, "java_commit", side_effect=lambda _, source, destination: events.append(
                    ("commit", source, destination)
                ),
            ),
            mock.patch.object(RUNALL, "hdfs_json", return_value=ready),
        ):
            RUNALL.commit_sector(config, context)

        expected = [
            ("hdfs", "dfs", "-rm", "-f", part),
            ("put", part, ready),
            ("hdfs", "dfs", "-mv", part, marker),
            ("commit", stage, final),
        ]
        self.assertEqual(expected, [event for event in events if event in expected])

    def test_server_runall_rejects_sector_audit_byte_mutation(self):
        context = {
            "run_id": "20260919T005932Z", "release_id": "20260919T005932Z",
            "source_list_sha256": "a" * 64, "sector": 7,
            "product_count": 19_995, "total_bytes": 1234,
        }
        config = {"code_release": "/opt/planetory-hdfs-load/releases/test"}
        with (
            mock.patch.object(RUNALL.shutil, "chown"),
            mock.patch.object(RUNALL, "hdfs_exists", return_value=True),
            mock.patch.object(RUNALL, "audit", return_value={
                "product_count": context["product_count"], "total_bytes": context["total_bytes"] + 1,
            }),
            mock.patch.object(RUNALL, "hdfs_json"),
            self.assertRaisesRegex(RuntimeError, "audit differs from coverage"),
        ):
            RUNALL.commit_sector(config, context)

    def test_source_cleanup_is_plan_bounded_and_idempotent(self):
        run_id = "20260919T005932Z"
        raw_root = self.root / "raw"
        plan = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, raw_root,
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
            run_id=run_id, release_id=run_id,
        )
        for bundle in plan["bundles"]:
            for entry in bundle["entries"]:
                entry["sha256"] = hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest()
        plan["plan_id"] = MODULE._plan_id(plan)
        plan_path = self.root / "worker-1.plan.json"
        MODULE.atomic_json(plan_path, plan)
        state_path = self.root / "worker-1.cleanup.json"
        unrelated = raw_root / "sector=0003" / "keep.txt"
        unrelated.write_text("keep", encoding="utf-8")
        final_uri = f"hdfs://planetory/lake/raw/tess/release={run_id}/sector=0003"
        ready = {
            "schema": MODULE.READY_SCHEMA, "run_id": run_id, "release_id": run_id,
            "source_list_sha256": self.source["source_list_sha256"], "sector": 3,
            "product_count": 3, "replication": 2,
        }

        def run(arguments, **_):
            if arguments[1:3] == ["dfs", "-cat"]:
                return CompletedProcess(arguments, 0, json.dumps(ready), "")
            if arguments[1:4] == ["dfs", "-test", "-e"]:
                return CompletedProcess(arguments, 0, "", "")
            raise AssertionError(arguments)

        parameters = {
            "run_id": run_id, "release_id": run_id,
            "source_sha": self.source["source_list_sha256"], "sector": 3, "worker_slot": 1,
        }
        with mock.patch.object(RUNALL, "run", side_effect=run):
            result = RUNALL.cleanup_plan_source(plan_path, raw_root, state_path, final_uri, **parameters)
            cached = RUNALL.cleanup_plan_source(plan_path, raw_root, state_path, final_uri, **parameters)
        self.assertEqual(result["removed_now_files"], 3)
        self.assertEqual(cached["previously_removed_files"], 3)
        self.assertTrue(unrelated.is_file())
        self.assertEqual(json.loads(state_path.read_text(encoding="utf-8"))["status"], "complete")

    def test_source_cleanup_accepts_legacy_plan_only_with_final_lineage(self):
        run_id = "20260918T080417Z"
        raw_root = self.root / "raw"
        plan = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, raw_root,
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
            run_id=run_id, release_id=run_id,
        )
        for key in ("run_id", "release_id", "sector_product_count", "replication"):
            plan.pop(key)
        plan["schema"] = MODULE.LEGACY_PLAN_SCHEMA
        for bundle in plan["bundles"]:
            for entry in bundle["entries"]:
                entry["sha256"] = hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest()
        plan["plan_id"] = MODULE._plan_id(plan)
        plan_path = self.root / "legacy.plan.json"
        MODULE.atomic_json(plan_path, plan)
        ready = {
            "schema": MODULE.READY_SCHEMA, "run_id": run_id, "release_id": run_id,
            "source_list_sha256": self.source["source_list_sha256"], "sector": 3,
            "product_count": 3, "replication": 2,
        }

        def run(arguments, **_):
            output = json.dumps(ready) if arguments[1:3] == ["dfs", "-cat"] else ""
            return CompletedProcess(arguments, 0, output, "")

        parameters = {
            "run_id": run_id, "release_id": run_id,
            "source_sha": self.source["source_list_sha256"], "sector": 3, "worker_slot": 1,
        }
        with mock.patch.object(RUNALL, "run", side_effect=run):
            result = RUNALL.cleanup_plan_source(
                plan_path, raw_root, self.root / "legacy.cleanup.json",
                f"hdfs://planetory/lake/raw/tess/release={run_id}/sector=0003", **parameters,
            )
        self.assertEqual(result["removed_now_files"], 3)

        ready["release_id"] = "wrong-release"
        with (
            mock.patch.object(RUNALL, "run", side_effect=run),
            self.assertRaisesRegex(RuntimeError, "final Raw identity mismatch"),
        ):
            RUNALL.cleanup_plan_source(
                plan_path, raw_root, self.root / "other.cleanup.json",
                f"hdfs://planetory/lake/raw/tess/release={run_id}/sector=0003", **parameters,
            )

    def test_source_cleanup_rejects_checksum_drift_before_deleting_anything(self):
        run_id = "20260919T005932Z"
        raw_root = self.root / "raw"
        plan = MODULE.build_plan(
            self.source_path, self.events_path, self.audit_path, raw_root,
            worker_slot=1, sector=3, target_bundle_bytes=512 << 20,
            run_id=run_id, release_id=run_id,
        )
        entries = [entry for bundle in plan["bundles"] for entry in bundle["entries"]]
        for entry in entries:
            entry["sha256"] = hashlib.sha256(Path(entry["path"]).read_bytes()).hexdigest()
        plan["plan_id"] = MODULE._plan_id(plan)
        plan_path = self.root / "worker-1.plan.json"
        MODULE.atomic_json(plan_path, plan)
        Path(entries[-1]["path"]).write_bytes(b"drift")
        ready = {
            "schema": MODULE.READY_SCHEMA, "run_id": run_id, "release_id": run_id,
            "source_list_sha256": self.source["source_list_sha256"], "sector": 3,
            "product_count": 3, "replication": 2,
        }

        def run(arguments, **_):
            output = json.dumps(ready) if arguments[1:3] == ["dfs", "-cat"] else ""
            return CompletedProcess(arguments, 0, output, "")

        with (
            mock.patch.object(RUNALL, "run", side_effect=run),
            self.assertRaisesRegex(RuntimeError, "no longer matches"),
        ):
            RUNALL.cleanup_plan_source(
                plan_path, raw_root, self.root / "cleanup.json",
                f"hdfs://planetory/lake/raw/tess/release={run_id}/sector=0003",
                run_id=run_id, release_id=run_id, source_sha=self.source["source_list_sha256"],
                sector=3, worker_slot=1,
            )
        self.assertTrue(all(Path(entry["path"]).is_file() for entry in entries))

    def test_server_runall_removes_stale_coverage_part_with_valid_ready(self):
        digest = "c" * 64
        run_id = "20260919T005932Z"
        stage = f"/lake/raw/tess/.staging/coverage={digest}/run={run_id}"
        final = f"/lake/raw/tess/coverage={digest}"
        staged_ready = f"{stage}/_READY.json"
        staged_part = f"{staged_ready}.part"
        ready = {"schema": MODULE.HDFS_COVERAGE_SCHEMA, "expected": 1, "sectors": []}
        calls = []
        events = []

        def build_ready(_, arguments):
            output = Path(arguments[arguments.index("--output") + 1])
            MODULE.atomic_json(output, ready)
            return CompletedProcess(arguments, 0, "", "")

        def exists(path):
            return path in {staged_ready, staged_part}

        def hdfs(arguments, **_):
            calls.append(arguments)
            if arguments == ["dfs", "-rm", "-f", staged_part]:
                events.append("remove-part")
            output = ""
            if arguments[:2] == ["dfs", "-find"]:
                output = "\n".join((stage, staged_ready, staged_part)) + "\n"
            return CompletedProcess(arguments, 0, output, "")

        config = {
            "run_id": run_id,
            "expected_coverage_sha256": digest,
            "coverage_manifest": str(self.root / "coverage.json"),
            "code_release": "/opt/planetory-hdfs-load/releases/test",
        }
        with (
            mock.patch.object(RUNALL.shutil, "chown"),
            mock.patch.object(RUNALL, "run_loader_as_hdfs", side_effect=build_ready),
            mock.patch.object(RUNALL, "hdfs_exists", side_effect=exists),
            mock.patch.object(RUNALL, "hdfs", side_effect=hdfs),
            mock.patch.object(RUNALL, "hdfs_json", return_value=ready),
            mock.patch.object(RUNALL, "hdfs_put_json") as put_json,
            mock.patch.object(
                RUNALL, "java_commit", side_effect=lambda *_: events.append("commit"),
            ) as java_commit,
        ):
            RUNALL.commit_coverage(config)
        self.assertIn(["dfs", "-rm", "-f", staged_part], calls)
        self.assertEqual(["remove-part", "commit"], events)
        put_json.assert_not_called()
        java_commit.assert_called_once_with(config, stage, final)


if __name__ == "__main__":
    unittest.main()

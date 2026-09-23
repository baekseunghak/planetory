"""Offline gates for immutable Sector admission and evidence reconciliation."""

import argparse
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import tess_sector_admission as admission  # noqa: E402


class AdmissionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root_patch = mock.patch.object(admission, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.args = argparse.Namespace(
            sector=14,
            script_url="https://archive.stsci.edu/missions/tess/download_scripts/sector/tesscurl_sector_14_lc.sh",
            ingestion_release="/mnt/data/planetory-ingestion/releases/20260922T000000Z",
            hdfs_release="/opt/planetory-hdfs-load/releases/20260922T000000Z",
            bronze_release="/opt/planetory-bronze/releases/20260922T000000Z",
            bronze_pipeline_version="S15P21C206-252",
            bronze_output_partitions=40,
        )

    def test_rejects_wrong_sector_or_nonimmutable_release(self):
        with self.assertRaisesRegex(ValueError, "official"):
            admission.validate_options(15, self.args.script_url, self.args.ingestion_release,
                self.args.hdfs_release, self.args.bronze_release,
                self.args.bronze_pipeline_version, self.args.bronze_output_partitions)
        with self.assertRaisesRegex(ValueError, "immutable HDFS"):
            admission.validate_options(14, self.args.script_url, self.args.ingestion_release,
                "/opt/planetory-hdfs-load/releases/../current", self.args.bronze_release,
                self.args.bronze_pipeline_version, self.args.bronze_output_partitions)

    def test_prepare_reuses_immutable_intent_after_interruption(self):
        source = {"source_list_sha256": "a" * 64, "product_count": 10}
        with mock.patch.object(admission, "locked_root", return_value=nullcontext()), \
             mock.patch.object(admission, "prepare_source", return_value=source), \
             mock.patch.object(admission.tess, "sha256_file", return_value="b" * 64), \
             mock.patch.object(admission, "install_worker") as install:
            first = admission.prepare(self.args)
            second = admission.prepare(self.args)
            self.assertEqual(first, second)
            self.assertEqual(install.call_count, 10)
            self.args.bronze_output_partitions = 41
            with self.assertRaisesRegex(ValueError, "immutable intent"):
                admission.prepare(self.args)

    def test_cleanup_without_raw_final_is_not_a_download_retry(self):
        state = {
            "sector": 14, "run_id": "20260922T000000Z", "installed": True,
            "source_list_sha256": "a" * 64, "product_count": 10,
            "source_document_sha256": "b" * 64,
            "bronze_pipeline_version": "S15P21C206-252",
        }
        admission.state_path(14).write_text(json.dumps(state), encoding="utf-8")
        cleanup = {
            "schema": "planetory.tess-source-cleanup.v1", "status": "complete",
            "run_id": state["run_id"], "release_id": state["run_id"],
            "source_list_sha256": state["source_list_sha256"], "sector": 14, "worker_slot": 1,
        }
        with mock.patch.object(admission.tess, "load_source_list", return_value={
            "source_list_sha256": "a" * 64,
            "products": [{"assigned_worker": slot} for slot in range(1, 6) for _ in range(2)],
        }), mock.patch.object(admission.tess, "sha256_file", return_value="b" * 64), \
             mock.patch.object(admission.raw, "hdfs_exists", return_value=False), \
             mock.patch.object(admission, "_optional_worker_json", return_value=cleanup):
            with self.assertRaisesRegex(ValueError, "without Raw final"):
                admission.status(14)

    def test_worker_completion_counts_match_frozen_assignments(self):
        state = {"sector": 14, "run_id": "20260922T000000Z",
                 "source_list_sha256": "a" * 64, "product_count": 10}
        products = [{"assigned_worker": slot} for slot in range(1, 6) for _ in range(2)]

        def worker_reply(worker, *_args, **_kwargs):
            slot = worker["slot"]
            return SimpleNamespace(stdout=json.dumps({
                "schema": "planetory.ingestion-sector-complete.v1", "sector": 14,
                "worker_slot": slot, "source_list_sha256": "a" * 64,
                "validated": 2, "total_bytes": 100,
            }))

        with mock.patch.object(admission.tess, "load_source_list", return_value={"products": products}), \
             mock.patch.object(admission.raw, "ssh", side_effect=worker_reply) as ssh:
            self.assertEqual(len(admission.worker_markers(state)), 5)
            ssh.side_effect = lambda worker, *_a, **_k: SimpleNamespace(stdout=json.dumps({
                "schema": "planetory.ingestion-sector-complete.v1", "sector": 14,
                "worker_slot": worker["slot"], "source_list_sha256": "a" * 64,
                "validated": 3, "total_bytes": 100,
            }))
            with self.assertRaisesRegex(ValueError, "completion marker"):
                admission.worker_markers(state)

    def test_partial_cleanup_resumes_at_cleanup_stage(self):
        state = {
            "sector": 14, "run_id": "20260922T000000Z", "installed": True,
            "source_list_sha256": "a" * 64, "source_document_sha256": "b" * 64,
            "product_count": 10, "bronze_pipeline_version": "S15P21C206-252",
        }
        admission.state_path(14).write_text(json.dumps(state), encoding="utf-8")
        raw_ready = {
            "run_id": state["run_id"], "release_id": state["run_id"],
            "source_list_sha256": "a" * 64, "sector": 14,
            "product_count": 10, "replication": 2,
        }
        partial = {
            "schema": "planetory.tess-source-cleanup.v1", "status": "in_progress",
            "run_id": state["run_id"], "release_id": state["run_id"],
            "source_list_sha256": "a" * 64, "sector": 14, "worker_slot": 1,
        }
        with mock.patch.object(admission.tess, "load_source_list", return_value={
            "source_list_sha256": "a" * 64, "products": [
                {"assigned_worker": slot} for slot in range(1, 6) for _ in range(2)
            ],
        }), mock.patch.object(admission.tess, "sha256_file", return_value="b" * 64), \
             mock.patch.object(admission.raw, "hdfs_exists", side_effect=lambda path: "/raw/" in path), \
             mock.patch.object(admission.raw, "hdfs_json", return_value=raw_ready), \
             mock.patch.object(admission, "_optional_worker_json",
                               side_effect=lambda slot, _path: partial if slot == 1 else None):
            self.assertEqual(admission.status(14)["evidence"], {
                "download": True, "raw": True, "cleanup": False, "bronze": False,
            })


if __name__ == "__main__":
    unittest.main()

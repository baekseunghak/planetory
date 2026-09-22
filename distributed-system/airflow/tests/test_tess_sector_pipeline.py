import ast
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


DAGS = Path(__file__).resolve().parents[1] / "dags"
sys.path.insert(0, str(DAGS))

from tess_pipeline_contract import (  # noqa: E402
    command,
    release_path,
    remaining_wait_time,
    sector_inputs,
    stage_inputs,
    validate_download_markers,
)


class TessSectorPipelineContractTest(unittest.TestCase):
    def test_five_matching_download_markers_are_aggregated(self):
        source_sha = "a" * 64
        markers = [
            {
                "schema": "planetory.ingestion-sector-complete.v1",
                "sector": 7,
                "worker_slot": slot,
                "validated": slot,
                "total_bytes": slot * 10,
                "source_list_sha256": source_sha,
            }
            for slot in range(1, 6)
        ]
        value = validate_download_markers(markers, 7, "20260919T005932Z", source_sha)
        self.assertEqual(value["product_count"], 15)
        self.assertEqual(value["total_bytes"], 150)

    def test_missing_or_mismatched_worker_marker_is_rejected(self):
        source_sha = "a" * 64
        markers = [
            {
                "schema": "planetory.ingestion-sector-complete.v1",
                "sector": 7,
                "worker_slot": slot,
                "validated": 1,
                "total_bytes": 10,
                "source_list_sha256": source_sha,
            }
            for slot in range(1, 5)
        ]
        with self.assertRaisesRegex(ValueError, "five Worker markers"):
            validate_download_markers(markers, 7, "20260919T005932Z", source_sha)
        markers.append({**markers[0], "worker_slot": 5, "source_list_sha256": "b" * 64})
        with self.assertRaisesRegex(ValueError, "invalid download completion marker"):
            validate_download_markers(markers, 7, "20260919T005932Z", source_sha)

    def test_lineage_paths_and_shell_arguments_are_bounded(self):
        params = {
            "sector_runs": {"1": "20260919T005932Z"},
            "sector_source_sha256": {"1": "a" * 64},
        }
        self.assertEqual(sector_inputs(params, 1), ("20260919T005932Z", "a" * 64))
        self.assertEqual(
            release_path(
                "/opt/planetory-hdfs-load/releases/20260921T101150Z",
                "/opt/planetory-hdfs-load/releases/",
            ),
            "/opt/planetory-hdfs-load/releases/20260921T101150Z",
        )
        with self.assertRaisesRegex(ValueError, "stay below"):
            release_path("/opt/planetory-hdfs-load/releases/../current", "/opt/planetory-hdfs-load/releases/")
        self.assertEqual(command(["printf", "%s", "a b"]), "printf %s 'a b'")
        with self.assertRaisesRegex(ValueError, "missing Sector 2 lineage"):
            sector_inputs(params, 2)

    def test_download_wait_keeps_its_original_deadline_after_deferral(self):
        started = datetime(2026, 9, 22, tzinfo=timezone.utc)
        timeout = timedelta(days=14)
        self.assertEqual(
            remaining_wait_time(started, timeout, started + timedelta(minutes=5)),
            timeout - timedelta(minutes=5),
        )
        self.assertLessEqual(remaining_wait_time(started, timeout, started + timeout), timedelta())
        with self.assertRaisesRegex(ValueError, "positive"):
            remaining_wait_time(started, timedelta(), started)

    def test_legacy_sector_1_to_13_dag_is_retired(self):
        self.assertFalse((DAGS / "tess_sector_pipeline.py").exists())

    def test_stage_lineage_and_four_paused_dags(self):
        conf = {
            "sector": 70, "run_id": "20260922T000000Z", "source_list_sha256": "a" * 64,
            "hdfs_release": "/opt/planetory-hdfs-load/releases/20260922T000000Z",
            "hdfs_config": "/etc/planetory/tess-hdfs-runall/20260922T000000Z.json",
            "bronze_release": "/opt/planetory-bronze/releases/20260922T000000Z",
            "bronze_run_id": "20260922T000000Z", "bronze_pipeline_version": "S15P21C206-252",
            "bronze_output_partitions": 40,
        }
        value = stage_inputs(conf)
        self.assertEqual(value, stage_inputs(value))
        self.assertEqual(stage_inputs({**conf, "attempt": 3})["lineage_sha256"], value["lineage_sha256"])
        with self.assertRaisesRegex(ValueError, "attempt"):
            stage_inputs({**conf, "attempt": -1})
        with self.assertRaisesRegex(ValueError, "lineage changed"):
            stage_inputs({**value, "source_list_sha256": "b" * 64})
        with self.assertRaises(ValueError):
            stage_inputs({**conf, "hdfs_config": "/etc/planetory/tess-hdfs-runall/../other"})
        source = (DAGS / "tess_stage_dags.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        ids = [
            keyword.value.value
            for node in ast.walk(tree) if isinstance(node, ast.Call)
            for keyword in node.keywords
            if keyword.arg == "dag_id" and isinstance(keyword.value, ast.Constant)
        ]
        self.assertEqual(set(ids), {
            "tess_sector_download", "tess_sector_raw", "tess_sector_cleanup", "tess_sector_bronze",
        })
        self.assertIn('is_paused_upon_creation=True', source)
        self.assertIn('"--expected-source-sha"', source)
        self.assertIn('Variable.set("tess_pipeline_enabled", "false")', source)
        self.assertIn('except AirflowFailException as error:', source)
        self.assertIn('class DownloadMarkerWaitOperator(BaseOperator):', source)
        self.assertIn('TimeDeltaTrigger(timedelta(minutes=5))', source)
        self.assertIn('timeout=remaining', source)
        self.assertNotIn('mode="reschedule"', source)
        marker_func = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "download_markers"
        )
        worker_loop = next(node for node in marker_func.body if isinstance(node, ast.For))
        self.assertFalse(any(isinstance(node, ast.Return) for node in ast.walk(worker_loop)))


if __name__ == "__main__":
    unittest.main()

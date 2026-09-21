import sys
import unittest
from pathlib import Path


DAGS = Path(__file__).resolve().parents[1] / "dags"
sys.path.insert(0, str(DAGS))

from tess_pipeline_contract import (  # noqa: E402
    command,
    release_path,
    sector_inputs,
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

    def test_dag_keeps_the_required_sector_order_and_terminal_exit(self):
        source = (DAGS / "tess_sector_pipeline.py").read_text(encoding="utf-8")
        self.assertIn("for sector in range(1, 14):", source)
        self.assertIn('previous >> downloaded', source)
        self.assertIn('"runall", "--config", config,', source)
        self.assertIn('"cleanup-sector", "--config", config,', source)
        self.assertIn('task_id=f"cleanup_local_sector_{sector:02d}"', source)
        self.assertIn('"coverage", "--release-dir", release,', source)
        self.assertIn("terminal_exit=65", source)


if __name__ == "__main__":
    unittest.main()

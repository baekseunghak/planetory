import ast
import sys
import unittest
from pathlib import Path


DAGS = Path(__file__).resolve().parents[1] / "dags"
sys.path.insert(0, str(DAGS))

from tess_silver_contract import silver_command  # noqa: E402


BASE = {
    "operation": "run",
    "silver_release": "/opt/planetory-silver/releases/20260922T000000Z",
    "bronze_coverage": "/lake/bronze/tess/coverage=" + "a" * 64,
    "run_id": "20260922T010000Z",
    "pipeline_version": "S15P21C206-78-20260922T000000Z",
}


class SilverDagContractTest(unittest.TestCase):
    def test_run_has_only_validated_arguments(self):
        command = silver_command(BASE)
        self.assertIn("tess_silver_ctl.py run --release-dir", command)
        self.assertIn("--bronze-coverage", command)
        self.assertNotIn("--tic-id", command)

    def test_canary_and_retry_have_disjoint_inputs(self):
        self.assertIn("--tic-id 123", silver_command({**BASE, "operation": "canary", "tic_ids": [123]}))
        retry = "/lake/silver/pipeline_version=v1/run_id=20260922T010000Z/attempt=20260922T020000Z"
        self.assertIn("--retry-from", silver_command({**BASE, "operation": "retry", "retry_from": retry}))
        for invalid in (
            {**BASE, "operation": "canary", "tic_ids": []},
            {**BASE, "operation": "run", "tic_ids": [123]},
            {**BASE, "operation": "retry"},
            {**BASE, "operation": "canary", "tic_ids": [123, 123]},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                silver_command(invalid)

    def test_paths_and_shell_metacharacters_fail_closed(self):
        for key, value in (
            ("silver_release", "/opt/planetory-silver/releases/../current"),
            ("bronze_coverage", "/lake/bronze/tess/sector=0014"),
            ("run_id", "20260922T010000Z; id"),
            ("pipeline_version", "v1' && id"),
            ("shuffle_partitions", True),
            ("tic_ids", None),
            ("unexpected", "ignored"),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                silver_command({**BASE, key: value})

    def test_dag_is_opt_in_and_uses_yarn_pool(self):
        source = (DAGS / "tess_silver_dag.py").read_text(encoding="utf-8")
        ast.parse(source)
        self.assertIn('is_paused_upon_creation=True', source)
        self.assertIn('schedule=None', source)
        self.assertIn('pool="tess_yarn"', source)
        self.assertIn('tess_pipeline_enabled', source)
        self.assertIn('"tess_sector_raw", "tess_sector_bronze"', source)
        self.assertIn('"tess_sector_download_raw_bronze"', source)


if __name__ == "__main__":
    unittest.main()

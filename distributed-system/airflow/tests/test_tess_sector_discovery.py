import ast
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from tess_sector_discovery import (  # noqa: E402
    INDEX_URL, MAX_INDEX_BYTES, completed_through, effective_max_sector, latest_published_sector, next_sector_stage,
    parse_lc_scripts, published_lc_scripts, resume_stage, retry_attempt, retry_attempt_from_task,
)


class TessSectorDiscoveryTest(unittest.TestCase):
    def test_index_fetch_rejects_redirect_and_oversized_body(self):
        class Response:
            def __init__(self, url, body):
                self.url, self.body = url, body

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def geturl(self):
                return self.url

            def read(self, limit):
                return self.body[:limit]

        with patch("tess_sector_discovery.urlopen", return_value=Response("https://evil.example/", b"")):
            with self.assertRaisesRegex(ValueError, "redirected"):
                published_lc_scripts()
        with patch("tess_sector_discovery.urlopen", return_value=Response(INDEX_URL, b"x" * (MAX_INDEX_BYTES + 1))):
            with self.assertRaisesRegex(ValueError, "size limit"):
                published_lc_scripts()

    def test_only_official_two_minute_lc_links_are_discovered(self):
        html = """
        <a href="https://archive.stsci.edu/missions/tess/download_scripts/sector/tesscurl_sector_14_lc.sh">LC</a>
        <a href="/missions/tess/download_scripts/sector/tesscurl_sector_15_lc.sh">LC</a>
        <a href="/missions/tess/download_scripts/sector/tesscurl_sector_15_fast-lc.sh">fast LC</a>
        <a href="https://evil.example/missions/tess/download_scripts/sector/tesscurl_sector_16_lc.sh">other</a>
        """
        scripts = parse_lc_scripts(html)
        self.assertEqual(set(scripts), {14, 15})
        self.assertEqual(scripts[14].split("/")[-1], "tesscurl_sector_14_lc.sh")

    def test_empty_or_untrusted_index_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "no official"):
            parse_lc_scripts('<a href="https://evil.example/tesscurl_sector_14_lc.sh">x</a>')

    def test_configured_ceiling_bounds_latest(self):
        scripts = {14: "script14", 70: "script70", 71: "script71"}
        self.assertEqual(latest_published_sector(scripts, 70), 70)
        self.assertEqual(latest_published_sector(scripts, 15), 14)
        self.assertIsNone(latest_published_sector(scripts, 13))
        with self.assertRaisesRegex(ValueError, "1..70"):
            latest_published_sector(scripts, True)

    def test_persistent_cap_bounds_scheduled_and_manual_runs(self):
        self.assertEqual(effective_max_sector(70, "14"), 14)
        self.assertEqual(effective_max_sector(15, "70"), 15)
        for invalid in ("13", "71", "bad", True):
            with self.assertRaises(ValueError):
                effective_max_sector(70, invalid)

    def test_completed_mark_skips_only_confirmed_contiguous_sectors(self):
        self.assertEqual(completed_through("13"), 13)
        self.assertEqual(completed_through("27"), 27)
        for invalid in ("12", "71", "bad", True):
            with self.assertRaises(ValueError):
                completed_through(invalid)
        source = (Path(__file__).resolve().parents[1] / "dags" / "tess_sector_discovery_dag.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("for sector in range(done + 1, max_sector + 1):", source)
        # The mark advances only across an unbroken run of completed Sectors.
        self.assertIn("if contiguous == sector - 1:", source)
        self.assertLess(source.index("if contiguous != done:"), source.index("return plans"))

    def test_resume_uses_downstream_evidence_after_download_cleanup(self):
        self.assertEqual(resume_stage({"download": True}), "raw")
        self.assertEqual(resume_stage({"raw": True}), "cleanup")
        self.assertEqual(resume_stage({"raw": True, "cleanup": True, "bronze": True}), None)
        with self.assertRaisesRegex(ValueError, "without Raw final"):
            resume_stage({"cleanup": True})
        with self.assertRaisesRegex(ValueError, "without local cleanup"):
            resume_stage({"raw": True, "bronze": True})
        with self.assertRaisesRegex(ValueError, "invalid"):
            resume_stage({"raw": "true"})
        with self.assertRaisesRegex(ValueError, "invalid"):
            resume_stage(None)

    def test_first_unfinished_sector_is_selected_without_skipping_gap(self):
        published = {14: "script14", 15: "script15", 17: "script17"}
        evidence = {14: {"raw": True, "cleanup": True, "bronze": True}, 15: {"raw": True}}
        self.assertEqual(next_sector_stage(published, evidence, max_sector=17), (15, "cleanup"))
        evidence[15] = {"raw": True, "cleanup": True, "bronze": True}
        self.assertIsNone(next_sector_stage(published, evidence, max_sector=17))
        with self.assertRaisesRegex(ValueError, "1..70"):
            next_sector_stage(published, evidence, max_sector=71)

    def test_failed_stage_is_retried_but_running_or_successful_is_not_replayed(self):
        prefix = "tess_s14_" + "a" * 16 + "_r"
        self.assertEqual(retry_attempt([], prefix), 0)
        self.assertEqual(retry_attempt([(prefix + "0", "failed")], prefix), 1)
        self.assertIsNone(retry_attempt([(prefix + "0", "failed"), (prefix + "1", "running")], prefix))
        with self.assertRaisesRegex(ValueError, "lacks its final evidence"):
            retry_attempt([(prefix + "0", "success")], prefix)
        with self.assertRaisesRegex(ValueError, "unexpected"):
            retry_attempt([(prefix + "other", "failed")], prefix)

    def test_task_sdk_retry_uses_existing_run_states(self):
        prefix = "tess_s14_" + "a" * 16 + "_r"

        class TaskInstance:
            states = {prefix + "0": "failed", prefix + "1": "running"}

            def get_dr_count(self, dag_id, run_ids):
                assert dag_id == "tess_sector_raw"
                return int(run_ids[0] in self.states)

            def get_dagrun_state(self, dag_id, run_id):
                return self.states[run_id]

        ti = TaskInstance()
        self.assertIsNone(retry_attempt_from_task(ti, "tess_sector_raw", prefix))
        ti.states[prefix + "1"] = "failed"
        self.assertEqual(retry_attempt_from_task(ti, "tess_sector_raw", prefix), 2)
        ti.states[prefix + "1"] = "success"
        with self.assertRaisesRegex(ValueError, "lacks its final evidence"):
            retry_attempt_from_task(ti, "tess_sector_raw", prefix)

    def test_upstream_retry_does_not_leave_a_gap_in_next_stage_attempts(self):
        # Download r0 failed and r1 succeeded; its trigger must start Raw at r0 so the
        # contiguous lookup sees the running Raw instead of scheduling a duplicate.
        prefix = "tess_s21_" + "a" * 16 + "_r"
        stage_source = (Path(__file__).resolve().parents[1] / "dags" / "tess_stage_dags.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("_r0\",", stage_source)
        self.assertIn("attempt=0)", stage_source)

        class TaskInstance:
            states = {prefix + "0": "running"}

            def get_dr_count(self, dag_id, run_ids):
                return int(run_ids[0] in self.states)

            def get_dagrun_state(self, dag_id, run_id):
                return self.states[run_id]

        self.assertIsNone(retry_attempt_from_task(TaskInstance(), "tess_sector_raw", prefix))

    def test_discovery_dag_maps_sector_plans_and_defaults_to_paused(self):
        source = (Path(__file__).resolve().parents[1] / "dags" / "tess_sector_discovery_dag.py").read_text(
            encoding="utf-8"
        )
        ast.parse(source)
        self.assertIn('is_paused_upon_creation=True', source)
        self.assertIn('default="false"', source)
        self.assertIn(').expand_kwargs(reconcile())', source)
        self.assertIn('if stage == "download":', source)
        self.assertIn('resuming admitted Sectors only', source)
        self.assertLess(source.index('current = admission(hdfs_release, "status", sector)'),
                        source.index('sector not in scripts'))


if __name__ == "__main__":
    unittest.main()

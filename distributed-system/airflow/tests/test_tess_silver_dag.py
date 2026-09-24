import ast
import importlib.util
import json
import re
import shlex
import sys
import unittest
from pathlib import Path


DAGS = Path(__file__).resolve().parents[1] / "dags"
sys.path.insert(0, str(DAGS))

from tess_silver_contract import silver_command, silver_status_command  # noqa: E402


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
        self.assertIn("tess_silver_ctl.py start-unit run --release-dir", command)
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

    def test_status_reuses_the_start_validation(self):
        self.assertTrue(silver_status_command(BASE).endswith(
            "tess_silver_ctl.py status run --run-id 20260922T010000Z"))
        with self.assertRaises(ValueError):
            silver_status_command({**BASE, "run_id": "x"})

    def test_dag_is_opt_in_and_waits_in_the_triggerer(self):
        source = (DAGS / "tess_silver_dag.py").read_text(encoding="utf-8")
        ast.parse(source)
        self.assertIn('is_paused_upon_creation=True', source)
        self.assertIn('schedule=None', source)
        # The YARN cap lives in the Node 1 controller; a pool slot would be held for days.
        self.assertNotIn('pool=', source)
        self.assertIn('TimeDeltaTrigger', source)
        self.assertIn('airflow.sdk', source)
        self.assertNotIn('create_session', source)

    def test_generated_commands_match_the_node1_sudoers_policy(self):
        # The DAG builds the command and the setup script writes the sudo regex; they must agree.
        script = (DAGS.parents[2] / "infra/distributed-system/scripts/"
                  "configure-tess-silver-airflow-node1.sh").read_text(encoding="utf-8")
        release = BASE["silver_release"]
        # The heredoc is unquoted, so bash reduces the doubled backslash before sudo reads it.
        patterns = [re.compile(row.split("NOPASSWD: /usr/bin/python3.12 ", 1)[1]
                               .replace("$release", release).replace("\\\\", "\\"))
                    for row in script.splitlines() if row.startswith("tess-airflow ALL=")]
        self.assertEqual(len(patterns), 2)
        cases = (
            {**BASE, "operation": "canary", "tic_ids": [1, 2, 3, 4, 5]},
            {**BASE, "operation": "run"},
            {**BASE, "operation": "retry", "retry_from": (
                "/lake/silver/pipeline_version=v1/run_id=20260922T010000Z/attempt=20260922T020000Z")},
        )
        for conf in cases:
            for build in (silver_command, silver_status_command):
                argv = shlex.split(build(conf))
                with self.subTest(operation=conf["operation"], command=build.__name__):
                    self.assertEqual(argv[:3], ["/usr/bin/sudo", "-n", "/usr/bin/python3.12"])
                    self.assertTrue(any(p.fullmatch(" ".join(argv[3:])) for p in patterns))

    def test_silver_starts_beside_the_bounded_bronze_pool(self):
        # Bronze uses the Pool; Silver is capped by the controller slots, never by blocking on Sector stages.
        silver = (DAGS / "tess_silver_dag.py").read_text(encoding="utf-8")
        stages = (DAGS / "tess_stage_dags.py").read_text(encoding="utf-8")
        ast.parse(stages)
        self.assertIn('pool="tess_yarn"', stages)
        self.assertIn('task_id="commit_bronze"', stages)
        for blocking in ("tess_pipeline_enabled", "get_dr_count", "tess_sector_bronze"):
            with self.subTest(blocking=blocking):
                self.assertNotIn(blocking, silver)


@unittest.skipUnless(importlib.util.find_spec("airflow"), "Airflow is not installed")
class SilverStateTest(unittest.TestCase):
    def state(self, attempt=None, **unit):
        from tess_silver_dag import silver_state

        systemd = {"LoadState": "loaded", "ActiveState": "inactive", "Result": "success",
                   "ExecMainStatus": "0", "ExecMainStartTimestampMonotonic": "123", **unit}
        return silver_state("noise\nSILVER_STATUS_JSON=" + json.dumps(
            {"unit": "u", "systemd": systemd, "attempt": attempt}))

    def test_running_queued_and_restarting_units_are_pending(self):
        self.assertEqual(self.state(ActiveState="active"), "pending")
        self.assertEqual(self.state(ActiveState="activating"), "pending")
        self.assertEqual(self.state(ExecMainStartTimestampMonotonic="0"), "pending")

    def test_only_a_successful_unit_with_a_complete_attempt_completes(self):
        self.assertEqual(self.state({"status": "complete", "result": {}}), "complete")
        from airflow.sdk.exceptions import AirflowException, AirflowFailException

        for attempt, unit in (
            (None, {}),
            ({"status": "terminal_failed"}, {"Result": "exit-code", "ExecMainStatus": "65"}),
            ({"status": "running"}, {"Result": "exit-code", "ExecMainStatus": "1"}),
            ({"status": "complete"}, {"LoadState": "not-found"}),
        ):
            with self.subTest(attempt=attempt, unit=unit), self.assertRaises(AirflowFailException):
                self.state(attempt, **unit)
        with self.assertRaises(AirflowException):
            __import__("tess_silver_dag").silver_state("no status line")

    def test_pending_unit_defers_to_the_triggerer_until_the_original_deadline(self):
        from datetime import datetime, timedelta, timezone
        from types import SimpleNamespace
        from unittest import mock

        from airflow.sdk.exceptions import AirflowFailException, TaskDeferred

        import tess_silver_dag

        pending = "SILVER_STATUS_JSON=" + json.dumps({"unit": "u", "attempt": None, "systemd": {
            "LoadState": "loaded", "ActiveState": "active", "ExecMainStartTimestampMonotonic": "9"}})
        operator = tess_silver_dag.SilverUnitWaitOperator(task_id="wait")
        now = datetime.now(timezone.utc)
        with mock.patch.object(tess_silver_dag, "remote", return_value=(0, pending)):
            context = {"dag_run": SimpleNamespace(conf=BASE), "ti": SimpleNamespace(start_date=now)}
            with self.assertRaises(TaskDeferred) as deferred:
                operator.execute(context)
            self.assertGreater(deferred.exception.timeout, timedelta(days=13))
            context["ti"].start_date = now - timedelta(days=15)
            with self.assertRaises(AirflowFailException):
                operator.execute_complete(context)


if __name__ == "__main__":
    unittest.main()

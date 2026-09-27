import ast
import json
import sys
import unittest
from pathlib import Path

DAGS = Path(__file__).resolve().parents[1] / "dags"
sys.path.insert(0, str(DAGS))

from tess_publication_contract import (collect_command, gate_start_command, gold_start_command,  # noqa: E402
                                       publication_request, status_command, unit_progress)

RELEASE = "/opt/planetory-silver/releases/20260927T000000Z"
SILVER = ("/lake/silver/pipeline_version=S15P21C206-78-20260924T093328Z/"
          "run_id=20260924T133559Z/attempt=20260924T133730Z")
CONF = {"release": RELEASE, "run_id": "20260927T010000Z", "silver_attempt": SILVER,
        "required_sources": ["nea_toi", "exofop_toi"], "exclude_tics": [307210830, 149603524],
        "approvals": {"identity": "S15P21C206-112/MR152/8aaf335d", "discoverability": "S15P21C206-123/MR173/e7b578fd",
                      "external": "S15P21C206-124/MR190/67a9e741"}}
ATTEMPT = "/lake/gold/tess/publication-candidates/run_id=20260927T010000Z/attempt=20260927T020000Z"


class PublicationContractTest(unittest.TestCase):
    def test_commands_follow_the_sudo_policy_order(self):
        request = publication_request(CONF)
        self.assertEqual(collect_command(request), f"/usr/bin/sudo -n /usr/bin/python3.12 {RELEASE}/spark/"
                         f"tess_external_ctl.py collect --run-id 20260927T010000Z --release-dir {RELEASE}")
        gold = gold_start_command(request)
        self.assertIn(f"start-unit run --release-dir {RELEASE} --run-id 20260927T010000Z --silver-attempt {SILVER} "
                      "--external /lake/external/tess/run_id=20260927T010000Z --required-source exofop_toi "
                      "--required-source nea_toi --exclude-tic 149603524 --exclude-tic 307210830 "
                      "--approval-identity S15P21C206-112/MR152/8aaf335d", gold)
        self.assertTrue(gold.endswith("--shuffle-partitions 400 --output-partitions 40"))
        self.assertTrue(gate_start_command(request, ATTEMPT).endswith(f"start-unit gate --release-dir {RELEASE} "
                                                                      f"--attempt {ATTEMPT}"))
        self.assertTrue(status_command(request, "gate").endswith("status gate --run-id 20260927T010000Z"))
        self.assertNotIn("'", gold)  # every value is a single safe token, so shlex adds no quotes

    def test_unsafe_or_incomplete_requests_are_refused(self):
        for change in ({"extra": 1}, {"release": "/tmp/r"}, {"run_id": "run-1"}, {"silver_attempt": "/lake/x"},
                       {"required_sources": []}, {"required_sources": ["nea_toi", "nea_toi"]},
                       {"required_sources": ["other"]}, {"exclude_tics": [0]}, {"exclude_tics": [1, 1]},
                       {"approvals": {**CONF["approvals"], "external": "MR 190"}},
                       {"approvals": {"identity": "a", "discoverability": "b"}}, {"shuffle_partitions": 0}):
            with self.assertRaises(ValueError, msg=change):
                publication_request({**CONF, **change})
        missing = dict(CONF)
        del missing["exclude_tics"]  # leaving out the tutorial list must be explicit, even as []
        with self.assertRaises(ValueError):
            publication_request(missing)
        self.assertEqual(publication_request({**CONF, "exclude_tics": []})["exclude_tics"], [])
        with self.assertRaises(ValueError):
            gate_start_command(publication_request(CONF), ATTEMPT.replace("run_id=20260927T010000Z",
                                                                          "run_id=20260101T000000Z"))

    def test_unit_progress_reads_controller_status(self):
        def status(systemd, state):
            return "noise\nGOLD_STATUS_JSON=" + json.dumps({"unit": "u", "systemd": systemd, "state": state})

        loaded = {"LoadState": "loaded", "ActiveState": "inactive", "ExecMainStartTimestampMonotonic": "1"}
        self.assertEqual(unit_progress(status(loaded, {"status": "complete", "final": ATTEMPT}), "complete", 6)[0],
                         "complete")
        self.assertEqual(unit_progress(status({**loaded, "ActiveState": "active"}, {"status": "prepared"}),
                                       "complete", 6), ("pending", None))
        self.assertEqual(unit_progress(status({**loaded, "ExecMainStartTimestampMonotonic": "0"}, None),
                                       "complete", 6), ("pending", None))
        for systemd, state in (({**loaded, "ExecMainStatus": "65"}, {"status": "failed"}),
                               (loaded, {"status": "rejected", "errors": ["tic 7"]}),
                               ({**loaded, "ActiveState": "active", "NRestarts": "7"}, {}),
                               ({"LoadState": "not-found"}, None), (loaded, {"status": "failed"})):
            self.assertEqual(unit_progress(status(systemd, state), "publish_ready", 6)[0], "terminal")
        self.assertEqual(unit_progress("no marker", "complete", 6)[0], "failed")

    def test_dag_is_opt_in_and_ends_with_the_approval(self):
        source = (DAGS / "tess_publication_dag.py").read_text(encoding="utf-8")
        ast.parse(source)
        for expected in ('dag_id="tess_publication_run"', "is_paused_upon_creation=True", "schedule=None",
                         "ApprovalOperator(", "fail_on_reject=True", "start_gate(wait_gold.output) >> wait_gate >> approve"):
            self.assertIn(expected, source)


if __name__ == "__main__":
    unittest.main()

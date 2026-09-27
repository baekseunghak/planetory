"""80 Gold 제어기: 입력 계보 검증, 제출 인자, 확정 marker, staging 보호를 HDFS·YARN 호출 없이 본다."""
import json
import re
import sys
import unittest
from argparse import Namespace
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_bronze_ctl  # noqa: E402
import tess_gold  # noqa: E402
import tess_gold_ctl as ctl  # noqa: E402
from tess_gold_ctl import GoldDataContractError  # noqa: E402
from tess_silver_ctl import SilverDataContractError  # noqa: E402

SILVER = ("/lake/silver/pipeline_version=S15P21C206-78-20260924T093328Z/"
          "run_id=20260924T133559Z/attempt=20260924T133730Z")
EXTERNAL = "/lake/external/tess/run_id=20260927T000000Z"
COVERAGE = dict(coverage_sha256="a" * 64, ready_sha256="b" * 64, bronze_paths=["/lake/bronze/tess/sector=0001"])


def args(**overrides):
    value = dict(command="run", run_id="20260927T010000Z", silver_attempt=SILVER, external=EXTERNAL,
                 required_source=["nea_toi"], exclude_tic=[149603524], approval_identity="112 !152",
                 approval_discoverability="123 !173", approval_external="124 !190", shuffle_partitions=400,
                 output_partitions=40, tic_id=None)
    return Namespace(**dict(value, **overrides))


class InputLineageTest(unittest.TestCase):
    def test_stage_and_job_agree_on_the_terminal_marker(self):
        self.assertEqual(ctl.GOLD_TERMINAL_SCHEMA, tess_gold.GOLD_TERMINAL_SCHEMA)

    def test_external_snapshot_must_cover_the_required_sources(self):
        marker = {"schema": ctl.EXTERNAL_READY_SCHEMA, "sources": {"nea_toi": {"sha256": "c" * 64}}}
        present = {f"{EXTERNAL}/sources/nea_toi.csv"}
        self.assertEqual(ctl.EXTERNAL_READY_SCHEMA, tess_gold.EXTERNAL_READY_SCHEMA)
        with patch.object(ctl, "hdfs_json", lambda path: (marker, "r" * 64)), patch.object(ctl, "fsck_healthy"), \
                patch.object(ctl, "hdfs_exists", lambda path: path in present):
            self.assertEqual(ctl.external_input(EXTERNAL, ["nea_toi"])["ready_sha256"], "r" * 64)
            with self.assertRaisesRegex(GoldDataContractError, "exactly"):
                ctl.external_input(EXTERNAL, ["nea_toi", "exofop_toi"])
            present.clear()
            with self.assertRaisesRegex(GoldDataContractError, "missing"):
                ctl.external_input(EXTERNAL, ["nea_toi"])
        with self.assertRaisesRegex(GoldDataContractError, "run snapshot path"):
            ctl.external_input("/tmp/external", ["nea_toi"])

    def test_silver_attempt_is_reaudited_against_the_bronze_coverage(self):
        seen = {}
        with patch.object(ctl, "audit_attempt", lambda path, expected: seen.update(expected) or {}), \
                patch.object(ctl, "hdfs_json", lambda path: ({}, "s" * 64)):
            self.assertEqual(ctl.silver_input(SILVER, COVERAGE)["ready_sha256"], "s" * 64)
        self.assertEqual((seen["bronze_coverage_sha256"], seen["bronze_coverage_ready_sha256"]), ("a" * 64, "b" * 64))
        with self.assertRaisesRegex(GoldDataContractError, "immutable attempt"):
            ctl.silver_input("/lake/silver/.staging/run=1", COVERAGE)


class SubmitAndCommitTest(unittest.TestCase):
    def test_submit_passes_lineage_approvals_and_exclusions(self):
        with patch.object(ctl, "event_log_conf", lambda: []):
            command = ctl.submit_command(release_dir=Path("/opt/planetory-gold/releases/r"), runtime_hdfs="/rt.tgz",
                                         coverage=COVERAGE, args=args(tic_id=[7]), attempt_id="20260927T010001Z",
                                         output="/lake/gold/tess/.staging/run=20260927T010000Z/attempt=20260927T010001Z")
        text = " ".join(command)
        for expected in (f"--silver-attempt hdfs://planetory{SILVER}", f"--external hdfs://planetory{EXTERNAL}",
                         "--required-source nea_toi", "--exclude-tic 149603524", "--tic-id 7",
                         "--approval-external 124 !190", "--bronze-path hdfs://planetory/lake/bronze/tess/sector=0001",
                         "spark.driver.maxResultSize=3g", "tess_gold.py:/opt/planetory/tess_gold.py:ro"):
            self.assertIn(expected, text)

    def finalize(self, summary):
        written = {}

        def hdfs(*argv, input_text=None, check=True):
            if argv[:2] == ("dfs", "-cat"):
                return Namespace(stdout=json.dumps(summary) + "\n")
            if argv[:2] == ("dfs", "-put"):
                written["marker"] = json.loads(input_text)
            return Namespace(stdout="", returncode=0)

        files = {"manifest/part-00000": {"sha256": "p" * 64, "bytes": 10, "lines": 1}}
        with patch.object(ctl, "hdfs", hdfs), patch.object(ctl, "hdfs_exists", lambda path: False), \
                patch.object(ctl, "output_files", lambda root: files), \
                patch.object(ctl, "fsck_healthy"), patch.object(ctl, "atomic_commit"), \
                patch.object(ctl, "hdfs_json", lambda path: (written["marker"], "m" * 64)):
            return ctl.finalize(release_dir=Path("/r"), output="/lake/gold/tess/.staging/run=R/attempt=A",
                                final="/lake/gold/tess/publication-candidates/run_id=R/attempt=A", args=args(),
                                attempt_id="20260927T010001Z", coverage=COVERAGE,
                                silver={"ready_sha256": "s" * 64},
                                external={"ready_sha256": "r" * 64, "sources": {"nea_toi": {"sha256": "c" * 64}}},
                                application_id="application_1_1")

    def test_commit_records_lineage_and_stops_on_disagreeing_outputs(self):
        summary = dict(contract_ok=True, status="complete", complete=True, counts={"ready": 1},
                       target_tic_count=1, candidate_count=2, candidates_sha256="h" * 64)
        marker = self.finalize(summary)
        self.assertEqual(marker["schema"], ctl.GOLD_READY_SCHEMA)
        self.assertEqual((marker["silver_ready_sha256"], marker["external_ready_sha256"]), ("s" * 64, "r" * 64))
        self.assertEqual(marker["excluded_tics"], [149603524])
        self.assertEqual(marker["approvals"]["identity"], "112 !152")
        self.assertEqual(marker["files"]["manifest/part-00000"]["lines"], 1)
        with self.assertRaisesRegex(GoldDataContractError, "disagree"):
            self.finalize(dict(summary, contract_ok=False))

    def test_only_staging_attempts_are_ever_discarded(self):
        with self.assertRaisesRegex(RuntimeError, "unexpected path"):
            ctl.discard_failed_attempt("R", "A", "/lake/gold/tess/publication-candidates/run_id=R/attempt=A", None)


ATTEMPT = "/lake/gold/tess/publication-candidates/run_id=20260927T010000Z/attempt=20260927T010001Z"
GOLD_MARKER = dict(schema=ctl.GOLD_READY_SCHEMA, run_id="20260927T010000Z", canary_tics=[], status="complete",
                   complete=True, silver_attempt=SILVER, silver_ready_sha256="s" * 64, external=EXTERNAL,
                   external_ready_sha256="r" * 64, counts={"ready": 1}, excluded_tics=[149603524],
                   approvals={"identity": "i"}, files={"bundles/part-00000": {"sha256": "b" * 64, "bytes": 5,
                                                                              "lines": 1}})


class GateTest(unittest.TestCase):
    def setUp(self):
        self.files = {f"{ATTEMPT}/_READY.json": (GOLD_MARKER, "g" * 64), f"{SILVER}/_READY.json": ({}, "s" * 64),
                      f"{EXTERNAL}/_READY.json": ({}, "r" * 64)}
        self.exists, self.calls, self.states = set(), [], []

    def hdfs(self, *argv, input_text=None, check=True):
        self.calls.append((argv, input_text))
        return Namespace(stdout="", returncode=0)

    def run_gate(self, verdict):
        verdict = dict(schema=ctl.GATE_VERDICT_SCHEMA, run_id="20260927T010000Z", attempt=ATTEMPT,
                       gate_version="publish-gate-80-v1", checked_at_utc="2026-09-27T02:00:00Z", bundles=1,
                       candidates=2, candidates_sha256="h" * 64, **verdict)
        with patch.object(ctl, "hdfs_json", lambda path: self.files[path]), patch.object(ctl, "audit_gold"), \
                patch.object(ctl, "hdfs", self.hdfs), patch.object(ctl, "hdfs_exists", lambda p: p in self.exists), \
                patch.object(ctl, "build_runtime", lambda release: "/rt.tgz"), \
                patch.object(ctl, "write_state", lambda path, state: self.states.append(dict(state))), \
                patch.object(ctl, "event_log_conf", lambda: []), \
                patch.object(ctl, "submit") as submit, patch.object(ctl, "read_verdict", lambda *a: verdict):
            ctl.command_gate(Namespace(attempt=ATTEMPT, release_dir="/r", state_root=tempfile_dir()))
        return submit

    def written_marker(self):
        return next(json.loads(text) for argv, text in self.calls if argv[:3] == ("dfs", "-put", "-f"))

    def test_only_a_passing_verdict_writes_publish_ready(self):
        submit = self.run_gate(dict(ok=True, errors=[]))
        submit.assert_called_once()
        marker = self.written_marker()
        self.assertEqual((marker["schema"], marker["attempt"], marker["gold_ready_sha256"]),
                         (ctl.PUBLISH_READY_SCHEMA, ATTEMPT, "g" * 64))
        self.assertEqual(marker["files"], GOLD_MARKER["files"])
        self.assertEqual(marker["excluded_tics"], [149603524])
        self.assertIn(("dfs", "-mv"), [argv[:2] for argv, _ in self.calls])
        # Each check writes its own .part, so a concurrent gate cannot swap the content before mv.
        part = next(argv[4] for argv, _ in self.calls if argv[:3] == ("dfs", "-put", "-f"))
        self.assertRegex(part, r"/_READY\.json\.[0-9]{8}T[0-9]{6}Z\.part$")
        self.assertEqual(self.states[-1]["status"], "publish_ready")
        self.calls.clear()
        with self.assertRaisesRegex(GoldDataContractError, "rejected"):
            self.run_gate(dict(ok=False, errors=["tic 7: array checksum mismatch"]))
        self.assertFalse(any(argv[:2] == ("dfs", "-mv") for argv, _ in self.calls))
        self.assertEqual(self.states[-1]["status"], "rejected")  # not overwritten as terminal_failed

    def test_one_publish_ready_per_run(self):
        ready = f"{ctl.PUBLISH_READY_ROOT}/run_id=20260927T010000Z/_READY.json"
        self.exists.add(ready)
        self.files[ready] = ({"attempt": ATTEMPT, "gold_ready_sha256": "g" * 64}, "x" * 64)
        self.run_gate(dict(ok=True, errors=[])).assert_not_called()
        # The restart after an interrupted gate records the state the first run did not get to write.
        self.assertEqual((self.states[-1]["status"], self.states[-1]["result"]["attempt"]), ("publish_ready", ATTEMPT))
        self.files[ready] = ({"attempt": ATTEMPT.replace("010001Z", "020000Z"), "gold_ready_sha256": "o" * 64}, "x")
        with self.assertRaisesRegex(GoldDataContractError, "already publish-ready"):
            self.run_gate(dict(ok=True, errors=[]))

    def test_canary_incomplete_or_changed_inputs_never_reach_the_gate_job(self):
        for change, reason in ((dict(canary_tics=[7]), "canary"), (dict(complete=False), "incomplete"),
                               (dict(silver_ready_sha256="z" * 64), "silver_ready_sha256"),
                               (dict(run_id="20260101T000000Z"), "path")):
            self.files[f"{ATTEMPT}/_READY.json"] = (dict(GOLD_MARKER, **change), "g" * 64)
            with self.assertRaisesRegex(GoldDataContractError, reason):
                self.run_gate(dict(ok=True, errors=[]))
            self.assertEqual(self.states[-1]["status"], "terminal_failed")  # Airflow shows the reason
            self.assertIn(reason, self.states[-1]["failure_detail"])
        with self.assertRaisesRegex(GoldDataContractError, "committed Gold attempt"):
            ctl.gate_input("/lake/gold/tess/.staging/run=R/attempt=A")


class UnitTest(unittest.TestCase):
    def test_units_run_validated_tokens_and_status_reads_their_own_state(self):
        root = Path(tempfile_dir())
        release = "/opt/planetory-silver/releases/20260927T000000Z"
        run = Namespace(**vars(args(operation="run", release_dir=release, state_root=str(root))))
        text = ctl.unit_text(run, run.run_id)
        # A deterministic non-contract failure stops after a bounded number of starts.
        self.assertIn("StartLimitBurst=7", text)
        self.assertNotIn("StartLimitIntervalSec=0", text)
        self.assertIn(f"ExecStart=/usr/bin/python3.12 {release}/spark/tess_gold_ctl.py run --release-dir {release}", text)
        self.assertIn("--approval-identity 112 !152", text)  # args() uses a spaced value: validate() refuses it
        with self.assertRaises(SystemExit), redirect_stderr(StringIO()):
            ctl.validate(ctl.parser().parse_args(["start-unit", "run", "--release-dir", release, "--run-id",
                                                  run.run_id, "--silver-attempt", SILVER, "--external", EXTERNAL,
                                                  "--required-source", "nea_toi", "--approval-identity", "112 !152",
                                                  "--approval-discoverability", "d", "--approval-external", "x"]))
        gate = Namespace(operation="gate", release_dir=release, attempt=ATTEMPT)
        self.assertEqual(ctl.unit_run_id(gate), "20260927T010000Z")
        self.assertTrue(ctl.operation_argv(gate)[-4:] == ["--attempt", ATTEMPT, "--release-dir", release])
        folder = root / "run=20260927T010000Z"
        folder.mkdir()
        (folder / "attempt=20260927T010001Z.json").write_text(json.dumps(
            {"unit": ctl.unit_name("run", "20260927T010000Z"), "status": "complete", "final": ATTEMPT}))
        (folder / "gate=20260927T020000Z.json").write_text(json.dumps(
            {"unit": ctl.unit_name("gate", "20260927T010000Z"), "status": "rejected"}))
        out = StringIO()
        with patch.object(ctl, "systemd_properties", lambda name: {"LoadState": "loaded"}), \
                patch("sys.stdout", out):
            ctl.command_status(Namespace(operation="run", run_id="20260927T010000Z", state_root=str(root)))
        status = json.loads(out.getvalue().split("GOLD_STATUS_JSON=", 1)[1])
        self.assertEqual((status["unit"], status["state"]["final"]), (ctl.unit_name("run", "20260927T010000Z"), ATTEMPT))
        argv = ["run", "--silver-attempt", SILVER, "--external", EXTERNAL, "--required-source", "nea_toi",
                "--release-dir", "/r", "--run-id", "20260927T010000Z", "--approval-identity", "i",
                "--approval-discoverability", "d", "--approval-external", "x", "--state-root", str(root)]
        with redirect_stderr(StringIO()):
            self.assertEqual(ctl.main(argv), 65)  # a completed run ID never runs again


class RestartTest(unittest.TestCase):
    RUN_ROOT = f"{ctl.GOLD_ROOT}/run_id=20260927T010000Z"
    FINAL = f"{ctl.GOLD_ROOT}/run_id=20260927T010000Z/attempt=20260927T010001Z"

    def marker(self, **changes):
        return {**dict(silver_attempt=SILVER, external=EXTERNAL, required_sources=["nea_toi"],
                       excluded_tics=[149603524],
                       approvals={"identity": "112 !152", "discoverability": "123 !173", "external": "124 !190"}),
                **changes}

    def run_attempt(self, listing, marker, states):
        def recompute(*argv):
            raise AssertionError("a committed run must not be computed again")

        with patch.object(ctl, "hdfs_exists", lambda path: path == self.RUN_ROOT), \
                patch.object(ctl, "hdfs", lambda *argv, **kw: Namespace(stdout=listing, returncode=0)), \
                patch.object(ctl, "hdfs_json", lambda path: (marker, "m" * 64)), patch.object(ctl, "audit_gold"), \
                patch.object(ctl, "write_state", lambda path, state: states.append(dict(state))), \
                patch.object(ctl, "cluster_preflight", recompute):
            return ctl.run_attempt(args(release_dir="/r", state_root=tempfile_dir()))

    def test_a_restart_after_the_commit_adopts_the_committed_attempt(self):
        states = []
        final, marker = self.run_attempt(f"drwxr-x--- - u g 0 2026-09-27 01:00 {self.FINAL}\n", self.marker(), states)
        self.assertEqual((final, marker["silver_attempt"]), (self.FINAL, SILVER))
        self.assertEqual((states[-1]["status"], states[-1]["final"], states[-1]["adopted"]),
                         ("complete", self.FINAL, True))
        for listing, marker, reason in (
                (f"d {self.FINAL}\nd {self.FINAL[:-3]}02Z\n", self.marker(), "2 committed attempts"),
                (f"d {self.FINAL}\n", self.marker(excluded_tics=[]), "other inputs")):
            states.clear()
            with self.subTest(reason=reason), self.assertRaisesRegex(GoldDataContractError, reason):
                self.run_attempt(listing, marker, states)
            self.assertEqual(states[-1]["status"], "terminal_failed")

    def test_input_contract_failures_are_recorded_with_their_reason(self):
        states = []
        broken = SilverDataContractError("Silver checksum mismatch output=iteration")
        with patch.object(ctl, "hdfs_exists", lambda path: False), \
                patch.object(ctl, "write_state", lambda path, state: states.append(dict(state))), \
                patch.object(ctl, "cluster_preflight", lambda coverage: COVERAGE), \
                patch.object(ctl, "silver_input", side_effect=broken), \
                self.assertRaises(SilverDataContractError):
            ctl.run_attempt(args(release_dir="/r", state_root=tempfile_dir(), bronze_coverage="/lake/bronze/tess/c"))
        self.assertEqual([s["status"] for s in states], ["prepared", "terminal_failed"])
        self.assertIn("checksum mismatch", states[-1]["failure_detail"])

    def test_gold_and_gate_apps_hold_pipeline_slots(self):
        # An unrecognised name would count as a foreign app and block every other pipeline preflight.
        with patch.object(ctl, "event_log_conf", lambda: []):
            gold = ctl.submit_command(release_dir=Path("/r"), runtime_hdfs="/rt.tgz", coverage=COVERAGE,
                                      args=args(release_dir="/r"), attempt_id="20260927T010001Z", output="/o")
            gate = ctl.gate_command(release_dir=Path("/r"), runtime_hdfs="/rt.tgz", run_id="20260927T010000Z",
                                    check_id="20260927T020000Z", attempt=self.FINAL, output="/o")
        for command in (gold, gate):
            name = command[command.index("--name") + 1]
            self.assertTrue(tess_bronze_ctl.PIPELINE_APP_NAME_RE.match(name), name)


def tempfile_dir():
    import tempfile
    return tempfile.mkdtemp()


class ArgumentTest(unittest.TestCase):
    base = ["run", "--silver-attempt", SILVER, "--external", EXTERNAL, "--required-source", "nea_toi",
            "--release-dir", "/r", "--run-id", "20260927T010000Z", "--approval-identity", "i",
            "--approval-discoverability", "d", "--approval-external", "x"]

    def test_unsafe_requests_are_refused_before_any_cluster_call(self):
        ctl.validate(ctl.parser().parse_args(self.base))
        canary = ["canary", *self.base[1:]] + [a for tic in range(1, 7) for a in ("--tic-id", str(tic))]
        for argv in (self.base + ["--approval-external", " "], self.base + ["--required-source", "nea_toi"],
                     self.base + ["--run-id", "run-1"], canary, self.base + ["--shuffle-partitions", "5000"],
                     [value.replace(SILVER, "/lake/silver/other") for value in self.base],
                     [value.replace(EXTERNAL, "/lake/external/tess/latest") for value in self.base]):
            with self.assertRaises(SystemExit), redirect_stderr(StringIO()):
                ctl.validate(ctl.parser().parse_args(argv))


if __name__ == "__main__":
    unittest.main()

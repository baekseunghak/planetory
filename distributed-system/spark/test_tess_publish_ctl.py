"""276 게시 제어기: marker·이미지 검사, part 받기와 대조, 게시 결과별 상태, unit 정의를 HDFS·Docker·systemd 없이 본다."""
import hashlib
import io
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_publish_ctl as ctl  # noqa: E402
from tess_publish_ctl import PublishContractError  # noqa: E402

RUN = "20260927T010000Z"
ATTEMPT = f"/lake/gold/tess/publication-candidates/run_id={RUN}/attempt=20260927T020000Z"
RELEASE = "/opt/planetory-silver/releases/20260927T030000Z"
APPROVAL = f"airflow/tess-publication-run/{RUN}/approved"
PARTS = {"manifest/part-00000": b'{"run_id": "x"}\n', "bundles/part-00000": b'{"tic_id": 1}\n{"tic_id": 2}\n',
         "bundles/part-00001": b""}


def spec(data: bytes) -> dict:
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "lines": data.count(b"\n")}


MARKER = {"schema": ctl.PUBLISH_READY_SCHEMA, "run_id": RUN, "attempt": ATTEMPT,
          "files": {rel: spec(data) for rel, data in PARTS.items()}}


class FakeCat:
    """subprocess.Popen stand-in for `hdfs dfs -cat <attempt>/<part>`."""

    def __init__(self, argv, stdout):
        self.stdout = io.BytesIO(PARTS[argv[-1].removeprefix(ATTEMPT + "/")])
        self.returncode = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class MarkerAndImageTest(unittest.TestCase):
    def test_marker_must_be_this_runs_gate_output(self):
        with patch.object(ctl, "hdfs_exists", lambda path: True), \
                patch.object(ctl, "hdfs_json", lambda path: (MARKER, "r" * 64)):
            self.assertEqual(ctl.ready_marker(RUN)[1], "r" * 64)
        for change in ({"schema": "other"}, {"run_id": "20260101T000000Z"},
                       {"attempt": ATTEMPT.replace(f"run_id={RUN}", "run_id=20260101T000000Z")},
                       {"files": {"../x": spec(b"")}}, {"files": {}}):
            with patch.object(ctl, "hdfs_exists", lambda path: True), \
                    patch.object(ctl, "hdfs_json", lambda path, c=change: ({**MARKER, **c}, "r" * 64)):
                with self.assertRaises(PublishContractError, msg=change):
                    ctl.ready_marker(RUN)
        with patch.object(ctl, "hdfs_exists", lambda path: False):
            with self.assertRaisesRegex(PublishContractError, "no publish-ready"):
                ctl.ready_marker(RUN)

    def test_image_must_be_pinned(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp, "image")
            with patch.object(ctl, "IMAGE_FILE", image):
                for value, ok in (("ec2-b.ts.net:5000/planetory/publisher:" + "a" * 40 + "\n", True),
                                  ("registry/planetory/publisher@sha256:" + "b" * 64, True),
                                  ("registry/planetory/publisher:latest", False), ("alpine", False)):
                    image.write_text(value, encoding="utf-8")
                    if ok:
                        self.assertEqual(ctl.publisher_image(), value.strip())
                    else:
                        with self.assertRaises(PublishContractError, msg=value):
                            ctl.publisher_image()
                image.unlink()
                with self.assertRaises(PublishContractError):
                    ctl.publisher_image()


class FetchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name, f"run={RUN}", "ready")

    def test_parts_are_checked_and_laid_out_for_publish_run(self):
        with patch.object(ctl.subprocess, "Popen", FakeCat):
            ctl.fetch(MARKER, self.folder)
        self.assertEqual(json.loads((self.folder / "_READY.json").read_text(encoding="utf-8")), MARKER)
        for rel, data in PARTS.items():
            self.assertEqual((self.folder / rel).read_bytes(), data)
        self.assertEqual((self.folder / "bundles/part-00000").stat().st_mode & 0o444, 0o444)  # Publisher user reads

    def test_a_part_that_differs_from_the_marker_stops_the_run(self):
        broken = {**MARKER, "files": {**MARKER["files"], "bundles/part-00000": spec(b"other\n")}}
        with patch.object(ctl.subprocess, "Popen", FakeCat):
            with self.assertRaisesRegex(PublishContractError, "differs"):
                ctl.fetch(broken, self.folder)

    def test_not_enough_disk_stops_before_fetching(self):
        with patch.object(ctl.shutil, "disk_usage", lambda path: Namespace(free=ctl.DISK_MARGIN)), \
                patch.object(ctl.subprocess, "Popen", side_effect=AssertionError("must not fetch")):
            with self.assertRaisesRegex(PublishContractError, "bytes under"):
                ctl.fetch(MARKER, self.folder)


class PublishTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.args = Namespace(run_id=RUN, release_dir=RELEASE, approval=APPROVAL, state_root=self.root)

    def publish(self, code: int, record: dict | None):
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            return CompletedProcess(argv, code, stdout=json.dumps(record) if record else "")

        with patch.object(ctl, "ready_marker", lambda run_id: (MARKER, "r" * 64)), \
                patch.object(ctl, "publisher_image", lambda: "registry/planetory/publisher:" + "a" * 40), \
                patch.object(ctl, "fetch", lambda marker, folder: folder.mkdir(parents=True, exist_ok=True)), \
                patch.object(ctl.subprocess, "run", fake_run):
            ctl.command_publish(self.args)
        return calls

    def state(self):
        return ctl.latest_state(self.root, RUN, ctl.unit_name(RUN))

    def test_success_records_the_run_and_removes_the_local_copy(self):
        record = {"status": "published", "counts": {"PUBLISHED": 2}, "stars": []}
        argv = self.publish(0, record)[0]
        self.assertEqual((self.state()["status"], self.state()["record"], self.state()["publisher_exit"]),
                         ("complete", record, 0))
        self.assertFalse(Path(self.root, f"run={RUN}", "ready").exists())
        self.assertEqual(argv[argv.index("--env-file") + 1], ctl.ENV_FILE)
        self.assertIn(f"{Path(self.root, f'run={RUN}', 'ready')}:/ready:ro", argv)
        self.assertEqual(argv[-7:], ["publish-run", "--run-id", RUN, "--ready", "/ready", "--approval", APPROVAL])

    def test_data_rejection_is_terminal_and_transient_failure_retries(self):
        with self.assertRaises(PublishContractError):
            self.publish(65, {"status": "published", "counts": {"PUBLISH_REJECTED": 1}})
        self.assertEqual(self.state()["status"], "rejected")
        with self.assertRaisesRegex(RuntimeError, "retries"):
            self.publish(1, None)
        self.assertEqual(self.state()["status"], "failed")
        # An image without publish-run (argparse 2) or a docker error (125) would fail the same way forever.
        for code in (2, 125):
            with self.assertRaises(PublishContractError, msg=code):
                self.publish(code, None)
            self.assertEqual(self.state()["status"], "rejected")

    def test_a_missing_marker_reaches_airflow_with_its_reason(self):
        def missing(run_id):
            raise PublishContractError(f"no publish-ready marker for run {run_id}")

        with patch.object(ctl, "ready_marker", missing), \
                patch.object(ctl.subprocess, "run", side_effect=AssertionError("must not publish")):
            with self.assertRaises(PublishContractError):
                ctl.command_publish(self.args)
        self.assertEqual((self.state()["status"], self.state()["failure_detail"]),
                         ("rejected", f"no publish-ready marker for run {RUN}"))


class UnitTest(unittest.TestCase):
    def test_unit_runs_the_release_controller_and_stops_on_65(self):
        args = Namespace(run_id=RUN, release_dir=RELEASE, approval=APPROVAL)
        text = ctl.unit_text(args)
        self.assertIn(f"ExecStart=/usr/bin/python3.12 {RELEASE}/spark/tess_publish_ctl.py publish --release-dir "
                      f"{RELEASE} --run-id {RUN} --approval {APPROVAL}", text)
        self.assertIn("RestartPreventExitStatus=65", text)
        self.assertIn("StartLimitBurst=7", text)
        self.assertEqual(ctl.unit_name(RUN), f"planetory-tess-publish-{RUN}.service")

    def test_arguments_are_single_safe_tokens(self):
        base = ["start-unit", "publish", "--release-dir", RELEASE, "--run-id", RUN]
        for bad in (["--approval", "a b"], ["--approval", "a;rm"], ["--approval", "/leading-slash"]):
            with self.assertRaises(SystemExit):
                ctl.main(base + bad)
        with self.assertRaises(SystemExit):
            ctl.main(["status", "publish", "--run-id", "run-1"])


if __name__ == "__main__":
    unittest.main()

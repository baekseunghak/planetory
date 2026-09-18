from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from ingestion import supervisor


def config() -> dict:
    return {
        "disk_stop_fraction": 0.75,
        "disk_resume_fraction": 0.70,
        "retry_initial_seconds": 30,
        "retry_max_seconds": 900,
        "max_retries": 5,
        "max_part_bytes": 64 << 20,
        "max_consecutive_failures": 10,
        "download_concurrency": 2,
    }


def success_summary() -> dict:
    return {
        "failed": 0,
        "stopped_capacity": False,
        "stopped_circuit": False,
    }


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run_root = self.root / "run"
        self.output = self.run_root / "raw"
        self.output.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def test_capacity_pause_resumes_below_low_watermark(self):
        usage_values = iter(
            [SimpleNamespace(total=100, used=75, free=25), SimpleNamespace(total=100, used=69, free=31)]
        )
        sleeps = []
        with mock.patch.object(supervisor.tess, "run_download", return_value=(success_summary(), 0)):
            with mock.patch.object(supervisor, "_audit_sector", return_value=True):
                code = supervisor.run_supervisor(
                    config(),
                    {},
                    self.output,
                    self.run_root,
                    worker_slot=1,
                    sectors=[3],
                    sleep=sleeps.append,
                    usage=lambda _: next(usage_values),
                    legacy_checker=lambda *_: False,
                )
        self.assertEqual(code, 0)
        self.assertEqual(sleeps, [30, 30])

    def test_capacity_between_watermarks_does_not_pause_before_stop(self):
        sleeps = []
        with mock.patch.object(supervisor.tess, "run_download", return_value=(success_summary(), 0)) as run:
            with mock.patch.object(supervisor, "_audit_sector", return_value=True):
                code = supervisor.run_supervisor(
                    config(),
                    {},
                    self.output,
                    self.run_root,
                    worker_slot=1,
                    sectors=[3],
                    sleep=sleeps.append,
                    usage=lambda _: SimpleNamespace(total=100, used=72, free=28),
                    legacy_checker=lambda *_: False,
                )
        self.assertEqual(code, 0)
        self.assertEqual(sleeps, [])
        self.assertEqual(run.call_args.kwargs["concurrency"], 2)

    def test_legacy_process_is_adopted_before_new_download(self):
        checks = iter([True, False])
        sleeps = []
        with mock.patch.object(supervisor.tess, "run_download", return_value=(success_summary(), 0)):
            with mock.patch.object(supervisor, "_audit_sector", return_value=True):
                code = supervisor.run_supervisor(
                    config(),
                    {},
                    self.output,
                    self.run_root,
                    worker_slot=1,
                    sectors=[3],
                    sleep=sleeps.append,
                    usage=lambda _: SimpleNamespace(total=100, used=1, free=99),
                    legacy_checker=lambda *_: next(checks),
                )
        self.assertEqual(code, 0)
        self.assertEqual(sleeps, [30])

    def test_circuit_exit_is_persisted_for_backoff(self):
        failed = {"failed": 10, "stopped_capacity": False, "stopped_circuit": True}
        with mock.patch.object(supervisor.tess, "run_download", return_value=(failed, 3)):
            code = supervisor.run_supervisor(
                config(),
                {},
                self.output,
                self.run_root,
                worker_slot=1,
                sectors=[3],
                sleep=lambda _: None,
                usage=lambda _: SimpleNamespace(total=100, used=1, free=99),
                legacy_checker=lambda *_: False,
                max_cycles=1,
            )
        self.assertEqual(code, 4)
        state = json.loads((self.run_root / "manifests" / "supervisor-worker-1.json").read_text())
        self.assertEqual(state["status"], "BACKOFF")
        self.assertEqual(state["exit_code"], 3)
        self.assertEqual(state["retry_after_seconds"], 60)

    def test_supervisor_notifies_systemd_while_working(self):
        notifications = []
        with mock.patch.object(supervisor.tess, "run_download", return_value=(success_summary(), 0)):
            with mock.patch.object(supervisor, "_audit_sector", return_value=True):
                code = supervisor.run_supervisor(
                    config(),
                    {},
                    self.output,
                    self.run_root,
                    worker_slot=1,
                    sectors=[3],
                    usage=lambda _: SimpleNamespace(total=100, used=1, free=99),
                    legacy_checker=lambda *_: False,
                    notify=notifications.append,
                )
        self.assertEqual(code, 0)
        self.assertTrue(any("READY=1" in message for message in notifications))
        self.assertTrue(any("WATCHDOG=1" in message for message in notifications))
        self.assertTrue(any("STATUS=COMPLETE" in message for message in notifications))

    def test_sector_audit_repairs_only_torn_event_tail(self):
        paths = supervisor._paths(self.run_root, 3, 1)
        paths["events"].parent.mkdir(parents=True)
        complete = '{"schema":"planetory.download-event.v1","filename":"ok.fits"}\n'
        paths["events"].write_text(complete + '{"schema":', encoding="utf-8")
        summary = {"validated": 1, "total_bytes": 2880, "source_list_sha256": "a" * 64}

        def audit(*_args, **_kwargs):
            self.assertEqual(paths["events"].read_text(encoding="utf-8"), complete)
            return summary, 0

        with mock.patch.object(supervisor.tess, "audit_download", side_effect=audit):
            self.assertTrue(supervisor._audit_sector({}, self.output, paths, 1, 3))
        self.assertTrue(paths["complete"].is_file())

    def test_second_supervisor_cannot_take_lock(self):
        lock = self.run_root / "pids" / "supervisor.lock"
        with supervisor.process_lock(lock):
            with self.assertRaises(supervisor.AlreadyRunning):
                with supervisor.process_lock(lock):
                    pass


if __name__ == "__main__":
    unittest.main()

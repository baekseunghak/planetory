from __future__ import annotations

import hashlib
import io
import json
import socket
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from ingestion import tess


def fits_bytes(tic_id: int = 42, sector: int = 3, procver: str = "spoc-test") -> bytes:
    def card(key, value):
        if isinstance(value, bool):
            rendered = "T" if value else "F"
        elif isinstance(value, str):
            rendered = f"'{value}'"
        else:
            rendered = str(value)
        return f"{key:<8}= {rendered:>20}".ljust(80)

    header = "".join(
        [card("SIMPLE", True), card("TICID", tic_id), card("SECTOR", sector), card("PROCVER", procver), "END".ljust(80)]
    ).encode("ascii")
    return header.ljust(tess.FITS_BLOCK, b" ")


class DownloadHandler(BaseHTTPRequestHandler):
    payload = fits_bytes()
    requests: list[str | None] = []
    path_counts: dict[str, int] = {}

    def log_message(self, *_):
        return

    def do_GET(self):
        cls = type(self)
        cls.requests.append(self.headers.get("Range"))
        cls.path_counts[self.path] = cls.path_counts.get(self.path, 0) + 1
        count = cls.path_counts[self.path]
        payload = cls.payload

        if self.path == "/retry" and count == 1:
            self.send_response(429)
            self.send_header("Retry-After", "0")
            self.end_headers()
            return
        if self.path == "/server-error" and count == 1:
            self.send_response(503)
            self.end_headers()
            return
        if self.path == "/interrupt" and count == 1:
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload[: len(payload) // 2])
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return

        range_header = self.headers.get("Range")
        if range_header and self.path != "/ignore-range":
            start = int(range_header.removeprefix("bytes=").removesuffix("-"))
            self.send_response(206)
            self.send_header("Content-Length", str(len(payload) - start))
            self.send_header("Content-Range", f"bytes {start}-{len(payload) - 1}/{len(payload)}")
            self.end_headers()
            self.wfile.write(payload[start:])
            return

        self.send_response(200)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class Server:
    def __enter__(self):
        DownloadHandler.requests = []
        DownloadHandler.path_counts = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), DownloadHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def product(url: str) -> tess.Product:
    return tess.Product(
        sector=3,
        tic_id=42,
        filename="tess2018263035959-s0003-0000000000000042-0123-s_lc.fits",
        mast_uri="mast:TESS/product/tess2018263035959-s0003-0000000000000042-0123-s_lc.fits",
        source_uri=url,
        assigned_worker=1,
    )


class SourceListTests(unittest.TestCase):
    def test_config_rejects_unbounded_download_concurrency(self):
        config = json.loads((Path(__file__).parents[1] / "config" / "service-v1.json").read_text(encoding="utf-8"))
        config["download_concurrency"] = 5
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "download_concurrency"):
                tess.load_config(path)

    def test_parse_and_build_source_list_are_deterministic(self):
        filename = "tess2018263035959-s0003-0000000000000042-0123-s_lc.fits"
        url = f"https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/{filename}"
        script = f"#!/bin/sh\ncurl -C - -L -o {filename} {url}\n".encode()
        config = {
            "schema": tess.CONFIG_SCHEMA,
            "version": "test",
            "worker_count": 5,
            "disk_stop_fraction": 0.75,
            "max_part_bytes": 4096,
            "max_retries": 5,
            "sectors": [{"sector": 3, "bulk_script_url": "https://example.test/s3.sh", "expected_count": 1}],
        }
        value = tess.build_source_list(config, lambda _: script, "2026-09-18T00:00:00+00:00")
        again = tess.build_source_list(config, lambda _: script, "2026-09-18T00:00:00+00:00")
        self.assertEqual(value, again)
        self.assertEqual(value["product_count"], 1)
        self.assertEqual(value["products"][0]["tic_id"], 42)
        self.assertIn(value["products"][0]["assigned_worker"], range(1, 6))

    def test_source_list_detects_mutation(self):
        item = product("https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/" + product("x").filename)
        source = {
            "schema": tess.SOURCE_LIST_SCHEMA,
            "worker_count": 5,
            "product_count": 1,
            "source_list_sha256": tess._source_list_hash([item]),
            "products": [{**item.__dict__, "assigned_worker": 2}],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.json"
            path.write_text(json.dumps(source), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                tess.load_source_list(path)

    def test_product_rejects_noncanonical_download_source(self):
        item = product("https://example.test/api/v0.1/Download/file/?uri=mast:TESS/product/" + product("x").filename)
        with self.assertRaisesRegex(ValueError, "unexpected MAST download endpoint"):
            tess.Product.from_dict(item.__dict__)

    def test_snapshot_id_is_content_based(self):
        digest = "a" * 64
        value = tess.input_snapshot_id(3, digest, "spoc-5")
        self.assertEqual(value, f"lc:spoc:s0003:sha256:{digest}:procver:spoc-5")
        self.assertNotEqual(value, tess.input_snapshot_id(3, "b" * 64, "spoc-5"))
        self.assertNotEqual(value, tess.input_snapshot_id(3, digest, "spoc-6"))


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_download_is_atomic_and_second_run_is_cached(self):
        with Server() as base:
            item = product(base + "/normal")
            destination = self.root / item.filename
            first = tess.download_product(item, destination, sleep=lambda _: None)
            second = tess.download_product(item, destination, sleep=lambda _: None)
        self.assertTrue(destination.is_file())
        self.assertFalse(destination.with_name(destination.name + ".part").exists())
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(first["input_snapshot_id"], second["input_snapshot_id"])
        self.assertEqual(len(DownloadHandler.requests), 1)

    def test_interrupted_response_resumes_with_range(self):
        with Server() as base:
            item = product(base + "/interrupt")
            destination = self.root / item.filename
            record = tess.download_product(item, destination, retries=2, sleep=lambda _: None)
        self.assertEqual(record["resumed_from"], 0)
        self.assertIn(f"bytes={len(DownloadHandler.payload) // 2}-", DownloadHandler.requests)
        self.assertEqual(destination.read_bytes(), DownloadHandler.payload)

    def test_server_ignoring_range_restarts_only_current_file(self):
        with Server() as base:
            item = product(base + "/ignore-range")
            destination = self.root / item.filename
            partial = destination.with_name(destination.name + ".part")
            partial.write_bytes(DownloadHandler.payload[:100])
            record = tess.download_product(item, destination, retries=1, sleep=lambda _: None)
        self.assertEqual(record["resumed_from"], 100)
        self.assertEqual(destination.read_bytes(), DownloadHandler.payload)
        self.assertEqual(DownloadHandler.requests, ["bytes=100-"])

    def test_429_honors_retry_after(self):
        delays = []
        with Server() as base:
            item = product(base + "/retry")
            destination = self.root / item.filename
            tess.download_product(item, destination, retries=2, sleep=delays.append)
        self.assertEqual(delays, [0.0])
        self.assertEqual(DownloadHandler.path_counts["/retry"], 2)

    def test_503_retries_and_records_http_metric(self):
        with Server() as base:
            item = product(base + "/server-error")
            record = tess.download_product(item, self.root / item.filename, retries=2, sleep=lambda _: None)
        self.assertEqual(record["http_retries"], {"503": 1})
        self.assertEqual(record["attempts"], 2)

    def test_http_error_response_is_closed(self):
        item = product("https://example.test/unavailable")
        response = urllib.error.HTTPError(item.source_uri, 503, "unavailable", {}, io.BytesIO())

        def fail(*_args, **_kwargs):
            raise response

        with self.assertRaisesRegex(RuntimeError, "failed to download"):
            tess.download_product(item, self.root / item.filename, retries=1, opener=fail)
        self.assertTrue(response.closed)

    def test_invalid_retry_after_uses_exponential_fallback(self):
        response = urllib.error.HTTPError(
            "https://example.test/unavailable", 503, "unavailable", {"Retry-After": "invalid"}, io.BytesIO()
        )
        try:
            self.assertEqual(tess._retry_delay(response, 2, lambda: None), 2.0)
        finally:
            response.close()

    def test_long_retry_wait_keeps_watchdog_progressing(self):
        sleeps = []
        heartbeats = []
        tess._sleep_with_progress(65, sleeps.append, lambda: heartbeats.append(True))
        self.assertEqual(sleeps, [30.0, 30.0, 5.0])
        self.assertEqual(len(heartbeats), 3)

    def test_corrupt_final_and_oversized_part_are_replaced(self):
        with Server() as base:
            item = product(base + "/normal")
            destination = self.root / item.filename
            destination.write_bytes(b"broken-final")
            partial = destination.with_name(destination.name + ".part")
            partial.write_bytes(b"x" * 4097)
            record = tess.download_product(
                item, destination, retries=1, max_part_bytes=4096, sleep=lambda _: None, log=lambda _: None
            )
        self.assertFalse(record["cached"])
        self.assertEqual(record["resumed_from"], 0)
        self.assertEqual(destination.read_bytes(), DownloadHandler.payload)
        self.assertFalse(partial.exists())

    def test_checksum_mismatch_never_reaches_final_path(self):
        with Server() as base:
            item = product(base + "/normal")
            destination = self.root / item.filename
            with self.assertRaisesRegex(RuntimeError, "sha256 mismatch"):
                tess.download_product(item, destination, expected_sha256="0" * 64, retries=2, sleep=lambda _: None)
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_name(destination.name + ".part").exists())

    def test_capacity_stop_keeps_partial_for_resume(self):
        with Server() as base:
            item = product(base + "/normal")
            destination = self.root / item.filename
            usage = SimpleNamespace(total=100, used=75, free=25)
            with mock.patch.object(tess.shutil, "disk_usage", return_value=usage):
                with self.assertRaises(tess.CapacityStop):
                    tess.download_product(item, destination, retries=1, sleep=lambda _: None)
        self.assertFalse(destination.exists())

    def test_run_manifest_records_failure_and_continues(self):
        first_name = "tess2018263035959-s0003-0000000000000042-0123-s_lc.fits"
        second_name = "tess2018263035959-s0003-0000000000000043-0123-s_lc.fits"
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        first = product(base + first_name)
        second = tess.Product(
            sector=3,
            tic_id=43,
            filename=second_name,
            mast_uri="mast:TESS/product/" + second_name,
            source_uri=base + second_name,
            assigned_worker=1,
        )
        source = {
            "source_list_sha256": "a" * 64,
            "worker_count": 5,
            "products": [first.__dict__, second.__dict__],
        }

        def fake(item, destination, **_):
            if item.tic_id == 42:
                raise RuntimeError("injected")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(DownloadHandler.payload)
            return {
                "schema": tess.EVENT_SCHEMA,
                "status": "VALIDATED",
                **item.__dict__,
                "cached": False,
                "bytes_transferred": len(DownloadHandler.payload),
            }

        events = self.root / "events.jsonl"
        summary, code = tess.run_download(
            source, self.root / "raw", events, worker_slot=None, downloader=fake
        )
        rows = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(code, 1)
        self.assertEqual([row["status"] for row in rows], ["FAILED", "VALIDATED"])
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["validated"], 1)

    def test_bounded_parallel_downloads_overlap_and_keep_event_order(self):
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        products = []
        for tic in (42, 43):
            filename = f"tess2018263035959-s0003-{tic:016d}-0123-s_lc.fits"
            products.append(tess.Product(3, tic, filename, "mast:TESS/product/" + filename, base + filename, 1))
        source = {
            "source_list_sha256": "a" * 64,
            "worker_count": 5,
            "products": [item.__dict__ for item in products],
        }
        barrier = threading.Barrier(2)

        def fake(item, destination, **_):
            barrier.wait(timeout=2)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(DownloadHandler.payload)
            return {
                "schema": tess.EVENT_SCHEMA,
                "status": "VALIDATED",
                **item.__dict__,
                "cached": False,
                "bytes_transferred": len(DownloadHandler.payload),
            }

        events = self.root / "parallel.jsonl"
        summary, code = tess.run_download(
            source,
            self.root / "raw",
            events,
            worker_slot=1,
            concurrency=2,
            downloader=fake,
        )
        rows = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual([row["sequence"] for row in rows], [1, 2])
        self.assertEqual([row["filename"] for row in rows], [item.filename for item in products])
        self.assertEqual(summary["processed"], 2)
        self.assertEqual(summary["concurrency"], 2)

    def test_parallel_circuit_stops_after_current_bounded_batch(self):
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        products = []
        for tic in (42, 43, 44):
            filename = f"tess2018263035959-s0003-{tic:016d}-0123-s_lc.fits"
            products.append(tess.Product(3, tic, filename, "mast:TESS/product/" + filename, base + filename, 1))
        source = {
            "source_list_sha256": "a" * 64,
            "worker_count": 5,
            "products": [item.__dict__ for item in products],
        }

        events = self.root / "parallel-circuit.jsonl"
        summary, code = tess.run_download(
            source,
            self.root / "raw",
            events,
            worker_slot=1,
            concurrency=2,
            max_consecutive_failures=1,
            downloader=lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("network unavailable")),
        )
        self.assertEqual(code, 3)
        self.assertTrue(summary["stopped_circuit"])
        self.assertEqual(summary["processed"], 2)
        self.assertEqual(len(events.read_text(encoding="utf-8").splitlines()), 2)

    def test_consecutive_failures_open_circuit(self):
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        products = []
        for tic in (42, 43, 44):
            filename = f"tess2018263035959-s0003-{tic:016d}-0123-s_lc.fits"
            products.append(
                tess.Product(3, tic, filename, "mast:TESS/product/" + filename, base + filename, 1)
            )
        source = {
            "source_list_sha256": "a" * 64,
            "worker_count": 5,
            "products": [item.__dict__ for item in products],
        }

        def fail(*_args, **_kwargs):
            raise OSError("network unavailable")

        events = self.root / "circuit.jsonl"
        summary, code = tess.run_download(
            source,
            self.root / "raw",
            events,
            worker_slot=1,
            max_consecutive_failures=2,
            downloader=fail,
        )
        self.assertEqual(code, 3)
        self.assertTrue(summary["stopped_circuit"])
        self.assertEqual(summary["failed"], 2)
        self.assertEqual(len(events.read_text(encoding="utf-8").splitlines()), 2)

    def test_torn_final_event_is_repaired_before_append(self):
        events = self.root / "torn.jsonl"
        valid = {"schema": tess.EVENT_SCHEMA, "filename": "ok.fits", "status": "VALIDATED"}
        events.write_text(json.dumps(valid) + "\n" + '{"schema":', encoding="utf-8")
        self.assertTrue(tess.repair_event_log(events))
        tess.append_event(events, {**valid, "filename": "next.fits"})
        rows = [json.loads(line) for line in events.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["filename"] for row in rows], ["ok.fits", "next.fits"])

    def test_event_append_completes_after_short_write(self):
        events = self.root / "events.jsonl"
        event = {"schema": tess.EVENT_SCHEMA, "filename": "complete.fits"}
        real_write = tess.os.write

        def short_write(descriptor, value):
            return real_write(descriptor, value[: max(1, len(value) // 2)])

        with mock.patch.object(tess.os, "write", side_effect=short_write):
            tess.append_event(events, event)

        self.assertEqual(json.loads(events.read_text(encoding="utf-8")), event)

    def test_sector_selection_and_audit_share_the_same_boundary(self):
        filename = "tess2018263035959-s0003-0000000000000042-0123-s_lc.fits"
        base = "https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/"
        item = product(base + filename)
        source = {
            "source_list_sha256": "a" * 64,
            "worker_count": 5,
            "products": [item.__dict__],
        }
        output = self.root / "raw"
        path = output / "sector=0003" / filename
        path.parent.mkdir(parents=True)
        path.write_bytes(DownloadHandler.payload)
        digest = hashlib.sha256(DownloadHandler.payload).hexdigest()
        events = self.root / "events.jsonl"
        tess.append_event(
            events,
            {
                "schema": tess.EVENT_SCHEMA,
                "status": "VALIDATED",
                **item.__dict__,
                "sha256": digest,
                "input_snapshot_id": tess.input_snapshot_id(3, digest, "spoc-test"),
            },
        )
        selected = tess.select_products(source, worker_slot=1, sectors={3}, limit=1)
        summary, code = tess.audit_download(source, output, events, worker_slot=1, sectors={3}, limit=1)
        self.assertEqual([value.filename for value in selected], [filename])
        self.assertEqual(code, 0)
        self.assertEqual(summary["expected"], summary["validated"])
        self.assertEqual(summary["total_bytes"], len(DownloadHandler.payload))


if __name__ == "__main__":
    unittest.main()

"""notify 명령 자기 검사. 로컬 HTTP 대역에 보낸다: python -m unittest test_notify (publisher 디렉터리에서)."""

import http.server
import os
import threading
import unittest
from unittest import mock

from publisher.__main__ import TOKEN_HEADER, main


class _Backend(http.server.BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        _Backend.seen.append((self.path, self.headers.get(TOKEN_HEADER)))
        body = b'{"applied": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class NotifyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), _Backend)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Backend.seen.clear()

    def test_resends_with_service_token_header(self):
        with mock.patch.dict(os.environ, {"BACKEND_URL": self.url, "INTERNAL_SERVICE_TOKEN": "t"}):
            self.assertEqual(main(["notify", "--bundle", "b-7"]), 0)
        # Backend의 InternalTokenFilter가 읽는 헤더 이름과 판 id 표기(b-)가 맞아야 한다.
        self.assertEqual(_Backend.seen, [("/internal/bundles/b-7/activated", "t")])

    def test_accepts_bare_id(self):
        with mock.patch.dict(os.environ, {"BACKEND_URL": self.url, "INTERNAL_SERVICE_TOKEN": "t"}):
            self.assertEqual(main(["notify", "--bundle", "7"]), 0)
        self.assertEqual(_Backend.seen[0][0], "/internal/bundles/b-7/activated")

    def test_without_token_sends_nothing_and_fails(self):
        env = {k: v for k, v in os.environ.items() if k != "INTERNAL_SERVICE_TOKEN"}
        with mock.patch.dict(os.environ, {**env, "BACKEND_URL": self.url}, clear=True):
            self.assertEqual(main(["notify", "--bundle", "b-7"]), 1)
        self.assertEqual(_Backend.seen, [])


if __name__ == "__main__":
    unittest.main()

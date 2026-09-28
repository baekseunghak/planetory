"""notify 명령 자기 검사. 로컬 HTTP 대역에 보낸다: python -m unittest test_notify (publisher 디렉터리에서)."""

import http.server
import os
import threading
import unittest
from unittest import mock

from publisher.__main__ import TOKEN_HEADER, main
from publisher.notify import notify_backend


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

    def test_a_dropped_response_is_recorded_and_the_next_bundle_is_still_sent(self):
        # 응답 없이 연결을 끊으면 http.client가 URLError가 아닌 RemoteDisconnected를 던진다. 4,916개 판 알림 도중
        # 한 판의 응답 실패(시간 초과 포함)가 publish-run 전체를 멈추면 안 된다[S15P21C206-276].
        class Hangup(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.close_connection = True

            def log_message(self, *args):
                pass

        hangup = http.server.HTTPServer(("127.0.0.1", 0), Hangup)
        threading.Thread(target=hangup.serve_forever, daemon=True).start()
        self.addCleanup(hangup.shutdown)
        dropped = notify_backend(f"http://127.0.0.1:{hangup.server_port}", "t", [7])
        self.assertEqual([(b, sent) for b, sent, _ in dropped], [(7, False)])
        self.assertIn("RemoteDisconnected", dropped[0][2])
        self.assertEqual([(b, sent) for b, sent, _ in notify_backend(self.url, "t", [8])], [(8, True)])
        # 잘못된 BACKEND_URL도 그 판의 실패로만 남는다(run 기록을 잃지 않는다).
        self.assertEqual([sent for _, sent, _ in notify_backend("http://[bad", "t", [9])], [False])

    def test_without_token_sends_nothing_and_fails(self):
        env = {k: v for k, v in os.environ.items() if k != "INTERNAL_SERVICE_TOKEN"}
        with mock.patch.dict(os.environ, {**env, "BACKEND_URL": self.url}, clear=True):
            self.assertEqual(main(["notify", "--bundle", "b-7"]), 1)
        self.assertEqual(_Backend.seen, [])


if __name__ == "__main__":
    unittest.main()

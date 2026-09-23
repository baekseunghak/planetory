import http.server
import socket
import threading

import pytest

from local_seed.payload import build_all


@pytest.fixture(scope="session")
def payloads():
    """전체 생성은 BLS 때문에 수 초가 걸려 세션에서 한 번만 만든다."""
    return build_all()


class FakeBackend:
    """판 전환 후처리 요청을 기록하고 판마다 정한 상태 코드로 답하는 로컬 HTTP 서버."""

    def __init__(self):
        self.default_status = 200
        self.statuses: dict[int, int] = {}
        self.requests: list[tuple[int, str | None]] = []
        backend = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                bundle_id = int(self.path.removeprefix("/internal/bundles/b-").removesuffix("/activated"))
                backend.requests.append((bundle_id, self.headers.get("X-Planetory-Service-Token")))
                self.send_response(backend.statuses.get(bundle_id, backend.default_status))
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def backend():
    server = FakeBackend()
    yield server
    server.close()


@pytest.fixture
def down_url():
    """아무도 듣지 않는 로컬 주소. 백엔드를 띄우지 않은 상태를 흉내 낸다."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"

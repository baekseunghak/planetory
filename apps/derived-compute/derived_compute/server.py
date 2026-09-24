"""Worker HTTP 어댑터: `POST /internal/v1/derived-compute` [S15P21C206-88].

계약 envelope(ok=true/false)는 HTTP 200으로 보낸다. envelope가 없는 응답은 다음뿐이다.
- 400·411·413: 본문을 JSON 객체로 읽을 수 없다. 상관 필드가 없으므로 Backend 조립 결함이다.
- 503: 인스턴스 동시 실행 상한(instance_concurrency)이 찼다. Backend는 worker_unavailable로 본다.

실행: python -m derived_compute.server (설정은 README의 환경 변수 표)
"""
import importlib.metadata
import json
import os
import platform
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from derived_compute.compute import handle

PATH = "/internal/v1/derived-compute"


def runtime_info():
    version = importlib.metadata.version
    return {"worker_image": os.environ.get("WORKER_IMAGE") or "local", "python": platform.python_version(),
            "numpy": version("numpy"), "astropy": version("astropy"), "astro_kernel": version("astro-kernel")}


def _reject_constant(name):
    raise ValueError(f"{name} is not a finite JSON number")


def make_server(host, port, *, concurrency=1, max_body_bytes=64 * 1024 * 1024):
    slots = threading.BoundedSemaphore(concurrency)
    runtime = runtime_info()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/healthz":
                self._send(200, {"status": "ok", "runtime": runtime})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != PATH:
                return self._send(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                return self._send(411, {"error": "content_length_required"})
            if not 0 < length <= max_body_bytes:
                return self._send(413, {"error": "body_too_large"})
            body = self.rfile.read(length)
            try:
                # 계약은 유한한 float만 허용한다. NaN·Infinity 리터럴을 받지 않는다.
                request = json.loads(body, parse_constant=_reject_constant)
            except (UnicodeDecodeError, ValueError):
                return self._send(400, {"error": "invalid_json"})
            if not isinstance(request, dict):
                return self._send(400, {"error": "invalid_json"})
            if not slots.acquire(blocking=False):
                return self._send(503, {"error": "busy"})
            try:
                response = handle(request, runtime)
            finally:
                slots.release()
            self._send(200, response)

        def _send(self, status, payload):
            body = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer((host, port), Handler)


def limit_memory(mib):
    """계산 중 메모리 상한을 넘으면 MemoryError → memory_exhausted로 돌려주게 한다.

    컨테이너 memory 제한보다 조금 낮게 둬야 OOM kill(응답 없음)보다 먼저 걸린다. Linux 전용이다.
    ponytail: 가상 주소 공간(RLIMIT_AS) 상한이라 실제 RSS보다 이르게 걸릴 수 있다. 104 실측으로 값을 조정한다.
    """
    if not mib:
        return
    import resource

    limit = int(mib) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def main():
    limit_memory(os.environ.get("DERIVED_COMPUTE_MEMORY_LIMIT_MIB"))
    server = make_server(os.environ.get("DERIVED_COMPUTE_HOST", "0.0.0.0"),
                         int(os.environ.get("DERIVED_COMPUTE_PORT", "8090")),
                         concurrency=int(os.environ.get("DERIVED_COMPUTE_INSTANCE_CONCURRENCY", "1")))
    server.serve_forever()


if __name__ == "__main__":
    main()

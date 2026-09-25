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
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from derived_compute.compute import handle

PATH = "/internal/v1/derived-compute"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9-]")


def runtime_info():
    version = importlib.metadata.version
    return {"worker_image": os.environ.get("WORKER_IMAGE") or "local", "python": platform.python_version(),
            "numpy": version("numpy"), "astropy": version("astropy"), "astro_kernel": version("astro-kernel")}


def _reject_constant(name):
    raise ValueError(f"{name} is not a finite JSON number")


def capture(directory, request, response):
    """요청·응답 한 쌍을 131 비교 도구 형식 {request, response}로 남긴다. 실패해도 응답은 막지 않는다.

    파일 이름은 요청 값에서 오므로 안전한 문자만 남긴다. 기존 파일을 덮어쓰지 않는다.
    """
    name = "-".join(_SAFE_NAME.sub("_", str(request.get(key, "none")))[:40]
                    for key in ("job_id", "attempt", "operation"))
    path = Path(directory) / f"{name}-{time.time_ns()}.json"
    try:
        with open(path, "x", encoding="utf-8") as out:
            json.dump({"request": request, "response": response}, out, allow_nan=False, ensure_ascii=False)
    except OSError as error:
        print(f"capture failed: {path}: {error}", file=sys.stderr)


def make_server(host, port, *, concurrency=1, max_body_bytes=64 * 1024 * 1024, capture_dir=None):
    """capture_dir를 주면 envelope 응답마다 요청·응답을 파일로 남긴다(131 인계용, 평시에는 끈다)."""
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
            if capture_dir:
                capture(capture_dir, request, response)
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
                         concurrency=int(os.environ.get("DERIVED_COMPUTE_INSTANCE_CONCURRENCY", "1")),
                         capture_dir=os.environ.get("DERIVED_COMPUTE_CAPTURE_DIR") or None)
    server.serve_forever()


if __name__ == "__main__":
    main()

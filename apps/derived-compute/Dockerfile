# syntax=docker/dockerfile:1
# 빌드 문맥은 저장소 루트다. 공용 커널(libs/astro-kernel)을 함께 담는다.

FROM python:3.12-slim AS runtime
WORKDIR /app

# uv.lock에서 내보낸 해시 고정 목록이다(README 「의존성 갱신」). 커널만 빠져 있다.
COPY apps/derived-compute/requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

# 의존성은 위에서 고정했으므로 커널은 --no-deps로 설치한다. runtime.astro_kernel이 이 버전을 읽는다.
COPY libs/astro-kernel/ /tmp/astro-kernel/
RUN pip install --no-cache-dir --no-deps /tmp/astro-kernel && rm -rf /tmp/astro-kernel

COPY apps/derived-compute/derived_compute/ ./derived_compute/
RUN useradd --system --uid 10001 planetory

# cpu_per_job=1이다. BLAS가 코어 수만큼 스레드를 띄우면 상한을 넘고 가상 메모리도 부풀린다.
ENV OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONUNBUFFERED=1
USER 10001
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4)"]
CMD ["python", "-m", "derived_compute.server"]

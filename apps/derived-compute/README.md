# Derived Compute

잔차 곡선과 잔차 주기도를 요청 시 계산하는 Python Worker다(`S15P21C206-88`).

Backend가 PostgreSQL에서 읽은 곡선 배열·고정 transit model·계산 버전을 전달하며 Worker는 DB와 Redis를 직접 읽지 않는다. 잔차 제거는 `libs/astro-kernel`의 `remove_transit_models`, 주기도는 `astro_kernel.bls.bls_periodogram`을 사용한다.

호출·상태·캐시는 [온라인 파생 계산](../../docs/architecture/online-derived-compute.md), 실제 HTTP/JSON 필드와 오류는 [파생 계산 내부 계약](../../contracts/derived-compute/README.md)을 따른다.

상태: Worker 서버·이미지·compose·CI와 Backend 실행기(`WorkerResidualComputeRunner`) 구현, 로컬·컨테이너 검증 완료. EC2 배포와 실제 Gold 수치 비교(131)는 아직이다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `derived_compute/compute.py` | 요청 dict → 응답 envelope. 검증, `null ↔ NaN`, bin 중심 이동, 커널 호출, 오류 매핑. HTTP를 모른다 |
| `derived_compute/server.py` | 표준 라이브러리 HTTP 서버. `POST /internal/v1/derived-compute`, `GET /healthz` |
| `tests/test_worker.py` | 계약 fixture 재생, 합성 곡선 계산, HTTP 경계 |
| `Dockerfile` | 저장소 루트 문맥으로 빌드. 해시 고정 의존성 + 커널 |

- **bin 중심 이동은 여기서 한 번만 한다.** Gold `start_btjd`는 첫 bin 시작이라 `start_btjd + bin_minutes/2880`에서 평가한다(113 결정). Backend는 옮기지 않는다.
- 주기도 시각 축은 원본 주기도와 같다. 세그먼트를 이어 붙이고 시각순으로 안정 정렬한다(`discoverability.provided_arrays`와 같은 규칙).
- `periodogram_config_version` 설정표는 `compute.PERIODOGRAM_CONFIGS`다(계약 3.4절). 공용 커널로 옮길지는 131 리뷰에서 정한다.

## HTTP 응답

| 상태 | 본문 | Backend가 볼 것 |
| --- | --- | --- |
| 200 | 계약 envelope(`ok=true` 또는 `ok=false`) | envelope를 그대로 해석 |
| 400·411·413 | `{"error": ...}` | 요청 조립 결함. 재시도하지 않는다 |
| 503 | `{"error": "busy"}` | 인스턴스 동시 실행 상한이 찼다. `worker_unavailable`로 본다 |

연결 실패·응답 없음(컨테이너 OOM kill 포함)도 `worker_unavailable`이다. 120초 timeout은 Backend가 잰다.

## 환경 변수

| 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `DERIVED_COMPUTE_HOST` | `0.0.0.0` | 바인딩 주소 |
| `DERIVED_COMPUTE_PORT` | `8090` | 포트 |
| `DERIVED_COMPUTE_INSTANCE_CONCURRENCY` | `1` | 동시 계산 수(계약 `instance_concurrency`). 넘치면 503 |
| `DERIVED_COMPUTE_MEMORY_LIMIT_MIB` | 없음 | 프로세스 메모리 상한(Linux `RLIMIT_AS`). 넘으면 `memory_exhausted` |
| `WORKER_IMAGE` | `local` | 응답 `runtime.worker_image`에 싣는 이미지 참조 |

서비스 배포 값은 [infra/service](../../infra/service/README.md) 「온라인 계산 Worker」에 있다.

## 로컬 실행과 검증

```powershell
cd apps/derived-compute
uv run --locked python -m pytest -q
uv run --locked python -m derived_compute.server
```

이미지는 저장소 루트에서 빌드한다.

```powershell
docker build --platform linux/amd64 -f apps/derived-compute/Dockerfile -t local/planetory-derived-compute:dev .
```

## 의존성 갱신

`pyproject.toml`을 고친 뒤 잠금과 이미지용 목록을 함께 갱신한다. `requirements.txt`는 커널을 빼고 해시까지 고정한다.

```powershell
cd apps/derived-compute
uv lock
uv export --frozen --no-dev --no-emit-package astro-kernel --no-emit-project -o requirements.txt
```

## 2026-09-25 검증 결과

| 항목 | 결과 |
| --- | --- |
| `pytest` (Windows 로컬 Python 3.12, CI와 같은 `python:3.12-slim` 컨테이너) | 16 passed. 계약 잔차 fixture와 `rtol=1e-12` 일치, 계약 오류 요청 7건 코드 일치 |
| 합성 20,000점·격자 5,000점, 컨테이너(`--cpus 1 --memory 2048m`) | 잔차 0.08초, 주기도 0.92초, 메모리 약 50MiB. 로컬 Windows 결과와 잔차·power 차이 0 |
| 프로세스 상한 400MiB, 격자 2,000만 점 | `memory_exhausted`(stage `PERIODOGRAM`) 응답 뒤에도 `/healthz` 정상 |
| compose(`derived-compute`) | 격리 프로젝트로 기동, 서비스 이름으로 접근, CPU 1·메모리 2GiB·호스트 포트 없음 확인 |

합성 곡선 한 개의 개발 측정이며 성능 목표·용량 근거가 아니다(104). 실제 Gold 배열과의 수치 비교는 131이다.

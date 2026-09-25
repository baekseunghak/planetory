# 온라인 파생 계산 내부 계약

> Jira: `S15P21C206-70`, 보완 `S15P21C206-88`<br>
> 상태: Backend–Python Worker HTTP/JSON 계약과 합성 fixture 검증 완료, Data 승인·Backend 보완 반영 후 재검토 대기. 88 보완(`period_grid` 조립 출처, 주기도 설정 버전, `runtime`, 전부 `null`인 세그먼트, 주기도·자원 오류)은 **제안**이며 Data(131)·Backend 리뷰 대기<br>
> 범위: Backend가 current Gold로 조립한 잔차·주기도 계산 요청과 Python Worker 응답

이 계약은 독립 배포되는 Backend와 Python Worker가 같은 요청·응답을 해석하기 위한 경계다. 실제 Worker 서버, Redis 큐·잠금·TTL, 재시도·lease 구현과 과학 알고리즘은 포함하지 않는다.

## 1. 호출 위치와 소유권

- Backend가 내부 동기 HTTP `POST /internal/v1/derived-compute`를 호출한다.
- 한 프로토콜에서 `operation=residual|periodogram`으로 단계를 구분한다. Backend는 잔차 성공 뒤에만 주기도를 요청한다.
- Backend가 PostgreSQL current 확인, Gold 조회, 요청 조립, Redis 상태·결과·잠금, 중복 방지, timeout과 결과 채택을 소유한다.
- Worker는 요청에 포함된 배열·모델·버전만 계산하고 PostgreSQL·Redis·사용자 인증·캐시 키를 알지 않는다.
- Worker는 부분 결과를 반환하지 않는다. 성공 전체 또는 오류 전체만 반환한다.
- 사용자 대상 Job API와 상태는 [탐사 API 7장](../../apps/backend/docs/exploration-api-spec.md)을 따른다. 이 문서는 외부 API를 대체하지 않는다.

실제 HTTP 어댑터와 컨테이너는 `S15P21C206-88`, Redis 상태·중복 방지는 89, lease·fencing·복구는 90에서 구현한다.

## 2. 직렬화 공통 규칙

| 항목 | 규칙 |
| --- | --- |
| 문자 인코딩 | UTF-8 JSON |
| 필드 이름 | `snake_case` |
| schema | `schema_version="1.0"`만 허용 |
| DB BIGINT 식별자 | JSON 숫자로 보내지 않는다. Bundle `b-<id>`, Candidate `c-<id>`, Segment `seg-<id>`, TIC decimal string을 사용한다 |
| float | JSON number, 유한한 float64 값만 허용 |
| 결측 flux | JSON `null`. Worker 어댑터에서만 `null ↔ NaN`으로 변환하며 응답에서 다시 `null`로 보존한다 |
| 배열 | 순서가 계약의 일부다. 세그먼트는 `(sector, binning_revision, segment_id)`, 제거 후보는 `c-` 뒤 정수의 숫자 오름차순(DB `BIGINT` 순서)이다 |
| 시간·단위 | BTJD는 day, `bin_minutes`는 minute, 주기 범위는 day, duration은 hour, depth는 ppm이다 |
| 부분 결과 | 금지. `ok=true`의 완전한 `result` 또는 `ok=false`의 `error` 중 하나만 보낸다 |

과학 규칙의 정본은 이 계약이 아니다. `transit_model`의 최종 shape·bin 평가 시각은 `S15P21C206-113`, 주기도 계산과 격자 의미는 `S15P21C206-120`, 수치 허용 오차는 `S15P21C206-131`이 소유한다.

## 3. 요청

### 3.1 공통 필드

| 필드 | 타입·단위 | 규칙 |
| --- | --- | --- |
| `schema_version` | string | `1.0` |
| `operation` | enum | `residual`, `periodogram` |
| `job_id` | string | Backend Job ID, 예: `rj-78` |
| `attempt` | integer | 1 이상인 Job 단위 시도 번호다. Backend가 재시도할 때 올리며 Worker는 증가시키지 않는다 |
| `publication_bundle_id` | string | `b-<id>`, 요청 전과 응답 채택 전에 Backend가 current를 확인한다 |
| `tic_id` | decimal string | 단위 없음 |
| `fold_reference_time_btjd` | float64 day | Bundle 공통값을 그대로 전달한다 |
| `residual_model_version` | string | Gold manifest 값 |
| `periodogram_config_version` | string | Gold manifest 값 |

### 3.2 `residual`

- `curve_segments[]`: `segment_id`, `sector`, `binning_revision`, `start_btjd`, `bin_minutes`, `n_points`, `flux`를 보낸다.
- `start_btjd`는 ERD의 첫 bin 시작 시각을 Backend가 그대로 보낸다. bin 중심 평가를 위한 시각 이동은 Worker 어댑터가 113번 규칙에 따라 수행하며 Backend는 옮기지 않는다.
- `removed_candidates[]`: `candidate_id`, `transit_model`을 보낸다. 목록 자체가 제거 조합이며 ID 오름차순·중복 없음이어야 한다.
- 빈 목록 `[]`은 `invalid_operation_payload`로 거절한다. 원본 곡선·주기도는 Gold에 이미 있고 Backend도 빈 조합을 계산 대상으로 만들지 않는다(탐사 API 7.1절). 빈 조합의 의미는 커널 불변량(제거 없음 = 입력 그대로)과 API 0단계의 DB 원본 반환으로 따로 검증한다(!211 합의).
- flux가 전부 `null`인 세그먼트는 거절하지 않는다(88 제안). 잔차는 그 세그먼트를 전부 `null`로 돌려주고 `n_valid_input`에 0을 더한다. 이런 세그먼트를 Gold에 허용할지는 Gold 계약·QA(113·117)가 정한다.
- Worker는 각 세그먼트에 같은 제거 조합을 적용하고 `residual_segments[]`를 반환한다.
- `transit_model` 검증과 잔차 제거는 [`libs/astro-kernel`](../../libs/astro-kernel/README.md)을 사용한다.

### 3.3 `periodogram`

- `residual_segments[]`: 직전 잔차 성공 응답의 `segment_id`, `n_points`, `flux`를 전달한다.
- `removed_candidate_ids[]`: 직전 단계와 같은 정렬된 제거 조합을 전달한다. 빈 목록은 3.2절처럼 거절한다.
- 모든 세그먼트를 이어 붙여 시각순으로 정렬한 뒤 계산한다. 전부 `null`인 세그먼트는 유효점이 없어 결과에 기여하지 않으며, 합친 유효점이 BLS 하한(100점)보다 적으면 `insufficient_observations`다.
- `period_grid`: `min_days`, `max_days`, `count`, `spacing`. Backend가 원본 주기도와 같은 격자로 조립한다(88 제안). `min_days`·`max_days`·`count`는 current Bundle의 `periodograms.period_min_days`·`period_max_days`·`n_periods` 열에서, `spacing`은 `manifest.period_grid.spacing`에서 읽는다. `period_max_days`는 별마다 다르고 그 정본이 DB 열이다. Worker는 manifest 키 이름을 알지 않는다.
- `periodogram_config_version`: 격자 밖의 설정(duration·objective 등)을 3.4절 표로 고정한다.
- Worker는 `period_days`, `power`, `n_periods`를 반환한다. fixture 값은 직렬화 예제이며 과학 기준값이 아니다.
- 첫 residual과 이어지는 periodogram은 같은 `attempt`를 사용한다. periodogram만 재시도하면 Job의 `attempt`를 올리고 성공한 residual 값은 재계산하지 않고 새 periodogram 요청에 재사용한다. 늦게 도착한 이전 attempt 응답은 버린다.

### 3.4 주기도 설정 버전 (88 제안)

`periodogram_config_version`은 Gold의 원본 주기도를 만든 설정과 같은 설정을 가리킨다. 격자 범위·점 수는 요청의 `period_grid`가 정하고, 나머지는 아래 표가 고정한다.

| 버전 | `spacing` | duration (hour) | objective | oversample | 오차 `dy` |
| --- | --- | --- | --- | --- | --- |
| `pg-log5000-v1` | `log` | 1.2, 1.92, 2.88, 4.8 | `likelihood` | 10 | 유효 flux 전역 `1.4826 × MAD` |
| `provided-bls-1.0.0` | `log` | 1.2, 1.92, 2.88, 4.8 | `likelihood` | 10 | 유효 flux 전역 `1.4826 × MAD` |

- 두 행은 **같은 설정의 두 이름**이다. `provided-bls-1.0.0`은 123 제공 해상도 규칙(`astro_kernel.discoverability`의 `RULE`·`NUMERICAL_VERSION`)의 이름이며 125 Gold 직렬화 재생이 쓴다. 이 규칙은 격자도 커널 `period_grid`로 만든다. 이름이 하나로 정해질 때까지 Worker는 둘 다 받는다(262 인계). 계약 예제의 `bls-log-v1`은 설정이 정의되지 않은 예시 문자열이라 받지 않는다.

- 근거: 117 왕복 예제, 병합된 로컬 시드, 262 목업이 모두 이 버전 문자열과 위 power 설정(duration·objective·dy)을 쓴다. 표의 값은 `astro_kernel.bls.bls_periodogram`의 기본 동작과 같다. 형식 확정은 Gold 계약 소유자(113·117)가 한다. [데이터 파이프라인 문서](../../docs/data/tess-pipeline/README.md)는 아직 `제안`이다.
- **격자 생성식은 커널 `astro_kernel.bls.period_grid`(log면 `np.geomspace`)다.** 117 예제와 262 목업의 원본 주기도는 `exp(linspace(log))`로 만들어, 5,000점 격자에서 3,152점이 최대 약 3.6e-14 day(상대 1e-15) 다르다. 격자를 비트 단위로 대조하는 비교(131)는 기준 계산에도 커널 함수를 써야 한다.
- 표에 없는 버전은 `unsupported_periodogram_config_version`, 버전과 다른 `spacing`은 `invalid_period_grid`로 거절한다. residual 요청에도 같은 검사를 적용해 쓸모없는 잔차 계산을 막는다.
- 설정을 바꾸려면 새 버전 행을 더한다. 기존 행의 값은 바꾸지 않는다.

## 4. 응답과 오류

성공 응답은 요청의 `schema_version`, `operation`, `job_id`, `attempt`, `publication_bundle_id`, `tic_id`, `removed_candidate_ids`를 그대로 돌려준다. Backend는 하나라도 다르면 결과를 채택하지 않는다.

envelope(`ok=true`·`ok=false`)는 HTTP 200으로 보낸다(88 제안). envelope가 없는 응답은 둘뿐이다. 본문을 JSON 객체로 읽을 수 없으면 400·411·413이며 Backend 조립 결함이라 재시도하지 않는다. 인스턴스 동시 실행 상한이 찼으면 503이며 Backend는 연결 실패와 같이 `worker_unavailable`로 본다.

Worker가 만든 응답(성공·오류)은 `runtime`을 싣는다(88 제안). 결과를 낸 실행 환경을 131 비교와 재현에 남기기 위한 것이며 Backend는 채택 판단에 쓰지 않는다.

| 필드 | 타입 | 규칙 |
| --- | --- | --- |
| `runtime.worker_image` | string | 배포한 이미지 참조. CI 배포는 `<registry>/derived-compute:<commit SHA>` 태그이며 로컬 실행은 `local`이다. digest는 배포 노드에서 따로 확보한다([Worker README](../../apps/derived-compute/README.md) 「131 인계」) |
| `runtime.python`, `runtime.numpy`, `runtime.astropy`, `runtime.astro_kernel` | string | 실행 중인 패키지 버전 |

오류 응답은 같은 상관 필드와 아래 객체를 가진다.

```json
{
  "ok": false,
  "error": {
    "stage": "RESIDUAL",
    "code": "invalid_parameter",
    "retryable": false,
    "message": "request validation failed",
    "field": "removed_candidates[0].transit_model.parameters.depth_ppm",
    "model_index": 0
  }
}
```

| 내부 오류 | Backend 자동 재시도 | 외부 실패 | Backend 처리 |
| --- | --- | --- | --- |
| `unsupported_schema_version`, `unsupported_operation`, `invalid_operation_payload` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | `FAILED` |
| `flux_length_mismatch`, `duplicate_candidate_id`, `invalid_removed_candidate_order` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | `FAILED` |
| `astro-kernel`의 `invalid_*`, `unsupported_*`, `missing_parameter`, `unknown_parameter`, `version_mismatch`, `shape_mismatch` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | 원래 code·field·model index 보존. 코드 목록(13종)은 [astro-kernel README](../../libs/astro-kernel/README.md) 실패 코드 표가 정본 |
| `astro-kernel`의 `nonpositive_model`, `numerical_failure` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | 부분 결과 폐기 |
| `unsupported_periodogram_config_version`, `invalid_period_grid` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | 3.4절 표·요청 격자 위반(88 제안) |
| `astro_kernel.bls`의 `invalid_input`, `invalid_grid`, `insufficient_observations`, `degenerate_flux`, `numerical_failure` (`stage=PERIODOGRAM`) | 아니오 | `COMPUTE_ERROR`, `retryable=false` | `BlsError.code` 보존, 부분 결과 폐기(88 제안). 뜻은 [astro-kernel README](../../libs/astro-kernel/README.md) BLS 절 |
| `memory_exhausted` | 아니오 | `COMPUTE_ERROR`, `retryable=false` | Worker가 계산 중 메모리 상한에 걸려 스스로 멈춘 실패(88 제안). 같은 입력은 같은 상한에 다시 걸린다 |
| `compute_timeout`, `worker_unavailable` | 가능 | `COMPUTE_ERROR`, `retryable=true` | Backend가 만든 실패이며 같은 target 재요청에서 attempt 증가. 컨테이너가 OOM으로 강제 종료되면 응답이 없으므로 `worker_unavailable`로 보인다 |

없는 Bundle·후보, `RESIDUAL_QUEUE_FULL`, `BUNDLE_CHANGED`, `BUNDLE_ARCHIVED`, stale attempt 거절은 Backend가 요청 전·채택 전에 판단한다. Worker 오류 코드로 만들지 않는다. timeout 뒤 도착한 결과도 Backend가 current Bundle과 최신 attempt를 확인한 뒤 버린다.

## 5. 실측 전 초기 제한

| 설정 키 | 초기값 | 적용 위치 |
| --- | --- | --- |
| `derived_compute.service_concurrency` | 2 | Backend·Redis 전역 동시 실행 |
| `derived_compute.instance_concurrency` | 1 | Worker 인스턴스 |
| `derived_compute.cpu_per_job` | 1 | Worker 컨테이너 |
| `derived_compute.memory_mib_per_job` | 2048 | Worker 컨테이너 |
| `derived_compute.queue_capacity` | 20 | Backend·Redis 큐 |
| `derived_compute.member_active_jobs` | 1 | Backend 사용자 제한 |
| `derived_compute.operation_timeout_seconds` | 120 | Backend의 residual 또는 periodogram 한 번 호출 |

모두 실측 전 시작값이며 SLA가 아니다. 구현 티켓은 값을 코드에 고정하지 않고 설정으로 노출한다. `S15P21C206-104`가 대표 workload의 대기 시간, 단계별 계산 시간 p95, 실패율, 메모리 최고값과 큐 포화를 측정한 뒤 값과 성능 목표를 다시 승인한다. TTL·lease·재시도 횟수는 각각 89·90에서 정한다.

## 6. 합성 fixture와 검증 범위

- [정상 예제](examples/derived-compute.valid.json): 잔차와 주기도 두 호출, 상관 필드, `null`, 정렬된 제거 조합, `runtime`과 초기 제한을 검사한다.
- [오류 예제](examples/derived-compute.invalid.json): schema, 배열 길이, 후보 중복·순서, 빈 제거 조합, 단계 payload, 주기도 설정 버전·격자 간격, 실제 오류 envelope와 120초 timeout 처리를 검사한다.

저장소 루트에서 실행한다.

```powershell
node contracts/derived-compute/validate.cjs
python -c 'import json, pathlib; p=pathlib.Path("contracts/derived-compute/examples/derived-compute.valid.json"); v=json.loads(p.read_text(encoding="utf-8")); assert json.loads(json.dumps(v, allow_nan=False)) == v; print("PASS: Python JSON round-trip")'
```

Node 검증기는 JSON parse/stringify 왕복과 계약 불변량을 검사하고 Python 표준 라이브러리는 같은 정상 fixture의 `null`·float·배열 왕복을 확인한다. 실제 HTTP, Backend DTO, Redis, Worker 프로세스, 수치 정확도와 성능을 실행하지 않으므로 88·89·90·104·131 완료를 뜻하지 않는다.

현재 fixture는 bin 시작과 bin 중심 평가를 구분하지 못한다. 경계 bin이 갈리는 fixture와 평가 시각 검증은 113번 예제에서 제공한다.

## 7. 교차 리뷰

| 역할 | 검토 항목 | 상태 |
| --- | --- | --- |
| Data·Science | 단위, `null ↔ NaN`, transit model·period grid 인계 경계 | 승인, non-blocking 후속은 113에서 처리 |
| Backend | 두 단계 호출, 상관 필드, 오류 매핑, current·attempt 재검증 | 정렬·attempt·외부 retryable·시각 책임 보완 후 재검토 대기 |
| Data·Science (88 보완) | 3.4절 설정 표·격자 생성식, 전부 `null`인 세그먼트, 주기도 오류 코드 | 88 MR에서 검토 대기. 빈 제거 조합 거절은 !211에서 합의 |
| Backend (88 보완) | `period_grid` 조립 출처(DB 열 + manifest `spacing`), `runtime`, `memory_exhausted`·OOM 매핑 | 88 MR에서 검토 대기 |

Jira 70 또는 MR에 비작성자 검토 결과를 기록해야 완료로 본다. 요청 기록만으로 승인을 대신하지 않는다.

# EC2 온라인 파생 계산

## 책임 경계

[요구사항 명세서](../requirements/planetory-requirements-spec.md)의 POL-03·EXP-01·EXP-09·DAT-05·DAT-11·DAT-14와 DEC-35를 기준으로 한다.

- GCP Publisher: 품질 필터·비닝이 끝난 곡선 세그먼트, `fold_reference_time_btjd`, 원본 주기도, 후보별 고정 transit model과 계산 버전을 PostgreSQL Gold에 넣는다.
- Backend: PostgreSQL에서 현재 Bundle의 곡선 배열·후보 모델·버전을 읽고 Worker 요청을 만들며, 상태·중복 방지·Redis·판 변경 검증을 맡는다.
- Python Worker: Backend가 전달한 값만으로 잔차 곡선과 잔차 주기도를 계산한다. PostgreSQL·Redis를 직접 조회하지 않는다.
- HDFS: 내부 잔차, 품질 검증 결과, AI 입력과 공개한 PublicationBundle 백업을 RF2로 보관한다. EC2가 실시간 조회하지 않는다.

온라인 계산에는 `light_curve_segments.flux` 전체를 사용합니다. 제출 스냅샷이나 화면 표시용 150/200-bin 축약 배열은 계산 입력으로 사용하지 않습니다.

## 계산 프로그램 선택

| 안 | 장점 | 단점 |
| --- | --- | --- |
| Spring Boot 내부 Java | 배포와 호출 경로가 단순함 | 기존 Python 수치 코드 재작성·검증 필요 |
| Python 계산 컨테이너 | 기존 `experiments/tess-bls` 코드 재사용 가능 | 내부 API와 컨테이너 하나 추가 |

첫 구현은 **별도 Python Worker**로 확정한다. 잔차 제거는 공유 패키지 `libs/astro-kernel`의 `remove_transit_models`를 사용하고, Backend가 곡선 배열과 고정 모델을 전달한다. 운영 결과로 통신 비용이 실제 병목임이 확인될 때만 Java 이식을 다시 검토한다.

기존 `residual_after_candidates`, `bls_periodogram`을 후보로 사용하되, `joint_refit`가 후보 모델을 다시 맞추는 현재 동작은 “Gold의 고정 모델을 제거한다”는 계약과 다를 수 있다. 담당자 합의 전에는 그대로 운영 계약으로 채택하지 않는다.

## 내부 호출 프로토콜

Backend와 Worker는 내부 동기 HTTP/JSON `POST /internal/v1/derived-compute` 하나를 사용한다. `operation=residual|periodogram`으로 단계를 구분하고 Backend가 잔차 성공 뒤에만 주기도를 요청한다. 사용자 요청은 기존 비동기 Job API로 처리하므로 내부 HTTP 연결을 사용자 요청과 직접 묶지 않는다.

- Backend: current Gold 조회, 요청 조립, Redis 상태·결과·잠금, 중복·timeout·재시도 판단, 응답의 Bundle·attempt 재검증
- Worker: 전달된 배열·고정 모델·버전의 순수 계산, 성공 전체 또는 오류 전체 반환
- 금지: Worker의 PostgreSQL·Redis 접근, 사용자 인증·캐시 키 판단, Backend callback

필드·단위·식별자·오류와 합성 fixture는 [온라인 파생 계산 내부 계약](../../contracts/derived-compute/README.md)이 정본이다. 실제 Worker HTTP 어댑터는 `S15P21C206-88`, Redis 실행 제어는 89, lease·fencing·복구는 90에서 구현한다.

## 요청과 중복 방지

```text
cache_key = (
  tic_id,
  publication_bundle_id,
  정렬하고 중복 제거한 removed_candidate_ids,
  residual_model_version,
  periodogram_config_version
)

status = QUEUED
      → RESIDUAL_CALCULATING
      → RESIDUAL_READY
      → PERIODOGRAM_CALCULATING
      → COMPLETED
      ↘ FAILED
```

- 같은 키의 실행은 하나만 허용하고 나머지 요청은 같은 작업 상태를 본다.
- Backend는 같은 `job_id`·`attempt`로 잔차와 주기도를 순서대로 호출한다. 응답 상관 필드가 요청과 다르면 결과를 채택하지 않는다.
- 작업을 가져간 Worker에는 만료 시간을 둔다. Worker가 죽으면 만료 후 다른 Worker가 다시 계산한다.
- 재시도 번호가 오래된 Worker의 늦은 결과가 최신 결과를 덮어쓰지 못하게 한다.
- Worker 응답을 저장하기 전에 Backend가 요청의 `publication_bundle_id`가 아직 `current`인지 다시 확인한다. 판이 바뀌었으면 결과를 버리고 최신 판 재로드를 요구한다.
- 잔차가 준비된 뒤에만 주기도 계산을 시작한다. `RESIDUAL_READY` 결과를 화면에 먼저 노출할지는 벤치마크로 결정한다.
- 실패 상태에는 실패 단계·원인과 재시도 정보를 기록하고 마지막 정상 곡선을 유지한다.

## 판 변경과 버전 격리

- 분석 진입과 계산 요청마다 인증·공개·별 열림 상태와 PostgreSQL의 `current`를 확인한다.
- 화면이 가진 `publication_bundle_id`가 현재 판과 다르면 쓰기와 계산 결과 채택을 거절하고 최신 판으로 다시 불러온다.
- 서로 다른 Bundle 또는 계산 버전 사이에는 캐시를 재사용하지 않는다.
- 판이 `archived`가 되면 그 판의 Redis 계산 상태·결과·잠금을 정리한다. 판 행은 과거 제출 참조를 위해 PostgreSQL에 남긴다.

## 초기 자원 제한

| 설정 키 | 실측 전 시작값 | 적용 위치 |
| --- | --- | --- |
| `derived_compute.service_concurrency` | 2 | Backend·Redis 전역 실행 |
| `derived_compute.instance_concurrency` | 1 | Worker 인스턴스 |
| `derived_compute.cpu_per_job` | 1 | Worker 컨테이너 |
| `derived_compute.memory_mib_per_job` | 2048 | Worker 컨테이너 |
| `derived_compute.queue_capacity` | 20 | Backend·Redis 큐 |
| `derived_compute.member_active_jobs` | 1 | Backend 사용자 제한 |
| `derived_compute.operation_timeout_seconds` | 120 | residual 또는 periodogram 한 번의 내부 호출 |

이는 확정 용량이나 SLA가 아니라 부하 시험 시작값이다. 구현 티켓은 값을 코드에 고정하지 않고 설정으로 노출한다. 초과 요청은 재시도 가능 시간을 응답하고, timeout은 부분 결과를 채택하지 않은 채 재시도 가능한 실패로 기록한다.

가입자 1,000명은 동시 계산 1,000개를 뜻하지 않는다. 실제 요청률, 캐시 적중 여부, 점 개수와 주기 탐색 범위별로 측정해 제한을 조정한다.

`S15P21C206-104`에서 대표 workload의 대기 시간, 단계별 계산 시간 p95, 실패율, Worker 메모리 최고값과 큐 포화를 측정한다. 측정 결과로 위 시작값과 성능 목표를 재승인하며 Redis TTL·lease·재시도 횟수는 각각 89·90의 책임으로 남긴다.

## 캐시 위치

| 저장소 | 저장할 내용 | 판단 |
| --- | --- | --- |
| PostgreSQL | 현재 Gold 배열·후보 모델·버전, 판 상태 | 정본 |
| Redis | 계산 상태·결과·키별 잠금·오류 | 확정 |
| Worker 로컬 디스크 | 영속 결과 | 사용하지 않음 |

Backend만 PostgreSQL과 Redis에 접근한다. Worker 결과는 Backend가 Redis에 저장하며 Redis가 비면 다시 계산한다. TTL과 메모리 상한은 부하 시험으로 정한다.

## 수치 검증

Silver 기준 결과와 Worker 결과를 같은 비닝 세그먼트 시각·flux, 후보 집합, 모델 버전과 주기 격자에서 비교한다.

- 제거 후보 없음, 후보 1개·여러 개, 겹친 transit
- Sector 사이 공백, NaN, 0에 가까운 모델
- 같은 후보를 다른 순서로 요청한 경우
- 운영 대상 x86_64(amd64)에서 배치와 EC2 온라인 계산 결과 비교
- ARM64 실행을 지원할 필요가 생길 때만 아키텍처 간 결과 비교 추가

잔차 float64의 시작 기준은 유효점에서 `rtol=1e-8`, `atol=1e-10`으로 두되 과학 담당 검토 후 확정한다. 주기도는 power 오차와 최고 peak 위치를 따로 비교한다.

## Gold 계약과 용량 측정

Backend가 PostgreSQL에서 조립해 Worker에 보내는 최소 계약은 다음과 같다. DB 열과 manifest의 정본은 [서비스 DB ERD](database-erd.md)다.

```text
publication_bundle_id, tic_id
curve_segments: segment_id, start_btjd, bin_minutes, n_points, flux
fold_reference_time_btjd
removed_candidates: candidate_id, transit_model
residual_model_version, periodogram_config_version, period_grid
```

Backend는 manifest의 `segment_ids`로 곡선을 조립하고 중복 제거 후보와 버전을 검증한 뒤 전달한다. Worker는 파일 경로나 DB 자격 증명을 받지 않는다.

위 목록은 책임 경계 요약이다. wire 형식은 [온라인 파생 계산 내부 계약](../../contracts/derived-compute/README.md)의 `schema_version=1.0`, 접두 문자열 식별자, JSON `null`, 정렬 규칙과 두 단계 fixture를 따른다. fixture의 수치는 직렬화 예제이며 `S15P21C206-113`·120의 과학 규칙이나 131의 수치 기준을 대신하지 않는다.

이전 Gold 20~25GiB 추정은 축약 데이터 기준이므로 사용하지 않는다. 실제 형식과 압축으로 표본을 저장한 뒤 다음 방식으로 계산한다.

1. cadence, Sector 수, TIC별 점 수와 후보 수별로 표본을 뽑는다.
2. 곡선 배열, 주기도, 모델과 manifest의 실제 byte를 각각 측정한다.
3. `전체 용량 = 각 그룹의 TIC 수 × 그룹당 평균 byte`를 모두 더한다.
4. PostgreSQL Primary·Standby의 Gold 배열·인덱스·WAL·여유 공간과 Redis 결과·TTL·메모리 상한을 각각 더한다.
5. 예상 점유가 각 저장소 용량의 85%를 넘으면 공개 범위·보존 수·비닝 또는 저장소를 다시 결정한다. 계산용 곡선을 화면 스냅샷 크기로 임의 축약하지 않는다.

## 관측 항목

대기 작업 수, 가장 오래 기다린 시간, 계산 시간 p95, 캐시 적중률, 시간 초과, 실패율과 Worker 메모리를 수집한다. TIC ID와 작업 ID는 로그에 남기고 Prometheus label에는 넣지 않는다.

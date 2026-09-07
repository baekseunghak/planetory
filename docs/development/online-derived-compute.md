# EC2 온라인 파생 계산

## 책임 경계

요구사항 v0.9의 DAT-05·DAT-14와 DEC-35를 기준으로 한다.

- OCI 배치: 원본 정제곡선의 모든 점, 품질 마스크, 원본 주기도, 후보별 고정 transit model과 계산 버전을 Gold에 넣는다.
- EC2: 사용자가 제거할 후보를 선택하면 잔차 곡선과 잔차 주기도를 계산한다.
- HDFS: 내부 잔차, 품질 검증 결과와 AI 입력을 보관한다. EC2가 실시간 조회하지 않는다.

Gold의 UI 축약 곡선은 화면 표시용이며 온라인 계산 입력으로 사용하지 않는다.

## 계산 프로그램 선택

| 안 | 장점 | 단점 |
| --- | --- | --- |
| Spring Boot 내부 Java | 배포와 호출 경로가 단순함 | 기존 Python 수치 코드 재작성·검증 필요 |
| Python 계산 컨테이너 | 기존 `experiments/tess-bls` 코드 재사용 가능 | 내부 API와 컨테이너 하나 추가 |

첫 구현은 **Python 계산 컨테이너**를 권고한다. 검증된 계산 함수를 최소한으로 옮길 수 있기 때문이다. 운영 결과로 통신 비용이 실제 병목임이 확인될 때만 Java 이식을 검토한다.

기존 `residual_after_candidates`, `bls_periodogram`을 후보로 사용하되, `joint_refit`가 후보 모델을 다시 맞추는 현재 동작은 “Gold의 고정 모델을 제거한다”는 계약과 다를 수 있다. 담당자 합의 전에는 그대로 운영 계약으로 채택하지 않는다.

## 요청과 중복 방지

```text
cache_key = (
  tic_id,
  publication_bundle_id,
  정렬하고 중복 제거한 removed_candidate_ids,
  residual_model_version,
  periodogram_config_version
)

status = QUEUED → RUNNING → SUCCEEDED | FAILED
```

- 같은 키의 실행은 하나만 허용하고 나머지 요청은 같은 작업 상태를 본다.
- 작업을 가져간 Worker에는 만료 시간을 둔다. Worker가 죽으면 만료 후 다른 Worker가 다시 계산한다.
- 재시도 번호가 오래된 Worker의 늦은 결과가 최신 결과를 덮어쓰지 못하게 한다.
- 결과에는 계산한 EC2 노드와 checksum을 기록한다. 다른 노드가 로컬 경로를 직접 열지 않고, 필요하면 소유 노드의 내부 API를 호출하거나 다시 계산한다.
- 새 PublicationBundle이 활성화되면 이전 bundle의 결과를 새 요청에 재사용하지 않는다.

## 초기 자원 제한

서비스 전체에서 동시 계산 2개, EC2 한 대당 1개, 작업당 CPU 1개와 메모리 2GiB, 대기 20개로 시작한다. 이는 확정 용량이 아니라 부하 시험 시작값이다. 초과 요청은 재시도 가능 시간을 응답한다.

가입자 1,000명은 동시 계산 1,000개를 뜻하지 않는다. 실제 요청률, 캐시 적중 여부, 점 개수와 주기 탐색 범위별로 측정해 제한을 조정한다.

## 캐시 위치

| 저장소 | 저장할 내용 | 판단 |
| --- | --- | --- |
| PostgreSQL | 작업 상태, 키, 결과 경로, 오류 | 필요 |
| EC2 로컬 파일 | 큰 잔차 곡선·주기도 결과 | 첫 구현 권고 |
| Redis | 짧은 상태·자주 읽는 작은 결과 | 필요가 측정될 때 추가 |

첫 구현은 PostgreSQL과 EC2 로컬 파일만 사용한다. Redis는 상태 조회 부하나 노드 간 조정 문제가 실제로 확인될 때 추가한다. 캐시는 Gold 릴리스와 다른 경로에 두며 용량 상한과 만료 정책을 둔다.

## 수치 검증

Silver 기준 결과와 EC2 결과를 같은 시간 배열, 품질 마스크, 후보 집합, 모델 버전과 주기 격자에서 비교한다.

- 제거 후보 없음, 후보 1개·여러 개, 겹친 transit
- Sector 사이 공백, NaN, 0에 가까운 모델
- 같은 후보를 다른 순서로 요청한 경우
- x86_64와 ARM64 실행 결과

잔차 float64의 시작 기준은 유효점에서 `rtol=1e-8`, `atol=1e-10`으로 두되 과학 담당 검토 후 확정한다. 주기도는 power 오차와 최고 peak 위치를 따로 비교한다.

## Gold 계약과 용량 측정

최소 계약 후보는 다음과 같다. 자료형·필수 여부·시간 기준은 계약 MR에서 확정한다.

```text
publication_bundle_id, tic_id, schema_version, source_versions
curve: path, point_count, dtype, time_unit, time_reference, flux_unit, quality_mask
periodogram: path, grid_definition, periodogram_config_version
transit_models: candidate_id, period, epoch, duration, depth, shape, model_version
normalization: baseline_definition, version
checksums, created_at
```

이전 Gold 20~25GiB 추정은 축약 데이터 기준이므로 사용하지 않는다. 실제 형식과 압축으로 표본을 저장한 뒤 다음 방식으로 계산한다.

1. cadence, Sector 수, TIC별 점 수와 후보 수별로 표본을 뽑는다.
2. 곡선, 품질, 주기도, 모델과 manifest의 실제 byte를 각각 측정한다.
3. `전체 용량 = 각 그룹의 TIC 수 × 그룹당 평균 byte`를 모두 더한다.
4. EC2마다 OS·이미지·DB·로그, current·previous Gold, 전송 중 파일, 캐시와 여유 공간을 더한다.
5. 한 EC2의 예상 점유가 설치 용량의 85%를 넘으면 공개 범위·보존 수·형식 또는 저장소를 다시 결정한다. 계산용 곡선을 임의로 축약하지 않는다.

## 관측 항목

대기 작업 수, 가장 오래 기다린 시간, 계산 시간 p95, 캐시 적중률, 시간 초과, 실패율과 Worker 메모리를 수집한다. TIC ID와 작업 ID는 로그에 남기고 Prometheus label에는 넣지 않는다.

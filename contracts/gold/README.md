# Gold 게시 계약

> Jira: `S15P21C206-68`<br>
> 상태: 합성 fixture 검증 완료, 담당자 교차 리뷰 대기<br>
> 범위: GCP Publisher가 PostgreSQL에 적재한 Gold를 Backend와 Frontend가 같은 필드와 단위로 해석하는 계약

이 디렉터리는 실제 TESS 관측값이나 Gold 파일 형식을 보관하지 않는다. Gold의 서비스 정본은 PostgreSQL 배열과 메타데이터이며, fixture는 직렬화·필드 매핑·판 전환 규칙만 검사하는 작은 합성 데이터다. 과학적 정확도와 운영 성능은 각각 담당 데이터·인프라 Task에서 실측한다.

## 1. 정본과 책임 경계

- 기능·보존 정책은 [요구사항 명세서](../../docs/requirements/planetory-requirements-spec.md)의 DAT-11·14를 따른다.
- 테이블·열·제약은 [서비스 DB ERD](../../docs/architecture/database-erd.md)를 따른다.
- Frontend 응답 필드와 단위는 [탐사 API 명세](../../apps/backend/docs/exploration-api-spec.md)의 2.5절·5장을 따른다.
- Publisher는 `planetory_gold_writer`로 PostgreSQL에 직접 적재하고, Backend는 Gold를 읽기만 한다.
- Publisher의 DB 행, Backend 읽기 모델, Frontend API 응답은 같은 데이터의 서로 다른 표현이다. 하나의 JSON이 세 구성요소 사이를 그대로 이동한다고 해석하지 않는다.

## 2. 게시 내용과 제외 내용

Gold는 다음을 게시한다.

- `publication_bundles`: 판 상태, 공통 기준 시각, 관측 기간, manifest
- `light_curve_segments`: 섹터별 비닝 revision, 정규화 flux, 대표 산포, 공백 구간
- `periodograms`: current 판의 원본 곡선 주기도
- `candidates`: 후보 값, 고정 통과 모델, 발견 가능 여부와 외부 확정 여부

다음은 Gold에 게시하지 않는다.

- 원본 시각 배열: `start_btjd + (bin_minutes / 1440) × i`로 복원한다.
- 주기 격자 배열: 범위·점 수와 manifest 규칙으로 복원한다.
- 품질 마스크와 trend: 배치·Silver 내부 진단 정보다. Gold에는 품질 필터 적용 후 `flux`의 `null`과 `gaps`만 게시한다.
- 사용자용 단계별 잔차 곡선·주기도: Backend와 Python Worker가 current Gold에서 계산하고 Redis에 캐시한다.

## 3. 필드와 단위

| 의미 | Publisher DB | Backend·API | 타입·단위 | 규칙 |
| --- | --- | --- | --- | --- |
| TIC 식별자 | `tic_id` | `ticId` | 정수 식별자 | 단위 없음 |
| Bundle 식별자 | `id`, `bundle_id` | `bundleId` | DB `BIGINT`, API `b-<id>` 문자열 | API의 접두 식별자는 DB 숫자 ID와 같은 대상을 가리킨다 |
| Bundle 버전 | `bundle_version` | `bundleVersion` | 문자열 | DB·Backend·API에서 같은 문자열을 쓴다 |
| Bundle 상태 | `status` | current 조회로 표현 | enum | `staging`, `current`, `archived`만 허용한다 |
| 기준 시각 | `fold_reference_time_btjd` | `foldReferenceTimeBtjd` | float64, BTJD 일 | Bundle 공통값이며 세그먼트가 별도 값을 만들지 않는다 |
| 관측 기간 | `base_days` | `baseDays` | 일 | 양수다 |
| 첫 bin 시각 | `start_btjd` | `startBtjd` | float64, BTJD 일 | 첫 bin 시작 시각이다 |
| 비닝 간격 | `bin_minutes` | `binMinutes` | 분 | 기본 10분이며 세그먼트별 실제 값을 전달한다 |
| 밝기 | `flux` | `flux` | 정규화 상대 밝기 | 유한수 또는 `null`이며 JSON `NaN`을 쓰지 않는다 |
| 대표 산포 | `flux_scatter` | `fluxScatter` | flux와 같은 무차원 값 | 세그먼트당 하나다 |
| 공백 | `gaps` | `gaps` | 인덱스 폐구간 배열 | `[start, end]`, `0 ≤ start ≤ end < nPoints`다 |
| 주기 범위 | `period_min_days`, `period_max_days` | `periodMinDays`, `periodMaxDays` | 일 | `0 < min < max`다 |
| 주기도 크기 | `n_periods`, `power` | `nPeriods`, `power` | 정수, 무차원 배열 | `nPeriods == power.length`다 |
| 후보 주기 | `period_days` | `periodDays` | 일 | 유한한 양수다 |
| 후보 기준 시각 | `epoch_btjd` | `epochBtjd` | BTJD 일 | 유한수다 |
| 지속시간 | `duration_hours` | `durationHours` | 시간 | 유한한 양수다 |
| 깊이 | `depth_ppm` | `depthPpm` | ppm | 0 이상이다 |
| 계산 버전 | manifest snake_case | API camelCase | 문자열 | `residual_model_version`, `periodogram_config_version`은 필수다 |

세그먼트와 후보 식별자도 같은 방식으로 DB 숫자 ID를 API의 `seg-<id>`, `c-<id>`에 대응한다. 접두 문자열은 외부 표현이며 DB 열 타입을 바꾸지 않는다.

`transit_model`의 세부 shape와 수치 경계는 `S15P21C206-113`이 소유한다. 이 fixture는 현재 box 모델 예시가 비어 있지 않은 JSON 객체인지와 manifest 버전 연결만 검사하며, 과학 계약 확정 증거로 사용하지 않는다.

## 4. 판 전환 시나리오

[정상 fixture](examples/publication-bundle.valid.json)는 동일한 TIC에서 Bundle 100이 current인 상태에 Bundle 101을 게시하는 사례다.

1. Publisher가 Bundle 101과 관련 Gold 행을 `staging`으로 적재한다.
2. 검증에 성공하면 같은 트랜잭션에서 Bundle 100을 `archived`, Bundle 101을 `current`로 전환한다.
3. archived Bundle 100의 `periodograms`를 정리하되 Bundle 행은 과거 제출 참조를 위해 남긴다.
4. 커밋 후 Publisher가 Backend에 `bundleId=101`을 알린다. 알림 실패는 DB 전환을 되돌리지 않는다.
5. Backend는 Bundle 100의 Redis 상태·결과·잠금을 정리하고, 요청과 Worker 응답 채택 전에 DB current가 101인지 확인한다.
6. Frontend는 `BUNDLE_CHANGED` 또는 `X-Current-Bundle` 변경을 받으면 101을 다시 불러온다.

`previous` 상태나 파일 심볼릭 링크는 계약에 없다. 진행 중 분석을 특정 Bundle에 고정하지 않는다.

## 5. 합성 fixture

- [정상 예제](examples/publication-bundle.valid.json): Publisher DB 행, Backend 읽기 모델과 Frontend 응답이 같은 TIC·Bundle·세그먼트·주기도를 해석하는 사례다.
- [오류 예제](examples/publication-bundle.invalid.json): 정상 예제에 적용할 최소 변형과 예상 오류 코드다.

배열은 계약 검사를 위해 4점으로 축약했으므로 용량·분포·과학적 정확도의 근거가 아니다. fixture checksum만 축약 배열을 `JSON.stringify`한 UTF-8 바이트의 SHA-256으로 재현한다. 운영 Publisher의 언어 간 checksum 직렬화 규칙을 확정한 것이 아니다.

저장소 루트에서 다음을 실행한다.

```powershell
node contracts/gold/validate.cjs
```

검증기는 JSON 파싱, 필수 manifest, 필드·단위, 배열 길이, checksum, quality mask 비게시, 판 전환과 Publisher→Backend→Frontend 매핑을 검사한다. 실제 PostgreSQL, Publisher, Backend와 Frontend를 실행하지 않으므로 통합 검증 완료를 뜻하지 않는다.

## 6. 미확정·후속 검증

| 항목 | 현재 상태 | 담당·종결 조건 |
| --- | --- | --- |
| `transit_model` 세부 shape·baseline·수치 경계 | 미정 | `S15P21C206-113`의 정상·오류 fixture와 승인 결과를 반영한다 |
| 운영 checksum canonicalization | 미정 | `S15P21C206-117`에서 Python·PostgreSQL 왕복 시 같은 바이트·값을 검증한다 |
| Gold PostgreSQL 실제 왕복·공개 QA | 미검증 | `S15P21C206-117`이 독립 PostgreSQL round-trip과 손상 입력을 검증한다 |
| Redis TTL·메모리·동시 실행 상한 | 실측 대기 | 부하 시험 담당 Task에서 정한다 |
| 실제 TESS 배열 크기·용량·수치 허용 오차 | 실측 대기 | D17·D23 계열 검증 결과를 반영한다 |

미확정 값을 fixture의 합성값으로 대신 확정하지 않는다. 애플리케이션 코드, DB migration과 운영 설정은 이 계약 작업에서 변경하지 않는다.

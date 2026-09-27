# Gold 게시 계약

> Jira: `S15P21C206-68`, `S15P21C206-69`<br>
> 상태: 필드·단위 및 Publisher 멱등 적재 합성 fixture 검증 완료, Data 승인·Backend 재검토 대기<br>
> 범위: GCP Publisher가 PostgreSQL에 적재한 Gold를 Backend와 Frontend가 같은 필드와 단위로 해석하는 계약

이 디렉터리는 실제 TESS 관측값이나 Gold 파일 형식을 보관하지 않는다. Gold의 서비스 정본은 PostgreSQL 배열과 메타데이터이며, fixture는 직렬화·필드 매핑·판 전환 규칙만 검사하는 작은 합성 데이터다. 과학적 정확도와 운영 성능은 각각 담당 데이터·인프라 Task에서 실측한다.

## 1. 정본과 책임 경계

- 기능·보존 정책은 [요구사항 명세서](../../docs/requirements/planetory-requirements-spec.md)의 DAT-11·14를 따른다.
- 테이블·열·제약은 [서비스 DB ERD](../../docs/architecture/database-erd.md)를 따른다.
- Frontend 응답 필드와 단위는 [탐사 API 명세](../../apps/backend/docs/exploration-api-spec.md)의 2.5절·5장을 따른다.
- Publisher는 `planetory_gold_writer`로 PostgreSQL에 직접 적재하고, Backend는 Gold를 읽기만 한다.
- Publisher의 DB 행, Backend 읽기 모델, Frontend API 응답은 같은 데이터의 서로 다른 표현이다. 하나의 JSON이 세 구성요소 사이를 그대로 이동한다고 해석하지 않는다.

### I02-2 결정 기록 — Publisher 적재 경계

- 결정일: 2026-09-15
- 결정·승인: 김동혁
- 검토: 강재민(Backend), 윤성용(Data). 아래 멱등성 보완안은 2026-09-16 재검토 대기다.

| 기준 | Publisher 직접 INSERT | Backend 내부 적재 API |
| --- | --- | --- |
| 인증 | Publisher 전용 DB 자격 증명만 관리 | Publisher용 서비스 인증을 새로 설계해야 함 |
| 네트워크 | GCP Publisher가 PostgreSQL Primary에 직접 접속 | Publisher→Backend→PostgreSQL 홉과 장애 지점이 추가됨 |
| 트랜잭션 | 적재·검증·current 전환을 한 DB 트랜잭션으로 묶음 | API timeout과 DB commit 결과를 별도로 조정해야 함 |
| 재시도 | DB 유일 제약·잠금·의미 payload 비교로 판정 | HTTP 재시도 계약과 서버측 멱등 저장소가 추가로 필요 |
| 권한 | `planetory_gold_writer`에 Gold 쓰기만 허용 | 서비스 런타임에 Gold 쓰기 권한이 필요해짐 |
| 운영 | Writer 자격 증명·접속 경로를 Publisher에 한정 | Backend에 배치 적재 부하와 운영 책임이 추가됨 |

직접 INSERT를 유지한다. 그 결과 Publisher가 트랜잭션·rollback·멱등 판정을 소유하고, Backend는 Gold 읽기와 커밋 후 후처리만 담당한다. 실제 DB 권한·접속·migration 구현은 86·87번에서 검증한다.

## 2. 충돌표

| 충돌 지점 | 기존 설명 | 확정 계약 | 검증·책임 |
| --- | --- | --- | --- |
| Gold 저장 위치 | `releases/<id>` 파일과 `current`·`previous` 링크 | 서비스 정본은 PostgreSQL 배열과 manifest다. Publisher가 직접 적재한다 | 정상 fixture의 Publisher DB 행과 Gold 스키마 테스트 |
| 판 보존 | 직전 판 파일을 `previous`로 보존 | 상태는 `staging/current/archived`만 사용한다. Bundle 행은 과거 제출 참조용으로 남기고 archived 주기도·캐시는 정리한다 | 오류 fixture의 `previous` 거절, repository의 archived id 조회 |
| 진행 중 분석 | 세션 시작 시 Bundle을 고정 | 요청과 Worker 응답 채택 전에 DB current를 다시 확인하고, 변경되면 Frontend가 최신 판을 다시 조회한다 | `BUNDLE_CHANGED`, `X-Current-Bundle`, current 매핑 검사 |
| 품질 정보 | 품질 마스크를 Gold와 화면 계약에 포함 | 품질 마스크와 trend는 배치·Silver 내부에서만 사용한다. Gold는 필터 적용 후 `flux`의 `null`과 `gaps`만 게시한다 | quality mask 비게시 검사 |
| 온라인 계산 결과 | PostgreSQL 또는 로컬 파일에 저장, Redis는 선택 | Redis에 상태·결과·잠금을 두고 archived 판 키를 정리한다. 과거 제출용 DB 보존과 계산물 정리를 분리한다 | 정상 fixture의 Redis 제거 목록, 역할 권한 테스트 |
| 구성요소 간 payload | 한 JSON을 Publisher·Backend·Frontend가 그대로 전달 | 같은 TIC·Bundle을 DB snake_case, Backend 읽기 모델, API camelCase로 매핑하며 식별자와 단위를 보존한다 | 정상 fixture의 계층 간 필드·단위 비교 |

기존 문서별 반영 위치와 완료 상태는 [원본 문서 정합화 요청 R3~R5](../../docs/project/planetory-doc-sync-requests.md)를 따른다.

## 3. 게시 내용과 제외 내용

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

## 4. 필드와 단위

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
| 대표 산포 | `flux_scatter` | `fluxScatter` | flux와 같은 무차원 값 | 세그먼트 전체 robust 산포. 점별 측정 오차가 아니다(아래 114 채택안) |
| 공백 | `gaps` | `gaps` | 인덱스 폐구간 배열 | `[start, end]`, `0 ≤ start ≤ end < nPoints`다 |
| 주기 범위 | `period_min_days`, `period_max_days` | `periodMinDays`, `periodMaxDays` | 일 | `0 < min < max`다 |
| 주기도 크기 | `n_periods`, `power` | `nPeriods`, `power` | 정수, 무차원 배열 | `nPeriods == power.length`다. `power` 에는 `null`·NaN·Infinity 가 없다(격자 전 점에 값이 있어야 한다) |
| 후보 주기 | `period_days` | `periodDays` | 일 | 유한한 양수다 |
| 후보 기준 시각 | `epoch_btjd` | `epochBtjd` | BTJD 일 | 유한수다 |
| 지속시간 | `duration_hours` | `durationHours` | 시간 | 유한한 양수다 |
| 깊이 | `depth_ppm` | `depthPpm` | ppm | 0 초과 1,000,000 미만이다(`transit_model` 계약과 같다) |
| 계산 버전 | manifest snake_case | API camelCase | 문자열 | `residual_model_version`, `periodogram_config_version`은 필수다 |

세그먼트와 후보 식별자도 같은 방식으로 DB 숫자 ID를 API의 `seg-<id>`, `c-<id>`에 대응한다. 접두 문자열은 외부 표현이며 DB 열 타입을 바꾸지 않는다.

`transit_model` JSONB의 필드·단위·shape·수치 경계는 [`transit-model.schema.json`](transit-model.schema.json)(계약 1.0, `S15P21C206-113` 소유)이 정본이다. 정상·불량 예제는 [`examples/transit-model.valid.json`](examples/transit-model.valid.json)·[`examples/transit-model.invalid.json`](examples/transit-model.invalid.json)이며, 수식·필드 사이 규칙·실패 코드는 [`libs/astro-kernel`](../../libs/astro-kernel/README.md)이 구현하고 같은 예제로 검사한다. 정상 fixture의 후보 `transit_model`은 이 형식을 따른다. `validate.cjs`는 shape 규칙을 중복 구현하지 않고 비어 있지 않은 객체인지와 manifest 버전 연결만 검사한다.

### 4.1 S15P21C206-114 비닝 운영 채택안

다음은 114의 실측·화면 리뷰와 처리·운영 리뷰를 반영한 **목표 계약 변경안**이다. 운영 구현 완료를 뜻하지 않는다. 승인 진행 상태는 [정합화 요청](../../docs/project/planetory-doc-sync-requests.md)과 MR !101 활동에서 관리한다. 근거와 부분 bin 분포는 [114 벤치마크](../../docs/data/tess-binning-benchmark.md#운영-채택안과-115123-인계)에 둔다. 123은 승인된 규칙으로 구현하며 실험 코드를 그대로 운영에 복사하지 않는다.

| 항목 | 채택안 |
| --- | --- |
| 간격·대표값 | 10분, 유한한 전처리 flux의 산술 평균(mean). 중앙값은 기본값으로 쓰지 않는다 |
| 격자 | 첫 QUALITY/유한값 필터 통과 시각을 anchor로 고정하고 전처리 제외점도 시간 범위에 남긴다. `[시작, 끝)` bin, 마지막 경계점은 다음 bin. 1e-8 bin 이내 경계 스냅을 적용한다 |
| 시각 | `start_btjd`는 첫 bin 시작. 모델 평가는 `start_btjd + (i + 0.5) × bin_minutes / 1440`인 중심에서 한다 |
| 빈 bin | 유효 점 0개이면 NULL. 보간하지 않고 균등 격자와 `gaps` 인덱스 폐구간을 보존한다 |
| 부분 bin | 유효 점이 1개 이상이면 유지한다. counts는 배치 진단 산출물에 보존하되 Gold 배열에는 추가하지 않는다. 값은 관측된 점의 평균이며 10분 전체의 균일한 관측·같은 오차를 보장하지 않는다 |
| `flux_scatter` | 세그먼트의 유한한 비닝 flux 전체에 대한 `1.4826 × median(abs(flux − median(flux)))`. 무차원 상대 flux이며 통과·별 변동을 포함한다. 점별 표준오차·통과 밖 잡음·역분산 가중치로 해석하지 않는다 |
| 상한 | 빈 bin 포함 `n_points > 20,000`이면 실패·격리하고 게시하지 않는다. 자동 확대하지 않는다. 향후 확대는 새 규칙/revision과 discoverable 재계산을 요구한다 |
| 운영 revision | 원천 snapshot 식별자·제품별 checksum, 전처리 버전, 비닝 규칙 버전, 운영 수치 구현 버전의 정렬된 canonical JSON을 SHA-256으로 식별한다. TIC·Sector 및 실제 적용 파라미터를 포함한다. 시각·절대 경로·주석·lock 전체 hash는 식별 재료로 쓰지 않고 실행 manifest에 별도 기록한다 |

수치에 영향을 주는 의존성 변경도 운영 수치 구현 버전을 올린다. 같은 원천·파라미터·수치 구현은 같은 revision이고 변경된 원천이나 규칙은 새 revision이다. 기존 `bin-exp-v1-*`은 실험 식별자이므로 운영에 사용하지 않는다. canonical 직렬화와 버전 갱신 테스트는 123의 구현 인수 조건이다.

부분 bin을 제거하면 관측된 신호도 잃으며 이번 실험은 점 수별 기각 문턱의 이득을 검증하지 않았다. 따라서 추가 기각 없이 유지하는 규칙을 선택한다. counts 비게시가 오차 동등성을 입증하는 것은 아니다. Backend·Worker는 이 값으로 점별 불확실성이나 오차 가중치를 만들지 않는다. 그러한 기능이 필요하면 counts만으로 해결된다고 보지 않고 오차 계약을 별도 검토한다.

`qa-tolerances.v0.json`의 `flux_scatter`·비닝 수치 허용 오차는 여전히 `pending-measurement`다. 123 구현과 131 실환경 대조에서 허용 오차를 측정하기 전 수치 QA 통과를 선언하지 않는다. 유효 bin 없음·산포 0의 게시/소비 경계도 123에서 기존 스키마와 대조하여 검증한다.

### 4.2 S15P21C206-123 discoverable 연결·게시 경계

상태: 구현·로컬 검증, 실제 FITS 비교 및 처리·소비 리뷰 전이다. 115의 실험 격자와 달리
123은 [공개 QA](publication-qa.md)의 `max(40, 최장 후보 주기 × 1.15)` 상한을 따른다.
2026-09-22 담당자 확인으로 기존 API·Gold 계약에 맞춰 비교하기로 했다.
115 저장 결과를 새 격자의 실측 결과로 대신하지 않는다. 수치 규칙 승인 근거와 운영 게시 승인은 별도다.

- 평가 부족·수치 실패로 후보의 discoverable이 null이면 **새 Bundle 전체를 보류**하고 기존 current와 후보 값을 유지한다. 첫 게시라면 게시하지 않는다. 실패 후보만 빼거나 false로 치환하지 않으며 DB `BOOLEAN NOT NULL`과 완료·재개 API를 바꾸지 않는다.
- 정상 평가의 true/false만 게시 제안에 사용한다. `match_half_width_cells ≤ manifest.fine_tune.half_width_cells`를 강제하고 미세 조정 폭이 부족하면 입력 오류로 중단한다. 상위 N 추천은 판정 조건이 아니다.
- Publisher는 active·retired 모두 `discoverable` 키 누락·null·boolean 이외 값을 적재 거절한다. 기본 false로 보정하지 않는다. 커널의 유일한 운영 진입점은 `prepare_discoverability`다.
- 규칙·격자·수치 버전·비닝 입력과 revision·후보 모델·제거 순서를 `candidate_quality` revision에 포함한다. 기존 동일 ID의 양방향 boolean 변경만 `candidate_status_history` 제안으로 출력하며 새 후보를 false→true로 만들지 않는다. Publisher가 `changed_at`을 채우고 새 판과 함께 원자 적재한다. 회원별 재개 판정은 150 책임이다.
- `discoverability_ready=true`는 123 계산 완료만 뜻한다. 외부 확인 라벨(124), Gold 검증(125), 열 단위 투영·원자 current 전환(Publisher)이 남으므로 `publishable=false`를 유지한다. 런타임 잔차·주기도·진단 전체를 DB 행으로 INSERT하지 않는다.
- Publisher(87)는 후보 네 수치를 갱신하는 트랜잭션에 READ COMMITTED를 사용해야 한다. V19 트리거는 다른 격리 수준을 SQLSTATE `25000`으로 거절한다. 공개 요청의 BEFORE 트리거는 후보 행 `FOR SHARE`를 획득하므로 후보를 갱신하는 긴 배치 트랜잭션은 공개 요청을 지연시킨다. 후보 갱신·current 원자 전환의 잠금 순서와 트랜잭션 길이를 87 착수 전에 검토한다. 이번 123은 Publisher 트랜잭션을 구현하거나 격리 수준을 변경하지 않는다.

지원 규칙·호출법은 [커널 README](../../libs/astro-kernel/README.md#제공-해상도-판정-123),
비교 실행과 검증 범위는 [벤치마크 README](../../experiments/tess-bench/README.md#123-비닝제공-해상도-회귀)를 따른다.

### 4.3 S15P21C206-79 게시 후보 집계

상태: 커널·합성 fixture 검증 완료. 80이 Silver 저장 행에서 별 단위 입력을 되살려 123·124와 잇는 변환([Spark Gold 절](../../distributed-system/spark/README.md#tess-silver--gold-게시-후보-s15p21c206-80))을 합성 곡선으로 검증했다(2026-09-27). 실제 Silver attempt 실행, 80 gate 연결과 운영 run 검증은 아직 하지 않았다.

한 run의 대상 TIC 전체를 125 `assemble`로 검증해 게시 전 후보 표·staging 제안·manifest 하나로 모은다. 형식의 정본은 [`publication-candidates.schema.json`](publication-candidates.schema.json)이고 구현은 `astro_kernel.candidate_aggregation.aggregate`다. `publishable`은 항상 false이며 게시 승인과 DB 적재는 80 gate와 Publisher가 맡는다.

| TIC 상태 | 조건 | 후보 표 | run 완료 판정 |
| --- | --- | --- | --- |
| `ready` | 125 검증 통과 | active 후보마다 한 행 | 끝난 것으로 센다 |
| `no_signal` | 122 `no_candidates_publication_held` 또는 125 `empty_catalog_upstream_policy_required`이고 이전 판에 active 후보가 없음 | 없음 | 끝난 것으로 센다 |
| `held` | 122·123·세그먼트 보류, 124 매칭·라벨 보류, 이전 판의 active 후보가 모두 사라짐(`catalog:previous_candidates_vanished`) | 없음 | 끝난 것으로 센다 |
| `request_failed` | 124 원천 전달 보류(`<source>:source_held`). 수집이 미완료·미검증이거나 전달 행이 검증에 실패해 유효한 snapshot이 없다 | 없음 | 남은 것으로 센다 |
| `rejected` | 125 검증 실패, 외부 계보 불일치 | 없음 | 끝난 것으로 센다 |
| `unprocessed` | 대상인데 결과가 없음 | 없음 | 남은 것으로 센다 |

- **누락과 원천 실패를 구분한다.** 완전한 원천에 행이 없거나 라벨이 비어 있으면 후보를 남기고 `external.state=missing`으로 표시한다. 원천마다 `match=unmatched` 또는 빈 `raw_disposition`을 기록한다. 원천 전달이 실패하면 TIC 전체를 `request_failed`로 두고 행을 만들지 않는다. 124의 `source_held`는 수집 실패와 전달 행 검증 실패를 나누지 않으므로 둘 다 이 상태이며, 원천을 고쳐 다시 받을 때까지 run을 연다. 정상 snapshot 안의 시간 미확인 행(`unresolved_external_rows`)은 원천 실패가 아니라 `held`다. `request_failed`나 `unprocessed`가 하나라도 있으면 `complete=false`이고 run `status=incomplete`다.
- **계산 버전.** run 단위 `calculation_versions`에는 전처리·BLS·잔차·주기도·외부 매칭·AI 버전을 넣는다. `candidate_quality`는 123이 별마다 후보 모델과 제거 이력으로 만든 content revision이다. 그래서 run 단위로 받지 않고(들어오면 run 거절), 별마다 123 discovery의 `candidate_quality_revision`을 번들 manifest에 넣는다.
- **계보.** 후보 행은 `bundle_version`으로 manifest의 계산 버전과 번들별 `record_checksums`에 이어진다. 원천마다 `snapshot_id`·`snapshot_sha256`·`retrieved_at`·`source_row_updated_at`을 남긴다.
- **AI 미실행 값(2026-09-27 확정).** 126 인계 결정에 따라 AI는 정책상 미실행만 받는다. `calculation_versions.ai_model`·`ai_threshold`와 `ai_policy.model_version`·`threshold_version`은 `none/policy-hold-118`, `ai_policy.decision_reference`는 `docs/requirements/planetory-decision-register.md#126-범위-변경과-ai-출시-유예`로 고정한다. 커널 상수 `AI_POLICY`와 다른 값은 run 전체를 거절하므로 테스트 문자열이 운영 run에 들어가지 않는다. 이 값은 `bundle_version`의 재료라서 바꾸면 모든 별이 새 판이 된다. 새 결정 없이 바꾸지 않는다. 후보 행의 `ai`는 `score=null`이고 번들의 `ai_results`는 빈 목록이다. 미실행은 실패가 아니다. AI 결과를 연결하면(264) 이 블록의 모양은 유지하고 status 값을 늘리며 스키마 버전을 올린다.
- **중복.** 같은 TIC 결과가 둘이거나 run 안에서 후보·번들 ID가 겹치면 run 전체가 `rejected`다. 한 후보에 같은 원천이 두 번 붙으면 그 TIC을 거절한다. 후보 행 수는 번들 active 후보 수의 합과 같다.
- **무신호 별.** [SRS](../../docs/requirements/planetory-requirements-spec.md) SUB-11(1)·DEC-25·[ERD](../../docs/architecture/database-erd.md) 결정 3에 따라 적재·공개하지 않는다. `no_signal`은 게시를 호출하지 않고 `PUBLISH_REJECTED` 같은 실패로 세지 않는다. 이미 current가 있는 별이 새 run에서 active 후보를 모두 잃으면 무신호가 아니라 처리 회귀를 의심해 `held`로 두고 기존 current를 유지한다. 별 숨김(`stars.service_status='hidden'`)은 회원 진행에 영향을 주는 제품 결정이라 이 경로에서 하지 않는다.
- **공급 집계.** manifest의 상태별 TIC 수와 `discoverable_ready_tic_count`(`ready`이고 active·discoverable 후보가 하나 이상인 TIC 수)는 게시 전 값이다. 튜토리얼 제외와 게시 검증 전이므로 DEC-01 공급량의 상한일 뿐 공급량이 아니다. 게시 후 공식 집계는 `python -m publisher supply-report`가 한다([Publisher README](../../distributed-system/publisher/README.md#dec-01-공급-집계-s15p21c206-79)). 공급 TIC 조건은 DEC-01 7.1절의 공급 집계 자격을 그대로 구현한다. 이 run의 `ready`, DB current 판이 이 run의 판, `stars.service_status='published'`, active·discoverable 후보 하나 이상, 사용 중인 튜토리얼 별이 아님이다. Backend 발견 대상 풀(OPS-08, `AchievementRepository.pickUndiscoveredStar`)은 후보·`discoverable`을 보지 않으므로 이 조건과 같지 않다. 튜토리얼 제외만 그 풀과 같은 `active` 기준을 따른다. 진행 중 챌린지 대상은 발견에서만 일시 제외되므로 공급에서 빼지 않는다. 미처리·실패·보류·무검출 수는 같은 run의 manifest에서 가져온다. manifest 미완료 또는 게시 누락이면 `undetermined`로 두고 통과로 판정하지 않는다.
- **튜토리얼 TIC 범위(2026-09-27 확정).** DEC-01의 "튜토리얼 TIC"은 `tutorial_stars.active=true`인 슬롯의 TIC이다. 열 뜻이 '사용 중'이고, Backend의 튜토리얼 조회·가입 검사·발견 풀(OPS-08)이 모두 `active`만 튜토리얼로 보며, 비활성 슬롯의 별은 일반 발견에 풀려 "현행 배정 계약상 이용 가능한 별"이기 때문이다. 튜토리얼 5종은 1~5번 슬롯이 모두 active이고 각 별이 위 제공 조건을 만족할 때 충족이다. 비활성 슬롯이 있으면 5종 조건이 이미 미달이므로 이 해석이 합격·미달 판정을 바꾸지 않는다. 튜토리얼별 정답 라벨 검증은 운영자 몫(OPS-07)이며 이 집계가 대신하지 않는다.
- 산출 위치(GCP staging 경로)와 파일 형식은 80에서 정한다.

## 5. 판 전환 시나리오

[정상 fixture](examples/publication-bundle.valid.json)는 동일한 TIC에서 Bundle 100이 current인 상태에 Bundle 101을 게시하는 사례다.

1. Publisher가 Bundle 101과 관련 Gold 행을 `staging`으로 적재한다.
2. 검증에 성공하면 같은 트랜잭션에서 Bundle 100을 `archived`, Bundle 101을 `current`로 전환한다.
3. archived Bundle 100의 `periodograms`를 정리하되 Bundle 행은 과거 제출 참조를 위해 남긴다.
4. 커밋 후 Publisher가 Backend에 `bundleId=101`을 알린다. 알림 실패는 DB 전환을 되돌리지 않는다.
5. Backend는 Bundle 100의 Redis 상태·결과·잠금을 정리하고, 요청과 Worker 응답 채택 전에 DB current가 101인지 확인한다.
6. Frontend는 `BUNDLE_CHANGED` 또는 `X-Current-Bundle` 변경을 받으면 101을 다시 불러온다.

`previous` 상태나 파일 심볼릭 링크는 계약에 없다. 진행 중 분석을 특정 Bundle에 고정하지 않는다.

## 6. 합성 fixture

- [정상 예제](examples/publication-bundle.valid.json): Publisher DB 행, Backend 읽기 모델과 Frontend 응답이 같은 TIC·Bundle·세그먼트·주기도를 해석하는 사례다.
- [오류 예제](examples/publication-bundle.invalid.json): 정상 예제에 적용할 최소 변형과 예상 오류 코드다.
- [게시 재시도 예제](examples/publication-load-scenarios.json): `(tic_id, bundle_version)` 키의 정상 게시·동일 재시도·payload 충돌·일시 실패 rollback·검증 실패·교체된 판의 늦은 재시도를 검사한다. `payloads` 참조는 fixture 중복만 줄인 표기이며 운영 요청 형식은 아니다.
- [공개 QA·실패 계약 v0](publication-qa.md): 새 판 공개 전 검사 항목, 실패 상태(69 코드만 사용), 배열·레코드 checksum 직렬화 규칙 제안, [허용 오차 등록표](qa-tolerances.v0.json), 미결 공개 정책(손상 Sector·AI 실패). [배열 벡터](examples/array-checksum-vectors.v0.json)·[레코드 벡터](examples/record-checksum-vectors.v0.json)는 Python·Node·Java(강재민)·PostgreSQL 왕복으로 재현했다([`array-checksum.cjs`](array-checksum.cjs), [`record-checksum.cjs`](record-checksum.cjs)). 레코드 동률 벡터 4건도 Java 대조 완료. 실제 곡선 payload 와 round-trip 스크립트는 [`experiments/gold-roundtrip`](../../experiments/gold-roundtrip/README.md).
- [`transit_model` 계약](transit-model.schema.json)과 [정상](examples/transit-model.valid.json)·[불량](examples/transit-model.invalid.json) 예제: 후보 한 건의 고정 통과 모델 JSON. `libs/astro-kernel` 테스트가 Schema·예제·파서의 일치를 검사한다(`uv run pytest -q` in `libs/astro-kernel`).
- [게시 후보 집계 계약](publication-candidates.schema.json)(4.3절): 별도 예제 파일 없이 `libs/astro-kernel/tests/test_candidate_aggregation.py`가 완전·누락·요청 실패·중복 합성 run의 커널 출력을 이 Schema로 검사하고, 깨진 행을 거절하는지 확인한다.

Publisher 게시 명령의 관찰 가능한 결과와 소유권은 게시 재시도 예제가 정본이다. 이 README와 데이터 관리 문서는 해당 계약의 의미와 구현 인계 범위만 설명한다.

게시 재시도 예제에서 `publication_bundles.id`는 PostgreSQL이 성공 시 생성하는 결과값이다. 요청 키 `(tic_id, bundle_version)`에는 DB `UNIQUE` 제약을 둔다. 같은 TIC의 게시를 `pg_advisory_xact_lock(tic_id)`으로 직렬화하며 동시 요청은 잠금 뒤 앞선 commit 또는 rollback을 관찰한다.

`bundle_version`은 실행 시각·run id가 아니라 정렬한 입력 snapshot id, 세그먼트 자연 키 `(tic_id, sector, binning_revision)`, 계산 버전 집합의 UTF-8 행을 LF로 연결한 SHA-256(`pv1-<hex>`)이다. 입력 snapshot id에는 곡선 원천과 TCE·TOI·Archive·ExoFOP 외부 참조 snapshot을 모두 넣으므로 외부 snapshot이 바뀌어도 새 `bundle_version`과 PublicationBundle을 만든다. 전처리·BLS·잔차·주기도·후보 품질·AI·외부 매칭 계산이 바뀌면 해당 계산 버전을 올려 새 `bundle_version`을 만든다.

계산 버전 중 `bls_config`는 반복 BLS·후보 제거 순서·종료 규칙을, `candidate_quality`는 후보 병합·고조파/alias·원본 곡선 재검증·`discoverable` 판정 규칙을 포함한다.

동일성은 입력 snapshot, 자연 키별 배열 checksum, 주기도·후보·AI·외부 상태 checksum, 계산 버전, `fold_reference_time_btjd`, `base_days`의 의미 payload로 비교한다. 배열은 snapshot id와 세그먼트 자연 키로 정렬하고 float64는 Producer가 JSON에 유효숫자 17자리로 보존한 뒤 파싱된 값을 정확 비교한다. DB 생성 `publication_bundles.id`, `light_curve_segments.id`, `periodograms.bundle_id`, manifest의 `segment_ids`는 비교에서 제외한다.

같은 키의 의미 payload가 다르면 `IDEMPOTENCY_CONFLICT`, 검증 실패는 재시도하지 않는 `PUBLISH_REJECTED`, 일시 장애 rollback은 재시도 가능한 `PUBLISH_ROLLED_BACK`이다. 이미 archived인 동일 판의 늦은 재시도는 `BUNDLE_SUPERSEDED`를 반환하고 현재 판을 되돌리거나 알림을 보내지 않는다. current인 동일 판만 `ALREADY_PUBLISHED`로 기존 `bundleId`를 반환하고 알림을 재시도할 수 있다.

staging 적재와 current 전환은 각각 `S15P21C206-86`, `S15P21C206-87`의 구현 범위지만 별도 commit 경계가 아니다. 부분 유일 인덱스는 문장마다 즉시 검사되므로 같은 트랜잭션에서 **기존 current를 먼저 archived로 바꾸고 신규 staging을 current로 올리는 순서**를 지켜야 한다. Publisher가 트랜잭션과 rollback을 소유하고 Airflow는 같은 키로 전체 명령을 재시도한다. fixture의 checksum은 분기 설명용 합성 문자열이며 운영 checksum canonicalization을 확정하지 않는다.

배열은 계약 검사를 위해 4점으로 축약했으므로 용량·분포·과학적 정확도의 근거가 아니다. fixture checksum만 축약 배열을 `JSON.stringify`한 UTF-8 바이트의 SHA-256으로 재현한다. 운영 Publisher의 언어 간 checksum 직렬화 규칙을 확정한 것이 아니다.

저장소 루트에서 다음을 실행한다.

```powershell
node contracts/gold/validate.cjs
```

검증기는 JSON 파싱, 필수 manifest, 필드·단위, 배열 길이, checksum, quality mask 비게시, 판 전환, Publisher→Backend→Frontend 매핑과 게시 재시도 결과를 검사한다. 실제 PostgreSQL, Publisher, Backend와 Frontend를 실행하지 않으므로 통합 검증 완료를 뜻하지 않는다.

Gold 스키마·조회·DB 역할 경계는 Backend 디렉터리에서 다음 명령으로 검증한다.

```powershell
.\gradlew.bat test --tests 'com.planetory.backend.domain.gold.*' --no-build-cache
```

2026-09-16 기준 PostgreSQL 컨테이너에서 20건이 통과했다. 이 결과는 Gold DB 계약 검증이며 Publisher·Frontend를 함께 실행한 종단 간 검증은 아니다.

## 7. 교차 리뷰 기록

| 역할 | 담당자 | 검토 항목 | 상태 |
| --- | --- | --- | --- |
| 데이터 | 윤성용 | Bundle 버전 결정성, 의미 payload 비교 범위·정렬·float64 규칙 | 승인 (2026-09-16) |
| Backend | 강재민 | DB 유일 제약·잠금·current/archived 재시도와 실패 결과 | 보완 반영, 재검토 요청 예정 |
| Frontend | 백지웅 | `bundleId`·필드·단위 해석, `BUNDLE_CHANGED`·헤더 변경 시 재조회 | Jira 검토 요청 |

필드·단위 의견은 [Jira S15P21C206-68](https://ssafy.atlassian.net/browse/S15P21C206-68), Publisher 멱등성 의견은 [Jira S15P21C206-69](https://ssafy.atlassian.net/browse/S15P21C206-69)에 남긴다. 요청 기록만으로 승인을 대신하지 않는다.

## 8. 미확정·후속 검증

| 항목 | 현재 상태 | 담당·종결 조건 |
| --- | --- | --- |
| `transit_model` 세부 shape·baseline·수치 경계 | 확정 (계약 1.0, 2026-09-17) | `S15P21C206-113` [`transit-model.schema.json`](transit-model.schema.json). box·unity·`box-divide-v0`, 통과 경계 `<`, 깊이 0 초과 1,000,000 미만, Gold 세그먼트는 bin 중심 평가(호출자 이동). 변경은 새 `residual_model_version` |
| 운영 checksum canonicalization | 제안 v0 — 배열 `array-f32le-null7fc00000-v0`, 레코드 `record-canonical-v0` (2026-09-17) | [공개 QA 3절](publication-qa.md). Python·Node·Java(강재민: 배열 15+6, 레코드 6, DB 경로) 일치, PostgreSQL 18.6 REAL[] 왕복·행 재계산 일치. Python·Node·Java 모두 일치, 팀 확정만 남음. 확정 시 게시 재시도 예제의 합성 checksum 을 실제 값으로 교체 |
| Gold PostgreSQL 실제 왕복 | 검증됨 (로컬 PostgreSQL 18.6, V1~V8, TOI-270 S3 예제 62항목, 모든 검사 뒤 단일 commit·손상 payload 거절 확인, 2026-09-17) | [`experiments/gold-roundtrip`](../../experiments/gold-roundtrip/README.md). 운영 Publisher·Java 경로·Silver 수치 비교는 미실행(D17·D23). NUMERIC 열은 float8 바인딩 대신 최단 왕복 표기로 바인딩해야 float64 가 보존됨(서버 float8→numeric 15자리 반올림) |
| 게시 후 제공 가능 TIC 집계(DEC-01) | 구현·DB 검증(`supply-report`, 4.3절). 튜토리얼 범위는 활성 슬롯으로 확정(2026-09-27) | 운영 run 게시 뒤 실제 집계 실행. 합성 DB·단위 테스트만 통과했다 |
| 공개 QA 정책 (손상 Sector·AI 실패) | 미결 — v0 기본값: 부분 공개 없음, 같은 입력 반복 실패는 `PUBLISH_REJECTED`, 일시 실패는 `PUBLISH_ROLLED_BACK` 같은 `bundle_version` 재시도, 기존 current 유지 | [공개 QA 5절](publication-qa.md). 새 결과 코드는 만들지 않음. AI 실패 후 부분 공개·재게시는 `bundle_version` 충돌 때문에 69 담당과 합의 필요 |
| Redis TTL·메모리·동시 실행 상한 | 실측 대기 | 부하 시험 담당 Task에서 정한다 |
| 실제 TESS 배열 크기·용량·수치 허용 오차 | 실측 대기 | D17·D23 계열 검증 결과를 반영한다 |

미확정 값을 fixture의 합성값으로 대신 확정하지 않는다. 애플리케이션 코드, DB migration과 운영 설정은 이 계약 작업에서 변경하지 않는다.

### 알림 원천 저장 경계 (175, V23)

2026-09-23 사용자 승인으로 [F15.8](../../docs/development/service-backend/community.md#notification-producer-contract)의 제한된 DB 트리거 예외를 채택했다. Gold 직접 역할에는 회원·설정·관계 조회 권한을 추가하지 않는다. 적재·검증·current 전환의 기존 트랜잭션과 TIC 직렬화를 유지하고 지연 트리거를 중간에 강제 실행하지 않는다. 최종 판의 후보 변화와 실제 AI/외부 판정 변화를 DB가 원천 사건으로 기록하며 실패·rollback·동일 값 재시도는 새 알림을 만들지 않는다. 실제 Publisher 운영 연결 검증 완료를 뜻하지 않는다.

# Planetory 탐사 코어 API 명세

- 작성일: 2026-09-11
- 상태: **팀 협의용 초안 Draft 0.4** — 구현 완료·최종 합의된 API가 아니다. 경로·필드명·HTTP 상태 코드는 제안이며, SRS v1.3.1 변경안과 다른 결정은 여기서 확정하지 않고 12장 미결 표에 둔다.
- 담당: 강재민 / 탐사 코어 백엔드
- Jira: [S15P21C206-36](https://ssafy.atlassian.net/browse/S15P21C206-36) (기획 분석 `S15P21C206-31`, 상위 Epic `S15P21C206-26`)
- 기준: [요구사항 명세서 v1.3.1](../../../docs/requirements/planetory-requirements-spec.md)(v1.1 기준선 `S15P21C206-53`, v1.2 배치 계약 `S15P21C206-33`), [ERD v1.6](../../../docs/architecture/database-erd.md), [지도 프론트 PoC](../../../experiments/galaxy-map-prototype/)(하서진, 과거 v1.2 타일·군집 참고 구현이며 v1.3 응답과 직접 호환되지 않음), [온라인 파생 계산](../../../docs/architecture/online-derived-compute.md), [시스템 아키텍처](../../../docs/architecture/system-architecture.md)
- v1.3 개정: 2026-09-15. 개별 별 타일·cursor 응답 변경안은 [변경 검토 기록](../../../docs/development/sky-individual-stars-review.md)을 따른다. 관련 제공자/소비자 리뷰 후 적용하며 런타임 구현 완료가 아니다.
- 이전 개정: 2026-09-14, `S15P21C206-33`. 은하 배치 변경은 [별지도 표현 계약](../../../docs/development/sky-presentation-contract.md)을 기준으로 교차 리뷰한다. 과거 PoC의 방사형 자리 함수는 새 배치의 참조 구현이 아니다.
- 분담·공통 약속: [API 명세 파트 분담](README.md). 서비스 API(회원·커뮤니티·공개 분석·챌린지 회차)는 백승학의 서비스 API 명세를 따른다.
- 프론트 요구: 백지웅 분석 프론트 상세 명세 Draft 0.2의 협의 항목 Q03~Q12에 대한 답을 각 절에 `Qnn`으로 표기한다.

- C02 결정 반영: [#133 계약 대조·검토 기록](exploration-contract-review.md). 은퇴 후보 처리, Bundle 공통 기준 시각, 사용자가 고른 봉우리 기준 duration 3배 선택 폭을 2026-09-14 확정해 이 문서와 [JSON 검증 예제](../../../docs/api/exploration/README.md)에 함께 반영했다. MR !32에서는 결정의 재승인이 아니라 문서·예제 사이의 누락과 충돌을 검토한다.

기능별로 "언제 호출하는지 → 무엇을 보내는지 → 무엇을 받는지 → 실패하면 어떻게 처리하는지"를 쓴다. 예시의 ID·수치·시각은 모두 가상이다.

## 1. 범위

| 포함 | 제외 |
|---|---|
| 별 지도 타일·별 상세·퀘스트·내 별 목록 (HOME, MY-02) | 회원·세션·프로필·설정 (서비스 API 3장) |
| 분석 진입·현재 판·곡선 세그먼트·주기도·후보 투영 (EXP-01~05) | 게시글·댓글·첨부·출처 카드·반응 (서비스 API 5~8장) |
| 제출·검증·매칭·결과·상세 보기·다시 풀기·건너뛰기 (SUB, RES) | 공식 스레드·공개 분석 등록·취소·일괄 공개 (서비스 API 9장) |
| 온라인 잔차 작업 (EXP-09, DAT-14) | 챌린지 회차 조회·피드·검색·통계·알림 |
| 히스토리 목록·상세·그래프·별 결과 페이지 (HIS, RES-10) | Gold 배치 생산 (김동혁·윤성용) |
| 성과·등급·별 열림·완료·재개·외부 라벨 표식 (GRD, SUB-11, DAT-15) — 조회 API와 내부 계약 | 운영 화면·관리 API (v1 제외, OPS-01·06) |

## 2. 공통 약속

서비스 API 명세 2장(경로 `/api/v1`, JSON camelCase, ID 문자열, ISO 8601 UTC, `items/nextCursor/hasNext` 커서, 오류 본문 `{code, message, fieldErrors[]}`, 세션 인증, 401/403/404/409/503)을 그대로 상속한다. 서비스 API는 일반 글·댓글에 요청 키를 두지 않기로 했으므로(SB-D17), 멱등 관련 코드는 탐사 API가 아래에서 직접 정의한다.

### 2.1 곡선 문맥 `curveContext`

곡선은 단계 번호만으로 식별하지 않는다. 모든 곡선·주기도·제출·잔차 요청은 아래 객체를 주고받는다.

```json
{
  "bundleId": "b-2",
  "curveStep": 1,
  "removedCandidateIds": ["c-401"],
  "residualModelVersion": "rm-1",
  "periodogramConfigVersion": "pg-1"
}
```

| 필드 | 규칙 |
|---|---|
| `bundleId` | 현재 `current` 판. 세션에 고정하지 않으며 요청마다 현재 판과 비교한다(EXP-01) |
| `curveStep` | 0 = 원본, n = 잔차 n단계. `removedCandidateIds.length`와 같아야 한다 |
| `removedCandidateIds` | 서버가 오름차순 정렬·중복 제거한다. 회원이 이 판에서 매칭한 활성 후보만 허용. 누적 매칭 집합과 다르다 |
| `residualModelVersion`, `periodogramConfigVersion` | 판 manifest의 계산 버전. 서버는 응답에 항상 현재 값을 넣고, 요청값이 다르면 `BUNDLE_CHANGED`로 거절한다 |

### 2.2 요청 ID와 멱등

**제출**은 본문 `requestId`(UUID v4)를 필수로 받고 ERD `submissions.request_id UNIQUE`에 저장한다. 이 절의 규칙은 제출 전용이다. 잔차 작업은 `requestId`를 쓰지 않으며 목표 곡선 문맥(캐시 키)이 멱등 단위다(7.1절). 상세 보기는 본문 없이 제출 ID에 대해 멱등이다(6.7절).

| 상황 | 응답 |
|---|---|
| 같은 회원·같은 `requestId`·같은 본문 재전송 | 저장된 결과를 200으로 재현. 새 행·성과·별 열림 없음(SUB-09) |
| 같은 `requestId`·다른 본문 | 409 `IDEMPOTENCY_CONFLICT` |
| 같은 `requestId`가 처리 중 | 409 `REQUEST_IN_PROGRESS`. 프론트는 `GET /submissions/by-request/{requestId}`로 확인 후 같은 ID로 재전송 |
| 응답 유실 | 새 ID를 만들지 말고 위 조회로 복구한다 |

서비스 API는 글·댓글에 요청 키를 두지 않으므로(SB-D17) 요청 ID는 탐사 API의 본문 `requestId`뿐이다(D-1, Q07).

### 2.3 판 교체와 별 잠김

| 코드 | HTTP | 뜻·프론트 처리 |
|---|---|---|
| `IDEMPOTENCY_CONFLICT` | 409 | 같은 `requestId`에 다른 본문. 저장된 결과를 재현하지 않고 거절 |
| `REQUEST_IN_PROGRESS` | 409 | 같은 `requestId`가 처리 중. `GET /submissions/by-request/{requestId}`로 확인 후 같은 ID로 재전송 |
| `BUNDLE_CHANGED` | 409 | 요청의 `bundleId`·계산 버전이 현재 판과 다름. 본문에 `currentBundleId`. 프론트는 EXP-01대로 최신 판을 다시 불러오고 곡선 단계·제거 조합은 유지, 주기·위상은 초기화(AT-117) |
| `GRAPH_TEMPORARILY_UNAVAILABLE` | 503 | 읽기 조회 중 판이 바뀌어 최신 판으로 1회 재시도했는데도 일관된 결과를 못 만듦(8.3절). 서비스 API 7.2절과 같은 코드 |
| `STAR_LOCKED` | 403 | 그 별이 이 회원에게 열리지 않음. 분석·곡선·제출·잔차 모두 거절(NFR-06, AT-64) |
| `STAR_NOT_PUBLISHED` | 404 | `stars.service_status != published` 또는 없는 TIC. 존재를 드러내지 않는다 |
| `STEP_NOT_RESTORABLE` | (안내값) | 오류가 아니라 6.8절·5.1절 응답의 `notice` 값. 제거 조합에 은퇴 후보가 있어 그 조합 그대로는 복원할 수 없을 때, 분석 복귀와 다시 풀기는 그 별의 최신 현재 진행 문맥을 돌려준다. History CURRENT는 별도 규칙에 따라 최신 원본을 사용한다 |
| `CANDIDATE_RETIRED` | 409 | 재도전 대상 신호가 현재 판에서 은퇴함 |
| `CURVE_NOT_READY` | 202 | 잔차가 아직 없음. 본문에 `residual` 상태(5.2절) |
| `RESIDUAL_QUEUE_FULL` | 429 | 대기열 초과. 본문에 `retryAfterSeconds` |
| `VALIDATION_FAILED` | 400 | 입력 검증 실패. `fieldErrors[]`에 위치·사유 |
| `EPOCH_OUT_OF_RANGE` | 400 | 위상 중심을 관측 범위 안의 epoch로 환산할 정수 k가 없음(EXP-06) |
| `DETAIL_UNAVAILABLE` | 409 | 상세 보기 대상 후보가 없음(RES-09) |
| `SKIP_NOT_AVAILABLE` | 409 | 튜토리얼 건너뛰기 조건 미충족(SUB-12) |
| `STAR_ALREADY_COMPLETED` | 409 | 완료된 별에 `no_candidate` 제출(SUB-11 (4)) |

**현재 판 헤더(D-5).** 탐사 API의 모든 응답에 `X-Current-Bundle: {bundleId}` 헤더를 붙인다. 프론트는 잔차 폴링·곡선 응답의 이 값이 분석 진입 때 받은 `bundleId`와 다르면 EXP-01대로 5.1절을 다시 조회한다. 쓰기 요청은 이와 별개로 `BUNDLE_CHANGED`로 거절된다.

### 2.4 잔차 상태 열거형

`QUEUED`, `RESIDUAL_CALCULATING`, `RESIDUAL_READY`, `PERIODOGRAM_CALCULATING`, `COMPLETED`, `FAILED`. 이 순서로만 전이하며 `FAILED`는 어느 계산 단계에서든 갈 수 있다(DAT-14). 조회 응답에서 `status: null`은 "결과도 작업도 없음"을 뜻하는 표현이며 상태 열거형의 값이 아니다(D-14).

### 2.5 단위와 좌표

| 값 | 단위 |
|---|---|
| 시각 `*Btjd` | BTJD 일 단위 실수(float64). UTC로 변환하지 않는다 |
| 주기 `*PeriodDays` | 일 |
| 지속시간 `durationHours` | 시간. ERD `duration_hours`. 계산 내부의 일 단위는 ×24 |
| 위상 `phaseStart`, `phaseEnd` | `0 ≤ phaseStart < 1`, `phaseStart < phaseEnd < phaseStart + 1` |
| 밝기 `flux` | 정규화 상대 밝기. `null`은 결측 |
| 깊이 `depthPpm` | ppm |

위상·epoch·duration 공식은 SRS EXP-06·07을 그대로 쓴다.

```text
phase(t) = (((t - T) / P) mod 1 + 1) mod 1
phaseCenter = ((phaseStart + phaseEnd) / 2) mod 1
epochBtjd = T + (phaseCenter + k) × P, k는 관측 범위 안이면서 |epoch − T| 최소, 동률이면 더 이른 시각
durationHours = (phaseEnd − phaseStart) × P × 24
```

`T`는 판의 `foldReferenceTimeBtjd`다. 브라우저 값은 미리보기이고 서버가 제출 시 같은 식으로 다시 계산한 값만 저장한다.

**C02-R2 결정:** `foldReferenceTimeBtjd`는 세그먼트별 값이 아니라 Bundle 공통값이다. 포함된 모든 세그먼트에서 DAT-02 품질 필터를 통과하고 중복을 제거한 뒤 time·flux가 유한한 원본 관측 시각 전체를 정렬해 중앙값을 구한다. 짝수 표본은 가운데 두 값의 평균을 사용하고 유효 입력이 없으면 Bundle 공개를 실패시킨다. 이 값을 `publication_bundles`에 float64로 한 번 저장하며 세그먼트와 온라인 잔차는 별도 기준을 만들지 않고 그대로 상속한다. 히스토리 재현은 저장된 절대 epoch·duration을 현재 Bundle 공통값으로 다시 위상 변환한다.

## 3. API 목록

| 기능 | 우선 | 메서드·경로 | 근거 | 절 |
|---|---|---|---|---|
| 지도 메타 | P0 | `GET /api/v1/me/sky` | HOME-01·02, NFR-20 | 4.1 |
| 별 지도 타일(월드 경계 상자) | P0 | `GET /api/v1/me/sky/tiles` | HOME-01·05, NFR-20a·d, DEC-30·32 | 4.1 |
| 검색 별 위치 조회 | P1 | `GET /api/v1/me/sky/locate` | HOME-04, NFR-20d | 4.1 |
| 별 상세 패널 | P0 | `GET /api/v1/me/stars/{ticId}` | HOME-05·08, GRD-07 | 4.2 |
| 퀘스트 패널 | P0 | `GET /api/v1/me/quests` | HOME-06·07, CHL-01, DEC-27 | 4.3 |
| 내 별 목록 | P0 | `GET /api/v1/me/stars`, `GET /api/v1/members/{memberId}/stars` | MY-02, HOME-03·04(P1), DEC-34, NFR-18 | 4.4 |
| 공개 별 요약 | P0 | `GET /api/v1/stars/{ticId}` | COM-01·11, NFR-06 | 4.5 |
| 분석 진입·현재 판 | P0 | `GET /api/v1/stars/{ticId}/analysis-context` | EXP-01·02·10 | 5.1 |
| 곡선 (원본·잔차 공용) | P0 | `GET /api/v1/stars/{ticId}/curves` | EXP-03, DAT-11 | 5.2 |
| 주기도 | P0 | `GET /api/v1/stars/{ticId}/periodogram` | EXP-04 | 5.3 |
| 봉우리·미세 조정 범위 | P0 | `GET /api/v1/stars/{ticId}/candidate-peaks` | EXP-05·13, POL-05 | 5.4 |
| 제출 | P0 | `POST /api/v1/stars/{ticId}/submissions` | SUB-01~12, 5장 | 6 |
| 제출 결과 조회 | P0 | `GET /api/v1/submissions/{submissionId}` | RES-01~05·11 | 6.6 |
| 요청 ID로 복구 | P0 | `GET /api/v1/submissions/by-request/{requestId}` | SUB-09 | 6.6 |
| 상세 보기 | P0 | `POST /api/v1/submissions/{submissionId}/detail-view` | RES-02·09, DEC-17 | 6.7 |
| 다시 풀기 초안 | P0 | `GET /api/v1/submissions/{submissionId}/retry-draft` | SUB-10, DEC-18 | 6.8 |
| 잔차 작업 요청 | P0 | `POST /api/v1/stars/{ticId}/residual-jobs` | EXP-09, DAT-14 | 7.1 |
| 잔차 작업 상태 | P0 | `GET /api/v1/residual-jobs/{jobId}` | EXP-09 | 7.2 |
| 히스토리 목록 | P0 | `GET /api/v1/me/histories` | HIS-04, MY-03 | 8.1 |
| 히스토리 상세 | P0 | `GET /api/v1/histories/{historyId}` | HIS-02·06, RES-06 | 8.2 |
| 히스토리 그래프 | P0 | `GET /api/v1/histories/{historyId}/graph` | HIS-03, NFR-03 | 8.3 |
| 별 결과 페이지 | P0 | `GET /api/v1/stars/{ticId}/result` | RES-10 | 8.4 |
| 성과 조회 | P0 | `GET /api/v1/me/achievements` | GRD-01·07, MY-01 | 9.1 |
| 내부: 성과 지급·별 열림 | P0 | 서비스 계층 함수 | GRD-02~04·08, NFR-01 | 9.2 |
| 내부: 완료·재개 | P0 | 제출 트랜잭션·배치 후처리 | SUB-11, DAT-15, DEC-27 | 9.3 |
| 내부: 튜토리얼·챌린지 발견 | P0 | 서비스 계층 함수 | HOME-02·06, CHL-01 | 9.4 |
| 내부: Gold 전환 후처리 | P0 | HTTP 적재 API 없음. Publisher 커밋 후 `bundleId` 알림 소비 | DAT-11·15, DEC-35 | 10 |

## 4. 별 지도·별 상세·퀘스트·내 별 목록

### 4.1 지도 메타와 타일

**자리 좌표(DEC-30, HOME-02, v1.2 변경안).** 서버는 중앙부·나선 팔·제한된 분산으로 회원별 은하 형태가 나타나도록 새 별의 월드 좌표를 계산한다. 부모 별 바깥·부모 각도 근처·다음 세대 반지름 조건을 적용하지 않는다. 알고리즘 계약은 [별지도 표현 계약 1절](../../../docs/development/sky-presentation-contract.md)을 따른다.

~~~text
미발견 TIC 선택 = 기존 OPS-08·성과 지급 규칙
새 위치 = personal-spiral-v1(layoutOrdinal), 회원 잠금 내 안정 순번 배정
INSERT star_unlocks(...발견 경로, world_x, world_y, depth_z, layout_ordinal, layout_version)
응답 x = world_x, y = world_y, depthZ = depth_z (`depthZ`는 단위 없는 정규화 깊이, -1.0 이상 1.0 이하)
~~~

좌표는 저장 후 바꾸지 않는다. 회전·기울기·배율은 프론트 투영이며 서버 좌표와 분리한다. 튜토리얼·챌린지도 열린 별만 배치하고 종류·순서는 marker/퀘스트로 알린다. 현재 보존해야 할 운영 좌표 데이터가 없으므로 종전 방사형 좌표를 유지·이관하지 않는다. 출시 전 개발·테스트 행을 포함한 모든 계정의 열린 별은 같은 은하 배치 함수와 현행 `layout_version`으로 좌표를 생성하며, 한 회원 지도에 방사형 좌표와 은하형 좌표를 섞지 않는다. 기존 `generation`·`angle_deg`·`radius_jitter`는 신규 좌표 계산에 사용하지 않는다. `depthZ`는 -1.0~1.0의 단위 없는 정규화 깊이이며 프론트의 월드 z는 depthZ×256이다. 배치/연출 재현 자료의 검증 벡터를 사용하고 신규 입력 layoutOrdinal은 지도·locate·상세에서 같아야 한다.

**타일(NFR-20d, v1.3 변경안).** 월드 좌표의 정사각 타일(한 변 tileSize)과 공간 인덱스를 유지한다. 모든 배율에서 개별 별을 반환하고 군집 노드로 바꾸지 않는다. 프론트는 각 변에 20% 여백(폭/높이 1.4배)을 둔 뷰포트를 월드 좌표로 역투영한 bbox를 보낸다. 큰 bbox는 상한 이내의 여러 요청으로 나누고 밀집 범위는 cursor로 나누어 받는다. 기존 PoC/구 API의 군집 구조와 직접 호환되지 않는다.

`GET /api/v1/me/sky` — 홈 진입 및 지도 버전 무효화 시 조회.

```json
{
  "representation": "individual-stars",
  "version": "u-101:57",
  "starCount": 57,
  "bounds": {
    "minX": -820,
    "maxX": 1800,
    "minY": -1600,
    "maxY": 805.9
  },
  "tileSize": 512,
  "zoomLevels": [
    {
      "level": 0,
      "scale": 0.25
    },
    {
      "level": 1,
      "scale": 0.5
    },
    {
      "level": 2,
      "scale": 1
    },
    {
      "level": 3,
      "scale": 2
    },
    {
      "level": 4,
      "scale": 4
    }
  ],
  "centerTicIds": [
    "100000001"
  ],
  "firstVisit": false,
  "asOf": "2026-09-15T05:20:00Z",
  "layoutVersion": "personal-spiral-v1",
  "presentationVersion": "personal-galaxy-v1"
}
```

| 필드 | 규칙 |
|---|---|
| `representation` | v1.3 응답 구분값 individual-stars. 구 응답의 누락 값이나 clusters를 빈 지도 정상 응답으로 처리하지 않는다 |
| `layoutVersion` / `presentationVersion` | 메타의 필수 값 personal-spiral-v1 / personal-galaxy-v1. 호환되지 않는 값/누락은 계약 오류로 안내한다. 모든 타일의 순번/좌표가 이 배치 버전에 속한다 |
| `version` | 회원의 발견/상태 갱신 버전. 동일 시각의 여러 변경도 구분하는 단조 증가 개정값. 프론트는 문자열 동등 비교만 한다 |
| `starCount` | 회원의 전체 발견 수. 현재 적재 수·가시 수·범위 수와 다르다 |
| `bounds` | 전체 발견 별의 월드 경계. 카메라 전체 보기의 범위이며 자체에 별 데이터가 없다 |
| `zoomLevels` | level 0부터 연속된 1개 이상의 단계, scale은 양수 오름차순. 예시의 5개는 의무 단계 수가 아니다. 모든 단계는 개별 별이며 clustered 필드는 제거한다. 프론트 연속 줌/표현 상세도와 연결하되 별을 합치지 않는다 |
| `firstVisit` | user_settings.onboarding_done의 반대값 |
| `asOf` | 응답을 만든 서버 UTC 시각. 데이터 동일성은 version으로 검증하며 시각만으로 버전을 추정하지 않는다 |

구 overview 군집 배열은 제거한다. 메타 뒤에 초기 카메라 범위의 타일을 요청한다. 첫 표시를 위해 메타에 전체 별을 포함하지 않는다. 히트 테스트·호버 인덱스와 GPU 일괄 그리기는 클라이언트 구현이다.

**첫 방문 안내(HOME-09).** 서버가 갖는 상태는 `onboarding_done` 하나다. 말풍선 단계(별 선택 → 봉우리 → 구간 → 판단 → 제출)의 진행은 브라우저 세션 상태이며 서버에 저장하지 않는다. 완료로 저장하는 시점은 **튜토리얼 1번 별의 첫 제출이 성공했을 때**(6.3절 트랜잭션에서 서버가 `onboarding_done=true`) 또는 사용자가 안내를 닫았을 때(서비스 API의 설정 변경)이며, 별을 클릭한 것만으로 끝내지 않는다. 마이페이지 [사용법 다시 보기]는 GIF+텍스트 5단계를 읽는 별도 화면이다. `onboarding_done`을 변경하지 않고 설정 PATCH·분석 세션 생성·제출·성과 지급·별 발견을 호출하지 않는다. 서비스 API 3.1절의 true만 허용하는 완료 규칙을 유지한다. `tutorialCompleted`(튜토리얼 5개 완료)와는 다른 값이다.

`GET /api/v1/me/sky/tiles?level=2&x=600&y=-1000&w=350&h=450&version=u-101:57&limit=1000`

| 쿼리 | 필수 | 뜻 |
|---|---|---|
| `level` | 예 | 배율 단계(0 = 최대 축소). `zoomLevels`의 값 |
| `x`, `y`, `w`, `h` | 예 | 요청 범위의 월드 좌표 경계 상자. 프론트가 각 변 20% 여백과 깊이 [-1,1] 전체를 z=depthZ×256으로 환산한 공통 카메라로 역투영한다. `w`·`h` 상한은 `tileSize × 64` |
| `version` | 예 | 지도 메타의 version. 다르면 아래 버전 변경 응답으로 재시작을 요구한다 |
| `limit` | 아니오 | 한 페이지 별 수. 기본 1000, 1~2000 정수. 전송 분할 상한이며 화면 별 수·성능 인수 예산이 아니다 |
| `cursor` | 아니오 | 첫 페이지는 생략. 다음은 nextCursor를 그대로 사용하며 회원·version·level·bbox·limit를 바꾸지 않는다 |

단계 수와 scale을 하드코딩하지 않는다. 모든 level은 같은 회원의 실제 개별 별을 제공하며 배율이 낮아도 생략·군집화하지 않는다.

```json
{
  "representation": "individual-stars",
  "version": "u-101:57",
  "level": 2,
  "versionChanged": false,
  "bounds": {
    "x": 512,
    "y": -1024,
    "w": 512,
    "h": 512
  },
  "rangeStarCount": 1,
  "stars": [
    {
      "ticId": "123456789",
      "x": 704.172009167,
      "y": -935.042108582,
      "depthZ": -0.05916475342,
      "planetCount": 2,
      "progressStage": "in_progress",
      "completedWithoutPlanets": false,
      "marker": null,
      "reopened": false,
      "layoutOrdinal": 7
    }
  ],
  "nextCursor": null,
  "asOf": "2026-09-15T05:20:00Z"
}
```

`bounds`는 요청 bbox를 타일 격자에 맞춰 넓힌 실제 응답 범위다. 왼쪽/아래 경계는 포함하고 오른쪽/위 경계는 제외한다. 응답의 모든 별 좌표는 이 범위 안이다. 같은 요청의 모든 페이지에서 bounds와 rangeStarCount는 같다. 겹친 bbox/타일 응답은 회원+version+ticId로 중복 제거한다. rangeStarCount는 해당 범위 전체 발견 수이며 stars.length는 이번 페이지 수다. nextCursor=null일 때만 해당 범위가 끝난다.

| 필드 | 규칙 |
|---|---|
| `planetCount` | HOME-05: 맞춘 확정 행성 + "행성 같음"으로 판단한 미확정. `user_star_progress.planet_count` |
| `layoutOrdinal` | 저장한 회원별 안정 순번 0~2147483647. 전송 배열 순서나 현재 별 수가 아니다. personal-galaxy-v1 색·기준 크기의 시드 입력이며 새로고침/페이지 순서로 바뀌지 않는다 |
| `completedWithoutPlanets` | `progress_stage=completed`이고 `planet_count=0`. HOME-05 "행성으로 표시할 신호 없이 탐색 완료". FP 성과 여부(`fp_success`)와 무관하며, 미확정 UNSURE 판단·FP 오판으로 완료된 별도 포함한다(지웅 리뷰 7) |
| `marker` | `{"type":"tutorial","seq":n}` 또는 null. 챌린지 빨간 느낌표는 싣지 않는다. 느낌표는 발견 경로와 무관하게 진행 회차의 대상 별에 붙고, 회차 전환·종료는 회원 `version`을 바꾸지 않아 타일에 실으면 갱신되지 않는다. 프론트는 퀘스트 `challenge.ticId`(4.3절)로 그린다. 발견 경로는 상세 `unlock.reason`·목록 `unlockReason`이 알린다. 튜토리얼 번호 숨김(HOME-05)은 퀘스트 튜토리얼 칸의 `completed`를 기준으로 한다(재개돼도 유지) |
| `reopened` | `reopened_at`이 있고 아직 새 제출이 없음. 퀘스트 "다시 열린 별" 카드와 같은 기준 |
| 삭제 필드 | 지도 타일의 colorLevel·sizeLevel·orbits는 v1.3 최종 표현안에서 제거한다. 전체 지도는 행성/궤도를 그리지 않고 내 행성은 선택 상세의 planets.items에서만 받는다. 클라이언트는 이 구 필드를 요구하거나 기본값으로 상태 색을 복원하지 않는다 |

**페이지·동시 변경 규칙.** stars는 ticId의 숫자값 오름차순으로 안정 정렬하고 불투명 cursor를 사용한다. cursor는 인증 회원·version·level·원 요청 bbox·limit에 묶는다. 같은 버전에서 반복 요청은 같은 집합을 반환한다. 잘못된/다른 범위 cursor는 400 VALIDATION_FAILED이며 다른 회원 자료를 노출하지 않는다. 클라이언트는 cursor를 만들거나 해석하지 않는다. 정상 페이지에 clusters/nodeId/counts 필드는 없다.

요청 version이 현재 회원 버전과 달라지면 기존 cursor를 새 데이터에 적용하지 않고 다음과 같이 응답한다. 이 stars 빈 배열은 빈 지도나 범위 적재 완료를 뜻하지 않는다. 프론트는 이전 cursor를 폐기하고 메타를 재조회한 뒤 현재 가시 범위를 첫 페이지부터 요청한다. 변경 전 정상 화면은 갱신 중 표시와 함께 유지할 수 있지만 서로 다른 버전의 데이터를 합치지는 않는다.

```json
{
  "representation": "individual-stars",
  "version": "u-101:58",
  "level": 2,
  "versionChanged": true,
  "stars": [],
  "nextCursor": null,
  "asOf": "2026-09-15T05:21:00Z"
}
```

서버는 회원 version 확인과 페이지/범위 집계 읽기를 같은 일관된 DB 스냅샷에서 수행한다. 응답 전에 version이 바뀌어 기존 페이지를 현재 버전인 것처럼 내보내지 않는다. 이전 스냅샷을 cursor 수명 동안 보존할 의무는 없고 버전 변경 시 재시작한다. 새 별/표시 상태 변경 시 영향받은 타일 캐시·인덱스와 회원 version을 갱신한다. 공간 인덱스의 물리 구현·실행 계획은 ERD 항목 8에서 검증한다. 서버/웹 워커 어디에서도 여러 별을 대표 노드로 합쳐 응답·표시하지 않는다. 회전·기울기는 저장 좌표에 영향을 주지 않고 미발견 별은 모든 단계에서 제외한다.

프론트는 페이지 수신 중 로딩/부분 실패와 재시도를 제공한다. 페이지가 남았는데 완성된 은하 또는 별 없음으로 표시하지 않는다. 동일 범위의 최종 중복 제거 수가 rangeStarCount와 다르면 계약 오류로 처리한다. 로그아웃·회원 전환은 요청 취소와 회원 캐시 제거, 카메라/버전 변경은 늦은 이전 응답 폐기를 수행한다. 전송 범위/limit 상한을 화면 별 수 제한으로 사용하지 않는다.

**최신성과 무효화(D-7).** 제출(6.4절)·공개 등록(서비스 API)·재개(9.3절) 응답에는 처리 후의 `skyVersion`을 넣는다. 프론트는 이 값이 마지막으로 받은 `version`과 다르면 `GET /me/sky`를 다시 받고 화면 안 범위의 타일만 재요청한다. 늦게 도착한 이전 `version`의 타일 응답은 버린다. 서버는 `version`을 회원 단위로 관리하며 다른 회원의 행동으로는 바뀌지 않는다.

`GET /api/v1/me/sky/locate?ticId=123456789` — P1. 검색·필터(HOME-04)로 고른 별이 아직 받지 않은 범위에 있을 때 카메라를 옮기기 위한 조회. 발견한 별만 허용하며 미발견 별은 `STAR_LOCKED`.

```json
{
  "ticId": "123456789",
  "x": 704.172009167,
  "y": -935.042108582,
  "depthZ": -0.05916475342,
  "level": 2,
  "bounds": {
    "x": 512,
    "y": -1024,
    "w": 512,
    "h": 512
  },
  "layoutOrdinal": 7,
  "layoutVersion": "personal-spiral-v1",
  "version": "u-101:57"
}
```

**실패:** 회원의 별이 0개(가입 직후 튜토리얼 1번 열림 전)는 없다. 가입 처리가 튜토리얼 1번을 연다(9.4절). 경계 상자가 유한하지 않거나 상한을 넘으면 400 `VALIDATION_FAILED`, 잘못된 `level`은 400.

### 4.2 선택한 별·내 행성 상세

`GET /api/v1/me/stars/{ticId}` — 별 선택 시 같은 캔버스의 근접 뷰·도킹 패널·행성 목록에서 공유한다. 인증 회원의 발견한 별만 허용하며 미발견 별은 `STAR_LOCKED`. 별도의 NASA iframe이나 전체 카탈로그 행성 API로 대체하지 않는다.

```json
{
  "ticId": "123456789",
  "asOf": "2026-09-15T05:20:00Z",
  "star": {
    "sectorCount": 3,
    "sectors": [
      14,
      41,
      54
    ],
    "tmag": 9.8,
    "teffK": 5600,
    "radiusRsun": 0.95
  },
  "unlock": {
    "reason": "achievement",
    "triggerTicId": "100000002",
    "triggerAchievementId": "ach-31",
    "unlockedAt": "2026-09-09T03:00:00Z",
    "position": {
      "x": 704.172009167,
      "y": -935.042108582,
      "depthZ": -0.05916475342,
      "layoutVersion": "personal-spiral-v1",
      "layoutOrdinal": 7
    }
  },
  "progress": {
    "stage": "in_progress",
    "currentCurveStep": 1,
    "completionReason": null,
    "reopenPending": false,
    "reopenedAt": null,
    "completedAt": null
  },
  "planets": {
    "count": 2,
    "completedWithoutPlanets": false,
    "items": [
      {
        "candidateId": "c-401",
        "kind": "confirmed",
        "periodDays": 3.0021,
        "depthPpm": 1450
      },
      {
        "candidateId": "c-402",
        "kind": "unconfirmed",
        "periodDays": 11.8,
        "depthPpm": 380
      }
    ]
  },
  "achievement": {
    "count": 2,
    "grade": "S",
    "byType": {
      "confirmed": 1,
      "unconfirmed": 1,
      "fp": 0
    }
  },
  "marker": null,
  "actions": {
    "analysis": "continue",
    "resultAvailable": true,
    "boardOpen": true,
    "threadCount": 1
  },
  "version": "u-101:57",
  "presentationVersion": "personal-galaxy-v1"
}
```

| 필드 | 규칙 |
|---|---|
| `unlock.position` | `x`·`y`·`depthZ`·`layoutOrdinal`·`layoutVersion`은 같은 회원/TIC의 저장 값을 반환하는 필수 필드다. 지도 타일·위치 찾기·별 상세·근접 뷰에서 값이 같아야 한다. x/y는 서비스 월드 좌표 단위, depthZ는 -1.0~1.0 정규화 깊이(렌더 월드 z=depthZ×256), layoutOrdinal은 회원별 안정 정수 0~2147483647이며 배열 인덱스가 아니다 |
| `version` / `presentationVersion` | 필수 문자열. version은 해당 본인 상세를 읽은 회원별 지도 버전이며 메타·타일과 같은 의미의 불투명 값이다. presentationVersion은 personal-galaxy-v1이다. 상세·진행·개인 행성은 한 DB 스냅샷에서 읽는다 |
| `star.tmag` / `star.teffK` / `star.radiusRsun` | TESS 등급(무차원), 유효 온도(K), 반지름(태양=1). 본인 상세는 셋을 모두 준다(D-18). 카탈로그에 값이 없으면 필드를 빼지 않고 `null`을 보낸다. 프론트는 `중심 위치: 데이터 없음`과 같은 방식으로 비활성 표시한다(AT-93) |
| `star.*` 공통 | 확정 행성 보유 여부·후보 수는 절대 넣지 않는다(HOME-04, AT-03). 물리값은 TESS 카탈로그 공개 값이며 비공개 대상이 아니다 |
| `planets.items` | 현재 인증 회원이 요청 TIC에서 수치 매칭한 고유 candidateId 중 HOME-05 표시 조건을 만족하는 목록. 확정 행성은 판단 오답/성과 미인정이어도 포함, 미확정은 6.3절의 회원별 후보 최신 판단이 LIKELY_PLANET일 때만 포함(공개/성과 인정 필수 아님). FP·미확정 UNLIKELY_PLANET/UNSURE·미매칭·타인 발견·전체 후보표는 제외. 같은 candidateId 중복 없음 |
| `planets.count` | 이 응답은 행성 목록을 페이지/4개 상한으로 자르지 않는다. count=items.length이며 같은 version의 지도 planetCount·user_star_progress.planet_count와 일치. achievement.count나 별의 외부 카탈로그 행성 수를 대신 쓰지 않음 |
| `planets.items[].candidateId` | 행성 객체·목록·확대 선택의 공통 문자열 식별자. items는 이 문자열의 오름차순으로 안정 정렬한다. 배열 인덱스/표시 순번을 ID로 쓰지 않음 |
| `planets.items[].kind` | confirmed / unconfirmed. 사용자는 "확인된 행성" / "아직 확인되지 않은 후보"로 읽는다. FP enum은 이 배열에 없음 |
| `planets.items[].periodDays` | 반복 주기, 일 단위. 매칭 신호의 값이며 사용자 입력값이나 애니메이션 속도를 반환하는 필드가 아님 |
| `planets.items[].depthPpm` | 어두워진 정도, ppm. 퍼센트로 보일 때 depthPpm / 10000 (1450ppm = 0.145%) |
| `planets.completedWithoutPlanets` | 진행 완료이며 표시할 내 행성이 0개인 상태. 외계행성이 실제로 없다는 증거가 아님 |
| `achievement.grade` | `count` 1/2/3/4 이상 → A/S/SS/SSS, 0이면 null. 열이 아니라 계산값(GRD-01) |
| `actions.analysis` | `start`(제출 없음) / `continue`(진행 중) / `review`(완료). 재개 별은 `continue` |
| `actions.boardOpen` | 한 명 이상 발견한 별이면 true(COM-01). 스레드 목록은 서비스 API |
| `actions.resultAvailable` | 그 회원의 제출 이력이 하나라도 있으면 true. 결과 페이지는 제출 이력이 있는 별마다 열린다(RES-10) |
| `actions.threadCount` | 이 별의 공식 신호 스레드 수. 숨김·삭제는 세지 않는다 |
| `star.sectorCount` / `star.sectors` | 관측 회차를 중복 없이 오름차순으로 준다. 같은 회차가 여러 `source_version`으로 들어올 수 있어 `sectorCount`는 행 수가 아니라 서로 다른 회차의 수다 |

**시각화와 실패 처리(HOME-05·08 v1.2).** 위의 기존 items 필드가 개별 행성 정보의 필수 계약이다. 외부 이름·행성 반지름·질량·공전 거리·표면 텍스처는 현재 계약에 없으며 임의 실측값으로 만들지 않는다. 숫자 정보가 null이면 "정보 없음"으로 표시하고 0으로 치환하지 않는다. 시각화의 표면·연출 색·크기와 선택 근접 뷰 간격·속도는 실제 사진/축척이 아닌 서비스 연출임을 안내한다. candidateId를 키로 같은 행성의 외형을 안정적으로 유지한다.

0개 응답은 `planets: {"count": 0, "completedWithoutPlanets": false, "items": []}` 형태이며 진행 완료라면 completedWithoutPlanets만 true가 된다. 로딩/실패와 0개를 구분하고 재시도·은하 복귀를 제공한다. 응답 count/items 불일치·중복 ID는 계약 오류로 처리하며 부족한 수만큼 임의 행성을 생성하지 않는다. A 별 요청 뒤 B 별을 선택했을 때 A의 늦은 응답을 무시한다. 상세는 필수 version/presentationVersion을 반환한다. 지도와 version이 다르면 이전 상세를 그대로 합치지 않고 메타/타일/상세를 최신 버전으로 재조회한다. asOf만으로 같음을 판단하지 않는다. 행성 선택은 이미 받은 items에서 처리하며 별도 행성 상세 API를 신설하지 않는다. [별지도 표현 계약 3절](../../../docs/development/sky-presentation-contract.md)과 AT-120~122를 따른다.

### 4.3 퀘스트 패널

`GET /api/v1/me/quests` — 홈 진입·별 상태 변경 후.

```json
{
  "asOf": "2026-09-11T05:20:00Z",
  "tutorial": {
    "completedCount": 2,
    "items": [
      {"seq": 1, "intent": "deep_confirmed", "status": "completed", "ticId": "100000001", "completionReason": "all_found"},
      {"seq": 2, "intent": "shallow_confirmed", "status": "completed", "ticId": "100000002", "completionReason": "skipped"},
      {"seq": 3, "intent": "fp", "status": "in_progress", "ticId": "100000003", "completionReason": null},
      {"seq": 4, "intent": "deep_fp", "status": "locked", "ticId": null, "completionReason": null},
      {"seq": 5, "intent": "multi_fp", "status": "locked", "ticId": null, "completionReason": null}
    ]
  },
  "challenge": {
    "round": {"roundId": "cr-901", "roundNo": 1, "startsOn": "2026-09-07", "endsOn": "2026-09-14",
              "description": "밝기 변화가 얕은 별에서 두 번째 신호를 찾아보세요"},
    "eligible": false, "ticId": null, "unlocked": false, "progressStage": null, "participantCount": 12
  },
  "reopened": [{"ticId": "123456780", "reopenedAt": "2026-09-10T18:00:00Z", "newDiscoverableCount": 1}]
}
```

- 튜토리얼 `status`: `locked`(미발견) / `unlocked`(발견, 제출 없음. 진행 단계 `unexplored`) / `in_progress` / `completed`. `ticId`는 열린 순번에만 준다(AT-57). `completionReason`은 `completed` 칸에만 준다. 학습 목적 문구는 `intent`를 프론트가 용어 사전으로 바꾼다.
- 튜토리얼은 **한 번 완료하면 완료로 남는다.** 진행 단계가 `completed`이거나 `completed_at`이 있으면 완료한 칸이다. 새 판에서 별이 재개돼 진행 단계가 `in_progress`로 돌아가도(9.3절, `completed_at` 유지) 칸은 `completed`로 두고 그 별은 `reopened`에 따로 나온다. 진행 단계만 보면 이미 받은 챌린지 별은 남는데 튜토리얼 완료와 다음 회차 자격이 풀려 서로 어긋난다.
- `completedCount`는 사용 중인(`active`) 튜토리얼 별 중 완료한 칸의 수다. `GET /me`의 `tutorialCompleted`와 챌린지 `eligible`은 이 값이 5인지로 판정한다(11.1절). 운영 중 튜토리얼 별을 바꾸지 않는다는 전제이며, 바꾸면 이미 끝낸 회원이 미완료로 돌아간다(S15P21C206-139).
- 챌린지 회차는 서비스 API `GET /challenges/current`와 같은 원천이며, 여기서는 회원의 발견·진행 상태를 덧붙인다. `description`은 `challenge_rounds.description`(ERD v1.1). `participantCount`는 **대상 별 공식 신호 스레드의 유효 공개 분석 참여자 수**(COM-14 (1)의 N, 회원당 1건, SRS v1.1 안건 15)이며 F16과 같은 유효 공개 분석 원천을 사용한다. 대상 별의 모든 공식 신호 스레드에서 회원 ID를 중복 제거한다(COUNT DISTINCT). 한 회원이 여러 신호에 참여해도 1명이며 스레드별 N을 합산하지 않는다. 공개 취소·숨김 후 다른 유효 공개 분석이 남으면 포함하고 하나도 없으면 제외한다. 핫 토픽·판단 분포는 기존 신호별 집계를 유지한다. 대상 별에 공식 스레드가 아직 없으면 0이다. `ticId`는 회원에게 열린 경우에만 준다.
- `roundId`는 `cr-{challenge_rounds.id}`다. `eligible`은 진행 회차가 있고 튜토리얼 5개를 완료했을 때 true다. `ticId`는 지도 빨간 느낌표(CHL-01)의 원천이다. 대상 별을 다른 경로로 먼저 발견한 회원에게도 같게 주고, 회차가 끝나면 사라진다. 지도·상세의 `marker`에는 챌린지를 싣지 않는다(4.1절). `progressStage`는 대상 별이 열린 경우 그 별의 진행 단계(진행 행이 없으면 `unexplored`)이고 아니면 null이다. 진행 회차가 없으면 필드를 빼지 않고 `{"round": null, "eligible": false, "ticId": null, "unlocked": false, "progressStage": null, "participantCount": null}`을 준다.
- 이 조회는 발견 상태를 바꾸지 않는다. 자격이 있는데 대상 별이 아직 열리지 않았어도 여기서 열지 않는다. 열기는 9.4절의 튜토리얼 완료 처리와 회차 전환 명령이 맡는다.
- `reopened`는 DEC-27 "다시 열린 별" 카드. 4.4절 `reopened`와 같은 조건(`reopened_at` 이후 새 제출 없음)이며 최근에 다시 열린 순서다. 새 제출이 생기면 빠진다. `newDiscoverableCount`는 재개 이벤트를 저장하는 곳이 정해질 때까지(S15P21C206-150) `null`이며 0으로 채우지 않는다.

### 4.4 내 별 목록

`GET /api/v1/me/stars?scope=submitted|discovered&sort=recent&stage=&grade=&ticId=&cursor=&size=20`
`GET /api/v1/members/{memberId}/stars?...` (타인. `user_settings.star_list_public=false`면 403 `STAR_LIST_PRIVATE`)

```json
{
  "items": [
    {"ticId": "123456789", "progressStage": "in_progress", "planetCount": 2, "completedWithoutPlanets": false,
     "achievementCount": 2, "grade": "S", "currentCurveStep": 1, "reopenPending": false, "reopened": false,
     "unpublishedSignalCount": 1, "lastActivityAt": "2026-09-10T02:30:00Z", "unlockReason": "achievement",
     "marker": null}
  ],
  "nextCursor": null, "hasNext": false
}
```

- `scope=submitted`(기본)는 발견한 별 중 제출 이력이 있는 별(MY-02). 옛 "내 진행" 화면(HOME-03)을 이 목록이 대체한다. `scope=discovered`는 제출 이력이 없는 발견 별까지 전부 포함하며 본인 조회에서만 허용한다. `sort=recent`는 `lastActivityAt` = 최근 제출·재개·발견 시각 내림차순, 동률 `ticId`.
- `unpublishedSignalCount`는 본인 조회에서만 있고 타인 조회는 필드를 뺀다(NFR-14).
- 필터 `stage`, `grade`, `ticId`는 HOME-04(P1). 확정 행성 보유 여부로는 필터하지 않는다.
- WebGL 대체 목록 뷰(NFR-18)는 `scope=discovered&sort=recent`를 쓴다. 성과로 막 발견해 아직 제출하지 않은 별도 목록에서 골라 분석에 진입할 수 있어야 하기 때문이다(지웅 리뷰 6). 마이페이지는 기본값을 유지한다.
- `size`는 기본 20, 상한 100이다. 상한 밖이거나 계약 밖 `scope`·`sort`는 400 `VALIDATION_FAILED`다. 타인 조회에 `scope=discovered`를 쓰면 같은 400으로 거절한다. 미제출 발견까지 보이면 그 회원의 진행 상태가 드러나기 때문이다.
- `cursor`는 불투명 값이며 **요청 회원·대상 회원·`scope`·`sort`·`size`**에 묶는다. 하나라도 다르면 400이다. 요청 회원까지 묶는 이유는 같은 대상이라도 보는 사람에 따라 응답이 다르기 때문이다(`unpublishedSignalCount`). 위치는 `lastActivityAt`과 `ticId`를 함께 담는다. 시각만 담으면 같은 시각의 별들이 페이지 경계에서 통째로 밀리거나 빠진다.
- `unpublishedSignalCount`는 회원이 이 별에서 매칭한 고유 신호 중 유효한 공개가 없는 수다. 타인 조회에서는 0이 아니라 **필드를 뺀다**. "공개하지 않은 신호가 없다"와 "볼 수 없다"는 다른 뜻이다.

### 4.5 공개 별 요약

`GET /api/v1/stars/{ticId}` — 별 게시판 헤더, 게시글의 [이 별 분석하기] 버튼, 출처 카드가 쓴다. 발견하지 않은 회원도 호출할 수 있다. 서비스 API가 게시판 열람 자격(COM-01)과 분석 진입 버튼 활성(COM-11)을 이 응답으로 판정한다.

```json
{
  "ticId": "123456789",
  "star": {"sectorCount": 3, "sectors": [14, 41, 54], "tmag": 9.8},
  "boardOpen": true,
  "unlockedForMe": false,
  "analysisAvailable": false,
  "currentBundleId": "b-2",
  "discoveredMemberCount": 12
}
```

| 필드 | 규칙 |
|---|---|
| `currentBundleId` | 현재 판. `published` 별에는 판이 있어야 하지만 없으면 `null`을 준다. 게시판 헤더는 판 없이도 떠야 하고, 분석 진입(5.1)이 그 자리에서 503으로 막는다 |
| `boardOpen` | `star_unlocks`에 그 TIC 행이 하나 이상. false면 서비스 API가 목록·검색·직접 URL에서 게시판을 숨긴다(AT-65) |
| `unlockedForMe`, `analysisAvailable` | 요청 회원의 발견 여부. 둘은 같은 값이지만 의미를 분리해 둔다. false면 [이 별 분석하기]를 비활성으로 표시하고 서버도 5.1절에서 거절한다(AT-64) |
| `star` | `sectorCount`·`sectors`·`tmag`만 준다. 이 응답은 게시판 헤더·[이 별 분석하기] 버튼·출처 카드가 쓰는 요약이라 온도·반지름을 놓을 자리가 없다. **감추는 것이 아니다** — 셋 다 TESS 카탈로그 공개 값이고 본인 상세(4.2)는 모두 준다. 소비 화면이 필요로 하면 그때 넓힌다(D-18) |
| `discoveredMemberCount` | 표시용. 후보 수·확정 보유 여부·타인의 진행 상태는 넣지 않는다 |

`service_status != published`이거나 `boardOpen=false`인 별은 404 `STAR_NOT_PUBLISHED`로 존재를 드러내지 않는다. 게시글에서 분석으로 넘어갈 때의 `return_post_id`는 URL·임시 세션에만 두고 Submission·AnalysisHistory에 저장하지 않으며(NFR-15), 복귀 시 Post의 TIC·공개 상태 재검사는 서비스 API가 한다(EXP-10, AT-50).

## 5. 분석 진입과 데이터

### 5.1 분석 진입·현재 판

`GET /api/v1/stars/{ticId}/analysis-context` — 분석 화면 진입, 통신 오류 복구, `BUNDLE_CHANGED` 후 재로드.

서버 검사 순서: 인증 → `stars.service_status=published` → 회원의 `star_unlocks` 존재 → `current` 판 조회. 하나라도 실패하면 곡선·후보 정보를 내려주지 않는다(EXP-01, NFR-06).

```json
{
  "ticId": "123456789",
  "star": {"sectorCount": 3, "sectors": [14, 41, 54], "tmag": 9.8},
  "hasConfirmedCandidate": true,
  "bundle": {
    "bundleId": "b-2", "bundleVersion": "v7", "publishedAt": "2026-09-09T20:00:00Z",
    "foldReferenceTimeBtjd": 1683.4231, "baseDays": 81.4,
    "observationBounds": [1683.35, 2570.12],
    "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1", "binningRevision": 1,
    "curveStepRule": "one_candidate_per_step"
  },
  "selectionRules": {
    "version": "sel-1",
    "minWindowDays": 0.0139, "phaseWidthMax": 0.25,
    "maxDurationMultipleOfSuggested": 3, "allowEmptyPhaseSpan": false,
    "fineTune": {"halfWidthCells": 3}
  },
  "progress": {"stage": "in_progress", "currentCurveStep": 1, "matchedCandidateIds": ["c-401"],
               "completionReason": null, "reopenPending": false, "achievementCount": 1, "grade": "A"},
  "currentCurveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                          "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "residualForCurrentStep": {"status": "COMPLETED", "jobId": null},
  "nextCurveContext": {"bundleId": "b-2", "curveStep": 2, "removedCandidateIds": ["c-401", "c-402"],
                       "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "residualForNextStep": {"status": "QUEUED", "jobId": "rj-78"},
  "tutorial": {"seq": null, "skipAvailable": false},
  "ruleVersion": "rule-3"
}
```

| 필드 | 규칙 |
|---|---|
| `bundle.bundleId` | DB `publication_bundles.id`를 `b-<id>` 문자열로 표현한다. 요청·응답·`X-Current-Bundle`에서 같은 값을 쓴다 |
| `bundle.bundleVersion` | DB `bundle_version`과 같은 문자열이다. 숫자로 암묵 변환하지 않는다 |
| `hasConfirmedCandidate` | EXP-02: 후보표에 실제로 있는 `is_confirmed` 후보가 있는지만. 개수·이름·주기는 없음(AT-03) |
| `selectionRules` | 최소 폭은 **시간**으로 준다: `minWindowDays` = 그 별 최소 케이던스의 2배(SRS 5.1 최소 허용 창). 위상 최소 폭은 주기에 따라 달라지므로 프론트·서버가 현재 주기로 `minWindowDays / periodDays`를 계산한다. `maxDurationMultipleOfSuggested=3`은 C02-R3 선택 폭 상한이고 `phaseWidthMax`는 공통 위상 상한이다. `allowEmptyPhaseSpan`은 미결 4(Q03). `fineTune.halfWidthCells`는 어떤 주기든 미세 조정 범위를 주기도 격자 ±N칸으로 계산하는 규칙(5.4절). 서버 검증도 같은 값을 쓴다 |
| `progress.currentCurveStep` | 회원의 `user_star_progress.current_curve_step` = **마지막 제출의 곡선 단계**. 제출 트랜잭션에서만 갱신하며 브라우저 저장소로 대체하지 않는다(NFR-19) |
| `currentCurveContext` | 마지막 제출 단계의 문맥. 제출이 없으면 원본(step 0). 판 전환으로 저장된 조합에 은퇴 후보가 생기면 **현재 판에서 회원이 매칭한 활성 후보 전체를 제거한 현재 진행 문맥**으로 대체하고 `notice: "STEP_NOT_RESTORABLE"`을 붙인다. 예: 옛 `{A,B}`, B 은퇴, 현재 진행 `{A,C}`이면 `{A,C}`, step 2다(C02-R1, Q09) |
| `nextCurveContext` | 이 판에서 회원이 매칭한 활성 후보 전체를 제거한 문맥(`curveStep` = 그 수). 남은 탐색 가능 신호가 없으면 null. [다음 곡선]의 기본 대상 |
| `residualForCurrentStep`, `residualForNextStep` | 각 문맥의 잔차 캐시 상태. `curveStep=0`이면 `COMPLETED` 고정 |
| `tutorial.skipAvailable` | SUB-12 조건 충족 여부. `tutorial_skip_after=0`이면 항상 false |

미제출 초안(주기·위상·판단·표시 범위)은 서버가 저장하지 않는다. EXP-10의 복원은 브라우저 임시 저장이며, 복원할 때 이 API로 판·단계가 같은지 확인한다(Q05).

**C02-R1 결정(2026-09-14):** 분석 복귀와 다시 풀기는 최신 현재 진행 문맥을 사용한다. History CURRENT는 HIS-03대로 최신 원본 곡선으로 대체하고, History SUBMITTED는 당시 snapshot을 유지한다. 세 경로의 기대 배열은 [공통 은퇴 사례](exploration-contract-review.md)에 고정했다.

**실패:** `STAR_LOCKED`, `STAR_NOT_PUBLISHED`. `current` 판이 없으면 503 `DEPENDENCY_UNAVAILABLE`(배치 미공개 별은 published가 아니어야 하므로 정상 운영에서는 없다).

### 5.2 곡선 (세그먼트 DTO)

`GET /api/v1/stars/{ticId}/curves?bundleId=b-2&curveStep=1&removed=c-401`

원본(`curveStep=0`, `removed` 없음)과 잔차 단계가 같은 형식이다. 히스토리 그래프(8.3절)·서비스 API의 첨부·공개 분석 그래프도 이 DTO를 쓴다.

```json
{
  "ticId": "123456789",
  "bundleId": "b-2",
  "foldReferenceTimeBtjd": 1683.4231,
  "curveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "residual": {"status": "COMPLETED", "jobId": "rj-77", "computedAt": "2026-09-10T02:31:10Z"},
  "fluxUnit": "normalized",
  "segments": [
    {"segmentId": "seg-1", "sector": 14, "binningRevision": 1,
     "startBtjd": 1683.35, "binMinutes": 10, "nPoints": 3900,
     "flux": [1.0001, 0.9998, null, 1.0003],
     "fluxScatter": 0.0012,
     "gaps": [[120, 135], [2010, 2044]]},
    {"segmentId": "seg-2", "sector": 41, "binningRevision": 1,
     "startBtjd": 2419.99, "binMinutes": 10, "nPoints": 3820,
     "flux": [0.9999, 1.0002], "fluxScatter": 0.0011, "gaps": []}
  ]
}
```

| 규칙 | 근거 |
|---|---|
| i번째 점의 시각 = `startBtjd + (binMinutes / 1440) × i`. 시각 배열은 보내지 않는다 | ERD `light_curve_segments` |
| 결측은 `null`, `gaps`는 `[시작 인덱스, 끝 인덱스]` 폐구간. JSON `NaN`은 쓰지 않는다 | Q04 |
| 세그먼트는 섹터 순 정렬. 섹터 사이 공백은 세그먼트 경계로 표현하고 프론트가 접어 그린다 | EXP-03, NFR-10 |
| `binMinutes`는 세그먼트마다 다를 수 있다(20,000점 초과 시 확대) | DAT-11 |
| `fluxScatter`는 세그먼트당 하나. 점별 오차 배열은 없다 | ERD |
| 잔차 단계의 `flux`는 같은 격자·같은 `startBtjd`에서 통과 모델을 나눈 값. 원본과 점 수·인덱스가 같다 | DAT-11·14 |
| 응답 크기: 별당 약 70KB(비닝 후). 바이너리 전송은 D-2 | ERD 용량표 |
| 잔차는 원본 세그먼트와 제거 후보의 `transit_model`·`residualModelVersion`으로 언제든 다시 만들 수 있다. 저장물이 아니라 온라인 계산 결과다 | NFR-05, DEC-22 |
| 판별 도구(홀짝·2차 식·V/U형, EXP-11)는 이 곡선 전 점으로 브라우저가 계산한다. 단계형 화면 상태(EXP-12)는 프론트 소유 | Q12 |

**잔차가 준비되지 않았을 때:** 202 `CURVE_NOT_READY`, `segments: null`을 반환한다. 결과와 작업이 모두 없으면 `residual: {"status": null, "jobId": null}`로 미계산을 표시하며 폴링하지 않는다. 실제 작업이 있을 때만 해당 상태와 실제 jobId를 반환한다(예: `{"status":"QUEUED","jobId":"rj-78"}`). 조회는 작업을 자동 생성하지 않는다. 본인 탐사 화면에서는 기존 권한 검증을 거쳐 7.1절로 계산을 요청한다. `residual.status=FAILED`면 `failure` 객체를 포함한다.

**실패:** `STAR_LOCKED`, `BUNDLE_CHANGED`, `removed`에 이 회원이 매칭하지 않은·은퇴한 후보가 있으면 400 `VALIDATION_FAILED`.

### 5.3 주기도

`GET /api/v1/stars/{ticId}/periodogram?bundleId=b-2&curveStep=1&removed=c-401`

```json
{
  "curveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "residual": {"status": "COMPLETED", "jobId": "rj-77"},
  "periodMinDays": 0.5, "periodMaxDays": 46.0, "nPeriods": 5000, "gridRule": "log",
  "baselineHalfDays": 40.7,
  "power": [0.012, 0.015, 0.011]
}
```

- i번째 주기 = `periodMinDays × (periodMaxDays / periodMinDays)^(i / (nPeriods − 1))`. 격자 배열은 보내지 않는다(ERD `periodograms`).
- `periodMaxDays`는 그 별 후보표 최장 주기의 1.15배, 최소 40일(EXP-04, AT-73). `baselineHalfDays`를 넘는 구간은 프론트가 "가려짐 2번 미만" 음영으로 표시한다.
- 원본(`curveStep=0`)은 `periodograms` 행, 잔차 단계는 Redis 캐시. 없으면 5.2절과 같은 202.

### 5.4 봉우리와 미세 조정 범위 (Q06)

`GET /api/v1/stars/{ticId}/candidate-peaks?bundleId=b-2&curveStep=1&removed=c-401`

EXP-05는 후보마다 `period_min/max/step`을 후보표 API에서 풀어 주라고 하고, POL-05·EXP-02는 매칭 전에 후보 개수·주기를 노출하지 말라고 한다. 두 요구를 함께 만족하는 안으로 **봉우리는 후보표가 아니라 현재 주기도에서 뽑는다.**

```json
{
  "curveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "peaks": [
    {"rank": 1, "periodDays": 11.802, "power": 0.83, "gridIndex": 3311,
     "fineTune": {"periodMinDays": 11.771, "periodMaxDays": 11.833, "periodStepDays": 0.0005},
     "suggestedDurationHours": 3.1, "suggestedPhaseCenter": 0.37},
    {"rank": 2, "periodDays": 5.901, "power": 0.41, "gridIndex": 2589,
     "fineTune": {"periodMinDays": 5.886, "periodMaxDays": 5.916, "periodStepDays": 0.00025},
     "suggestedDurationHours": 2.2, "suggestedPhaseCenter": 0.81}
  ],
  "matchedCandidates": [{"candidateId": "c-401", "periodDays": 3.0021}],
  "peakRuleVersion": "peak-1"
}
```

| 규칙 | 근거 |
|---|---|
| `peaks`는 주기도 상위 N개 봉우리(N은 운영 설정, 기본 10). 후보든 아니든 구분하지 않으며 `candidateId`를 넣지 않는다 | POL-05, EXP-13 "상위 봉우리에 번호" |
| `gridIndex`는 같은 `curveContext`·`peakRuleVersion` 안에서 사용자가 고른 봉우리의 식별값이다. `rank`는 정렬 결과이므로 제출 식별값으로 쓰지 않는다 | C02-R3 |
| `fineTune`은 manifest의 격자 간격·허용 폭 규칙을 그 봉우리 주기에 적용해 계산. 하드코딩 금지 | EXP-05, DAT-11 |
| `suggestedDurationHours`·`suggestedPhaseCenter`는 BLS 제안 밴드(EXP-06 "제안 밴드로 표시할 수 있으나"). 제출 입력이 아니다 | EXP-06 |
| `matchedCandidates`는 회원이 이미 매칭한 후보의 주기. 흐린 선 표시용 | EXP-13 |
| 목록은 **표시·추천용**이다. 제출 주기가 상위 N개에 속할 필요는 없으며, 어떤 주기 P의 미세 조정 범위는 `selectionRules.fineTune.halfWidthCells`로 주기도 격자에서 `P × r^(−h) ~ P × r^(+h)` (r = 격자 비율, h = halfWidthCells), step은 격자 한 칸 폭이다. 목록의 `fineTune`은 이 규칙을 각 봉우리에 미리 적용한 값 | EXP-05 재선택·미세 조정 구분 |
| 선택 봉우리의 미세 조정 범위 밖으로 값을 바꾸는 것은 프론트가 막고 새 주기 선택을 안내한다. 서버도 `sourcePeakGridIndex`가 있으면 같은 범위를 검증한다. 주기도의 다른 위치를 새로 고른 경우 source를 null로 바꾸며, 전체 주기 격자 안이면 봉우리 범위 밖이라는 이유만으로 거절하지 않는다 | EXP-05, C02-R3 |

봉우리 추출 규칙(N, 최소 간격, 고조파 제외)은 윤성용과 정한다(미결 5). 봉우리를 선택해 시작한 제출은 `sourcePeakGridIndex`로 그 선택을 전달하고, 서버는 해당 봉우리의 추천 duration을 6.2절 상한에 사용한다. 주기도의 다른 위치를 직접 선택한 제출은 이 값을 null로 보낸다.

## 6. 제출·결과

### 6.1 요청

`POST /api/v1/stars/{ticId}/submissions` — 제출값 확인 단계의 [제출].

```json
{
  "requestId": "6f0b3a1e-4d2c-4a7f-9d0e-1b2c3d4e5f60",
  "submissionKind": "candidate",
  "curveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "selection": {"periodDays": 11.802, "sourcePeakGridIndex": 3311, "phaseStart": 0.995, "phaseEnd": 1.005},
  "userJudgment": "LIKELY_PLANET",
  "evidenceChecks": ["oddeven", "ushape"],
  "memo": "홀짝 깊이가 비슷하고 U형",
  "viewState": {"periodogramViewport": {"minDays": 8.0, "maxDays": 16.0}, "foldedXZoomRatio": 4},
  "retryOfSubmissionId": null
}
```

| 필드 | 필수 | 규칙 |
|---|---|---|
| `requestId` | 예 | 2.2절 |
| `submissionKind` | 예 | `candidate` / `no_candidate` / `skipped` |
| `curveContext` | 예 | 2.1절. 현재 판·현재 단계와 대조 |
| `selection` | candidate만 | 원본 입력. `sourcePeakGridIndex`는 사용자가 선택한 봉우리의 `gridIndex`이며 주기도의 다른 위치를 직접 선택했으면 null이다. `epoch`·`duration`·정정 주기·성과를 보내도 무시한다(SUB-01) |
| `userJudgment` | candidate만 | `LIKELY_PLANET` / `UNLIKELY_PLANET` / `UNSURE` |
| `evidenceChecks` | 아니오 | `oddeven`, `secondary`, `ushape` 중 0~3개. 그 외 값(중심 위치 포함)은 400(POL-13, AT-93) |
| `memo` | 아니오 | 0~200 유니코드 코드포인트. 2026-09-17 사용자 채택·프론트 적용, 서버 DTO 검증·오류 응답 반영 확인 대기 |
| `viewState` | 아니오 | 재현용. 서버 매칭 입력이 아니며 범위만 검증(HIS-02). `foldedXZoomRatio`를 제공하면 유한한 수이며 `1 ≤ 값 ≤ 32`여야 한다. 기존 1~8 값도 유효하다(SRS v1.3.1 변경안) |
| `retryOfSubmissionId` | 아니오 | [다시 풀기]에서 온 제출. 본인 제출·같은 TIC만 |

**접기 표시 상태 변경안(2026-09-16, 사용자 채택·교차 리뷰 대기):** [SRS EXP-13](../../../docs/requirements/planetory-requirements-spec.md#43-분석-화면)에 따라 배율 허용 상한을 32로 늘린다. 미세 조정 중 화면 중심 위상은 프론트 내부 상태이며 이 요청·히스토리 응답에 새 필드를 추가하지 않는다. 기존 `analysis_histories.snapshot_params` JSONB에 배율을 저장하므로 이 변경으로 테이블·열·마이그레이션을 추가하지 않는다. 백엔드 담당자는 DTO·범위 검증의 8배 제한 유무와 32배 저장·조회, 기존 1~8배 기록 호환을 확인하고 제한이 있으면 수정한다. 문서 반영은 실제 API 검증 완료를 의미하지 않는다. 확대 배율은 BLS·잔차·매칭·epoch·duration 계산 입력을 변경하지 않는다.

### 6.2 검증 (SUB-02, Q03)

순서대로 검사하고 첫 실패에서 400을 돌려준다. `fieldErrors[].field`는 아래 이름을 쓴다.

| 순서 | 검사 | 실패 코드 |
|---|---|---|
| 1 | 인증·`published`·별 열림 | 401 / 404 / 403 `STAR_LOCKED` |
| 2 | `bundleId`·계산 버전 = 현재 판 | 409 `BUNDLE_CHANGED` |
| 3 | `removedCandidateIds` ⊆ 이 판에서 회원이 매칭한 활성 후보, `curveStep = removedCandidateIds.length`. **마지막 제출 단계와 같을 필요는 없다.** 다음 잔차 단계의 첫 제출, 원본·이전 단계로 돌아간 제출, 재도전 초안의 제출이 모두 이 조건만으로 허용된다(EXP-09) | 400 `curveContext` |
| 4 | `periodDays` 유한·양수, `phaseStart`·`phaseEnd` 유한, `0 ≤ phaseStart < 1`, `phaseStart < phaseEnd < phaseStart + 1` | 400 `selection.*` |
| 5 | 시간 최소: `(phaseEnd − phaseStart) × periodDays ≥ selectionRules.minWindowDays`(케이던스 2배). 위상 최대: `phaseEnd − phaseStart ≤ phaseWidthMax`. `sourcePeakGridIndex`가 있으면 같은 `curveContext`의 봉우리가 존재하고 제출 주기가 그 봉우리의 `fineTune` 범위 안인지 확인한 뒤, **그 봉우리의** `suggestedDurationHours × maxDurationMultipleOfSuggested`도 상한으로 적용한다. null이면 위상 최대만 적용한다. 주기만 보고 가까운 봉우리를 역추정하지 않는다 | 400 `selection.sourcePeakGridIndex` 또는 `selection.phaseEnd` (DEC-19, Q03) |
| 6 | 정수 k가 존재해 epoch가 `observationBounds` 안 | 400 `EPOCH_OUT_OF_RANGE` |
| 7 | `0 < durationHours/24 < periodDays` | 400 `selection` |
| 8 | `userJudgment` enum, `evidenceChecks` 허용 목록 | 400 |
| 9 | `periodDays`가 주기도 격자 범위 `[periodMinDays, periodMaxDays]` 안(5.3절). **상위 N개 봉우리에 속할 필요는 없다**(EXP-05의 재선택은 주기도 어느 주기든 가능) | 400 `selection.periodDays` |

`phaseEnd > 1`인 경계 통과는 정상이다(AT-09). 검증 실패는 Submission·History를 만들지 않는다.

**C02-R3 결정:** 추천 duration 3배 상한은 정답 판정 범위가 아니라 선택 폭 제한이다. 서로 다른 봉우리의 `fineTune` 범위가 겹쳐도 `sourcePeakGridIndex`가 가리키는 사용자 선택 봉우리의 `suggestedDurationHours`만 사용한다. source가 null인 직접 주기 선택은 Bundle 공통 `phaseWidthMax`만 적용한다. 추천 배열 순서나 가장 가까운 봉우리로 source를 추정하지 않는다. 3배 값은 DEC-19의 현재 기본안이며 운영값은 `selectionRules.version`으로 버전 관리한다.

### 6.3 처리 순서 (한 트랜잭션, NFR-01)

```text
1. request_id로 기존 행 조회 → 있으면 본문 해시 비교 후 재현 또는 IDEMPOTENCY_CONFLICT
2. 6.2 검증. epochBtjd·durationHours 서버 산정
3. 매칭 (5.1·5.2): 이 판의 active·discoverable 후보 중 removedCandidateIds에 없는 것만 비교.
   허용 오차·관측 통과 수 N 상한·허용 배율은 operation_settings 현재 rule_version의 values에서 읽고 submissions.rule_version에 기록(OPS-04)
   - 배율 1 일치 우선 → 없으면 1/2·2배 → 조건 만족 후보 0개 not_matched / 1개 matched·matched_harmonic
   - 여러 개면 정규화 거리·통과 중첩 비교, 우세 없으면 ambiguous_match
   - 일치 후보에 이미 이 회원의 user_candidate_achievements가 있으면 duplicate
4. submissions INSERT (원본·정정·파생값·rule_version·bundle_id)
5. analysis_histories INSERT (snapshot_params, versions). 제출 1건당 정확히 1건이며 사용자 조작 없이 생성(HIS-01)
6. matched·matched_harmonic·duplicate면 analysis_snapshots INSERT (150 bins, 접힌 곡선 중앙값·오차)
7. 성과 판정 (5.3): 확정+LIKELY / FP+UNLIKELY → 9.2 recognizeAchievement 호출 → 별 열림
   - 확정·FP 오판·UNSURE → achievement_result=judgment_mismatch, 성과 없음
   - 미확정 → pending_publish (공개 시 서비스 API가 9.2 호출)
   - duplicate → already_recognized
8. user_star_progress 갱신: planet_count(회원의 후보별 최신 판단으로 다시 계산, HOME-05), current_curve_step = 이 제출의 curveStep, completed 판정(9.3)
   튜토리얼 1번 별의 첫 제출이면 user_settings.onboarding_done = true (D-8, HOME-09)
9. 튜토리얼 별이면 completed 시 다음 순번 열림(9.4)
10. COMMIT 후 응답. 잔차 계산은 시작하지 않는다(EXP-09의 [다음 곡선] 요청이 별도)
```

동시 제출: 같은 회원의 제출은 `users` 행 잠금으로 직렬화한다(서비스 SB-D15와 같은 잠금 순서: users → user_star_progress → user_candidate_achievements → star_unlocks). 다른 회원의 제출은 서로 잠그지 않는다.

### 6.4 응답 DTO `submissionResult`

새 제출 201, 재전송 200. `GET /submissions/{id}`도 같은 본문이다.

```json
{
  "submissionId": "sub-7001", "historyId": "h-501", "requestId": "6f0b3a1e-…",
  "ticId": "123456789", "bundleId": "b-2", "ruleVersion": "rule-3",
  "submittedAt": "2026-09-10T02:30:00Z",
  "submissionKind": "candidate",
  "curveContext": {"bundleId": "b-2", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "original": {"periodDays": 11.802, "sourcePeakGridIndex": 3311, "phaseStart": 0.995, "phaseEnd": 1.005, "userJudgment": "LIKELY_PLANET",
               "evidenceChecks": ["oddeven", "ushape"], "memo": "홀짝 깊이가 비슷하고 U형",
               "viewState": {"periodogramViewport": {"minDays": 8.0, "maxDays": 16.0}, "foldedXZoomRatio": 4}},
  "serverDerived": {"foldReferenceTimeBtjd": 1683.4231, "phaseCenter": 0.0, "epochBtjd": 1683.4231,
                    "durationHours": 2.83, "sourcePeakSuggestedDurationHours": 3.1, "durationLimitHours": 9.3,
                    "centroidDataStatus": "unavailable"},
  "match": {"status": "matched_harmonic", "candidateId": "c-402", "harmonicMultiplier": 2,
            "correctedPeriodDays": 23.604, "correctionReason": "P/2 alias"},
  "signal": {
    "candidateId": "c-402", "disposition": "UNCONFIRMED", "answerClass": "analysis", "planetTruth": null,
    "bls": {"periodDays": 23.604, "epochBtjd": 1695.11, "durationHours": 3.4, "depthPpm": 380, "sde": 9.1, "snr": 7.8},
    "ai": {"status": "completed", "score": 0.71, "verdict": "hold", "modelVersion": "astronet-triage-1"},
    "external": [{"source": "TOI", "externalId": "TOI-1234.02", "disposition": "PC", "fetchedOn": "2026-09-01"}],
    "relabel": null
  },
  "judgment": {"value": "LIKELY_PLANET", "evaluation": "UNSCORED"},
  "skyVersion": "u-101:58",
  "achievement": {"result": "pending_publish", "newlyRecognized": false, "unlockedStars": [],
                  "star": {"count": 1, "grade": "A", "byType": {"confirmed": 1, "unconfirmed": 0, "fp": 0}}},
  "progress": {"stage": "in_progress", "completionReason": null, "reopenPending": false,
               "currentCurveStep": 1, "matchedCandidateIds": ["c-401", "c-402"],
               "remainingDiscoverableCount": 1},
  "publication": {"state": "UNPUBLISHED", "publicAnalysisId": null},
  "judgmentStatistics": {"kind": "public_analyses", "candidateId": "c-402",
                         "participantCount": 15, "likelyPlanet": 8, "unlikelyPlanet": 4, "unsure": 3,
                         "percentages": {"likelyPlanet": 53.3, "unlikelyPlanet": 26.7, "unsure": 20.0},
                         "asOf": "2026-09-10T02:30:00Z"},
  "detail": {"available": true, "targetKind": "CURRENT_MATCH", "answerViewed": false},
  "tutorial": {"seq": null, "skipAvailable": false},
  "nextActions": ["NEXT_CURVE", "PUBLISH_ANALYSIS", "LATER", "VIEW_RESULT"]
}
```

| 필드 | 규칙 |
|---|---|
| `match.status` | `matched` / `matched_harmonic` / `not_matched` / `duplicate` / `ambiguous_match`; `no_candidate`는 `none_wrong`, `skipped`는 `skipped`. ERD CHECK 그대로 |
| `signal` | 매칭 성공(`matched`·`matched_harmonic`·`duplicate`)에만. `not_matched`·`ambiguous_match`는 null(AT-14, AT-75). 확정·FP는 `external`에 행성명·출처·조회일·링크(RES-02) |
| `signal.ai` | `status` `completed` / `input_insufficient` / `error` / `not_evaluated`. 실행 불가를 0점으로 바꾸지 않는다(RES-04, AT-15). `signal.external`과 나란히 두고 어느 쪽도 다른 쪽을 덮어쓰지 않는다(RES-05, AT-16). AI 오류·데이터 부족·미매칭·후보 미충족은 각각 `ai.status`·`match.status`로 구분된다(NFR-09) |
| `judgment.evaluation` | 확정: LIKELY=`AGREES`, UNLIKELY=`DISAGREES`, UNSURE=`UNSURE`. FP: UNLIKELY=`AGREES`, LIKELY=`DISAGREES`. 미확정=`UNSCORED`. 미매칭=`NOT_APPLICABLE` |
| `achievement.result` | ERD `achievement_result`. `unlockedStars`는 이번에 열린 별의 `{ticId, position}` 목록(AT-58). `star`는 이 TIC의 처리 후 누적값 |
| `skyVersion` | 처리 후 지도 `version`(4.1절 최신성). 프론트는 마지막 값과 다르면 지도 메타·타일을 재조회한다(제안) |
| `progress.remainingDiscoverableCount` | 남은 탐색 가능 미매칭 신호 수. 후보표 전체 수는 주지 않는다(DEC-28) |
| `publication` | 미확정 매칭만 `UNPUBLISHED`. 확정·FP는 `NOT_ELIGIBLE`. 서비스 API의 공개 기록을 조인 |
| `judgmentStatistics` | RES-11. 미확정은 서비스 F16의 `judgmentSummary`와 같은 형식(`kind: public_analyses`). 확정·FP는 `{"kind":"graded","matchedMemberCount":10,"agreementPercent":70.0}`. 공개 0명은 `participantCount: 0`, `percentages: null`. 미매칭은 null |
| `detail.targetKind` | `CURRENT_MATCH`(매칭 후 오판·보류·duplicate) / `CURRENT_CURVE_HINT`(not_matched·none_wrong) / null |
| `nextActions` | 서버 힌트(RES-03·08). `NEXT_CURVE`(남은 탐색 가능 신호 있음), `VIEW_DETAIL`, `RETRY`, `PUBLISH_ANALYSIS`(미확정 매칭), `LATER`, `VIEW_RESULT`, `GO_HOME`, `DISCUSS`(not_matched), `SKIP_TUTORIAL`. 실행 시 서버가 다시 검증. 게시 화면으로 강제 이동시키지 않는다(AT-36) |

`ambiguous_match`: 어느 후보도 고르지 않고 `signal: null`, 성과·진행 변화 없음, `nextActions`는 `RETRY`(AT-13). 판 교체 후 재전송된 `requestId`는 저장된 결과를 그대로 재현하며 새 판으로 다시 판정하지 않는다.

### 6.5 특수 제출

**`no_candidate` (SUB-11 (2)).** `selection`·`userJudgment`·`evidenceChecks` 없음. 현재 단계에서 제거되지 않은 탐색 가능 신호가 남아 있으면 `match.status=none_wrong`, 성과 없음, `detail.targetKind=CURRENT_CURVE_HINT`(AT-55). 별이 이미 완료면 저장하지 않고 409 `STAR_ALREADY_COMPLETED`.

**`skipped` (SUB-12).** 조건: 튜토리얼 별, `tutorial_skip_after ≥ 1`, 같은 별 본인 제출 중 `not_matched`·`none_wrong`·`judgment_mismatch` 합이 설정값 이상, 그리고 가장 최근 오답 제출에서 상세 보기(`answer_viewed=true`)를 거침. 충족하면 `match.status=skipped`, `completion_reason=skipped`, 성과·별 열림 없음, 다음 순번 튜토리얼 열림(AT-88). 아니면 409 `SKIP_NOT_AVAILABLE`. 튜토리얼이 아닌 별은 항상 409.

### 6.6 조회와 요청 ID 복구

`GET /api/v1/submissions/{submissionId}` — 본인 제출만(타인 403). 6.4절 본문. `achievement.star`·`progress`·`publication`·`judgmentStatistics`는 **조회 시점**의 현재 값이고 `original`·`serverDerived`·`match`·`judgment`·`achievement.result`는 제출 당시 값이다.

`GET /api/v1/submissions/by-request/{requestId}` — 응답 유실 후 복구. 200 같은 본문 / 404 미접수(새 요청 아님, 같은 ID로 재전송) / 409 `REQUEST_IN_PROGRESS`.

### 6.7 상세 보기

`POST /api/v1/submissions/{submissionId}/detail-view` — 오답 분기의 [상세 보기]. 본문 없음. 멱등(반복 호출은 같은 대상).

```json
{
  "submissionId": "sub-7002", "answerViewed": true,
  "targetKind": "CURRENT_CURVE_HINT",
  "signal": {"candidateId": "c-403", "disposition": "FP", "answerClass": "graded", "planetTruth": "not_planet",
             "bls": {"periodDays": 2.77, "epochBtjd": 1684.9, "durationHours": 4.1, "depthPpm": 12000, "sde": 14.2, "snr": 21.0},
             "ai": {"status": "completed", "score": 0.12, "verdict": "rejected", "modelVersion": "astronet-triage-1"},
             "external": [{"source": "TOI", "externalId": "TOI-1234.01", "disposition": "FP", "fetchedOn": "2026-09-01"}],
             "explanation": "깊이가 크고 2차 식이 뚜렷한 식쌍성 신호입니다."},
  "userJudgmentAgrees": null,
  "tutorial": {"seq": 2, "skipAvailable": true}
}
```

- `CURRENT_MATCH`: 그 제출이 매칭한 신호. `userJudgmentAgrees`에 일치 여부(RES-02).
- `CURRENT_CURVE_HINT`: 그 제출의 `curveContext`에서 제거되지 않은 탐색 가능 후보 중 `bls_power`(SDE·SNR) 최고 하나. 누적 매칭 집합이 아니라 그 제출 단계 기준(RES-09). 한 번에 하나만.
- 미확정 후보는 `explanation`에 "정답"이라는 표현을 쓰지 않는다.
- 대상이 없으면 409 `DETAIL_UNAVAILABLE`, `answer_viewed`도 바꾸지 않는다.
- `tutorial.skipAvailable`이 true면 프론트가 화면 끝에 [다음 튜토리얼로]를 두고 `skipped` 제출로 실행한다.

### 6.8 다시 풀기 초안 (SUB-10, AT-54·100·118)

`GET /api/v1/submissions/{submissionId}/retry-draft` — 초안 조회만이며 아무것도 저장하지 않는다.

```json
{
  "sourceSubmissionId": "sub-7002",
  "bundleId": "b-3", "isPreviousBundle": true,
  "curveContext": {"bundleId": "b-3", "curveStep": 1, "removedCandidateIds": ["c-401"],
                   "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "restored": {"step": true, "notice": null},
  "draft": {"periodDays": 11.802, "phaseStart": 0.9874, "phaseEnd": 0.9974,
            "viewState": {"periodogramViewport": {"minDays": 8.0, "maxDays": 16.0}, "foldedXZoomRatio": 4},
            "userJudgment": null, "evidenceChecks": [], "memo": null},
  "residualForStep": {"status": null, "jobId": null},
  "retryOfSubmissionId": "sub-7002"
}
```

- 위상은 저장값을 복사하지 않고 현재 판 기준 시각으로 재환산한다(HIS-02, 분석 프론트 6.3): `width = durationHours / (24 × P)`, `center = phase(epochBtjd)`, `phaseStart = (center − width/2) mod 1`, `phaseEnd = phaseStart + width`.
- **C02-R1 결정:** 원 제출의 제거 조합에 은퇴 후보가 있으면 `curveContext`를 **그 별의 현재 진행 문맥**으로 대체하고 `restored.step=false`, `restored.notice=STEP_NOT_RESTORABLE`을 반환한다. 예: 옛 `{A,B}`, B 은퇴, 현재 진행 `{A,C}`이면 `{A,C}`, step 2다. 조회는 진행·원 제출을 변경하지 않는다. History CURRENT는 별도 HIS-03 규칙에 따라 최신 원본 곡선으로 대체하며, 5.1·6.8과 같은 잔차 조합을 반환하지 않는다.
- 대상 신호가 은퇴했으면 409 `CANDIDATE_RETIRED`.
- 초안의 단계 잔차가 캐시에 없으면 `residualForStep`으로 알려 준다. 결과와 작업이 모두 없으면 위 예시처럼 status·jobId는 null이고, 실제 작업이 있으면 그 상태·ID를 반환한다. 초안 조회는 작업을 생성하지 않으며 본인 탐사 화면에서 7.1절로 요청한다.
- 실제 재제출은 새 `requestId`와 `retryOfSubmissionId`로 6.1절을 호출한다. 누적 매칭·완료는 되돌리지 않는다.
- 새 판에서 저장된 주기가 추천 봉우리의 `fineTune` 범위 밖이어도 전체 주기도 격자 `[periodMinDays, periodMaxDays]` 안이면 그 이유만으로 재제출을 거절하지 않는다(5.4절, 6.2절 9단계). 전체 격자 밖이면 400 `VALIDATION_FAILED`와 `fieldErrors[].field=selection.periodDays`로 거절하고 프론트는 초안을 유지한 채 주기 재선택을 안내한다. 다시 풀기에서는 옛 봉우리 식별값을 복원하지 않고 `sourcePeakGridIndex=null`로 시작한다. 사용자가 현재 판의 봉우리를 다시 선택하면 그 값을 새로 기록한다.

## 7. 온라인 잔차 작업

### 7.1 요청

`POST /api/v1/stars/{ticId}/residual-jobs` — 매칭 후 [다음 곡선], 원본·이전 단계 복귀 시 캐시 없음, 재시도.

```json
{
  "target": {"bundleId": "b-2", "removedCandidateIds": ["c-401", "c-402"],
             "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"}
}
```

검증: 별 열림, 현재 판, `removedCandidateIds` ⊆ 회원이 이 판에서 매칭한 활성 후보(어떤 순서 조합도 허용, EXP-09). 빈 배열은 원본이므로 400.

캐시 키는 DAT-14 그대로 `tic:{ticId}:b{bundleId}:rm{정렬 id}:{rm}:{pg}`이다.

| 상황 | 응답 |
|---|---|
| 캐시 `COMPLETED` | 200 `{"jobId": null, "status": "COMPLETED", "cacheHit": true, "resultCurveContext": {...}}` |
| 진행 중 작업 있음 | 202 그 작업의 상태. 같은 키는 하나만 계산(`SETNX`) |
| 새 작업 | 202 `{"jobId": "rj-78", "status": "QUEUED", "cacheHit": false, "queuePosition": 3, "estimatedSeconds": 40, "pollAfterSeconds": 2}` |
| 대기열 초과 | 429 `RESIDUAL_QUEUE_FULL`, `retryAfterSeconds` |
| 같은 회원의 다른 작업이 진행 중 | 429 `RESIDUAL_QUEUE_FULL`, `retryAfterSeconds`, `activeJobId`. 회원당 동시 1개(D-4) |
| 판 교체 | 409 `BUNDLE_CHANGED` |

잔차 요청에는 `requestId`가 없다. 같은 `target`을 다시 POST하면 진행 중 작업 또는 캐시 결과를 그대로 돌려주므로, **응답 유실 후 복구도 같은 `target`으로 재호출**한다. 별도 복구 조회 API는 두지 않는다. 동일 요청 재전송과 새 요청을 구분할 필요가 없는 이유는 결과가 회원과 무관한 캐시이고 요청 자체가 상태를 만들지 않기 때문이다.

### 7.2 상태 조회

`GET /api/v1/residual-jobs/{jobId}` — v1은 폴링(D-3, Q08). `pollAfterSeconds`를 따른다.

```json
{
  "jobId": "rj-78", "ticId": "123456789",
  "target": {"bundleId": "b-2", "removedCandidateIds": ["c-401", "c-402"], "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "status": "PERIODOGRAM_CALCULATING",
  "attempt": 1,
  "timeline": {"queuedAt": "…", "residualStartedAt": "…", "residualReadyAt": "…", "periodogramStartedAt": "…", "completedAt": null},
  "failure": null,
  "resultCurveContext": null,
  "pollAfterSeconds": 2
}
```

- `COMPLETED`면 `resultCurveContext`에 5.2·5.3절로 조회할 문맥을 준다. `curveStep = removedCandidateIds.length`.
- `FAILED`면 `failure: {"stage": "PERIODOGRAM", "code": "COMPUTE_ERROR", "message": "…", "retryable": true}`. 저장된 제출·매칭·완료·성과는 바뀌지 않고 마지막 정상 곡선을 유지한다(AT-101). 재시도는 7.1절 재호출이며 `attempt`가 오른다.
- v1은 `RESIDUAL_READY`에서 곡선을 먼저 노출하지 않고 `COMPLETED`에서만 전환한다(D-3). 선노출·SSE는 계산 시간 실측 후 재검토한다.
- Redis 재시작으로 작업이 사라지면 404 `RESOURCE_NOT_FOUND`. 프론트는 7.1절로 다시 요청한다(분석 프론트 8.1 "Redis 결과 없음").
- 계산 중 새 판이 공개되면 작업은 `FAILED(stage: BUNDLE_ARCHIVED)`로 끝나고 프론트는 최신 판을 다시 불러온다(AT-80).

### 7.3 중복·만료·관측

- Worker 임대 시간을 두고 만료 시 다른 Worker가 다시 계산한다. 늦은 결과는 `attempt`가 최신보다 작으면 버린다(온라인 파생 계산 문서).
- 판이 `archived`가 되면 그 판의 키를 모두 지운다(DAT-11). TTL·동시 실행 상한(초기값 전체 2, EC2당 1, 대기 20)은 DEC-35·김동혁.
- 잔차 계산 완료·곡선 전환·원본 복귀는 서버 상태를 바꾸지 않는다. `user_star_progress.current_curve_step`은 **회원이 그 단계에서 제출할 때** 제출 트랜잭션이 갱신한다(6.3절 8단계). 통신 오류 후 복귀는 5.1절의 `currentCurveContext`·`nextCurveContext`로 판단한다.

## 8. 히스토리·결과 페이지

### 8.1 히스토리 목록

`GET /api/v1/me/histories?ticId=123456789&candidateId=&result=&from=&to=&cursor=&size=20`

서비스 API 7.1절(첨부 선택)과 같은 계약이다. 필드명은 ERD에 맞춘다.

```json
{
  "items": [{
    "historyId": "h-501", "submissionId": "sub-7001", "ticId": "123456789", "candidateId": "c-402",
    "submissionKind": "candidate", "matchResult": "matched_harmonic", "userJudgment": "LIKELY_PLANET",
    "achievementResult": "pending_publish", "submittedAt": "2026-09-10T02:30:00Z",
    "bundleId": "b-2", "isPreviousBundle": false, "curveStep": 1,
    "publication": {"publicAnalysisId": null, "isPublic": false, "isModerationHidden": false},
    "achievementGranted": false, "snapshotAvailable": true, "answerViewed": false,
    "relabel": null, "retryOfSubmissionId": null
  }],
  "nextCursor": null, "hasNext": false
}
```

- `result` 필터: `matched`(matched·matched_harmonic·duplicate) / `not_matched` / `none_wrong` / `ambiguous_match` / `skipped`.
- 정렬 `submittedAt` 내림차순, 동률 `submissionId` 내림차순(결정 7-1).
- `achievementGranted`는 `user_candidate_achievements` 존재 여부이며 현재 공개 여부와 다르다.
- 타인은 조회할 수 없다(NFR-14). 첨부·공개 분석은 8.5절 투영을 서비스 API가 사용한다.

### 8.2 히스토리 상세

`GET /api/v1/histories/{historyId}` — 본인만. 6.4절 `submissionResult` 전체에 아래를 더한다.

```json
{
  "historyId": "h-501",
  "submission": {"$ref": "6.4절 submissionResult 본문 전체"},
  "versions": {"data": "sec-14-41-54/r1", "preprocess": "pp-3", "pipeline": "pl-7", "rule": "rule-3",
               "residualModel": "rm-1", "periodogramConfig": "pg-1"},
  "snapshotParams": {"periodogramViewport": {"minDays": 8.0, "maxDays": 16.0}, "foldedXZoomRatio": 4,
                     "foldSettings": {"referenceTimeBtjd": 1683.4231}, "centroidDataStatus": "unavailable"},
  "isPreviousBundle": false,
  "relabel": null,
  "createdAt": "2026-09-10T02:30:00Z"
}
```

불변이다(HIS-06, NFR-12). 수정·삭제 API는 없고 그래프는 이미지가 아니라 재현 파라미터로만 보관한다. 장기 보관·탈퇴 처리는 DEC-11(서비스 F04). `relabel`은 `{"relabeledAt": "...", "newDisposition": "CONFIRMED"}`로 "기록이 갱신됨" 표시에 쓴다(GRD-06).

### 8.3 히스토리 그래프 (HIS-03, Q11)

`GET /api/v1/histories/{historyId}/graph?mode=CURRENT|SUBMITTED` — 생략은 `CURRENT`.

```json
{
  "historyId": "h-501",
  "reproduction": {"submittedBundleId": "b-2", "currentBundleId": "b-3", "isPreviousSubmission": true,
                   "residualReproducible": false, "fallbackReason": "RETIRED_CANDIDATE",
                   "currentFoldReferenceTimeBtjd": 1683.4231},
  "selection": {"userPeriodDays": 11.802, "correctedPeriodDays": 23.604, "harmonicMultiplier": 2,
                "epochBtjd": 1683.4231, "durationHours": 2.83,
                "currentPhaseStart": 0.9874, "currentPhaseEnd": 0.9974},
  "curve": {"$ref": "5.2절 세그먼트 DTO. residualReproducible=false면 원본(curveStep 0)"},
  "snapshot": {"bins": 150, "foldedFlux": [1.0, 0.98], "foldedError": [0.001, 0.002]}
}
```

| 모드 | 내용 |
|---|---|
| `CURRENT` | 현재 판 곡선(잔차 재현 가능하면 그 단계, 아니면 원본) + `selection`의 현재 위상. `snapshot`은 `null` |
| `SUBMITTED` | `curve`는 `null`, `snapshot`은 `analysis_snapshots`. 위상 i = `-0.5 + (i + 0.5) / bins`. 매칭 실패 기록은 `snapshot: null`(409가 아니라 200) |

접기는 `userPeriodDays`(원본 주기)로 한다. 정정 주기는 참고 표시다. 잔차 단계가 캐시에 없으면 HTTP 200을 유지하고 `curve.segments: null`로 준다. 결과와 작업이 모두 없으면 `curve.residual: {"status":null,"jobId":null}`, 실제 작업이 있으면 해당 상태와 실제 ID를 반환한다. null 상태는 작업 생성 전 조회 표현이며 2장의 작업 상태 전이에 추가하지 않는다. 히스토리 조회는 작업을 자동 생성하지 않는다.

첨부·공개 분석을 보는 타인에게는 잔차 재계산 요청 기능을 제공하지 않는다. 제공 가능한 원본 또는 제출 스냅샷만 표시하고 둘 다 없으면 그래프 제공 불가를 안내한다. 원본은 잔차로 표시하지 않으며 판단·메모 등 나머지 공개 내용은 유지한다. SUBMITTED 요청은 기존대로 curve:null·snapshot 규칙을 유지하고, 원본 대체는 CURRENT 조회로 구분한다. 개인 잔차 생성·작업 조회 API의 기존 권한을 확대하지 않는다.

읽기 조회이므로 판 교체는 `BUNDLE_CHANGED`로 거절하지 않는다. 응답을 만드는 동안 선택한 판이 `archived`가 되면 서버가 최신 판으로 조회 전체를 **최대 1회** 다시 시도하고, 그래도 한 판으로 일관된 결과를 만들지 못하면 503 `GRAPH_TEMPORARILY_UNAVAILABLE`을 돌려준다(서비스 API 7.2절 SB-D18과 같은 규칙). 서로 다른 판의 배열과 메타데이터를 한 응답에 섞지 않으며, `reproduction.currentBundleId`는 실제로 그래프를 만든 판이다. 서비스 API의 첨부·공개 분석 그래프 조회도 이 절을 그대로 쓴다.

### 8.4 별 결과 페이지 (RES-10, AT-74)

`GET /api/v1/stars/{ticId}/result` — 결과 카드 [결과 보기], 별 패널 [결과], 마이페이지 [결과]. 제출 이력이 없으면 404.

```json
{
  "ticId": "123456789",
  "star": {"sectorCount": 3, "tmag": 9.8},
  "bundle": {"bundleId": "b-3", "publishedAt": "…"},
  "progress": {"stage": "completed", "completionReason": "all_found", "reopenPending": false, "currentCurveStep": 2,
               "matchedCandidateIds": ["c-401", "c-402"], "remainingDiscoverableCount": 0},
  "achievement": {"count": 1, "grade": "A", "byType": {"confirmed": 1, "unconfirmed": 0, "fp": 0}},
  "signals": [
    {"candidateId": "c-401", "disposition": "CONFIRMED", "status": "active",
     "latestSubmissionId": "sub-6990", "latestHistoryId": "h-490", "matchResult": "matched", "userJudgment": "LIKELY_PLANET",
     "judgmentEvaluation": "AGREES", "achievement": {"result": "recognized", "recognizedAt": "…"},
     "publication": {"state": "NOT_ELIGIBLE"}, "ai": {"status": "completed", "score": 0.93, "verdict": "approved"},
     "relabel": null, "curveStepAtMatch": 0, "submissionIds": ["sub-6990"], "threadId": "st-301"},
    {"candidateId": "c-402", "disposition": "UNCONFIRMED", "status": "active",
     "latestSubmissionId": "sub-7001", "latestHistoryId": "h-501", "matchResult": "matched_harmonic", "userJudgment": "LIKELY_PLANET",
     "judgmentEvaluation": "UNSCORED", "achievement": {"result": "pending_publish", "recognizedAt": null},
     "publication": {"state": "UNPUBLISHED"}, "ai": {"status": "completed", "score": 0.71, "verdict": "hold"},
     "relabel": null, "curveStepAtMatch": 1, "submissionIds": ["sub-7001"], "threadId": null}
  ],
  "unmatchedSubmissions": [{"submissionId": "sub-7002", "historyId": "h-502", "matchResult": "not_matched", "submittedAt": "…"}],
  "curveSteps": [{"curveStep": 0, "residual": {"status": "COMPLETED"}}, {"curveStep": 1, "removedCandidateIds": ["c-401"], "residual": {"status": "COMPLETED"}},
                 {"curveStep": 2, "removedCandidateIds": ["c-401", "c-402"], "residual": {"status": "FAILED"}}],
  "discoveredStars": [{"ticId": "123456790", "unlockedAt": "…", "triggerAchievementId": "ach-31"}],
  "unpublishedSignalCount": 1,
  "links": {"boardOpen": true, "threadIds": ["st-301"]},
  "nextActions": ["PUBLISH_ALL", "LATER", "RETRY"]
}
```

- `signals`는 회원이 매칭한 고유 신호마다 한 항목. 미매칭 후보는 절대 나열하지 않는다(DEC-28).
- "탐색 완료 / 미게시 분석 있음"은 `progress.stage=completed`와 `unpublishedSignalCount>0`으로 공존한다.
- `threadId`는 서비스 API 공식 스레드 ID(있을 때만).

### 8.5 첨부·공개 분석용 투영 필드

서비스 API가 글·댓글 첨부 조회(HIS-05, COM-07)와 공개 분석 상세(COM-18)에 내려줄 수 있는 히스토리 필드는 아래로 한정한다(NFR-14). 첨부·게시·반응은 성과 수·등급을 바꾸지 않는다(GRD-05). 나머지(`viewState`, `answerViewed`, `achievementResult`, `retryOfSubmissionId`, 힌트 대상)는 소유자 전용이다.

```text
historyId, ticId, candidateId, submittedAt, userJudgment, evidenceChecks, memo,
original.periodDays, original.sourcePeakGridIndex, original.phaseStart, original.phaseEnd,
serverDerived.epochBtjd, serverDerived.durationHours, match.status, match.correctedPeriodDays, match.harmonicMultiplier,
curveContext, versions, graph(8.3절, mode 양쪽), relabel
```

## 9. 성과·등급·별 열림·완료·재개

### 9.1 성과 조회

`GET /api/v1/me/achievements?ticId=&cursor=&size=50`

```json
{
  "summary": {"discoveredStarCount": 57, "startedStarCount": 12, "completedStarCount": 5,
              "recognizedTotal": 9, "byType": {"confirmed": 5, "unconfirmed": 3, "fp": 1},
              "gradeDistribution": {"A": 3, "S": 1, "SS": 1, "SSS": 0}},
  "items": [{"achievementId": "ach-31", "ticId": "123456789", "candidateId": "c-401", "type": "confirmed",
             "recognizedSubmissionId": "sub-6990", "recognizedAnalysisId": null, "recognizedAt": "…",
             "relabel": null, "unlockedStars": [{"ticId": "123456790"}]}],
  "nextCursor": null, "hasNext": false
}
```

`summary`는 MY-01 프로필 요약의 원천이며 서비스 API `GET /me`·`GET /members/{id}`가 읽는다. 타인 프로필 노출 범위는 서비스 SB-D23(미병합)에 따른다. 순위·백분위는 없다(STA-04).

### 9.2 내부 계약: 성과 지급·별 열림

HTTP가 아니라 서비스 계층 함수다. 제출(6.3절 7단계)과 서비스 API의 공개 등록·일괄 공개(SB-D15)가 **같은 함수·같은 PostgreSQL 트랜잭션**에서 호출한다.

```text
recognizeAchievement(userId, candidateId, type, recognizedSubmissionId, recognizedAnalysisId?)
  → { newlyRecognized, achievementId, ticAchievementCount, grade, unlockedStars[] }

1. SELECT users WHERE id = userId FOR UPDATE          -- 회원 단위 직렬화. 잠금 순서: users → user_star_progress → user_candidate_achievements → star_unlocks
2. INSERT user_candidate_achievements ON CONFLICT (user_id, candidate_id) DO NOTHING
   → 충돌이면 newlyRecognized=false로 반환. 아래를 실행하지 않는다 (SUB-06, AT-12)
3. user_star_progress.achievement_count += 1, fp_success = true (type=fp일 때)
4. n = operation_settings.stars_per_achievement (기본 1)
   후보 = stars.service_status=published
        AND NOT EXISTS star_unlocks(user_id, tic_id)
        AND tic_id NOT IN tutorial_stars.active AND tic_id != 진행 중 challenge_rounds.target_tic_id      (OPS-08 제외 규칙)
   무작위 n개 선택. 시드 정책은 operation_settings (재현용 seed = hash(userId, achievementId, seq))
   후보가 n보다 적으면 있는 만큼만 열고 반환값 unlockShortfall = n − 실제 수 (D-11). 성과 인정은 그대로
5. 회원 잠금 안에서 실제 새 별마다 안정 layout_ordinal을 배정한다. 4.1절 personal-spiral-v1을 호출한다.
   star_unlocks INSERT (unlock_reason=achievement, trigger_tic_id=성과 별, trigger_achievement_id, seq=0..n-1,
   layout_ordinal, world_x, world_y, depth_z, layout_version=4.1절 은하 배치 함수 결과)
   ON CONFLICT (trigger_achievement_id, seq) DO NOTHING          -- 재처리 중복 방지 (GRD-08)
6. 반환
```

등급 상승·완료는 트리거가 아니다(POL-27, GRD-08, 결정 1·2). 확정·FP 경로(제출)와 미확정 경로(공개)가 같은 함수를 쓰므로 여러 신호의 일괄 공개도 순차 개별 인정과 같은 결과가 된다(COM-19, AT-107).

### 9.3 내부 계약: 완료·재개 판정

**완료(SUB-11, DEC-28).** 아래 판정을 세 시점에 실행한다. (a) 제출 트랜잭션에서 매칭 성공 후, (b) 5.1절 분석 진입 시 회원의 진행 행이 `in_progress`이면(AT-69: 탐색 불가능 신호만 남은 별에 들어왔을 때 성과 없이 완료·재개 대기), (c) 새 판 `current` 전환 후처리에서 `in_progress` 행 전부. 무신호 별은 배치가 적재하지 않으므로 active 후보가 0개인 별은 판정 대상이 아니다(SUB-11 (1)).

```text
discoverableUnmatched = 이 판 active 후보 중 discoverable=true AND candidate_id ∉ 회원 매칭 집합
undiscoverableUnmatched = 같은 조건에 discoverable=false
if discoverableUnmatched = 0:
    if undiscoverableUnmatched = 0: stage=completed, completion_reason=all_found
    else: stage=completed, completion_reason=undiscoverable_only, reopen_pending=true
    completed_at = now
```

판단·성과·공개와 독립이다(AT-56·97·98). 완료 자체에 성과·별 열림은 없다. `no_candidate` 제출은 완료를 만들지 않는다.

**재개(DAT-15, DEC-27).** 새 판이 `current`가 될 때 배치 후처리가 실행한다.

```text
for each user_star_progress(tic_id):
  if stage=in_progress: 위 완료 판정 (c)를 먼저 실행
  if stage=completed AND 이 판에 discoverable=true AND 회원 미매칭 후보가 생겼으면:
     stage=in_progress, reopen_pending=false, reopened_at=now, completed_at 유지
     → 재개 이벤트 {userId, ticId, bundleId, newDiscoverableCount, reason: new_candidate|became_discoverable}
       → 퀘스트 카드(4.3절), 마이페이지 목록 상단(4.4절 lastActivityAt 갱신), 알림 NTF-01(P1, 서비스 API)
기존 성과·등급·발견 별은 바꾸지 않는다. 튜토리얼 별도 같은 규칙으로 재개하지만 튜토리얼 완료·챌린지 자격은 `completed_at`으로 유지된다(4.3절).
```

### 9.4 내부 계약: 튜토리얼·챌린지 발견 (HOME-02·06, CHL-01)

모든 실제 신규 발견은 9.2절과 같은 회원별 순번 배정·좌표 저장 함수를 사용한다. layout_ordinal은 튜토리얼 seq나 성과 seq와 별개이며 중복 발견에는 새 순번을 확정하지 않는다. 발견·좌표·순번·회원 version 갱신은 같은 트랜잭션에서 확정/롤백한다. C04-2 저장 제약, C05-1 배치 함수, C07/C11 호출부를 함께 검증한다. 이미 열린 별이면 순번·좌표·회원 version을 바꾸지 않는다. 같은 사건을 다시 실행해도 프론트가 바뀌지 않은 지도를 다시 받지 않게 하기 위해서다.

| 사건 | 처리 |
|---|---|
| 회원 생성 | `tutorial_stars.seq=1` 별을 `unlock_reason=tutorial`로 열고 4.1절 은하 배치 좌표를 저장한다. 실패하면 회원 생성도 롤백(서비스 F01-Q5 제안). 튜토리얼 5개·회차 대상 TIC은 운영자가 DB에서 설정한다(OPS-07) |
| 튜토리얼 n 완료(`all_found`·`undiscoverable_only`·`skipped`) | seq n+1을 연다. 5 완료면 진행 중 회차의 `target_tic_id`를 `unlock_reason=challenge`로 연다. `ON CONFLICT (user_id, tic_id) DO NOTHING`. 제출 트랜잭션이 완료로 바꾼 뒤 같은 트랜잭션에서 호출한다(6.3절 9단계). 호출 시점에 완료가 아니거나 튜토리얼 별이 아니면 아무것도 하지 않는다. 다음 순번이 설정되지 않았으면 회원 생성과 같이 503 `DEPENDENCY_UNAVAILABLE`로 되돌린다 |
| 새 회차 `active` 전환 | 튜토리얼 5개 완료 회원 전원에게 그 회차 별을 연다(배치, 멱등). 회차가 끝나도 닫지 않는다(AT-61). 앱은 DB 직접 변경(OPS-07)을 감지하지 않으므로 운영자가 회차를 `active`로 바꾼 뒤 전용 명령(`--planetory.command=challenge-unlock`)을 실행한다. 주기 실행은 두지 않는다. 회원마다 트랜잭션을 나누고, 처리 도중 회차가 `active`에서 벗어나면 남은 회원을 열지 않고 멈춘다. 절차는 [챌린지 회차 전환 런북](../../../docs/operations/challenge-round-runbook.md) |
| 회차 진행 중 5번 완료 | 그 시점에 연다(서비스 F17-Q2) |
| 대상 별을 이미 발견한 회원 | 다른 경로(성과 발견 등)로 먼저 연 회원은 새로 기록하지 않는다. 발견 경로는 처음 기록한 `unlock_reason`을 유지하고, 빨간 느낌표는 경로와 무관하게 퀘스트 `challenge.ticId`로 표시한다(4.1·4.3절, 서비스 F17-Q2 제안) |

### 9.5 외부 라벨 갱신 표식 (GRD-06, DEC-26)

배치가 `candidate_dispositions`를 바꾸면 같은 배치가 아래만 한다.

- `candidate_status_history` INSERT
- 그 후보의 `user_candidate_achievements.relabeled_at`, `relabel_disposition` 설정
- 응답의 `relabel` 필드(6.4·8.1·8.2·8.4·9.1절)로 "기록이 갱신됨" 표시

성과 유형·등급·발견 별·통계 스냅샷은 바꾸지 않는다. 채점형 통계는 현재 `planet_truth`로 계산하므로 별도 조치 없이 반영된다. 후보 병합·분리·부정 사용 조치에 따른 성과 재계산(GRD-06 예외, OPS-03)은 v1에 운영 API가 없으므로 DB 작업과 `candidate_status_history` 기록으로 처리하며 이 문서 범위 밖이다.

## 10. 배치·Gold 적재 경계

Publisher가 PostgreSQL Primary에 직접 적재하고 서비스 API는 Gold를 읽기만 한다.

1. `planetory_gold_writer`로 `light_curve_segments`(신규 revision만), `periodograms`, `candidates`, `publication_bundles` staging을 적재한다.
2. 같은 트랜잭션에서 기존 `current`를 `archived`, 새 판을 `current`로 바꾸고 archived 판의 주기도를 정리한다.
3. 커밋 뒤 Publisher가 Backend에 전환된 `bundleId`를 알린다. 알림은 멱등 재시도하며 실패해도 DB 커밋을 되돌리지 않는다.
4. Backend는 알림을 계기로 (1) 이전 판 Redis 캐시 삭제, (2) 9.3 재개 판정, (3) 9.5 라벨 표식을 실행한다.

알림은 전환 감지 지연을 줄이는 신호일 뿐 정본이 아니다. 탐사 API는 요청마다 PostgreSQL의 `current`를 기준으로 판 변경을 검증한다.

## 11. 다른 담당과의 계약

### 11.1 서비스 API(백승학)와의 필드 대응

| 서비스 API 필드 | 탐사 원천 |
|---|---|
| `GET /me` `tutorialCompleted` | `tutorial_stars` 5개를 모두 완료했는지. 재개돼도 유지(4.3절 `completedCount = 5`) |
| `GET /me/stars` 항목 | 4.4절로 대체 |
| `GET /me/histories` 항목 | 8.1절로 대체. `signalId` → `candidateId` |
| 첨부·공개 분석 `graph` | 8.3절 응답을 8.5절 투영 범위로 |
| `POST /public-analyses` 성과 | 9.2절 `recognizeAchievement(type=unconfirmed, recognizedAnalysisId)` |
| 결과 카드 `judgmentSummary` | 6.4절 `judgmentStatistics.kind=public_analyses`는 서비스 F16 DTO를 그대로 포함 |
| `GET /challenges/current` `eligible` | 4.3절과 같은 판정. 별 발견은 9.4절 |
| 별 게시판 열람 자격·[이 별 분석하기] 활성(COM-01·11) | 4.5절 `boardOpen`, `analysisAvailable` |
| 재개·성과 알림 사건 | 9.2·9.3절 이벤트. P1 알림은 서비스 F15 |

### 11.2 분석 프론트(백지웅) 협의 항목 매핑

| Q | 이 문서의 답 |
|---|---|
| Q03 위상 폭·공백 허용 | 5.1절 `selectionRules`, 6.2절 5·6단계. 값은 미결 4 |
| Q04 다중 섹터 기준 시각·전송 형식 | 판 단위 `foldReferenceTimeBtjd` 하나(ERD `publication_bundles`), 5.2절 세그먼트·null 공백. 바이너리는 D-2 |
| Q05 초안 보존·재도전 첫 단계 | 서버는 초안을 저장하지 않음(5.1절). 재도전은 6.8절 초안 → "주기 맞추기" 단계 |
| Q06 후보 노출 경계 | 5.4절 봉우리 투영. `candidateId` 미노출 |
| Q07 경로·DTO·멱등·판 변경 | 2장, 6.4절, 6.6절. 판 변경 감지는 `BUNDLE_CHANGED`와 5.1절 재조회 |
| Q08 잔차 선노출·상태 전달 | 7.2절 폴링, `COMPLETED`에서만 전환. D-3 |
| Q09 진행 중 은퇴 후보 | 판 전환의 분석 복귀(5.1절)와 다시 풀기(6.8절)는 최신 현재 진행 문맥을 사용한다. 히스토리 CURRENT(8.3절)는 최신 원본, SUBMITTED는 당시 snapshot을 사용한다. 대상 신호 자체가 은퇴하면 `CANDIDATE_RETIRED` |
| Q10 ambiguous·구판 힌트·재분류 공개 자격 | 6.4절 ambiguous, 6.7절 힌트는 제출 당시 단계, 재분류 공개 자격은 서비스 F07-Q2(미결) |
| Q11 스냅샷 누락·고조파 좌표 | 8.3절 `snapshot: null`, 접기는 원본 주기 |
| Q12 확인 도구 계산 위치 | 브라우저 계산(서버 API 없음). 입력은 5.2절 곡선 전 점. 관측 부족 기준은 윤성용 |

### 11.3 지도 프론트(하서진) 필드 대응

하서진 PoC·현재 프론트(`experiments/galaxy-map-prototype`, 통합 문서 부록 B)의 필드와 이 문서의 대응이다. 값의 의미가 같은 것은 이름만 바꾸면 된다.

| PoC·현재 프론트 | 이 문서 | 비고 |
|---|---|---|
| GET /map/manifest, /map/tiles | GET /api/v1/me/sky, /api/v1/me/sky/tiles | v1.3 개별 별 표현은 군집 PoC와 응답 구조가 다르다. representation 확인·overview/clusters 제거·cursor 완료 처리·version 격리를 포함한 어댑터 변경과 fixture 교체가 필요하다 |
| `GET /map/tiles?zoom&x&y&w&h&keys` | `GET /me/sky/tiles?level&x&y&w&h&version&limit&cursor` | keys는 제거한다. version 필수, limit/cursor는 페이지 규칙에 따라 사용 |
| `GET /map/galaxy` 전체 배열 | 없음 | NFR-20d 위반이라 폐기(서진 D04) |
| `MapNode.counts {planet, done, new}` | 제거 | 군집 구성을 반환·표시하지 않는다. 개별 별 상태와 전체/범위/현재 적재 수는 별도 값 |
| `GalaxyStar.warmth`, `size` | 저장 x/y·layoutOrdinal → 프론트 appearance | 연출은 personal-galaxy-v1로 유지한다. 순번/저장 좌표로 안정 계산하고 행성 수는 별도 정보 값이다 |
| `StarNode.status unexplored/in_progress/complete` | `progressStage unexplored/in_progress/completed` | ERD enum |
| `StarNode.typeCounts` | `achievement.byType` | 인정된 성과만 |
| `StarDetail.parentId`, `source` | `unlock.triggerTicId`, `unlock.reason` | |
| `StarDetail.magnitude` | `star.tmag` | |
| `StarDetail.knownSignals[].depth`(%) | `planets.items[].depthPpm` | ppm 고정. %는 어댑터에서 ÷10,000 |
| `Quests.tutorials[].state ready/complete` | `tutorial.items[].status unlocked/completed` | `skipped`는 `completionReason` |
| `Quests.tutorials[].purpose` 문구 | `intent` 코드 | 문구는 용어 사전 |
| `Quests.challenge.id`(TIC) | `challenge.ticId` | 회차 ID는 `round.roundId` |
| `Quests.reopened[].id` | `reopened[].ticId` | |
| `ApiSession.member.firstVisit` | `GET /me/sky.firstVisit` (원천은 서비스 `GET /me`) | 완료 시점은 4.1절 "첫 방문 안내" |
| `POST /me/guide` | 없음 | 완료 저장은 첫 제출 성공(서버) 또는 서비스 설정 API |
| `Page<StarNode>.total/page` | `items/nextCursor/hasNext` | 전체 건수 없음 |

### 11.4 데이터·인프라

| 담당 | 항목 |
|---|---|
| 김동혁 | Redis 키·TTL·메모리 상한, 동시 계산 상한·큐, Python Worker 호출 경로, Publisher DB 접속·커밋 후 알림, archived 판 캐시 정리 |
| 윤성용 | `transit_model` 파라미터, `discoverable` 판정, 매칭 허용 오차·N 상한(DEC-03), 봉우리 추출 규칙(5.4절), 잔차 일치 검증 |
| 하서진 | 은하 배치 시각 기준·서버 저장 좌표, 개별 별/타일/배율 연결, 별 상세 패널 필드 |

## 12. 결정안과 미결

### 12.1 결정안 (리뷰 대상)

기존 결정 이력을 유지하며 이번 D-6 및 D-12의 별지도 변경은 SRS·ERD v1.3 변경안과 함께 교차 리뷰한다. 이번 개별 별 표현은 정본 변경을 포함한다. 문서 MR 병합이 실제 API 구현·인수 완료를 뜻하지 않는다. 지도와 무관한 기존 결정은 변경하지 않는다.

| # | 항목 | 결정안 | 이유 | 반영 절 | 확인 |
|---|---|---|---|---|---|
| D-1 | 요청 ID 위치 | 제출만 본문 `requestId`. 헤더 키는 쓰지 않음 | ERD `submissions.request_id`와 일치. 서비스 API도 글·댓글 요청 키를 없앰(SB-D17) | 2.2 | 백지웅 |
| D-2 | 곡선 전송 형식 | JSON 배열, 결측은 `null` | 별당 약 70KB(ERD 용량표). 바이너리는 용량 실측 후 재검토 | 5.2 | 백지웅·윤성용 |
| D-3 | 잔차 상태 전달 | 폴링(`pollAfterSeconds`), `COMPLETED`에서만 곡선 전환, `RESIDUAL_READY` 선노출 없음 | DEC-35 초기값. SSE·선노출은 계산 시간 실측 후 | 7.2 | 백지웅·김동혁 |
| D-4 | 회원별 잔차 요청 상한 | 회원당 진행 중 작업 1개. 초과 시 429 `RESIDUAL_QUEUE_FULL` + `retryAfterSeconds` | 전체 상한 2·대기 20(DEC-35)과 정합 | 7.1 | 김동혁 |
| D-5 | 판 변경 능동 감지 | 탐사 API 모든 응답에 헤더 `X-Current-Bundle: {bundleId}`. 프론트는 잔차 폴링·곡선 응답에서 비교해 달라지면 5.1절 재조회 | 폴링이 이미 돌고 있어 추가 요청 없음. 쓰기 요청은 계속 `BUNDLE_CHANGED`로 거절 | 2.3 | 백지웅 |
| D-6 | 별지도 표현·공간 조회 | **v1.3 변경안:** 서버 저장 은하 좌표·회원별 공간 인덱스/타일 캐시는 유지하고 공식 군집 사전 계산·응답은 제거한다. 모든 level은 개별 별 페이지다. 새 발견/상태 변경 시 영향 범위와 회원 version 갱신, 웹 워커는 투영·히트 테스트 보조 | 제공자/소비자 교차 리뷰 후 적용 | 4.1, 9.2, ERD 항목 8 | 하서진·강재민 |
| D-7 | 지도 최신성 | `asOf`(지도 메타·타일·별 상세·퀘스트)와 `skyVersion`(제출·공개·재개 응답) 채택 | 하서진 통합 문서 B.6 요청. 없으면 화면이 매번 전체 재조회 | 4.1, 6.4 | 하서진 |
| D-8 | 첫 방문 안내 완료 시점 | 둘 다. 튜토리얼 1번 별 첫 제출 성공 시 서버가 `onboarding_done=true`, 사용자가 닫으면 서비스 설정 API로 즉시 true. 별 클릭만으로는 끝내지 않음 | HOME-09 초기 안내 완료 뒤 자동 재노출 없음. GIF 사용법 다시 보기는 상태 변경·분석 실행 없음 | 4.1, 6.3 | 백승학·백지웅·하서진 |
| D-9 | 공개 응답의 성과·새 별 | 서비스 API 공개·일괄 응답 항목에 9.2절 반환값(`newlyRecognized`·`unlockedStars`·`achievement.star`·`skyVersion`)을 그대로 포함 | 제출 응답(6.4절)과 같은 모양이라 프론트 처리가 하나 | 9.2, 11.1 | 백승학·백지웅 |
| D-10 | 완료 별의 `no_candidate` | 저장하지 않고 409 `STAR_ALREADY_COMPLETED` | SUB-11 "다시 제출할 필요는 없다". 저장할 의미 없음 | 6.5 | 백지웅 |
| D-11 | 미발견 별 부족 | 있는 만큼만 열고 응답 `achievement.unlockShortfall`에 부족 수. 성과는 인정 | OPS-08 제외 규칙 안에서 처리. 다음 정본 개정 때 한 문장 추가 제안 | 9.2 | — |
| D-12 | 입력·요청 상한 | 분석 메모 200 코드포인트(2026-09-17 사용자 채택·서버 반영 확인 대기), 타일 요청 상자 `tileSize × 64`, 타일 페이지 limit 기본 1000·최대 2000, 잘못된 cursor 및 `locate`·타일 요청 크기 초과는 400 | 분석 메모는 서비스 댓글의 2,000자와 별도 적용. 타일 상한은 기존 결정 유지 | 4.1, 6.1 | 하서진 |
| D-13 | 챌린지 참여 수 집계 단위 | 대상 별의 **모든** 공식 신호 스레드에서 유효 공개 분석을 가진 회원 ID를 별 단위로 중복 제거(COUNT DISTINCT). 여러 신호에 참여해도 1명, 스레드별 N을 합산하지 않음. 공개 취소·숨김 후 다른 유효 공개가 남으면 포함 | SRS v1.1 안건 15 "회원당 1"의 구체화. 핫 토픽·판단 분포의 신호별 집계는 그대로 | 4.3 | 백승학·하서진 |
| D-14 | 미계산 잔차의 표현 | 캐시 결과도 진행 중 작업도 없으면 `residual: {"status": null, "jobId": null}`. 조회(곡선·초안·히스토리 그래프)는 작업을 만들지 않으며 `null`은 2.4절 상태 열거형에 추가하지 않는다 | 가짜 `QUEUED`·`jobId`로 폴링을 유도하지 않음 | 2.4, 5.2, 6.8, 8.3 | 백지웅 |
| D-15 | 타인 공개 그래프의 잔차 | 첨부·공개 분석을 보는 타인에게는 잔차 재계산 요청을 제공하지 않는다. 캐시된 잔차가 없으면 원본 곡선 또는 제출 스냅샷만 표시하고 둘 다 없으면 "그래프 제공 불가" 안내. 본인 분석의 잔차 요청 권한은 그대로 | 타인 요청으로 계산 자원을 쓰지 않음. 공개 내용(판단·메모)은 계속 표시 | 8.3, 8.5 | 백승학·백지웅 |
| D-16 | Gold 적재·전환 경계 | Publisher가 Gold를 PostgreSQL에 직접 적재하고 한 트랜잭션으로 current를 전환한다. 커밋 후 Backend에는 `bundleId`만 알려 후처리한다 | 대용량 배열을 HTTP로 우회하지 않고 DB 원자성과 앱 읽기 전용 권한을 유지 | 10 | 김동혁·강재민 |
| D-17 | 온라인 계산 호출 경계 | Backend가 현재 판의 DB 배열·후보 모델을 Python Worker에 전달한다. Worker는 DB를 직접 읽지 않고 `astro-kernel`로 계산하며, Backend는 응답 채택 전 current를 재검증한다 | 판 교체 경합을 Backend 한 곳에서 막고 Worker를 순수 계산으로 유지 | 7, 10 | 김동혁·윤성용 |
| D-18 | `stars` 표시 열 | 본인 상세(4.2)는 `tmag`·`teffK`·`radiusRsun` 셋 다, 공개 요약(4.5)은 `tmag`만. 값이 없으면 필드를 빼지 않고 `null`. 단위는 TESS 등급(무차원)·K·태양 반지름 | 4.5에서 온도·반지름을 뺀 것은 비공개가 아니라 그 화면에 자리가 없기 때문이다. 셋 다 TESS 카탈로그에서 TIC 번호로 조회할 수 있는 공개 값이라 서버에서 빼도 감춰지지 않는다 | 4.2, 4.5 | 강재민 |

### 12.2 미결 (실측·타 담당 데이터 필요)

| # | 항목 | 담당 | 처리 |
|---|---|---|---|
| 4 | `selectionRules` 값(위상 폭 min/max, 관측점 없는 구간 허용) | 윤성용·강재민 | DEC-19, Q03. 계약 형태는 5.1절, 숫자만 채움 |
| 5 | 봉우리 추출 규칙(N·최소 간격·고조파), 매칭 허용 오차·N 상한 | 윤성용 | DEC-03, Q06. `operation_settings`에 값만 |
| 12 | 회원 생성 시 튜토리얼 1번 열림 실패 처리(회원 생성 롤백 여부) | 강재민·백승학 | 서비스 F01-Q5 |

해소된 항목: 10(`stars` 표시 열) → D-18, 1(요청 ID, SB-D17) → D-1, 13(참여 수 정의) → SRS v1.1 안건 15, 나머지 옛 2·3·6·8·9·11·14·15·16·17·18 → D-2~D-12.

## 13. 요구사항·검수 추적

| 요구사항 | 절 | 검수 시나리오 |
|---|---|---|
| HOME-01·02·05 | 4.1 | AT-57·58·71 |
| HOME-06·07·09 | 4.3, 9.4 | AT-57·87·88·89 |
| HOME-08 | 4.2 | AT-29·42 |
| HOME-03·04, MY-02, NFR-18 | 4.4 | AT-42·70·83·84 |
| COM-01·11, NFR-06·15 | 4.5 | AT-34·50·64·65 |
| EXP-01·02·10 | 5.1 | AT-03·64·117 |
| EXP-03·04·11·12, NFR-05·10, DEC-22 | 5.2·5.3 | AT-22·73 |
| EXP-05·13 | 5.4 | AT-72·90·91·92 |
| EXP-06·07·08 | 2.5, 6.2 | AT-06·09·59·95 |
| EXP-09, DAT-14 | 7 | AT-08·67·80·101 |
| SUB-01·02 | 6.1·6.2 | AT-07·09·93 |
| SUB-03·04·05·07 | 6.3·6.4 | AT-10·11·13·63 |
| SUB-06·09 | 2.2, 6.3, 9.2 | AT-12·66 |
| SUB-08, RES-07 | 6.4·6.5 | AT-14·37 |
| SUB-10, DEC-18 | 6.8 | AT-54·100·118 |
| SUB-11, DEC-28 | 6.5, 9.3 | AT-55·56·68·69 |
| SUB-12 | 6.5·6.7 | AT-88 |
| RES-01~05·08·11, NFR-09 | 6.4 | AT-04·05·15·16·36·75·116 |
| RES-06, HIS-01·02·06, NFR-12 | 6.3, 8.2 | AT-23·32 |
| HIS-05, GRD-05 | 8.5 | AT-28·30·31·39 |
| RES-09, DEC-17 | 6.7 | AT-04·53 |
| RES-10 | 8.4 | AT-74 |
| HIS-03, NFR-03 | 8.3 | AT-115 |
| HIS-04, MY-03 | 8.1 | AT-26·27 |
| GRD-01·02·03·07 | 6.3, 9.1 | AT-24·25·97·98·99 |
| GRD-04 | 9.2 (서비스 호출) | AT-27·103·107 |
| GRD-06, DEC-26 | 9.5 | (AT 없음, GRD-06 문구) |
| GRD-08, DEC-23 | 9.2 | AT-58·99 |
| DAT-15, DEC-27 | 9.3 | AT-62·83 |
| NFR-01·02 | 2.2, 6.3, 9.2 | AT-12·23 |
| NFR-06 | 2.3, 5.1 | AT-02·64 |
| NFR-14 | 8.5 | AT-39 |
| NFR-19 | 5.1 | AT-58 |

## 14. 변경 이력

| 날짜 | 변경 |
|---|---|
| 2026-09-11 | Draft 0.1. SRS·ERD v1.0 기준 탐사 코어 API 초안. 별 지도 타일·세그먼트 곡선 DTO·제출 처리 순서·잔차 작업·히스토리 그래프·성과 지급 내부 계약 작성. 지웅 Q03~Q12 매핑 |
| 2026-09-11 | 서비스 API MR !24 반영 정합: 오류 본문에서 `requestId` 제거, `IDEMPOTENCY_CONFLICT`·`REQUEST_IN_PROGRESS`·`GRAPH_TEMPORARILY_UNAVAILABLE`을 2.3절에 직접 정의, 8.3절에 판 교체 시 1회 재조회 규칙 추가(SB-D18), D-1 해소(SB-D17) |
| 2026-09-13 | 백승학 통합 정합(`724c560`·`826ce1e`) 수용: 챌린지 참여 수 별 단위 COUNT DISTINCT, 미계산 잔차 `status: null`, 타인 공개 그래프 재계산 없음을 D-13~D-15로 결정안 표에 등록. 2.4절에 `null` 의미 추가. 통합 검토 작업 로그 파일은 변경 이력으로 대체하고 제거 |
| 2026-09-15 | Draft 0.4 / SRS v1.3 변경안. 군집 overview/clusters/clustered 제거, representation 및 개별 별 cursor·rangeStarCount·version 일관성/부분 실패 명시. 모든 level에서 개별 별 제공. 4.1·D-6·D-12·PoC 대응표 정합화. 교차 리뷰 후 적용 |
| 2026-09-14 | Draft 0.3 / SRS v1.2 변경안. 은하형 배치·최종 월드 좌표 저장으로 4.1·9.2·D-6 정합화. MR 리뷰를 반영해 모든 계정을 은하 배치로 통일하고, 같은 회원·TIC의 API별 좌표와 정규화 `depthZ` 범위를 일치시켰다. 공식 군집은 서버 사전 계산으로 확정하고 API 예시를 LOD 5단계로 수정했다. GIF 사용법 다시 보기의 false 재설정 문구를 제거하고 서비스 API의 단방향 완료 규칙과 4.1·D-8 정합화. 4.2에 내 매칭 행성 목록의 범위·개수·단위·빈/실패 상태·3D 표현 구분을 명시(새 API 없음). 구현 및 담당자 승인은 MR 리뷰 대상. |
| 2026-09-11 | 12장을 "결정안(D-1~D-12, 리뷰 대상)"과 "미결(실측·타 담당 대기)"로 재편. 결정안: 본문 `requestId`, JSON 곡선, 폴링·선노출 없음, 회원별 잔차 1개, `X-Current-Bundle` 헤더, 서버 쿼드트리·자리 상수, `asOf`·`skyVersion`, 첫 방문 안내 완료 시점, 공개 응답에 성과·새 별 포함, 완료 별 `no_candidate` 409, 별 부족 시 `unlockShortfall`, 입력·요청 상한. 본문 2.3·6.3·7.1·9.2절에 대응 문장 추가 |
| 2026-09-11 | Draft 0.2. 기준을 SRS·ERD v1.1(`S15P21C206-53`)로 갱신. 하서진 통합 문서·PoC 코드 반영: 타일 요청을 월드 경계 상자(`x,y,w,h`)+`level`로 변경(회전 허용에 따른 역투영), 군집 `counts {planet, done, new}` 채택, 자리 상수 초안값(360/세대·±1.2rad·간격 76·0세대 고정 좌표), 지도 메타 `overview`, `GET /me/sky/locate`(P1), `asOf`·`skyVersion` 최신성 제안, 첫 방문 안내 완료 시점 제안, 챌린지 `description`·`participantCount` 확정, 11.3 지도 프론트 필드 대응표. SRS v1.1 안건 15 해소, 17·18 추가 |
| 2026-09-11 | 백지웅 리뷰 7건 반영. (1) 제출 단계 검증을 "제거 조합 ⊆ 매칭 활성 후보, curveStep = 조합 크기"로 바꿔 다음 잔차 단계·이전 단계 제출 허용. (2) 상위 N 봉우리 포함을 제출 조건에서 제거, 미세 조정 범위를 격자 ±N칸 규칙으로 임의 주기에 적용. (3) 최소 위상 폭을 시간 `minWindowDays`로 주고 주기로 나눠 검증. (4) `requestId`를 제출 전용으로 한정, 잔차는 목표 문맥 재호출로 복구. (5) 완료 판정을 진입·판 전환에도 실행(AT-69). (6) `GET /me/stars?scope=discovered`로 미제출 발견 별 포함(NFR-18). (7) 살구색 조건을 `completedWithoutPlanets`(완료·행성 0)로 정정. 예시 수치 정합(위상 폭 0.01·2.83시간), 설명용 JSON 블록을 유효 JSON으로, Q09 대체 문맥 규칙 통일 |
| 2026-09-14 | C02 후속 정합화. 첫 방문 안내를 서버 단방향 완료와 브라우저 다시 보기로 통일하고, 추천 봉우리 밖이지만 전체 격자 안인 재제출을 허용하도록 6.8절 충돌을 수정. 사용자 결정에 따라 은퇴 경로는 분석 복귀·재도전 `{A,C}`와 History CURRENT 원본으로, 기준 시각은 Bundle 공통값으로, duration 상한은 사용자가 고른 봉우리의 추천값 3배로 확정하고 SRS·ERD·API·정적 JSON 예제를 함께 갱신 |
| 2026-09-17 | S15P21C206-139 구현 반영. 4.3절에 완료 수·챌린지 자격의 공통 판정, 진행 회차가 없을 때의 빈 챌린지 형태, 조회가 별을 열지 않음, `reopened` 조건·정렬과 `newDiscoverableCount` null(S15P21C206-150 전까지)을 명시. 9.4절에 이미 열린 별은 순번·version을 바꾸지 않음, 튜토리얼 완료 후처리의 호출 위치·다음 순번 미설정 시 503, 회차 전환을 주기 실행 대신 운영자 전용 명령으로 실행함을 명시하고 [챌린지 회차 전환 런북](../../../docs/operations/challenge-round-runbook.md)을 연결. 튜토리얼 완료를 한 번 완료하면 유지(재개돼도 `completed_at`으로 판정)로 정하고 4.3·9.3·11.1절에 반영. 챌린지 빨간 느낌표를 발견 경로 대신 퀘스트 `challenge.ticId` 기준으로 바꾸고 4.1절 `marker`에서 `challenge`를 제거, 대상 별을 이미 발견한 회원은 경로를 새로 기록하지 않음을 9.4절에 추가(서비스 F17-Q2 제안). 12.2 미결 12는 백승학 확인 전이라 유지 |

### v1.3 최종 표현안 적용 메모 (227, 2026-09-15)

개인 시제품 기준·연출 색/크기·선택 시에만 내 행성 표시를 반영한다. 원본 캡처·배치/투영 벡터·합성 HTTP 사례는 [별지도 기준 자료](../../../docs/development/sky-reference/README.md)를 따른다. 메타 layoutVersion/presentationVersion, 타일·locate·상세 layoutOrdinal, 상세 version을 필수로 연결하고 구 colorLevel/sizeLevel/orbits는 타일에서 제거한다. 필드 이름만 치환하는 구 어댑터로는 호환되지 않는다. provider/consumer가 같은 fixture를 검토한 후 실제 서버·DB·브라우저 인수를 별도 수행한다.

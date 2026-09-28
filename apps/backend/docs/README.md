# Planetory API 명세 파트 분담

2026-09-21 프론트 기준 P1 구현 인계: [팔로우 등 P1 요청·응답 계약](p1-service-contract.md)을 먼저 확인한다. 서진 요청으로 프론트가 소비 계약을 구체화했으며 백엔드 구현·배포 완료와 구분한다.

- 작성일: 2026-09-11
- Jira: [S15P21C206-36 · API 명세서 작성](https://ssafy.atlassian.net/browse/S15P21C206-36) (상위 Epic `S15P21C206-26`)
- 작성: 강재민. 백승학과 파트를 나누어 각자 작성한 뒤 이 문서를 인덱스로 합친다.
- 기준: [요구사항 명세서 v1.1](../../../docs/requirements/planetory-requirements-spec.md), [ERD v1.1](../../../docs/architecture/database-erd.md), [팀 역할 분배](../../../docs/project/team-role-allocation.md)
- 관련 초안: 백승학 [서비스 API 명세](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/24) (MR !24, 브랜치 `docs/S15P21C206-30-service-backend-feature-analysis`), 백지웅 [분석 프론트 상세 명세·Mock 계약](https://ssafy.atlassian.net/browse/S15P21C206-49) (브랜치 `docs/S15P21C206-49-docs-analysis-contract`)
- 상태: 분담 제안. 경로·필드·상태 코드는 팀 검토 전 제안이며, SRS v1.0과 다른 결정은 여기서 확정하지 않고 팀 결정 항목으로 올린다.

## 1. 목적

API 명세를 두 사람이 나눠 쓰면서 경로·필드·오류 형식이 어긋나지 않도록 담당 영역, 공통 약속, 서로 넘겨받는 계약, 문서 위치를 먼저 정한다. 이 문서는 두 명세가 합쳐진 뒤에도 "어느 API가 어느 문서에 있는지"를 찾는 인덱스로 남긴다.

## 2. 담당 분담

역할 분배 문서의 도메인 경계를 따르되, 데이터 소유자가 API를 쓴다는 원칙으로 회색 지대를 나눴다. 별 지도·별 상세·퀘스트는 데이터(StarUnlock 자리, UserStarProgress 등급·완료·재개 대기, 튜토리얼 순번)가 모두 탐사 도메인이므로 강재민이 맡는다.

| 영역 | 담당 | 요구사항 ID | 문서 |
|---|---|---|---|
| 회원·세션·프로필·설정 | 백승학 | ACC-01~05, MY-01·04, DEC-34 | 서비스 API 명세 3장 |
| 피드·검색·핫 토픽 | 백승학 | COM-03·09·15, DEC-09 | 서비스 API 명세 4장 |
| 일반 글·댓글·히스토리 첨부 조회·출처 카드 | 백승학 | COM-01·02·04~07·10~12·20, HIS-05 | 서비스 API 명세 5~7장 |
| 동의·비동의·반응자 목록 | 백승학 | COM-08 | 서비스 API 명세 8장 |
| 공식 스레드·공개 분석 등록·취소·목록·일괄 공개 | 백승학 | COM-14·17~19, GRD-04(공개 시점) | 서비스 API 명세 9장 |
| 챌린지 회차 조회 | 백승학 | CHL-01, HOME-07(챌린지 카드 원천) | 서비스 API 명세 11장 |
| 숨김 상태 적용, 팔로우·알림·통계(P1) | 백승학 | COM-13·16, NTF-01·02, STA-01~04 | 서비스 API 명세 10·12장 |
| **별 지도 타일·별 상세 패널·퀘스트 패널** | **강재민** | HOME-01·02·05·06·07·08·09, NFR-18·20a~e, DEC-30·32 | 탐사 API 명세 |
| 분석 진입·현재 판·곡선 세그먼트·주기도·후보 투영 | 강재민 | EXP-01~05, DAT-11, POL-05 | 탐사 API 명세 |
| 제출·검증·매칭·결과·상세 보기·다시 풀기·건너뛰기 | 강재민 | SUB-01~12, RES-01~11, 5장 매칭 규칙 | 탐사 API 명세 |
| 온라인 잔차 작업 요청·상태·결과 곡선 | 강재민 | EXP-09, DAT-14, DEC-35 | 탐사 API 명세 |
| 히스토리 목록·상세·그래프(당시/최신)·별 결과 페이지 | 강재민 | HIS-01~04·06, RES-10, MY-02·03 | 탐사 API 명세 |
| 성과·등급·별 열림·완료·재개·외부 라벨 표식 | 강재민 | GRD-01~08, SUB-11, DAT-15, DEC-23·26·27 | 탐사 API 명세 (조회 API + 내부 계약) |
| 내 별 목록(MY-02) | 강재민 | MY-02 | 탐사 API 명세. 서비스 명세 3.2절의 최소안을 대체 |

### 회색 지대 결정

| 항목 | 결정 | 이유 |
|---|---|---|
| `GET /me/stars`, `GET /members/{id}/stars` | 강재민이 MY-02 전체 필드로 정의. 승학 3.2절은 이 정의를 참조 | 진행 단계·행성 수·등급·곡선 단계·미게시 수가 모두 탐사 데이터 |
| `GET /me/histories` | 강재민이 정의. 승학 7.1절의 항목 구조를 출발점으로 삼고 필드명을 ERD에 맞춤(`signalId` → `candidateId`) | 승학 명세도 "하나의 계약, 중복 구현 금지"로 표기 |
| 첨부·공개 분석의 그래프 배열 | 강재민이 세그먼트 곡선 DTO를 정의. 승학 7.2절은 참조로 교체 | ERD `light_curve_segments` 구조·잔차 캐시 상태를 담아야 함 |
| 챌린지 별 발견 처리 | 강재민(발견·자리 계산·멱등). 회차 조회는 승학 | StarUnlock은 탐사 소유 |
| 튜토리얼 완료 판정(`tutorialCompleted`) | 강재민이 제공. 승학 `GET /me`가 읽음 | user_star_progress 기준 |
| 미확정 성과 인정(공개 시점) | 승학의 공개 트랜잭션이 강재민의 성과 지급 공통 함수를 호출 | SB-D15 합의 그대로 |

## 3. 공통 약속

백승학 명세 2장을 공통 약속으로 상속한다. 두 문서가 모두 지킬 항목만 아래에 다시 적는다.

| 항목 | 규칙 |
|---|---|
| 경로·본문 | `/api/v1`, JSON, camelCase. 204 응답은 본문 없음 |
| ID | 모두 문자열. `ticId`, `candidateId`, `submissionId`, `historyId`, `bundleId`, `publicAnalysisId`, `threadId`, `memberId` |
| 시각 | ISO 8601 UTC 문자열. BTJD 값은 숫자(일 단위)이며 UTC로 변환하지 않음 |
| 목록 | `items`, `nextCursor`, `hasNext`. size 기본 20·최대 100 |
| 오류 | `{code, message, fieldErrors[], requestId}`. 401 `AUTH_REQUIRED`, 403 `FORBIDDEN`, 404 `RESOURCE_NOT_FOUND`, 409 충돌, 503 `DEPENDENCY_UNAVAILABLE` |
| 인증 | 세션 쿠키. 본문에 회원 ID·권한을 받지 않음 |
| 공개 상태 | 삭제·숨김·상위 스레드 숨김·본인 공개 취소를 매 조회 적용 |

탐사 명세에서 추가하는 공통 항목:

| 항목 | 규칙 |
|---|---|
| `curveContext` | `bundleId`, `curveStep`, `removedCandidateIds`(정렬), `residualModelVersion`, `periodogramConfigVersion`. 곡선을 단계 번호만으로 식별하지 않음 |
| 요청 ID | 제출만 본문 `requestId`(UUID)를 받아 ERD `submissions.request_id`에 저장. 잔차 요청은 목표 곡선 문맥이 멱등 단위, 상세 보기는 제출 ID에 대해 멱등 |
| 판 교체 | 요청의 `bundleId`가 현재 판과 다르면 409 `BUNDLE_CHANGED` + `currentBundleId` |
| 별 잠김 | 회원에게 열리지 않은 별의 분석·제출·곡선 요청은 403 `STAR_LOCKED` |
| 잔차 상태 | `QUEUED`, `RESIDUAL_CALCULATING`, `RESIDUAL_READY`, `PERIODOGRAM_CALCULATING`, `COMPLETED`, `FAILED` |
| 지웅 Mock 대응 | 구판 fixture의 snake_case 필드는 camelCase로 1:1 대응. 대응표는 탐사 명세 부록 |

해소(2026-09-11): 서비스 API는 글·댓글에 요청 키를 두지 않기로 했다(SB-D17). 요청 ID는 탐사 API의 본문 `requestId`뿐이다.

## 4. 서로 넘겨받는 계약

| 제공 → 소비 | 계약 | 정의 위치 |
|---|---|---|
| 강재민 → 백승학 | 히스토리 목록·상세 DTO(첨부 선택·공개 검토 화면이 사용) | 탐사 명세 |
| 강재민 → 백승학 | 세그먼트 곡선 DTO·히스토리 그래프(당시/최신) | 탐사 명세 |
| 강재민 → 백승학 | 성과 지급 공통 함수: 입력(회원, 후보, 유형, 근거 제출·공개 분석) → 출력(신규 여부, 성과 수, 열린 별). 회원 행 잠금 순서 포함 | 탐사 명세 내부 계약 |
| 강재민 → 백승학 | 튜토리얼 완료·챌린지 자격·별 발견 멱등 처리 | 탐사 명세 내부 계약 |
| 강재민 → 백승학 | 재개 이벤트(별·판·사유·대상 회원) → 알림(P1)·퀘스트 카드 | 탐사 명세 내부 계약 |
| 강재민 → 백승학 | 외부 라벨 갱신 표식(`relabeledAt`, `relabelDisposition`) 표시 규칙 | 탐사 명세 |
| 백승학 → 강재민 | 공개 분석 상태(`publication`)·판단 통계 DTO(결과 카드 RES-11이 사용) | 서비스 명세 9장 |
| 백승학 → 강재민 | 챌린지 현재 회차(대표 `target_tic_id`와 추가 대상, 기간) | 서비스 명세 11장 |
| 강재민 ↔ 백지웅 | 지웅 Q03·04·05·06·07·08·09·10·11·12의 답 | 탐사 명세 각 절에 Q 번호 표기 |
| 강재민 ↔ 김동혁 | Redis 캐시 키·TTL, Python Worker 호출, Publisher의 PostgreSQL 적재·커밋 후 알림 | 탐사 명세 10장·결정 D-16·17 |
| 강재민 ↔ 윤성용 | `transit_model`, `discoverable`, 매칭 허용 오차(DEC-03), `candidate-peaks` 투영 범위 | 탐사 명세 미결 표 |

## 5. 탐사 API 초안 목록 (강재민)

경로는 제안이다. 우선순위는 SRS v1.0을 따른다.

| 기능 | 우선 | 메서드·경로 | 근거 |
|---|---|---|---|
| 별 지도 메타·타일 | P0 | `GET /me/sky`, `GET /me/sky/tiles?level=&x=&y=&w=&h=` (월드 경계 상자, 회전 역투영) | HOME-01·05, NFR-20a·d, DEC-30·32 |
| 검색 별 위치 조회 | P1 | `GET /me/sky/locate?ticId=` | HOME-04, NFR-20d |
| 별 상세 패널 | P0 | `GET /me/stars/{ticId}` | HOME-08, GRD-07 |
| 퀘스트 패널(튜토리얼·챌린지·재개 카드) | P0 | `GET /me/quests` | HOME-06·07·09, DEC-27 |
| 내 별 목록 | P0 | `GET /me/stars`, `GET /members/{memberId}/stars` | MY-02, DEC-34 |
| 별 목록 뷰(WebGL 대체) | P0 | `GET /me/stars`와 동일 응답 재사용 | NFR-18 |
| 공개 별 요약(게시판 열람 자격·분석 진입 가능 여부) | P0 | `GET /stars/{ticId}` | COM-01·11, NFR-06 |
| 분석 진입·현재 판 | P0 | `GET /stars/{ticId}/analysis-context` | EXP-01·02·10 |
| 곡선(원본·잔차 공용) | P0 | `GET /stars/{ticId}/curves?curveStep=&removed=` | EXP-03, DAT-11 |
| 주기도 | P0 | `GET /stars/{ticId}/periodogram?curveStep=&removed=` | EXP-04 |
| 후보 투영(봉우리·미세 조정 범위) | P0 | `GET /stars/{ticId}/candidate-peaks?curveStep=` | EXP-05, POL-05, 지웅 Q06 |
| 제출 | P0 | `POST /stars/{ticId}/submissions` | SUB-01~09·11·12, 5장 |
| 제출 결과 조회·요청 ID 복구 | P0 | `GET /submissions/{id}`, `GET /submissions/by-request/{requestId}` | SUB-09, RES-01~05·11 |
| 상세 보기 | P0 | `POST /submissions/{id}/detail-view` | RES-02·09, DEC-17 |
| 다시 풀기 초안 | P0 | `GET /submissions/{id}/retry-draft` | SUB-10, DEC-18 |
| 잔차 작업 | P0 | `POST /stars/{ticId}/residual-jobs`, `GET /residual-jobs/{jobId}` | EXP-09, DAT-14 |
| 히스토리 | P0 | `GET /me/histories`, `GET /histories/{id}`, `GET /histories/{id}/graph?mode=CURRENT|SUBMITTED` | HIS-01~04·06, MY-03 |
| 별 결과 페이지 | P0 | `GET /stars/{ticId}/result` | RES-10 |
| 성과·등급 요약 | P0 | `GET /me/achievements?ticId=` | GRD-01·07 |
| 내부: 성과 지급·별 열림 | P0 | HTTP 아님. 서비스 계층 함수 | GRD-02~04·08, NFR-01 |
| 내부: 완료·재개 판정 | P0 | HTTP 아님. 제출 트랜잭션·배치 후처리 | SUB-11, DAT-15 |
| 내부: Gold 전환 후처리 | P0 | 적재 API 없음. Publisher 커밋 후 `bundleId` 알림으로 캐시·재개·라벨 처리 | DAT-11·15, 김동혁 |

## 6. 서비스 API 목록 (백승학, MR !24 기준)

승학 명세 1장의 목록을 그대로 참조한다. 이 문서에서는 경계에 걸린 항목만 표시한다.

| 항목 | 처리 |
|---|---|
| `GET /me`의 `tutorialCompleted` | 탐사 판정값을 읽음 |
| `GET /me/stars`, `GET /members/{id}/stars` | 탐사 명세 정의로 대체 |
| `GET /me/histories` | 탐사 명세 정의로 대체 |
| 첨부·공개 분석 `graphMode` 응답 | 탐사 명세의 세그먼트 곡선 DTO·히스토리 그래프 참조 |
| `POST /public-analyses`, `/batch` | 성과 부분은 탐사 공통 함수 호출 |
| `GET /challenges/current` | 별 발견은 탐사 내부 계약 |

## 7. 문서 위치와 병합 방식

- 위치: 저장소 구조 문서에 따라 백엔드 문서는 `apps/backend/docs/`에 둔다. 승학 초안도 MR !24에서 같은 경로로 이동했다.
- 파일: `apps/backend/docs/service-api-spec.md`(백승학), `apps/backend/docs/exploration-api-spec.md`(강재민), 이 문서를 인덱스로 유지한다. 한 파일로 합치지 않는다.
- 브랜치: `docs/S15P21C206-36-api-spec`. 승학 MR이 먼저 병합되면 공통 약속은 링크로 참조하고 중복 서술을 지운다.

## 8. 미결·확인 항목

| # | 항목 | 담당 | 처리 |
|---|---|---|---|
| 1 | ~~요청 ID 위치(헤더 vs 본문)~~ 해소: 탐사 본문 `requestId`만 사용(SB-D17) | 강재민·백지웅 | Q07 프론트 확인 |
| 2 | 곡선 배열 전송 형식(JSON null 공백 vs 바이너리) | 강재민·백지웅·윤성용 | 지웅 Q04. v1은 JSON 기본안, 용량 실측 후 재검토 |
| 3 | 잔차 상태 전달(폴링 vs SSE), 부분 준비 선노출 | 강재민·김동혁·백지웅 | 지웅 Q08, DEC-35. v1은 폴링 기본안 |
| 4 | 위상 폭 최소·최대 | 윤성용·강재민 | DEC-19 |
| 5 | 매칭 허용 오차·N 상한 | 윤성용 | DEC-03. 명세는 설정 참조만 |
| 6 | 별 지도 타일 인덱스(세대 vs 공간) | 강재민·하서진 | ERD 미결 8 |
| 8 | 검색·핫 토픽 P0 상향, DEC-09 산식 | 팀 | 승학 MR !24 리뷰 지적. 10.1 안건 5 |
| 9 | 미발견 별이 `stars_per_achievement`보다 적을 때 | 강재민 | OPS-08 제외 규칙에 추가 제안 |

## 9. 작업 순서

1. 이 분담 문서를 승학과 확인한다(2장 회색 지대 6건).
2. 탐사 명세 공통 약속·목록 표를 쓰고 지웅 Q 번호를 각 절에 매핑한다.
3. P0 상세를 별 지도 → 분석 진입 → 제출·결과 → 잔차 → 히스토리 → 성과 순으로 채운다.
4. 요구사항 ID 커버리지 표와 AT 시나리오 매핑을 붙인다.
5. MR을 만들고 승학·지웅에게 교차 리뷰를 요청한다. Jira `S15P21C206-31`에 결과 링크를 남긴다.

- [공개 은하 계약 (250)](public-sky-contract.md): 전체 보유 별과 공개 범위·방문자 읽기 전용 API.


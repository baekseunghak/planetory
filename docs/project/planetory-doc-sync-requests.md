# Planetory 원본 문서 정합화 요청

- 작성일: 2026-09-11
- 상태: 완료. 2026-09-11 SRS v1.1·ERD v1.1에서 R1·R2·R6~R9·D1·D2 반영, 2026-09-15 R3~R5 반영
- 작성: 백승학 / 서비스 백엔드
- 관련 작업: S15P21C206-30

2026-09-11 기준으로 원본 문서에 남은 옛 문구를 모았다. [서비스 백엔드 기능 분석](../development/service-backend/README.md)과 [서비스 API 명세](../../apps/backend/docs/service-api-spec.md)는 오른쪽 “최신 기준”을 적용한다. **원본 문서는 수정하지 않았고** 각 문서 담당자에게 반영을 요청한다. 반영되면 해당 행을 완료로 표시한다.

| # | 문서·위치 | 현재 문구 | 수정 제안 | 근거 |
|---|---|---|---|---|
| R1 ✅ v1.1 | ERD 4장 결정 5 | “판 자체는 직전 것만 짧게 보존한다” | “판 행은 제출 참조용으로 남기고, 이전 판의 주기도·캐시는 archived 전환 시 정리한다” | ERD publication_bundles.status(이전 판 미보존, 결정 C) |
| R2 ✅ v1.1 | ERD 4장 결정 6 | 축약 스냅샷 ≈1.8KB | ≈1.2KB(float32 배열 2개×150개, 메타데이터·행 오버헤드 별도) | ERD analysis_snapshots.folded_flux/folded_err |
| R3 ✅ 2026-09-15 | system-architecture.md 3장, Gold 공개 규칙, 미결 목록 | Gold 파일 `releases/<id>`·`previous` 보존, 세션의 Bundle 고정, Redis는 필요 시 추가 | PostgreSQL Gold 배열, 최신 판 재로드, Redis 확정으로 반영. Publisher 직접 적재·커밋 후 알림 경계도 함께 기록 | ERD v0.3 결정·결정 C, SRS DAT-14, SB-D07·18 |
| R4 ✅ 2026-09-15 | online-derived-compute.md 판 변경·캐시·용량 | 세션에 Bundle 고정, `current`·`previous` 보존, PostgreSQL+EC2 로컬 파일 | Redis 상태·결과·잠금, Backend 전달형 Python Worker, 응답 채택 전 current 재검증으로 반영 | SRS DAT-14, 상태표 v0.15, SB-D18 |
| R5 ✅ 2026-09-15 | data-guidelines.md PostgreSQL Gold 공개 | `releases/`·`current`·`previous` 심볼릭 링크 전환 | Publisher가 PostgreSQL 배열 적재와 status 전환을 한 트랜잭션으로 수행하도록 반영. 검증 실패 시 기존 current 유지 | ERD Gold DB 배열 결정, S15P21C206-134 |
| R6 ✅ v1.1 | SRS AT-77 | 전체 통계가 “어제자 StatsSnapshot” 기준 | “전체 통계는 10분 갱신 materialized view 기준 시각으로, 비교 탭은 일별 StatsSnapshot의 90일 활동 회원 중앙값으로 표시” | SRS STA-02·DAT-13, F19 |
| R7 ✅ v1.1 | SRS COM-17 | “관리자 권한 계정은 숨김·복원을 담당”, “MVP는 … 숨김·복원을 제공” | “v1은 운영 화면·API 없이 운영자가 DB에서 hidden 상태를 변경한다(COM-13·OPS-06)” | SRS COM-13·OPS-01·OPS-06, F12·F22 |
| R8 ✅ v1.1 | SRS CHL-03 | “목표 달성·기간 종료·운영 취소 상태와 완료 성과를 기록”, 마감 제출 반영 | “회차 상태(planned/active/closed)와 기간을 기록한다. 챌린지 전용 달성·성과·보상은 없다” | 삭제된 CHL-02, POL-24, ERD ChallengeRound, F17 |
| R9 ✅ v1.1 | ERD posts 인덱스 | (tic_id, kind, created_at DESC), (user_id, created_at DESC)만 있음 | `CREATE EXTENSION pg_trgm`, posts.title·posts.body GIN(gin_trgm_ops) 인덱스 추가. board·tag 필터 인덱스는 측정 후 결정 | SB-D24 검색 범위 확장(SRS COM-03) |

**정합화가 아니라 요구사항 변경이라 팀 결정이 필요한 항목**

| # | 문서·위치 | 차이 | 처리 |
|---|---|---|---|
| D1 ✅ | SRS COM-03·09 우선순위 | 검색 대상 필드는 SB-D24로 COM-03과 일치 | **2026-09-11 팀 결정(SRS v1.1 안건 13): P0 상향.** 2026-09-20 170에서 서비스 API·기능 분석의 현행 표기를 P0로 정정했다. [검색 공통 표본](../api/community/README.md)의 세부 계약 교차 검토와 구현 인수는 별도다 |
| D2 ✅ | SRS RPT ↔ ERD expert_reports | RPT는 P1인데 ERD는 expert_reports를 제외 | **SRS v1.1 4.13에서 "표의 P1은 재도입 시 우선순위, v1 범위 아님"으로 정리.** F20 보류 유지 |

**해결됨**

| # | 문서·위치 | 차이 | 처리 결과 |
|---|---|---|---|
| D3 | SRS DEC-09·10.1 안건 5 핫 토픽 산식 | 기본안: 최근 7일 (답글 수 + 동의·비동의 수) 가중, 별 스레드 기준 | 2026-09-11 팀 확정: 대안 SB-D16(공식 스레드 유효 참여자 세 판단 합계 N >= 10, 기간 제한 없음, 일반 글 제외) 채택. SRS·API 4.2·F13 함께 갱신 완료 |

## S15P21C206-227 개인 시제품 기준 정합화 (2026-09-15)

사용자 결정은 [표현 계약](../development/sky-presentation-contract.md)과 [기준 자료](../development/sky-reference/README.md)에 기록한다. 현행 SRS·API·ERD·상태표·와이어프레임·역할·Jira의 연출 색/크기·선택 궤도·안정 배치/순번·페이지 계약을 같은 변경안으로 맞춘다. 문서상 충돌 제거와 사용자 결정 반영 상태이며 강재민/서진의 제공자·소비자 리뷰와 MR !41 병합은 대기한다. 기존 R3~R5 등 다른 영역의 요청 상태를 바꾸지 않는다.

## S15P21C206-114 비닝·산포 정합화 (2026-09-20)

상태: **MR !101 재리뷰 대기**. 김동혁의 처리·운영 리뷰를 근거로 [Gold 4.1 채택안](../../contracts/gold/README.md#41-s15p21c206-114-비닝-운영-채택안)과 ERD의 산포 설명을 함께 정정했다. `flux_scatter`는 전체 유한 비닝 flux의 robust 산포이며 점별 오차가 같다는 근거로 쓰지 않는다. 운영 10분 상한 초과의 자동 확대 설명도 실패·격리 채택안으로 맞춘다. counts는 배치 진단에 보존하며 Gold에는 추가하지 않는 이유·한계는 [실측 및 인계](../data/tess-binning-benchmark.md#운영-채택안과-115123-인계)에 둔다.

이는 정본의 **변경안**이며 운영 구현·배포 완료가 아니다. 김동혁 처리·운영 재리뷰와 Backend 계약 소비자 검토 시 이 의미 변경을 확인한다. 승인 후 123에서 구현·revision 검증을 수행하고, 131과 수치 허용 오차를 측정한다. `qa-tolerances.v0.json`의 `pending-measurement`를 임의의 통과값으로 바꾸지 않았다.


### 114 추가 정합화 — 9942ee67 재검토 반영

상태: 추가 보완·재리뷰 대기. 서비스/탐사 API·처리 역할·리뷰 체크리스트의 자동 확대·NaN·점별 오차 설명을 Gold와 맞췄다. develop의 143 변경(v1.11)을 보존하여 ERD v1.12에 114 변경 요약을 추가했고 상태가 포함된 Gold 제목·앵커를 고정 문구로 교체했다. 123은 GoldCatalogViews.java 설명을 정정한다. DB COMMENT는 아래 123 리뷰 후속으로 이관하며 기존 V1은 보존한다. counts 전용 첨부·검산 절차는 비닝 벤치마크를 따른다. 이전 develop 통합은 e8f62ea에서 커밋·push까지 완료됐다. 최종 리뷰에 따라 최신 develop `2c1c857c591647289bb1e9803080a663d815c00e`의 119 추가 마스킹 항목과 114 항목을 모두 보존하도록 통합했다. 현재 승인 여부는 MR !101에서 관리한다.
## S15P21C206-119 추가 마스킹 기준 정합화 (2026-09-20)

상태: **!107 리뷰 반영·후속 245 등록, 재리뷰 대기**. 상단의 과거 R1~R9 완료와 별개다.
SRS DAT-02는 Sector 시작·궤도 근점 추가 마스킹을 요구하지만 [42 결과 6절](../data/tess-preprocess-benchmark.md)은
고정 6·12시간 가장자리 제외의 관측점 손실 대비 이득이 작아 기본 적용하지 않는다고 기록한다.
윤성용은 2026-09-20에 42 결과대로 구현하고 이 차이를 MR에서 함께 검토하도록 요청했다.
[119 계약](../../libs/astro-kernel/README.md#silver-전처리-119)은 **42/D03 기준 공용 전처리 기본 커널**로 한정한다.
김동혁은 !107 리뷰에서 고정 6·12시간 일괄 제외를 넣지 않는 판단에 동의했으며, 실제 확인된 불량 구간의 별도
마스킹 요구는 유지하도록 요청했다. DAT-02 전체 구현 완료로 표시하지 않는다. SRS 본문은 이번 보완에서 변경하지 않는다.

후속 [S15P21C206-245](https://ssafy.atlassian.net/browse/S15P21C206-245)를 등록했다(담당 윤성용, 해야 할 일).
적용 계층은 FITS 파싱 후 Silver 입력 준비 단계이며 정규화·추세 계산 전에 적용한다. 원본 행을 먼저 삭제하지 않고
product_id·원본 source_row·cadenceno·원래 QUALITY·원본 시각·모든 제외 사유·근거 구간 및 마스크 버전을 보존한다.
현재 커널이 원래 QUALITY까지 보존하는 추가 마스킹 연결을 완료한 것은 아니다. 구간 근거·경계·실패·추적 회귀는
245의 완료 조건이며 127에 인계한다. SRS 정합화 방향은 “일괄 6·12시간 제외는 적용하지 않고, 확인된 Sector 시작·
궤도 근점 불량 구간은 근거 있는 구간만 별도 마스킹”이다. 요구 삭제로 처리하지 않는다.


### 2026-09-21: 245 구현·로컬 검증 보완

245에서 구간별 제품/근거 SHA, 원본 QUALITY와 모든 겹친 제외 사유를 보존하는 입력 계약을 구현했다.
[실측 범위와 근거](../../experiments/tess-bench/README.md#245-근거-구간-마스크-검증), [소비 계층·재처리 계약](../../libs/astro-kernel/README.md#근거-구간-마스킹-245)을 따른다.
실제 Sector 3 DR42 표본에서는 추가 제외가 없으며 근거 구간 운영 채택·127 연결 리뷰는 남아 있다.
SRS의 DAT-02 요구를 완화하거나 전체 범위 완료로 변경하지 않는다.


245의 별도 `docs/data/tess-interval-mask-validation.md`는 사용자 요청으로 삭제하고
[기존 tess-bench README](../../experiments/tess-bench/README.md#245-근거-구간-마스크-검증)에 통합했다.
같은 검증 범위에 별도 문서를 다시 만들지 않는다.

## S15P21C206-153 GRD-06 재분류 표식 위치 (2026-09-21)

| 문서·위치 | 현재 문구 | 수정 제안 | 근거 |
| --- | --- | --- | --- |
| SRS GRD-06 | "AnalysisHistory와 UserCandidateAchievement에 재분류 표식(relabeled_at, new_disposition)만 남기고" | "UserCandidateAchievement에 재분류 표식(relabeled_at, relabel_disposition)을 남기고" | `analysis_histories`에는 두 열이 없다(V1 스키마). 탐사 API 9.5절과 현재 구현은 성과 행에만 두고, 히스토리 화면 표식은 `(user_id, candidate_id)` 조인으로 만든다 |

**이 차이가 남기는 것:** 성과가 없는 히스토리는 「기록이 갱신됨」을 표시할 수 없다. 미확정 미공개 기록과 판단 불일치 기록이 여기에 해당한다.
그 기록에도 표식이 필요하다면 문구 정정이 아니라 스키마를 늘리는 요구사항 변경이므로 팀 결정이 필요하다.
판단 근거는 [후보 병합·분리 정정 계약](../architecture/candidate-correction-contract.md) 2장 S6에 정리했다. 다른 영역의 요청 상태는 바꾸지 않는다.

## S15P21C206-123 제공 격자·null 게시 경계 (2026-09-22)

115의 실험 격자 `max(40, 최장 주기)`와 기존 API·Gold의 `max(40, 1.15 × 최장 주기)` 차이를 확인했다.
담당자 윤성용은 기존 API·Gold 계약에 맞춰 123을 구현하고 새 비교 실험을 실행하는 방향을 선택했다.
옛 실험 수치로 새 격자의 성능을 확정하지 않는다. null은 새 Bundle 전체 보류·기존 current 유지로 처리한다.
상세 정본은 [Gold 계약 4.2절](../../contracts/gold/README.md#42-s15p21c206-123-discoverable-연결게시-경계)이다.
상태: 구현·로컬 검증, FITS 비교·수치 규칙 채택 근거 확인·후속 리뷰 전. API·DB boolean 타입 변경은 없다.

### 123 리뷰 후속: bin 중심 소비자 정합화

2026-09-23 범위 정정(S15P21C206-247): 표시·접기 소비자는 192의 사용자 승인으로 이미 중심 기준이며, 247은 [탐사 API 5.2·6.2·8.3절](../../apps/backend/docs/exploration-api-spec.md)과 History 설명을 정합화한다. 아래 후속 목록 전체의 완료를 뜻하지 않는다. `SubmissionMatching.windowsOf`의 시작 기반 관측 판정은 142의 별도 승인 계약이므로 중심으로 바꾸려면 별도 결정을 받아야 한다. `analysis-data.ts`의 끝 계산은 마지막 점이 아니라 세그먼트 범위 끝 검증이므로 반 bin을 빼지 않는다. DB COMMENT·마이그레이션 적용 검증은 247 범위 밖으로 유지한다.

247 데이터 처리 리뷰의 후속 제안(미승인): 현재 관측 창 `[첫 bin 시작, 마지막 bin 시작]`에는 마지막 bin 중심이 포함되지 않는다. 창을 bin이 덮는 범위 `[첫 bin 시작, 마지막 bin 시작 + binMinutes / 1440)`로 정의하는 대안을 142 담당과 검토한다. 이는 창 정의와 경계 포함 규칙의 변경이므로 관측점 존재·통과 수·매칭 판정을 함께 검토하고 별도 승인·회귀 검증을 거쳐야 한다. 247에서는 채택하거나 구현하지 않는다.

상태: 후속 Task 등록 대기(아직 Jira 키 없음). 123 리뷰에서 기존 소비자 불일치를 확인했다.
Backend·Frontend 담당자가 함께 처리할 작업이며 이번 123에서 소비자 계산 코드를 변경하지 않는다.

- 대상: Backend `SubmissionMatching.observedWindows`의 실제 시작/끝 계산 및 javadoc,
  `AnalysisViews` 설명, Frontend `fold-data.ts`, `history-graph.ts`, `time-curve.ts`의 BTJD,
  `analysis-data.ts` 마지막 점 검증. 기준은 `start_btjd + (i + 0.5) × bin_minutes / 1440`이다.
- `FoldedSnapshot`의 기존 bin 중심 결과와 같은 입력으로 대조하고, 관측 창·빈 bin·첫/마지막 점 및
  제출 매칭 경계가 서버/화면에서 일치하는 회귀 테스트를 추가한다. 10분 bin의 기존 5분 차이를 확인한다.
- `start_btjd` DB COMMENT를 '첫 bin 시작 시각'으로 정정한다. V1은 수정하지 않고 신규 migration으로 처리한다.
  산포 COMMENT도 함께 정정·검증한다. 번호는 미정이며 열린 브랜치·적용 이력과 병합/배포 순서를 확정한 뒤 부여한다.
- 완료 조건: 소비자 코드·API 설명·DB COMMENT 정합화와 경계 회귀·DB 적용 검증, 담당 리뷰를 기록한다.

리뷰어는 `prepare_discoverability`를 진입점으로 고정하는 조건으로 123 규칙의 후속 적용에 동의했다.
1.15배 상한의 실제 데이터 효과는 여전히 미검증이다. 조건부 승인을 운영 배포 승인으로 해석하지 않는다.

123 Backend 리뷰 후속 갱신: 강재민이 M1 Backend 수정·matching-cases 표본 재검증·과거 제출 재판정 금지 확인을 자신의 후속 티켓으로 인수한다고 답했다. Frontend 4곳은 API 계약 확정 후 연결한다. start_btjd COMMENT 정정도 같은 후속 범위다. 실제 Jira 키는 아직 전달받지 않았다. Publisher 87 인계의 READ COMMITTED·FOR SHARE 대기 경계는 Gold 계약 4.2절에 기록했다.

<a id="123-review-comment-handoff"></a>

### 123 COMMENT migration 분리 결정

사용자 요청으로 123의 V22 산포 COMMENT와 전용 검사 단계를 제거했다. 계산 커널·판정 기준은 변경하지 않는다.
후속 정정 문구는 다음과 같다.

- `light_curve_segments.start_btjd`: 첫 bin 시작 시각(BTJD). flux[i]의 시각은 start_btjd + (i + 0.5) × bin_minutes / 1440.
- `light_curve_segments.flux_scatter`: 세그먼트의 유한 비닝 flux 전체에 대한 1.4826 × MAD. 무차원 상대 flux이며 통과·별 변동 포함. 점별 측정 오차·통과 밖 잡음·역분산 가중치가 아님.

강재민이 인수한 M1 후속에 두 COMMENT를 함께 인계 요청한다. 산포 COMMENT의 추가 인수 확인과 실제 Jira 키 연결은 남아 있다.
열린 V21 통계·V22 판 전환의 병합/배포 순서 및 대상 DB의 적용 이력을 먼저 확인해야 한다.
후속 완료 조건은 새 DB 전체 적용, 기존 DB 순차 업그레이드, validate·재실행 0건 및 두 COMMENT 조회 확인이다.
이미 적용된 영속 migration을 삭제하거나 repair/outOfOrder를 켜서 우회하지 않는다.

## S15P21C206-174 알림 정책·생산자 인계 (2026-09-22)

상태: **Q1~Q5·기존 사건 보존/비소급 채택, E1·E2·E4·E5·알림함·설정 구현, E3·E6·E7 DB 생산 경계 구현, 배포 인수 대기**. 상세 정책·V23·검증과 미실행 배포 인수는 [F15.7](../development/service-backend/community.md#notification-policy)을 따른다.

| 충돌·대기 | 현재 사실 | 다음 조치 |
|---|---|---|
| FE221 기본값 ↔ DB 기본 | V23 이전 DB는 follow=false·comment 없음, 현재 FE/API는 RELABEL 포함 6종 | Q4 채택: 기존 값 보존·누락 true. V23과 FE를 함께 배포하고 실제 인수한다. V1 수정 없음 |
| 사건 보존 ↔ 수신 OFF·90일 보관 | 150은 설정 검사 없이 notifications에 개인 재개 사건을 저장 | 150·175가 A2/A5에서 사건과 사용자 제공·제외를 구분. 현재 설정으로 목록만 가리거나 사건 행을 90일 뒤 삭제하지 않음 |
| 별 구독 재개 ↔ 개인 재개 | V23의 공통 원인·E2 결합·STAR_BOARD 구현 | F15.8의 실제 Publisher 게시·규모·배포 인수. 기존 150 reason은 근거 없이 채우지 않음 |
| NTF-01 상태 변경 | FE/API RELABEL·6종 설정은 구현 | E7 DB 최종 값·매칭 경험자 연결 구현. 실제 외부 게시·AI 경로 인수는 별도 |

174는 정책을 담당하고 175는 V23·알림함·설정·E1~E7 DB 사건 경계를 구현했다. 220·221/244 두 실제 계정·배포 인수는 별도이며, 탈퇴 원본 삭제·보존·익명화·재가입·마지막 발견자 정책은 DEC-11/179의 미정 상태를 유지한다.

## S15P21C206-256 섹터별 비닝 revision 소비자 정합화 (2026-09-23)

상태: 탐사 API·Backend 반영(MR !201 리뷰 중). [Gold 4.1 채택안](../../contracts/gold/README.md#41-s15p21c206-114-비닝-운영-채택안) 승인(MR !101)과는 별개다.

[탐사 API](../../apps/backend/docs/exploration-api-spec.md) 5.1절은 한 판의 세그먼트 revision이 하나라고 정했고, `AnalysisService`는 revision이 여럿인 판을 적재 계약 위반으로 처리해 분석 진입이 500이 됐다. Gold 4.1 운영 revision과 `astro_kernel.segment_revision`은 TIC·섹터·원천 checksum의 해시라 여러 섹터 별이면 세그먼트마다 다르다. 옛 규칙은 fixture 값(`10m-v1`)에서 온 것이라 소비자 쪽을 고친다(강재민 결정).

- 5.1절 판 요약에서 `binningRevision`을 빼고 5.2절 세그먼트에만 둔다. 판 전체의 비닝 규칙은 manifest `binning`이 정한다.
- Frontend는 판 요약의 이 값을 읽지 않고 세그먼트 값만 쓴다. 개발 fixture의 판 요약 값만 뺐다.
- [로컬 시드](../../experiments/distributed-pipeline/local-seed/README.md)는 합성 별의 revision을 `segment_revision`으로 섹터마다 만들어 통합 테스트가 이 경우를 지난다.
- 남은 확인: Publisher(86·87·125)가 4.1 규칙으로 실제 여러 섹터 별을 적재했을 때 분석 진입.

## S15P21C206-262 목업 화면 검증의 계약 불일치 (2026-09-25)

상태: **결정·인계 대기.** 262는 코드·스키마·fixture를 바꾸지 않았다. 목업 Gold를 Publisher로 적재하고 실제 로그인으로 분석 화면을 따라가다 확인했다. 수정한 봉우리 표기·null 수신 2건은 [변경 이력](../changes/2026-09-W4/2026-09-25.md)에 있다.

| 충돌·대기 | 현재 사실 | 다음 조치 |
|---|---|---|
| 제출 제약 ↔ 추천값 null 계약 | V4 `ck_submissions_source_peak_all_or_none`은 봉우리 제출에 `source_peak_suggested_duration_hours`·`duration_limit_hours` NOT NULL을 요구한다. 탐사 API 5.4는 추천 duration을 항상 null로 준다. 봉우리 제출이 모두 500이고 주기 직접 선택만 통과한다 | 강재민 인계. 제안: `source_peak_grid_index`는 필수, 제안 duration·상한은 "둘 다 NULL 또는 둘 다 양수". 신규 migration과 [ERD](../architecture/database-erd.md) 제출 표·API 6.2 문구를 함께 바꾼다 |
| `manifest.period_grid` 키 이름 | DB 열은 모두 `period_min_days`·`period_max_days`·`n_periods`다. manifest 안의 키는 117 예제(`experiments/gold-roundtrip`)·로컬 시드(!201)·262 목업이 `period_min_days`·`period_max_days`·`n_periods`, [Gold 계약](../../contracts/gold/README.md) 예제와 [파생 계산 계약](../../contracts/derived-compute/README.md) 3.3절이 `min_days`·`max_days`·`count`다. Backend는 manifest에서 `spacing`만 읽는다 | Gold 계약 담당(113·117, 윤성용)이 키를 확정한다. 확정 뒤 세 산출물을 한 번에 맞춘다. 88 어댑터는 DB 열에서 범위·점 수를 읽는 대안도 있으나 그러면 3.3절 문구를 바꿔야 한다 |
| `periodogram_config_version` 형식 | 이름이 셋이다. 계약 예제 JSON은 `bls-log-v1`, [데이터 정본](../data/tess-pipeline/README.md) 표는 "형식 미정 → 제안 `pg-log5000-v1`"이고 117 예제·시드·목업이 이 값을 쓴다. 123 제공 해상도 규칙(`astro_kernel/discoverability.py` `NUMERICAL_VERSION`)과 125 Gold 직렬화 DB 재생(`experiments/gold-roundtrip/gold_roundtrip/connection_replay.py`)은 `provided-bls-1.0.0`이다. `pg-log5000-v1`과 `provided-bls-1.0.0`은 계산 설정이 같다(0.5일·5000칸·log, duration 1.2·1.92·2.88·4.8시간, likelihood) | 위 키와 함께 확정한다. 확정 전까지 어느 쪽도 확정값으로 적지 않는다. 88 Worker가 버전으로 계산 설정을 고르므로 **실제 파이프라인 판(`provided-bls-1.0.0`)을 거절하지 않게** 두 이름을 같은 설정으로 받는다(88). 운영 Publisher(86·87)가 적재할 이름도 이 결정을 따른다 |

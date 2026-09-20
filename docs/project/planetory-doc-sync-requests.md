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
| D1 ✅ | SRS COM-03·09 우선순위 | SRS는 검색·핫 토픽 P1. 검색 대상 필드는 SB-D24로 COM-03과 일치 | **2026-09-11 팀 결정(SRS v1.1 안건 13): P0 상향.** 서비스 API·기능 분석의 "P1(P0 상향 요청)" 표기를 P0로 갱신 필요 |
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

상태: 추가 보완·재리뷰 대기. 서비스/탐사 API·처리 역할·리뷰 체크리스트의 자동 확대·NaN·점별 오차 설명을 Gold와 맞췄다. develop의 143 변경(v1.11)을 보존하여 ERD v1.12에 114 변경 요약을 추가했고 상태가 포함된 Gold 제목·앵커를 고정 문구로 교체했다. 123은 GoldCatalogViews.java 설명과 새 migration의 DB COMMENT를 함께 정정하며 기존 V1은 보존한다. counts 전용 첨부·검산 절차는 비닝 벤치마크를 따른다. 이전 develop 통합은 e8f62ea에서 커밋·push까지 완료됐다. 최종 리뷰에 따라 최신 develop `2c1c857c591647289bb1e9803080a663d815c00e`의 119 추가 마스킹 항목과 114 항목을 모두 보존하도록 통합했다. 현재 승인 여부는 MR !101에서 관리한다.
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

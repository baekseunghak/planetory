# Planetory 원본 문서 정합화 요청

- 작성일: 2026-09-11
- 상태: 요청 목록. 2026-09-11 SRS v1.1·ERD v1.1에서 R1·R2·R6~R9·D1·D2 반영 완료(강재민). R3~R5(아키텍처·온라인 계산·데이터 문서)는 김동혁 반영 대기
- 작성: 백승학 / 서비스 백엔드
- 관련 작업: S15P21C206-30

2026-09-11 기준으로 원본 문서에 남은 옛 문구를 모았다. [서비스 백엔드 기능 분석](../development/service-backend/README.md)과 [서비스 API 명세](../../apps/backend/docs/service-api-spec.md)는 오른쪽 “최신 기준”을 적용한다. **원본 문서는 수정하지 않았고** 각 문서 담당자에게 반영을 요청한다. 반영되면 해당 행을 완료로 표시한다.

| # | 문서·위치 | 현재 문구 | 수정 제안 | 근거 |
|---|---|---|---|---|
| R1 ✅ v1.1 | ERD 4장 결정 5 | “판 자체는 직전 것만 짧게 보존한다” | “판 행은 제출 참조용으로 남기고, 이전 판의 주기도·캐시는 archived 전환 시 정리한다” | ERD publication_bundles.status(이전 판 미보존, 결정 C) |
| R2 ✅ v1.1 | ERD 4장 결정 6 | 축약 스냅샷 ≈1.8KB | ≈1.2KB(float32 배열 2개×150개, 메타데이터·행 오버헤드 별도) | ERD analysis_snapshots.folded_flux/folded_err |
| R3 | system-architecture.md 3장(63행), Gold 릴리스 절(194~196행), 미결 목록(219·222행) | Gold 파일 `releases/<id>`·`previous` 보존, 세션의 Bundle 고정, Redis는 필요 시 추가 | Gold 본문은 PostgreSQL 배열, 이전 판 미보존·판 교체 시 최신 판 재로드, DAT-14 상태·결과 캐시는 Redis. “Redis 도입 여부”·“이전 Bundle 보존기간” 미결 항목 삭제 또는 “Redis 위치·TTL·메모리 상한”으로 교체 | ERD v0.3 결정·결정 C, SRS DAT-14, SB-D07·18. ERD 머리말도 “아키텍처 불변 규칙 5 수정 필요”를 요청 중 |
| R4 | online-derived-compute.md “세션과 버전 고정”·“캐시 위치”·용량 산정 4번 | 세션에 Bundle 고정, `current`·`previous` 보존, 첫 구현은 PostgreSQL+EC2 로컬 파일 | R3과 같은 기준으로 교체. 캐시 표는 Redis(상태·결과·키별 잠금)로, 용량 산정에서 `previous`·보호 Bundle 항목 제거 | SRS DAT-14, 상태표 v0.15, SB-D18 |
| R5 | data-guidelines.md “EC2 Gold 릴리스”(64~80행) | `releases/`·`current`·`previous` 심볼릭 링크 전환, 참조 중 이전 릴리스 보존 | 배치가 릴리스 전환 때 PostgreSQL 배열을 적재하고 publication_bundles.status로 current를 전환하는 절차로 교체. 검증 실패 시 기존 current 유지 원칙은 보존 | ERD 머리말(Gold 파일 계층 없음) |
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

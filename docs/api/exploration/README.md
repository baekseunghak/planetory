# 탐사 API C02 계약 예제

[#133 검토안](../../../apps/backend/docs/exploration-contract-review.md)을 위한 합성 JSON이다. 2026-09-14 원격 `develop` `321f10b`의 SRS v1.2 변경안과 탐사 API Draft 0.3을 기준으로 한 **초안 예제**이며 운영 API 구현·권한 집행·수치 정책 승인 증거가 아니다.

`contracts.json`의 각 case는 독립 초기 상태다. `same-request-replay`와 `idempotency-conflict`만 normal-harmonic의 접수 완료를 전제로 한다. `request`와 `response`만 HTTP 표현이며 setup/effects/at/sourceSection은 검증 메타데이터다. 설명용 축약 UUID는 유효 UUID로, 반올림 duration은 원본 위상에서 계산한 값으로 교정했다. 기존 탐사 명세의 정상 제출·곡선·별 목록 DTO를 재사용했으며 구판 `docs/api/analysis/examples`는 변경하지 않았다.

`decisions.json`은 HTTP 응답이 아닌 공동 검토용 계산·정책 사례다. 은퇴 경로별 서로 다른 결과와 duration 중첩의 양쪽 결과를 보존한다. 특정 대안의 채택을 의미하지 않는다. 기준 시각 환산 예제는 AT-118을 재사용한다.

저장소 루트에서 `node docs/api/exploration/validate.cjs`로 검사한다. JSON 파싱, UUID/오류/상태, 원본 요청·응답 일치, duration·위상 환산, 배열 길이, 은퇴 대체 배열, 추천 밖의 격자 포함 여부, 중첩 상한의 차이, 공개 조회의 작업 생성 금지, 참여자 중복 제거를 검사한다. 실제 서버 호출·후보 매칭·DB 동시성·브라우저 계산은 실행하지 않는다.

C02-R1 은퇴 3경로는 2026-09-14 사용자 선택에 따라 분석 복귀·재도전은 최신 현재 진행, History CURRENT는 원본으로 고정했다. C02-R2 기준 시각은 같은 날 Bundle 공통값으로 결정했으며 모든 유효 원본 관측 시각의 중앙값을 한 번 저장한다. C02-R3은 사용자가 고른 봉우리의 grid index를 제출하고 그 봉우리의 추천 duration 3배를 선택 폭 상한으로 적용한다. 직접 주기 선택은 Bundle 공통 위상 상한만 쓴다. 교차 검토 후 정본·API·JSON을 같은 버전으로 확정한다. 예제의 합성 수치를 운영 설정에 복사하지 않는다.

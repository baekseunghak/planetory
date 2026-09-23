# 현재 판 다시 풀기 — 192

기준: develop `e7a7e0e1`, [탐사 API 6.8](../../backend/docs/exploration-api-spec.md), [프론트 명세 5·6.3](../../../docs/development/analysis-frontend-spec.md), S15P21C206-192. 프론트 구현과 합성 HTTP 검증을 다루며 실제 API·DB 인수 완료를 뜻하지 않는다.

## 구현 흐름

1. 결과의 서버 제공 RETRY와 본인 History 상세에서 다시 풀기를 연다. History 목록에서는 기록 상세를 거친다. URL의 `retryOfSubmissionId`는 요청할 식별자일 뿐 소유권의 근거가 아니다.
2. 같은 회원·항성의 미제출 초안이 있으면 편집기를 열기 전에 기존 초안 이어가기 / 초안 대신 재도전 시작을 고른다. 조회 실패만으로 기존 초안을 덮어쓰지 않는다.
3. 현재 analysis-context와 본인 제출 조회의 TIC·제출 ID를 확인하고 retry-draft를 읽는다. 서버가 재환산한 phase를 그대로 쓰며 브라우저에서 다시 5분을 더하거나 절대 epoch를 바꾸지 않는다. Bundle 경합은 한 번만 재조회한다.
4. 서버가 복원한 곡선 문맥을 사용한다. 캐시가 없으면 기존 residual-jobs 흐름으로 준비한 뒤 같은 목표 곡선을 다시 읽는다. 이동·unmount는 대기 요청을 중단한다. 403·404·409·503은 오류와 재시도로 표시한다.
5. period는 현재 전체 주기도 격자에서 검증하고 sourcePeakGridIndex=null로 복원한다. 추천 봉우리의 미세 조정 범위로 과거 주기를 제한하지 않는다. 유효한 구간은 판단 단계, 없는 선택은 주기 선택 단계, 현재 규칙에 맞지 않는 구간은 수정 단계로 간다. 새 재도전의 판단·근거·메모는 비운다.
6. 제출 때만 retryOfSubmissionId를 붙인다. 의도적인 재도전마다 브라우저 내부 attempt ID를 만들고 초안과 함께 보존한다. 이는 요청 예약의 식별에만 쓰며 API 본문에 보내지 않는다. 같은 원본에 같은 답을 다시 내도 새 requestId를 만들고, 통신 복구는 같은 requestId·본문을 유지한다. 미확인 요청은 여전히 새 제출을 막는다.
7. 실제 접수된 입력의 세션 초안은 제거하고 제출 복구 기록은 별도로 유지한다. 재도전 도중 새로고침·이탈에는 새로 작성한 판단과 출처를 보존하되 구간을 다시 확인한다. 초안은 회원·항성당 한 건이다.
8. 원 게시글로 돌아갈 때 실제 GET /posts/{id}로 접근 가능 여부를 재확인하고 TIC를 대조한다. 삭제·숨김·다른 TIC이면 분석에 남아 오류와 별지도 경로를 제공한다. postId는 제출·History에 영속 저장하지 않는다.

## Gold 시각 기준 정합화

2026-09-22 사용자 승인: 신규 프론트 표시·접기 시각을 Gold bin 중앙으로 맞춘다.

`t[i] = startBtjd + (i + 0.5) × binMinutes / 1440`

- 저장된 startBtjd는 bin 시작 그대로다. 각 세그먼트의 binMinutes를 사용한다. 원본 시간축·툴팁·예상 통과 띠·Worker 접기·History CURRENT에 같은 규칙을 적용했다.
- 근거는 [Gold 계약](../../../contracts/gold/README.md)과 [Astro kernel D06](../../../libs/astro-kernel/README.md)의 중앙 시각 합의, [스냅샷 운영 안내](../../../docs/api/exploration/submission-readiness.md)의 folded-mad-v1 채택이다. 이미 노출 중앙인 원시 2분 TIME에 다시 반 bin을 더하는 규칙이 아니다. 이 화면의 입력은 Gold 형태의 비닝된 세그먼트다.
- History SUBMITTED의 저장 배열·v0/v1 표기는 그대로 읽는다. 과거 스냅샷 재계산, DB 테이블·저장 시각·전역 접기 기준 T 변경은 없다.
- 접기 dataId에 gold-bin-center-v1을 넣어 시작 시각 기준으로 저장한 세션 초안을 다른 계산 결과에 복원하지 않는다.
- 선택 미리보기는 서버가 보낸 observationBounds를 계속 사용하고 제출 최종 검증도 서버가 한다. 중앙 시각으로 바꿨다고 허용 관측 범위를 프론트에서 반 bin 늘리지 않는다. 서버 SubmissionMatching의 관측 창은 현재 시작 시각 기준이며, 경계 bin 선택의 허용 여부는 아래 리뷰 항목이다.
- bin 중앙은 평균에 참여한 실제 관측 시각의 평균과 같다고 보장되지 않는다. 부분 bin의 정확한 시간 복원이나 매칭 정확도 향상을 입증한 변경이 아니다.

## MR에서 강재민 님에게 요청할 리뷰

> @jmkang21212 현재 판 다시 풀기와 프론트 Gold 시각 기준 정합화 리뷰 부탁드립니다. D06 합의와 folded-mad-v1에 맞춰 화면·접기를 세그먼트별 bin 중앙으로 통일했습니다. startBtjd 저장값, 기존 스냅샷, 접기 기준 T는 유지했습니다. 특히 (1) 부분 bin·혼합 cadence에서도 이 기준이 맞는지, (2) 서버 observationBounds/SubmissionMatching의 시작 시각 기반 관측 창에서 양 끝 bin 선택이 거절될 수 있는 경계를 그대로 둘지, 별도 규칙 변경이 필요한지 함께 확인 부탁드립니다. DB 테이블 수정은 이번 변경에 없습니다.

리뷰 댓글은 MR 생성 단계에서 요청한다. 아직 게시하지 않았다.

## 검증 범위와 인수 항목

- 단위 검사: 응답 ID·위상·빈 선택·잔차 단계, bounded Bundle 경합, 소유/TIC 오류, 잔차 준비 목표, 원 글 TIC 재확인, 10분 bin의 9–63분 통과 창, 혼합 cadence·시간축·History 배열 보존.
- 브라우저 검사: 새 재도전의 초기화·판단 진입, 동일 답의 별도 requestId, 기존 초안 보존, 새로고침 뒤 출처·메모, 선택 없는 재도전, 원 글 접근 거절, 기존 초안·제출·History 회귀. 지원 최소 폭 1024px의 재환산 구간·32배 복원과 390px의 기존 데스크톱 안내를 확인한다.
- 실제 API·DB 인수는 미실행이다. 이 워크트리는 .env.example만 있으며 API_PROXY_TARGET도 설정되지 않았다. 합성 fixture는 서버의 절대값 재환산·성과 불변·DB 행 수·실제 은퇴 후보 권한을 증명하지 않는다. 실제 사용자 세션·현재 Bundle 데이터에서 FAV-20~22·30·31을 확인해야 한다.
- 커밋·푸시·MR은 별도 요청 단계에서 수행한다.

### 2026-09-22 실행 결과

- `npm run build`: 타입 검사·운영 빌드·fixture 제외 검사 통과. Vite의 기존 확장자·500KB 청크 경고는 남아 있다.
- `npm test`: 384개 통과.
- Chromium 관련 9개 파일, 중복을 제외한 99개 시나리오 통과. 기능별 실행과 실패한 기존 기대값 수정 후 선택 재실행을 합산했다. 한 번의 99개 일괄 실행 결과는 아니다.
  - analysis-draft / analysis-submit / history-detail: 기존 초안·제출·History 회귀. 새로 연결한 다시 풀기 링크의 기존 ‘링크 없음’ 기대값을 수정해 재확인했다.
  - analysis-retry: 9개. 주기 없는 초안 저장, 서버 재환산 위상, 재제출 ID, 원 글 거절, 대기열 429와 retryable=false 포함.
  - analysis-data / analysis-refresh / time-curve / phase-preview / folded-curve: 진입·판 경합·시간축·표시 위치·미세 조정 회귀.
- `git diff --check` 통과. 실제 API·DB 검증, Firefox·Edge 인수, 성능 재측정은 실행하지 않았다.

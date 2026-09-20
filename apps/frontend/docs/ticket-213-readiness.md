# 213 본인 History·공개 출처 첨부 구현과 인수

S15P21C206-213 / W14 · 하서진 · 2026-09-18. [프론트 README](../README.md), [서비스 7절](../../backend/docs/service-api-spec.md#attachments), [탐사 8절](../../backend/docs/exploration-api-spec.md).

## 구현 범위

글/댓글에서 같은 TIC의 본인 기록을 cursor 목록으로 선택하고 공개 분석·공식 스레드는 명시적으로 종류/ID를 입력하여 source-cards로 확인한 후 선택한다. 본문 URL은 자동 첨부하지 않는다. 각각 최대3·중복 금지·최종 본문 필수. 게시 전 TIC/게시판 변경은 자료를 모두 해제하며 PATCH에 빈 배열을 함께 전송한다. 부모가 최종 권한/TIC/소유자를 검증하는 기존 쓰기를 사용하며 실패해도 초안은 남는다. 새 공개 분석·성과·공식 스레드를 만들지 않는다.

조회는 posts/{postId}/history-attachments/{historyId} 또는 comments/{commentId}/history-attachments/{historyId}다. 개인 History 상세·잔차 생성·개인 작업 조회는 호출하지 않는다. 공개 취소된 출처/첨부는 내용과 링크를 제거한다. 부모·회원·TIC 변경, 재진입과 탭 복귀 시 기존 비공개 캐시를 재사용하지 않는다.

CURRENT와 SUBMITTED를 따로 요청하고 원본/잔차/현재 판/제출 판을 구분한다. SUBMITTED snapshot:null이면 당시 버튼을 비활성화하며 최신 곡선으로 대신 채우지 않는다. 기존 잔차 jobId와 진행 상태가 함께 있을 때만 같은 부모 첨부 GET을5초 간격 최대6회 조회한다. null 또는 FAILED는 폴링하지 않는다. 그래프 오류 중 마지막 그래프는 표시하지 않고 공개 메타데이터는 유지하되403/404/401이면 전부 제거한다. 판503은 수동 재조회로 복구하며 클라이언트가 계산 작업을 만들지 않는다.

## A08 공용 연결

src/features/history/HistoryGraph.tsx의 HistoryGraphDto는 탐사5.2/8.3의 기존 envelope와 배열을 그대로 전달한다. public 전용 배열이나 접기 계산기를 만들지 않았다. App의 historyGraphRenderer에 A08 컴포넌트 어댑터를 주입하면 graph·mode·readOnly:true를 받는다. 이 경계는 단위 검사에서 원본 객체 동일성·읽기 전용을 확인한다.

213 작성 당시 remote185에는 분석용 조작 그래프만 있고 A08 공개 History 컴포넌트가 없었다. 운영 기본 슬롯은 연결 준비 안내를 표시하며 이를 그래프 렌더링 완료라고 부르지 않는다. Jira에 명시된 placeholder 병행 조건으로 선택·카드·소비 어댑터를 제출했다. 실제 렌더러 결합과 화면 인수는216-213에 남는다. 메모/근거는 공개 응답의 memo/evidenceChecks만 사용하고 개인 원본으로 보충하지 않는다.

## 검증

apps/frontend에서 npm ci 후 npm run dev:materials (58354). 검사는 npm run build, npm test, npx playwright test --config=playwright.materials.config.ts, npm run test:posts, npm run test:comments, npm run test:production.

build/typecheck·운영 제외 검사 통과, 단위80개·첨부20개(Chromium/Chrome/Edge/Firefox)·글14개·댓글7개·운영7개 통과. 첨부 수정 뒤 returnTo 쿼리를 허용하지 않았던 테스트 기대식을 바로잡고 해당4브라우저를 재검사했다. 개발 fixture는 합성 기록이고 실제 S07/S14/C14 완료 증거가 아니다. 운영 번들에 포함되지 않는다.

## 상태와 재개

213은 develop b0d733b에서 분기 후212 cbb7494를 통합했다. 당시 !75→!76→!78→!79→본 MR 순서였으며 서버 첨부·출처 구현을 기다렸다. 2026-09-20의 160 변경은 아래와 같다. 216-213에서 실제 서버와 A08 렌더러를 함께 연결한 화면 인수를 진행한다.

롤백은 첨부 UI/소비 어댑터/개발 모드를 제거하고 기존209~212를 유지한다.

## 2026-09-18 MR 리뷰 보완

- 글 수정 DTO의 자료 중복 해석을 제거했다.
- 자료 비교는 순서 대신 History ID·출처 종류/ID로 한다. 서버가 순서를 바꿔도 응답 유실 후 저장 확인을 잘못 실패시키지 않는다. 중복·누락·다른 ID는 여전히 거부한다.
- 검증: 타입 검사·단위 98개, 기존 Chromium 자료 5개와 신규 응답 유실/순서 변경 1개 통과. 재전송 없이 실제 fixture PATCH 반영을 GET으로 확인했다.
- 지도·커뮤니티 통합과 최신 develop 및 선행 리뷰 수정 포함. 공용 그래프·실제 API·배포 인수의 기존 경계는 유지한다.

## 2026-09-20 History 첨부 서버 연결(160)

- 서버가 본인·동일 TIC·최대 3개 History를 저장하고 부모별 공개 조회를 제공한다. 출처 카드 167은 여전히 별도다. 서비스 응답의 `judgment`와 148 공개 투영·Graph DTO를 사용하며 판단 없는 기록의 null도 표시한다.
- 첫 그래프 요청이 503이면 같은 부모 경로로 `includeGraph=false`를 조회해 공개 내용과 오류 안내를 함께 표시한다. 이 조회도 권한을 다시 검사하며 401/403/404이면 기존 내용을 제거한다. 개인 History나 작업 API로 보충하지 않는다.
- 일반 첨부는 161의 공식 공개·성과와 독립적이다. 147의 실제 잔차 공급자와 A08 공용 렌더러·216-213 화면 인수는 남는다. 검증용 fixture 결과를 실제 서비스 연결 완료로 간주하지 않는다.
- 검증: `npm run build`, `npm test`(225개), `node_modules\.bin\playwright.cmd test --config=playwright.materials.config.ts --project=chrome`(7개) 통과. 첫 503의 공개 내용 조회·null 판단 표시·권한 철회 시 제거를 추가 검사했다. Chromium 전용 실행 파일은 없어 Chrome으로 검증했다.

# 213 본인 History·공개 출처 첨부 구현과 인수

S15P21C206-213 / W14 · 하서진 · 2026-09-18. [프론트 README](../README.md), [서비스 7절](../../backend/docs/service-api-spec.md#attachments), [탐사 8절](../../backend/docs/exploration-api-spec.md).

## 구현 범위

글/댓글에서 같은 TIC의 본인 기록을 cursor 목록으로 선택하고 공개 분석·공식 스레드는 명시적으로 종류/ID를 입력하여 source-cards로 확인한 후 선택한다. 본문 URL은 자동 첨부하지 않는다. 각각 최대3·중복 금지·최종 본문 필수. 게시 전 TIC/게시판 변경은 자료를 모두 해제하며 PATCH에 빈 배열을 함께 전송한다. 부모가 최종 권한/TIC/소유자를 검증하는 기존 쓰기를 사용하며 실패해도 초안은 남는다. 새 공개 분석·성과·공식 스레드를 만들지 않는다.

조회는 posts/{postId}/history-attachments/{historyId} 또는 comments/{commentId}/history-attachments/{historyId}다. 개인 History 상세·잔차 생성·개인 작업 조회는 호출하지 않는다. 공개 취소된 출처/첨부는 내용과 링크를 제거한다. 부모·회원·TIC 변경, 재진입과 탭 복귀 시 기존 비공개 캐시를 재사용하지 않는다.

CURRENT와 SUBMITTED를 따로 요청하고 원본/잔차/현재 판/제출 판을 구분한다. SUBMITTED snapshot:null이면 당시 버튼을 비활성화하며 최신 곡선으로 대신 채우지 않는다. 공개 첨부는 작업 상태로 주기적 재조회를 하지 않으며, 완료 상태라도 non-null jobId가 오면 응답을 거절한다. 개인 History와 공유하는 파서는 유지하고 공개 소비 경계에서만 검사한다. 그래프 오류 중 마지막 그래프는 표시하지 않으며, 503이면 includeGraph=false로 현재 권한을 다시 확인한 공개 내용만 표시한다. 403/404/401이면 내용을 전부 제거한다. 오류의 수동 재조회·모드 전환·탭 복귀의 권한 재확인은 유지하며 계산 작업은 만들지 않는다.

CURRENT의 RETIRED_CANDIDATE는 은퇴 후보에 따른 원본 대체, RESIDUAL_NOT_AVAILABLE은 현재 사용 가능한 잔차 부재에 따른 원본 표시로 서로 다르게 안내한다. SUBMITTED의 RETIRED_CANDIDATE는 현재 판의 재현 가능성만 설명하고 당시 배열은 그대로 표시한다. snapshot:null이면 배열이 보인다고 안내하지 않는다. 내부 열거값은 사용자에게 노출하지 않는다.

## A08 공용 연결

src/features/history/HistoryGraph.tsx의 HistoryGraphDto는 탐사5.2/8.3의 기존 envelope와 배열을 그대로 전달한다. public 전용 배열이나 접기 계산기를 만들지 않았다. App의 historyGraphRenderer에 A08 컴포넌트 어댑터를 주입하면 graph·mode·readOnly:true를 받는다. 이 경계는 단위 검사에서 원본 객체 동일성·읽기 전용을 확인한다.

213 작성 당시 remote185에는 분석용 조작 그래프만 있어 placeholder 병행 조건으로 선택·카드·소비 어댑터를 제출했다. 2026-09-21 확인한 develop 09021d1에는 190의 SharedHistoryCurve가 main.tsx에 연결돼 있다. 이번 Chrome 검사는 CURRENT의 실제 SVG와 SUBMITTED의 150칸 그래프 표시까지 확인했다. 슬롯 미등록 때의 연결 준비 안내와 구분하며, 실제 서버·두 계정 권한·부모 경로의 종단 인수는 191/216-213에 남는다. 메모/근거는 공개 응답의 memo/evidenceChecks만 사용하고 개인 원본으로 보충하지 않는다.

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

## 2026-09-20 160 MR 리뷰: 판단 없는 기록 선택

- 선택 목록도 `userJudgment: null`을 정상 값으로 보존한다. `submissionKind=no_candidate`는 “신호 없음으로 제출”, `skipped`는 “건너뛴 기록”, 그 밖의 null은 “판단 없음”으로 표시하며 판단값을 임의로 채우지 않는다. 누락·숫자 등 잘못된 판단 형식은 기존 검증을 유지한다.
- 서버 목록 계약에 맞춰 개발 fixture에도 `submissionKind`를 명시했다. 정상 기록과 null 판단 기록을 섞어 표시·두 기록 선택·POST의 historyIds·저장 후 첨부를 확인하는 Chrome 회귀 2개를 추가했다.
- 검증: 수정 전 두 사례 모두 목록 오류를 재현했다. 수정 후 `npm run build`, `npm test` 225개, Chrome 첨부 9개(기존 7+회귀 2)를 통과했다. 브라우저 검증은 합성 HTTP fixture·응답 제어 기반이며 실제 백엔드·DB·공용 그래프 렌더러 통합 검증을 뜻하지 않는다.

## 2026-09-21 191 검토에 따른 공개 첨부 표시 보완

- 기준: develop 09021d1. MaterialCards의 모드별 안내·사유별 한국어 문구·공개 jobId 거절과 자동 반복 조회 제거를 213 후속 수정으로 수행했다. readHistoryGraph, 개인 History 화면, 서버 권한 로직, useReadModel의 재진입/숨김/늦은 응답 처리는 변경하지 않았다.
- 과거 근거: 213 최초 커밋 577a2f3 당시 서비스 7.2에는 실제 jobId가 있는 경우 폴링한다는 계약이 있었다. 구현은 개인 작업 API가 아니라 같은 부모 첨부 GET을 반복했다. 9/20 c662796·ca013ba의 공개 jobId null 및 SUBMITTED 의미 명확화 이후 소비자 동기화가 빠져 이번에 정정했다.
- lastMeta는 최초 구현에 존재했으며 160의 978cffc에서 제거됐다. 현재의 includeGraph=false 권한 재확인은 보존한다. 과거 위험과 현재 코드의 미해결 결함을 구분한다.
- 검증: `npm run build`의 타입 검사·운영 빌드·개발 fixture 제외 검사 통과, `npm test` 343개 통과, `node_modules\.bin\playwright.cmd test --config=playwright.materials.config.ts --project=chrome` 14개 통과(기존 9+추가 5). 두 사유, 당시 배열 유지, snapshot:null, QUEUED/COMPLETED의 잘못된 jobId 거절, 35초 경과 후 반복 조회 부재를 확인했다. 503 공개 메타데이터 재조회·권한 철회 및 글/댓글 기존 검사도 통과했다.
- 검증 구분: 요청 횟수는 StrictMode의 초기 재마운트·중단 요청 이후 증가 여부로 검사한다. 운영 빌드의 기존 청크 크기 및 Vite 설정 import 경고는 이번 수정 범위 밖이다. 브라우저 검증은 합성 HTTP 응답과 실제 공용 렌더러를 사용했으며 실제 백엔드 두 계정 인수가 아니다.
- 인계: 191의 전체 권한·공개 부모 경로 인수를 완료한 것으로 처리하지 않는다. `/public-analyses/:analysisId` 상세 화면의 담당 범위는 별도로 확인하며 193/195에 자동으로 포함됐다고 간주하지 않는다. 사용자 요청으로 213 후속 수정 브랜치에서 일반 MR 리뷰를 진행하며, Jira 상태나 191 완료 여부는 이번 코드 공유로 변경하지 않는다.

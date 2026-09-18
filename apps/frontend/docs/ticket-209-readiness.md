# 209 커뮤니티 조회 구현·인수 기록

Jira: **S15P21C206-209 / W11** · 담당 하서진 · 기준 2026-09-18.

상태: 기능 구현·로컬 계약 검증 완료, 비작성자 리뷰와 develop 병합 대기. 실제 S11/S12 종단 인수는 **216-209**, 배포 HTTPS·실제 Safari는 **216-ENV**에서 확인한다. 아래 가상 HTTP 검증을 실제 백엔드 검증으로 간주하지 않는다.

상위 안내: [프론트 README](../README.md). 계약: [서비스 API 4·5·6·9.2절](../../backend/docs/service-api-spec.md), [SRS COM-01·02·12·14·15·17](../../../docs/requirements/planetory-requirements-spec.md), [공통 프론트 연결](shared-frontend-contract.md).

## 구현 범위

| 체크   | 구현 및 검증                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 209-01 | 전체/별/자유 게시판, 특정 TIC 게시판. POST와 SIGNAL_THREAD 구분, 불투명 cursor의 처음/이전/다음 페이지, 필터·직접 주소·새로고침·복귀 문맥                                     |
| 209-02 | 공식 SYSTEM 원글, TIC·candidateId·제목에 따른 신호 식별 요약, 개인 작성자·제출 시각·공개 분석 목록, 전체/세 판단 필터, 읽기 전용 토론                                         |
| 209-03 | 서버 judgmentSummary만 표시. 필터 목록 길이나 개별 공개 기록으로 N·비율을 재계산하지 않음. N=0 별도 안내, 최신 유효 공개 제출 집계 설명                                       |
| 209-04 | 행성일 확률·성과·일반 글 반응 수와 구분. 지웅 담당 공개 분석 상세·상세 통계는 기존 페이지 슬롯으로만 이동                                                                     |
| 209-05 | 인증 게이트, 부모 조회 후 자식 조회, 401 세션 제거, 403/404/부분 실패 시 상세 전체 차단, 취소/순서 역전, 빈 결과·잘못된 DTO·수동 재조회, 탭 복귀 재검증, 본문 문자 이스케이프 |
| 209-06 | 리뷰 승인/develop 병합 대기. 원격 MR과 Jira에 검증 근거를 연결한 후 병합 여부를 확인해 종료                                                                                   |

글/댓글 작성·수정·삭제(210/211), 반응(212), 자료 첨부/출처 카드(213), 검색(217), 핫 토픽(218)은 구현하지 않는다. 기존 205~~208과 개인 시제품을 수정하지 않는다. 최신 develop `0fe04d00`에서 시작했으며 205~~208의 미병합 기능에 의존하지 않는다. main.tsx에 페이지 슬롯을 각각 추가하므로 그 브랜치들과 통합할 때 슬롯을 모두 보존한다.

## HTTP 연결

| 화면           | GET 경로(`/api` 기본 접두사)                                       | 규칙                                                              |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 전체 피드      | `/v1/community/feed?size=20`                                       | board/ticId 생략                                                  |
| 별/자유 피드   | 같은 경로 + `board=STAR` 또는 `FREE`                               | 필터 변경 시 cursor 제거                                          |
| 특정 별 게시판 | 같은 경로 + `board=STAR&ticId=...`                                 | 숫자 변환 없이 문자열 ID                                          |
| 일반 글        | `/v1/posts/:postId`                                                | path와 응답 postId 일치 확인                                      |
| 공식 스레드    | `/v1/signal-threads/:threadId`                                     | SYSTEM, TIC, candidateId, 판단 요약                               |
| 공개 분석 목록 | `/v1/signal-threads/:threadId/analyses?size=20`                    | 전체는 judgment 생략. 나머지 LIKELY_PLANET/UNLIKELY_PLANET/UNSURE |
| 토론           | `/v1/comments?parentType=POST\|SIGNAL_THREAD&parentId=...&size=20` | 읽기 전용, cursor는 부모/필터별 독립                              |

쿠키·취소·시간 초과·401 처리는 기존 api 클라이언트와 SessionProvider를 사용한다. API 실패를 가짜 목록이나 빈 목록 성공으로 바꾸지 않는다. GET 재시도는 사용자의 버튼으로만 실행하며 쓰기 요청을 추가하지 않는다.

- `items/nextCursor/hasNext`와 ID·판단·UTC·음수/불일치 통계를 검증한다. 서버의 percentages를 표시하며 유효성 대조만 수행한다.
- `contributesToSummary`는 서비스 9.2절의 선택적 보조 정보다. true/false가 제공된 경우만 현재 집계/과거 기록을 표시하고, 미제공 시 임의 판정을 하지 않는다.
- 신호의 period/epoch/duration은 현재 스레드 조회 DTO에 없다. 별/TIC·candidateId·제목·공개 판단까지만 표시하며 수치나 단위를 생성하지 않는다. 해당 수치와 그래프는 지웅 담당 공개 분석 상세 계약을 따른다.
- 공개 분석 링크는 `analysisId`와 `returnTo`로 `/public-analyses/:analysisId` 슬롯에 전달한다. 미공개 History 직접 조회 링크를 만들지 않는다. 이 브랜치에 실제 공개 분석 상세 구현이 있다고 주장하지 않는다.
- 시각은 UTC 문자열로 수신하고 브라우저 현지 시각으로 표시한다. BTJD 값으로 변환하지 않는다.
- 본문/목록 캐시는 메모리의 현재 요청에만 둔다. 경로·회원 변경, 로그아웃, 숨김/권한 실패 시 제거한다. 문서를 숨길 때 제거하고 탭 복귀/페이지 복원 시 부모부터 다시 확인한다. 스크롤 복원은 응답과 무관한 위치 숫자만 최대 50개 메모리에 둔다.

## 실행·확인

```powershell
cd apps/frontend
npm ci
npm run dev:community
```

http://127.0.0.1:58346/community 에서 개발 검증 자료로 확인한다. 실제 게시글이 아니라는 안내를 표시한다. 26개 피드·23개 공개 분석·22개 댓글로 20개 페이지 경계를 확인한다. `st-301`은 참여자15명(8/4/3), `st-302`는0명이다. 목록의 과거 기록과 현재 참여자 분모는 다르다.

실제 서버에서는 기존 `API_PROXY_TARGET`을 지정하고 `npm run dev`를 실행한다. 별도 community 플래그 없이 운영 페이지가 등록된다. `--mode community`의 개발 HTTP 플러그인은 **serve + non-preview**일 때만 실행하며 배포 빌드/preview에는 포함되지 않는다. 운영에 고정 회원·가상 콘텐츠·리셋 기능을 넣지 않는다.

```powershell
npm test
npm run build
npm run test:community
npx playwright test --config=playwright.community.config.ts --project=chrome --project=msedge --project=firefox
npm run test:browser
npm run test:production
```

브라우저 검사는 테스트 서버58347을 별도로 띄운다. Firefox는 Windows의 정식 Firefox BiDi(`moz-firefox`)를 사용하며 필요하면 `FIREFOX_EXECUTABLE`로 공식 설치 경로를 지정한다. Docker는 사용하지 않는다.

## 검증 결과

실행 환경: Windows, Node24.18.0/npm11.16.0, Playwright1.63.0. Chrome153.0.8010.48, Edge153.0.4234.32, Firefox156.0. 기존 의존성 버전·lockfile을 변경하지 않는다.

- 단위 검사63개 통과(209 계약 검사5개 포함).
- 타입 검사·배포 빌드·개발 데이터 미포함 검사 통과.
- 공통 라우트/인증 회귀12개, 배포 코드 검사6개 통과(209 운영 경로2개 포함).
- 커뮤니티13개 시나리오 × Chromium·Chrome·Edge·정식 Firefox, 총52개 통과.
- 목록과 공식 스레드 데스크톱 화면을 직접 확인했다. 1024px 가로 넘침 및 1024px 미만 안내도 자동 검사한다.

## 216-209 인계 — 미검증

develop `0fe04d00`에 일반 글 상세(PostController)와 댓글(CommentController) 구현은 존재한다. 전체 피드/공식 스레드/공개 목록/S12 통계 controller는 아직 없다. 이 작업 시점 해당 로컬 백엔드는 실행 중이지 않아 실제 DB 읽기 검증을 새로 수행하지 않았다. 로컬 HTTP fixture와 오류 응답 가로채기 검증을 구분한다.

재개 조건: S11/S12와 인증된 서비스 백엔드, 지웅 담당 공개 분석 상세가 제공되면 같은 운영 페이지를 실제 API에 연결한다.

기대 결과: 전체/STAR/FREE·특정TIC의 접근 자격과 cursor 경계, N=0·세 판단 필터의 분모, 같은 회원의 여러 공개 기록, 부모 숨김/삭제/공개 취소 후 직접 URL 및 돌아가기 차단, 실제 공개 분석 상세 왕복을 확인한다. 배포HTTPS·Safari는216-ENV에 함께 증거를 남긴다. 미확정 수치 필드를 임의로 신설하거나 fixture 성공을 실제 인수 완료로 기록하지 않는다.

롤백: 이 MR의 프론트 페이지 등록·community 모듈·개발 검사 파일을 함께 되돌린다. DB/백엔드/운영 설정 변경은 없다.

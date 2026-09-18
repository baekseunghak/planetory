# W03 공통 코드와 A/W 화면 연결

215의 지도 내부 성능 개선은 라우트·인증·이벤트·API 계약을 변경하지 않는다. [공간 인덱스와 데이터 재사용](performance-215.md)은 `sky-data`/`sky-renderer` 내부에 한정되며214 프로필이나 분석 화면을 선행 병합할 필요가 없다.

기준: `develop` 321f10b / SRS v1.2 / 서비스 API 2~3절 / Jira `S15P21C206-201`. 2026-09-14 작성. 아래 **프론트 경로와 파일 구조는 이 구현의 검토안**이다. 백지웅 화면이 실제 연결됐거나 미확정 API가 합의됐다는 의미는 아니다.

2026-09-15 현행: 실제 SSAFY·Google 및 공통 오류 계약 검증을 마쳤다. 서진님은 지웅님이 공통 기반 사용에 이견이 없다고 전달했다. 배포가 지연되어도 코드 공유·리뷰는 진행한다. 실제 A 화면 연결 시험과 배포 인수를 통과한 뜻은 아니다. [현재 상태와 다음 단계](ticket-201-readiness.md), [검증 결과](verification.md)를 따른다.

## 이번 변경의 범위

기존 시제품의 package 설정·App 인증 조회/라우팅·요청 취소 로직·메뉴 dialog를 바탕으로 공통 부분을 추출했다. `/api/v1/me` 평면 응답과 서버 `ErrorResponse.FieldError(field, reason)`를 적용한다. 기존 코드에 있던 `{field, message}`만 읽는 처리는 가져오지 않았다.

| 공통 파일                          | 역할                                                | 기능 담당자의 사용 방법                          |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `src/main.tsx`                     | 앱을 한 번 시작, BrowserRouter/SessionProvider 배치 | 두 번째 Router나 로그인 Provider를 만들지 않는다 |
| `src/app/App.tsx`                  | 인증 게이트와 화면 연결 자리                        | PageSlots에 자신의 컴포넌트 등록                 |
| `src/app/paths.ts`                 | 화면 주소·ID·복귀 링크                              | `pagePath()` 사용                                |
| `src/app/usePageContext.ts`        | 현재 TIC/History/원 글/복귀 주소                    | `usePageContext()` 사용                          |
| `src/auth/SessionProvider.tsx`     | GET /me, 현재 회원, 401 정리                        | `useSession()` 사용                              |
| `src/api/index.ts`                 | 앱에서 사용하는 HTTP 클라이언트 한 개               | `api()` 사용                                     |
| `src/api/client.ts`                | 쿠키, 취소, 204, 오류, 요청 식별, 자동 재시도 금지  | 기능별 fetch 래퍼를 중복 작성하지 않는다         |
| `src/api/useResource.ts`           | 읽기 요청, 수동 재조회, 늦은 응답 무시              | 안정적인 decoder 함수와 경로 전달                |
| `src/components/ServiceLayout.tsx` | 접는 메뉴와 공통 회원 표시                          | 페이지 본문은 Outlet 자리에서 렌더링             |
| `src/components/RequestState.tsx`  | 로딩·오류·수동 조회 재시도                          | 쓰기 요청 자체를 retry에 연결하지 않는다         |

화면별 그래프 계산·폼·지도 렌더러·성과 계산은 W03에 포함하지 않는다. 전체 시제품을 통째로 복사해 여러 티켓을 한 MR에 묶지 않았다.

## 버전

| 항목                  | 이 앱                 | 선택 근거                                                             |
| --------------------- | --------------------- | --------------------------------------------------------------------- |
| React / React DOM     | 19.2.8                | 최신 Git의 analysis-ui/analysis-lab과 동일                            |
| TypeScript            | 7.0.2                 | analysis-ui와 동일                                                    |
| Vite / React plugin   | 8.2.2 / 6.1.1         | analysis-ui와 동일                                                    |
| React Router DOM      | 7.18.3                | 기존 서비스 시제품에서 재사용                                         |
| Playwright / Prettier | 1.63.0 / 3.9.6        | analysis-ui와 동일                                                    |
| Node                  | 22.12 이상, Docker 22 | 저장소 Docker 기준                                                    |
| @types/node           | 22.19.19              | 운영 Docker 22의 API 범위로 제한; 분석 실험의 26 타입을 강제하지 않음 |
| 패키지 관리자         | npm + package-lock    | 기존 운영 Docker `npm ci` 유지; 실험 pnpm은 그대로 보존               |

버전 변경이 필요하면 이 앱의 manifest와 lockfile을 함께 변경한다. 실험 package.json을 운영 앱에 덮어쓰지 않는다.

## 화면을 연결하는 예

기능 컴포넌트를 작성한 후 `src/main.tsx`의 pages에 등록한다. #182 통합에서 아래 AnalysisPage를 실제 연결했으며 기존 지도 슬롯과 개발 검증 화면 등록을 함께 유지한다.

```tsx
import { AnalysisPage } from "./features/analysis/AnalysisPage";
// start() 안에서 이미 등록된 sky를 유지하고 분석 슬롯을 추가:
pages.analysis = AnalysisPage;
```

분석 컴포넌트 안에서는 다음 공통 코드를 사용한다.

```tsx
import { useSession } from "../../auth/SessionProvider";
import { usePageContext } from "../../app/usePageContext";
import { Link } from "react-router-dom";

const { member } = useSession();
const { ticId, historyId, postId, returnTo } = usePageContext();
// 서버는 세션에서 회원을 식별한다. memberId를 authorId로 전송하지 않는다.
// 분석 내용은 기능 담당자가 구현한다.
// <Link to={returnTo}>원래 화면으로</Link>
```

회원 정보는 `{memberId, nickname, onboardingDone, tutorialCompleted}`로 읽는다. `onboardingDone`과 `tutorialCompleted`는 독립이고 프론트에서 서로 유추하지 않는다. 마이페이지 성과 요약 등 추가 DTO는 해당 기능의 decoder에서 API 계약에 맞춰 확장한다.

W04에서는 `useSession().logout()`을 사용한다. 공통 Provider가 로그아웃 요청 동안 개인 화면을 제거하고 **서버 성공 후** `clear()`를 호출한다. 응답이 불명확하면 `verifyLogout()`으로 회원 상태를 확인하며 쓰기 요청을 자동 재전송하지 않는다. `clear()` 자체는 백엔드 세션을 종료하지 않는다. 401은 공통 클라이언트가 clear를 실행하고 진행 중 요청·화면의 개인 데이터를 제거한다. 403/404는 로그인 상태를 해제하지 않는다. 일반 네트워크 오류는 401로 간주하지 않는다.

## 화면 주소와 전달값

| PageSlots 키                       | 프론트 주소                                                                                        | 입력·소유 경계                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| sky                                | /sky                                                                                               | 하서진                                                             |
| profile                            | /me                                                                                                | 하서진 페이지, 백지웅 내 별/History 목록을 후속 연결               |
| settings / member                  | /settings, /members/:memberId                                                                      | 하서진                                                             |
| community / starBoard              | /community, /community/stars/:ticId                                                                | 하서진                                                             |
| postCreate / postEdit / post       | /posts/new, /posts/:postId/edit, /posts/:postId                                                    | 하서진                                                             |
| thread                             | /signal-threads/:threadId                                                                          | 하서진                                                             |
| postAttachment / commentAttachment | /posts/:postId/history-attachments/:historyId, /comments/:commentId/history-attachments/:historyId | 하서진 진입·권한, 백지웅 그래프                                    |
| analysis                           | /analysis/:ticId                                                                                   | 백지웅                                                             |
| starResults                        | /results/:ticId                                                                                    | 백지웅 별 결과                                                     |
| submissionResult                   | /submissions/:submissionId/result                                                                  | 백지웅 제출 결과; 별 결과와 다른 식별자, 이 프론트에서 추가 제안   |
| historyList / historyDetail        | /history, /history/:historyId                                                                      | 백지웅                                                             |
| publication                        | /publication/:historyId                                                                            | 백지웅 개별 공개 검토; 여러 History를 선택하는 흐름은 A12에서 확장 |
| publicAnalysis                     | /public-analyses/:analysisId                                                                       | 백지웅                                                             |
| statistics                         | /statistics                                                                                        | 백지웅                                                             |

기존 서비스 시제품의 모호한 `:id`는 각 의미의 `:historyId`, `:postId` 등으로 명명했다. URL 형태는 유지하며 새 제출 결과 경로는 검토가 필요하다. 로그인 /login, 콜백 /oauth/callback만 인증 예외다. W04에서 로그인·콜백 UI를 연결했다. 실제 제공자 로그인 완료 여부와 미확정 계약은 [202 검증 기록](ticket-202-readiness.md)을 따른다.

```ts
pagePath(
  "analysis",
  { ticId: "259377017" },
  {
    historyId: "h-501",
    postId: "p-201",
    returnTo: "/community?q=밝기&board=STAR",
  },
);
```

ID를 Number로 바꾸지 않는다. 경로의 TIC/History가 있으면 query보다 우선한다. returnTo는 같은 앱의 허용된 경로만 받고 없거나 외부 주소면 /sky로 간다. 링크를 공유하거나 새로고침해도 query 문맥은 유지된다. TIC와 History 일치·소유권은 서버 검증 대상이며 URL 값만으로 권한을 부여하지 않는다. `historyId`/`postId`는 출처 문맥이고 재전송 멱등 키가 아니다.

## HTTP와 오류

```ts
const result = await api<unknown>("/v1/me", { signal: controller.signal });
// 실제 쓰기는 CSRF 계약을 설정한 뒤 기능별 이벤트에서 호출:
await api("/v1/posts", { method: "POST", json: input });
```

- `/api` 기본 주소 + `/v1/...` 경로를 사용하며 쿠키는 항상 `credentials: include`다. 사용자 입력 URL을 API 목적지로 사용하지 않는다.
- 응답 취소·요청 취소·타임아웃·형식 오류·HTTP 오류를 구분한다. 204는 undefined이며 목록 `[]`로 바꾸지 않는다.
- `ApiError.status`, `code`, `message`, `fieldErrors[{field,reason}]`를 폼에 전달한다. React 텍스트로 표시하며 HTML을 실행하지 않는다.
- 일반 POST/PATCH를 포함해 공통 클라이언트는 자동 재전송을 하지 않는다. 네트워크 유실·시간 초과·전송 뒤 취소·불명확한 쓰기 응답은 `outcomeUnknown=true`로 전달한다. 폼은 입력을 유지하고 상세/목록 재조회로 저장 여부를 확인한다. 이 작업은 공통 신호를 제공하며 글/댓글 폼 자체의 복구는 W12/W13에서 구현·검증한다.
- 분석 제출/공개 멱등 키는 해당 API의 기능 담당자가 처리한다. 통신 추적 ID를 멱등 키로 사용하지 않는다.
- `localRequestId`는 브라우저 내 요청 구분 값이다. 임의 헤더로 서버에 보내지 않는다. 합의한 응답 헤더 이름을 `VITE_REQUEST_ID_HEADER`로 지정하면 서버 값은 별도 `requestId`로 보존한다. 현행 상세 오류 계약과 서버 ErrorResponse에는 요청 ID가 없으며 별도 추적 헤더도 확정되지 않았다. 서버 requestId=null을 유지하고, 서버 추적 기능을 201 완료의 필수 선행으로 추가하지 않는다. API 안내 README의 옛 표기와 분석 제출의 멱등 requestId는 구분한다.
- CSRF는 MR !42의 `GET /api/v1/auth/csrf` 응답 `{headerName: "X-CSRF-TOKEN", token}`을 기본으로 사용한다. 매 쓰기 직전에 발급하고 토큰은 변형하거나 저장하지 않는다. 발급 실패·취소 때 쓰기를 보내지 않는다. `VITE_CSRF_HEADER`·`VITE_CSRF_COOKIE`는 둘 다 비운다. 둘 다 지정한 기존 쿠키 방식은 호환용으로 유지하며 SESSION 쿠키를 읽는 방식이 아니다. 하나만 설정하면 쓰기를 중단한다.
- `useResource()`는 GET 전용이며 경로가 바뀌거나 unmount되면 이전 요청을 취소하고 늦은 결과를 무시한다. decoder를 컴포넌트 밖에 선언해 불필요한 재요청을 피한다.
- #182 4단계에서 `api(path, { onResponse: ({ status, headers }) => { /* 메타데이터 보관 */ } })` 선택 옵션을 추가했다. 성공·실패·204 응답의 헤더를 JSON 처리 전에 읽으며 기존 본문 반환·오류·인증·취소 처리는 유지한다. 콜백은 동기적으로 값을 보관하고 판 비교·재시도·오류 처리는 요청이 끝난 뒤 기능 코드에서 한다. 이 옵션은 fetch에 전송하지 않는다. 공통 클라이언트가 자체적으로 Bundle 재조회나 쓰기 재시도를 수행하지 않는다.
- 진행·성과·발견·History를 localStorage에 저장하지 않는다. BTJD 수치와 UTC 활동 시각은 `src/shared/types.ts`의 별도 타입으로 구분하며 기능별 API decoder에서 단위를 확인한다.

## 개발 공급과 운영 분리

`observations` 모드는 같은 개발용 인증·라우트를 사용하며 분석 3개 TIC의 읽기만 로컬 관측 export로 공급한다. 파일은 `dev/observations/`에서만 읽고 정적 public 자산이나 운영 번들에 포함하지 않는다. 입력 누락 시 503이며 정상 합성 곡선으로 대체하지 않는다. Vite의 개발 모드 선택 확장은 #201과 병합 시 함께 확인한다. 출처와 명령은 [관측 연결 안내](observation-fixtures.md)를 따른다.

`dev/fixture-plugin.ts`는 serve + fixture 모드에서 GET /me를 공급한다. #182의 분석 읽기용 GET 합성 응답도 같은 미들웨어에서 제공하며, 예제·주소·검증 범위는 [분석 데이터 읽기 안내](analysis-data.md)를 따른다. `dev/FixturePages.tsx`는 실제 공통 코드로 이동·오류·인증 공유를 시험하는 소비자이며 분석 슬롯은 `AnalysisPage`로 연결한다. 실데이터가 없을 때 운영 모드가 fixture로 자동 전환되지 않는다. 운영 라우트에는 /accounts·reset·임의 성과 기능이 없다. 개발 확인 화면은 페이지 구현 완료의 증거가 아니다.

P0는 1024px 이상이다. 더 작은 화면에는 SRS 문구로 안내만 보여준다. 접는 메뉴는 dialog·Tab 순환·Escape 닫기·원래 버튼 포커스 복귀를 유지했다.

## 팀원에게 전달할 내용

201에서 준비하는 것은 앱 실행·페이지 이동·현재 회원 조회·HTTP 요청의 공통 코드다. 지웅님에게 이 검증을 위해 새로운 분석 화면을 만들도록 요청하지 않는다.

아래는 #201 작성 당시의 인계 절차다. #182에서는 분석 컴포넌트를 등록했으며, 2026-09-16 최신 develop의 #201 코드에 응답 메타데이터 옵션과 관측 모드를 통합했다. 공통 비동기 CSRF·취소·OAuth 프록시 처리를 유지한다. Bundle 판단은 [분석 로더](../src/features/analysis/load-analysis.ts)에만 두며 실제 탐사 응답의 헤더 제공·CORS 노출과 분석 API 연동은 남아 있다.

1. 서진은 기존 MR !34와 위 파일별 사용 방법을 제공한다.
2. 지웅님이 이미 작업 중인 프론트 브랜치/컴포넌트를 공유하면, 위 예제의 AnalysisPage import를 그 실제 경로로 바꾸고 main.tsx의 pages.analysis에 등록한다. 예제의 features/analysis/AnalysisPage 파일은 이 티켓에서 만든 실제 분석 구현이 아니다.
3. 연결 화면에서 useSession()의 회원, usePageContext()의 TIC/History/원 글/returnTo를 사용한다. API는 src/api의 공통 api()를 사용한다.
4. 같은 로그인 상태로 별지도 연결 자리 → 분석 화면 → 원래 주소 복귀, 분석 직접 URL·새로고침을 확인한다. 분석 기능 전체 완성은 이 연결 시험의 선행 조건이 아니다.

서진님이 전달한 지웅님의 동의는 공통 사용 방향의 합의로 기록한다. 아직 실제 컴포넌트를 받아 연결 시험을 한 것으로 기록하지 않는다. 새 입력 API나 서버 추적 ID 구현을 공통 기반의 추가 선행으로 요구하지 않는다. 기능 API가 준비되면 해당 폼에서 오류 표시도 대조한다. 배포 주소·HTTPS·Safari의 남은 확인은 [인수 상태](ticket-201-readiness.md)에 남긴다.

## W05 별지도 데이터 연결

203에서 `SkyDataPage`를 sky 슬롯에 등록했다. 메타·타일은 같은 `api()`/`useSession()`을 사용하며 회원/버전/level 단위 캐시를 갖는다. 204의 은하 렌더러는 `renderScene`으로 연결하고 카메라 행렬을 `viewportBounds`에 전달한다. 세부 API와 캐시·오류 규칙은 [별지도 데이터 어댑터 계약](sky-data-adapter.md)을 따른다.

분석 제출·공개 등록·재개 화면은 기존 API 성공 응답의 `skyVersion`/선택적 `asOf`를 `publishSkyChange(member.memberId, event)`에 전달한다. 지도 재진입은 메타부터 조회한다. 실제 분석/공개 기능을 이 공통 프로젝트에서 대신 구현한 것이 아니다.

## W14 공개 History 그래프 연결

App의 선택 속성 historyGraphRenderer에는 A08의 읽기 전용 렌더 어댑터를 전달한다. HistoryGraphProps의 graph는 탐사5.2/8.3과 같은 응답 객체이며 mode(CURRENT/SUBMITTED), readOnly:true를 전달한다. 네트워크 조회와 부모 권한·폴링은 W14가 관리하고 렌더러에 잔차 생성/개인 작업 조회 함수를 주지 않는다. 미등록은 명시적인 연결 준비 상태이며 실제A08 통합 완료가 아니다. [213 구현·인수](ticket-213-readiness.md).

## W16 마이페이지 내부 슬롯

본인 프로필은 [서비스 API 3.1/3.2](../../backend/docs/service-api-spec.md)의 필수 joinedAt(ISO8601 UTC)을 소비한다. 가입일은 Asia/Seoul 기준 날짜로 표시하며 누락·비정상 값은 오류로 처리한다. 타인 프로필에는 가입일을 투영하지 않는다. 가입일 계약은242 / !84에서 확정되었으며 팔로우 수 정책과 별개다.

App.profileSections에 stars/history/statistics 컴포넌트를 등록한다. ProfileSlotProps는 memberId, isOwn, starListVisibility다. 본인 History/통계만 허용하고 타인 PRIVATE 별 목록은 하위 컴포넌트를 mount하지 않는다. 하위 화면도 실제 API의403/404와 권한 변경을 처리해야 하며 props는 서버 권한을 대체하지 않는다. 미등록은 연결 준비 안내다. [214 구현·범위·인수](ticket-214-readiness.md).

팔로워·팔로잉 수 표시는219(P1)의 범위다. P0 프로필은 해당 수치·팔로우 조작을 숨기며 임의0을 표시하지 않는다. P1의 API 계약·구현·인수 완료는214의 완료 선행 조건이 아니다. [MY-01 요구사항](../../../docs/requirements/planetory-requirements-spec.md)과 [214 범위 결정](ticket-214-readiness.md)을 따른다.

## W09 퀘스트 갱신

208의 `QuestProvider`가 지도와 대체 목록에 같은 퀘스트 상태를 공급한다. A06의 실제 제출 성공 뒤 `publishQuestChange(memberId, { reason: "submission" })`를 호출한다. 허용 건너뛰기 성공은 `reason: "tutorial-skipped"`, A14 안내 닫기는 `reason: "guide-closed"`이며 안내 닫기로 튜토리얼 완료나 성과를 만들지 않는다. 이벤트는 회원별 읽기 갱신 요청이고 상태 저장소가 아니다. 지도에 돌아오면 서버 상태를 새로 조회한다.

지도 데이터도 바뀌는 성공 응답은 기존 `publishSkyChange`를 사용한다. 그 이벤트 역시 퀘스트를 재조회하므로 같은 성공 사건에 두 이벤트를 반드시 함께 보낼 필요는 없다. 자세한 응답 책임·실제 연동 대기는 [208 인수 기록](ticket-208-readiness.md)을 따른다.

## 2026-09-18 리뷰 통합

지도 205~208과 커뮤니티 209 이후의 스택을 208→209로 통합했다. 실행 모드 interaction과 community, 양쪽 운영 경로를 함께 유지한다. 선행 MR이 병합된 뒤 후속 MR을 병합한다. 이 통합은 216의 실제 API·배포 인수를 대체하지 않는다.

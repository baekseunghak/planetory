# 201 공통 기반과 실제 분석 컴포넌트 통합 검증

확인일: 2026-09-17. 대상: S15P21C206-201 / W03. 상태: **프론트 통합·실제 기능 입력 오류 검증 완료. 배포/Safari 대기**. 상위 판단은 [201 인수 상태](ticket-201-readiness.md)를 따른다.

## 대상과 방법

- 201은 [MR !34](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/34)와 병합 커밋 `112aa83d9cc6ac93e7cf629c312d2e76a103652b`로 develop에 포함되어 있다. 현재 확인한 develop은 `d880b41`이다.
- 지웅님의 [182 브랜치 검증 기준](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/commit/507bd3014da815d22c8c67c92a8769ab1a7fdf26)을 별도 detached worktree에 가져와 직접 재검증했다. 원본 182 브랜치와 201 운영 코드를 수정하지 않았다.
- `src/main.tsx`는 실제 `AnalysisPage`를 개발·운영 모드 모두에서 공통 `App`의 슬롯에 등록한다. 하나의 `BrowserRouter`와 `SessionProvider`를 사용한다. 분석 코드는 공통 API 클라이언트와 `usePageContext()`를 사용한다.
- 분석 화면은 실제 182 컴포넌트다. 인증·분석 응답은 테스트 fixture와 일부 요청 가로채기를 사용했다. 실제 분석 백엔드·운영 Gold 연동 완료로 해석하지 않는다. History 소비자는 아직 fixture다.
- 환경은 Windows, Node 24.18.0/npm 11.16.0이다. 이번 실행을 Node 22 또는 배포 환경 재검증으로 세지 않는다.

## 직접 실행한 결과

| 검사                            | 결과     | 범위                                                              |
| ------------------------------- | -------- | ----------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`   | 성공     | 182의 기존 lockfile 사용                                          |
| `npm run check`                 | 성공     | 타입·빌드·개발 자료 제외, 단위 41개, Chromium 20개, 운영 빌드 2개 |
| Chrome 공통·로그아웃 검사       | 9/9 통과 | 실제 분석 컴포넌트 진입·복귀를 포함                               |
| Edge 공통·로그아웃 검사         | 9/9 통과 | 같은 시나리오                                                     |
| 정식 Firefox 공통·로그아웃 검사 | 9/9 통과 | 기존 `moz-firefox` 설정, 설치된 Firefox 사용                      |

단위·Chromium·운영 빌드 63건과 세 브라우저의 공통 검사 27건을 실행했다. 자동 검사 90건은 서로 다른 환경의 반복 시나리오를 포함한다. 기존 팀원 기록을 이번 실행 결과로 옮겨 적은 것이 아니다.

공통 화면 검사는 회원 표시·TIC/History 문자열 문맥·새로고침·이전 화면 복귀, 401 정리, 403/404와 필드 사유 표시, 늦은 응답 무시, 메뉴 키보드/포커스, 1024px 경계, 잘못된 회원 응답 차단, CSRF 후 로그아웃·실패·응답 유실을 포함한다. BTJD/UTC 구분은 타입 및 분석 데이터 단위 검사로 확인했다.

```powershell
# 182의 별도 검증 worktree / apps/frontend
npm ci --no-audit --no-fund
npm run check
npx playwright test tests/browser/foundation.spec.ts tests/browser/logout.spec.ts --project=chrome --project=msedge
$env:FIREFOX_EXECUTABLE='C:/Program Files/Mozilla Firefox/firefox.exe'
npx playwright test tests/browser/foundation.spec.ts tests/browser/logout.spec.ts --config=playwright.local-firefox.config.ts
```

## 실제 입력 오류 확인 — 후속 재실행 완료

같은 날 후속 요청에서 실행 차단 없이 최신 develop 0b7436f의 Java21 백엔드와 새 전용 PostgreSQL17.10 DB를 실행했다. 개인 OAuth 대신 가상 제공자를 사용하고 실제 Spring 세션·CSRF·컨트롤러·DB를 거쳤다. 201/182 공통 클라이언트 각각15개, 총30개 확인점 통과. profile/onboarding 입력 거부 후 회원 불변, CSRF 거부, 404, 로그아웃204, 이후401을 확인했다. [결과 JSON](live-feature-errors-201-results.json). 비어 있지 않은 fieldErrors의 새 실제 응답을 만들지는 않았다.

### 이전 시도 — 아래 실행 차단은 해소됨

최신 develop 백엔드는 Java 21로 `bootJar`가 통과했다. Docker가 실행되지 않아 설치된 PostgreSQL 17.10으로 기존 서비스와 분리된 새 검증 DB를 생성하고 기동했다. 이후 최신 백엔드와 가상 OAuth 제공자를 loopback에서 실행하는 명령이 자동 승인 검토에서 두 차례 거절되었다. 두 번째 시도는 사용자가 정확한 로컬 실행 범위를 허용한 뒤였으며, 도구는 구체적인 사유 없이 `blocked by policy`만 반환했다.

따라서 실제 API HTTP 검증은 **실행하지 못했다**. 가상 제공자 로그인·프로필 오류·CSRF·로그아웃을 검사하는 스크립트는 준비와 구문 확인만 했으며 통과 결과로 세지 않는다. 새 검증 DB는 종료했고 기존 DB·계정·개인 OAuth 설정은 사용하지 않았다. 이번에 DB 마이그레이션이나 로그인·회원 변경이 실행되었다고 주장하지 않는다.

정적으로 확인한 현행 157 API의 계약도 구분한다. `PATCH /api/v1/me/profile`의 잘못된 닉네임과 `PATCH /api/v1/me/onboarding`의 false/null은 `VALIDATION_FAILED`를 반환하며, 현재 서비스 코드는 필드별 사유를 추가하지 않는다. 공통 `ErrorResponse`는 비어 있는 `fieldErrors`를 JSON에서 생략한다. 프론트는 이를 빈 배열로 처리한다. 이것만으로 프론트 결함이나 새로운 백엔드 수정 요구를 만들지 않는다. **비어 있지 않은 fieldErrors의 전달은 기존 MVC/클라이언트·브라우저 계약 검사 증거이고, 실제 기능 API 검증과 구분한다.**

## 체크리스트 반영과 잔여

- **201-08 완료:** 이미 공유된 실제 분석 컴포넌트가 공통 라우터·세션·문맥을 사용하는지 직접 검증했다. 분석 전체 기능이나 182의 최종 완료·병합을 201 선행으로 요구하지 않는다.
- **201-07 완료:** 이전 실제 Google·SSAFY/회원/CSRF/공통 오류 증거에 이번 실제 기능 입력 API 대조30개를 추가했다.
- **201-09 부분 완료 유지:** 실제 배포 HTTPS와 실제 Safari가 남아 있다. 로컬 브라우저 검사와 구분한다.
- **201-10 부분 완료 유지:** develop 병합은 끝났다. 남은 검증과 Jira 최종 결과 등록·완료 변경은 하지 않았다.

배포·Safari 조건을 삭제하거나 후속 티켓으로 이동하는 결정은 이번 작업에 포함하지 않았다. 코드 기능 수정, commit, push, Jira 상태 변경, 팀원 댓글 전송은 하지 않았다.

로컬 원본 증거는 `output/ticket-workflow/201-closeout-20260917/`의 `analysis-integration-check.log`, `analysis-foundation-desktop.log`, `analysis-foundation-firefox.log`, `verification-summary.json`에 보존했다. 검증 worktree는 `output/Planetory-182-Validation-20260917`과 `output/Planetory-201-Validation-20260917`이다. 이 경로는 현재 PC의 작업 공간 기준이며 공유 저장소에 로그가 올라갔다는 의미가 아니다.

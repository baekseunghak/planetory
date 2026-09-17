# W03 명세 대조·검증 기록

## 현행 결과 · 2026-09-15

현재 인수 판단은 [201번 작업 범위와 인수 상태](ticket-201-readiness.md)를 따른다. 아래 과거 실행 이력의 인증 부재·Google 미검증·배포와 로컬 Docker 혼동·요청 추적 ID 필수 대기 표기는 현행 상태가 아니다.

| 검사                            | 결과                                                                            | 범위                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| npm run check                   | 타입·운영 빌드·개발 코드 제외, 단위 16/16, Chromium 9/9, dist 2/2 통과          | 9/15 현재 201 수정본에서 다시 실행                             |
| 실제 SSAFY                      | 로그인·회원 조회·새로고침·로그아웃·재로그인 성공                                | 백엔드 1cf1cca, 실제 제공자, 로컬 HTTP·전용 DB                 |
| 실제 Google                     | 가입·회원/설정/첫 별/진행 상태 각 1개, /me·새로고침·로그아웃·재로그인·중복 없음 | 백엔드 d50c75e3, 실제 제공자, V1~V4 전용 DB                    |
| 실제 Spring + 시험 OAuth 제공자 | Vite HTTP 확인점 17, Nginx 확인점 6, 백엔드 자동 검사 17 통과                   | 제공자만 시험용, 실제 세션·DB·오류·CSRF                        |
| 오류 응답 대조                  | 프론트 13, 백엔드 5, 실제 HTTP 5, MVC 본문 대조 5 통과                          | 상세는 오류 검증 기록. 인증된 기능 입력 API의 종단 시험은 아님 |
| 지웅님과 공통 코드 사용         | 서진님이 이견 없음을 전달                                                       | 실제 A 화면 연결 시험·공식 MR 승인과 구분                      |
| 배포 HTTPS / 실제 Safari        | 대기                                                                            | 환경이 준비되면 재개. 코드 정리·리뷰는 진행 가능               |

Windows Node 24.18.0/npm 11.16.0에서 현재 수정본의 기본 검사를 실행했다. 앞선 204 통합 소스의 Node22·정식 Firefox·로컬 Nginx 결과를 현재 201 수정본에서 재실행한 것으로 세지 않는다. 실제 제공자 검증의 코드 버전·데이터·환경 한계도 각각의 기록을 보존한다.

### 현재 수정본의 지원 브라우저와 쿠키 검사

- Chrome·Edge 각각 9/9 통과. 쿠키 검사 방식 보완 후 Chromium·Chrome·Edge의 해당 시나리오 각각 1/1도 재통과했다.
- 정식 Firefox 155.0.1 + Playwright moz-firefox에서 9/9 통과했다. 번들 Firefox 실행 문제가 해결됐다는 의미는 아니다.
- 최초 Firefox 실행은 8/9였다. 가로챈 요청의 Cookie 헤더가 누락되어 실패했고, allHeaders로 변경해도 동일했다. 검사를 개발 HTTP 서버의 실제 쿠키 수신 확인으로 바꾸자 통과했다. 쿠키 포함 여부·회원 정보·TIC/History·복귀/새로고침 검증을 제거하지 않았다.
- dev/fixture-plugin.ts는 고정 시험 쿠키의 수신 여부만 응답 헤더로 알려준다. 실제 세션 값은 반사하지 않으며 운영 빌드에는 포함되지 않는다. 운영 인증 코드는 이 보완에서 변경하지 않았다.
- 마지막 개발 검사 보완 후 타입·운영 빌드·개발 코드 제외·포맷 검사도 통과했다. 재빌드 결과의 JS/CSS 해시는 보완 전과 동일하다.

실행 명령: npm run check, npx playwright test --project=chrome --project=msedge, npx playwright test --config=playwright.local-firefox.config.ts, npx playwright test --project=chromium --project=chrome --project=msedge --grep 'authenticated cookie', npm run build, npm run format:check.

Windows 정식 Firefox는 FIREFOX_EXECUTABLE 환경변수에 설치 경로를 지정한 뒤 선택 설정을 실행한다. 이 선택 설정은 기본 Playwright Firefox 프로젝트를 변경하지 않는다. [실행 결과 요약](foundation-final-201-results.json).

### 현 수정본 Node 22 Docker 재검증

201 저장소의 기존 Dockerfile build 단계를 사용해 Node 22.23.2/npm 10.9.8에서 npm ci, 타입·운영 빌드·개발 코드 제외, 단위 16/16을 통과했다. 이미지: planetory-201-final-build:20260915. 기존 DB·서비스 컨테이너는 변경하지 않았다. Node22 번들의 해시가 Windows Node24 번들과 같다는 주장은 하지 않는다. 이 실행은 실제 배포나 Nginx 런타임 재검증이 아니다.

명령: 저장소 루트에서 docker build --target build -f apps/frontend/Dockerfile -t planetory-201-final-build:20260915 ., docker run --rm planetory-201-final-build:20260915 node --version, docker run --rm planetory-201-final-build:20260915 npm test.

### 증거 문서

- [실제 SSAFY](auth-ssafy-201-validation.md), [실제 Google](auth-google-201-validation.md)
- [백엔드·Nginx](auth-backend-201-validation.md), [공통 오류](auth-error-201-validation.md)
- [공통 사용 방법](shared-frontend-contract.md), [남은 인수](ticket-201-readiness.md)

## 과거 실행 이력 — 당시 결과 보존

다음 내용은 각 실행 시점의 기록이며 현행 완료 판단에는 위 표와 연결된 인수 문서를 사용한다.

대상: `S15P21C206-201`, 기준 develop `321f10b`, SRS v1.2·서비스 API 2~3절·서버 ErrorResponse. 작성일 2026-09-14.

**최신 갱신 2026-09-15:** [실제 SSAFY 성공 기록](auth-ssafy-201-validation.md)과 [직전 백엔드 연결 기록](auth-backend-201-validation.md)을 우선한다. 아래 표는 9/14 실행 이력이다. MR !42와 201 수정본의 단위 16·기존 화면 6·dist 2·실제 HTTP 확인점 17·Nginx 확인점 6·백엔드 자동 검사 17이 통과했다. 이후 실제 SSAFY 로그인·회원 생성·회원 API 200·새로고침 유지도 확인했다. Google·배포 TLS·Safari는 새로 검증하지 않았다. 코드의 Git 업로드는 아직 하지 않았다.

## 요구사항 대응

| 기준                         | 코드/검증 대상                      | 완료 판단 범위                                                            |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| React·TS·Vite 공용 앱        | package, main, App                  | 타입·빌드·lockfile 재설치 확인                                            |
| ACC-03 / NFR-06 인증 게이트  | SessionProvider, ProtectedRoutes    | 인증 조회 fixture·401 직접 경로와 만료 처리; 실제 S03 검증은 대기         |
| ACC-04 세션 확인             | /api/v1/me decoder, clear, 취소     | 평면 memberId·상태 구분, clear는 서버 로그아웃을 대체하지 않음            |
| 공통 401/403/404·fieldErrors | api/client, RequestState            | 서버의 field/reason 보존·권한과 인증 구분·수동 읽기 재조회                |
| 요청 식별                    | ApiError.localRequestId / requestId | 로컬 식별 및 설정된 응답 헤더 보존 테스트; 서버 헤더 합의는 대기          |
| A/W 같은 라우터              | PageSlots, pagePath, usePageContext | 같은 앱의 시험 소비자로 검증; 실제 분석 컴포넌트 통합은 대기              |
| ID·BTJD/UTC                  | string 경로/decoder, shared/types   | ID 손실 방지·시각 타입 구분; 분석 과학 단위 변환은 A 범위                 |
| 자동 재전송 금지             | api/client                          | POST/PATCH 유실·취소·시간 초과는 자동 재시도 없음; 폼 복구는 각 기능 티켓 |
| NFR-08 공통 접근성           | 메뉴 dialog, RequestState           | 키보드/포커스 복귀·로딩/오류; 별/그래프 접근성은 별도 티켓                |
| NFR-17                       | DesktopGate                         | 1023px 안내 / 1024px 서비스 표시; 실제 Safari·모바일 성능 보증 아님       |
| NFR-19 / 개발 기능 분리      | dev fixture, production 검사        | 운영 번들에 계정/리셋/성과 시연·가상 회원 데이터 없음                     |
| 직접 URL·새로고침            | BrowserRouter, nginx.conf           | Vite 브라우저 검증; Docker/Nginx 배포 실행 검증은 별도                    |

## 실제 실행 결과

실행 환경: Windows, Node v24.18.0, npm 11.16.0. Docker 기준 Node 22에서의 실행은 미검증이다. 아래는 이번 작업에서 새로 실행한 결과이며 기존 시제품의 과거 기록이 아니다.

| 검사                                          | 실제 결과                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`                 | lockfile로 37개 패키지 재설치 성공                                                                                                                               |
| `npm run build`                               | TypeScript 통과, Vite 배포 빌드 통과, 개발 기능 미포함 검사 통과                                                                                                 |
| `npm test`                                    | 12개 통과: 평면 회원 DTO, 문자열 ID, 복귀 문맥, 쿠키/Headers, reason 오류, 401/403/404, 204, 본문 수신 중 취소, 자동 재전송 금지, 타임아웃, 쓰기 취소의 불확실성 |
| Chromium                                      | 화면 검증 6개 통과                                                                                                                                               |
| 설치된 Chrome                                 | 같은 화면 검증 6개 통과                                                                                                                                          |
| 설치된 Edge                                   | 같은 화면 검증 6개 통과                                                                                                                                          |
| `npm run test:production`                     | 2개 통과: 서버 미설정 503·자동 가짜 로그인 없음, 실제 dist 직접 주소/새로고침/복귀/개발 라우트 미포함                                                            |
| `vite build --mode fixture` + production 검사 | 개발 모드 이름으로 빌드해도 고정 회원/확인 화면이 배포되지 않음                                                                                                  |
| Firefox                                       | 6개 모두 브라우저 시작 단계의 `browserType.launch: spawn UNKNOWN`. 페이지 동작을 검증한 결과가 아니며 통과로 세지 않음                                           |
| Safari / Docker Nginx / 실제 S03              | 실행 환경 또는 실제 인증 구현 부재로 미검증                                                                                                                      |

브라우저 6개 시나리오: 인증 쿠키/같은 회원/TIC·History·복귀값/새로고침, 401 직접 경로 및 만료 뒤 보호 화면 제거, 403/404/필드 reason 및 재조회 복구, 이전 경로의 늦은 응답 무시, 메뉴 Tab 순환/Escape/포커스 복귀 및 1023/1024 경계, 잘못된 회원 응답과 /accounts 라우트 차단.

정상 배포 JS는 약 245KB(압축 약 79KB), CSS 약 2.8KB다. 이 수치는 공통 연결 자리의 빌드 크기이며 은하 지도 성능 인수 결과가 아니다.

## 미완료·경계

- Git에 실제 /api/v1/me·OAuth·세션 구현이 없어 실제 인증된 요청·CSRF 동작을 확인할 수 없다.
- 새 공통 앱에는 201번 외 기능 화면을 등록하지 않았다. 이전 은하 지도 등은 기존 작업 폴더에 보존되어 있다.
- 백지웅 담당 실제 화면과 공통 구조를 사용하는 통합 검토가 남았다. PageSlots fixture는 구조 확인용이다.
- 이 PC에서 Docker 명령이 확인되지 않아 Nginx 컨테이너 실행 인수는 아직 하지 않았다.
- Firefox 시작 오류를 해결한 환경에서 다시 실행하고, Safari 및 Node 22 기준을 추가 검증해야 한다. 기본 `npm run check`의 Chromium 통과가 이 검증들을 대체하지 않는다.
- Jira는 진행 중을 유지한다. 타입/fixture/브라우저 검사 통과만으로 완료 또는 전체 서비스 완성을 선언하지 않는다.

## 201번 범위 분리 후 재검증

2026-09-14, 은하 렌더러·별 상세·퀘스트 등 후속 기능을 분리한 공통 기반에서 다시 실행했다.

- `npm ci --no-audit --no-fund`: lockfile 기준 37개 패키지 설치 성공.
- `npm run check`: 타입·빌드·운영 코드 분리 검사, 단위 12개, Chromium 6개, dist 2개 모두 통과.
- `npm run format:check`: 통과.
- 코드와 별도로 기본 fixture 실행 포트를 58267로 구분했다. 테스트 전용 포트는 기존과 같다.
- 최신 `origin/develop`은 `321f10b`이며 실제 인증 구현이 아직 없다. 인증 담당 Jira는 `S15P21C206-156`, 확인 시점 해야 할 일이다.
- 이번에는 실제 백엔드·A 컴포넌트·Safari·Firefox·Docker·배포 인수를 통과했다고 기록하지 않는다. [완료 조건 대조](ticket-201-readiness.md)에 재개 조건을 적었다.

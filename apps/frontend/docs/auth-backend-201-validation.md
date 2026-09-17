# 201 실제 백엔드 연결 검증 · 2026-09-15

이 문서는 **시험 제공자 단계의 실행 이력**이다. 이후 사용자 제공 설정으로 [실제 SSAFY 로그인 검증](auth-ssafy-201-validation.md)을 완료했다. 아래의 실제 제공자 미확인 문구는 이 단계 당시의 상태이며 현재 SSAFY는 성공으로 갱신됐다.

현행 판정은 [201 인수 상태](ticket-201-readiness.md)를 따른다. 아래의 실제 제공자·요청 추적 ID 필수 대기 등은 당시 기록이며, 실제 Google/SSAFY와 공통 오류 계약의 후속 검증이 완료됐다.

## 결론과 범위

인증 백엔드는 Git에 있다. [백승학의 156번 MR !42](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/42), `feature/S15P21C206-156-oauth`의 `1cf1cca`를 별도 detached worktree에서 빌드했다. MR을 승인·병합하지 않고 201 프론트에서 실제 HTTP로 연결했다. 확인 당시 최신 `origin/develop`은 `0237215`다.

**Spring Boot·PostgreSQL·회원 생성·SESSION·CSRF·로그아웃은 MR의 실제 구현**이다. 프론트 fixture, 응답 가로채기, 로그인 우회 API를 사용하지 않았다. Google·SSAFY 개인 설정 파일이 없어 **외부 OAuth 제공자만 로컬 시험 제공자로 대체**했다. 이 결과를 실제 Google/SSAFY 로그인 성공이나 배포 완료로 간주하지 않는다.

DB는 이 검증에서 새로 만든 전용 DB다. MR의 Flyway V1을 적용하고 MR의 `AuthIntegrationTest`와 같은 가상 TIC 1~5를 seed했다. 기존 DB를 변경하지 않았다. 최신 develop DB와의 호환성 및 실제 튜토리얼 데이터 인수는 검증하지 않았다. 백엔드 원본 코드도 변경하지 않았다.

## 이번 201 변경

- 쓰기 요청 전에 `GET /api/v1/auth/csrf`의 `{headerName, token}`을 받아 `X-CSRF-TOKEN`으로 그대로 보낸다. XOR 토큰을 가공하거나 저장하지 않으며 매 쓰기마다 새로 요청한다.
- CSRF를 기다리는 동안 계정 변경·취소·시간 초과가 발생하면 쓰기를 뒤늦게 보내지 않는다. POST/PATCH 자동 재전송은 하지 않는다.
- Vite와 Nginx에서 `/api/`, `/oauth2/`, `/login/oauth2/`를 백엔드에 전달한다. `/login`은 프론트 로그인 자리로 유지한다.
- 요청 추적 응답 헤더는 MR에 없으므로 빈 설정을 유지한다. 브라우저의 `localRequestId`를 서버 추적 ID로 표시하지 않는다.

## 실행 결과

| 검사                              | 결과         | 증거의 범위                                                |
| --------------------------------- | ------------ | ---------------------------------------------------------- |
| Java 21 백엔드 Docker 빌드        | 통과         | MR 원본 `bootJar`                                          |
| MR 백엔드 자동 검사               | 17/17        | 인증 10, 오류 처리 4, 앱 3; 별도 DB의 시험 스키마          |
| 201 타입·운영 빌드·개발 코드 제외 | 통과         | 실제 201 수정본                                            |
| 프론트 단위 검사                  | 16/16        | 기존 12 + CSRF/취소 4                                      |
| 기존 Chromium 화면 / dist 검사    | 6/6, 2/2     | fixture 기반 회귀 검사; 실제 API 증거와 구분               |
| Chrome → Vite → 실제 백엔드       | 17/17 확인점 | 가로채기 없음; OAuth 제공자만 시험용                       |
| Chrome → Nginx → 실제 백엔드      | 6/6 확인점   | 실제 dist, OAuth 시작/콜백, 쿠키, 새로고침, 오류, 로그아웃 |
| Nginx 구성 검사                   | 통과         | 201 `nginx.conf`, 전용 Docker 네트워크                     |

실제 HTTP로 확인한 내용:

1. 미인증 `/me` 401과 보호 화면의 로그인 이동.
2. 코드 교환 → DB 회원 생성 → 평면 `/me` → 공통 회원 표시.
3. 로그인 전후 SESSION 교체, HttpOnly, SameSite=Lax, JavaScript 읽기 차단, 새로고침 유지. 로컬 HTTP이므로 Secure=false이며 배포 Secure 검증과 구분한다.
4. 실제 403/404가 공통 오류로 전달되고 회원 상태는 유지됨. 요청 추적 ID는 없는 그대로 null.
5. CSRF 없는 로그아웃과 로그인 전의 오래된 토큰은 403. 공통 클라이언트의 새 토큰 발급 → POST 정확히 한 번 → 204 성공.
6. 로그아웃 후 `/me` 401이 공통 회원 상태를 제거함. 재로그인 시 동일 DB 회원을 반환함.
7. 운영 Nginx에서 프론트 `/login`과 백엔드 콜백이 충돌하지 않음. 직접 URL·새로고침의 TIC/History 문맥 유지, API/정적 파일 404 보존.

실제 분석 화면 연결은 확인하지 않았다. 테스트에 쓰인 `/analysis/:ticId`는 201의 페이지 연결 자리다.

비밀값을 제외한 확인점별 결과: [Vite 17개](auth-backend-201-vite-results.json), [Nginx 6개](auth-backend-201-nginx-results.json).

## 이 PC에서 재현

로컬 검증 도구와 원본 결과는 `C:/Users/SSAFY/Documents/ChatGPT/BrandNewDay/output/ticket-workflow/201-real-backend/`에 보관한다. 이 절대 경로는 이 PC 전용이며 팀의 공통 설치 경로가 아니다.

- `compose.yaml`: 전용 DB·시험 제공자·MR 백엔드. `nginx` 프로필은 201 dist와 nginx.conf를 읽기 전용으로 연결한다. 기존 204 빌드/런타임 이미지는 Node/Nginx 실행 파일 용도로만 사용하며, 제공하는 서비스 파일은 201의 dist다.
- `verify-browser.mjs` / `browser-result.json`: Vite의 실제 앱 클라이언트 호출 17개 확인점.
- `verify-nginx.mjs` / `nginx-result.json`: 운영 dist 프록시 6개 확인점.
- `backend-test-results`: Gradle 원본 검사 결과. 실제 사용자 정보·OAuth 비밀키는 입력하지 않았다.
- 현재 `http://localhost:58310`은 Nginx의 201 공통 기반이다. `http://localhost:58310/oauth2/authorization/ssafy`는 **시험 제공자 로그인**으로 연결된다. 실제 SSAFY 계정을 입력하는 곳이 아니다.
- backend `127.0.0.1:58308`, 시험 제공자 `127.0.0.1:58309`. 두 포트와 프론트는 로컬 PC에만 공개한다.

Vite 검사 재실행 시 Nginx web만 정지하고 201 폴더에서 `API_PROXY_TARGET=http://127.0.0.1:58308`을 지정한 뒤 `npm run dev -- --host localhost --port 58310 --strictPort`를 실행한다. 같은 포트를 동시에 사용하지 않는다. 다른 기존 시제품/검증 서버는 그대로 둔다.

## 실제 Google·SSAFY 연결로 전환하는 조건

팀이 제공한 실제 서버 주소를 프록시에 넣거나, MR의 `apps/backend/docs/oauth-setup.md`에 따라 Git에 제외된 개인 OAuth 설정을 준비해 실제 제공자로 실행한다. 시험 제공자 URL override와 시험 client 값은 제거한다. 개발자센터 콜백 URL과 브라우저 주소의 호스트/포트를 일치시킨다.

프론트는 `/oauth2/authorization/{provider}`로 이동하고, 백엔드가 `/login/oauth2/code/{provider}`에서 코드를 처리한다. 고정된 `AUTH_SUCCESS_URL=/sky`로 복귀한 뒤 공통 클라이언트가 `/api/v1/me`를 조회한다. 202 로그인 버튼/프로필 설정 전체 UI를 201에서 대신 구현하지 않는다. 실제 제공자 설정 없이도 끝낸 위 검증을 다시 처음부터 만들 필요는 없다.

## 남은 완료 조건

- **201-07 부분 완료:** 실제 백엔드의 `/me`·401/403/404·세션·CSRF·로그아웃 연결 완료. 실제 Google/SSAFY 로그인, 기능 API의 실제 `fieldErrors`, 서버 요청 추적 ID 계약/응답 확인은 남는다. MR !42의 오류 단위 검사가 실제 기능 API의 입력 오류 인수를 대신하지 않는다.
- **201-08:** 지웅님 실제 컴포넌트 최소 하나의 같은 라우터/세션 진입·복귀.
- **201-09 부분 완료:** 로컬 Nginx 인증 프록시까지 확인. 실제 배포 HTTPS·쿠키·Safari 확인은 남는다. 이전 204 통합 환경의 Firefox/Node22 결과는 별도 범위이며 이번 수정본의 Safari/Firefox 인수라고 하지 않는다.
- **201-10:** 리뷰·develop 병합·Jira 결과 등록. 이번 변경은 201 브랜치 로컬에만 있고 commit/push/MR 갱신·타 티켓 완료 변경은 하지 않았다.

201-07~10의 여러 조건 중 일부만 통과했으므로 전체 줄을 체크하지 않는다. 현재 201은 진행 중이다.

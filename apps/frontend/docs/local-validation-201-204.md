# 201~204 로컬 환경 검증 — 2026-09-15

백엔드와 분석 담당 화면 없이 가능한 기능·실행환경만 확인했다. 가상 HTTP 응답을 사용했으며 실제 OAuth/API/DB, 운영 배포, Safari, 팀 리뷰·병합은 완료하지 않았다. 215의 10만 별 성능은 사용자 결정으로 보류하며 이번에 재측정하지 않았다.

검증 소스는 201 `0333e949` → 202 `3660bfc2` → 203 개별 별 보완 → 204 개별 별 보완을 포함한 이 브랜치다. 201/202의 기존 작업 폴더는 변경하지 않았다. 203의 공통 데이터 코드는 같은 보완본을 사용한다. Node 22 결과는 203 단독 이미지가 아니라 이 통합 소스의 결과다.

## Firefox 기능

Windows 11, 정식 Firefox **155.0.1**. Playwright **1.63.0**의 `moz-firefox` BiDi 경로와 Selenium **4.35.0**의 실제 입력/HTTP 검사를 함께 사용했다. 실행 불가였던 번들 Firefox가 고쳐졌다는 뜻은 아니다.

| 기존 기능 검사 | 결과                           | 보완 확인                                                                                                                   |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 201 공통       | 5/6                            | 나머지 경로/복귀 assertion 이후 쿠키 헤더 검사 실패. BiDi가 가로챈 요청 헤더에 쿠키가 없어서 실제 HTTP 프록시 수신으로 검증 |
| 202 인증       | 6/9                            | BiDi fill/한글 삽입이 React 입력 상태를 갱신하지 않은 3건을 Selenium 실제 키 입력으로 검증                                  |
| 203 데이터     | 8/8                            | 개별 별 페이지·부분 실패·버전 교체 등 기존 검사 그대로 통과                                                                 |
| 204 현행 렌더  | 10/11 + 나머지 1건 재실행 통과 | BiDi의 모션 감소 에뮬레이션 대신 Firefox 실제 `ui.prefersReducedMotion=1` 설정으로 context loss/복구·공전 정지 확인         |

원래 테스트를 통째로 34/34 통과했다고 기록하지 않는다. **기존 검사 30건 통과 + 실제 HTTP/입력 보완 4건 통과**다. 보관용 구 군집 비교 4건은 이번 Firefox 범위에서 제외했다. 기존 Chromium/Chrome/Edge 결과는 [204 인수 기록](ticket-204-readiness.md)에 별도로 남겼다.

보완 4건은 쿠키 전달과 직접 URL 복귀, 한글 닉네임 중복/금칙/공백 처리, 저장 뒤 응답 본문 유실 시 입력 보존·수동 GET 확인, 저장 성공 후 회원조회 오류·복귀 경로 보존이다. [보완 결과 JSON](firefox-native-results.json).

최초 장애 주입에서 응답 헤더 전 소켓을 닫자 Firefox 전송 계층이 PATCH를 반복 전송했다. 최종 검사는 헤더 수신 후 본문 유실로 조건을 분명히 했다. 앱이 자동 재전송하지 않는 것과 네트워크 전체의 정확히 한 번 전송은 다르다. 후자는 실제 서버의 멱등/중복 처리 인수가 필요하며 이번 결과로 보장하지 않는다.

재현 (앱 폴더, 설치된 정식 Firefox 필요):

```powershell
$env:FIREFOX_EXECUTABLE='C:/Program Files/Mozilla Firefox/firefox.exe'
$env:FRONTEND_SUITE='data' # foundation / auth / data / galaxy
npx playwright test --config=playwright.local-firefox.config.ts
# galaxy 현행 범위:
$env:FRONTEND_SUITE='galaxy'
npx playwright test --config=playwright.local-firefox.config.ts --grep-invert 'comparison uses|wheel drag|automatic LOD|snapshot errors'
# 위 모션 검사 1건은 실제 설정으로 다시 실행:
$env:FIREFOX_REDUCED_MOTION='1'
npx playwright test --config=playwright.local-firefox.config.ts --grep 'context loss'
Remove-Item Env:FIREFOX_REDUCED_MOTION
```

보완 검사는 별도 터미널에서 `npx vite --mode auth --host 127.0.0.1 --port 58302 --strictPort` 실행 후 아래 명령을 사용한다. 인증 서버는 가상 응답이며 실제 로그인 서비스가 아니다.

```powershell
npm ci --prefix tools/firefox-functional
$env:SE_AVOID_STATS='true'
node tools/firefox-functional/verify.mjs
```

결과는 `test-results/stock-firefox-native/results.json`. WebDriver 최초 설치 시 네트워크가 필요할 수 있다. 앱의 package.json/lockfile에 Selenium을 추가하지 않았다.

## Node 22 / Docker / Nginx

- Docker Desktop 4.86.0 / Engine **29.7.2**.
- `node:22-alpine`: 실제 **Node 22.23.2 / npm 10.9.8**. 잠금 파일 `npm ci`, 타입·운영 빌드·개발 코드 제외 통과. **단위 53/53** 통과.
- `nginxinc/nginx-unprivileged:1.27-alpine`, `nginx -t` 통과. 같은 Docker 네트워크의 `backend:8080`은 이번 검사용 HTTP 서버다.
- Chrome **153.0.8010.36**, Firefox **155.0.1** 각각 6건 통과: `/sky` 직접 진입, 새로고침 후 1,000별, 분석 연결 자리 직접 URL/새로고침, 없는 정적 파일404, API503이 HTML로 바뀌지 않음, HttpOnly 가상 쿠키 왕복. [결과 JSON](local-runtime-results.json).
- 호스트 `127.0.0.1:58304`에만 바인딩했다. TLS, 실제 제공자 리다이렉트, 서버 세션 정책, 분석 화면 구현의 인수가 아니다.

검사에서 **Dockerfile에 렌더 활성화 ARG가 빠진 것**을 발견했다. `ARG VITE_SKY_RENDERER_ENABLED=false`를 추가해 빌드 시 활성화할 수 있게 했으며 기본값은 유지했다. `true` 빌드의 실제 캔버스와 별 1,000개로 검증했다.

저장소 루트에서:

```powershell
docker build -f apps/frontend/Dockerfile --target build --build-arg VITE_SKY_RENDERER_ENABLED=true -t planetory-local-204-build:20260915 .
docker run --rm planetory-local-204-build:20260915 node --version
docker run --rm planetory-local-204-build:20260915 npm test
docker build -f apps/frontend/Dockerfile --build-arg VITE_SKY_RENDERER_ENABLED=true -t planetory-local-204-runtime:20260915 .
```

런타임 이미지는 `backend:8080`에 접근할 수 있는 배포 네트워크에서 실행해야 한다. 데이터는 이미지에 넣지 않는다. 실제 API로 바꾸어도 동일한 직접 URL·쿠키·오류 검사가 추가로 필요하다.

## 완료 처리하지 않은 것

201 실제 인증/상대 컴포넌트, 202 실제 OAuth/세션/CSRF, 203 C05 서버 동시성/교차 리뷰/분석 성공 이벤트, 204 C06 실제 회원 행성 필터/저장 좌표 인수는 대기다. 205 조작·206 상세·207 대체 목록은 후속 티켓이다. Safari와 운영 환경 및 리뷰·develop 병합이 남아 있으므로 201~204 Jira는 진행 중으로 유지한다.

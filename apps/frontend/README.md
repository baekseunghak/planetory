# Planetory 공용 프론트

2026-09-17 통합 갱신: 최신 develop 충돌 정리와 재검증은 [202 MR 통합 기록](docs/merge-readiness-202.md)을 기준으로 합니다. 아래 이전 실행 기록의 미업로드·미통합 표기는 당시 상태입니다.

`S15P21C206-201` / W03. 별지도·서비스 화면과 백지웅 담당 분석 화면이 같은 React 앱, 페이지 이동, 인증 조회, HTTP 클라이언트를 사용하는 출발점이다.

현재 기능 화면은 연결 자리다. 기존 은하 지도·행성 뷰·분석 기능을 이 작업에서 완성한 것으로 보지 않는다. 기존 시제품의 공통 코드를 바탕으로 추출·보완했으며 운영 소스가 `experiments`를 import하지 않는다.

## 실행

Node 22.12 이상을 사용한다. 저장소 Docker 기준은 Node 22이며 `.node-version`도 22다. 이 앱은 기존 Dockerfile의 `npm ci`와 맞추기 위해 **npm + package-lock.json**을 사용한다. `experiments/analysis-ui`의 pnpm 실행환경은 별도 실험으로 유지한다.

```powershell
cd apps/frontend
npm ci
npm run dev:fixture
```

이 PC의 연결 확인 주소: `http://127.0.0.1:58267/sky`. 테스트 응답으로 고정 회원 정보를 공급한다. 화면·메뉴·TIC/History 전달 확인만 제공하며 계정 선택·리셋·임의 성과 지급·실제 분석/제출 기능은 없다. 기존 은하 지도와 분리된 공통 기반 확인용 포트다.

실제 서버로 연결할 때:

```powershell
Copy-Item .env.example .env.local
# .env.local의 API_PROXY_TARGET에 실제 실행 중인 백엔드 주소를 입력
npm run dev
```

예를 들어 Git에 있는 백엔드를 로컬 8080 포트로 실행했다면 `API_PROXY_TARGET=http://127.0.0.1:8080`으로 설정한다. Compose 프론트 컨테이너에서 실행할 때는 같은 네트워크의 `http://backend:8080`을 사용한다. 설정하지 않으면 개발 서버는 API 요청에 503 안내를 돌려준다. 실제 서버 모드에 자동 가짜 로그인은 없다.

**2026-09-15 상태:** 실제 SSAFY·Google 로그인, 회원 조회·세션·CSRF·로그아웃과 공통 오류 계약을 검증했다. 지웅님과 공통 기반 사용 방향에 이견이 없음을 서진님이 전달했다. 배포 지연을 감안해 코드 정리·공유·리뷰를 진행하며, 실제 A 화면 연결·배포 HTTPS·Safari와 최종 리뷰/병합은 별도로 남긴다. [검증 기록](docs/verification.md), [현재 인수 상태](docs/ticket-201-readiness.md)를 따른다.

## 검증 명령

```powershell
npm run build
npm test
npm run test:browser
npm run test:production
```

기본 브라우저 검증에는 Playwright Chromium이 필요하다. 설치되지 않은 PC는 `npx playwright install chromium`을 실행한다. `npm run test:browser:desktop`은 설치된 Chrome·Edge와 Playwright Firefox를 추가 검증한다(Firefox 설치: `npx playwright install firefox`). 번들 Firefox가 실행되지 않는 Windows에서는 정식 Firefox 경로를 FIREFOX_EXECUTABLE로 지정하고 `npx playwright test --config=playwright.local-firefox.config.ts`를 사용할 수 있다. Safari 실기기 검증은 별도다. 브라우저 테스트는 58262 포트에 별도의 serve-only fixture를 띄운다. 일반 개발 서버에 연결하거나 사용자의 기존 브라우저 세션을 사용하지 않는다.

`npm run build`는 타입 검사·배포 빌드·개발 데이터/계정 기능 미포함 검사를 실행한다. `vite build --mode fixture`도 fixture를 포함하지 않도록 `command === serve`와 `import.meta.env.DEV`로 제한했다.

`npm run test:production`은 먼저 빌드한 dist를 58264 포트에서 확인한다. 개발용 고정 회원 없이 서버 미설정 503 안내가 나타나는지, 배포 코드의 직접 경로·새로고침·개발 화면 미포함을 검사한다. `npm run check`는 빌드·단위·기본 Chromium·배포 코드 검증을 순서대로 실행한다.

## 팀원 연결 방법

- [공통 코드 사용·화면 연결 계약](docs/shared-frontend-contract.md)
- [명세 대조 및 검증 기록](docs/verification.md)
- [201번 완료 조건과 남은 연동 확인](docs/ticket-201-readiness.md)
- [156번 실제 백엔드 연결 결과·설정 방법](docs/auth-backend-201-validation.md)
- [실제 SSAFY 로그인 성공 기록](docs/auth-ssafy-201-validation.md)
- [실제 Google 로그인 성공 기록](docs/auth-google-201-validation.md)
- [기존 분석 프론트 명세](../../docs/development/analysis-frontend-spec.md)
- [서비스 API](../backend/docs/service-api-spec.md)

## 배포 연결

```powershell
# 저장소 루트에서 실행
docker build -f apps/frontend/Dockerfile -t planetory-frontend:201 .
```

Nginx는 `/analysis/...`, `/history/...` 직접 진입·새로고침에 index.html을 제공하고 `/api/`, `/oauth2/`, `/login/oauth2/`는 같은 서비스 네트워크의 `backend:8080`으로 전달한다. 프론트 `/login`은 유지하며 API 오류를 HTML 성공 응답으로 바꾸지 않는다. API 목적지가 다르면 배포 담당자가 프록시 설정을 조정한다. TLS·OAuth 등록 URL·실제 세션 쿠키 속성은 인증/배포 담당 인수 대상이다.

`VITE_*`는 빌드 시 결정된다. 기본 CSRF 계약은 MR !42의 `GET /api/v1/auth/csrf`이며 쓰기 전에 발급된 토큰을 `X-CSRF-TOKEN`으로 전송한다. `VITE_CSRF_HEADER`/`VITE_CSRF_COOKIE`는 둘 다 비워 둔다. 둘 다 설정한 기존 쿠키 방식은 호환용으로만 유지한다. 요청 추적 응답 헤더는 MR에 없으므로 임의로 설정하지 않는다. 토큰·개인 비밀키는 빌드 인자에 넣지 않는다.

## W04 로그인 화면 검증

`npm run dev:auth` → http://127.0.0.1:58268/login. 두 버튼은 개발 전용 인증 응답을 사용한다. 실제 OAuth 제공자 연동이 아니다. 최초 닉네임·취소·실패·서버 연결 설정과 남은 인수 조건은 [202 검증 기록](docs/ticket-202-readiness.md)을 참고한다. 기존 별지도 시제품은 이 브랜치에 포함하지 않는다.

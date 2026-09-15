# Planetory 공용 프론트

`S15P21C206-201` / W03. 별지도·서비스 화면과 백지웅 담당 분석 화면이 같은 React 앱, 페이지 이동, 인증 조회, HTTP 클라이언트를 사용하는 출발점이다.

로그인(202)과 별지도 데이터 로딩(203)을 공통 기반에 연결했다. 나머지 기능 화면은 연결 자리다. 기존 은하 지도·행성 뷰·분석 기능을 이 작업에서 완성한 것으로 보지 않는다. 기존 시제품의 공통 코드를 바탕으로 추출·보완했으며 운영 소스가 `experiments`를 import하지 않는다.

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

**현재 Git 기준 인증 상태:** 기반 브랜치 `321f10b`에는 `/api/v1/hello`와 공통 오류 처리가 있으나 실제 `/api/v1/me`·OAuth·세션 구현은 없다. fixture 성공은 실제 S03 인증 성공 증거가 아니다. 실제 인증된 GET·오류·A/W 기능 연결 인수 전에는 201번을 완료 처리하지 않는다.

## 검증 명령

```powershell
npm run build
npm test
npm run test:browser
npm run test:production
```

기본 브라우저 검증에는 Playwright Chromium이 필요하다. 설치되지 않은 PC는 `npx playwright install chromium`을 실행한다. `npm run test:browser:desktop`은 설치된 Chrome·Edge와 Playwright Firefox를 추가 검증한다(Firefox 설치: `npx playwright install firefox`). Safari 실기기 검증은 별도다. 브라우저 테스트는 58262 포트에 별도의 serve-only fixture를 띄운다. 일반 개발 서버에 연결하거나 사용자의 기존 브라우저 세션을 사용하지 않는다.

`npm run build`는 타입 검사·배포 빌드·개발 데이터/계정 기능 미포함 검사를 실행한다. `vite build --mode fixture`도 fixture를 포함하지 않도록 `command === serve`와 `import.meta.env.DEV`로 제한했다.

`npm run test:production`은 먼저 빌드한 dist를 58264 포트에서 확인한다. 개발용 고정 회원 없이 서버 미설정 503 안내가 나타나는지, 배포 코드의 직접 경로·새로고침·개발 화면 미포함을 검사한다. `npm run check`는 빌드·단위·기본 Chromium·배포 코드 검증을 순서대로 실행한다.

## 팀원 연결 방법

- [공통 코드 사용·화면 연결 계약](docs/shared-frontend-contract.md)
- [명세 대조 및 검증 기록](docs/verification.md)
- [201번 완료 조건과 남은 연동 확인](docs/ticket-201-readiness.md)
- [기존 분석 프론트 명세](../../docs/development/analysis-frontend-spec.md)
- [서비스 API](../backend/docs/service-api-spec.md)

## 배포 연결

```powershell
# 저장소 루트에서 실행
docker build -f apps/frontend/Dockerfile -t planetory-frontend:201 .
```

Nginx는 `/analysis/...`, `/history/...` 직접 진입·새로고침에 index.html을 제공하고 `/api/`는 같은 서비스 네트워크의 `backend:8080`으로 전달한다. `/api/` 오류를 HTML 성공 응답으로 바꾸지 않는다. API 목적지가 다르면 배포 담당자가 프록시 설정을 조정한다. TLS·OAuth 등록 URL·실제 세션 쿠키 속성은 인증/배포 담당 인수 대상이다.

`VITE_*`는 빌드 시 결정된다. Docker 빌드 인자로 API 기본 경로, **합의된** CSRF 헤더/쿠키 이름, 요청 식별 응답 헤더 이름을 전달할 수 있다. 토큰 값은 넣지 않는다. 현재 CSRF 이름·발급 방식은 미확정이며 설정 없이 쓰기 요청을 실행하면 `CSRF_NOT_CONFIGURED`로 전송 전에 중단한다.

## W04 로그인 화면 검증

`npm run dev:auth` → http://127.0.0.1:58268/login. 두 버튼은 개발 전용 인증 응답을 사용한다. 실제 OAuth 제공자 연동이 아니다. 최초 닉네임·취소·실패·서버 연결 설정과 남은 인수 조건은 [202 검증 기록](docs/ticket-202-readiness.md)을 참고한다. 기존 별지도 시제품은 이 브랜치에 포함하지 않는다.

## W05 별지도 데이터 로딩

`npm run dev:sky-data` → http://127.0.0.1:58270/sky. MR !41의 v1.3 개별 별 페이지·원본 카메라 투영·부분 실패·새 버전·선택 유지용 개발 검사 화면이다. 2,501개를 여러 페이지로 받는 fixture이며 최종 은하 디자인은 204에서 연결한다. 일반 실행과 운영 빌드에는 이 검사 화면/가상 API가 없다.

- [203 완료 조건 대조·실제 연동 대기](docs/ticket-203-readiness.md)
- [렌더러와 skyVersion 이벤트 연결](docs/sky-data-adapter.md)
- `npm run test:sky-data`: Chromium의 HTTP/화면 검사 8개. `npm run check`에도 포함한다.

## W06-1 개별 별 은하

2026-09-15 사용자 승인된 MR !41 7f67c568의 v1.3을 로컬 적용했다. 군집/성운과 고정 개수 상한을 제거하고 원본 개인 시제품의 좌표·색·크기·카메라를 사용한다. 운영 코드가 별 위치를 생성하지 않는다.

이번 확인 주소는 http://127.0.0.1:58275/sky?reference=1 이다. npm run dev:galaxy의 기본 포트는58272다. 가상 자료로1/10/100/1000/2501개를 확인하며 클릭·드래그 등 실제 조작은205, 상세 화면은206에서 연결한다.

- [렌더 구조·205/206 연결](docs/galaxy-renderer.md)
- [204 항목별 인수/대기](docs/ticket-204-readiness.md)
- [기존 군집 비교 보관본](docs/galaxy-comparison.md)
- npm run test:galaxy: 현행 렌더11개와 보관 비교4개.
- npm run test:renderer-production: 활성화 dist2개,58276 포트.

실제 서버는 VITE_SKY_RENDERER_ENABLED=true와 기존 인증/API 설정을 사용한다. 기본 플래그는false, npm run build:renderer는 활성화 빌드다. 개발 도구/가상 API는 운영에 포함하지 않는다. 문서 팀 승인·실제 API·리뷰/병합은 대기 중이다. 기존 Draft MR !40에서 검토한다.

- [201~204 Firefox·Node22·로컬 Nginx 검증](docs/local-validation-201-204.md)
- Docker 활성화: 저장소 루트에서 `docker build -f apps/frontend/Dockerfile --build-arg VITE_SKY_RENDERER_ENABLED=true -t planetory-frontend:204 .`

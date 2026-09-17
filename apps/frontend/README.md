# Planetory 공용 프론트

2026-09-17 통합 갱신: 최신 develop 충돌 정리와 재검증은 [202 MR 통합 기록](docs/merge-readiness-202.md)을 기준으로 합니다. 아래 이전 실행 기록의 미업로드·미통합 표기는 당시 상태입니다.

`S15P21C206-201` / W03. 별지도·서비스 화면과 백지웅 담당 분석 화면이 같은 React 앱, 페이지 이동, 인증 조회, HTTP 클라이언트를 사용하는 출발점이다.

로그인(202)과 별지도 데이터 로딩(203)을 공통 기반에 연결했다. 나머지 기능 화면은 연결 자리다. 기존 은하 지도·행성 뷰·분석 기능을 이 작업에서 완성한 것으로 보지 않는다. 기존 시제품의 공통 코드를 바탕으로 추출·보완했으며 운영 소스가 `experiments`를 import하지 않는다.

## 실행

Node 22.12 이상을 사용한다. 저장소 Docker 기준은 Node 22이며 `.node-version`도 22다. 이 앱은 기존 Dockerfile의 `npm ci`와 맞추기 위해 **npm + package-lock.json**을 사용한다. `experiments/analysis-ui`의 pnpm 실행환경은 별도 실험으로 유지한다.

```powershell
cd apps/frontend
npm ci
npm run dev:fixture
```

이 PC의 연결 확인 주소: `http://127.0.0.1:58267/sky`. 테스트 응답으로 고정 회원 정보를 공급한다. 화면·메뉴·TIC/History 전달과 #182 분석 데이터 읽기를 합성 응답으로 확인한다. 계정 선택·리셋·임의 성과 지급·실제 분석/제출 기능은 없다. 기존 은하 지도와 분리된 공통 기반 확인용 포트다.

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

### #182 분석 데이터 읽기·시간 곡선·판 갱신 (4단계)

`/analysis/:ticId`는 [AnalysisPage](src/features/analysis/AnalysisPage.tsx)를 표시한다. 공통 `usePageContext()`에서 문자열 TIC와 검증된 복귀 주소를 읽으며, 인증·라우터는 기존 공통 구현을 사용한다. 공통 API 클라이언트로 분석 문맥과 곡선을 순서대로 읽고, 분석 전용 어댑터가 응답을 검사한다. Bundle·단위·Sector·점 수와 시간 차트를 표시한다. 실제 서버 연동은 아직 완료하지 않았다.

[main.tsx](src/main.tsx)는 개발용 페이지 목록을 읽은 뒤 `analysis`만 이 컴포넌트로 등록한다. fixture 모드에서도 실제 분석 페이지를 확인할 수 있고, 별지도·회원 정보 등 다른 슬롯은 유지한다. 다른 기능 브랜치와 병합할 때는 각 기능의 페이지 등록을 함께 보존한다.

`npm run dev:fixture` 실행 후 별지도의 분석 링크로 진입한다. 정상 예제는 Sector 2개·전체 14점·유효 11점·결측 3점이다. 샘플 계정과 분석 응답은 Vite 개발 서버가 제공한다. 샘플 JSON 구조, 정상·오류 주소, 데이터 출처와 검증 범위는 [분석 데이터 읽기 안내](docs/analysis-data.md)에 기록한다. 실제 인증·분석 API 연동을 검증한 것은 아니다.

[시간 차트](src/features/analysis/TimeCurveChart.tsx)는 유효점 전체를 Canvas로 그린다. `null`에서 선을 끊고 Sector 사이의 시간 간격은 `//`로 축약한다. 실제 BTJD와 밝기는 보존한다. 휠·버튼·키보드로 확대·이동하고, 점에 마우스를 올리거나 ↑/↓로 수치를 확인한다. 구간 선택·주기·접기·제출 기능은 포함하지 않는다.

4단계는 응답 헤더·409의 판 변경을 감지해 문맥부터 한 번 자동 재조회하고, 반복 경합에서는 수동 재시도를 안내한다. `최신 자료 확인`으로 수동 조회할 수도 있다. 이전 차트와 늦은 응답을 새 문맥에 섞지 않으며 서버의 현재 진행 단계와 복원 안내를 따른다. 디자인은 이후 한 번에 적용한다. 현재는 기능 확인용 화면이며 실제 서버·잔차 폴링·초안 초기화 연동은 남아 있다. 자세한 동작과 샘플은 위 분석 데이터 읽기 안내를 따른다.

프로토타입에서 사용한 TESS 3개 항성은 `data:prepare`로 로컬 데이터를 준비한 뒤 `dev:observations`로 확인한다. TOI-270·L 98-59·CM Draconis의 기존 정제값을 10분 평균 배열로 변환하며, 실제 관측 곡선과 로컬 인증·진행 메타데이터를 구분한다. 준비 명령·변환 규칙·건수·검증은 [관측 데이터 연결 안내](docs/observation-fixtures.md)를 따른다. 생성 파일은 Git과 운영 번들에서 제외한다.

### 공통 참고 문서

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

Docker의 OAuth 기본값은 `VITE_OAUTH_SSAFY_URL=/oauth2/authorization/ssafy`, `VITE_OAUTH_GOOGLE_URL=/oauth2/authorization/google`이다. 인자를 생략한 기본 이미지에서도 두 로그인 버튼을 사용할 수 있다. 특정 제공자를 의도적으로 끄려면 해당 `--build-arg VITE_OAUTH_..._URL=`을 명시한다. 실행 중 컨테이너에 환경 변수를 추가해도 이미 빌드된 프론트 설정은 바뀌지 않는다.

`npm run test:docker-defaults`는 Dockerfile의 build 단계에 있는 `VITE_*` 기본값을 읽어 별도 `dist/docker-defaults`에 빌드한 후 58330 포트에서 기존 운영 브라우저 검사를 실행한다. 호스트 `VITE_*`와 로컬 `.env`를 제외해 잘못된 기본값이 개인 설정으로 가려지지 않게 한다. 이 검사는 Docker 엔진 없이 실행할 수 있으며 실제 Linux 이미지/Nginx·배포 HTTPS 검증을 대체하지 않는다. `npm run check`에도 포함한다. [리뷰 수정 검증](docs/merge-readiness-202.md#docker-oauth-기본값-리뷰-수정).

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

203 통합·병합 순서와 남은 인수: [MR !36 통합 기록](docs/merge-readiness-203.md).

204 통합·병합 순서와 남은 인수: [MR !40 통합 기록](docs/merge-readiness-204.md).

최신 develop의 인증·지도·은하와 분석 브랜치를 결합한 변경 및 검증은 [2026-09-17 통합 기록](docs/develop-integration-2026-09-17.md)을 따른다.

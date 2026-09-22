# Planetory 공용 프론트

2026-09-22: [193 별 결과 화면과 공개 검토 연결](docs/analysis-star-result.md). 신호·제출 집계와 History 이동을 구현했다. 공개 처리는 195, 실제 API 인수는 별도다.

2026-09-21: [223 별 검색·위치 이동과 A13 연결 범위](docs/ticket-223-readiness.md). `npm run dev:star-search`로58384에서 서버 좌표 기반 검색·선택을 확인한다. 필터 HTTP·공용 입력 슬롯을 구현했으며 실제 A13 소비자와 백엔드 연결은 아직 미검증이다.
2026-09-21: [221 개인 설정 구현·잔여](docs/ticket-221-readiness.md). `/settings`에서 별 목록 공개 범위를 저장·복구한다. `npm run dev:settings`로58382에서 확인한다. 알림 수신 설정의 정책/API는 미정이며 221 전체 완료가 아니다.
219 팔로우: [프론트 기준 P1 HTTP 계약](../backend/docs/p1-service-contract.md)을 백엔드와 함께 사용한다. `node --import tsx scripts/p1-server.mjs`는58392에서 실제 제품 코드에 개발용 HTTP를 공급한다. 제품 활성화는 `VITE_P1_ENABLED=true`이며 가짜 응답을 운영으로 가져오지 않는다. 커뮤니티의 팔로잉과 마이페이지의 관계 관리를 분리한다.
192 현재 판 다시 풀기: [계획·구현·로컬 검증·시각 기준 확인 사항](docs/analysis-retry-draft.md). 화면·초안·제출 출처 연결과 Gold 중앙 시각 정합화를 구현했다. 실제 API·DB 인수는 남아 있다.

2026-09-21: 기존 P0 화면을 승인된 시제품의 배치와 디자인에 맞춘다. [248 명세 비교·제외 범위·검증 체크리스트](docs/prototype-presentation-248.md)를 따른다. `npm run dev:presentation`은 58381에서 실제 제품 화면에 메모리 임시 별 5,000개를 공급하는 로컬 검토 도구이며 운영 API 인수가 아니다.

248 후속: 별 상세의 구조·표면·조작 이식은 아직 미완료다. [시제품 상세 이식 기준·간헐 실패 원인](docs/prototype-detail-parity-248.md)을 따른다. 작은 화면으로 바뀔 때 이미 연 페이지를 숨겨 상태를 보존하며, 세션 만료 시 비공개 화면 제거는 유지한다.

2026-09-20 W20-2: 커뮤니티의 핫 토픽 목록·유효 공개 분석 참여자10명 선정 기준·상세 복귀를 연결했다. `npm run dev:hot-topics`로58368에서 합성 HTTP 데이터를 확인한다. [218 구현·검증·216 인계](docs/ticket-218-readiness.md)를 따른다. 실제 S18 집계 인수는216-218에서 진행한다.

2026-09-18 W20-1: 커뮤니티 제목·본문/현재 닉네임/TIC/게시판/태그 검색과 상세 복귀를 연결했다. `npm run dev:search`로58364에서 합성 HTTP 데이터를 확인한다. [217 구현·검증·216 인계](docs/ticket-217-readiness.md)를 따른다. 실제 S16 연결은216-217에서 인수한다.

2026-09-18 W13-2: 일반 글 반응·취소·반응자 목록을 연결했다. `npm run dev:reactions`로58352에서 개발 자료를 확인한다. [212 구현·검증 및216 인계](docs/ticket-212-readiness.md)를 따른다.211 MR !78 선행 병합이 필요하다.

2026-09-18 W13-1: 일반 글·공식 스레드 댓글 CRUD와 응답 유실 복구를 연결했다. `npm run dev:comments`로58350에서 개발 자료를 확인한다. [211 구현·검증 및216 인계](docs/ticket-211-readiness.md)를 따른다.210 MR !76 선행 병합이 필요하다.

2026-09-18 W12: 일반 글 작성·본인 수정/삭제와 응답 유실 복구를 연결했다. `npm run dev:posts`로58348에서 개발 자료를 확인한다. [210 구현·검증 및216 인계](docs/ticket-210-readiness.md)를 따른다.209 MR !75 선행 병합이 필요하다.

2026-09-18 W11: 전체/별/자유 피드, 일반 글 상세, 공식 신호 스레드·공개 판단 요약·공개 분석 목록·토론 조회를 연결했다. `npm run dev:community`로58346에서 개발 자료를 확인한다. [209 구현·계약 검증 및 실제 연동 인수](docs/ticket-209-readiness.md)를 따른다. 검색은217, 핫 토픽은218에서 연결했다.
2026-09-17: 208 튜토리얼·챌린지·재개 퀘스트를 지도와 대체 목록의 공용 패널로 연결했다. `npm run dev:quests`는 58345의 개발용 합성 응답이다. 실제 API 확인 범위와 남은 제공자 연결은 [208 구현·인수 기록](docs/ticket-208-readiness.md)을 따른다.

2026-09-17: 207 WebGL 대체 발견 목록·키보드 전환을 연결했다. `npm run dev:fallback`으로 58338에서 확인한다. [207 구현·검증과 실제 인수 대기](docs/ticket-207-readiness.md)를 따른다.

2026-09-17: 206 별 상세·내 행성 확대·복귀·공통 경로 이동을 연결했다. `npm run dev:detail`로 확인하며 [206 항목별 인수와 남은 실제 연동](docs/ticket-206-readiness.md)을 따른다.

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

### #183 주기도 탐색·선택·판 변경 복구 (4단계)

주기도·공개 봉우리의 응답 검증과 전체/확대 탐색 화면에 주기 선택·미세 조정을 연결했다. 추천 봉우리 선택은 출처를 보존하고 직접 선택은 null 출처로 구분하고 미세 조정은 보류한다. 범위 밖 입력은 기존 선택을 유지하며 오류를 안내한다. 탐색 조작은 선택을 변경하지 않고 미세 조정은 계산 API를 호출하지 않는다. 로딩·빈 자료·오류·미계산을 구분하며 시간 곡선은 유지한다. 새 Bundle 헤더·409를 감지하면 문맥·곡선·주기도를 한 번 자동 재조회하고 이전 선택을 제거한다. 반복 경합은 수동 재시도로 전환한다. 접힌 곡선은 아래 #184에서 연결하며 실제 관측 세 항성의 주기도는 아직 미연결 상태다. 화면의 `주기도 정상 샘플`에서 확인하며 미세 조정 범위·샘플 응답·조작·검증·접근성 검토는 [주기도 개발 안내](docs/periodogram-data.md)를 따른다.

### #184 위상 접기 계산·그래프·복구·로컬 성능 검증 (1~4단계)

현재 곡선의 전체 유효점을 Bundle 기준 시각과 원본 주기로 접는 Worker를 주기 선택 화면에 연결했다. 같은 Canvas에 두 주기를 표시하고 ×1~32 가로 확대·복귀·키보드 조작을 제공한다. 재선택은 ×1 전체 보기, 미세 조정은 배율과 화면 중심 위상을 유지한다(SRS v1.3.1 변경안 적용). 계산 중 마지막 성공 그래프를 유지하며 실패·무응답·취소 시 성공 주기·입력 범위·그래프·확대 위치를 함께 복구한다. 재시도는 실패하거나 취소한 주기를 다시 계산한다. 후속 진행 가능 상태도 제공하지만 구간·판단·제출 UI와 초안 복구 연동은 #185 이후 기능에서 연결해야 한다. 입력/결과 구조, 샘플과 검증 범위는 [위상 접기 개발 안내](docs/phase-folding.md)를 따른다.

4단계에서는 상태 표시로 차트가 이동하는 현상을 수정하고, 밀집한 화면은 모든 관측점을 픽셀 버퍼에 합성해 그리는 방식으로 개선했다. `npm run test:performance`로 배포 빌드의 세 합성 규모를 반복 측정할 수 있다. 30만 점 전체 보기의 긴 작업은 남아 있으며, 실제 데이터 최대 규모·지원 기기 성능 기준과 백엔드 연동은 아직 검증 완료가 아니다.

문제 발견, 시도한 방법과 선택 이유, 측정 조건·전후 수치, 회고 및 포트폴리오용 요약은 [위상 접기 성능 개선 사례](docs/phase-folding-performance.md)에 정리한다.

추가로 [Canvas·WebGL 성능 실험](docs/phase-folding-gpu-experiment.md)을 `npm run test:gpu`로 재현할 수 있다. 분리 렌더러는 58265, 실제 개발 화면 비교는 `npm run test:gpu:app`의 58266 포트를 사용한다. 개발 화면의 `개발용 접기 렌더러`에서 WebGL을 선택할 수 있고 실패하면 Canvas로 자동 전환한다. 일반 배포는 Canvas를 유지하며 검증 진행표는 실험 문서에서 관리한다.

### #185 위상 구간 선택·분석 단계·판단·제출 확인 (로컬 검증 완료·API 인수 대기)

선택 규칙·위상 정규화, 선택 밴드·두 핸들, 시간 미리보기·예상 띠에 이어 판단 3종·근거 3종·메모와 제출값 확인을 연결했다. 기본 드래그는 구간 선택, Shift+드래그는 선택을 유지하는 좌우 이동이다. 구간 수정 시 작성 내용은 유지하고 구간·제출값을 재확인한다. 재접기 중 입력을 잠그고 실패·취소 시 이전 초안을 복원하며 성공하면 초기화한다. 실제 제출은 #187 API 연결 전까지 비활성이다. 단계별 계획, 사용법, 샘플 계산, 검증과 미확정 조건은 [위상 구간 선택 개발 안내](docs/phase-selection.md)를 따른다.

5단계 이후 사용자 결정으로 메모 200자와 같은 탭의 sessionStorage 초안을 적용했다. 새로고침/복귀 시 「초안 불러오기」로 현재 자료를 검증하고 다시 접으며 구간·제출값을 재확인한다. 로그아웃·인증 만료·회원 변경 때 분석 초안을 지운다. 단위 127개·빌드, Chrome/Edge 각각 89개, Firefox/Playwright WebKit 각각 29개 시나리오를 확인했다. 분석 본문 네 상태의 axe 자동 검사는 위반 0건이다. 실제 Safari·스크린리더·API 수치·제출·히스토리 왕복과 미확정 선택 정책은 인수 대기다. 상세 범위와 재검사 이력은 [개발 안내](docs/phase-selection.md#메모-200자와-탭-세션-초안)에 기록한다.

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

별지도 성능 측정은 [215 재현 방법·구조](docs/performance-215.md)와 [215 결과·잔여 조건](docs/ticket-215-readiness.md)을 따른다. `npm run dev:performance`는 별도 production-compiled 서비스 화면과 로컬 HTTP fixture를58360에서 제공한다. 제품 빌드에는 포함되지 않으며214 브랜치가 필요하지 않다.

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

- [213 본인 History·공개 출처 첨부](docs/ticket-213-readiness.md) — 자료 선택·부모 권한·A08 소비 어댑터와 인수 조건.

- [214 프로필·닉네임·사용법 다시 보기](docs/ticket-214-readiness.md) — npm run dev:profiles (58356), 내 가입일 joinedAt 표시 반영·팔로우 수 정책 미확정.

## W06-2 은하 지도 조작과 마커

205는 기존 은하에 드래그 회전·팬·휠·키보드·개별 별/내 행성 선택과 가시 DOM 마커 풀을 연결한다. `npm run dev:interaction`은58326의 개발 HTTP fixture, `npm run test:interaction`은 독립 입력 검사다. 운영은 기존 렌더 활성화 플래그와 API 연결을 사용한다. [205 항목별 구현·검증·실제 연동 대기](docs/ticket-205-readiness.md)를 참고한다. 206 상세 화면·207 대체 접근·배포 인수는 별도다.

## 206~207 상세·대체 목록과 최신 실제 연결

[206 상세 인수](docs/ticket-206-readiness.md), [207 대체 목록 인수](docs/ticket-207-readiness.md), [201~207 최신 실서버 검증](docs/latest-integration-201-207-20260917.md)을 참고한다. 현재 develop 854c23c의 퀘스트 API를 연결했으며 201~204는 develop에 병합됐다. 과거의 퀘스트404와 실제 연결 대기는 구버전 서버 검증 이력이다. 최신 기능은 205→206→207 순서로 검토하며 배포·상대 목적지·Safari 인수는 남는다.

## 2026-09-18 MR 리뷰 통합 결과

[205~214 리뷰 수정·통합 검증](docs/mr-review-fixes-20260918.md)을 현재 기준으로 확인한다. 앞선 실행 이력의 독립 스택·오래된 develop 표기는 당시 기록이다. 현재는 205→214 순차 의존이며 기존 API/배포 인수 범위를 유지한다.

최신 develop의 인증·지도·은하와 분석 브랜치를 결합한 변경 및 검증은 [2026-09-17 통합 기록](docs/develop-integration-2026-09-17.md)을 따른다.

분석 1–5단계의 Figma 적용 범위와 조작·검증은 [분석 디자인 적용 기록](docs/analysis-design.md)을 따른다.

### P1 시제품 반영 인계
[구현 순서·백엔드 인계](docs/p1-prototype-rollout.md). 공개 은하 250은 전체 보유 별을 대상으로 하며 219~223 계약과 함께 배포 연결한다. 개발용 실행은 npm run dev:p1, 검증은 npm run test:p1.

2026-09-21 출처 카드(167): ID 없는 `available:false` 항목은 글·댓글에서 대체 안내로 표시하며 조회·링크를 생성하지 않는다. 본문·History만 수정하면 출처 PATCH를 생략하고, 무효 출처는 공개 출처 전체 제거로 명시적으로 해제한다. 기존 213 첨부 그래프 동작을 유지한다. 계약은 [서비스 API 7장](../backend/docs/service-api-spec.md#attachments)을 따른다.

2026-09-21 출처 카드 리뷰 보완(167): 응답 유실 후 `sourceLinks:[]`의 반영 여부는 유효·무효 출처가 모두 사라졌을 때만 성공으로 판단한다. 출처 필드를 생략한 본문 수정은 기존 무효 출처를 유지한다.

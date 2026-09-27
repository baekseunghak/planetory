# 시네마틱 전환 (`src/cinema`)

상태: `experiment/S15P21C206-274-web-cinematic-core` 실험 브랜치([S15P21C206-274]). 분석 화면 A/B 선택은 팀 결정 전이다. 셸이 `App.tsx`·`main-cinema.tsx`에 연결되어 앱 전체가 이 은하 위에서 돈다. 운영 계약·API는 바꾸지 않는다.

운영 기본은 켜져 있다(2026-09-27): 운영 이미지는 CI가 `VITE_CINEMA=true`로 빌드해 시네마만 넣으므로, 운영에는 기존 화면과 `?ui=` 선택이 없다. `VITE_CINEMA`를 두지 않은 빌드(Dockerfile 기본값, 로컬 `npm run build`)는 기존 화면(`src/legacy`)을 띄우고, 방문자가 `?ui=cinema`로 들어온 브라우저만 시네마를 띄운다(아래 "화면 플래그와 저사양 정책").

목표: 은하 하나가 앱 전체다. 화면 전환은 그 위의 카메라 이동과 패널이다.
로그인 → 내 은하로 진입 → 별로 비행 → 항성계 → 분석 패널 → 발견 시 통과 장면 → 행성 등장 → 은하로 복귀 → 새 별 점화.

## 직접 실행해 보기

발표 시연 순서(주소·계정·실제 별·정확한 클릭·초기화·저사양 대처)는 [`DEMO.md`](DEMO.md)에 따로 둔다.

필요한 환경: Node 22.12 이상, 그래픽 가속이 켜진 Chrome, 폭 1024px 이상 화면. 데이터는 모두 합성이며 각자 컴퓨터의 메모리에서만 돈다. 실제 서버와 운영 DB는 사용하지 않는다.

```bash
cd apps/frontend
npm ci
npm run dev:cinema
```

1. 브라우저에서 `http://127.0.0.1:58390/api/dev-cinema/session?as=anonymous`를 연다. 로그인 화면에서 `SSAFY 계정으로 로그인`을 누르면 은하로 들어간다(합성 로그인).
2. (2–4는 합성 자료 기준이다. `.real-sample/`이 있으면 튜토리얼·탐사 자리의 TIC가 실제 별로 바뀌므로 `CINEMA_REAL_SAMPLE=0`으로 띄운다. 실제 표본의 자리는 `GET /api/dev-cinema/state`의 `placement`.) 파란 3번 마커(TIC 900000003)를 누르고 `분석 시작`을 누른다. 회원에게는 새 디자인 분석만 보인다(예전 기존형으로 띄우려면 `CINEMA_ANALYSIS=classic npm run dev:cinema`). `기존형 / 새 디자인` 토글은 `VITE_CINEMA_DEV_TOOLS=true npm run dev:cinema`로 띄운 개발 서버에서만 나온다(아래 "전환 스위치").
3. `1위 봉우리`(약 11.73일)를 고르고 위상 0 또는 1의 밝기 감소를 구간으로 잡은 뒤 `행성 같음 → 제출값 확인 → 제출하기`. 통과 장면, 발견 카드, 은하 복귀 후 새 별 점화가 이어진다.
4. 다른 경우: `/sky?star=900000011`(구간이 빗나가면 수치 불일치), `/sky?star=900000012`(판단 불일치), `/sky?star=900000001`(행성 5개, 후보는 점선 궤도).
5. 처음 상태로: `curl -X POST http://127.0.0.1:58390/api/dev-cinema/reset`. 포트를 바꾸려면 `CINEMA_PORT=<포트> npm run dev:cinema`.
6. 데모 시나리오: 화면 위 가운데의 `DEMO` 탭(평소에는 보이지 않고, 마우스를 올리거나 Alt+Shift+D로 연다)에서 계정·은하 크기·다른 탐사자의 은하를 고른다. 주소로는 `/api/dev-cinema/session?as=newcomer|member|veteran`(아래 "데모 시나리오"). P1 화면(알림·팔로우·공개 은하·통계·탈퇴)은 기본으로 켜져 있다. `CINEMA_P1=0`이면 운영처럼 알림·전체 통계·탈퇴만 끈다(팔로우·공개 은하·내 통계는 운영에서도 켜져 있다, `features/p1.ts`).
7. 실제 TESS 별: `apps/frontend/.real-sample/`이 있으면 그 별들이 튜토리얼·탐사 자리에 들어간다(아래 "실제 TESS 표본"). 없으면 모두 합성이다. 기존 화면으로 보려면 `VITE_CINEMA=false npm run dev:cinema`, 운영과 같은 선택(기본 기존 화면, `?ui=cinema`로 시네마)은 `VITE_CINEMA=auto npm run dev:cinema`.

알려진 한계: Chromium 계열에서만 확인했다. 그래픽 가속이 없는 환경(원격 데스크톱, 일부 CI)에서는 저사양 경로로 그린다(아래 "화면 플래그와 저사양 정책"). 기존 브라우저 테스트 일부는 화면 변경으로 실패한다(아래 최종 수정 메모 참고).

## 소유 범위 (완성 작업)

병렬 작업자는 자기 파일만 고친다. 다른 사람 파일의 타입 오류는 고치지 말고 보고한다. 표에 없는 파일은 고치기 전에 보고한다.

| 작업자                            | 파일                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 시나리오                          | `dev/cinema-fixture-plugin.ts`, `dev/cinema-scenarios.ts`, `scripts/cinema-server.mjs`, `scripts/cinema-smoke.mjs`, `src/cinema/shell/public-galaxy/**`, `src/cinema/shell/demo/**`                                                                                                                                                                                                                                                |
| 화면                              | `src/cinema/pages/**`(CSS 포함). 기존 `src/features/**` 컴포넌트는 피할 수 없을 때만 최소 수정하고 파일을 보고에 나열한다                                                                                                                                                                                                                                                                                                          |
| 안정성                            | `src/cinema/scene/**`, 위 두 폴더를 뺀 `src/cinema/shell/**`, `src/cinema/flags.ts`, `src/cinema/ui/**`, `src/cinema/styles/**`, `src/main.tsx`, `src/main-cinema.tsx`, `src/app/App.tsx`, `src/components/ServiceLayout.tsx`, `src/legacy/**`(새로 만듦), `src/features/analysis/celebration.ts`와 축하 판정 줄, `tests/unit/cinema-shell.test.ts`, `tests/unit/cinema-public-stage.test.ts`, `tests/unit/cinema-scene-*.test.ts` |
| 데이터                            | `tools/real-sample/**`(Python, uv), `dev/real-sample/**`, `apps/frontend/.gitignore`, `tests/unit/cinema-real-sample.test.ts`. 결과물은 `.real-sample/`(Git 제외)                                                                                                                                                                                                                                                                  |
| 공유(선택 필드·인자 추가만, 보고) | `src/cinema/scene/contract.ts`, `src/cinema/analysis/bridge.ts`, `dev/submission-fixtures.ts`, `dev/submission-outcome-fixtures.ts`, `dev/galaxy-fixture-plugin.ts`, `dev/analysis-fixtures.ts`, `dev/periodogram-fixtures.ts`                                                                                                                                                                                                     |
| 이번에는 고치지 않음              | `src/cinema/analysis-classic/**`, `src/cinema/analysis-new/**`, `src/cinema/analysis/AnalysisSwitch.tsx`. 고칠 일이 생기면 보고한다                                                                                                                                                                                                                                                                                                |

- `package.json`·`package-lock.json`은 아무도 고치지 않는다. 필요한 의존성은 설치돼 있다: `three@0.186.1`, `@types/three@0.186.0`, `@fontsource/ibm-plex-sans-kr@5.3.0`, `@fontsource/ibm-plex-mono@5.3.0`.
- 화면 작업자는 `src/cinema/pages/index.ts`의 `cinemaPages`에 라우트 키별 컴포넌트를 넣는다. `main.tsx`가 기존 페이지 위에 합친다(기능 fixture 모드 제외). 빠진 키는 기존 페이지가 그대로 뜬다.
- 공개 은하는 장면에 그려진다(`public-galaxy/index.tsx`의 `PUBLIC_GALAXY_READY = true`, 아래 "다른 탐사자의 은하"). `false`로 돌리면 `/members/:id/sky`는 배경 위의 페이지가 된다.

## 데모 시나리오 (`dev/cinema-scenarios.ts`가 정본)

`GET /api/dev-cinema/session?as=<값>`으로 바꾼다. 응답은 쿠키를 바꾸고 이 탭의 분석 초안(`planetory:analysis-draft:*`)을 지운 뒤 다음 주소로 넘어가는 작은 페이지다. newcomer·member·veteran은 바꿀 때마다 그 시나리오의 새 세계(은하·제출·진행·잔차 작업·팔로우)를 만든다. `POST /api/dev-cinema/reset`은 지금 시나리오를 같은 크기로 처음부터 다시 만든다. 서버 시작 시나리오는 `CINEMA_SCENARIO=newcomer|member|veteran`(기본 member).

| `as`           | 은하                            | 상태                                                                                |
| -------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `newcomer`     | 튜토리얼 별 5개                 | 튜토리얼 0개 완료, `onboardingDone=false`(로그인 뒤 튜토리얼 1로 비행), 팔로우 없음 |
| `member`(기본) | `CINEMA_STARS`(1000)            | 튜토리얼 1·2 완료, 3명 팔로우                                                       |
| `veteran`      | `stars=5000`(기본) 또는 `10000` | 튜토리얼 모두 완료, 별의 12%가 탐색 완료(8%는 행성 1–3개), 4%가 탐색 중, 4명 팔로우 |
| `anonymous`    | 그대로                          | 로그아웃, `/login`                                                                  |

- `stars=<n>`(10–20000)은 member·veteran 크기, `start=login`은 세계를 만든 뒤 로그아웃 상태로 `/login`에 둔다(로그인하면 그 세계로 날아든다), `next=<경로>`는 이동할 곳.
- 발표 순서 예: DEMO 탭에서 `로그인 화면에서 시작` + `처음 온 탐사자` → SSAFY 로그인 → 튜토리얼 1(실제 표본이면 WASP-62)로 자동 비행 → `분석 시작` → 1위 봉우리, 감광 구간, 행성 같음 → 통과·발견 카드 → `은하로 돌아가기` → 새 별 점화(실제 표본이면 TOI-270, 챌린지 자리). 이어서 `오래 탐사한 회원` 별 5,000/10,000, 마지막으로 커뮤니티 글쓴이 → 프로필 → `은하 방문하기`.
- 진행 규칙(개발 서버): 실제 별은 모든 신호를 찾으면 탐색 완료(`all_found`)이고 튜토리얼 별이면 그 퀘스트가 끝난다. 합성 튜토리얼 별은 첫 인정 성과로 끝난다. 튜토리얼 1의 첫 제출(또는 `PATCH /v1/me/onboarding` true)로 `onboardingDone=true`(AT-86). `GET /v1/me`의 닉네임·`onboardingDone`·`tutorialCompleted`·`achievementSummary`는 지금 세계에서 센다(상단 발견한 별·찾은 행성과 같은 값).
- 실제 표본의 자리: member·veteran은 `defaultRealPlacement`(탐사 별 5, 8, 9…), newcomer는 발견으로 열리는 순서대로 5, 6, 7…에 탐사 별을 둔다. veteran은 탐사 별을 하나 걸러 실제 행성과 함께 탐색 완료로 둔다. 합성 TIC 구간(900000001–904000000)과 겹치는 실제 TIC는 빼고 경고한다. 분석 fixture TIC와 같은 실제 별(TOI-270 = TIC 259377017)은 은하에서 실제 별이 이긴다.
- 전환 UI: `src/cinema/shell/demo/DemoSwitch.tsx`. `CinemaRoot`가 `import.meta.env.DEV && VITE_CINEMA_DEMO === "true"`(dev:cinema만)일 때 지연 로드한다. `/api/dev-cinema/scenarios`가 답하지 않으면 아무것도 그리지 않는다. 배포 파일에 들어가면 `scripts/check-production.mjs`가 `dev-cinema` 문자열로 막는다.
- 모든 시나리오의 회원 ID는 `u-209`다(다른 fixture가 이 ID를 "나"로 쓴다). 새 세계마다 제출 번호를 시각 기반 새 번호에서 시작한다(`resetSubmissionFixtures(첫 번호)`). 같은 번호가 돌아오면 브라우저의 축하 이력(`planetory:analysis-celebrated`)이 연출을 막기 때문이다.

### 다른 탐사자의 은하 (`shell/public-galaxy`)

- `/members/:memberId/sky`는 장면 `public` 단계다. 그 탐사자의 별을 같은 장면에 올리고(`setStars` 뒤 `showOverview`), 별을 누르면 그 별로 날아가 그 사람이 찾은 행성을 보여 준다(`?star=`). 분석 행동은 없고, 왼쪽 위 카드에 주인 이름·공개한 별·찾은 행성과 `← 나의 은하로`·프로필·팔로우가 늘 있다. 내 상단 집계는 이 화면에서 숨긴다(주인 카드가 센다). 내 은하에도 있는 별(튜토리얼 별)은 `내 은하에서 이 별 보기`로 잇는다.
- 가는 길: 커뮤니티 글쓴이 → 프로필 `은하 방문하기`, 왼쪽 아래 `다른 탐사자`(내가 팔로우한 탐사자와 나를 팔로우한 탐사자, `GET /v1/me/following/members`·`/v1/me/followers`), 마이페이지 `나의 연결`, DEMO 탭.
- 탐사자(`DEMO_MEMBERS`): `u-301` 별지기 50개, `u-211` 다른탐사자 1,000개, `u-302` 행성사냥꾼 2,400개, `u-303` 은하수집가 10,000개, `u-210` 비공개. 커뮤니티 공개 분석 글쓴이 `u-3NN`과 `u-orbit-217`(Orbit)도 작은 은하를 만든다. 첫 5개는 모두 같은 튜토리얼 별이고(실제 표본이면 실제 행성), 나머지는 탐사자마다 다른 TIC다(901000001부터).
- 개발 서버의 커뮤니티 fixture 글(p-201–p-244)은 다섯에 넷을 위 탐사자가 쓴 것으로 바꿔 보낸다(나머지는 내 글, 수정 가능). 팔로우 상태는 세계마다 새로 만든다.
- 떠날 때는 `SkyProvider`가 내 별을 다시 올리고, 다음 단계가 카메라를 쓰지 않으면 내 은하를 전체 보기로 다시 잡는다. 새로 고침으로 바로 들어오면 로그인 비행이 시작된 뒤에 움직인다(감독과 같은 턴에 카메라를 다투지 않게 한 박자 늦춘다).

## 실제 TESS 표본 (`dev/real-sample`)

- 모양: `dev/real-sample/types.ts`(동결, 선택 필드 추가만). 파일: `.real-sample/manifest.json` + `.real-sample/stars/<TIC>.json`. `tools/real-sample`이 만든다.
- 만들기: [`tools/real-sample/README.md`](../../../../tools/real-sample/README.md)(uv, MAST에서 FITS 24개 약 48 MB, 커널 처리 약 45초). 지금 표본은 10개 별이다. 튜토리얼 1–5는 WASP-62(S2), L 98-59(S2), TIC 279569718(EB), TOI-184(EB), TIC 278956474(EB 2개)이고, 탐사 별은 TOI-270(S3–5, 행성 3개, 챌린지 자리), TOI-700(S3–5), TIC 176984144(미확정 후보), TIC 272357134·30313682(EB)다. 커널이 보류한 별(QA 실패, 후보 없음)은 넣지 않는다.
- 읽기: `loadRealSample()`(`dev/real-sample/index.ts`) — 폴더가 없으면 `null`(합성만), 모양이 틀리면 서버 시작에서 멈춘다. `CINEMA_REAL_SAMPLE=<폴더>`로 바꾸고 `0`이면 끈다.
- 자리: `defaultRealPlacement` — 튜토리얼 별은 서열 `tutorialSeq-1`(파란 1–5), 탐사 별은 5(빨간 `!`), 8, 9, 10… 은하 fixture는 `galaxyFixturePlugin(false, n, { ticFor, planetCountFor })`로 그 자리에 실제 TIC를 쓰고 합성 행성을 뺀다. 좌표는 서열 그대로다.
- 분석 읽기: 실제 별의 `analysis-context`·`curves`·`periodogram`·`candidate-peaks`는 `realAnalysisResponse(star, url, state)`. `state`는 플러그인이 기억하는 그 별의 단계와 매칭한 후보다. 다음 곡선은 제거한 후보의 통과를 상자 모양으로 되돌린 곡선이고, 잔차 작업 없이 바로 준비된다.
- 매칭: `submissionFixtureResponse({ matchSignal, detailSignal })`에 `realMatchSignal`·`realDetailSignal`을 넘긴다. 규칙은 지금과 같다. 봉우리를 고르면 그 봉우리의 신호(`candidate.peaks`, 미세 조정 폭 안), 직접 고른 주기는 같은 폭 안에서 배수 포함, 그리고 구간이 감광 중심 ± 가려진 시간의 절반을 덮어야 한다(감광 위치는 그 후보의 관측된 통과를 고른 주기로 접은 평균 위상). 빗나가면 미매칭, 상세 보기의 힌트는 가장 센 남은 후보다. 확정→`CONFIRMED`, 후보→`UNCONFIRMED`, FP→`FP`. AI 점수는 실제 값이 있을 때만 싣는다.
- 검증: `tests/unit/cinema-real-sample.test.ts`가 가짜 별 하나로 어댑터 출력을 프런트 디코더(`decodeAnalysisContext`·`decodeCurve`·`decodePeriodogram`·`decodeCandidatePeaks`·`decodeSubmissionReceipt`·`decodeDetailView`)에 통과시킨다. 잔차 곡선이 커널 예제(`libs/astro-kernel/examples/removal_case.json`)와 같은지도 본다. 이 컴퓨터에 `.real-sample/`이 있으면, 별마다 추천 봉우리를 제거 순서대로 골라 매칭되는지와 TOI-270 주기도 확인한다.

## 화면 플래그와 저사양 정책

- 앱 선택(`src/ui-choice.ts`, 단위 테스트 `tests/unit/ui-choice.test.ts`): 빌드 시 `VITE_CINEMA="true"`면 시네마, `"false"`면 기존 화면으로 고정하고 빌드에 한쪽 앱만 넣는다(`src/main.tsx`의 리터럴 조건). 운영 이미지는 `true`다(`.gitlab/ci/apps/frontend.yml`의 `BUILD_ARGS`, MR `web:build`도 같은 값). 그 밖(설정 없음, Dockerfile 기본값)은 방문마다 고른다. `?ui=cinema`는 `localStorage["planetory:ui"]="cinema"`를 저장하고 시네마를, `?ui=legacy`는 그 값을 지우고 기존 화면을 띄운다. 파라미터가 없으면 저장값이 `cinema`일 때만 시네마, 아니면 기존 화면이다. 저장소가 막혀 있어도(try/catch) `?ui=cinema`는 그 방문에만 시네마로 열린다. `ui` 파라미터는 앱이 뜨기 전에 주소에서 지운다(다른 파라미터는 그대로). 두 앱 모두 동적 import라 한 방문은 한쪽 앱의 JS·CSS만 받는다(공용 청크에 비활성 분석 브리지 `cinema/analysis/bridge.ts`·`analysis-classic/classic-bridge.ts`만 함께 온다). `npm run dev:cinema`는 `VITE_CINEMA=true`가 기본이고 `false`·`auto`(운영과 같은 선택)를 받는다.
- 기존 화면(`src/legacy/`)은 `git show fbc7da7b~1:<경로>`로 되살린 develop의 `main.tsx`·`App.tsx`·`ServiceLayout.tsx`·`LoginPage.tsx`·`auth-presentation.css`다(import 경로만 바꿈). `/sky`는 `SkyDataPage`(렌더러 플래그면 `GalaxyPage`), 분석은 `AnalysisPage`. 공유 기능 컴포넌트에 들어간 시네마용 변경은 제공자가 있을 때만 동작한다(`ModalHoldContext`, `MySkyPreviewSlot`, `ClassicBridgeScope`, `StrictCelebration`, `NextActions`의 `labels`). 퀘스트 패널 문구는 develop 그대로 두었다. 기존 화면이 develop과 같은지: 운영 인자 빌드의 소스맵 비교(바뀐 공유 모듈은 위 제공자 기반 변경뿐), 같은 fixture API 뒤에서 develop 빌드와 14개 화면의 계산된 스타일 비교(움직이는 행성 버튼 좌표 외 차이 없음), 기존 Playwright 스위트(아래 "알려진 차이").
- 저사양(`SceneState.power`, 정책·기준값은 `scene/power.ts`): `full`(빛 효과 기본 켬, DPR ≤ 1.75) → `reduced`(빛 효과 기본 끔, DPR ≤ 1, 로그인 배경 30fps·다른 페이지 배경 20fps) → `low`(DPR 0.5, 빛 효과를 켜지 않으면 후처리 없이 바로 그림) → 목록(`failed` = "화면이 느려 3D 은하 대신 별 목록으로 보여 드립니다.", `DiscoveredStars`, "3D 다시 시도" 버튼). 시작 시 `WEBGL_debug_renderer_info`가 소프트웨어(SwiftShader·llvmpipe·Microsoft Basic Render)면 `low`. 실행 중에는 은하·항성계가 멈춰 있을 때(비행·통과·점화 제외) 3초 창의 fps 중앙값이 24 미만이면 한 단계 내린다(해상도와 기본값만 바뀌고 회원이 직접 고른 빛 효과는 그대로 둔다). `low`에서 빛 효과 없이 5초 창이 10fps 미만이면 목록으로 바꾼다(회원이 빛 효과를 켜 둔 동안은 바꾸지 않는다). 빛 효과를 바꾼 직후와 별 데이터가 들어온 직후 2초도 재지 않는다(셰이더 컴파일, 큰 은하의 나눠 읽기). 숨은 탭·모드 전환·비행 뒤 2초와 4초 넘는 멈춤은 재지 않는다. 다시 올리지 않는다(세션 저장소 `planetory:scene-power`). 실행 중에 단계가 내려가면 은하에서 "화면이 느려 그래픽을 낮췄습니다"를 잠깐 보인다(시작할 때 소프트웨어 그래픽으로 정한 단계에는 보이지 않는다).
- `빛 효과` 버튼(은하 오른쪽 아래)은 모든 단계에서 실제로 켜고 끈다. 선택은 `localStorage['planetory:scene-effects']`(`on`/`off`)이고, 고른 적이 없으면 단계가 정한다. 저사양 경로에서 켜면 bloom·성운·먼지가 합성 경로로 그려진다.
- 시연용 고정: `?power=full|reduced|low|list`(그 탭에서 유지, 감시 없음), `?power=auto`는 고정과 기억을 지운다. `canvas[data-power]`, `.scene-canvas[data-scene-power]`로 현재 단계를 본다.
- 다른 페이지 뒤(`backdrop`): 흐려지는 전환이 끝나고 1.2초 동안 움직임이 없으면 그리기를 멈추고 마지막 프레임을 배경으로 둔다(`canvas[data-frozen="true"]`). 창 크기가 바뀌면 한 번 다시 그리고, 은하·별·분석으로 돌아오면 바로 다시 돈다.

## 재사용하는 것과 바꾸는 것

그대로 쓴다: `auth/SessionProvider`, `api/client`·`api/index`, `features/sky-data`(store·contracts·events), 분석 데이터·접기 Worker·제출·초안 저장·복구(`features/analysis`의 `*.ts`와 hook), 퀘스트(`QuestProvider`·`contracts`), 별 상세 읽기(`sky-renderer/detail.ts`의 `readStarDetail`·`readPlanetExplanations`), `starStyle()`·`markerLabel()`·`signalSeed()`.

바꾸는 것은 표현뿐이다. 업무 규칙을 다시 쓰지 않는다.

서비스 규칙(개발 코드가 정본):

- 별 위치는 저장된 `x`·`y`·`depthZ`. 렌더 z = `depthZ * DEPTH_SCALE`(256). 색·크기는 `starStyle()`(금빛 중심, 푸른·보라 외곽).
- 표시: 튜토리얼 = 파란 원 + 순번, 챌린지 = 빨간 `!` (`markerLabel()`, `.galaxy-marker`). DOM 표시는 `projectStar()`로 위치를 받는다.
- 항성계는 내 `planets.items`만. 미확정 후보 궤도는 점선. 행성 색은 seed(기본 바다/얼음, >.68 갈색, <.17 청록). 항성 표면은 짙은 빨강 → 금빛.
- 행성을 누르면 그 행성으로 초점, `PlanetExplanation.tsx`(NASA 자료). 별 정보·행동은 시네마 용어(미탐사/탐사 중/탐사 완료, 분석 시작/이어서 분석/다시 분석, 별 게시판)를 쓴다. 공유 기능 화면의 시네마 문구는 아래 "시네마 문구".
- 문구 "표면과 궤도는 이해를 돕기 위한 시각화입니다."를 유지한다.
- WebGL 실패 → `DiscoveredStars` 목록. 데스크톱 관문(1024px 이상) 유지. `prefers-reduced-motion` → 즉시 전환, 궤도 정지.

## 장면 계약 (`scene/contract.ts`)

`SceneProvider`를 라우트 위에 한 번 둔다. 엔진의 `SceneCanvas`가 `useRegisterScene(controller)`로 등록하고, 그 전에는 `useScene()`이 no-op 컨트롤러를 준다(모드·초점 상태만 유지, `ready=false`, 그리지 않음). UI를 `ready`로 막지 않는다. `failed`만 목록 대체에 쓴다.

모드: `intro` → `galaxy` ⇄ `system` ⇄ `analysis` → `transit`(playTransit 동안만) / 다른 페이지 뒤에서는 `backdrop`.

| 호출                                                                  | 뜻                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `setStars(stars, meta)`                                               | sky store의 `data.stars`·`data.meta`                                  |
| `setSystem(sceneSystemFrom(detail.system))` / `null`                  | 초점 별의 내 행성                                                     |
| `setMode(mode)`                                                       | 카메라 목표 없는 모드 전환(`analysis`, `backdrop`, `intro`)           |
| `playIntro()`, `showOverview()`, `focusStar(tic)`, `returnToGalaxy()` | 카메라 비행. Promise는 끝·생략·대체 시 resolve, reject 없음           |
| `focusPlanet(id \| null)`                                             | 행성 초점                                                             |
| `setViewInset({bottom,right})`                                        | 패널이 덮는 영역(px). 초점 별은 나머지 영역 가운데                    |
| `setAnalysisHint({periodDays,strength,selection})` / `null`           | 유령 궤도(강도 0..1) · 구간 선택 시 유령 행성                         |
| `playMismatch()`                                                      | 수치 불일치: 유령 궤도가 한 번 붉게                                   |
| `playTransit({periodDays,depth,durationHours,onFlux})`                | 옆에서 본 통과 장면, 실시간 밝기 콜백                                 |
| `revealPlanet(planet)`                                                | 발견한 행성이 궤도에 자리 잡음                                        |
| `ignite(tic \| star)`                                                 | 새 별 섬광·충격파. TIC만 주면 `setStars`에 올 때까지 최대 10초 기다림 |
| `holdStars?(tics \| null)`                                            | (선택, 추가) 새로 열린 별을 `ignite`까지 숨김. `null`은 모두 풂       |
| `setHomeFrame?({ticIds, margin} \| null)`                             | (선택, 추가) 홈·전체 보기 구도가 화면 안에 둘 별과 여백(px)           |
| `setEffects(bool)`                                                    | bloom·성운·먼지. 회원의 명시 선택(모든 저사양 단계에서 유효)          |
| `projectStar(tic)`, `projectPlanet(id)`, `onFrame(fn)`                | DOM 표시·라벨 위치. `onFrame`에서는 transform만 바꾼다                |
| `onReady`, `onError`, `onStarHover`, `onStarClick`, `onPlanetClick`   | 이벤트. 해제 함수를 돌려준다                                          |
| `getState()`/`subscribe()`/`useSceneState()`                          | 모드·초점·실패·효과                                                   |

`SCENE_TIMING`은 시제품의 비행 시간(ms)이다. 캔버스 위에 `backdrop-filter`를 쓰지 않는다.

## 분석 브리지 (`analysis/bridge.ts`)

분석 → 셸/장면 단방향 이벤트. 리스너 오류는 기록하고 넘기므로 분석을 깨지 않는다.

| 이벤트             | 내용                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `sessionChanged`   | `{ticId, active}` 분석 화면 진입·이탈                                                                      |
| `periodChanged`    | `{ticId, periodDays, strength, sourcePeakGridIndex, operation}`. `strength = periodStrength(data, period)` |
| `selectionChanged` | `{ticId, selection: {periodDays, startPhase, endPhase, durationHours, confirmed} \| null}`                 |
| `stageChanged`     | `{ticId, stage: 1..4}` (`analysis-stage.ts`)                                                               |
| `submitted`        | `{ticId, kind}` 전송 시작                                                                                  |
| `outcome`          | `outcomeFromReceipt(receipt, {firstView, userJudgment})` — 접수된 결과만                                   |
| `submitFailed`     | `{ticId, state, message}` — unresolved·rejected·conflict·bundle-changed·context-not-ready·denied·expired   |

`outcome.kind`는 실제 `SubmissionReceipt`의 `match.status`와 `achievement.result`로 정한다(`classifyOutcome`): `matched`(인정) · `judgmentMismatch` · `pendingPublish` · `duplicate` · `numericMismatch`(not_matched) · `ambiguous` · `noCandidate` · `skipped` · `unknown`.

- 한 번만 보일 연출(통과·점화)은 `firstView`로 가른다(축하 이력, 2.2절). HTTP 201/200(`created`)으로 가르지 않는다.
- `revealsPlanet`은 HOME-05 규칙이다: 확정은 판단과 무관하게, 미확정은 `LIKELY_PLANET`일 때만, FP는 행성이 아니다.
- 새 별 좌표는 응답이 아니라 지도에서 얻는다. 셸이 `publishSkyChange(memberId, {skyVersion})`를 부르면 store가 새 판을 읽고, 새 별이 `data.stars`에 오면 `ignite(tic)`.
- 기존 분석은 제출 뒤 지도를 갱신하지 않았다(지도가 다시 마운트되며 읽었다). 은하가 유지되므로 이제 셸이 위 호출을 맡는다.

기존형 분석의 emit 위치(최소 줄 추가):

- `sessionChanged`: `analysis-classic/index.tsx`에서 mount/unmount.
- `periodChanged`: `features/analysis/PeriodSelection.tsx` 133행 `begin`(144행 `onPeriodChange?.(next)` 옆). `data`가 있어 `periodStrength`를 계산할 수 있다.
- `selectionChanged`·`stageChanged`: 같은 파일 `PeriodSelectionWorkspace` 121–122행의 `stage`·`phase`(PhaseDraft)에 effect.
- `submitted`: `features/analysis/use-submission.ts` 202행(`run(... "sending")`), 재전송 경로 포함.
- `outcome`/`submitFailed`: 같은 파일 140행 `setState({ phase: "settled", ... })` 직후. `firstView = !hasCelebrated(memberId, submissionId)`(이 시점엔 아직 기록 전), `userJudgment = attempted.current?.userJudgment ?? null`. 대안: `AnalysisSubmission.tsx` 101–107행의 `celebrate` 판정.

새 분석은 같은 hook(`useAnalysisData`, `useCurveStep`, `AnalysisSession`, `useFoldSession`, `useSubmission`, `loadPeriodogram`, `period-selection`, `phase-selection`, `submission-input`)을 import해 자기 화면에서 같은 이벤트를 보낸다.

## 전환 스위치 (`analysis/AnalysisSwitch.tsx`)

`/analysis/:ticId` 라우트 요소. 회원에게는 빌드가 정한 변형 하나만 보이고 토글이 없다. 팀은 새 디자인으로 정했다(2026-09-27). 빌드 정의 `VITE_CINEMA_ANALYSIS`가 없으면(운영 빌드) 새 디자인이고, `classic`일 때만 예전 기존형이다(되돌릴 때를 위한 길, `analysis/variant.ts`, `tests/unit/cinema-analysis-variant.test.ts`). `npm run dev:cinema`는 환경 변수 `CINEMA_ANALYSIS`(`new` 기본 | `classic`)로 이 값을 정의하므로 기존형 비교용 두 번째 서버는 `CINEMA_PORT=58391 CINEMA_ANALYSIS=classic npm run dev:cinema`다([`DEMO.md`](DEMO.md) "띄우기"). `import.meta.env.DEV && VITE_CINEMA_DEV_TOOLS === "true"`(`analysis/dev-tools.ts`)일 때만 "기존형 / 새 디자인" 토글과 `localStorage['planetory:analysis-variant']`(`classic` | `cinematic`, 없으면 빌드 변형, 저장소 실패 시 빌드 변형)를 쓰고, 기존형의 `개발용 렌더러` 펼침도 그때만 보인다. `npm run dev:cinema`(시연 서버)와 모든 빌드는 이 값을 두지 않는다. 켜려면 `VITE_CINEMA_DEV_TOOLS=true npm run dev:cinema`. 전환하면 분석을 다시 마운트한다. 초안은 세션 저장소에서, 결과 불명 제출은 요청 ID로 복구된다.

## 분석·결과 표현 (`analysis/copy.tsx`, `analysis/format.ts`)

시네마 앱은 `CinemaCopy` 문맥(`features/analysis/cinema-copy.ts`, `main-cinema.tsx`가 준다)으로 공유 분석 화면에 자기 표현을 넘긴다. 제공자가 없는 기존 화면(운영 기본)은 `null`을 읽어 문구·숫자·동작이 그대로다(`StrictCelebration`과 같은 방식). 규칙은 `analysis/format.ts` 한 곳에 있고 `tests/unit/cinema-analysis-format.test.ts`가 본다.

- 숫자: 주기 2–3자리 + 일, 가려진 시간 1자리 + 시간, 위상 3자리, 깊이는 % 2자리(ppm 숨김), 주기도는 가장 센 봉우리 = 1인 「세기」(0..1, 음수는 0). 봉우리 순위 글자(`placeRankLabels`)는 늘 그래프 안에 둔다: 점 위에 자리가 있으면 위, 위쪽 끝에 닿는 봉우리(예: 세기 1)는 점 옆(오른쪽, 안 되면 왼쪽), 그다음 한 줄 위, 자리가 없으면 뺀다(1위는 빼지 않는다). 다른 글자와 겹치지 않고, 되도록 다른 봉우리 점과 고른 주기의 세로선을 피한다. BTJD는 주 화면에서 빼고 「기준 시각」 2자리로 「기술 정보」 안에만 둔다. 시간 곡선 가로축은 관측 시작부터 지난 날, `Sector`는 「섹터」.
- 이름: 별의 신호는 별 패널 순서(candidateId 오름차순)로 「행성 N」(회원의 행성일 때, 확정 행성은 NASA 이름을 붙여 「행성 1 · WASP-62 b」), 아니면 「신호 N」. 분류 코드는 확정 행성 / 행성 후보 / 행성 아님(오탐) / 식쌍성.
- 결과 대화상자(기존형, `results/AcceptedResult.tsx`): 무슨 일이 있었는지 제목 한 줄, 할 일 한 줄, 주요 행동 둘(가장 알맞은 다음 행동 + 「나의 은하로」), 나머지는 작은 줄. 접수·기록 번호, 곡선 단계, 기준 시각, SDE·SNR, 모델 버전, 외부 자료 원문은 접힌 「기술 정보」 안에. AI 판정은 실제로 돌았을 때만 보인다. 구간이 빗나간 결과(`not_matched`)는 「이번 구간에서는 신호를 찾지 못했습니다」와 「구간 다시 잡기」(제출 상태를 풀고 주기를 둔 채 구간 단계로), 작은 줄의 「주기 다시 고르기」(같이 풀고 주기 선택 단계로, 단계 줄의 '주기 선택'과 같다)이고, 탐사 완료 결과에는 「다음 곡선 단계로」를 내지 않는다.
- 주기 다시 고르기(기존형, `features/analysis/PeriodogramChart.tsx`, 시네마만): 구간 선택·판단·제출값 확인 단계에서 주기도(봉우리 버튼, 그래프 빈 곳, 그래프에서 Enter)를 누르면 '주기 선택' 단계로 돌아가 그 주기를 고른다. 단계 줄의 '주기 선택'을 누르고 고른 것과 같은 `go(1)`과 같은 선택이라, 새 주기의 접기가 끝나면 구간·판단 초안이 늘 그렇듯 비워지고 초안 저장도 같다. 그 단계들에서는 커서가 손 모양이고 그래프 아래에 「그래프를 눌러 주기를 다시 고를 수 있습니다」가 보인다(`data-reselect`, `analysis/periodogram.css`). develop 화면은 1단계에서만 고른다(「조회 전용」).
- 별 결과(`/results/:ticId`, `results/StarResult.tsx`), 기록 상세(`/history/:id`, `results/HistoryDetail.tsx`), 데이터 상세(`results/DataDetails.tsx`, 새 분석의 `자료`도 같다)는 같은 응답을 이 규칙으로 다시 그린다. 공개 검토는 제자리에서 신호 이름·숫자만 바꾸고 버전·번호를 「기술 정보」로 옮긴다.
- 발견 카드(`shell/sequences.ts`): 확정 행성(튜토리얼 정답 포함)은 새 발견이 아니다. 「알려진 행성 WASP-62 b를 직접 찾아냈습니다」(이름이 없으면 「확정된 행성을 직접 찾아냈습니다」), 「발견」은 미확정 후보에만 쓴다. 인정됐지만 새 별이 없으면 칩 대신 메모 「이번에는 새로 열린 별이 없습니다.」. 이름은 브리지 `OutcomePlanet.knownName`(선택 필드, 외부 기록의 CP/KP 이름).

## 셸 참고

- 지도 store는 앱에 하나. `useSkyData()`는 마운트마다 새 store를 만들고 언마운트에 폐기하므로 라우트 위(보호된 레이아웃)에서 한 번만 부른다. 전체 은하를 올리려면 `store.setView({ level: meta.zoomLevels[0].level, box: {x: minX, y: minY, w: max(tileSize, maxX-minX), h: max(tileSize, maxY-minY)} })`.
- 선택은 지금처럼 URL `?star=`(→ `store.select`)을 기준으로 둔다. 별 상세는 `GET /v1/me/stars/:tic` + `readStarDetail`.
- `QuestProvider`는 `{store, data}`가 필요하다. 표시는 `markerLabel(star, quests.markers, challengeTicId)`.
- 글꼴은 자체 호스팅(`styles/fonts.ts`, unicode-range 분할). 토큰은 `styles/tokens.css`의 `--pc-*`(기존 화면 변수와 겹치지 않게 접두사). 숫자는 `--pc-font-mono` + tabular-nums.

## 은하 위 화면 (`pages/`)

`/sky`·`/analysis`·`/members/:id/sky`를 뺀 보호된 라우트는 흐린 은하(`backdrop`) 위의 페이지다. `pages/index.ts`의 `cinemaPages`가 기존 기능 컴포넌트를 `PageFrame`(`pages/PageFrame.tsx`)으로 감싼다. 데이터 호출·검증·접근성 속성은 기능 컴포넌트 그대로이고 바뀌는 것은 표현뿐이다.

- 틀: 폭 세 가지(`wide` 1200 · `standard` 1040 · `reading` 860px), 제목·패널·목록·양식·빈 상태·불러오는 중·오류를 `pages/pages.css`가 `.cinema-shell .cp-page` 아래에서 토큰으로 입힌다. 자기 제목이 없는 화면(기록 상세, 공개 분석, `/history`)은 틀이 `h1`을 준다.
- 기능 컴포넌트의 분석 그래프 변수(`--fg-*`, `--accent`, `--panel-line` 등)를 틀이 토큰으로 다시 정의한다. 이전에는 이 변수가 없어 기록 상세 그래프가 보이지 않았다.
- "나의 밤하늘" 2D 미리보기(`MySkyPreview`) 자리에는 셸이 이미 읽은 지도로 만든 카드(`SkyCard`)가 들어간다(`MySkyPreviewSlot`). 페이지마다 전체 은하를 다시 읽지 않는다.
- `/history`는 마이페이지의 분석 기록 목록(`MyHistorySection`). 만들지 않은 화면(첨부 기록·제출 결과), P1이 꺼졌을 때의 P1 경로(통계·알림·팔로우·공개 은하·탈퇴)와 없는 주소는 모두 틀 안의 같은 "없는 화면입니다" 안내(`pages/routes.tsx` `MissingScreen`, `나의 은하로` + 주소에 `returnTo`가 있으면 `이전 화면으로`)를 보인다. 「이 화면은 연결 준비 중입니다」는 시네마에 없다.
- 마이페이지는 탭(탐사 요약·내 별·내 분석 기록)이 먼저이고 `탐사 요약` 탭의 내용이 그 아래에 온다(기존 화면은 요약이 탭 위에 있어 탭 본문이 비어 보였다).
- 탭 제목은 화면마다 "나의 은하 · Planetory", "TIC … 분석 · Planetory", "커뮤니티 · Planetory" 등(`shell/stage.ts` `cinemaTitle`), 파비콘은 `CinemaRoot`가 붙인다(기존 화면의 `index.html`은 그대로).

## 개발 서버 (`npm run dev:cinema`)

`CINEMA_PORT`(기본 58390)에서 Vite 하나로 로그인부터 제출·새 별까지 합성 HTTP를 준다. 운영 API 인수가 아니다. 사용법·TIC·결과표는 `scripts/cinema-server.mjs` 머리말, 시나리오는 `dev/cinema-scenarios.ts`가 정본이다.

- 기본은 로그인 회원 `u-209`(member 시나리오). 비로그인 화면: `/api/dev-cinema/session?as=anonymous` → `/login`. 로그인 버튼 → 회원으로 복귀. 로그아웃 → 비로그인. `?as=member`·`newcomer`·`veteran`은 새 세계를 만든다.
- 이 플러그인이 더 답하는 경로: `PATCH /v1/me/onboarding`, 다른 탐사자의 `GET /v1/members/:id`·`/sky`·`/sky/tiles`·`/stars`·`/stars/:tic`·`/follow-summary`, 팔로우(`/v1/me/following/**`, `/v1/me/followers`, `/v1/community/following-feed`; 따로 있던 follow fixture 대신).
- 지금 세계에서 세는 화면: 마이페이지 `내 별`(`GET /v1/me/stars`, 탐사한 별), `내 분석 기록`(`GET /v1/me/histories`)과 기록 상세·그래프(`GET /v1/histories/:id`, 실제 별은 실제 곡선을 접는다), 별 결과(`GET /v1/stars/:tic/result`, 신호마다 자기 제출), 통계(`GET /v1/me/statistics`는 이 세계, `GET /v1/statistics`는 화면의 탐사자보다 큰 서비스 규모), 알림의 성과 소식(이 세계에서 인정된 별), 챌린지 회차 날짜(이번 주). 세계를 만들 때 이미 탐사한 실제 별(member·veteran의 튜토리얼, veteran의 탐사 별)은 신호마다 같은 제출 fixture로 한 번씩 제출해 두므로 기록·결과가 실제 접수와 같은 모양이다.
- 합성 별의 행성은 별마다 id·주기·깊이를 정하고 NASA 설명은 "연결된 행성을 찾지 못했습니다"(`source_unavailable`/`not_found`)로 답한다. 새 제출의 접수 시각은 지금이고, 다른 회원 판단 통계는 싣지 않는다. 커뮤니티 fixture의 검색 시험용 글(p-201)은 제목·본문을 바꿔 보낸다.
- `POST /api/dev-cinema/reset` 지금 시나리오 새로 만들기, `GET /api/dev-cinema/state` 시나리오·판·실제 별 자리·새 별·오버레이, `GET /api/dev-cinema/scenarios` DEMO 탭 목록, `POST /api/dev-cinema/unlock?on=0|1` 인정된 성과가 새 별을 열지 않게/열게(시작값 `CINEMA_UNLOCK`, 기본 연다).
- 실제 표본에 없는 은하 별은 TIC 259377024의 합성 곡선으로 분석된다(1위 봉우리 약 11.73일, 위상 0/1에 0.8% 감광). 실제 별은 위 "실제 TESS 표본" 규칙을 따른다.
- 인정(`matched`): 1위 봉우리 + 위상 0 또는 1을 덮는 구간 + 행성 같음 → 새 별 1개(다음 TIC, 예 900001001)와 그 별의 확정 행성 `9007199254741101`.
- 수치 불일치: 1위 봉우리 + 감광을 벗어난 구간(기본 화면에서 키보드 "구간 선택 시작"은 0.5에 놓인다) 또는 주기도 빈 곳 직접 선택.
- 판단 불일치: 1위 봉우리 + 감광 구간 + 아닌 것 같음/모르겠음.
- 발표 전 확인: `CINEMA_PORT=… CINEMA_SHOTS=<폴더> node scripts/cinema-smoke.mjs`(시연 순서는 [`DEMO.md`](DEMO.md)). 세 시나리오(newcomer 로그인·첫 방문·발견·새 별, veteran 5,000/10,000 집계·프레임, 다른 탐사자 은하 50/1,000/10,000·비공개·복귀)와 DEMO 탭을 셸 선택자로 돌리고 1440×900 스크린샷과 `report.json`을 남긴다. 서버의 지금 세계를 바꾼다. `CINEMA_ONLY=newcomer,veteran,public,switch`로 일부만, `CINEMA_GPU=0`이면 GPU 플래그 없이.

## 검증

`npm run typecheck`, `npm test`, `npm run build`(프런트 폴더). 브라우저 확인은 Node Playwright 스크립트 + `npm run dev:cinema`, 스크린샷은 `test-results/cinema-shots/<영역>/`(Git 제외). 띄운 서버는 PID로 끈다.

## 통합 메모

- 셸은 `CinemaRoot`(장면 하나, 로그인 포함)와 `CinemaLayout`(보호된 라우트)로 붙는다. 분석 패널은 각 변형이 직접 그리고 `setViewInset`으로 알린다. 셸은 발견 연출(트랜싯, 카드) 동안만 패널을 비켜 두고, 끝나면 변형이 잰 inset을 돌려준다.
- 발견 카드는 모달 `<dialog>`다. "결과 자세히 보기"는 카드를 닫고 장면을 다시 `analysis` 모드로 둔다(트랜싯이 `system`으로 돌려놓기 때문). 실제 행성이 드러나면 유령 궤도 힌트는 지운다. 새 주기를 고르면 다시 나온다.
- 새 별 점화는 은하로 돌아온 뒤, 별이 store에 들어온 다음에 한다. 새로 열린 별은 결과가 온 순간(지도 새로 읽기 전) `holdStars`로 숨겨 두고, `ignite`가 드러낸다(움직임 줄이기에서도 점화 뒤에는 보인다). 점화하지 못한 채 셸이 내려가면(로그아웃) 풀어 준다. 분석을 공개해서(공개 검토, `features/publication/use-publication.ts`) 성과가 새로 인정되고 별이 열려도 같다. 공개 응답의 `unlockedStars`를 셸이 준 `PublicationUnlockSink`(`features/publication/unlock-sink.ts`, 기존 화면은 값 없음)로 받아 `SequenceDirector.unlockElsewhere`가 지도 새로 읽기 전에 숨기고 새 별로 표시하며, 은하로 돌아오면 점화한다. 다시 공개해 이미 연결된 별로 온 응답(`newlyGranted: false`)은 점화하지 않는다. 시연 서버는 `/publication/h-1951`의 게시가 새 별 하나를 연다.
- 새로 열린 별(`shell/new-stars.ts`, 표시는 `ScreenLabels` `NewStarMarks`): 처음 보는 결과가 연 별(`unlockedTicIds`, 판단 불일치 제외)은 회원이 그 별의 패널이나 분석을 열 때까지 `localStorage["planetory:new-stars"]`(`{ [memberId]: TIC[] }`, 최근 것이 끝, 200개까지)에 남는다. 은하에서는 가장 최근 10개에 보라색 고리(움직임 줄이기에서는 파동 없이)를 두고 카메라가 움직이거나 별을 연 동안 숨기며, 도구 줄의 `새 별 N개`가 가장 최근 별부터 하나씩 연다. 다 불러온 지도에서 탐사를 시작했거나 없는 별은 빠진다(방금 열린 별은 그 별을 실은 지도가 올 때까지 둔다). 여러 별은 차례로 점화한 뒤 토스트 하나(「새 별 N개가 열렸습니다」)를 보이고, 마지막 별의 고리에 「새로 열린 별 · TIC …」를 다음 조작까지 둔다. 시나리오 전환 페이지가 이 기록도 지운다.
- 「축하합니다!」는 처음 보는 결과이고 성과가 실제로 인정(`recognized`)됐을 때만 보인다(`features/analysis/celebration.ts`의 `celebrationText`). 판단 불일치·공개 대기·이미 인정됨·미매칭에는 붙지 않는다. 두 분석 화면이 같은 `ResultExplanationView`를 쓴다. 이 규칙은 시네마 앱이 `StrictCelebration`을 줄 때만 쓰고, 기존 화면(운영 기본)은 develop 규칙(`developCelebrationText`, 처음 보는 결과면 모두 축하) 그대로다.
- 인정됐지만 새로 열린 별이 없는 결과(`achievement.unlockedStars: []`, 운영의 튜토리얼 성과에서 흔하다)는 발견 카드에 `새로 열린 별 없음` 칩을 달고, `은하로 돌아가기`에서 점화하지 않는다. 다른 결과(판단 불일치·공개 대기·이미 인정됨)에는 별 이야기를 하지 않는다. 개발 서버에서 재현: `CINEMA_UNLOCK=0` 또는 `POST /api/dev-cinema/unlock?on=0`.
- 튜토리얼 안내(`shell/TutorialGuide.tsx`, 문구·저장은 `shell/tutorial-guide.ts`): 튜토리얼 별 1–5에 풀이를 별 패널(짧은 줄)과 분석 화면 위(두 변형 공통, 상단 띠, 무엇을 보고 무엇을 고를지)에 보인다. 천문 용어 없이 화면 이름(추천 봉우리 1위, 접힌 곡선, 구간, '행성 같음'/'아닌 것 같음', '다음 곡선 단계로', 행성 1/2/3, 신호 1/2)으로 쓰고, 연결 준비 중인 판별 도구(홀짝·2차 식·V/U)는 가리키지 않는다. 1024px에서 두 줄을 넘지 않는다. 백엔드가 주는 튜토리얼 순번(`Star.marker.seq`, 없으면 퀘스트의 튜토리얼 표시)으로 고르고 TIC로 고르지 않는다. 탐사 완료한 별에는 보이지 않는다. 자리(별 패널/분석)·순번마다 `풀이 닫기`로 닫고 `localStorage["planetory:tutorial-guide-closed"]`에 남긴다. 문구 규칙은 `tests/unit/cinema-tutorial-guide.test.ts`가 본다.
- 안내는 한 번에 하나: 튜토리얼 풀이가 보이면 첫 방문 문구(은하·별 패널 아래)와 분석 안내 줄은 비킨다. 분석 안내(`features/onboarding` `OnboardingTip`, 시네마만 `OnboardingLookContext`)는 분석 단계 이름(주기 선택·구간 선택·판단·제출값 확인)의 한 줄이고 "2/5" 번호가 없다. `안내 숨기기`는 그 줄만 이번 방문 동안 숨기고 안내 완료(`PATCH /v1/me/onboarding`)를 보내지 않는다(완료는 튜토리얼 1의 첫 제출로 서버가 정한다). 기존 화면은 상자·번호·완료 저장 그대로다.
- 첫 로그인 이야기(`shell/FirstStory.tsx`, 문구·시간·기록은 `shell/first-story.ts`): 처음 온 탐사자(`onboardingDone=false`, 이 브라우저에서 이 회원이 아직 보지 않았고 튜토리얼 1로 날아간 적도 없음)가 은하에 오면, 은하를 멀리(`intro`) 둔 채 네 줄을 하나씩(줄마다 약 2.5초, 페이드) 보이고 마지막 줄 아래에 `시작하기`를 둔다. 오른쪽 아래 `건너뛰기`(또는 Escape)는 처음부터 있다. 둘 중 하나를 누르면 회원마다 한 번(`localStorage["planetory:first-visit-story"]`) 기록하고 날아들기와 아래 첫 방문 비행이 이어진다(감독 `holdIntro`). 이야기 동안 HUD와 은하 표시는 숨고 튜토리얼 1 비행도 기다린다. 움직임 줄이기에서는 네 줄과 버튼을 한 번에 보인다. 튜토리얼 1을 마친 회원(`onboardingDone=true`)에게는 보이지 않는다. 문구·기록 규칙은 `tests/unit/cinema-first-story.test.ts`.
- 튜토리얼 표시 구도: 셸이 탐사 완료가 아닌 튜토리얼 별(`marker.type === "tutorial"`)을 `setHomeFrame`으로 넘기면, 장면의 홈 구도(날아들기 끝, 튜토리얼 비행 전 자리)와 `전체 보기`는 그 별들이 상단 막대·표시 높이·하단 HUD와 첫 방문 문구를 뺀 영역(`MARKER_FRAME_MARGIN`) 안에 들도록 시점 평면에서 먼저 옮기고, 그래도 모자랄 때만 뒤로 물러난다(`math.ts` `fitPointsInView`, 정확한 최소 거리). 이미 다 보이면 그대로라 1,000개 은하 회원의 구도는 바뀌지 않는다. 처음 온 탐사자(별 5개)는 1440×900·1024×768 모두 1–5가 화면 안에 들고(전체 보기보다는 가깝다), 날아드는 동안 별이 도착했으면 착지 뒤 1.1초 동안 새 구도로 옮긴다. `tests/unit/cinema-scene-framing.test.ts`가 three.js 카메라로 확인한다.
- 첫 방문(`onboardingDone=false`): 로그인 뒤 은하로 날아드는 장면이 끝나고(장면이 은하에서 멈춘 뒤 0.9초) 튜토리얼 1로 날아간다. 회원마다 한 번(`localStorage["planetory:first-visit-flown"]`, `tutorial-guide.ts` `takeFirstVisitFlight`)이라 `← 나의 은하`와 새로 고침이 별로 되돌아가지 않는다. 그 뒤 은하의 문구는 "파란 1번 별을 눌러 시작하세요."다. 개발 서버의 시나리오 전환 페이지(`/api/dev-cinema/session`)는 새 세계마다 이 기록, 첫 로그인 이야기 기록과 닫은 풀이를 지운다(`POST /reset`만 부르면 지우지 않는다).
- 분석 화면(기존형) 배치는 `shell/analysis-stage.css`가 덮는다: 패널을 `max(60vh, 100vh − 264px)`로 키워 별은 위 약 200px 띠에 두고, 주기도를 왼쪽 첫 칸에 두며, 단계의 주 버튼(이 주기로 구간 선택·구간 확정하고 판단하기·제출값 확인·제출하기)은 패널 아래에 붙어 늘 보인다. 1440×900과 1024×768에서 스크롤 없이 보이는 것을 확인했다(2026-09-27).
- 통과 장면: 문구는 처음부터 보이고, 1초 뒤 오른쪽 아래 `건너뛰기`(또는 Escape)가 통과를 끝내고 바로 발견 카드로 간다(`SequenceDirector.skip`, 행성은 카드 뒤에서 자리 잡는다).
- 운영 API를 조회로 확인한 P1(2026-09-27: 공개 은하, 팔로우 요약·목록·팔로잉 피드, 내 통계)은 시네마 앱에서 늘 켠다(`features/p1.ts` `useLiveP1`, 공유 화면은 `CinemaWording`으로만 켜지므로 기존 화면은 `p1Enabled` 그대로). 알림(목록이 503 `DEPENDENCY_UNAVAILABLE`)·전체 통계(`AGGREGATE_NOT_READY`)·탈퇴는 `p1Enabled`일 때만이다. P1이 꺼지면(`p1Enabled` false, 운영) 상단 메뉴는 나의 은하·커뮤니티·마이페이지·설정만 두고, 알림·통계·탈퇴로 가는 링크를 두지 않는다. `CINEMA_P1=0` 개발 서버에서 주요 화면(은하·별 패널·마이페이지·설정·커뮤니티·핫 토픽·분석 기록·별 결과·글·프로필)의 내부 링크 79개를 모두 열어 금지 경로 링크와 「이 화면은 연결 준비 중입니다」가 없음을 확인했다(2026-09-27).
- `VITE_SKY_RENDERER_ENABLED`는 더 이상 `/sky`를 바꾸지 않는다. 개발용 inspector 슬롯만 `/sky`를 덮는다.
- 엔진은 소프트웨어 WebGL(SwiftShader, llvmpipe 등)을 알아보면 싼 경로(`low`)로 그린다: 픽셀 비율 0.5, 후처리·성운·먼지 없음, `canvas[data-power="low"]`. 회원이 빛 효과를 켜면 이 경로에서도 켜진다. 헤드리스 Chromium 기준 2–3fps → 60fps.
- 로그인 직후 새로 고침된 페이지에서 엔진 청크가 늦게 오면, 프록시가 날아들기 요청을 기억했다가 엔진이 붙을 때 재생한다.
- 기존 브라우저 테스트 중 제출 직후 결과를 바로 찾는 것들은 발견 연출(트랜싯 → 카드)이 결과를 먼저 덮으므로 실패한다. 의도된 화면 변경이다.
- `scripts/cinema-smoke.mjs`는 셸 기준 선택자(`.scene-canvas[data-scene-mode|data-scene-busy]`, 마커 `data-visible`, `dialog.cinema-discovery`, `new-star-reticle`)와 분석 화면의 접근 이름(기본 새 디자인, `CINEMA_ANALYSIS=classic` 서버면 기존형)으로 세 데모 시나리오를 돈다(위 "개발 서버").

## 최종 수정 메모 (리뷰 반영)

리뷰(체험·정확성)에서 나온 항목을 반영한 결과다. 최종 흐름 검증 스크립트는 작업자 로컬 검토 폴더에 있으며 저장소에는 포함하지 않았다. 저장소 안의 흐름 확인은 `scripts/cinema-smoke.mjs`를 쓴다.

장면(`scene/`)

- 셰이더 예열: 첫 프레임 뒤 `renderer.compileAsync`(확장이 없으면 `compile`)로 숨은 항성계·통과 행성·섬광까지 모든 프로그램을 미리 만든다. 통과 시작 순간의 약 0.5초 멈춤과 별로 가는 비행 중 0.1초 끊김이 사라졌다(GPU 기준 최대 프레임 16.8ms). 소프트웨어 WebGL은 예열하지 않는다.
- 모드별 성운·먼지(`HAZE`): 은하 1, 항성계 0.3, 분석 0.25, 통과 0. 옆에서 보는 통과 장면에서 은하 원반이 흰 띠로 번지지 않는다. 통과 시 별 밝기(`LOOK.transit`) 0.4.
- 통과는 궤도가 도는 방향으로 지나가고(`transitTheta`), 드러난 행성은 통과가 끝난 자리에서 그대로 궤도를 이어 간다(`Body.phase`). 탄생 섬광은 그 행성 위에 붙는다.
- 분석 모드: 항성은 0.72배로 작게, 유령 궤도 반지름은 코로나 밖 하한을 둔 케플러 반지름(`ghostDisplayRadius`, `GHOST_FLOOR`). 카메라 거리는 유령 궤도까지 담도록 다시 맞추고(`frameRadius`), 패널 크기가 바뀌는 동안 들어온 inset은 진행 중인 재구도를 대체한다.
- 홈 구도(`homePose`)는 전체 보기보다 0.74배 가깝다. 로그인 뒤 날아들기는 옆으로 돌아 들어오며, 그동안 HUD와 표시는 숨었다가 착지 뒤 나타난다.
- 새 별 점화: 은하 중심부에서도 번지지 않는 거리에서 섬광을 보여 주고, 끝나면 원래 은하 구도로 물러난다. 셸은 점화 뒤 그 별에 "새로 열린 별" 표시를 다음 조작까지 둔다.
- 광택 줄무늬 방지: 코로나·섬광 셰이더와 마지막 패스에 디더링. 헤일로를 줄여 바닥이 갈색으로 뜨지 않는다.
- 캔버스 크기가 0(데스크톱 관문)이거나 탭이 숨으면 그리지 않는다. 다른 페이지 뒤(`backdrop`)에서는 30fps(저사양 20fps)로 흐려진 뒤 멈춘 마지막 프레임을 둔다.

셸(`shell/`)

- 상단 집계는 발견 연출 동안 제자리에 둔다: 행성 수는 행성이 나타날 때, 별 수는 새 별이 점화될 때 올라간다(`SequenceDirector` `TallyHold`, `TopBar` `useTallyCount`).
- 통과 문구와 실시간 광도 곡선은 옆모습 비행이 끝나고 첫 밝기 표본이 올 때 나타난다.
- 발견 연출 동안 분석 패널의 모달 대화상자(기존형 결과)는 닫아 둔다(`ModalHoldContext`, `features/analysis/use-modal-dialog.ts`). 최상위 레이어의 모달은 `inert`를 벗어나 키보드 포커스와 버튼이 남기 때문이다. "결과 자세히 보기"를 누르면 상태 그대로 다시 열린다. 이 때문에 제출 직후 결과 대화상자를 바로 찾는 기존 브라우저 테스트는 카드가 닫힐 때까지 실패한다(의도된 화면 변경).
- 분석 브리지의 따라잡기는 현재 세션에서 온 값만 쓴다(`lastAnalysisOrder`, bridge에 추가한 선택적 export). 같은 별을 다시 열 때 지난 세션의 유령 궤도가 돌아오지 않는다.
- 별로 비행하는 동안 별 패널은 기다렸다가 도착 무렵 나타난다. 은하로 돌아갈 때 튜토리얼·챌린지 표시는 카메라가 멈춘 뒤 나타난다. 표시 위에 포인터나 키보드 초점을 두면 그 별의 TIC와 상태를 보여 준다.
- 지도는 은하로 돌아올 때, 창 포커스(30초 간격)와 1분마다 다시 읽는다. 방금 바뀐 지도가 이전 판을 돌려주면(읽기 지연) 0.7·1.5·3초 간격으로 다시 묻고, 그래도 안 되면 알림을 보인다.
- 지도에 없는 TIC(잠긴 별)는 비행하지 않는다.
- 별 패널의 `returnTo`는 검색 조건을 유지한다(`starSearch`).
- 셸 문구는 '~습니다'로 통일했다("YOUR STAR" → "내 별").

시네마 문구(`src/shared/cinema-wording.ts`)

- 공유 기능 화면(커뮤니티·핫 토픽·글·마이페이지·탐사자 프로필·설정·사용법·퀘스트·내 별 찾기·별 목록·NASA 설명)의 시네마 문구는 `CinemaWording` 제공자가 있을 때만 쓴다(`CinemaRoot`가 준다). 기존 화면(운영 기본)은 제공자가 없어 develop 문구 그대로다.
- 용어: 나의 은하(별지도 아님), 미탐사/탐사 중/탐사 완료, 공식 스레드 글쓴이 "Planetory 공식"(SYSTEM 아님), 커뮤니티 제목 "커뮤니티"(메뉴와 같게), '~습니다', 섹터·밝기 등급(Sector·Tmag 아님), 초 없는 날짜("2026년 9월 18일 오전 10:00"). 개발자 문구("%, _도 입력한 문자 그대로 검색", "스레드 ID가 최신인 순", 평소의 "설정 다시 확인" 버튼, 첨부 링크의 내부 번호)는 시네마에서 뺐다. 분석·결과 화면 문구는 분석 쪽 `CinemaCopy`가 맡는다.

새 분석(`analysis-new/`)

- EXP-12 제출값 확인 단계: "제출값 확인" → 주기·위상·가려진 시간·판단·근거·메모와 접힌 "아직 제출되지 않았습니다 · 계산 안내"(기준 시각은 그 안에) → "판단·메모 수정" 또는 "제출하기". 구간·판단·근거·메모를 바꾸면 확인이 풀린다. 구간이 바뀌면 판단도 고르지 않은 것으로 보이고, 다시 고르면 새 구간으로 확정한다.
- 숫자·이름은 기존형과 같은 `analysis/format.ts` 규칙이다(주기 3자리 + 일, 가려진 시간 1자리, 위상 3자리, 깊이 %, 주기도는 「세기」 0..1, 가로축 「일」, 시간 띠는 관측 일수, BTJD·내부 번호 없음). 주기도의 봉우리 순위 글자는 그래프 안에서 서로 겹치지 않게 놓는다(`model.placeRankTags`, 가장 높은 봉우리 위에 글자 자리를 남긴다).
- 결과: 판단 칸에 제목(`format.resultTitle`, 확정 행성은 「알려진 행성 … 을 직접 찾아냈습니다」)·신호 이름과 숫자 한 줄·요약 칩, 행동은 둘까지(빗나간 구간은 「구간 다시 잡기」·「주기 다시 고르기」, 그 밖은 「결과 자세히 보기」와 남은 신호가 있으면 「다음 곡선 단계로」). 영역에 `data-analysis-result`: 카드의 "결과 자세히 보기"가 새 분석의 상세 대화상자를 연다. 상세는 기존형과 같은 `results/AcceptedResult`다.
- 접은 곡선의 깊이 추정은 "평균 감소 (추정)". 눈썹 문구와 같은 칩은 한 번만 보인다. 단어는 Plex Sans KR, 값(`<b>`)만 Plex Mono.
- 언마운트할 때 `selectionChanged(null)`을 보낸다.

기존형 분석(`analysis-classic/`)

- 1024–1279px에서도 세 칸(주기도·시간 곡선 | 접힌 곡선 | 판단)으로 두어 패널 안에 작업 영역이 보인다. 패널 머리의 두 번째 워드마크는 숨겼다. 패널은 카메라가 움직이기 시작한 뒤(180ms) 올라온다. 장면 inset에 상단 막대(56px)를 넣었다.
- `use-submission.ts`: 결과를 모르는 두 경로(차단된 예약, 마운트 시 복구)도 `submitFailed(unresolved)`를 보낸다.

알려진 차이

- 전체 은하를 한 번에 올린다(가장 거친 배율, 저장 경계 전체). `docs/development/sky-presentation-contract.md`의 "뷰포트 + 20%" 요청과 다르다. 판이 바뀌면 전 페이지를 다시 읽는다. 20,000개에서 요청 22개·1.6–2.6초(리뷰 측정). 10만 개 규모에서는 보이는 영역 먼저 읽기가 필요하다.
- 2026-09-27 기준(develop 병합 뒤): 기본 모드(기존 화면) `npm run test:browser` chromium 250 통과, 0 실패, 3 건너뜀. `npm run test:e2e:smoke`는 CI 스모크 job과 같은 빌드(렌더러 인자 없음)에서 11·11·14 통과. 렌더러 인자(`VITE_SKY_RENDERER_ENABLED=true`) 빌드에서는 `production.spec.ts`의 `/sky` 문구 확인 1건이 develop 빌드와 똑같이 실패한다(그 확인은 렌더러 없는 빌드를 가정한다). `tests/auth/auth.spec.ts`·`tests/browser/foundation.spec.ts`·`tests/production/production.spec.ts`·`tools/firefox-functional/verify.mjs`는 기본 화면에 맞게 develop 기대값으로 되돌렸다. 시네마를 강제한 실행(`VITE_CINEMA=true npm run test:browser`)은 213 통과, 37 실패, 3 건너뜀이다(아래 36개 + 되돌린 `foundation.spec.ts`의 401 복귀 확인 1개).
- 이전 기록(시네마가 기본이던 때) chromium 브라우저 테스트(`npm run test:browser`): 214 통과, 36 실패, 3 건너뜀. 실패 중 27개는 발견 연출이 결과 대화상자를 잡아 두는 탓이다(카드를 닫아야 결과가 열린다). 발견 연출을 잠시 끈 확인 실행에서 해당 스펙(analysis-retry·analysis-submit·curve-step·onboarding) 70개 중 69개가 통과했다(남은 1개는 글자색 토큰). 나머지 9개는 이전 분류 그대로다(머리글 로그아웃 제거, 패널 스크롤 기준 좌표, 장면의 WebGL 버퍼, 주기도 드래그 시작점, 글자색 토큰). 테스트 코드는 새 화면에 맞게 고쳐야 한다.
- 스모크(`npm run test:e2e:smoke`)는 위 첫 항목을 본다. 스모크의 `/sky` 확인은 다시 develop과 같이 기존 화면의 지도 메타 문구만 본다. 스모크는 Dockerfile 기본값처럼 `VITE_CINEMA` 없이 빌드하므로 운영 번들(시네마 전용)은 보지 않는다.
- 같은 분석 스펙을 새 분석(`cinematic`)으로 돌리면 198개 중 36개만 통과한다(HTTP·계약·복구). 화면 스펙은 기존형의 접근 이름·testid를 쓰기 때문이다.

## 색상 검토안

금색 메인·하늘색 서브 G1 조합의 색상표와 변경 요청 방법은 [색상 가이드](styles/README.md)를 따른다. 로컬 검토안이며 운영 채택은 미확정이다.

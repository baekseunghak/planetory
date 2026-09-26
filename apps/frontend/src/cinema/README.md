# 시네마틱 전환 (`src/cinema`)

상태: `experiment/S15P21C206-274-web-cinematic-core` 실험 브랜치([S15P21C206-274]). 병합 여부와 분석 화면 A/B 선택은 팀 결정 전이다. 셸이 `App.tsx`·`main.tsx`에 연결되어 앱 전체가 이 은하 위에서 돈다. 운영 계약·API는 바꾸지 않는다.

목표: 은하 하나가 앱 전체다. 화면 전환은 그 위의 카메라 이동과 패널이다.
로그인 → 내 은하로 진입 → 별로 비행 → 항성계 → 분석 패널 → 발견 시 통과 장면 → 행성 등장 → 은하로 복귀 → 새 별 점화.

## 직접 실행해 보기

필요한 환경: Node 22.12 이상, 그래픽 가속이 켜진 Chrome, 폭 1024px 이상 화면. 데이터는 모두 합성이며 각자 컴퓨터의 메모리에서만 돈다. 실제 서버와 운영 DB는 사용하지 않는다.

```bash
cd apps/frontend
npm ci
npm run dev:cinema
```

1. 브라우저에서 `http://127.0.0.1:58390/api/dev-cinema/session?as=anonymous`를 연다. 로그인 화면에서 `SSAFY 계정으로 로그인`을 누르면 은하로 들어간다(합성 로그인).
2. 파란 3번 마커(TIC 900000003)를 누르고 `분석 시작`을 누른다. 왼쪽 위 `기존형 / 새 디자인`으로 분석 화면을 바꾼다.
3. `1위 봉우리`(약 11.73일)를 고르고 위상 0 또는 1의 밝기 감소를 구간으로 잡은 뒤 `행성 같음 → 제출값 확인 → 제출하기`. 통과 장면, 발견 카드, 은하 복귀 후 새 별 점화가 이어진다.
4. 다른 경우: `/sky?star=900000011`(구간이 빗나가면 수치 불일치), `/sky?star=900000012`(판단 불일치), `/sky?star=900000001`(행성 5개, 후보는 점선 궤도).
5. 처음 상태로: `curl -X POST http://127.0.0.1:58390/api/dev-cinema/reset`. 포트를 바꾸려면 `CINEMA_PORT=<포트> npm run dev:cinema`.

알려진 한계: Chromium 계열에서만 확인했다. 그래픽 가속이 없는 환경(원격 데스크톱, 일부 CI)에서는 초당 몇 프레임으로 매우 느리다. 기존 브라우저 테스트 일부는 화면 변경으로 실패한다(아래 최종 수정 메모 참고).

## 소유 범위

병렬 작업자는 자기 파일만 고친다. 다른 사람 파일의 타입 오류는 고치지 말고 보고한다.

| 영역            | 파일                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 장면 엔진       | `src/cinema/scene/**` (단, `contract.ts`는 동결)                                                                                                                                                                                                                                                                                |
| 셸              | `src/cinema/shell/**`, `src/cinema/ui/**`, `src/cinema/styles/**`, `src/app/App.tsx`, `src/main.tsx`, `src/components/ServiceLayout.tsx`, `src/auth/LoginPage.tsx`, `src/auth/auth.css`, `src/auth/auth-presentation.css`, `tests/auth/auth.spec.ts`, `tests/browser/foundation.spec.ts`, `tools/firefox-functional/verify.mjs` |
| 기존형 분석     | `src/cinema/analysis-classic/**` + `src/features/analysis/**` 안의 최소 emit 줄                                                                                                                                                                                                                                                 |
| 새 분석         | `src/cinema/analysis-new/**` (`src/features/analysis`는 import만, 수정 금지)                                                                                                                                                                                                                                                    |
| 공유·동결       | `src/cinema/scene/contract.ts`, `src/cinema/analysis/bridge.ts` — optional 필드·멤버 추가만 허용하고 보고에 적는다                                                                                                                                                                                                              |
| 설계(architect) | `src/cinema/analysis/AnalysisSwitch.tsx`·`analysis-switch.css`, `src/cinema/README.md`, `dev/cinema-fixture-plugin.ts`, `scripts/cinema-server.mjs`, `scripts/cinema-smoke.mjs`, `tests/unit/cinema-contract.test.ts`                                                                                                           |

- `package.json`·`package-lock.json`은 아무도 고치지 않는다. 필요한 의존성은 설치돼 있다: `three@0.186.1`, `@types/three@0.186.0`, `@fontsource/ibm-plex-sans-kr@5.3.0`, `@fontsource/ibm-plex-mono@5.3.0`.
- 셸은 토글 위치를 `AnalysisSwitch`의 `toggleClassName`으로 바꾼다. 파일 수정이 필요하면 먼저 보고한다.

## 재사용하는 것과 바꾸는 것

그대로 쓴다: `auth/SessionProvider`, `api/client`·`api/index`, `features/sky-data`(store·contracts·events), 분석 데이터·접기 Worker·제출·초안 저장·복구(`features/analysis`의 `*.ts`와 hook), 퀘스트(`QuestProvider`·`contracts`), 별 상세 읽기(`sky-renderer/detail.ts`의 `readStarDetail`·`readPlanetExplanations`), `starStyle()`·`markerLabel()`·`signalSeed()`.

바꾸는 것은 표현뿐이다. 업무 규칙을 다시 쓰지 않는다.

서비스 규칙(개발 코드가 정본):

- 별 위치는 저장된 `x`·`y`·`depthZ`. 렌더 z = `depthZ * DEPTH_SCALE`(256). 색·크기는 `starStyle()`(금빛 중심, 푸른·보라 외곽).
- 표시: 튜토리얼 = 파란 원 + 순번, 챌린지 = 빨간 `!` (`markerLabel()`, `.galaxy-marker`). DOM 표시는 `projectStar()`로 위치를 받는다.
- 항성계는 내 `planets.items`만. 미확정 후보 궤도는 점선. 행성 색은 seed(기본 바다/얼음, >.68 갈색, <.17 청록). 항성 표면은 짙은 빨강 → 금빛.
- 행성을 누르면 그 행성으로 초점, `PlanetExplanation.tsx`(NASA 자료). 별 정보·행동은 `StarDetail.tsx`의 어휘(미탐사/탐색 중/탐색 완료, 분석 시작/이어서 분석/분석 다시 보기, 별 게시판).
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
| `setEffects(bool)`                                                    | bloom·성운·먼지                                                       |
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

`/analysis/:ticId` 라우트 요소. "기존형 / 새 디자인" 토글, `localStorage['planetory:analysis-variant']`(`classic` | `cinematic`, 기본 `classic`, 저장소 실패 시 기본값). 전환하면 분석을 다시 마운트한다. 초안은 세션 저장소에서, 결과 불명 제출은 요청 ID로 복구된다.

## 셸 참고

- 지도 store는 앱에 하나. `useSkyData()`는 마운트마다 새 store를 만들고 언마운트에 폐기하므로 라우트 위(보호된 레이아웃)에서 한 번만 부른다. 전체 은하를 올리려면 `store.setView({ level: meta.zoomLevels[0].level, box: {x: minX, y: minY, w: max(tileSize, maxX-minX), h: max(tileSize, maxY-minY)} })`.
- 선택은 지금처럼 URL `?star=`(→ `store.select`)을 기준으로 둔다. 별 상세는 `GET /v1/me/stars/:tic` + `readStarDetail`.
- `QuestProvider`는 `{store, data}`가 필요하다. 표시는 `markerLabel(star, quests.markers, challengeTicId)`.
- 글꼴은 자체 호스팅(`styles/fonts.ts`, unicode-range 분할). 토큰은 `styles/tokens.css`의 `--pc-*`(기존 화면 변수와 겹치지 않게 접두사). 숫자는 `--pc-font-mono` + tabular-nums.

## 개발 서버 (`npm run dev:cinema`)

`CINEMA_PORT`(기본 58390)에서 Vite 하나로 로그인부터 제출·새 별까지 합성 HTTP를 준다. 운영 API 인수가 아니다. 사용법·TIC·결과표는 `scripts/cinema-server.mjs` 머리말이 정본이다.

- 기본은 로그인 회원 `u-209`. 비로그인 화면: `/api/dev-cinema/session?as=anonymous` → `/login`. 로그인 버튼 → 회원으로 복귀. 로그아웃 → 비로그인.
- `POST /api/dev-cinema/reset` 초기화, `GET /api/dev-cinema/state` 현재 판·새 별·오버레이.
- 모든 은하 별이 TIC 259377024의 합성 곡선으로 분석된다(1위 봉우리 약 11.73일, 위상 0/1에 0.8% 감광).
- 인정(`matched`): 1위 봉우리 + 위상 0 또는 1을 덮는 구간 + 행성 같음 → 새 별 1개(다음 TIC, 예 900001001)와 그 별의 확정 행성 `9007199254741101`.
- 수치 불일치: 1위 봉우리 + 감광을 벗어난 구간(기본 화면에서 키보드 "구간 선택 시작"은 0.5에 놓인다) 또는 주기도 빈 곳 직접 선택.
- 판단 불일치: 1위 봉우리 + 감광 구간 + 아닌 것 같음/모르겠음.
- 확인 스크립트: `CINEMA_PORT=… CINEMA_SHOTS=… node scripts/cinema-smoke.mjs`(기존 UI 기준 선택자, 복사해서 쓴다).

## 검증

`npm run typecheck`, `npm test`, `npm run build`(프런트 폴더). 브라우저 확인은 Node Playwright 스크립트 + `npm run dev:cinema`, 스크린샷은 `test-results/cinema-shots/<영역>/`(Git 제외). 띄운 서버는 PID로 끈다.

## 통합 메모

- 셸은 `CinemaRoot`(장면 하나, 로그인 포함)와 `CinemaLayout`(보호된 라우트)로 붙는다. 분석 패널은 각 변형이 직접 그리고 `setViewInset`으로 알린다. 셸은 발견 연출(트랜싯, 카드) 동안만 패널을 비켜 두고, 끝나면 변형이 잰 inset을 돌려준다.
- 발견 카드는 모달 `<dialog>`다. "결과 자세히 보기"는 카드를 닫고 장면을 다시 `analysis` 모드로 둔다(트랜싯이 `system`으로 돌려놓기 때문). 실제 행성이 드러나면 유령 궤도 힌트는 지운다. 새 주기를 고르면 다시 나온다.
- 새 별 점화는 은하로 돌아온 뒤, 별이 store에 들어온 다음에 한다.
- `VITE_SKY_RENDERER_ENABLED`는 더 이상 `/sky`를 바꾸지 않는다. 개발용 inspector 슬롯만 `/sky`를 덮는다.
- 엔진은 소프트웨어 WebGL(SwiftShader, llvmpipe 등)을 알아보면 싼 경로로 그린다: 픽셀 비율 0.5, 후처리·성운·먼지 없음, `canvas[data-power="low"]`. 이 경로에서는 빛 효과를 켤 수 없다. 헤드리스 Chromium 기준 2–3fps → 60fps.
- 로그인 직후 새로 고침된 페이지에서 엔진 청크가 늦게 오면, 프록시가 날아들기 요청을 기억했다가 엔진이 붙을 때 재생한다.
- 기존 브라우저 테스트 중 제출 직후 결과를 바로 찾는 것들은 발견 연출(트랜싯 → 카드)이 결과를 먼저 덮으므로 실패한다. 의도된 화면 변경이다.
- `scripts/cinema-smoke.mjs`는 셸 이전 화면의 선택자(`.galaxy-scene canvas`, 머리글 로그아웃, 제출 직후 결과)를 쓴다. 통합된 셸에서는 10단계 중 4단계(로그인 후 지도, 인정 제출, 판단 불일치 제출, 로그아웃)가 선택자 때문에 실패한다. 셸 기준 흐름은 `.scene-canvas[data-scene-mode]`, 마커 `data-visible`, `.cinema-discovery` 카드, 메뉴 대화상자 안 로그아웃을 쓴다.

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
- 캔버스 크기가 0(데스크톱 관문)이거나 탭이 숨으면 그리지 않는다. 다른 페이지 뒤(`backdrop`)에서는 30fps.

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

새 분석(`analysis-new/`)

- EXP-12 제출값 확인 단계: "제출값 확인" → 주기(6자리)·위상·기준 시각·가려진 시간·판단·근거·메모와 "아직 제출되지 않았습니다…" 안내 → "판단·메모 수정" 또는 "제출하기". 구간·판단·근거·메모를 바꾸면 확인이 풀린다.
- 결과 영역에 `data-analysis-result`: 카드의 "결과 자세히 보기"가 새 분석의 상세 대화상자를 연다. 다음 행동 이름은 셸 어휘("나의 은하로", "분석 결과 보기", `NextActions`의 선택적 `labels`).
- 접은 곡선의 깊이 추정은 "평균 감소 (추정)". 눈썹 문구와 같은 칩은 한 번만 보인다. 단어는 Plex Sans KR, 값(`<b>`)만 Plex Mono.
- 언마운트할 때 `selectionChanged(null)`을 보낸다.

기존형 분석(`analysis-classic/`)

- 1024–1279px에서도 세 칸(주기도·시간 곡선 | 접힌 곡선 | 판단)으로 두어 패널 안에 작업 영역이 보인다. 패널 머리의 두 번째 워드마크는 숨겼다. 패널은 카메라가 움직이기 시작한 뒤(180ms) 올라온다. 장면 inset에 상단 막대(56px)를 넣었다.
- `use-submission.ts`: 결과를 모르는 두 경로(차단된 예약, 마운트 시 복구)도 `submitFailed(unresolved)`를 보낸다.

알려진 차이

- 전체 은하를 한 번에 올린다(가장 거친 배율, 저장 경계 전체). `docs/development/sky-presentation-contract.md`의 "뷰포트 + 20%" 요청과 다르다. 판이 바뀌면 전 페이지를 다시 읽는다. 20,000개에서 요청 22개·1.6–2.6초(리뷰 측정). 10만 개 규모에서는 보이는 영역 먼저 읽기가 필요하다.
- 기존 chromium 브라우저 테스트(`npm run test:browser`): 214 통과, 36 실패, 3 건너뜀. 실패 중 27개는 발견 연출이 결과 대화상자를 잡아 두는 탓이다(카드를 닫아야 결과가 열린다). 발견 연출을 잠시 끈 확인 실행에서 해당 스펙(analysis-retry·analysis-submit·curve-step·onboarding) 70개 중 69개가 통과했다(남은 1개는 글자색 토큰). 나머지 9개는 이전 분류 그대로다(머리글 로그아웃 제거, 패널 스크롤 기준 좌표, 장면의 WebGL 버퍼, 주기도 드래그 시작점, 글자색 토큰). 테스트 코드는 새 화면에 맞게 고쳐야 한다.
- 같은 분석 스펙을 새 분석(`cinematic`)으로 돌리면 198개 중 36개만 통과한다(HTTP·계약·복구). 화면 스펙은 기존형의 접근 이름·testid를 쓰기 때문이다.

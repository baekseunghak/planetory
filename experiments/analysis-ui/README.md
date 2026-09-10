# 분석 프론트 React 미리보기

백지웅 담당 분석 화면의 로컬 실험이다. 기본 화면은 **실제 TESS 관측 → BLS 봉우리 선택 → 주기 미세 조정 → 전 점 위상 접기 → 구간 선택 → 판단 → 임시 저장**을 제공한다. 별도 화면에서 합성 API 예시의 **결과 → 재판단 → 개인 기록 → 선택 공개** 14개 시나리오를 확인한다.

실제 관측 화면의 선택값은 이 탭의 `sessionStorage`에 임시 저장한다. 서버 제출·신호 매칭·잔차 계산·성과·공개는 실행하지 않는다. 합성 결과 시나리오는 메모리에서 동작하며 새로고침하면 최초 상태로 돌아간다.

## 작업 위치와 기준

- 로컬 브랜치: `experiment/analysis-ui-prototype`
- 분기 기준: `docs/analysis-api-draft`의 `fc68ebd`. 문서 초안 2개 커밋을 공통 기반으로 사용하며 기존 문서 브랜치를 이동시키지 않는다.
- Jira 미연결 임시 작업이다. 팀 티켓 정리 후 실제 작업 키에 맞춰 브랜치·미푸시 커밋을 정리하고 리뷰한다. 푸시·MR·배포는 수행하지 않는다.
- 정본: [요구사항 v0.12](../../docs/requirements/planetory-requirements-spec.md), [와이어프레임 v0.6](../../docs/requirements/planetory-wireframe.html)
- 제안 계약: [분석 API·Mock](../../docs/api/analysis/README.md), [상태 모델](../../docs/api/analysis/state-model.md)

최종 서비스의 프론트 디렉터리·공통 디자인·인증 구성을 결정한 것은 아니다. 기존 별 지도 실험과 실행 환경을 공유하지 않는다.

## 선택한 구성

| 구성                       | 용도                                           |
| -------------------------- | ---------------------------------------------- |
| React 19 + TypeScript      | 화면 컴포넌트와 요청·응답 타입                 |
| Vite 8                     | 로컬 개발 서버, Fast Refresh, 정적 빌드        |
| pnpm 11.19.0               | 의존성 관리. 직접 의존성 버전과 잠금 파일 고정 |
| 일반 CSS                   | 수정 가능한 화면 스타일·데스크톱 레이아웃      |
| Canvas + Web Worker        | 전체 관측점 그리기와 float64 위상 접기         |
| Vitest                     | 위상 수학·데이터 검증·Mock 상태 검증           |
| Playwright + 설치된 Chrome | 실제 버튼·복원·부분 실패·기기 범위 검증        |
| Prettier                   | TypeScript·JSX·CSS·설정 파일 형식 통일         |

현재는 React 상태로 분석 단계를 관리한다. 전체 점은 Canvas에 그리고, 접기 연산은 Web Worker에서 실행한다. 합성 결과 화면만 메모리 Mock 어댑터를 사용한다. 새 라이브러리를 추가하지 않았으며 서버 API 연결은 이후 작업이다.

공식 구성 참고: [React의 Vite·TypeScript 시작 안내](https://react.dev/learn/build-a-react-app-from-scratch), [Vite 시작 안내](https://vite.dev/guide/).

## 실행

Node 22.12 이상과 pnpm 11.19.0이 필요하다. 검증한 런타임은 Node 24.19.0이다. 별도의 환경변수·API 키·로그인이 필요하지 않다.

저장소 루트 `Planetory`에서:

```powershell
cd experiments/analysis-ui
pnpm install --frozen-lockfile
pnpm dev
```

실제 관측 JSON을 먼저 생성해야 한다. `Planetory` 디렉터리에서:

```powershell
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/export_observations.py
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/verify_observations.py
```

입력은 이미 저장된 `archive/TESS_BLS_semi_auto/sample_raw/tess/`의 FITS 7개다. 다른 경로는 `--source-root`로 지정한다. 해당 가상환경이 없으면 [기존 tess-bls 환경](../tess-bls/README.md)을 준비한다. [출처·처리 규칙](scripts/README-observations.md)에 자세한 내용이 있다. 원본 FITS와 생성 JSON은 Git에 포함하지 않는다. 데이터 파일이 없으면 화면에서 생성 안내와 재시도 버튼을 제공한다.

- [실제 관측 분석](http://127.0.0.1:5174/?mode=observations&target=toi270)
- [합성 결과 시나리오](http://127.0.0.1:5174/?scenario=last-fp-wrong)

개발 주소: [http://127.0.0.1:5174](http://127.0.0.1:5174). 포트가 사용 중이면 임의의 다음 포트로 바꾸지 않고 오류를 표시한다. 터미널에서 `Ctrl+C`로 종료한다.

```powershell
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm format:check
pnpm validate:fixtures
```

`test:e2e`는 설치된 Google Chrome을 사용한다. Chrome이 없으면 Playwright 브라우저 설치와 실행 채널을 팀 환경에 맞게 바꿔야 한다. 이미 같은 개발 서버가 실행 중이면 재사용하고, 없으면 테스트 설정이 서버를 시작한다. 빌드 결과 미리보기는 `pnpm preview`로 [127.0.0.1:4174](http://127.0.0.1:4174)에서 실행한다.

## 디렉터리

```text
analysis-ui/
├─ src/
│  ├─ App.tsx                       # 화면 전환·요청 상태·결과/복원/공개 검토
│  ├─ ObservationApp.tsx            # 실제 관측의 선택·판단·임시 저장·복원
│  ├─ observation-math.ts           # 기준 시각·위상·예상 transit 구간 계산
│  ├─ fold.worker.ts               # 전체 관측점 접기 및 요청 revision 반환
│  ├─ components/                   # Canvas 그래프·합성 곡선·아이콘
│  ├─ mock/analysis-service.ts       # 실제 서버와 교체할 메모리 어댑터
│  ├─ mock/analysis-service.test.ts  # 중요한 상태 계약 검증
│  └─ styles.css
├─ tests/analysis-flow.spec.ts       # 브라우저 흐름 검증
├─ tests/observation-flow.spec.ts     # 실제 관측의 선택·접기·복원 검증
├─ scripts/                         # FITS 내보내기·출처/전체 행 검증
├─ public/observations/              # 생성 JSON, Git 제외
├─ playwright.config.ts
├─ vite.config.ts
└─ pnpm-lock.yaml
```

기존 `docs/api/analysis/examples` JSON을 직접 가져온다. Mock의 성과·매칭·공개 처리는 합성 화면 시연용이다. 실제 API로 전환할 때 이 로직을 브라우저의 권위 있는 판정으로 사용하지 않는다. 개발 서버의 파일 접근 허용 범위도 앱과 합성 예시 디렉터리로 한정한다.

## 확인할 흐름

### 실제 관측

1. TOI-270, L 98-59, CM Draconis 중 항성을 선택한다. 각각 44,551 / 47,579 / 11,558개 정제 관측점을 모두 사용한다. BLS 주기도도 전체 점에서 미리 계산한 0.5~40일, 8,000개 격자다.
2. 주기도를 클릭하거나 봉우리 버튼을 선택한다. 두 주기의 접힌 곡선을 표시하고, 슬라이더 또는 숫자 입력 후 Enter로 주기를 맞춘다. 숫자 입력은 현재 봉우리의 설정 범위 안에서 허용한다.
3. `[이 주기로 구간 고르기]` 후 그래프를 드래그하거나 `[중앙 구간에서 시작]`과 두 핸들을 사용한다. 위상 0을 가로지르는 구간도 저장한다. 핸들은 좌우 방향키로도 움직인다. 기준 시각·가려진 시간·시간 영역 예상 띠는 구간에서 계산하는 읽기 전용 미리보기다.
4. 휠은 포인터 중심으로 가로 ×1~8 확대한다. Shift+드래그는 이동, +/-는 중앙 확대, 0·더블클릭은 초기화다. y축은 가로 확대 중 바뀌지 않는다. 같은 봉우리의 미세 조정은 가로 배율만 유지하고 구간·판단·메모를 초기화한다. 봉우리 재선택은 배율도 ×1로 초기화한다.
5. 접기 중에는 구간·판단 입력이 잠긴다. 마지막 요청의 결과만 적용한다. Worker 오류 또는 15초 시간 초과는 마지막 성공 주기·입력으로 복구한다. 주기 조정은 BLS·잔차 API를 호출하지 않는다.
6. 구간을 정한 뒤 세 가지 판단과 메모를 입력하고 저장 내용을 검토한다. 임시 기록은 현재 탭 새로고침 후 복원 가능하며, 복원 후 다시 저장해도 이전 기록은 바뀌지 않는다. Bundle과 선택 설정이 다른 기록은 복원하지 않는다. 탭을 닫으면 임시 기록이 사라질 수 있다.

### 합성 결과

1. 기본 `마지막 FP · 판단 불일치`: 완료·불일치·미인정이 함께 표시된다. 다시 풀어 `아닌 것 같음`으로 제출하면 새 기록과 최초 FP 성과를 얻는다. 이후 재제출은 기존 성과를 유지한다.
2. `마지막 확정 · 판단 불일치`와 `마지막 확정 · 모르겠음`: 불일치와 판단 보류를 구분한다.
3. `미확정 · 미게시 완료`: 공개하지 않고 결과에 머물 수 있다. 공개 분석 0명은 비율 없이 빈 상태를 표시한다.
4. `두 신호 공개 · 일부 실패`: 모두 게시하면 첫 신호 성공·둘째 신호 실패. 실패분 재시도 후 인정 2건·미확정 S로 갱신한다. 성공한 기록은 다시 등록하지 않는다.
5. 미확정 재판단 후 공개 검토: 신호당 최신 미공개 기록 한 건을 기본 선택하고 과거 기록도 고를 수 있다. 공개 전까지 판단 통계는 유지된다.
6. `일치 없음`·`해설 없음`·`고조파`: 상세 대상과 비활성 상태를 구분하고, 재도전에는 정정 주기가 아닌 원본 주기를 복원한다. 해설 열람은 제출별 부가 상태로 남긴다.
7. 복원 자료 만료·스레드 숨김: 개인 기록·성과·완료를 유지하며 불가 사유를 표시한다.
8. 폭 1024px 이상에서 사용하고 미만에서는 데스크톱 이용 안내를 제공한다(NFR-17).

## 검증 범위와 다음 작업

2026-09-09 검증 결과: TypeScript·프로덕션 빌드·Prettier 통과, 단위 테스트 22개와 Chrome E2E 19개 통과, Python exporter 계약 테스트 5개 통과. 실제 FITS 7개 전체와 생성 JSON 대조도 통과했다. 빌드된 Worker 파일에서 세 항성의 전 점 접기와 HTTP 200 응답을 확인했다. 화면은 1440px·1024px와 390px 안내 화면을 직접 확인했다. 원본 대조의 상세 증거는 [관측 검증 기록](scripts/verification-observations.md)에 남겼다.

단위 검증은 수학·데이터 경계·Mock 상태를, Chrome 검증은 실제 관측 선택·복원과 기존 합성 결과 흐름을 확인한다. TypeScript, 프로덕션 빌드, 1440px·1024px 화면과 390px 안내 화면도 확인한다. 실제 관측 E2E를 실행하려면 위의 데이터 export가 필요하다. 문서의 합성 시나리오 10개·요청/응답 54개 정합성 검증은 별도 명령으로 유지한다.

현재 자료의 정제는 기존 PoC 파이프라인을 사용한다. CM Draconis에서는 품질 필터 후 14,900점 중 상단 이상치 3,342점이 추가 제외되었다. 출처와 제외 행을 보존했으며 과학적 전처리 적합성을 새로 검증한 것은 아니다. 현재 주기도의 대표 봉우리는 실제 행성 정답이나 서비스의 discoverable 후보 목록이 아니다. 선택 폭 0.001~0.25도 명시적으로 버전을 둔 실험 설정이며 DEC-19의 확정 정책을 대체하지 않는다.

다음 단계는 홀짝 비교·2차 식·형태·품질 확인 도구, 실제 제출·매칭 API와 다음 곡선 잔차 처리다. 시간축 공백은 현재 실제 시간 간격을 유지하며, 장기 공백을 접어 보여주는 기능은 아직 없다. 별 지도/게시판 이동, 인증, 서버 동시성·재전송, 공개 취소·운영 API, 다른 브라우저와 대규모 성능은 아직 검증하지 않았다. 합성 결과 화면의 읽기 전용 9점 그래프는 그대로 유지한다.

팀과 먼저 맞출 연결 항목은 실제 곡선 샘플·단위·선택 제한, API 경로·에러·요청 ID 표준, 잔차 작업 응답, 공개 검토 담당이다. 전체 목록은 API 초안의 Q1~Q6을 따른다.

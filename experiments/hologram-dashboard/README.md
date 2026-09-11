# Hologram observation dashboard

Planetory의 홀로그램 패널 배치와 실제 분석 조작을 확인하는 독립 비교 시안이다. `tmp/hologram-dashboard`의 원본 커밋 `91270e9`에서 가져와 [S15P21C206-50](https://ssafy.atlassian.net/browse/S15P21C206-50)의 `experiment/S15P21C206-50-web-analysis-prototype` 브랜치에 추가했다. 기존 `apps/frontend`, [analysis-ui](../analysis-ui/README.md), [analysis-lab](../analysis-lab/README.md)의 화면을 대체하지 않는다.

현재 기준은 [요구사항 v1.0](../../docs/requirements/planetory-requirements-spec.md)과 [분석 프론트 상세 명세](../../docs/development/analysis-frontend-spec.md)이며, 관련 문서 Task는 `S15P21C206-49`다. 원본 시안의 화면과 조작을 비교하기 위한 실험이고 현재 계약을 모두 구현한 운영 프론트가 아니다.

단위 테스트와 브라우저 흐름 확인 결과는 [검증 기록](VALIDATION.md)에 정리했다.

## 실행

Node.js 22.12 이상과 pnpm 11.19.0을 사용한다. 이 디렉터리에서:

```powershell
pnpm install --frozen-lockfile
pnpm data:prepare
pnpm data:check
pnpm dev
```

새 checkout에는 관측 JSON이 없다. 먼저 기존 `analysis-ui/public/observations/`에 원본 export의 `manifest.json`, `toi270.json`, `l98-59.json`, `cm-dra.json` 네 파일을 준비한다. 데이터가 없으면 화면의 로딩 실패·재시도 상태가 표시되며, `pnpm test`도 실제 자료를 읽기 때문에 준비 후 실행해야 한다. 입력 준비와 다른 저장 경로 지정은 아래 데이터 절차를 따른다.

미리보기: <http://127.0.0.1:5177>. 개발·미리보기 서버는 `0.0.0.0:5177`에 바인딩하므로 같은 네트워크에서는 `http://<이 PC의 IPv4 주소>:5177`로 접속한다. `pnpm build`로 TypeScript 검사 및 프로덕션 번들 생성, `pnpm test`로 위상 수학과 저장 기록 검증을 실행한다. 설치 스크립트는 `pnpm-workspace.yaml`에서 esbuild만 허용한다.

## 체험 흐름

1. 별 지도 또는 하단 카드에서 TOI-270, L 98-59, CM Draconis를 선택한다. 지도는 드래그, 휠 및 좌측 버튼으로 이동·확대한다.
2. 우측 패널에서 **이 별 분석하기**를 누른다. 주기도의 봉우리를 선택하고 주기를 조절한다.
3. **주기 확정** 후 위상 그래프를 드래그해 구간을 지정한다. 경계 핸들, 키보드 Enter/방향키/Shift+방향키도 지원한다.
4. 판단과 선택 근거·메모를 남기고 기록을 확인한다. **관측 기록 저장**은 이 브라우저의 localStorage에만 저장한다. 관측 기록 화면에서 다시 열 수 있다.

검색 단축키 `/`, 분석에서 지도 복귀 `Esc`, 차트 배율 초기화 `0`. 표시 설정에서 좌표 가이드·공간 모션·패널 투명도를 변경한다. OS의 모션 감소 설정을 기본값으로 존중한다. 1024px 이상 데스크톱에 맞춘 구성으로, 좁은 내장 미리보기를 위해 900px까지 축소 배치를 제공한다.

## 구현 범위

- React + TypeScript + Vite. 패널은 HTML/CSS, 별 배경과 차트는 Canvas, 위상 계산은 Worker로 구현했다.
- 반투명 패널, 모서리 프레임, 겹친 외곽선, 제한적인 포인터 기울기와 분석 진입 전환. 분석 중 차트와 조작 도구는 정면에 고정한다.
- 전체 유효 관측점, 광도곡선·BLS 주기도·두 주기의 위상곡선, 평균선, 관측 구간 미리보기. 관측 공백은 표시 폭을 압축하고 회차 경계와 실제 BTJD 축을 표시한다.
- 슬라이더는 저장된 피크의 허용 범위·step을 사용한다. 변경 중 마지막 성공 그래프를 유지하며 늦게 도착한 계산은 무시한다. 주기 변경은 구간·판단·근거·메모를 초기화한다.
- 로딩·오류·재시도, 선택 없음, 검색 결과 없음, 기록 없음, 저장 실패 안내. 기록 복원 시 관측 대상·bundle·고정 기준 시각·주기 범위·선택 폭을 검증한다.

이는 시각·조작 프로토타입이다. 지도상의 항성 위치와 성운은 시안용 배치이며 천구 투영이 아니다. 항성 정보의 RA/DEC는 실제 메타데이터를 보여준다. 로그인, API, 서버 제출, 실시간 BLS 재계산, 잔차 분석, AI 판정 및 정답 공개는 구현 범위에 포함하지 않는다. 실제 서비스의 전체 요구사항을 구현했다는 의미가 아니다.

## 현재 명세 및 다른 시안과의 차이

| 항목 | 이 시안의 동작과 범위 |
|---|---|
| 기록 다시 열기 | 같은 로컬 Bundle·기준 시각에서 주기·구간·판단·근거·메모를 복원한다. 현재 데이터로 재환산하고 판단 입력을 비우는 `SUB-10`의 새 제출용 재도전은 구현하지 않았다. |
| 저장 위치 | 이 시안은 `localStorage`라 브라우저를 닫았다 열어도 기록이 남을 수 있다. 기존 `analysis-ui` 관측 화면은 탭의 `sessionStorage`, `analysis-lab`은 새로고침하면 초기화되는 화면 상태를 사용한다. 셋 모두 서버 히스토리 저장이 아니다. |
| 그래프 조작 | 위상 그래프에서 휠·키보드 ×1~8 확대와 기본 드래그 구간 선택을 지원한다. 광도·주기도의 팬/확대 및 `analysis-lab`의 Shift+드래그 이동·20배 확대는 이 시안에 포함하지 않는다. |
| 관측 데이터 | 기존 PoC의 정제 관측점 전체 export다. 현재 계약의 10분 비닝·세그먼트 revision·현재 Bundle 전환을 구현하거나 검증한 자료가 아니다. |
| 판단 근거 | 홀짝·2차 식·V/U형의 세 가지 선택 입력이다. 해당 진단 도구의 과학적 계산과 검증은 구현하지 않았다. |

## 데이터와 출처

`public/observations/*.json`은 기존 로컬 `experiments/analysis-ui/public/observations`의 `analysis-observations-v1` export를 바이트 그대로 복사한 생성물이며 Git에서 제외한다. 원본 시안 커밋에는 이 JSON도 포함됐으나 Jira 작업 브랜치에서는 코드·메타데이터·재생성 명령만 추가한다. 각 파일 안에 TESS SPOC/PDCSAP 자료와 정제 출처가 기록되어 있다. FITS 재조회·재정제·BLS 재계산은 하지 않았다.

| 대상 | 유효 관측점 | 파일 |
|---|---:|---|
| TOI-270 | 44,551 | `toi270.json` |
| L 98-59 | 47,579 | `l98-59.json` |
| CM Draconis | 11,558 | `cm-dra.json` |

팀에서 기존 export 네 파일을 제공받거나, [analysis-ui 관측 준비 절차](../analysis-ui/scripts/README-observations.md)에 따라 저장된 FITS에서 export한다. 원본 FITS도 Git에 포함하지 않으며 이 importer는 자료를 자동 탐색·다운로드하지 않는다.

기본 입력 폴더에 자료가 있으면 위의 `pnpm data:prepare`·`pnpm data:check`를 실행한다. 다른 위치에 있는 원본 export를 가져오려면:

```powershell
pnpm data:prepare --source-dir "<관측 JSON과 원본 manifest가 있는 폴더>"
pnpm data:check --source-dir "<같은 폴더>"
```

상대 경로는 명령을 실행한 폴더 기준이며 이전의 위치 인자 하나를 전달하는 명령도 지원한다. importer는 원본 manifest의 해시·크기·Bundle·TIC·Sector, 관측점 수·유한값·시간 순서를 검사하고 **세 입력을 모두 검증한 후** 파일을 쓴다. 출력 해시와 Bundle ID는 생성된 `public/observations/manifest.json`에 기록한다. `--check`는 생성된 네 파일을 예상 바이트와 대조하며 파일을 쓰지 않는다.

항성 메타데이터 `src/catalog.json`은 원본 시안에서 `experiments/star-map-prototype/shared/data.js`를 이용해 만든 작은 스냅샷이다. importer는 대상 식별자·관측점 수·Sector가 이 스냅샷과 맞는지도 확인하며, 카탈로그와 원본 자료는 변경하지 않는다. 새로운 대상이나 다른 정제 결과를 검토할 때는 별도 변경으로 카탈로그와 검증 기준을 함께 갱신해야 한다.

Pretendard 폰트 및 라이선스는 기존 별 지도 실험에서 함께 복사했다.

시각적 참고: [HUD_T_S](https://codepen.io/INM0RTAl/full/NPGvjzd), [layered glass panel](https://codepen.io/xistence-imaginations/full/abyPqqM), [augmented-ui](https://augmented-ui.com/mixinmixer/). 프레임·깊이·전환의 표현을 참고했고 코드는 직접 작성했다. 외부 CDN이나 참조 사이트에 런타임 의존하지 않는다.

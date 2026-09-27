# 실제 TESS 표본 만들기 (`tools/real-sample`)

`npm run dev:cinema`가 읽는 실제 TESS 표본을 만든다. 결과는 `apps/frontend/.real-sample/`(Git 제외)에 쓴다. 모양은 `apps/frontend/dev/real-sample/types.ts`를 따른다. 시연 전용이며 운영 Gold나 DB와 관계없다.

## 다시 만들기

저장소 최상위에서 Git Bash로 실행한다. PowerShell이면 `$env:UV_PROJECT_ENVIRONMENT = ...` 형식으로 바꾼다.

```bash
export UV_PROJECT_ENVIRONMENT="$PWD/tools/real-sample/.venv"
uv sync --project libs/astro-kernel --locked --extra bls --python 3.12   # libs/astro-kernel의 uv.lock 그대로
tools/real-sample/.venv/Scripts/python.exe tools/real-sample/fetch.py      # MAST에서 FITS 24개(약 48 MB)를 .cache/에 받는다
tools/real-sample/.venv/Scripts/python.exe tools/real-sample/run.py       # 커널 처리 → apps/frontend/.real-sample/ (약 45초)
```

- `fetch.py`는 `mast.stsci.edu`에만 접속한다. 이미 받은 파일은 다시 받지 않고 헤더의 TIC·Sector를 확인한다. 저장소에 SHA-256이 고정된 파일(`experiments/tess-fixture/*checksums.json`)은 해시도 대조한다.
- `run.py --only <TIC...>`는 일부 별만 처리한다. `--out <폴더>`를 주면 다른 폴더에 쓴다. 별마다 결과는 `.cache/report.json`에 남는다(보류 사유, 커널 단계별 결과, 라벨 근거, Gold 검사 결과).
- 표본을 바꾼 뒤에는 `dev:cinema`를 다시 시작한다. 서버는 시작할 때 표본을 한 번만 읽는다.
- 브라우저 확인: 서버를 띄운 뒤 `CINEMA_PORT=<포트> REAL_TIC=150428135 node tools/real-sample/browser-check.mjs`를 실행한다. 별 패널 → 분석 → 1위 봉우리 → 추천 위상 구간 → 제출 → 통과 장면 → 발견 카드 순서로 진행하고, 스크린샷을 `.cache/shots/`(`SHOTS=<폴더>`로 변경)에 남긴다.

## 처리 순서 (커널 함수 그대로)

`fits_adapter.parse_spoc_hdul` → `preprocessing.preprocess_silver` → `iteration.iterate_bls`(기본 품질 버전 `gate_v1/snr7_sde6`. Spark 127 호출과 같다) → `candidate_catalog.build_candidate_catalog` → `segmentation.segment_silver` → `discoverability.prepare_discoverability` → `discoverability.evaluate`(제거 조합별 주기도) → `gold_serialization.assemble`(Gold 모양 검사).

- 커널이 보류한 별은 내보내지 않는다. 반복 탐색 QA 실패, 후보 0개(무신호 별 공개 제외), discoverable 후보 0개가 이에 해당한다. 사유는 `report.json`에 있다.
- 후보 ID(`90071992547600xx`)와 승인 문자열(`planetory-cinema-demo-only`)은 시연용이다. 실제 ID 할당이나 리뷰 승인이 아니다.
- 봉우리 목록은 백엔드 `CandidatePeaks` 규칙을 옮겼다(상위 10개, 간격 2h+1칸, 배율 2·½). 추천 duration과 위상은 같은 BLS 계산의 값이다.
- 외부 라벨은 `stars.py`의 `REFS`, 즉 저장소에 이미 있는 값만 쓴다. epoch가 있으면 124 규칙(identity distance ≤ 0.5, duration 비 ≤ 2)으로, 주기만 있으면 상대 오차 0.5% 이내로 붙인다. 맞는 행이 없으면 미확정 후보(`candidate`)다.

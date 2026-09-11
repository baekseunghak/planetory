# 저장된 TESS 관측 데이터 내보내기

`export_observations.py`는 현재 작업 공간에 이미 저장된 SPOC 2분 cadence Light Curve FITS를 읽어 분석 UI에 필요한 JSON을 만듭니다. 네트워크 요청이나 원본 수정은 하지 않습니다. 앱 서버에서도 원본 FITS를 제공하지 않습니다.

| ID       | 화면 이름   | TIC       | Sector  | 기본 입력 폴더                                      |
| -------- | ----------- | --------- | ------- | --------------------------------------------------- |
| `toi270` | TOI-270     | 259377017 | 3, 4, 5 | `archive/TESS_BLS_semi_auto/sample_raw/tess/toi270` |
| `l98-59` | L 98-59     | 307210830 | 2, 5, 8 | `archive/TESS_BLS_semi_auto/sample_raw/tess/l98_59` |
| `cm-dra` | CM Draconis | 199574208 | 16      | `archive/TESS_BLS_semi_auto/sample_raw/tess/cm_dra` |

경로는 `Planetory` 상위 작업 공간 기준입니다. 외부 목록에서 읽어 온 행성 확정 여부·검증용 정답 주기·정답 epoch/duration/depth는 JSON에 포함하지 않습니다. BLS는 관측 밝기의 반복 신호를 계산하며 천체의 성격을 확정하지 않습니다.

## 실행

새 checkout에는 원본 FITS와 생성 JSON이 없습니다. 기존 export를 제공받았다면 `manifest.json`, `toi270.json`, `l98-59.json`, `cm-dra.json` 네 파일을 `experiments/analysis-ui/public/observations/`에 준비합니다. manifest는 제공받은 JSON과 같은 export의 것이어야 합니다. 실제 FITS 재검증은 원본까지 있을 때만 실행할 수 있습니다.

FITS에서 새로 만들려면 `experiments/tess-bls`에서 `uv sync --locked`로 Python 3.11 이상 환경을 준비합니다. `--source-root`에 지정할 폴더는 `toi270/`(Sector 3·4·5), `l98_59/`(Sector 2·5·8), `cm_dra/`(Sector 16) 하위 폴더와 각각의 `*_lc.fits` 파일을 포함해야 합니다. 폴더별 TIC와 Sector는 위 표와 같아야 합니다. exporter가 파일을 내려받거나 `archive`의 내용을 변경하지 않습니다.

프로젝트 루트에서 명시적인 입력 폴더를 지정하는 예:

```powershell
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/export_observations.py --source-root "<저장된 tess 폴더>"
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/verify_observations.py --source-root "<저장된 tess 폴더>"
```

`Planetory` 디렉터리에서, 기존 `experiments/tess-bls` 가상환경을 사용합니다.

```powershell
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/export_observations.py
& experiments/tess-bls/.venv/Scripts/python.exe -m pytest -q experiments/analysis-ui/scripts/test_export_observations.py
& experiments/tess-bls/.venv/Scripts/python.exe experiments/analysis-ui/scripts/verify_observations.py --report experiments/analysis-ui/scripts/verification-observations.md
```

다른 저장 위치는 `--source-root <tess 폴더>`로 지정할 수 있습니다. `--output <폴더>`는 출력 경로를 변경합니다. 기본 출력은 `experiments/analysis-ui/public/observations/manifest.json`과 별별 JSON입니다. 원본 FITS와 생성 JSON을 Git에 넣지 않습니다. 생성 JSON에는 수십만 개의 수치가 있으므로 `.gitignore` 대상입니다. 파일별 SHA-256·크기·TIC·Sector를 함께 남깁니다.

## 관측점과 기준 시각

1. `QUALITY != 0`인 원본 행을 제외합니다.
2. 나머지에서 TIME 또는 PDCSAP_FLUX가 유한하지 않은 행을 제외합니다.
3. 나머지에서 PDCSAP_FLUX가 0 이하인 행을 제외합니다.
4. 이 시점의 **원본 TIME 전체의 float64 중앙값**을 `fold_reference_time_btjd`로 한 번 고정합니다. 아래 정제 후에 다시 구하지 않습니다.
5. 기존 `experiments/tess-bls/pipeline.py::clean`으로 Sector별 중앙값 정규화, 0.5일 초과 공백별 Savitzky–Golay 추세 제거, 상단 5-MAD 이상치 제거를 수행합니다. 기본 창은 2일, 다항식 차수는 2입니다. 하단 transit 점을 별도로 자르지 않습니다.
6. 최종 점은 **샘플링·binning·소수점 반올림 없이 모두** 내보냅니다. JavaScript Number로 round-trip 가능한 Python float64 JSON입니다.

`point_source_index`와 `point_source_row`는 각 출력 점에 대응하는 원본 파일 번호·0부터 시작하는 FITS 테이블 행 번호입니다. 마스크별 원본 제외 행도 기록하여 원본 행 수 = 최종 점 수 + 제외 행 수를 검사합니다. 선택한 데이터는 Sector가 겹치지 않습니다. 시간 중복을 발견하면 행을 합치지 않고 명시적으로 실패합니다.

`observation_windows`는 정제 전 유효 관측점의 Sector 전체 범위입니다. `observation_segments`는 같은 점에서 0.5일 초과 공백으로 나눈 실제 관측 구간입니다. 공백을 보간하지 않습니다. 따라서 Sector 전체 범위 안에도 관측하지 않은 시간이 존재할 수 있습니다.

## BLS와 UI 계약

- 실제 전체 정제 관측점으로 `pipeline.bls_periodogram`을 실행합니다. 0.5일에서 40일까지 선형 격자 8,000개, 내부 duration 탐색은 0.5시간에서 8시간까지 로그 격자 12개입니다. 기존 실험 파이프라인과 동일하게 flux error 가중치를 사용하지 않습니다.
- `periodogram`에는 주기와 power만 포함합니다. BLS 내부 최적 epoch/duration/depth는 내보내지 않습니다.
- `peaks`는 `pipeline.bls_period_candidates`의 최대 10개 대표 피크입니다. 원래 알고리즘의 주파수 분리·슬라이더 범위·간격을 그대로 사용합니다. 슬라이더 조절은 이미 제공된 전체 점을 브라우저에서 다시 접기 위한 동작입니다.
- `selection_rules.version = prototype-selection-v1`, `min_width_phase = 0.001`, `max_width_phase = 0.25`는 이 실험 UI 설정입니다. 확정된 서비스 정책이나 cadence별 보장값을 뜻하지 않습니다.
- `bundle_id`는 원본 해시·파이프라인과 exporter 해시·처리 설정·라이브러리 버전에서 결정됩니다. 같은 데이터 Bundle 안에서는 기준 시각이 변하지 않습니다.

manifest의 `targets`는 `id, label, tic_id, file, point_count, sectors`와 검증용 Bundle·해시·파일 크기를 포함합니다. `file`은 `manifest.json`과 같은 폴더의 상대 파일명입니다. 상세 데이터의 `provenance`에는 실행 시각·원본 출처·처리 방법·마스크 건수·BLS 계산 시간·도구 버전을 기록합니다. 외부 경로를 지정하면 브라우저에 기기별 절대 경로를 노출하지 않습니다.

단위 테스트는 비유한·음수·불량 품질 마스크의 분할, 정제 전 기준 시각 고정, 원본 행 매핑, 정답 필드 제외, float64 JSON 보존을 검사합니다. 실제 데이터 건수와 실행 시간은 생성 manifest/JSON 및 실행 로그가 기준입니다.

## 실제 데이터 검증 기록

`verify_observations.py`는 exporter와 같은 기본 입력·출력 경로를 사용합니다. 원본과 JSON을 읽기만 하며 `--report`를 지정한 경우에만 검증 Markdown을 씁니다. 원본 SHA-256·TIC·Sector, 출력 점별 원본 TIME와 행 번호, 제외 마스크의 정확한 분할, float64 중앙값을 확인합니다. 원본 유효점 전체에서 `pipeline.clean`을 다시 실행해 출력 TIME와 정제 flux가 float64 수준에서 완전히 같은지도 검사합니다. BLS는 다시 실행하지 않고 8,000개 격자와 power가 모두 유한한지 확인합니다.

| 대상        | 원본 행 | 정제 전 유효점 | 최종 출력 점 | 상단 clip |
| ----------- | ------: | -------------: | -----------: | --------: |
| TOI-270     |  57,320 |         44,553 |       44,551 |         2 |
| L 98-59     |  56,436 |         47,583 |       47,579 |         4 |
| CM Draconis |  17,765 |         14,900 |       11,558 |     3,342 |

CM Dra는 기존 `pipeline.clean`의 상단 5-MAD 규칙으로 유효점 3,342개가 제외됩니다. 전체 점 보존은 **정제 결과 전체**를 뜻하며 정제 전 유효점 전체를 뜻하지 않습니다. 이 검증은 기존 처리 재현성을 확인하고, 이 clipping의 과학적 적합성을 보증하지 않습니다. 원본 파일별 해시·건수·기준 시각은 [verification-observations.md](verification-observations.md)에 남깁니다. 브라우저 렌더링·Worker·포인터 조작·UI 성능 검증은 이 데이터 검증과 별도입니다.

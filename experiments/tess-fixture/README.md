# TESS 고정 fixture·합성 주입 세트·실행 manifest

Jira `S15P21C206-41`. 후속 전처리·BLS·비닝·AI 실험이 같은 입력으로 비교되도록 고정 SPOC 2분 광도곡선 표본과
합성 감광 주입 세트를 만들고, 모든 실행을 manifest 로 남기는 도구다. 표본 선정 근거·격자·스키마 설명은
[docs/development/tess-fixture-set.md](../../docs/development/tess-fixture-set.md) 에 있다.

원본 FITS(`sample_raw/`)와 주입 결과(`results/`)는 Git 에 넣지 않는다. Git 에 남는 것은 코드, 설정, `checksums.json`,
`references.csv`, `examples/` 다.

## 실행

Python 3.11 이상과 `uv` 가 필요하다.

```powershell
cd experiments/tess-fixture
uv sync --locked
uv run python -m tess_fixture targets                      # 표본 목록
uv run python -m tess_fixture download                     # 공식 MAST 제품 23개 다운로드·검증 (약 44MB)
uv run python -m tess_fixture references                   # NASA Exoplanet Archive 참고값 -> references.csv
uv run python -m tess_fixture inject --target toi270       # 주입 목록(catalog.csv) 생성
uv run python -m tess_fixture inject --target toi270 --write-curves   # 주입 곡선 NPZ 까지 저장 (약 28MB)
uv run pytest -q
```

`download` 는 완료된 파일을 헤더(TICID·SECTOR)와 SHA-256 으로 다시 검증한 뒤 캐시로 인정하고, 결과를
`checksums.json` 에 병합한다. 이후 실행은 이 파일의 checksum 과 다르면 실패한다. 일부만 받으려면
`--target toi270 cm_dra` 처럼 key 를 준다.

## 산출물 위치

| 경로 | Git | 내용 |
|---|---|---|
| `checksums.json` | 커밋 | 제품별 파일명·원천 URI·TIC·Sector·크기·SHA-256·PROCVER |
| `references.csv` | 커밋 | 표본 별의 확인 행성 주기·통과 지속시간·깊이 (Exoplanet Archive `pscomppars`, 조회 시각 포함) |
| `configs/injection_grid_v1.json` | 커밋 | 합성 단일 신호 격자 108점과 다중 신호 쌍 3개 |
| `schemas/run_manifest.schema.json` | 커밋 | 실행 manifest JSON Schema |
| `examples/run_manifest.example.json` | 커밋 | 실제 `inject` 실행 manifest 축약본 |
| `sample_raw/<target>/*.fits` | 제외 | 원본 SPOC LC |
| `results/injections/<grid>/<target>/catalog.csv` | 제외 | 주입 목록. 재실행하면 같은 내용이 나온다 |
| `results/injections/<grid>/<target>/<baseline>/*.npz` | 제외 | 바탕곡선과 group 별 주입 flux(float32) |
| `results/manifests/*.json` | 제외 | 실행별 manifest |

## 주입 규칙 요약

- 바탕곡선: `QUALITY == 0`, TIME·PDCSAP_FLUX 유한값, Sector 중앙값으로 나눔, 시간 정렬. 기존 PoC `pipeline.clean` 의
  첫 단계와 같고 detrending·clipping 은 하지 않는다. 벤치마크는 주입 곡선에 전처리부터 다시 실행한다.
- 모델: box. `flux *= 1 - depth` (통과 중). 첫 통과 중심 `t0 = t_min + phase_fraction * period`.
- 잡음 대조 곡선: 같은 시각·공백 구조에 `1 + N(0, robust scatter)` 를 채운 합성 곡선(`--noise-seed`, 기본 20260910).
  실제 곡선은 알려지지 않은 신호가 있을 수 있어 순수 음성 정답은 합성 곡선으로만 정의한다.
- 다중 신호: 두 신호의 box 모델을 곱해 한 곡선에 넣는다(`group_id` 공유).

## 파이썬에서 쓰기

```python
from pathlib import Path
from tess_fixture.lightcurve import load_sector, build_baseline
from tess_fixture import inject as inj

root = Path("sample_raw/toi270")
base = build_baseline([load_sector(p) for p in sorted(root.glob("*.fits"))])
grid = inj.load_grid(Path("configs/injection_grid_v1.json"))
rows = inj.build_catalog(grid, base, baseline_id="toi270-real", set_id=grid["grid_id"])
flux = inj.inject_group(base, [rows[0]])        # 주입 곡선 하나
```

## 한계

- 표본 9개 별·23개 제품은 실험용 고정 입력이며 서비스 데이터 범위(DEC-01)가 아니다.
- 실제 "무신호 별" 은 아직 포함하지 않았다. 선정 절차는 docs 문서의 TBD 항목을 따른다.
- 고조파·식쌍성 세트, 관측 조건 스트레스 세트, 사다리꼴 모델은 격자 v1 에 없다(`not_included_yet`).

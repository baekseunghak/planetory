# TESS 고정 fixture·합성 주입 세트·실행 manifest

Jira `S15P21C206-41`. 후속 전처리·BLS·비닝·AI 실험이 같은 입력으로 비교되도록 고정 SPOC 2분 광도곡선 표본과
합성 감광 주입 세트를 만들고, 모든 실행을 manifest 로 남기는 도구다. 표본 선정 근거·격자·스키마 설명은
[TESS fixture 문서](../../docs/data/tess-fixture-set.md)에 있다.

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

`references --target cm_dra` 처럼 일부만 갱신하면 `references.csv` 에서 **선택한 target 의 행만 교체**하고 나머지 행은
보존한다. Archive 에 행이 없는 target(식쌍성 등)도 빈 자리표시 행 1개로 남는다.

`inject` 는 실행마다 `results/injections/<set_id>/<target>/run-<UTC시각>-<run_id>/` 디렉터리를 새로 만든다. 이름의 시각과
UUID 앞 8자리로 다른 실행과 겹칠 가능성을 낮추며, 같은 초 안에서 끝난 실행들의 순서는 이름 정렬로 보장하지 않는다(정확한
순서는 manifest 의 `created_at`·`run_id`). `set_id` 는 `<grid_id>-<version>`(예 `injection_grid_v1-1.1.0`)이라 격자 버전이 바뀌면 다른 세트다.
세 명령 모두 `--results` 로 준 루트 아래 `manifests/` 에 실행 manifest 를 남긴다.

이 프로젝트는 설치 가능한 패키지(hatchling)라서 다른 실험 프로젝트가 경로 의존성으로 가져다 쓸 수 있다.
`experiments/tess-bench` 가 `tess-fixture = { path = "../tess-fixture", editable = true }` 로 사용한다.

## 산출물 위치

| 경로 | Git | 내용 |
|---|---|---|
| `checksums.json` | 커밋 | 제품별 파일명·원천 URI·TIC·Sector·크기·SHA-256·PROCVER |
| `references.csv` | 커밋 | 표본 별의 확인 행성 주기·통과 지속시간·깊이 (Exoplanet Archive `pscomppars`, 조회 시각 포함) |
| `configs/injection_grid_v1.json` | 커밋 | 합성 단일 신호 격자 108점과 다중 신호 쌍 3개 |
| `schemas/run_manifest.schema.json` | 커밋 | 실행 manifest JSON Schema |
| `examples/run_manifest.example.json` | 커밋 | 실제 `inject` 실행 manifest 축약본 |
| `sample_raw/<target>/*.fits` | 제외 | 원본 SPOC LC |
| `results/injections/<set_id>/<target>/run-*/catalog.csv` | 제외 | 주입 목록. 같은 입력·격자면 실행이 달라도 내용이 같다 |
| `results/injections/<set_id>/<target>/run-*/<baseline>/*.npz` | 제외 | 바탕곡선과 group 별 주입 flux(float32) |
| `results/manifests/*.json` | 제외 | 실행별 manifest (`config.parameters.run_dir` 가 산출물 디렉터리를 가리킴) |

## 주입 규칙 요약

- 바탕곡선: `QUALITY == 0`, TIME·PDCSAP_FLUX 유한값, Sector 중앙값으로 나눔, 시간 정렬. 기존 PoC `pipeline.clean` 의
  첫 단계와 같고 detrending·clipping 은 하지 않는다. 벤치마크는 주입 곡선에 전처리부터 다시 실행한다.
- 모델: box. `flux *= 1 - depth` (통과 중). 첫 통과 중심 `t0 = t_min + phase_fraction * period`.
- 잡음 대조 곡선: 같은 시각·공백 구조에 `1 + N(0, robust scatter)` 를 채운 합성 곡선(`--noise-seed`, 기본 20260910).
  실제 곡선은 알려지지 않은 신호가 있을 수 있어 순수 음성 정답은 합성 곡선으로만 정의한다.
- 다중 신호: 두 신호의 box 모델을 곱해 한 곡선에 넣는다(`group_id` 공유). `overlapping_transits` 쌍은 4일·8일 신호의
  t0 가 같도록 phase_fraction 0.5·0.25 를 써서 신호 1의 통과 두 번마다 신호 2의 통과가 정확히 겹친다(격자 1.1.0).

## 파이썬에서 쓰기

```python
from pathlib import Path
from tess_fixture.lightcurve import load_sector, build_baseline
from tess_fixture import inject as inj

root = Path("sample_raw/toi270")
base = build_baseline([load_sector(p) for p in sorted(root.glob("*.fits"))])
grid = inj.load_grid(Path("configs/injection_grid_v1.json"))
rows = inj.build_catalog(grid, base, baseline_id="toi270-real", set_id=inj.grid_set_id(grid))   # CLI 와 같은 set_id
flux = inj.inject_group(base, [rows[0]])        # 주입 곡선 하나
```

## 한계

- 표본 9개 별·23개 제품은 실험용 고정 입력이며 서비스 데이터 범위(DEC-01)가 아니다.
- 실제 "무신호 별" 은 아직 포함하지 않았다. 선정 절차는 docs 문서의 TBD 항목을 따른다.
- 고조파·식쌍성 세트, 관측 조건 스트레스 세트, 사다리꼴 모델은 격자 v1 에 없다(`not_included_yet`).

## 110 독립 평가용 holdout

기본 TARGETS 9별과 별도로 HOLDOUT_TARGETS 4별을 등록한다. 기본 다운로드·주입 대상은 기존 9별을 유지하며 holdout은 명시한 key로만 선택한다. 4별·10제품의 checksum/PROCVER는 checksums.json, Archive 조회 결과는 references.csv에 고정한다. 조회 결과 0행은 빈 기록으로 남기며 무신호의 증거로 해석하지 않는다.

다른 환경에서 원본을 준비할 때 tess-fixture 디렉터리에서 실행한다.

```powershell
uv sync --python 3.11 --locked
uv run --locked python -m tess_fixture download --target holdout_268637577 holdout_100102268 holdout_219237079 holdout_358253008
```

평가에는 저장된 참고값을 그대로 사용한다. `references`를 다시 조회하면 고정 입력이 달라져 holdout lock 검사가 실패한다. 평가의 설정·판정·재실행 정책은 [BLS 벤치마크](../../docs/data/tess-bls-benchmark.md)의 5.3절을 따른다.

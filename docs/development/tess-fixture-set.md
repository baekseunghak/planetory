# TESS 고정 fixture·합성 주입 세트

작성일: 2026-09-10 / 담당: 윤성용 / Jira: `S15P21C206-41` / 코드: `experiments/tess-fixture/`

이 문서는 후속 실험(전처리·detrending 벤치마크 `S15P21C206-42`, 비닝·discoverable 실측, BLS 벤치마크, AstroNet-Triage 평가 `S15P21C206-43`)이 같은 입력으로 비교되도록 고정한 표본과 합성 주입 세트, 실행 manifest 형식을 설명한다. 근거는 [TESS 파이프라인 갭 분석](tess-pipeline-gap-analysis.md) 5.1절(원천 구조)·5.7절(평가 데이터 구성안)·7.1절(전처리 비교 실험)이다.

여기 표본은 **실험용 고정 입력**이다. 서비스 데이터 범위(DEC-01)와 무신호 별 비율 실측은 별도 결정·Task 이며, 이 표본으로 대신하지 않는다.

## 1. 표본 TIC 목록과 선정 근거

모두 공식 MAST SPOC 2분 cadence Light Curve(`*-s_lc.fits`)다. Sector는 기존 PoC 다운로더에서 확인된 제품명 접두(Sector 2·3·4·5·8·16)가 있는 범위 안에서 골랐고, 각 제품 URL은 2026-09-10 MAST HEAD 요청으로 존재를 확인했다. 확인 행성 참고값은 `references.csv`(NASA Exoplanet Archive `pscomppars`, 2026-09-10 조회)를 정본으로 한다.

| key | 이름 | TIC | Sector | 역할 | 선정 근거 | 참고값 (`references.csv`) |
|---|---|---:|---|---|---|---|
| `toi270` | TOI-270 | 259377017 | 3·4·5 | 다중 행성, M형 왜성 | 기존 PoC 재현 샘플. 세 행성 회수와 고조파(11.38≈2×5.66) 검증 | b 3.360 d / c 5.661 d / d 11.382 d, 깊이 0.10~0.35 % |
| `l98_59` | L 98-59 | 307210830 | 2·5·8 | 다중 행성, 얕은 통과 | 깊이 0.06~0.15 %의 짧은 통과(0.8~1.3 h). 약한 후속 신호 회수율 확인 | b 2.253 d / c 3.691 d / d 7.451 d (e·f 는 비통과) |
| `cm_dra` | CM Draconis | 199574208 | 16 | 식쌍성 | 주극소·부극소 깊이가 비슷해 P/2 별칭이 강함. 고조파·대표 주기 선택 검증 | 궤도 주기 1.26839 d(문헌). Archive 행 없음 |
| `wasp18` | WASP-18 | 100100827 | 2·3 | 깊은 단주기 | 깊이 약 1 %, 주기 0.94 d. 탐색 하한(period_min)과 깊은 신호 제거 QA 확인 | b 0.94145 d, 깊이 1.04 % |
| `wasp62` | WASP-62 | 149603524 | 2·3·4·8 | 깊은 신호, 다중 Sector | 4개 Sector 결합·경계 처리 스트레스. Sector 5 SPOC 2분 제품은 없음(404) | b 4.412 d, 깊이 1.20 % |
| `toi700` | TOI-700 | 150428135 | 3·4·5·8 | 매우 얕은 통과, 장주기 | 깊이 0.04~0.28 %, 주기 10~37 d. 회수 한계와 관측 transit 수 조건 확인 | b 9.977 / c 16.051 / e 27.810 / d 37.424 d |
| `toi451` | TOI-451 | 257605131 | 4·5 | 젊은 활동성 별 | 회전 변광이 큰 별의 행성 3개. detrending 창 선택·신호 보존 스트레스 | b 1.859 / c 9.192 / d 16.365 d |
| `pi_men` | π Mensae | 261136679 | 4·8 | 밝은 별, 얕은 통과 | 매우 밝은 별의 0.027 % 통과. 포화·계통 오차 사례 | c 6.268 d (d·b 는 비통과 RV 행성) |
| `hd21749` | HD 21749 (TOI-186) | 279741379 | 3·4 | 장주기, 얕은 내행성 | 35.6 d 행성은 두 Sector 에서 통과 1~2회. 단일 통과·최소 transit 수 조건 확인. Sector 5 제품 없음(404) | GJ 143 b 35.613 d / HD 21749 c 7.790 d |

제품 수는 23개(약 44 MB)다. 파일별 SHA-256·PROCVER·크기는 `checksums.json` 에 있다. `references --target <key>` 로 일부 별만 다시 조회하면 그 별의 행만 교체하고 나머지는 보존하며, Archive 에 행이 없는 별(CM Dra)도 빈 자리표시 행으로 남는다. SPOC 처리 버전(PROCVER)은 제품마다 다르며(`spoc-5.0.11`~`spoc-5.0.96`, 일부는 2023년 재처리본) 같은 별의 Sector 사이에도 다를 수 있으므로, 버전 차이가 결과에 영향을 주는지는 전처리 벤치마크에서 확인한다. 세 기존 PoC 별(TOI-270·L 98-59·CM Dra)의 checksum 은 갭 분석 5.1절에 기록한 값과 같다.

### 아직 없는 표본 (TBD)

- **실제 무신호 별.** 순수 음성 정답으로 쓸 실제 별은 TOI·TCE 목록과 교차 확인이 필요하고, 그래도 미발견 신호 가능성을 배제할 수 없다(갭 분석 5.7절). 현재 무신호 대조군은 합성 잡음 곡선(아래 2절)으로만 정의한다. 실제 무신호 별 선정 절차 제안: 같은 Sector·카메라의 2분 대상 중 ExoFOP TOI 목록에 없고 SPOC TCE 도 없는 별을 후보로 뽑아 자체 BLS 결과와 함께 "무신호 후보"로 표시한다. 이는 무신호 별 비율 실측(DEC-01·03) Task 에서 수행한다.
- **항성 변동만 있고 행성이 없는 별, 계통 오차가 큰 별.** 라벨 있는 실제 표본 묶음(갭 분석 5.7절)의 나머지 항목이다. 41 범위에 넣지 않았고, 전처리 벤치마크(42)에서 필요하면 추가한다.

## 2. 합성 주입 세트 (`configs/injection_grid_v1.json`)

### 바탕곡선

주입은 detrending 전, 기존 PoC `pipeline.clean` 의 첫 단계와 같은 규칙으로 만든 Sector별 정규화 flux 에 넣는다.

1. `QUALITY == 0` 이고 TIME·PDCSAP_FLUX 가 유한한 행만 남긴다.
2. Sector 별로 시간 정렬 후 flux 중앙값으로 나눈다(중앙값은 manifest 에 기록).
3. Sector 를 시간순으로 결합한다.

TOI-270 Sector 3·4·5 기준 원본 57,320행 중 44,553행이 남고 robust scatter 는 약 1,365 ppm 이다. 이 값은 갭 분석 5.2절의 "QUALITY=0 이며 시간·밝기 모두 유한한 행" 합계와 같다.

바탕곡선 두 종류를 만든다.

| baseline_id | 내용 | 용도 |
|---|---|---|
| `<target>-real` | 위 규칙의 실제 정규화 곡선 | 실제 잡음·계통 위에서 회수율. 원래 있는 행성 신호도 함께 들어 있음을 기록 |
| `<target>-noise<seed>` | 같은 시각·공백 구조에 `1 + N(0, robust scatter)` 를 채운 백색 잡음 | 순수 음성 대조와 가짜 후보 수 측정. seed 기본 20260910 |

### 단일 신호 격자 (108점)

| 요인 | 값 | 비고 |
|---|---|---|
| period (day) | 1, 5, 20 | 20 d 는 27 d Sector 하나에서 통과 1~2회 |
| duration (hour) | 0.5, 2, 8 | 0.5 h 는 2분 cadence 로 약 15점, 10분 비닝이면 3점 |
| depth (ppm) | 500, 1,000, 3,000, 10,000 | TOI-270 scatter(약 1,365 ppm) 대비 0.4~7배 |
| 첫 통과 위상 | start 0.05, middle 0.5, end 0.95 | `t0 = t_min + fraction × period` |

`3 × 3 × 4 × 3 = 108` 개. 모델은 box(`flux *= 1 − depth`, 통과 중)이며 PoC `box_transit_model` 과 같은 정의다. 사다리꼴(ingress/egress) 모델은 v1 에 없다.

### 다중 신호 쌍 (3쌍)

| pair_id | 신호 1 | 신호 2 | 확인할 것 |
|---|---|---|---|
| `strong_weak` | 3.0 d / 2.0 h / 5,000 ppm | 7.0 d / 2.5 h / 800 ppm | 강한 신호 제거 후 약한 신호 회수 |
| `similar_strength` | 2.5 d / 1.5 h / 1,500 ppm | 6.5 d / 2.0 h / 1,500 ppm | 비슷한 세기의 회수 순서·중복 후보 |
| `overlapping_transits` | 4.0 d / 3.0 h / 3,000 ppm, phase 0.5 | 8.0 d / 3.0 h / 2,000 ppm, phase 0.25 | P2 = 2P1 이고 t0 가 같아(`t_min + 2일`) 신호 1의 통과 두 번마다 신호 2의 통과가 정확히 겹침. 겹친 점 삭제 없이 모델 곱 |

두 신호의 box 모델을 곱해 한 곡선에 넣고 `group_id` 를 공유한다. 바탕곡선당 catalog 행은 108 + 6 = 114, TOI-270 실행에서는 두 바탕곡선으로 228행·222개 곡선(group)이다.

격자 파일에는 `version` 과 `changelog` 가 있다. 세트 식별자 `set_id` 는 `<grid_id>-<version>`(현재 `injection_grid_v1-1.1.0`)이며 결과 디렉터리와 `injection_id` 앞에 붙는다. 1.0.0 은 `overlapping_transits` 두 신호에 모두 phase 0.5 를 써서 t0 가 2일 어긋나 실제로는 겹치지 않았고, 1.1.0 에서 두 번째 신호를 0.25 로 고쳤다(`S15P21C206-44`). 겹치는 관측점의 flux 가 두 모델의 곱인지는 회귀 테스트로 고정했다.

### catalog.csv 열

`injection_id`, `set_id`, `baseline_id`, `signal_index`, `group_id`, `period_days`, `duration_hours`, `depth_ppm`, `phase_fraction`, `phase_label`, `t0_btjd`, `model`, `n_transits_in_window`(관측점이 있는 통과 회차 수), `n_points_in_transit`. `injection_id` 형식은 `<set_id>-<baseline_id>-g<group 3자리>-s<signal_index>` 다. 목록 순서는 period → duration → depth → phase 로 고정이며 재실행하면 같은 내용이 나온다.

### 산출물 경로

`inject` 는 실행마다 `results/injections/<set_id>/<target>/run-<UTC시각>-<run_id 8자리>/` 를 새로 만든다. seed·`--single-only` 같은 옵션을 바꿔 연속 실행해도 이전 실행의 catalog·NPZ 가 남고, 각 실행의 manifest(`config.parameters.run_dir`, `outputs[].path`)는 자기 디렉터리만 가리킨다. `download`·`references`·`inject` 의 manifest 는 모두 `--results` 로 준 루트 아래 `manifests/` 에 저장된다.

### 아직 없는 세트 (`not_included_yet`)

고조파·식쌍성 세트(주극소·부극소 깊이 차이), 관측 조건 스트레스 세트(단일 Sector, Sector별 깊이 차이, 예상 transit 마스킹), 사다리꼴 모델 비교. BLS 벤치마크 Task 에서 격자 v2 로 추가한다. 격자 파일의 `version` 과 sha256 이 manifest 에 남으므로 v1 결과와 구분된다.

## 3. 실행 manifest (`schemas/run_manifest.schema.json`)

[데이터 관리 및 재현성](data-guidelines.md) 의 "재현성" 항목(실행 명령, 의존성 버전, seed, 코드·데이터 버전, 설정값, 환경)을 필드로 고정했다. `download`·`references`·`inject` 명령이 실행마다 `results/manifests/` 에 하나씩 남기고, 축약본 예시는 `experiments/tess-fixture/examples/run_manifest.example.json` 이다.

| 필드 | 내용 |
|---|---|
| `schema` | `planetory.run-manifest.v1` |
| `run_id`, `created_at` | UUID4, UTC 시각 |
| `task` | Jira 키와 명령, 예 `S15P21C206-41 inject` |
| `command` | 재실행 가능한 명령 한 줄 |
| `code` | `git_commit`, `git_branch`, `git_dirty`(커밋 안 된 변경 여부) |
| `environment` | Python 버전, 플랫폼, 패키지 버전(numpy·astropy) |
| `inputs[]` | 입력 파일마다 `path`, `sha256`, `size_bytes`, `source_uri`, `tic_id`, `sector`, `procver`, `role` |
| `config` | 설정 파일 `name`·`version`·`sha256` 과 명령행 인자 등 `parameters` (seed, 바탕곡선 규칙, Sector별 정규화 중앙값, 행 수 포함) |
| `outputs[]` | 산출물 `path`, `kind`(catalog·curves·checksums·references), `rows`, 가능하면 `sha256` |

후속 Task 는 이 스키마를 그대로 쓰거나 `inputs[].role` 과 `config.parameters` 만 늘린다. 스키마를 바꾸면 `$id` 버전을 올린다.

## 4. 재현 명령

```powershell
cd experiments/tess-fixture
uv sync --locked
uv run python -m tess_fixture download          # checksums.json 과 대조, 다르면 실패
uv run python -m tess_fixture references        # references.csv 갱신 (조회 시각 포함)
uv run python -m tess_fixture inject --target toi270 --write-curves
uv run pytest -q                                # 단위 테스트 25개 (FITS 표본이 없으면 1개 skip)
```

같은 checksum 의 FITS 와 같은 격자 파일이면 `catalog.csv` 는 바이트 단위로 같아야 한다. 곡선 NPZ 는 float32 로 저장하므로 비교는 catalog 와 manifest 의 sha256 으로 한다.

## 5. Git 에 넣지 않는 것

원본 FITS(`sample_raw/`), 주입 곡선·manifest(`results/`), 가상환경. `checksums.json` 과 `references.csv` 는 작은 표라서 커밋한다. 규칙은 [데이터 관리 및 재현성](data-guidelines.md) 을 따른다.

## 6. 41 완료 조건 대조

| 완료 조건 | 위치 |
|---|---|
| 표본 TIC 목록과 선정 근거 표 | 이 문서 1절, `tess_fixture/targets.py`, `references.csv` |
| 합성 주입 생성 코드와 파라미터 격자 문서 | `tess_fixture/inject.py`, `configs/injection_grid_v1.json`, 이 문서 2절 |
| manifest 스키마와 예시 1개 | `schemas/run_manifest.schema.json`, `examples/run_manifest.example.json`, 이 문서 3절 |
| 다른 팀원이 같은 표본을 재현할 수 있는 명령 | 이 문서 4절, `experiments/tess-fixture/README.md` |
| 문서·MR 링크 Jira 등록 | MR 병합 후 |

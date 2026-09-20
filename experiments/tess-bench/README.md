# TESS 처리 벤치마크

## 114 세그먼트·비닝 실험

3차 화면 리뷰는 완료됐고 추가 그림 요청은 없다. 저장된 9별 counts 재집계와 115·123 인계는 [운영 채택안](../../docs/data/tess-binning-benchmark.md#운영-채택안과-115123-인계)에 기록했다. 운영은 10분 mean·부분 bin 유지·상한 초과 실패를 제안하며 MR !101 재승인 대기다. 실험의 자동 확대·`bin-exp-v1-*`을 운영 규칙으로 사용하지 않는다.

MR !101 보충 시계열은 저장 결과만 읽는 `scripts/plot_binning_review.py`로 생성한다.
주입 차분 그림은 통과 밖 배경이 제거되어 실제 가독성을 대표하지 않는다.
설명·검증 범위는 [비닝 실험 문서](../../docs/data/tess-binning-benchmark.md#mr-101-2차-화면-리뷰와-보충-자료)를 따른다.
Matplotlib은 일회성 실행 환경에만 추가하며 프로젝트 lock은 변경하지 않는다. output은 존재하지 않는 새 경로로 지정한다.

```powershell
uv run --locked --with matplotlib==3.11.2 python scripts/plot_binning_review.py --source results/binning/run-20260919T120741Z-84d4cc93 --output results/review-114-round2-84d4cc93
```

다른 프로젝트의 가상환경이 활성화돼 있으면 Git Bash에서 `deactivate` 후 실행한다. `uv`는 기본적으로 이 디렉터리의 `.venv`를 사용하므로 다른 환경을 강제하는 `--active`는 사용하지 않는다. `--locked`가 실패하면 로컬 경로 의존성의 메타데이터와 lock 일치를 확인하며, 실측을 위해 잠금 검사를 생략하지 않는다.

`uv run --locked python -m tess_bench.binning --check-inputs`로 9별 입력을 확인하고, `--target l98_59`로 한 별을 실행한다. 인자 없이 전체 9별을 비교한다. 2·5·10·20분 평균/중앙값, 20,000점 상한, 빈 bin, 실제 신호와 전처리 후 합성 주입을 비교한다. 결과는 `results/binning/`에 별도 실행 디렉터리로 보존한다. BLS나 독립 holdout 평가는 아니다. 설계·지표·입력 준비·인수 조건은 [비닝 벤치마크](../../docs/data/tess-binning-benchmark.md)를 따른다.

Jira `S15P21C206-42` (전처리·detrending, `preprocess`) 와 `S15P21C206-110` (BLS 격자·게이트, `bls`·`bls-gates`). 비닝 실측(D) 벤치마크도 이 프로젝트에 하위 명령으로 붙인다.
BLS 실험 계획·규칙·결과는 [docs/data/tess-bls-benchmark.md](../../docs/data/tess-bls-benchmark.md) 에 있다.
입력은 [tess-fixture](../tess-fixture/README.md) 의 고정 표본과 합성 주입 세트다. 실험 계획과 결과 읽는 법은
[docs/data/tess-preprocess-benchmark.md](../../docs/data/tess-preprocess-benchmark.md) 에 있다.

이 코드는 **값을 정하는 실험 코드**다. 검증된 규칙은 구현 Task 에서 별도 커널로 옮긴다.

## 준비

Python 3.11 이상, `uv`. FITS 표본은 tess-fixture 쪽에 받아 둔다.

```powershell
cd experiments/tess-fixture
uv sync --locked
uv run python -m tess_fixture download --target toi270      # 처음 한 번 (약 6MB)

cd ../tess-bench
uv sync --locked                                            # tess-fixture 를 경로 의존성으로 설치
uv run pytest -q
```

## 실행

현재 설정 파일(1.1.0)은 18개다. `--only` 없이 돌리면 18개 전부 실행된다.

```powershell
# 빠른 확인: 설정 2개, group 6개, 잡음 바탕곡선 생략 (약 5초)
uv run python -m tess_bench preprocess --target toi270 --only poc_baseline biweight_1.0d --limit 6 --no-noise

# 전체 실행: 설정 18개, real 바탕곡선만 (별당 약 15~20분, 2단계 biweight 가 대부분)
uv run python -m tess_bench preprocess --target toi270 --no-noise

# 전체 실행 + 잡음 바탕곡선
uv run python -m tess_bench preprocess --target toi270

# 다른 별 (활동성·다중 Sector·저잡음)
uv run python -m tess_bench preprocess --target toi451 --no-noise
uv run python -m tess_bench preprocess --target wasp62 --no-noise
uv run python -m tess_bench preprocess --target pi_men --no-noise
```

문서에 기록된 결과는 위 "전체 실행" 과 범위가 다르다. 2026-09-10 실행은 설정 파일 1.0.0(11개)을 `--only` 없이 돌린 것이고,
2026-09-11 실행은 1.1.0 에서 추가된 7개와 `poc_baseline` 만 아래처럼 골라 돌린 것이다. 자세한 대응은 문서 4절.

```powershell
# 2026-09-11 기록의 명령 (1.1.0 추가분 7개 + 기준 재현, 별당 약 4~8분)
uv run python -m tess_bench preprocess --target toi270 --no-noise --only poc_baseline edge6h_savgol_2.0d edge12h_savgol_2.0d edge6h_biweight_1.0d edge12h_biweight_1.0d two_stage_sg3.0d_sg1.0d two_stage_bw3.0d_bw1.0d two_stage_bw3.0d_bw0.5d
```

`--limit` 이나 `--only` 로 일부만 돌리면 어떤 duration(0.5h·2h·8h)의 신호가 하나도 없을 수 있다. 그 경우 summary 의 해당
`depth_ratio_*` 열은 NaN 이다(전체 중앙값으로 대체하지 않는다).

옵션: `--only <setting_id ...>` 설정 선택, `--limit N` 바탕곡선당 처음 N group 만, `--no-noise` 잡음 바탕곡선 생략,
`--single-only` 다중 신호 쌍 생략, `--settings <json>` 다른 설정 파일, `--results <dir>` 산출물 루트.

실행 중 설정마다 진행 카운터와 요약 한 줄(깊이 보존·통과점 유지·잡음·경계·실패 구간·소요)이 터미널에 찍히고,
끝나면 설정별 요약표를 다시 보여준다.

## BLS 실행 (`bls`, `bls-gates`)

```powershell
# 빠른 확인: 설정 1개, group 3개, 잡음 생략 (1분 안)
uv run python -m tess_bench bls --target toi270 --stage tuning --only poc_linear20k --limit 3 --no-noise

# 조정 단계: 설정 9개 × (realclean + 잡음 1개) — 별당 1–4시간. autoperiod 는 기준선² 로 격자가 커져
# 4 Sector 이상 별(wasp62·pi_men)에서는 빼는 것을 권한다.
uv run python -m tess_bench bls --target toi270 --stage tuning
uv run python -m tess_bench bls --target wasp62 --stage tuning --only poc_linear20k linear5k linear50k autoperiod_ff3 pmax_half dur_log8_0.5-8h dur_log10_0.5-12h objective_snr

# 평가 단계: 채택 후보 2개만, 잡음 seed 3개 (가짜 후보 통계를 늘린다)
uv run python -m tess_bench bls --target l98_59 --stage evaluation --only linear50k poc_linear20k --noise-seeds 20260910 20260917 20260918

# 저장된 run 에 게이트 조합 적용 (재실행 없음). 옛 run(in_search_range 열 없음)은 --baseline-days 로 상한을 준다.
uv run python -m tess_bench bls-gates --run-dir results/bench/bls_grid_v1-1.0.0/toi270/run-<id>

# 문서 5.1절 표 생성: 여러 별 run 의 matches.csv 를 합쳐 설정별·구간별 회수율 Markdown 을 만든다 (재실행 없음).
# 구간표는 단일 주입만 세고 쌍 주입은 따로 낸다. 세 구간표의 주변합이 다르면 종료 코드 1.
uv run python -m tess_bench bls-report --run-dir results/bench/bls_grid_v1-1.0.0/toi270/run-<id> results/bench/bls_grid_v1-1.0.0/toi451/run-<id> --baseline-days 77.724 52.812
```

옵션: `--stage tuning|evaluation` 별·주입 선택(설정 파일 `stages`), `--only`, `--limit`, `--no-noise`, `--noise-seeds <seed ...>` 잡음
바탕곡선 seed 목록(기본 20260910 하나), `--include-raw-real` 알려진 행성을 제거하지 않은 원본 곡선 추가.
바탕곡선 `realclean` 은 `references.csv` 의 Archive 확인 행성을 `libs/astro-kernel` 로 나눠 제거한 곡선이다.

`matches.csv` 의 `in_search_range` 는 주입 주기가 그 설정의 탐색 상한(`period_max_days`, 기준선/3 등) 안인지다. 관측 기간이 짧은 별은
20일 주입이 범위 밖이라 어느 격자도 못 찾으므로, 설정 비교와 `bls-gates` 회수율은 범위 안 신호(`direct_recovery_in_range`)로 한다.
`bls-gates` 의 "잔여" 열은 주입 없는 실제 곡선(realclean `none`)에서 게이트를 통과한 피크 수다. 잡음 곡선만 보면 SNR 게이트가 충분해
보이지만 자전 변광·제거 잔여·밝은 별의 낮은 산포가 그대로 통과하므로 이 열을 함께 본다.

테스트는 `uv run pytest -q`. `test_metrics_cli` 하나는 TOI-270 FITS 표본(`tess-fixture download`)이 없으면 skip 된다(표본 있음 34 passed, 없음 33 passed / 1 skipped).

## 산출물

| 경로 | Git | 내용 |
|---|---|---|
| `configs/preprocess_settings_v1.json` | 커밋 | 설정 18개(1.1.0). PoC 기준에서 한 요인씩 바꿈: 품질 마스크 2, 구간 분리 2, SG 창 3, biweight 창 3, 가장자리 마스크 4, 2단계 detrending 3 |
| `results/bench/preprocess_v1-<ver>/<target>/run-<UTC>-<id>/metrics.csv` | 제외 | 행 = 주입 신호 × 설정 × 바탕곡선 |
| 같은 폴더 `summary.csv` | 제외 | 행 = 설정 × 바탕곡선. 보실 표 |
| `results/manifests/preprocess-<target>-<id>.json` | 제외 | 실행 manifest (tess-fixture 스키마) |

## 지표

| 열 | 뜻 | 읽는 법 |
|---|---|---|
| `depth_ratio_*` | 전처리 후 잰 겉보기 깊이 ÷ 심은 깊이 (전체 중앙값, 0.5h·2h·8h 별). 해당 duration 신호가 없으면 NaN | 1.0 이 보존. 8h 열이 낮으면 창이 짧아 긴 통과를 깎은 것. 1 을 넘을 수 있고 불확실성은 재지 않음 |
| `in_transit_kept_median` | 통과 구간 점 중 전처리 후 남은 비율. 분모는 품질·유한값 필터 뒤 바탕곡선의 통과 구간 점 수 | 가장자리 마스크·clipping 이 통과 점을 얼마나 지웠나 |
| `oot_scatter_ppm_median` | 통과 밖 잡음(robust scatter) | 낮을수록 좋지만 깊이 보존과 함께 볼 것 |
| `boundary_ratio_median` | 구간 경계 ±0.5일 안 \|flux−1\| 중앙값 ÷ 전체 잡음 | 순수 잡음이면 약 0.67(정규분포에서 median\|x\| = 0.674σ). 그보다 눈에 띄게 크면 경계 근처 추세 잔여·왜곡 |
| `failed_segments_per_curve` | 곡선당 실패·대체 처리된 구간 수 | 짧은 구간 중앙값 대체, 비정상 추세 |
| `edge_masked_fraction` | 가장자리 마스크로 제외된 점 비율 | `edge*` 설정에서만 0 이 아님. 통과 점 유지율과 함께 봄 |
| `n_points_after_quality` | 품질 마스크 통과 점 수 | 마스크 3종 비교용 |

깊이는 위상 접기 없이 통과 구간 점 중앙값과 통과 밖 중앙값의 차이다. 같은 group 의 다른 신호가 겹친 점은 그 신호의
알고 있는 모델로 나눠 대상 신호만 남긴 뒤 잰다(주입 파라미터를 아는 평가용 계산).

## 한계

- 깊이 지표는 전처리 후 겉보기 깊이 비율이다. real 바탕곡선의 잔여 변동·계통 오차와 심은 신호를 함께 본 추세 추정의 영향을
  detrending 손실과 완전히 분리하지 못하며, 신호별 불확실성은 측정하지 않는다.
- SG(Savitzky–Golay)는 통과를 마스킹하지 않고 다항식을 맞추므로 창이 길어도 깊이를 일부 깎는다. 그 손실 크기를 재는 것이
  이 벤치마크의 목적이며, 통과 마스킹 후 재적합하는 방식은 v1 설정에 없다(후속 후보). SG 는 SciPy `savgol_filter` 다.
- biweight 는 자체 구현이다: 초기값 중앙값, 척도 MAD(정규화 상수 없음), 절단 c=6, 고정 3회 반복, MAD 0 이면 중심값 반환.
  창은 평가점 ±창/2 를 `searchsorted` 로 잡고 구간 시작·끝에서는 한쪽만 채워진 채 계산한다(패딩 없음). 10점(`biweight_stride`)
  간격과 마지막 점에서 추정해 `np.interp` 로 선형 보간한다. astropy·wotan 의 biweight 와 동일하다고 가정하지 않는다.
- 품질 비트마스크 175·7407 은 이번 실험의 고정 값이다. lightkurve v1.11.3 의 `DEFAULT_BITMASK`/`HARD_BITMASK` 와 일치하지만
  현재 lightkurve main 의 값(17087/24319)과는 다르다. 비트 이름 대응과 SDPDD 원문 대조 상태는 문서 2절.
- 가장자리 마스크가 12시간 이상이면 구간 경계 ±0.5일 안에 남는 점이 없어 `boundary_ratio` 가 nan 이 된다. 그 설정의 경계 왜곡은
  이 지표로 평가하지 않는다.
- 2단계 detrending 은 1단계 추세로 나눈 뒤 2단계를 적합하므로 계산 시간이 두 배다(biweight 3일→1일: 228 group 에 약 5분).

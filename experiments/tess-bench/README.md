# TESS 처리 벤치마크

## 128 제출 매칭 부분 검산

`tess_bench.matching_evidence`는 저장된 111 manifest·CSV만 읽어 출력 해시·행 수와
회수 신호의 주기·duration 조건을 검사한다. BLS나 Git을 실행하지 않는다.
실행 명령·측정 한계·rule-1 잔여 범위는 [제출 매칭 검증](../../docs/data/tess-submission-matching-benchmark.md)을 따른다.
단위 테스트는 `uv run --locked pytest tests/test_matching_evidence.py -q`로 실행한다.

`tess_bench.matching_replay`는 사용자가 실제 FITS로 관측 창·주입 epoch를 재구성하고 저장된 후보를
제출 매칭에 대조하는 후속 실행 도구다. BLS 탐색은 하지 않는다. 같은 문서 4절의 5개 manifest 명령을 따른다.
합성 경계는 `uv run --locked pytest tests/test_matching_replay.py -q`로 검증한다.

## 112 고조파·후보 동일성 실험

111 확정 ZIP 감사, 4별 두 Bundle 비교, 정확한 모델 중복 정리와 자동 고조파 병합 비교 실험은
[후보 동일성 벤치마크](../../docs/data/tess-candidate-identity-benchmark.md)를 따른다.
`candidate_identity_v3_review`는 일반 MR에서 계약 승인을 요청하는 검토안이다.
69개 관련 테스트와 최종 `review-v3` 결과를 제공한다. 0.25ppm 동등성 실험은 운영 미채택이며
운영 ID 할당·122 통합은 이 실험의 범위가 아니다.

## 120 공용 BLS 커널 회귀

[함수 계약과 상태](../../libs/astro-kernel/README.md#bls-탐색과-품질-게이트-120)를 따른다.
합성 비교는 `tests/test_bls_kernel.py`에서 수행한다. 실제 FITS 회귀는 사용자가 아래 명령으로 실행한다.

```powershell
cd experiments/tess-bench
uv sync --locked --python 3.11
uv run --locked python -m tess_bench.bls_kernel_regression
```

현재 설정 파일의 tuning 대상·전체 주입 그룹에 realclean과 seed 20260910 잡음을 적용한다.
119의 `detrend_silver` 결과와 기존 전처리의 일치, 110 참조와 전체 power·상위 5피크의 수치
(rtol=1e-12, atol=0), 확정 게이트 및 direct/alias 회수 판정 일치를 검증한다.
FITS checksum은 기존 입력 로더로 검사하고 계산 전 plan에 입력·코드·설정·환경을 고정한다.
완료 시 `results/bls-kernel-regression/run-.../`에 comparisons·matches CSV와 출력 해시 manifest를 기록한다.
계산 중 예외·전처리 실패·불일치는 failure.json과 비정상 종료로 남는다. 입력 파일이 없으면 계산 전에 종료한다.
다운로드·Git 명령은 실행하지 않으며 원본·결과 파일은 Git에 추가하지 않는다.
2026-09-21 실제 4별·320곡선 회귀가 통과했다. [실측 결과](../../libs/astro-kernel/README.md#120-실제-4별-회귀-결과)를 참조한다. 새 독립 평가나 과거 환경 재현으로 해석하지 않는다.

과거 `holdout_lock_v1.json`은 유지한다. 코드·의존성이 바뀐 현재 checkout에서 과거 holdout 재실행이
거절되는 것은 정상이다. CLI 출력 단위 테스트만 임시 snapshot을 실제 validator로 검증하며,
잠금 변조 거절 테스트를 유지한다. 잠금을 갱신해서 과거 평가를 다시 통과시키지 않는다.

## 114 세그먼트·비닝 실험

3차 화면 리뷰는 완료됐고 추가 그림 요청은 없다. 저장된 9별 counts 재집계와 115·123 인계는 [운영 채택안](../../docs/data/tess-binning-benchmark.md#운영-채택안과-115123-인계)에 기록했다. 운영 채택안은 10분 mean·부분 bin 유지·상한 초과 실패다. 승인 상태는 MR !101과 정합화 요청에서 관리한다. 실험의 자동 확대·`bin-exp-v1-*`을 운영 규칙으로 사용하지 않는다.

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

## Silver 전처리 커널 회귀 (119)

공용 구현·실패·회귀 계약은 [astro-kernel](../../libs/astro-kernel/README.md#silver-전처리-119)을 따른다.
아래 명령은 BLS 없이 42의 4별·주입 격자 1.1.0을 기존 전처리와 새 커널로 각각 처리한다.
실제 실험은 사용자가 실행한다. 입력·코드·환경·오차 0 기준을 먼저 저장한다.

```powershell
cd experiments/tess-bench
uv sync --locked --python 3.11
uv run --locked python -m tess_bench.silver_regression
```

각 별의 `112/112 curves equal; summary=True`와 마지막 `passed=True`를 확인한다.
산출물은 `results/silver-regression/run-.../`의 plan·비교 CSV·지표 CSV·요약 CSV·manifest다.
이 도구는 다운로드·Git 명령을 실행하지 않는다. 사용자 실행 `9c908a11`에서 448/448곡선과 4별 요약이 일치했다.
총 428.510초이며 저장된 입력·출력·plan 해시 44개도 일치한다. 상세 수치·해시는 위 119 계약에 기록한다.
검증 범위는 42/D03 기본 커널이며 DAT-02 전체 구현 완료가 아니다. 고정 6·12시간 일괄 제외는 넣지 않으며,
확인된 불량 구간의 정규화 전 마스킹·원본 QUALITY/행 추적은 후속 `S15P21C206-245`에서 다룬다.

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

## BLS 실행 (`bls`, `bls-gates`, `bls-report`, `bls-snr-dy`, `iterate`)

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

# SNR 점 오차(dy) 방식 비교 (재탐색 없음): manifest 로 같은 곡선을 다시 만들고 저장된 상위 피크에서 SNR 만
# global(전역 robust scatter, 현재 구현)·flux_err(PDCSAP_FLUX_ERR/중앙값/추세)·local(1일 구간 scatter) 로 재계산해
# 게이트(SNR≥7, SNR≥7&SDE≥6) 결과를 비교한다. 결과는 run 폴더의 snr_dy.csv·gates_dy.csv.
# 시작 전에 manifest 의 grid·BLS 설정·전처리 설정 sha256, grid_set_id, 전처리·탐색 파라미터가 현재와 같은지 검사하고 다르면 중단한다.
# 재현 판정은 설정별(global 재계산 vs 저장 snr: 중앙값 ≤ 1e-6, 1e-3 초과 피크 ≤ 25%(실측 4–14%), 최대 < 0.2(실측 최대 0.161)) 이며 하나라도 실패하면 종료 코드 1.
# 기록된 전처리·탐색 파라미터 키가 현재 코드에서 사라지거나 이름이 바뀐 경우도 불일치다(허용된 기록용 메타 키만 예외).
uv run python -m tess_bench bls-snr-dy --run-dir results/bench/bls_grid_v1-1.0.0/l98_59/run-<id>
uv run python -m tess_bench bls-snr-dy --run-dir results/bench/bls_grid_v1-1.0.0/pi_men/run-<id> --only linear50k --baseline-days 131.097

# 반복 제거 루프 벤치마크 (S15P21C206-111): BLS → 중복·고조파 아닌 최강 피크 → 게이트 → box 모델 제거(astro-kernel)
# → 제거 QA(power 감소·경계 돌출·다른 후보 훼손·겹친 transit·유한성) → 통과면 잔차로 반복, 실패면 직전 단계로 복구.
# 곡선마다 종료 사유(설계 5.6절 7종)·단계별 QA 원시 수치·정답 회수 순서를 steps.csv / iterations.csv / matches.csv 에 남긴다.
uv run python -m tess_bench iterate --target toi270 --stage tuning --groups pairs none --no-noise          # 빠른 확인 (30초)
uv run python -m tess_bench iterate --target l98_59 --stage evaluation                                    # 쌍 3 + 단일 108 + none, realclean + 잡음 1
uv run python -m tess_bench iterate --target wasp18 --stage evaluation --include-raw-real --groups none    # 실제 행성 회수·잔여 고조파 시험
uv run python -m tess_bench iterate --target toi270 --stage tuning --groups pairs --no-noise --tamper-depth-factor 3   # QA 실패·복구 fixture
# 옵션 실험(문서 5.5절): 창 안 편향 깊이 상대 허용, 재적합 지속시간 확대, QA 실패 피크 마스킹 뒤 계속 탐색
uv run python -m tess_bench iterate --target cm_dra --stage evaluation --no-noise --continue-after-qa-fail --window-offset-rel-depth 0.1 --refine-duration-max-hours 12
```

옵션: `--stage tuning|evaluation` 별·주입 선택(설정 파일 `stages`), `--only`, `--limit`, `--no-noise`, `--noise-seeds <seed ...>` 잡음
바탕곡선 seed 목록(기본 20260910 하나), `--include-raw-real` 알려진 행성을 제거하지 않은 원본 곡선 추가.
바탕곡선 `realclean` 은 `references.csv` 의 Archive 확인 행성을 `libs/astro-kernel` 로 나눠 제거한 곡선이다.

`matches.csv` 의 `in_search_range` 는 주입 주기가 그 설정의 탐색 상한(`period_max_days`, 기준선/3 등) 안인지다. 관측 기간이 짧은 별은
20일 주입이 범위 밖이라 어느 격자도 못 찾으므로, 설정 비교와 `bls-gates` 회수율은 범위 안 신호(`direct_recovery_in_range`)로 한다.
`bls-gates` 의 "잔여" 열은 주입 없는 실제 곡선(realclean `none`)에서 게이트를 통과한 피크 수다. 잡음 곡선만 보면 SNR 게이트가 충분해
보이지만 자전 변광·제거 잔여·밝은 별의 낮은 산포가 그대로 통과하므로 이 열을 함께 본다.

테스트는 `uv run pytest -q`. `test_metrics_cli` 하나는 TOI-270 FITS 표본(`tess-fixture download`)이 없으면 skip 된다(표본 있음 40 passed, 없음 39 passed / 1 skipped).

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

## 제거 편향 진단 (111)

저장된 첫 단계 후보를 고정해 1 d·8 h 단일 주입 12곡선만 복원한다. BLS 재탐색 없이 제거 전후 창 안·바깥 평균과 기존 QA 재현 여부를 기록한다. 실제 실행은 사용자 담당이다.

```powershell
uv run --locked python -m tess_bench.iterate_diagnose --manifest results/manifests/iterate-l98_59-7cc8dcb2.json
```

`results/diagnostics/iterate-7cc8dcb2-<UTC>/window_offsets.csv`와 `provenance.json`을 생성한다. 원본 입력·CSV checksum 또는 Archive 모델이 다르면 중단한다. `source metrics reproduced: False`면 결과를 보존하고 원본과의 차이부터 조사한다. 진단은 QA 기준을 변경하지 않으며 결과가 나와도 자동 채택하지 않는다. 현재 111 브랜치의 원본 설정으로 실행하고 110 설정을 합친 뒤에는 같은 입력이라고 가정하지 않는다.

## 바깥 평균 기준 제거 QA 비교 (111, 미채택 옵션)

진단 뒤 비교 실행은 기존 `7cc8dcb2` 조건에 `--window-offset-reference oot`만 추가한다. 실제 실행은 사용자가 수행한다.

```powershell
uv run --locked python -m tess_bench iterate --target l98_59 --stage evaluation --no-noise --window-offset-rel-depth 0.1 --refine-duration-max-hours 12 --window-offset-reference oot
```

기본값 `unity`는 기존 기준 1과 비교하고 `oot`는 창 안·바깥 평균 차이와 두 평균의 표본 오차를 쓴다. 제거 모델·재적합·다른 QA는 유지한다. `steps.csv`에 판정 방식과 기존 unity 지표를 함께 남기고 manifest에 옵션을 기록한다. 상세 산식·한계·진단 결과는 [반복 제거 벤치마크 5.5.3](../../docs/data/tess-bls-iteration-benchmark.md)에 있다. L 98-59 비교 실행에서 단일 회수 65→71, 가짜 1→2로 기록했으며 기본값 승격은 보류한다(벤치마크 5.5.4절).

## 111 최종 검증 준비

최종 인계 후보와 110 승인 후 실행 세트는 [반복 제거 벤치마크 7절](../../docs/data/tess-bls-iteration-benchmark.md)에 모은다. 현재 oot는 미채택이고 unity·상대 0.1·duration 최대 12 h를 보수적 리뷰 후보로 둔다. 110 승인값 반영·재대조 전에 이를 최종 확정 실행으로 부르지 않는다.

새 iterate manifest에는 `iterate_config_version=bls_iterate_qa_v1/<설정 SHA-256 앞 12자리>`, 전체 `iterate_config_sha256`, `grid_set_id`와 Archive 참고값·fixture checksum 파일의 해시를 기록한다. 설정 해시와 코드 commit은 별도 식별자다. 콘솔 QA 요약의 최소·절댓값 최대를 함께 확인한다.

## 110 holdout 실행 (평가 전에 입력·설정 고정)

대상·판정 산식·결과 기록 정본은 [BLS 벤치마크 5.3절](../../docs/data/tess-bls-benchmark.md)이다. 기존 tuning/evaluation은 조정 이력이 있으므로 holdout과 구분한다. 기본 9별에 holdout을 섞지 않는다.

1. 환경은 `uv sync --python 3.11 --locked`로 준비한다. 다른 머신에서는 아래 다운로드와 고정 references.csv를 사용하며 Archive 참고값을 다시 갱신하지 않는다.
2. 코드·설정·통과 기준·제품 checksum·참고값·lock을 검토하고 **평가 전 커밋**한다. lock은 설정을 바꿔 우회하는 도구가 아니다. Git 명령은 사용자가 실행한다.
3. 아래 네 명령은 **tess-bench 디렉터리**에서 사용자가 실행한다. `iterate`가 아닌 `bls`다. 각 실행은 realclean + seed 3개, 바탕곡선당 주입 111그룹 + none 1그룹이며 대상당 총 448곡선이다.

```powershell
uv run --locked python -m tess_bench bls --target holdout_268637577 --stage holdout --only poc_linear20k --noise-seeds 20260910 20260917 20260918
uv run --locked python -m tess_bench bls --target holdout_100102268 --stage holdout --only poc_linear20k --noise-seeds 20260910 20260917 20260918
uv run --locked python -m tess_bench bls --target holdout_219237079 --stage holdout --only poc_linear20k --noise-seeds 20260910 20260917 20260918
uv run --locked python -m tess_bench bls --target holdout_358253008 --stage holdout --only poc_linear20k --noise-seeds 20260910 20260917 20260918
```

각 명령 성공을 확인한 뒤 다음 대상으로 진행한다. 에러 또는 lock mismatch가 발생하면 기준 파일을 재생성하지 말고 원인을 확인한다. 결과 manifest 4개와 peaks/matches/summary CSV를 보존하고, 같은 MR에 별별·합계 검증 결과를 추가한다. Git에는 원본 FITS와 results 디렉터리를 추가하지 않는다. 모의 manifest 테스트는 실제 holdout 평가를 수행하지 않는다.

### 111 QA 재검증 안내 (2026-09-21)

MR !117 리뷰에 따라 0 산포의 overlap 반환 타입과 다른 후보 깊이 측정 실패 시 거절 처리를 수정했다. 비교 대상이 있는데 제거 전·후 깊이가 비유한·0·음수이면 `other_depth_not_measurable`로 거절한다. 비교 대상이 없을 때의 미산출은 허용한다. 수정 전 2084018 결과는 새 코드의 검증 근거가 아니며, 깨끗한 수정 후 commit에서 [벤치마크 7.4·7.8절](../../docs/data/tess-bls-iteration-benchmark.md)의 8개 실행과 리뷰 ZIP을 갱신해야 한다.

## 122 반복 BLS 공용 커널 회귀

`astro_kernel.iteration.iterate_bls`를 승인된 111 반복 설정과 같은 입력에서 비교한다.
TOI-270·TOI-451·WASP-62·pi Men의 기존 realclean에 등록된 두 신호 주입 3종과 무주입을
각각 적용하는 총 16곡선이다. 정답 목록을 제거 QA에 전달하지 않는다. 전체 111 실험이나
새 독립 평가를 대체하지 않으며, 기존 holdout을 임계값 조정에 재사용하지 않는다.

```powershell
uv run --locked python -m tess_bench.iteration_kernel_regression --raw ../tess-fixture/sample_raw
```

다른 워크트리의 FITS를 읽을 때는 `--raw`에 해당 sample_raw 절대 경로를 전달한다.
원본 파일을 수정하지 않는다. 출력은 `results/iteration-kernel-regression/run-*` 아래에 생성한다.
`plan.json`은 입력·코드·설정 SHA-256과 환경을 고정한다. 성공 시 `manifest.json`,
`comparisons.csv`, 곡선별 `curve-*.json`을 남기고 실패 시 `failure.json`을 남긴다.
종료·채택·QA 실패 단계·단계별 모든 참조 수치와 임시 잔차를 비교한다. 수치는 rtol=1e-12,
atol=0이며 벽시계 시간은 제외한다. NaN 참조 진단은 운영 JSON의 null과 대조한다.
원본·실행 결과는 Git에 추가하지 않는다.

수치 회귀가 끝난 저장 결과를 후보 ID·모델 계약까지 연결해 확인할 수 있다.
이 검증은 신규 DB ID를 만들지 않고 fixture 전용 ID와 **테스트용 승인 표시**만 사용한다.
실제 정책 승인을 뜻하지 않는다. 승인 표시가 없을 때의 보류, 113 JSON Schema·모델 파서,
같은 계산 결과를 다음 Bundle로 전달했을 때 ID 유지·추가/은퇴 없음도 확인한다.
후보가 없거나 QA 실패·동일성 보류인 곡선은 성공 카탈로그로 강제 변환하지 않는다.

`jsonschema`가 있는 기존 astro-kernel 개발 환경에서 같은 작업트리의 libs·bench·fixture를
PYTHONPATH에 지정하고 다음 모듈을 실행한다. 이 보조 검증 때문에 운영 의존성을 추가하지 않는다.

```powershell
python -m tess_bench.candidate_catalog_regression --source results/iteration-kernel-regression/<성공-run>
```

출력은 `results/candidate-catalog-regression/run-*`의 plan·manifest·proofs.json이다.
이 연결 검증은 **같은 결과의 ID 유지**를 확인하며 다른 Sector 판의 과학적 동일성 검증이나
실제 DB 할당·Publisher 트랜잭션 검증을 대신하지 않는다. 유지·추가·retired 동시 발생과
부적절한 ID·불완전 판은 공용 커널의 합성 회귀 테스트에서 확인한다.

### 122 최종 로컬 검증 결과 (2026-09-21)

커널 전체 **170 passed**, 벤치마크 전체 **121 passed·1 skipped**다.
건너뛴 `test_metrics_cli`는 워크트리 내부 TOI-270 FITS 부재가 원인이다. 아래 실제 회귀는
기존 원본 디렉터리를 명시했고 11개 FITS checksum과 실행 전후 코드·입력 snapshot을 확인했다.
Python 3.11.9 / NumPy 2.4.6 / Astropy 7.2.2 / SciPy 1.17.1의 수치 실행이다.

최종 수치 실행 `run-20260921T074418Z-99a5ec46`: **4별·16곡선 전부 참조회귀 통과**, 306.374초.
QA 통과 이력 후보 19개, `no_quality_peak` 15곡선, `removal_qa_failed` 1곡선이다.
실패 곡선의 `power_not_reduced` 사유와 직전 잔차 보존까지 일치했다.
후보 19개는 행성 확정 수나 공개 후보 수가 아니다.

카탈로그 연결 실행 `run-20260921T074940Z-0bf59071`: 승인 근거가 없을 때 **16곡선 모두 보류,
수명주기 작업 0건**이다. 테스트 전용 승인 표시·fixture ID로 연결했을 때 11곡선의 후보
18개가 새 Bundle에서도 같은 ID를 유지했고 추가·은퇴는 0건이었다.
나머지 5곡선은 QA 불완전 1·빈 후보 4로 보류했다. 모든 준비 모델은 113 JSON Schema와
공용 파서를 통과했다. 이는 운영 승인이나 DB 반영 결과가 아니다.

| 실행 | 파일 | SHA-256 |
| --- | --- | --- |
| 수치 회귀 | plan.json | `b00c0ab404f950259cdf9172d2e4cf24a8a77ee8ca293cfa7b002b1944df4004` |
| 수치 회귀 | manifest.json | `0afa1acec1baf9b166bec9e3cad8fa7f4986021a4311aec5024fc23c165d1a26` |
| 후보 연결 | plan.json | `43d04f7a1b0fe5209c634150a13668e7c2f25a6ee2f0fc71e0aa317bd52dd4ee` |
| 후보 연결 | manifest.json | `607ba761710f9b3025f6f30415b1b7f8fcd4b372ef8edcb14d48de1efb8f95de` |

112 최종 승인 참조·소비자 리뷰, 123/125/Publisher 연결과 별도 245 브랜치를 합친 통합 검증은
남아 있다. 이번 회귀 통과를 전체 111 실험 재실행이나 운영 배포 완료로 표현하지 않는다.

리뷰 자료: `results/review-122.zip` (59,477 bytes, 23 entries).
SHA-256: `2108374dfca4fbe1b7aae42cb00d66d3aacfa8605af5131766d6802c187edc08`.
최종 두 실행의 plan·manifest·출력만 묶었으며 원본 FITS·임시 잔차 배열은 넣지 않았다.
입력·코드·결과 snapshot 77개와 ZIP 내부 checksum을 확인했다. Git 검사는 사용자가
수행하며 이 검증을 `git diff --check` 실행 결과로 대신 표기하지 않는다.


### 122 리뷰 보완 검증 (최신 develop 통합 전)

기존 16곡선 회귀는 `baseline_time`을 전달하지 않았고 search_diagnostics를 비교하지 않았다.
그 실행의 수치·복구 검증 범위는 유지하지만 마스크·Sector 진단 검증 근거로 사용하지 않는다.
보완 실행기는 `baseline_time=prepared.time`을 전달한다. 기준은 realclean baseline 구성 이후,
detrend 마스킹 전의 시각 배열이며 원본 FITS QUALITY 제외 행 전체를 복원한 기준은 아니다.

111 참조의 채택 모델을 순서대로 제거하여 각 탐색 직전 잔차를 재구성하고, 그 잔차로
120 `search_bls`를 직접 실행해 같은 coarse rank의 진단을 대조한다. 재적합 전 period·epoch·duration,
전체 sector_stats(유효점 없는 Sector 포함), sector_consistency_status, mask_dropped_fraction,
diagnostic_reasons의 누락·행 수·값을 비교한다. 수치 허용오차는 rtol=1e-12, atol=0이다.
이는 120에서 122로 진단이 제대로 전달되는지 확인하며 120 수식 자체의 독립 천문 검증은 아니다.

111은 원본 SNR 실패 시 최상위 termination만 변경했으므로, 보완 검산기는 122의 마지막
original_validation 실패 기록을 명시적으로 검증한 뒤 나머지 탐색 이력과 참조 수치를 비교한다.
실패 이유·대상 후보 단계가 다르거나 기록이 누락되면 거절한다.

동기화 전 커널·수정 검산기 합계 207 passed, 벤치마크 전체 137 passed·1 skipped를 확인했다.
skip은 워크트리 내부 TOI-270 FITS 부재다. 전체 NaN Sector·진단 누락/변조와 원본 SNR
저값/NaN/예외 경계를 추가했고 `python -O`에서도 진단 변조 3건의 명시적 실패를 확인했다.
최신 develop 반영 이후 전체 실제 16곡선·카탈로그 연결 재검증과 새 리뷰 자료 생성이 남는다.
기존 review-122.zip은 이 수정 전 검증 자료이며 갱신된 실행의 근거로 표기하지 않는다.

동기화 전 실제 연결 확인: `run-20260921T084803Z-21026f33`, TOI-270 4곡선 통과(65.715초).
채택 이력 5개의 진단 모두 Sector 3개 행을 유지했고 마스크 비율은 null이 아닌 0.0으로
계산·참조 일치했다. 이 입력에서는 기준 시각 이후 해당 통과점의 추가 제외가 없다는 뜻이며,
원본 QUALITY 제외가 없다는 뜻이 아니다. 비율이 양수인 경우와 전체 NaN Sector는 합성 경계
테스트에서 확인했다. manifest SHA-256:
`a5c3bfdf87158c50abd1ca41fc825f1eeecdd418e1110665715940272e381d7b`.
입력·코드·출력 hash를 사후 대조했다. 이 4곡선 확인은 최신 develop 통합 후 전체 회귀를 대신하지 않는다.


### 122 !160 develop 통합 후 최종 재검증

2026-09-21, 사용자가 가져온 develop을 통합하고 README의 112·122·245 설명을 모두 보존했다.
커널 전체 205 passed, 벤치마크 전체 184 passed·1 skipped(워크트리의 TOI-270 FITS 부재).
실제 회귀는 별도 원본 FITS 경로를 명시해 TOI-270·TOI-451·WASP-62·pi Men 총 16곡선을 검증했다.

- 수치·진단 회귀: `results/iteration-kernel-regression/run-20260921T085550Z-712f39d9`, 16곡선 통과, 270.00초.
- 종료: no_quality_peak 15곡선, removal_qa_failed 1곡선. 채택 이력 19개를 기존 참조와 비교했다.
- 19개 search_diagnostics의 Sector 통계·일관성 상태·마스크 제외율·진단 사유와 coarse 파라미터를 직접 120 탐색 결과와 대조했다. 마스크 제외율은 null 0개, 0.0이 18개, 0.001769911504424737이 1개다. 기준은 prepared.time이며 원본 FITS QUALITY 제외율이 아니다.
- 원본 SNR 실패의 최상위 종료와 마지막 단계 사유 일치는 합성 경계 테스트로 검증했다. 실제 16곡선에서 그 실패가 발생했다고 해석하지 않는다.
- 후보 계약: `results/candidate-catalog-regression/run-20260921T090039Z-17b1fdd1`, 승인 표시 없을 때 16곡선 모두 보류. 테스트용 승인·ID를 넣은 경우 11곡선 ready·18 ID 유지, 5곡선 보류(QA 실패 1, 빈 후보 4). 실제 DB 적재·정책 승인 검증은 아니다.
- 입력·코드·출력 snapshot 83개 경로를 사후 대조했고, ZIP 내부 파일 checksum도 검증했다.

수치 manifest SHA-256: `c0eb1917ebc11ccd6fbf1b76f54a5656579b9eaa99b9a05168920216f8caf36d`.
후보 계약 manifest SHA-256: `52aea00560b9b357234efd281b848f9f1699b8ff67ca3f094697eadf283dfacc`.
새 리뷰 자료: `results/review-122-r2.zip` (23항목, 원본 FITS·잔차 배열 제외).
ZIP SHA-256: `c4476feba5e8e02a33852bb507b3def28e33080932568c1df23434b34f35bd68`.
이전 review-122.zip은 이전 실행 자료로 보존하며 이번 재리뷰에는 r2를 사용한다.
Git index의 충돌 해제와 원격 MR 상태는 사용자 stage·병합 commit·push 후 확인한다.

245의 `tess_bench.interval_mask_regression`은 [아래 검증 기록](#245-근거-구간-마스크-검증)을 따른다.


## 245 근거 구간 마스크 검증

상태: 구현·로컬 검증 완료, 리뷰 전. Jira S15P21C206-245.
입력 계약은 [astro-kernel](../../libs/astro-kernel/README.md#근거-구간-마스킹-245)을 따른다.

### 실제 근거와 적용 범위

공식 [DRN4 Table 1·1.2절](https://archive.stsci.edu/missions/tess/doc/tess_drn/tess_sector_03_drn04_v02.pdf)은
Sector 3의 ACS 시험과 과학 관측 cadence 경계를 제공한다. 과학 cadence 바깥 구간을 다음처럼 해석한다.
경계는 정수 cadence 양끝 포함이며 과학 시작·종료 cadence 자체는 제외하지 않는다.

| 구간 ID | CADENCENO 시작 | 끝 | 근거 |
|---|---:|---:|---|
| s3-acs-0 | 111297 | 114077 | 첫 과학 관측 이전 |
| s3-acs-1 | 120979 | 121787 | 두 궤도 사이 |
| s3-acs-2 | 128764 | 130988 | 마지막 과학 관측 이후 |

[DRN42](https://archive.stsci.edu/missions/tess/doc/tess_drn/tess_reprocessing-sector_1_13_drn42_v02.pdf)는
재처리 시각과 품질 플래그 변경을 설명한다. DRN의 TJD 숫자를 별별 BTJD로 그대로 대입하지 않는다.
이번 실제 fixture는 DATA_REL=42, PROCVER=spoc-5.0.20-20201120이며 각각 원본 SHA로 고정한다.
마스크 목록은 이 고정 제품별 검토 fixture다. Sector 번호만 보고 모든 제품·재처리판에 자동 적용하지 않는다.

공식 PDF 원문 snapshot은 Git 제외 결과 폴더에 보존한다.

| snapshot | SHA-256 |
|---|---|
| tess_sector_03_drn04_v02.pdf | 5a825ad259483b0a8d1e9922b66e962752047f9046fe5b2bcc43442b4bfebffa |
| tess_reprocessing-sector_1_13_drn42_v02.pdf | 20fbfdd24157119be69a13b08ca91d51d01a6f690a69cf8f051e7959fa1fb2da |

### 검증 결과

2026-09-21: Sector 3 실제 5제품(HD21749, TOI270, TOI700, WASP18, WASP62), 각 19,692행을 읽었다.
각 제품의 5,815행에 ACS 구간 근거를 남겼다. 이 행은 모두 기존 QUALITY/유한값 필터에서도 제외돼
신규 제외는 0행이다. 준비 flux와 추세 후 flux는 전후 동일하며 모든 결과 status=ok이다.
원본 행 장부와 최종 생존 행의 합은 각 19,692행이고 cadence/QUALITY 원본 대응을 검증했다.
이는 추가 잡음 감소나 BLS 회수율 개선의 증거가 아니다. 이번 실측에는 BLS를 다시 실행하지 않았다.

합성 경계 검증은 정규화 전에 유효한 불량값 제거, 겹친 사유 보존, BTJD 경계 네 종류,
잘못된 단위·출처·checksum·구간 거절, 전체 제외·관측 부족, 빈 마스크 수치 동일성을 검사한다.
고정 6·12시간 일괄 제외는 추가하지 않았다.

### 재현

공식 PDF 두 개를 evidence 폴더에 원문 그대로 저장한다. 검증 스크립트가 고정 SHA를 검사한다.
원본 FITS는 읽기 전용으로 전달하고 새 결과 경로를 지정한다.

```powershell
python -m tess_bench.interval_mask_regression --raw <sample_raw> --evidence <evidence> --output <새_결과_경로>
```

실측 결과는 `experiments/tess-bench/results/interval-masks-245/run-v3`의 plan/report/manifest에 있다.
원본과 생성 결과는 Git에 추가하지 않는다. 127 Spark 실제 호출 연결·클러스터 검증 및 다른 Sector의
불량 구간 근거는 별도이며 이번 검증으로 전 구간 완비를 선언하지 않는다.

실행 전 plan에 원본·PDF·코드·uv.lock SHA, Python/NumPy/Astropy 환경, cadence 구간·경계·버전과
허용 오차 `rtol=0, atol=0, equal_nan=true`를 기록한다. 종료 후 입력·코드 해시를 다시 확인한다.
manifest는 plan/report/제외 장부 해시를 연결하며 실패는 failure.json으로 남긴다.
공용 커널 전체 테스트는 120 passed이다. 생존 행의 정렬·다중 Sector 원본 대응과 추세 적합 전 제외,
비유한 시각의 엄격한 JSON 직렬화까지 포함한다. 근거 구간의 운영 채택은 김동혁 리뷰 전이다.


5제품 합계 원본 98,460행 = 최종 생존 64,025행 + 제외 장부 34,435행이다.
장부의 `(product_id, source_row)` 중복은 0이고, 구간 근거가 붙은 행은 29,075행이다.
run-v3의 plan/report/exclusions 출력 해시 3개와 입력·코드 snapshot 일치를 다시 확인했다.


#### 마스크 없는 119 회귀 재검증

`no-mask-regression/run-20260921T073157Z-e454941a`에서 TOI-270·TOI-451·WASP-62·π Men 각각
112곡선, 총 448곡선의 정규화·추세·정제값·마스크·구간·산포·상태·요약이 기존42 참조와 정확히 일치했다.
소요 410.42초. 입력/코드/출력/plan 해시 52개도 다시 확인했다. 이 실행만 최종 회귀 증거로 사용한다.
앞선 중단 실행은 failure.json으로 별도 표시했고 성공 자료에 포함하지 않는다.
manifest SHA-256: `f97eab1a35cadf746361e6e0ab91dfc4c24e5e85ff4ff18fd77065a1a7a50bb3`.

근거 구간·버전 승인과 MR 병합은 아직 남아 있다. 운영 전체 Sector 적용, 클러스터 배포 또는
새 BLS 회수율 검증을 완료했다고 주장하지 않는다.


### 245 MR !158 리뷰 수정 검증

`9f62bb0` 리뷰의 NumPy scalar 직렬화와 최적화 모드 검증 누락을 수정했다.
입력 마스크를 변경하지 않고 검증된 복사본의 sector/cadence는 Python int, BTJD 경계는 float로 보존한다.
회귀 실행기의 행 수·원본 추적·수치 일치·사후 해시 검증은 명시적 ValueError로 실패한다.
실행 plan에 `sys.flags.optimize`도 기록한다.

- 통합 기준 develop: `8aaf335d4f13456c8a8bbc1cb89f5e916e1e0498`. 153 정합화 기록과 245 기록을 모두 보존했다.
- astro-kernel 전체: 124 passed (NumPy int64/float64/float32 JSON 직렬화 4사례 포함).
- 최적화 모드 검증 10사례 + 기존 Silver 참조 6사례: 16 passed.
- `-O`와 `PYTHONOPTIMIZE=1` 각각에서 정상 대조는 통과하고, 행 수·cadence 추적·수치·입력 hash 변조는 성공 manifest 생성 전에 거절했다.
- 실제 `python -O -m tess_bench.interval_mask_regression` 5제품 통과, 신규 제외0·전후 수치 동일.
- 결과: `results/interval-masks-245/review-fix-optimized`. 최적화 모드에서도 입력·코드 snapshot과 출력 hash를 확인한다.
- 기존 448곡선 실측은 앞 절의 이전 실행 증거다. 이번에는 전체448곡선을 재실행하지 않았고, 위 테스트와5제품을 재검증했다.

Git 충돌 해제 확정은 해결 파일 stage·merge commit·push 후 MR에서 확인한다. 로컬 마커 제거만으로 원격 MR 충돌 해제를 선언하지 않는다.

## 115 제공 해상도 discoverable 실험

10분 mean·제공 로그 5,000점·발견 직전 고정 모델 잔차의 봉우리 판정 검토안이다.
실행·분모·실패 상태·revision 사례·승인 경계는 [115 벤치마크](../../docs/data/tess-discoverability-benchmark.md)를 따른다.
`uv run --locked python -m tess_bench.discoverability --targets l98_59`로 한 별을 확인하고,
대상 옵션 없이 전체 9별을 실행한다. 9별 실측·검산을 완료했으며 규칙 승인 전이다. 운영 discoverable을 갱신하지 않는다.

## 123 비닝·제공 해상도 회귀

상태: 실행기·합성 검증 및 아래 9별 FITS 비교 완료, 리뷰 전이다. `segmentation_regression`은 114 비닝 참조,
115 판정 참조와 123 커널을 비교한다. 운영 규칙·게시 경계는 [Gold 계약](../../contracts/gold/README.md#42-s15p21c206-123-discoverable-연결게시-경계),
호출법은 [커널 README](../../libs/astro-kernel/README.md#제공-해상도-판정-123)를 따른다.

123은 API·Gold의 `max(40, 최장 후보 주기 × 1.15)`를 사용한다. 115의 옛 상한은 보존한다.
같은 새 격자에서 구현 간 판정·봉우리 인덱스·잔차·BLS power를 비교하고, 별도로 옛 격자를
동일 후보에 적용해 양방향 boolean 변경 목록을 기록한다. false→true가 없어도 임의로 사례를 만들지 않는다.
실제 122 후보 모델을 쓰지만 ID·Bundle·승인 근거는 실행 전용 합성값이다. 회원 재개·실제 DB 판 전환 검증은 아니다.

저장된 115 ZIP 검산만 실행하면 FITS와 BLS를 재실행하지 않는다.

```powershell
uv run --locked python -m tess_bench.segmentation_regression --saved-115 C:/Users/SSAFY/Downloads/review-115-2fb9d38f.zip
```

2026-09-22 제공 ZIP의 plan 및 출력 112개 checksum을 대조했고, 저장된 72개 주기도의 판정을
재분류해 모두 일치했다(후보 35/36, 대조 4/9). ZIP의 집 PC 절대 경로는 파일명으로 대응한다.
이 명령은 78개 원천 입력을 검증하지 않으며 191개 전체 파일 검증이나 새 격자 실측을 뜻하지 않는다.

사용자가 FITS를 준비한 환경에서 `experiments/tess-bench`를 작업 디렉터리로 실행한다. 자동 다운로드는 없다.

```powershell
uv run --locked python -m tess_bench.segmentation_regression --targets l98_59
# 한 별 확인 후 전체 9별 × 4곡선
uv run --locked python -m tess_bench.segmentation_regression
```

결과는 Git 제외 `results/segmentation-regression/run-*`에 별도 저장한다. plan에 입력·코드·환경·
설정·로컬 비교 오차를 기록하고 종료 전 입력과 plan hash를 다시 대조한다. 변경·불일치는 명시적으로 실패한다.
`curve-*.json`은 이전 격자 판정과 122 원본 결과·보류 사유·새 제안·변경 목록,
NPZ는 각 단계의 런타임 배열, `comparisons.json`은 곡선별 요약이다. 마지막 manifest만 성공 근거로 사용한다.
입력·코드를 실행 중 수정하지 않는다. 실패는 `failure.json`이며 성공으로 합산하지 않는다.

QA 실패·무후보로 122 카탈로그가 보류된 곡선은 bin 비교와 보류 상태를 기록한다.
그 곡선의 후보를 게시 가능하도록 우회하지 않는다. `passed=true`는 비교가 완료됐다는 뜻이며
모든 곡선의 discoverability_ready 또는 Gold 게시 허용을 뜻하지 않는다.
수치 비교 허용치는 로컬 회귀용이고 Gold `pending-measurement` 허용 오차를 확정하지 않는다.

검증: tess-bench 전체 225개(신규 실행기 3개 포함), 커널 전체 248개 통과.
신규 실행기 테스트는 합성 입력의 실제 BLS·manifest·출력 hash를 포함한다.
실제 FITS 비교는 아래 결과를 따른다. DB COMMENT migration 적용·운영 Publisher·EC2 비교는 아직 실행하지 않았다.

### 9별 FITS 비교 결과 (2026-09-22)

사용자 실행 `run-20260922T005624Z-bcdaf492`에서 9별 × 4곡선 모두 비교를 통과했다.
소요 251.484초이며 입력·코드·plan·출력 합계 168개 파일 checksum 불일치는 0이다.
최대 bin flux 절대 차이는 `4.440892098500626e-16`이다.

- ready 19곡선, held 17곡선이다. held는 제거 QA 실패 10곡선과 정상 종료·채택 후보 0개인 7곡선이다.
- ready 곡선의 원본 단계 19개와 후보 단계 30개, 합계 49단계를 비교했다. 후보 판정은 true 29개·false 1개다.
- QA 실패 곡선의 앞선 채택 후보 6개는 공개 판정에서 제외했다. 따라서 115의 전체 진단 후보 36개와 분모가 다르며 29/30을 전체 주입 회수율로 해석하지 않는다.
- 실제 비교 대상에서는 구·신 규칙 모두 상한 40일이었다. 상한 변경 0곡선·boolean 변화 0건이다. 실제 데이터의 false→true 또는 1.15배 상한 변경 효과를 입증한 결과는 아니다. 40일 후보→46일 상한 경계는 합성 테스트 근거다.
- tuning 목록 밖 대상도 기존 fixture 재검증이며 독립 평가가 아니다. ready는 계산 제안 준비 상태이고 운영 게시 승인이 아니다.

manifest와 출력 목록은 해당 결과 폴더에 보존한다. 계산 코드는 실행 후 변경하지 않았으며
실측 문서만 갱신했다. Git 검사·리뷰, 규칙 승인 근거 확인 및 DB COMMENT 적용 검증은 남아 있다.

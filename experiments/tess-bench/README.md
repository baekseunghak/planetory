# TESS 처리 벤치마크

Jira `S15P21C206-42` (전처리·detrending). 이후 BLS 격자(A)·비닝 실측(D) 벤치마크도 이 프로젝트에 하위 명령으로 붙인다.
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

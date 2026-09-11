# TESS 처리 벤치마크

Jira `S15P21C206-42` (전처리·detrending). 이후 BLS 격자(A)·비닝 실측(D) 벤치마크도 이 프로젝트에 하위 명령으로 붙인다.
입력은 [tess-fixture](../tess-fixture/README.md) 의 고정 표본과 합성 주입 세트다. 실험 계획과 결과 읽는 법은
[docs/development/tess-preprocess-benchmark.md](../../docs/development/tess-preprocess-benchmark.md) 에 있다.

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

```powershell
# 빠른 확인: 설정 2개, group 6개, 잡음 바탕곡선 생략 (약 5초)
uv run python -m tess_bench preprocess --target toi270 --only poc_baseline biweight_1.0d --limit 6 --no-noise

# 본 실행 1단계: real 바탕곡선만, 설정 11개 전부 (TOI-270 약 3분, biweight 3개가 대부분)
uv run python -m tess_bench preprocess --target toi270 --no-noise

# 본 실행 2단계: 잡음 바탕곡선까지 (약 6분)
uv run python -m tess_bench preprocess --target toi270

# 다른 별 (활동성·다중 Sector·저잡음)
uv run python -m tess_bench preprocess --target toi451 --no-noise
uv run python -m tess_bench preprocess --target wasp62 --no-noise
uv run python -m tess_bench preprocess --target pi_men --no-noise

# 설정 1.1.0 추가분만 (가장자리 마스크 4 + 2단계 3) + 기준 재현. 별당 약 10~12분 (2단계 biweight 가 대부분)
uv run python -m tess_bench preprocess --target toi270 --no-noise --only poc_baseline edge6h_savgol_2.0d edge12h_savgol_2.0d edge6h_biweight_1.0d edge12h_biweight_1.0d two_stage_sg3.0d_sg1.0d two_stage_bw3.0d_bw1.0d two_stage_bw3.0d_bw0.5d
```

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
| `depth_ratio_*` | 전처리 후 잰 깊이 ÷ 심은 깊이 (전체 중앙값, 0.5h·2h·8h 별) | 1.0 이 보존. 8h 열이 낮으면 창이 짧아 긴 통과를 깎은 것 |
| `in_transit_kept_median` | 통과 구간 점 중 전처리 후 남은 비율 | 품질 마스크·clipping 이 통과 점을 얼마나 지웠나 |
| `oot_scatter_ppm_median` | 통과 밖 잡음(robust scatter) | 낮을수록 좋지만 깊이 보존과 함께 볼 것 |
| `boundary_ratio_median` | 구간 경계 ±0.5일 안 \|flux−1\| 중앙값 ÷ 전체 잡음 | 순수 잡음이면 약 0.67(정규분포에서 median\|x\| = 0.674σ). 그보다 눈에 띄게 크면 경계 근처 추세 잔여·왜곡 |
| `failed_segments_per_curve` | 곡선당 실패·대체 처리된 구간 수 | 짧은 구간 중앙값 대체, 비정상 추세 |
| `edge_masked_fraction` | 가장자리 마스크로 제외된 점 비율 | `edge*` 설정에서만 0 이 아님. 통과 점 유지율과 함께 봄 |
| `n_points_after_quality` | 품질 마스크 통과 점 수 | 마스크 3종 비교용 |

깊이는 위상 접기 없이 통과 구간 점 중앙값과 통과 밖 중앙값의 차이다. 같은 group 의 다른 신호가 겹친 점은 그 신호의
알고 있는 모델로 나눠 대상 신호만 남긴 뒤 잰다(주입 파라미터를 아는 평가용 계산).

## 한계

- SG(Savitzky–Golay)는 통과를 마스킹하지 않고 다항식을 맞추므로 창이 길어도 깊이를 일부 깎는다. 그 손실 크기를 재는 것이
  이 벤치마크의 목적이며, 통과 마스킹 후 재적합하는 방식은 v1 설정에 없다(후속 후보).
- biweight 는 stride 점마다 추정해 보간한다(기본 10점 = 20분). 창 안의 점은 모두 쓰므로 통과 보존에는 영향이 작다.
- 품질 비트마스크 175·7407 은 lightkurve 의 DEFAULT/HARD 값이며, 비트 의미는 공식 문서로 확인해 문서에 기록한다.
- 가장자리 마스크가 12시간 이상이면 구간 경계 ±0.5일 안에 남는 점이 없어 `boundary_ratio` 가 nan 이 된다. 그 설정의 경계 왜곡은
  이 지표로 평가하지 않는다.
- 2단계 detrending 은 1단계 추세로 나눈 뒤 2단계를 적합하므로 계산 시간이 두 배다(biweight 3일→1일: 228 group 에 약 5분).

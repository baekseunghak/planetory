# AstroNet-Triage 평가 세트·입력 변환

작성일: 2026-09-16 / 담당: 윤성용 / Jira: `S15P21C206-43` / 코드: `experiments/astronet-eval/` / 상태: 9별 1차 세트 생성·변환 완료(5절), 팀 리뷰 전

이 문서는 AstroNet-Triage 단일 checkpoint 성능 평가(`S15P21C206-118`)에 쓸 **평가 세트의 라벨 출처·분리 규칙과 입력 변환 규칙**을 기록한다.
근거는 [외부 원천과 AI 설계](tess-pipeline/external-sources-and-ai.md) 5.9절(검증·임계값 결정 계획)과 [AI 모델 조사](tess-ai-model-feasibility.md) 4·5절이다.
입력 곡선은 [TESS fixture 세트](tess-fixture-set.md)의 9별, 전처리는 [전처리 벤치마크](tess-preprocess-benchmark.md)의 채택 설정이다.
모델 실행·지표·임계값 채택은 118, 운영 추론은 126 의 범위다.

## 1. 질문

118 이 답할 "AstroNet-Triage 가 Planetory BLS 후보의 잡음성 후보 1차 선별에 쓸 만한가"에 필요한 입력을, **누가 봐도 출처를 따라갈 수 있게** 고정한다.
세 가지가 고정 대상이다. (1) 어떤 후보가 PC·EB·junk 인지와 그 근거의 조회 시각, (2) 같은 별이 조정·평가 양쪽에 섞이지 않는 분리, (3) 후보 기하 → 201/61 배열로 가는 계산 규칙과 실패 처리.

## 2. 라벨 정의와 출처

AstroNet-Triage checkpoint 의 학습 라벨은 양성 `PC/EB`, 음성 `junk` 다. 점수는 행성 확률이 아니므로 평가 라벨도 모델 목표에 맞춘다.

| label | 정답 집합 | 출처 | snapshot | 후보 기하 |
|---|---|---|---|---|
| PC | 포함 | NASA Exoplanet Archive `pscomppars` (fixture `references.csv`). `tran_flag=1`, 주기·통과 중심·지속시간이 있는 확인 행성 | `fetched_at`(2026-09-10) | Archive 값. 깊이는 `pl_trandep(%)×1e4` ppm, 없으면 비움 |
| EB | 포함 | fixture `targets.py` role=eclipsing_binary(CM Draconis), 문헌 궤도 주기 | `targets.py` sha256 | 알려진 주기에서 BLS 로 epoch·duration·depth 산출 |
| junk | 포함 | fixture `synthetic_noise_baseline`: 실제 곡선의 시각·공백 구조에 백색 잡음만 채운 곡선, seed 20260910·20260911·20260912 | seed | 잡음 곡선의 BLS 최강 피크 |
| junk_unverified | **제외** | 실제 곡선에서 PC/EB 를 `libs/astro-kernel` 고정 모델로 나눠 제거한 잔차의 BLS 최강 피크 | 파생 | 미확인 신호일 수 있어 정답에서 빼고 점수 분포만 보고 |

TOI 의 PC/APC 와 무라벨 신호는 양성 정답으로 쓰지 않는다(Jira 43 지시). L 98-59 e·f 처럼 `tran_flag=0` 인 비통과 행성은 제외하고 `skipped_references.csv` 에 사유를 남긴다.

fixture 9별 기준 규모: PC 18(8별), EB 1, junk 27(9별×3 seed), junk_unverified 9(5절). **EB 가 1개라 118 의 PC/EB 대 junk 지표는 지시적 수준**이다. 별 추가는 108(범위·표본·예산)과 묶어 세트 버전을 올린다.

## 3. 분리와 학습 중복

- 분리 단위는 별(TIC)이다. `sha256(str(tic_id))` 첫 바이트가 짝수면 `calibration`, 홀수면 `evaluation`. 재실행·순서 변경에도 같은 결과이고, 같은 별의 후보(PC·EB·junk·unverified 전부)는 한쪽에만 간다. 위반은 `check_split_integrity` 가 실패로 만든다.
- 학습 중복: AstroNet-Triage 는 QLP TCE 로 학습했고 TIC 목록이 공개돼 있지 않다. 모든 별을 `training_overlap=unknown` 으로 적는다. `false` 라고 임의로 쓰지 않으며 118 에서 논문 부록으로 확인되면 갱신한다.

## 4. 입력 변환 규칙

40번 `prepare_toi270_probe.py` 의 view 수식을 그대로 옮겼다. checkpoint 가 학습한 입력 규칙이라 바꾸지 않는다.

| 단계 | 규칙 | 근거 |
|---|---|---|
| 곡선 | fixture 바탕곡선(QUALITY==0, Sector 중앙값 정규화) → tess-bench `preprocess` **`biweight_1.0d`**(42 채택) → `kept` 점만 | 42 결론. 40번은 PoC SG 2일이었으므로 같은 후보 점수가 달라질 수 있고 그 차이가 118 관찰 항목 |
| 접기 | `(t + P/2 − t0) mod P − P/2` | 40번 `phase_fold` |
| global_view | 201 bin, bin 폭 `P×1.2/201`, 범위 ±P/2 | Triage 실행 설정(README 의 81 이 아닌 checkpoint 실제 61 규격, 40번 4절) |
| local_view | 61 bin, bin 폭 `D×0.16`, 범위 ±min(P/2, 2D) | 같음 |
| 정규화 | bin 중앙값 → 빈 bin 선형 보간 → 전체 중앙값 빼기 → \|최솟값\| 으로 나눔 → float32 | 40번 `median_view` |
| 실패 | 후보별 `input_incomplete` + reason(`missing_geometry`, `invalid_geometry`, `no_valid_points`, `too_few_transit_points`, `empty_view`, `flat_view`) | 점수 0 대체 금지(갭 분석 5.9절 입력 스키마) |

기록하는 진단값: 접기에 쓴 점 수, 통과 안 점 수(\|위상 거리\| < D/2), 보간 전 빈 bin 수(global·local), 배열 sha256. 빈 bin 수가 크면 관측 공백이 view 에 영향을 준 후보다.

junk 후보의 BLS 격자는 PoC 기본값(선형 20,000점, 0.5일~기준선/3)이며 110 벤치마크 전 잠정값이다. junk 라벨의 정당성은 격자가 아니라 "신호 없는 합성 곡선"이라는 구성에서 나온다.

## 5. 실행 결과 (2026-09-16, fixture 9별)

실행: `build-set` 전체(약 4분, manifest `build-set-c56ddd49`), `convert`(약 30초, manifest `convert-b5329387`). 설정 `eval_set_v1` 1.0.0, 전처리 `biweight_1.0d`.

### 5.1 세트 구성

| label | calibration | evaluation | 합 | 정답 집합 |
|---|---|---|---|---|
| PC | 8 | 10 | 18 | O |
| EB | 0 | 1 | 1 | O |
| junk | 9 | 18 | 27 | O |
| junk_unverified | 3 | 6 | 9 | X |

정답 46개, 별 9개. calibration 은 TOI-270·WASP-62·TOI-700(3별), evaluation 은 L 98-59·CM Dra·WASP-18·TOI-451·π Men·HD 21749(6별). **EB 가 evaluation 에만 1개** 있어 calibration 세트로는 EB 를 조정할 수 없다. 제외한 Archive 행 5개: 비통과 행성 4(L 98-59 e·f, π Men b·d), 식쌍성 자리표시 1.

전처리 후 점 수: 9별 모두 `status=ok`, 실패 구간 0. clipping 으로 빠진 점은 별당 0~271개(π Men·HD 21749 가 많음, 밝은 별 계통 오차).

### 5.2 변환

55/55 성공, `input_incomplete` 0. 진단값에서 읽은 것:

- **PC/EB 의 통과 위치**: 19개 중 16개가 global 최솟값 bin 99~101(중심). 벗어난 3개는 모두 장주기·얕은 신호다. TOI-700 e(27.8일, 407 ppm, 통과 점 83, 빈 bin 9) 108, **TOI-700 d(37.4일, 613 ppm, 통과 점 198) 192**, **GJ 143 b(35.6일, 통과 1~2회, 빈 bin 39) 150**. 이 셋은 접힌 view 에서 통과보다 깊은 잡음 구조가 있다는 뜻이라 118 에서 "입력은 만들어졌지만 신호가 view 에 드러나지 않은 PC" 로 따로 봐야 한다. TOI-451(epoch 가 BTJD 3312 로 관측 뒤 1,000주기 이상 외삽)과 WASP-18(epoch 가 관측 앞 1,600일)은 모두 중심 100 에 맞아 Archive epoch 외삽은 문제가 없었다.
- **빈 bin**: 장주기 후보에서만 생긴다(최대 GJ 143 b global 39/201, π Men 잔차 피크 local 13/61). 보간으로 채워지므로 값은 유한하지만 그 구간은 관측이 아니다.
- **CM Dra**: EB 후보(1.268일, BLS 깊이 31%, 폭 0.72h)는 중심에 맞았다. 그런데 잔차 최강 피크(`cm_dra-junkunv-residual`)가 같은 주기 1.2673일·깊이 22%·power 5.2 로 나왔다. box 모델이 주극소만 제거해 **부극소가 남은 것**이다. 정답 집합에서 제외(in_truth=false)돼 있어 지표에는 안 들어가지만, 118 은 이 행을 "junk 로 오인된 EB 부극소" 로 해석해야 한다. 식쌍성의 부극소를 별도 EB 후보(위상 0.5)로 넣을지는 세트 v2 에서 정한다.
- **WASP-18 잔차 피크**(0.627일, 통과 점 9,904)도 뜨거운 목성 제거 뒤 남은 위상 곡선·부극소 성분으로 보이며 같은 이유로 정답 제외가 맞다.
- junk 후보의 BLS power(0.001~0.018)와 snr 열은 PoC 기본 격자의 참고값이며 라벨 근거가 아니다.

### 5.3 40번과의 차이

40번 TOI-270 c 입력은 BLS 가 찾은 기하(P 5.65933, t0 1389.5098, D 1.20h)와 PoC SG 2일 전처리였다. 이번은 Archive 기하(P 5.66051, epoch 1463.0806, D 1.68h)와 biweight 1일이다. 같은 후보라도 기하·전처리가 달라 118 의 점수는 40번의 0.258 과 직접 비교하지 않고, 필요하면 118 에서 40번 조건을 재현한 대조 행을 따로 만든다.

## 6. 118 로 넘기는 것

- `labels.csv`(라벨·split·기하·출처·snapshot), `conversions.csv`(status·reason·진단값·NPZ 경로), NPZ, `tfrecord_index.csv`(TFRecord 순서 ↔ candidate_id).
- 118 은 `in_truth=true` 후보만 정답으로 쓰고, `junk_unverified` 와 `input_incomplete` 는 별도 행으로 보고한다. `training_overlap=unknown` 을 결과 해석에 명시한다.

## 7. 한계·후속

- EB 1개, PC 18개 규모. 확장은 108 결정과 함께 세트 v2.
- QLP 학습 전처리와 SPOC·biweight 전처리의 동등성은 검증하지 않았다(118 항목).
- 공식 10개 checkpoint ensemble·AstroNet-Vetting 비교는 118 의 확장 항목이며 이 세트는 단일 checkpoint 입력 규격만 만든다.

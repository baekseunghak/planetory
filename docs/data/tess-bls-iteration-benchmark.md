# 반복 BLS·고정 모델 제거 루프 벤치마크 (종료·제거 QA·복구)

작성일: 2026-09-18 / 담당: 윤성용 / Jira: `S15P21C206-111` (계획 ID D05-1) / 코드: `experiments/tess-bench/` (`iterate` 명령, `tess_bench/iterate.py`) / 상태: 5별·real·실패 사례 실행 완료(5절), 문턱·설계 변경 제안은 팀 리뷰 전

이 문서는 Silver 내부 반복 BLS 루프 — 후보를 찾고, 고정 box 모델로 나누고, 잔차에서 다시 찾는 — 가 **언제 멈추고, 제거가 잘못됐는지 어떻게 알고, 잘못됐으면 어디로 되돌리는지** 를 고정 fixture 에서 측정해 종료 사유·제거 QA 문턱·복구 규칙을 D14-2(구현)에 넘기는 실험의 계획·규칙·결과를 기록한다.
근거는 [후보 검출 설계](tess-pipeline/candidate-detection.md) 5.6절 "Silver 내부 반복 BLS와 처리 종료 — v1.0"(종료 사유 7종)과 요구사항 DAT-05·DAT-06·DAT-08, 입력은 [TESS fixture 세트](tess-fixture-set.md) 와 주입 격자 1.1.0(쌍 3개 포함), BLS 설정·게이트는 [BLS 벤치마크](tess-bls-benchmark.md) 5.3절의 수정 제안(`poc_linear20k`, SNR ≥ 7 & SDE ≥ 6)을 잠정값으로 쓴다.
고조파 병합의 정식 규칙과 판 사이 후보 동일성은 `S15P21C206-112`, 운영 반복 커널은 `S15P21C206-122`(D14-2) 이 맡는다.

## 1. 질문

1. 쌍 신호(강/약·유사·겹침)에서 루프가 두 신호를 순서대로 회수하고 그 뒤 스스로 멈추는가. 멈추는 사유는 무엇인가.
2. 단일 신호·무신호 곡선에서 제거 뒤 잔여(고조파·진입·이탈 파형)를 새 후보로 잘못 채택하는 일이 얼마나 있는가.
3. 제거 QA 다섯 항목(power 감소·경계 돌출·창 안 편향·다른 후보 훼손·겹친 transit)의 원시 수치는 정상 제거에서 어느 범위에 있고, 일부러 틀린 모델을 넣으면 어느 항목이 잡는가.
4. QA 실패 뒤 채택 후보 집합이 직전 정상 단계와 같게 복구되는가(DAT-06).
5. 실제 행성이 있는 원본 곡선(`real`)에서 알려진 행성을 찾은 뒤 그 제거 잔여 고조파를 중복으로 막는가(110 에서 본 WASP-18 b 잔여 문제).

## 2. 루프 (설계 5.6절 v1.0 을 그대로 구현)

곡선 하나마다 `step = 0, 1, …` 을 반복한다.

1. 현재 곡선에 BLS(`poc_linear20k`) → 상위 5 피크.
2. 이미 채택한 후보의 **중복·고조파가 아닌** 가장 강한 피크를 고른다. 임시 규칙: 주기 비 m ∈ {1/2, 1, 2} 에 SRS 5.1 누적 오차 `|P − m·P_c| × N ≤ D/2` (N = 피크의 관측 통과 수, D = 피크와 채택 후보 지속시간 중 큰 값 — 잔여 피크는 지속시간이 짧게 잡히므로). 상위 5개가 전부 중복이면 `duplicate_or_harmonic_only` 로 종료. 정식 규칙은 112.
3. 게이트 SNR ≥ 7 & SDE ≥ 6 & 통과 ≥ 2 미달이면 `no_quality_peak` 로 종료.
4. 피크 주위(탐색 격자 간격의 ±2배)를 201점 국소 격자로 다시 계산해 주기·epoch·지속시간·깊이를 **재적합**한 뒤(설계 5.6 "transit model을 적합해"), box `transit_model`(계약 1.0)을 만들어 `libs/astro-kernel` `remove_transit_models` 로 현재 곡선을 나눈다. 탐색 격자 값을 그대로 쓰면 20k 격자에서 주기 오차가 통과 9회 누적으로 십수 분에 이르러 진입·이탈 띠가 남고, 그 잔여가 다음 단계에서 새 후보로 잡힌다(합성 테스트에서 확인).
5. **제거 QA**(3절). 통과면 후보 채택 후 잔차를 다음 곡선으로, 실패면 `removal_qa_failed` 로 종료하고 **채택 집합은 직전 단계까지**, 잔차는 버린다.
6. 유효 점 100 미만이면 `insufficient_observations`, 계산 예외는 `numerical_failure`, 채택 후보 5개 도달이면 `max_iterations_reached`.
7. 루프 뒤 채택 후보를 **원본 정제곡선**에서 같은 파라미터로 다시 평가(box 적합 SNR). 게이트 미달 후보가 있으면 종료 사유를 `candidate_validation_failed` 로 바꾸고 그 후보에 플래그를 남긴다.

잠정 설정은 `IterateConfig` 에 있고 manifest 에 기록된다: 안전 상한 5, 최소 점 100, 고조파 배수 {0.5, 1, 2}, QA 문턱은 3절.

5절 결과를 보고 세 가지를 **옵션**으로 추가했다(기본값은 5절 실행값 그대로, 5.5절에서 효과를 잰다).

| 옵션 | 동작 | 근거 |
|---|---|---|
| `--window-offset-rel-depth 0.1` | 창 안 편향 z 가 5 를 넘어도 \|평균 편차\| ≤ 0.1 × 제거 깊이면 통과 | 깊은 신호의 정당한 제거가 z 문턱에 걸림(5.2절) |
| `--refine-duration-max-hours 12` | 재적합 지속시간 범위를 0.5 × D₀ ~ max(2 × D₀, 12 h) 로 확대 | 탐색 격자 상한 4.8 h 로는 8 h 통과를 못 덮음(5.2절) |
| `--continue-after-qa-fail` | QA 실패 피크를 "제거 불가" 로 기록하고 그 통과 창(지속시간 × 1.5)을 NaN 으로 가린 뒤 계속 탐색. 실패 피크·고조파는 이후 `rejected_blocked` 로 제외. 채택 집합 복구 규칙은 그대로 | 식쌍성·뜨거운 목성 잔여가 최강 피크인 별에서 뒤의 행성을 전부 놓침(5.1절). 나누기로 없앨 수 없는 신호는 가리는 것이 대안 |

5.5절 분리 실행 뒤 **가드 두 개**를 기본값으로 추가했다(`max_duration_fraction = 0.35`, `qa_require_measurable = True`). 재적합·게이트에서 지속시간이 주기의 35% 를 넘는 피크는 transit 으로 보지 않고(주입 격자의 8 h/1 d = 0.33 은 허용), 통과 창 바깥(|φ| ≥ D) 구간이 없어 경계 돌출·창 안 편향을 잴 수 없으면 QA 실패(`qa_not_measurable`)로 본다. 바깥 구간 기준은 원래 |φ| ≥ 2D 였으나 점유율 높은 신호에서 구간이 비어 |φ| ≥ D 로 바꿨다. 5절 본 실행은 이 가드가 없던 코드로 돌았다(manifest 의 `iterate` 파라미터로 구분).

## 3. 제거 QA 수치와 잠정 문턱

| 항목 (DAT-06) | 측정 | 잠정 문턱 | 실패 이름 |
|---|---|---|---|
| power 감소 | 제거 주기 ±2% 국소 격자(201점)에서 제거 전/후 likelihood power 최대값 비 | ≤ 0.5 | `power_not_reduced` |
| 경계 돌출 | 잔차에서 통과 창 가장자리 띠(D/2 ≤ \|φ\| < D)의 \|r−1\| 중앙값 / 바깥(\|φ\| ≥ D; 5절 실행 때는 2D) robust scatter. 잡음만 남으면 약 0.67 | ≤ 1.5 | `edge_excess` |
| 창 안 편향 | 잔차에서 통과 창 안 (r−1) 평균의 z 점수 = 평균 / (scatter/√n), scatter 는 바깥(\|φ\| ≥ D) 구간. 과대 제거(밝아짐)는 +, 과소 제거(어둠 잔존)는 − | \|z\| ≤ 5 | `window_offset` |
| 다른 후보 훼손 | (a) 이미 채택한 후보: 원본에서 그 후보 깊이가 이번 모델 하나만 나눈 원본에서 얼마나 바뀌나 (b) 아직 제거 안 된 정답 신호(벤치마크 전용): 현재 곡선 → 잔차 깊이 변화. \|log₂ 비\| 최대 | ≤ 1 (2배) | `other_candidate_damaged` |
| 겹친 transit | 제거 모델 통과 점 중 다른 신호 통과와 겹치는 비율과, 겹친 점들의 \|r−1\| 중앙값 / scatter | 편차 ≤ 3 | `overlap_distortion` |
| 유한성 | `n_finite_residual == n_valid_input` | 같아야 함 | `non_finite` |

문턱은 잠정값이다. 원시 수치를 `steps.csv` 에 모두 남기므로 5절의 분포로 다시 정한다(단, 문턱을 바꾸면 루프의 경로도 바뀌므로 재실행이 필요하다).

## 4. 저장하는 것과 정답 대조

- `steps.csv`: 단계마다 상태(`accepted` / `rejected_gate` / `rejected_duplicate` / `qa_failed` / `error` / `terminated`), 종료 사유, 피크 파라미터·SDE·SNR·통과 수, QA 원시 수치, 실패 항목, BLS 시간.
- `iterations.csv`: 곡선마다 종료 사유, 채택 후보 수와 주기, 정답 회수 수·회수 단계 순서, 정답과 안 맞는 채택 후보(가짜) 수, QA 실패 단계, 원본 재평가 실패 수.
- `matches.csv`: 주입 신호마다 직접/alias/missed 와 회수 단계 (`bls_match.match_injection` 재사용, SRS 5.1 규칙).
- 정답 대조는 벤치마크 전용이다. 운영 루프에는 정답이 없으므로 (b) 훼손 항목과 회수 지표는 문턱 결정에만 쓴다.

실패 사례 fixture: `--tamper-depth-factor 3` 은 0단계 제거 모델의 깊이를 3배로 부풀려 QA 실패를 유도한다(창 안 편향이 잡아야 함). 합성 테스트(`tests/test_iterate.py`)는 단일 신호 채택 1회 뒤 종료, 강/약 순서 회수, 과대 제거 QA 실패·빈 집합 복구, 점 부족·계산 예외 종료 구분, 안전 상한, 중복 규칙, 경계 돌출 지표를 고정한다.

## 5. 실행 결과 (2026-09-18, 잠정 설정 `poc_linear20k` + SNR ≥ 7 & SDE ≥ 6)

평가 5별(L 98-59·CM Dra·WASP-18·TOI-700·HD 21749) × (쌍 3 + 단일 108 + none 1) × (realclean + 잡음 seed 20260910) = 1,120곡선, `real` 곡선 2개(WASP-18·TOI-700), 실패 사례 3개(TOI-270 쌍, 깊이 3배 모델). manifest `iterate-l98_59-503d1ee6`, `iterate-cm_dra-0a42355a`, `iterate-wasp18-bfcd893c`, `iterate-toi700-08b99eb4`, `iterate-hd21749-58005608`, `iterate-wasp18-29cf1d64`(real), `iterate-toi700-2e3ad65e`(real), `iterate-toi270-5726d88c`(tamper). 별당 10–33분.

```powershell
uv run python -m tess_bench iterate --target l98_59 --stage evaluation
uv run python -m tess_bench iterate --target wasp18 --stage evaluation --include-raw-real --groups none --no-noise
uv run python -m tess_bench iterate --target toi270 --stage tuning --groups pairs --no-noise --tamper-depth-factor 3
```

### 5.1 종료 사유·회수·가짜 후보

| 곡선 종류 | 바탕곡선 | 곡선 수 | 종료 사유 | 정답 회수 | 가짜 채택 | QA 실패 곡선 |
|---|---|---|---|---|---|---|
| none(주입 없음) | 잡음 | 5 | `no_quality_peak` 5 | — | 0 | 0 |
| none | realclean | 5 | `no_quality_peak` 3, `removal_qa_failed` 2 (CM Dra·WASP-18) | — | 0 | 2 |
| 쌍 강/약 | 잡음 / realclean | 5 / 5 | 잡음 `no_quality_peak` 5 · realclean 3 + QA 실패 2 | 9/10 · 6/10 | 0 · 0 | 0 · 2 |
| 쌍 유사 | 잡음 / realclean | 5 / 5 | 잡음 3 + `candidate_validation_failed` 1 + QA 1 · realclean 3 + QA 2 | 9/10 · 6/10 | 0 · 0 | 1 · 2 |
| 쌍 겹침(P₂ = 2P₁) | 잡음 / realclean | 5 / 5 | 잡음 3 + QA 2 · realclean 2 + QA 3 | 10/10 · 8/10 | 2 · 0 | 2 · 3 |
| 단일 | 잡음 | 540 | `no_quality_peak` 384, `removal_qa_failed` 155, `candidate_validation_failed` 1 | 326/540 | 36 | 155 |
| 단일 | realclean | 540 | `no_quality_peak` 274, `removal_qa_failed` 266 | 213/540 | 4 | 266 |

- **주입 없는 곡선은 멈춘다.** 잡음 5개 모두 0단계 `no_quality_peak`. realclean 도 3개는 0단계에서 멈췄고, CM Dra(식쌍성)·WASP-18(제거 잔여)은 상위 피크를 제거하려다 QA 에 걸려 멈췄다(가짜 채택 0).
- **쌍은 강한 신호 → 약한 신호 순서로 회수한다.** 회수 순서는 예외 없이 `0;1`(강한 쪽 0단계, 약한 쪽 1단계)이고, 겹침 쌍은 두 신호가 0단계 후보 하나(P₁ 또는 alias)로 함께 매칭된다. 두 번째 신호를 못 찾은 10건의 원인은 세 가지다: (1) CM Dra realclean 3건 — 식쌍성 식 신호가 0단계 최강 피크인데 box 로 나눌 수 없어 QA 실패 → 루프 종료 → 주입 신호에 도달 못 함. (2) WASP-18 realclean 3건 + 잡음 1건 — 첫 신호 제거 뒤 다음 최강 피크가 WASP-18 b 제거 잔여(0.94 d)이고 그 제거가 `power_not_reduced` 로 실패 → 종료. (3) HD 21749 realclean 2건 — 두 번째(약한) 신호가 게이트(SDE ≥ 6) 미달 → `no_quality_peak`.
- **단일 신호 회수 213/540(realclean)·326/540(잡음)** 은 110 의 "상위 5 안에 있음"(범위 안 0.58)보다 낮다. 여기서는 1위 피크가 게이트를 넘고 제거 QA 까지 통과해야 채택이기 때문이다. 별별 realclean 회수는 L 98-59 67, CM Dra 0, WASP-18 46, TOI-700 67, HD 21749 33 (각 108 중).
- **가짜 채택 42건**(잡음 36 + realclean 4 + 겹침 쌍 2) 중 14건은 정답을 주기가 조금 어긋나게 잡아 SRS 5.1 규칙에 못 든 경우(주로 0.5 h 짧은 통과: 5.002 vs 5.0 d)라 사실상 정답이고, 28건은 정답의 **P/3·P/5·P/7·3P·5P/2** 등 임시 규칙({1/2, 1, 2}) 밖 고조파다. 정식 병합 규칙(112)은 배수 집합을 넓혀야 한다.

### 5.2 제거 QA 원시 수치 분포

| 항목 | 채택 단계(정상 제거) p50 / p95 / 최대 | 실패 단계 p50 / p95 / 최대 | 잠정 문턱 | 판단 |
|---|---|---|---|---|
| power_ratio | 0.05–0.06 / 0.21–0.29 / 0.50 | 0.04–0.79 / 0.97–1.02 / 1.09 | ≤ 0.5 | 유지. 정상 제거는 대부분 0.1 아래 |
| edge_excess | 0.68 / 0.82–0.83 / 1.41 | 0.81–1.12 / 1.71–2.13 / 2.55 | ≤ 1.5 | 유지. 식쌍성(CM Dra) 2.0–2.5 를 정확히 가른다 |
| window_offset_z | 0.26–0.58 / 3.3–3.9 / 4.8 | 0.24–0.70 / 13–23 / 41 | \|z\| ≤ 5 | **재검토**. 정상 제거의 p95 가 3.3–3.9 로 문턱에 가깝고, 깊은 신호(10,000 ppm)에서 정답 제거가 걸린다(아래) |
| other_depth_log2_max | 0.20–0.38 / 0.35–0.88 / 1.00 | 0.21–0.26 / 1.8–2.8 / 5.3 | ≤ 1 | 유지, 경계값 1.00 이 나오므로 `<` 가 아닌 `≤` 로 명시 |
| overlap_dev | 0.71–1.05 / 1.9–2.1 / 2.45 | 0.78–2.33 / 3.9–90 / 103 | ≤ 3 | 유지 |

QA 실패 항목 합(5별): `window_offset` 245, `power_not_reduced` 241, `edge_excess` 137, `overlap_distortion` 100, `other_candidate_damaged` 40 (한 단계에 여러 항목 가능).

- **정답 신호의 제거가 QA 에 실패한 경우는 소수다.** 실패 단계의 피크가 정답이었던 수: L 98-59 10/25(realclean)·12/38(잡음), WASP-18 9/93·8/38, TOI-700 10/29·10/32, HD 21749 5/11·5/31, CM Dra 0/108·3/16. 나머지는 잔여·임의 피크의 제거를 QA 가 거절한 것으로, **거절 자체는 옳다**.
- 정답 제거가 실패한 경우는 거의 전부 **지속시간 8 h** 이고 깊이 3,000–10,000 ppm 이다(`window_offset`·`power_not_reduced`). 원인은 탐색 격자의 지속시간 상한(PoC 4점, 최대 4.8 h)이다. 재적합이 0.7–1.4 × 4.8 h = 6.7 h 까지만 보므로 8 h 통과는 모델이 짧아 양끝이 남는다. **제거 단계의 지속시간 탐색 범위는 탐색 격자와 별개로 넓혀야 한다**(제안: 0.5 × D₀ ~ max(2 × D₀, 12 h), period_min 미만).
- CM Dra realclean 108/108 이 0단계에서 실패한 것은 식쌍성 식(깊이 21%)을 box 로 나눌 수 없기 때문이다(`edge_excess` 2.0–2.5, `window_offset` −104). QA 는 제 역할을 했지만 그 뒤 루프가 멈춰 주입 신호 108개를 하나도 못 찾았다.

### 5.3 복구·원본 재평가·실제 곡선

- **QA 실패 뒤 복구는 재현된다.** 실패 사례 3건(깊이 3배 모델)은 모두 0단계에서 `window_offset` z = 72–257 로 실패하고 채택 집합이 빈 집합으로 남았다. 5별 본 실행에서도 `removal_qa_failed` 곡선의 채택 집합은 항상 실패 직전 단계까지다(`iterations.csv` `n_accepted` = `qa_failed_step`).
- 원본 재평가(`candidate_validation_failed`)는 1,120곡선 중 2건(CM Dra 잡음). 잔차에서 잡힌 후보가 원본에서는 게이트를 못 넘는 경우로, 드물지만 실제로 나온다.
- **`real` WASP-18**: 0단계에서 WASP-18 b(0.9415 d, 9,972 ppm, SNR 752)를 채택하고 제거 뒤 남은 0.941·1.883 d 피크는 중복·고조파로 **정확히 막았다**. 그러나 1.412 d(3P/2) 피크는 배수 집합 밖이라 제거를 시도했고 `power_not_reduced` 로 QA 가 막아 종료했다. 깊이 1% 행성의 box 제거 잔여가 3P/2 까지 미친다는 점은 112 의 배수 집합과 111 의 "실패 뒤 계속" 정책 둘 다에 걸린다.
- **`real` TOI-700**: TOI-700 c(16.05 d, 2,608 ppm)만 채택하고 나머지 세 행성(b 10 d·d 37 d·e 28 d, 모두 1,000 ppm 안팎)은 게이트 미달로 `no_quality_peak`. 얕은 행성은 이 게이트(SDE ≥ 6)에서 보이지 않는다 — 110 5.3절의 긴 기준선 SDE 손실과 같은 문제.

### 5.4 제안 (팀 리뷰 전)

| 항목 | 제안 | 근거 |
|---|---|---|
| 종료 사유 7종 | 설계 5.6 v1.0 그대로 채택. 이번 실행에서 `numerical_failure`·`max_iterations_reached`·`insufficient_observations` 는 fixture 에서 나오지 않았고 합성 테스트로만 고정 | 5.1 |
| 안전 상한 | 후보 5 유지 (쌍은 2단계에서 끝남, 최대 사용 3단계) | 5.1 |
| QA 문턱 | power ≤ 0.5, edge ≤ 1.5, overlap ≤ 3, other ≤ 1 유지. **창 안 편향은 \|z\| ≤ 5 또는 \|평균 편차\| ≤ 0.1 × 깊이** (`--window-offset-rel-depth 0.1`) — 5.5절에서 8 h 정답 제거 실패 6 → 0 확인 | 5.2·5.5 |
| 제거 단계 지속시간 범위 | 탐색 격자와 분리해 0.5 × D₀ ~ max(2 × D₀, 12 h) (`--refine-duration-max-hours 12`) — 5.5절에서 8 h 정답 채택 지속시간 6.7 → 7.9 h 확인 | 5.2·5.5 |
| QA 실패 뒤 동작 (DEC-05/06) | 5.6 v1.0 대로 `removal_qa_failed` 에서 종료 **유지**. 실패 피크를 가리고 계속 탐색하는 안은 5.5절에서 별칭 연쇄(가짜 채택 WASP-18 1 → 60)를 일으켜 보류. 112 의 넓은 고조파 집합과 별 단위 EB 제외 뒤 재측정 | 5.1·5.3·5.5 |
| 중복·고조파 배수 | 정식 규칙(112)은 {1/2, 1, 2} 를 넘어 P/3·P/5·P/7·3P·5P/2 와 3P/2 를 다뤄야 하며, 겹침 쌍(진짜 2P 신호)은 깊이·통과 부분집합으로 구분해야 한다 | 5.1·5.3 |
| D14-2 인계 | `IterateConfig` 잠정값·QA 정의(3절)·`steps.csv` 열·종료 사유를 구현 계약의 출발점으로 넘긴다. 위 재검토 항목 두 개(창 안 편향, 지속시간 범위)는 재실행 뒤 확정 | — |

### 5.5 옵션 실험 (realclean, 잡음 생략, 옵션 3개 동시)

CM Dra·WASP-18·L 98-59 의 realclean(쌍 3 + 단일 108 + none)에 2절의 옵션 세 개를 모두 켜서 재실행했다(manifest `iterate-cm_dra-4105837c`, `iterate-wasp18-578c83be`, `iterate-l98_59-ee6cadaa`). 5.1 의 기본 실행(realclean 만)과 비교한다.

| 별 | 항목 | 기본 | 옵션 3개 |
|---|---|---|---|
| L 98-59 | 단일 회수 / 가짜 채택 / QA 실패 곡선 | 67/108 / 0 / 25 | **75/108** / **9** / 16 |
| | 정답 제거 QA 실패 (그중 8 h) | 10 (6) | **2 (0)** |
| | 8 h 정답 채택 시 재적합 지속시간 중앙값 | 6.7 h | **7.9 h** |
| | 쌍 회수 / 종료 | 6/6 | 6/6 · 점 부족 2, 원본 재평가 실패 2 |
| WASP-18 | 단일 회수 / 가짜 채택 / QA 실패 곡선 | 46/108 / 1 / 93 | 57/108 / **60** / 92 |
| | 정답 제거 QA 실패 (8 h) | 9 (6) | 2 (2) |
| | 쌍 회수 / 종료 | 4/6 | 6/6 · 안전 상한 6, 점 부족 7 |
| CM Dra | 단일 회수 / 가짜 / QA 실패 곡선 | 0/108 / 0 / 108 | 5/108 / 0 / 108 |
| | 종료 | `removal_qa_failed` 108 | `duplicate_or_harmonic_only` 61, `max_iterations_reached` 46 |

- **지속시간 범위 확대 + 창 안 편향 깊이 상대 허용은 의도대로 작동한다.** 8 h 정답 제거의 QA 실패가 L 98-59 6 → 0, WASP-18 6 → 2 로 줄고 재적합 지속시간 중앙값이 7.9 h 로 8 h 를 덮는다.
- **두 옵션만 켠 분리 실행(L 98-59, `iterate-l98_59-1f73cf6a`)**: 단일 회수 75/108(기본 67), 정답 제거 QA 실패 2(8 h 0), 쌍 6/6, 그러나 **가짜 채택 8**. 8건 모두 8 h·5 d 정답을 제거한 **뒤** 남은 하위 고조파(P/7·P/9·P/8·P/3, 깊이 130–170 ppm)가 재적합에서 지속시간 **9–11 h(주기 0.71 d 의 65%)** 로 맞춰진 것이다. 그 폭이면 통과 창 바깥(|φ| ≥ 2D) 구간이 없어 경계 돌출·창 안 편향이 NaN 이 되고 QA 는 power 비만 보게 되어 통과했다. 즉 가짜의 원인은 옵션 자체가 아니라 **지속시간 상한과 "측정 불가" 처리의 부재**다. → 가드 두 개(2절: 지속시간 ≤ 0.35 × 주기, 측정 불가는 실패)를 추가하고 재실행한다(아래 5.5.1).
- **QA 실패 뒤 계속(마스킹)은 지금 규칙으로는 채택할 수 없다.** 가짜 채택이 L 98-59 0 → 9, WASP-18 1 → 60 으로 늘었다. 원인은 **별칭 연쇄**다. WASP-18 의 가짜 65건 중 62건이 **0.628 d = WASP-18 b 주기의 2/3** 하나다: 잔여 0.94 d 피크를 가리자 그 2/3 고조파 잔여가 거의 모든 곡선에서 SDE·SNR 게이트를 넘어 채택됐다. L 98-59 의 9건은 진짜 신호(P = 5 d)의 P/3 별칭이 제거 불가로 가려진 뒤 P/7·P/9·P/8 하위 고조파가 SDE 15–20 으로 연달아 채택된 것이다. 임시 배수 집합 {1/2, 1, 2} 는 2/3·1/3·1/7 을 막지 못한다. 마스킹이 점을 너무 많이 가려 `insufficient_observations` 로 끝난 곡선도 L 98-59 2, WASP-18 7 이다.
- **식쌍성(CM Dra)은 마스킹으로도 풀리지 않는다.** V 자 식의 양 날개가 box 지속시간 1.5배 마스크 밖에 남아(경계 돌출 최대 55) 잔여가 다시 최강 피크가 되고, 5단계를 전부 소모한다(회수 5/108). 식쌍성은 루프 안에서 다룰 대상이 아니라 **별 단위 EB 라벨**(43 라벨·AstroNet)로 탐색 대상에서 빼야 한다.

#### 5.5.1 가드 적용 뒤 분리 실행 (2차 결과 기록)

L 98-59 realclean 에 두 옵션 + 가드로 재실행한다. 1차(상한 0.2, 바깥 구간 |φ| ≥ 2D, `iterate-l98_59-451f709c`): 가짜 8 → 1, QA 실패 곡선 16 → 6 으로 구멍은 막혔지만 **회수 75 → 63** — 줄어든 12개가 전부 주입 격자의 (1 d, 8 h) 조합(점유율 0.33)이 상한 0.2 에 걸린 것이었다(다른 조합은 전부 동일). 그래서 상한을 0.35 로, 바깥 구간을 |φ| ≥ D 로 바꿔 2차 재실행했다.

**2차 실행 조건·출처**: 2026-09-19 KST(시작 2026-09-18 18:35:25 UTC), manifest `iterate-l98_59-7cc8dcb2.json`, run ID `7cc8dcb2-e0da-4722-b655-0984755148a6`. 실행 코드 `12336d7458886311cef994dcf96e2465b570230d`, manifest상 작업 트리 변경 없음. Windows AMD64, Python 3.11.4, NumPy 2.4.6, SciPy 1.17.1, Astropy 7.2.2. TIC 307210830·Sector 2/5/8, 주입 격자 1.1.0, `biweight_1.0d`, `poc_linear20k`, realclean 112곡선이며 잡음 seed는 사용하지 않았다. `max_duration_fraction=0.35`, `qa_require_measurable=true`, `continue_after_qa_fail=false`다. 콘솔 총 소요 799.8초(약 13분 20초), manifest notes는 기록 시점 차이로 799.6초다.

```powershell
cd experiments/tess-bench
uv run --locked python -m tess_bench iterate --target l98_59 --stage evaluation --no-noise --window-offset-rel-depth 0.1 --refine-duration-max-hours 12
```

| 종류 | 곡선 수 | 직접 회수 | 2P 별칭 회수 | 전체 회수 / 주입 신호 | 가짜 채택 | QA 실패 곡선 |
|---|---:|---:|---:|---:|---:|---:|
| none | 1 | 0 | 0 | 0/0 (회수율 미정의) | 0 | 0 |
| single | 108 | 63 | 2 | 65/108 | 1 | 18 |
| pair:overlapping_transits | 1 | 1 | 1 | 2/2 | 0 | 0 |
| pair:similar_strength | 1 | 2 | 0 | 2/2 | 0 | 0 |
| pair:strong_weak | 1 | 2 | 0 | 2/2 | 0 | 0 |
| 합계 | 112 | 68 | 3 | 71/114 | 1 | 18 |

- 전체 회수는 직접+별칭 합산이다. 단일 회수 65/108(60.2%), 전체 회수 71/114(62.3%)이며, 직접 회수만 세면 68/114(59.6%)다. 종료는 `no_quality_peak` 94곡선·`removal_qa_failed` 18곡선이다. QA 실패 항목은 `power_not_reduced` 5, `window_offset` 12, `overlap_distortion` 1, `edge_excess` 1로 총 19건이며 한 단계에 복수 사유가 있어 실패 곡선 수와 다르다.
- **단일 75개 안팎 회수·8 h 정답 제거 실패 0이라는 기대는 충족하지 못했다.** 주기 1 d·지속시간 8 h인 단일 12곡선 중 직접 회수는 2개이고, 나머지 10개(`g024`~`g033`)는 0단계에서 약 1 d 피크의 제거가 `window_offset`으로 거절됐다. 이 10개의 재적합 지속시간은 6.72~7.92 h, 창 안 편향 절댓값은 z 17.88~146.01·깊이 대비 0.123~0.341로 두 허용 조건을 모두 넘었다. 상한에서 허용하는 것만으로 제거 QA 통과가 보장되지는 않는다. 이전 실행과의 표본별 재대조 전에는 추가 실패의 원인을 바깥 구간 변경 하나로 확정하지 않는다.
- 가짜 1개는 주기 5 d·지속시간 8 h 주입의 `g069`에서 정답을 채택한 뒤 1단계에서 채택한 약 19.99842 d 후보다. 정답 주기의 약 4배인 잔여 후보이며, 정식 고조파 처리 검토는 112에 연결한다.
- QA 실패 18곡선 모두 `n_accepted == qa_failed_step`이고, 실패 단계 자체는 `qa_failed`로 기록됐다. 이는 저장 결과상 실패 직전까지의 채택 수가 유지됨을 확인한 것이며, 잔차 배열 자체의 복구 검증을 새로 수행한 것은 아니다.
- 잡음 곡선은 실행하지 않았으므로 realclean의 가짜 1개를 잡음 오탐률이나 110 holdout 통과 근거로 쓰지 않는다. 단일 별 옵션 실험이며, 110 확정 설정·5별 재검증·팀 승인은 남아 있다.

결과 디렉터리는 `experiments/tess-bench/results/bench/bls_iterate_v1-1.0.0/l98_59/run-20260918T183525Z-7cc8dcb2/`, manifest는 `experiments/tess-bench/results/manifests/iterate-l98_59-7cc8dcb2.json`이다. 원시 결과는 Git에 추가하지 않는다. manifest 입력 6개와 출력 CSV 3개의 SHA-256이 현재 파일과 모두 일치함을 확인했다.

| 출력 | 행 수 | SHA-256 |
|---|---:|---|
| steps.csv | 214 | `2c57d7ffb44ef451e7ce7e3276612fb59a2a390c55baff9fff3b696f1facba45` |
| iterations.csv | 112 | `7b9f7be7e6eafae98645a9c78cea0bf2f255313a6432f4749c72679c07df8754` |
| matches.csv | 114 | `c3ad0805b9978b73833ea0bb8c359f5201ff5b57ee37f92fda79478d5c8d17b0` |

기록상 한계: manifest의 `task`는 `S15P21C206-110 iterate`로 남아 있지만 실제 작업은 111이다. 실행 명령·브랜치·커밋으로 출처를 구분하고 원본 manifest는 수정하지 않는다. 후속 코드 수정에서 task 표기를 정정할 필요가 있다.

**5.4 제안 갱신**: 지속시간 범위 확대·창 안 편향 깊이 상대 허용은 **채택 제안·미확정**이다. 5.4·5.5의 8 h 실패 0은 가드 적용 전 옵션 실행에서의 관찰이며, 5.5.1의 현재 가드 조합에서는 재현되지 않았다. 우선 1 d·8 h의 `window_offset` 실패 원인을 조사하고 고정 비교 조건에서 재검증한다. 결과를 맞추기 위해 문턱을 즉시 완화하거나 옵션을 기본값으로 승격하지 않는다. 110 확정 설정과 5별 재실행 뒤 팀 리뷰로 확정한다. "QA 실패 뒤 계속" 은 **보류** — 112 의 넓은 고조파 집합(P/3·P/5·P/7·3P·3P/2 포함)과 별 단위 EB 제외가 먼저 있어야 하며, 그 전까지는 5.6 v1.0 대로 `removal_qa_failed` 에서 종료한다. 옵션은 코드에 남겨 112 뒤 재측정한다.

### 5.5.2 창 안 편향 원인 진단 (2026-09-19 실측 완료)

`7cc8dcb2` 저장 결과에서 1 d·8 h 실패에는 양수 편향과 음수 편향이 모두 있다. 예를 들어 g024는 z=17.88·깊이 상대 편차=0.293, g033은 z=−146.01·상대 편차=−0.123이다. 현재 노트북에는 이전 비교 실행 `1f73cf6a`·`451f709c`의 원시 manifest가 없어, 바깥 구간 변경만을 원인으로 확정하지 않는다.

현재 QA는 창 안 잔차 평균을 고정 기준 1과 비교하며, 바깥 구간은 scatter 추정에 사용한다. 바깥 평균이 1인지, 모델 제거가 창 안과 바깥의 차이를 줄였는지는 기존 steps.csv만으로 구분할 수 없다. 기준 밝기 편향·모델 깊이 또는 창 오차를 분리하기 위해 `python -m tess_bench.iterate_diagnose`를 추가한다. 이는 기존 판정을 바꾸는 보정이 아니라 진단이다.

- 원본 manifest의 입력 6개·출력 3개 SHA-256과 Archive 제거 모델을 확인한다.
- realclean 단일 1 d·8 h 주입 12곡선만 전처리까지 복원하고 저장된 0단계 후보 모델을 적용한다. BLS 탐색·재적합·반복 루프를 실행하지 않는다.
- 제거 전후 창 안·바깥 점 수와 평균(ppm), 제거 뒤 안−바깥 차이, 기존 QA 세 지표를 CSV로 기록한다.
- 기존 window_offset_z·window_offset_rel·edge_excess 재현 여부를 검사한다. 불일치하면 비정상 종료하고 해석을 보류한다.
- 결과는 별도 results/diagnostics 디렉터리에 저장하며 원본 산출물은 보존한다. provenance에는 원본 manifest·출력·현재 계산 코드의 SHA-256을 기록하며 Git 명령을 실행하지 않는다.

실행법은 [tess-bench README](../../experiments/tess-bench/README.md)의 제거 편향 진단 절을 따른다. 사용자가 아래 진단을 실행했으며 12곡선의 기존 QA 지표가 모두 재현됐다. 합성 테스트는 기준 밝기가 600 ppm 높은 정상 제거와 깊이를 3배 과대 제거한 경우를 구분한다. QA 문턱·제거 모델·지속시간 상한은 변경하지 않는다. 새 iterate manifest의 task만 `S15P21C206-111 iterate`로 정정하며 과거 manifest는 수정하지 않는다.

### 5.5.3 바깥 평균 기준 창 안 편향 QA (실험 옵션·실측 완료, 채택 보류)

진단 출처는 `results/diagnostics/iterate-7cc8dcb2-20260919T085528878912Z/`의 `window_offsets.csv`와 `provenance.json`이다(tess-bench 기준). CSV SHA-256은 `34f4133dc03035ec93f25ad1694057a06398e273dba9fee7b34134ea29818838`이며 provenance와 일치한다. 원본 run은 `7cc8dcb2`, `source_metrics_reproduced=true`다.

| 표본 | 제거 뒤 창 안 평균(ppm, 기준 1) | 바깥 평균(ppm, 기준 1) | 안−바깥(ppm) | 해석 |
|---|---:|---:|---:|---|
| g025 | 168.688 | 160.435 | 8.254 | 기준 밝기 편향과 제거 잔여를 구분할 필요 |
| g031 | 891.091 | 887.962 | 3.129 | 기준 1 대비 큰 편차가 대부분 공통 밝기 편향 |
| g033 | −990.460 | 29.312 | −1,019.771 | 바깥과 비교해도 제거 잔여가 남음 |

진단은 전처리의 어느 연산이 공통 편향을 만들었는지나 재적합이 실패한 세부 원인까지 확정하지 않는다. 우선 판정 기준의 공통 밝기 민감도를 분리하여 검증한다.

`--window-offset-reference oot`를 지정하면 창 안 편향만 다음 계산으로 바꾼다. 기본값 `unity`는 기존 실행과 같다.

- 안 구간: `|φ| < D/2`, 바깥 구간: `|φ| ≥ D`. 유한 잔차만 사용한다.
- `delta = mean(residual_inside − 1) − mean(residual_outside − 1)`.
- `SE = robust_scatter(residual_outside) × sqrt(1/n_inside + 1/n_outside)`; `z = delta/SE`.
- 깊이 상대 편차는 `delta / 제거 모델 깊이`다. 기존과 같은 `|z| ≤ 5` 또는 깊이 상대 편차 절댓값 ≤ 0.1 기준으로 비교한다. 0.1은 실행 옵션으로 지정한다.
- 안 5점·바깥 20점 미만 또는 바깥 scatter 0/비유한이면 측정 불가로 남긴다. 기본 `qa_require_measurable=true`에서 실패한다. 기준 1 방식으로 대체하지 않는다.
- 두 구간의 공통 잡음·독립 점을 가정한 SE 근사다. 시간 상관·바깥의 다른 신호/추세 오염을 해결한 통계적 유의확률은 아니다. 창 안 산포를 분모에 넣어 잘못 제거한 잔여를 숨기지 않는다.
- 모델 제거·재적합·지속시간 상한 0.35·게이트·경계 돌출·다른 후보/겹침 QA·실패 시 종료는 그대로다. 이 옵션은 운영 계약 또는 110 holdout 설정 변경이 아니다.

`steps.csv`의 QA 측정 행은 `window_offset_reference`와 실제 판정용 `window_offset_z`·`window_offset_rel`을 저장한다. `window_offset_unity_z`·`window_offset_unity_rel`에는 기준 1 대비 기존 지표를 함께 남긴다. manifest의 `iterate.qa_window_offset_reference`에도 방식을 기록한다. 과거 CSV에는 이 열이 없으며 기준은 unity다.

저장 진단 수치로 **창 안 편향 항목만** 재계산하면 g024·g027·g030·g033은 여전히 실패하며, 12개 중 실패가 10개에서 4개로 줄어든다. 이는 고정된 첫 단계 후보의 산술 비교이고 새 루프의 회수·가짜 후보 결과가 아니다. 후속 단계 경로와 다른 QA는 실제 비교 실행으로 검증한다.

```powershell
uv run --locked python -m tess_bench iterate --target l98_59 --stage evaluation --no-noise --window-offset-rel-depth 0.1 --refine-duration-max-hours 12 --window-offset-reference oot
```

`7cc8dcb2`의 조건에 reference 옵션 하나만 추가한다. 결과에서 단일·쌍 회수, 가짜 후보, QA 실패와 실패 항목, 1 d·8 h 표본별 첫 단계 및 원본 재평가를 비교한다. 사용자 반복 실행 결과는 5.5.4절에 기록한다. 검증은 tess-bench·tess-fixture 96 passed, 2 skipped(TOI-270 FITS 부재)다. 합성 테스트에서 공통 밝기 이동 불변성, 두 평균의 표본 오차, 과대/과소 제거 실패와 잔차 복구, 측정 불가, CLI→manifest 옵션 기록을 확인했다.

### 5.5.4 oot 비교 실행 결과 (2026-09-19)

사용자 실행 `652fe48d`의 manifest는 `results/manifests/iterate-l98_59-652fe48d.json`이다(tess-bench 기준). 실행 커밋 `5ad274e87a9b3a949253e0050abd2e6d9c2e0deb`, `git_dirty=false`, task `S15P21C206-111 iterate`를 확인했다. 원본 `7cc8dcb2`와 manifest 입력 6개가 동일하고 설정 파라미터는 reference 옵션만 추가됐다(run_dir 제외). 입력 6개·출력 3개 SHA-256이 일치한다. 콘솔 총 소요 870.7초(14분 30.7초), manifest 870.5초다.

| 항목 | unity (`7cc8dcb2`) | oot (`652fe48d`) |
|---|---:|---:|
| 단일 회수 / 108 | 65 (직접 63·별칭 2) | 71 (직접 69·별칭 2) |
| 쌍 회수 / 6 | 6 | 6 |
| 전체 회수 / 114 | 71 (직접 68·별칭 3) | 77 (직접 74·별칭 3) |
| 가짜 채택 | 1 | 2 |
| QA 실패 곡선 | 18 | 13 |
| 1 d·8 h 직접 회수 / 12 | 2 | 8 |
| 1 d·8 h 첫 단계 window_offset 실패 | 10 | 4 |
| 원본 재평가 실패 | 0 | 0 |

추가 직접 회수 6개는 g025·g026·g028·g029·g031·g032이며 모두 1 d·8 h 주입이다. g024·g027·g030·g033은 첫 단계 창 안 편향 실패로 남는다(재적합 지속시간 모두 6.72 h). 진단의 고정 후보 산술 비교와 일치한다. g029·g032는 첫 신호를 회수한 뒤 약 3 d 잔여 피크 제거가 power_not_reduced로 실패하여 종료한다. 따라서 첫 단계 실패 감소 6건이 곡선 전체 QA 실패 감소 5건과 같지 않다.

가짜 2개 중 기존 g069의 약 19.998418 d(주입 약 5 d의 4배)는 그대로다. 추가 가짜는 g102에서 약 20 d 정답을 제거한 뒤 1단계의 P=0.605876699 d·D=5.04 h·깊이 62.632 ppm 피크다. SNR=8.259, SDE=11.793, power_ratio=0.447933이며, 기존 unity z=9.189·rel=0.899로 실패했던 동일 후보가 oot z=−1.405·rel=−0.200으로 통과했다. 현재 판정은 OR이므로 상대 편차가 0.1을 넘어도 절대 z가 5 이하면 통과한다. 이는 새 방식에서 추가된 가짜 채택이며, 주입과 매칭되지 않았다는 뜻이다. 기원이나 고조파 관계를 이 수치만으로 단정하지 않는다.

종료는 no_quality_peak 99곡선, removal_qa_failed 13곡선이다. QA 실패 항목은 power_not_reduced 7·window_offset 5·overlap_distortion 1·edge_excess 1(복수 사유 포함 14건)이다. 실패 13곡선의 n_accepted == qa_failed_step을 확인했다. 저장 기록상 채택 수 검증이며 이번 실제 잔차 배열을 새로 검증한 것은 아니다. 콘솔 QA 요약의 최대는 부호 있는 최댓값이므로 음수 방향 큰 실패를 보여주지 않는다. 실제 절댓값 최대는 window_offset_z 117.430, window_offset_rel 0.334636이다.

| 출력 | 행 수 | SHA-256 |
|---|---:|---|
| steps.csv | 230 | `0854e59caba83656b6ed3468bf49f8f3088f843d4b91b1dec802763d6144cc47` |
| iterations.csv | 112 | `293bd887e5ce6ebb0fd4a5823a4b0c6c2a1f16d265ed22efbfe633691bd84f59` |
| matches.csv | 114 | `5b0abe1ebbaad92db1bf0a1f1407f76f2dbd016a87d612cc6eddeb0b2b699e63` |

파일은 `results/bench/bls_iterate_v1-1.0.0/l98_59/run-20260919T104039Z-652fe48d/`에 보존한다. **회수 개선은 확인했지만 가짜 채택 증가로 oot 기본값 승격·최종 채택은 보류한다.** 잡음을 생략한 단일 별 옵션 실험이므로 잡음 오탐·일반화 검증으로 쓰지 않는다. 다음은 남은 1 d·8 h의 재적합 창/주기 오차와 g102 잔여 후보의 특성을 별도로 진단한다. 이번 결과만을 맞추기 위해 문턱이나 AND/OR 판정을 바꾸지 않는다. 110 확정 설정 반영·다른 별 검증·팀 승인은 남아 있다.

## 6. 한계·후속

- 중복·고조파 규칙은 임시다. 겹침 쌍(P₂ = 2P₁)처럼 **실제 두 번째 신호가 첫 후보의 정확한 고조파**인 경우 임시 규칙은 그것을 중복으로 버린다. 깊이·통과 부분집합으로 구분하는 정식 규칙은 112 가 정하고, 이 벤치마크는 그 사례를 기록만 한다.
- box 모델의 진입·이탈 근사 잔여는 경계 돌출 지표로 재지만 모델을 바꾸지 않는다(D06 계약 1.0).
- 잡음 seed 1개로 돌린다. 가짜 후보 수는 방향만 본다.
- 문턱 재조정 뒤에는 루프 경로가 바뀌므로 재실행이 필요하다.

## 7. Jira 111 완료 조건과 최종 인계 준비 (2026-09-19)

[Jira 111](https://ssafy.atlassian.net/browse/S15P21C206-111)의 최신 설명을 직접 대조했다. 티켓은 진행 중이며 완료 조건은 아래 세 가지다. 고조파 병합·판 사이 동일성(112), 셋 이상 겹침·격자 v2 스트레스·운영 커널은 제외 범위다. 회수 100%나 1 d·8 h 실패 0은 티켓의 필수 통과 기준이 아니다. 기존 옵션 실험의 기대값과 완료 조건을 구분한다.

| 완료 조건 | 현재 증거 | 남은 일 |
|---|---|---|
| 다중 쌍 3개·단일·실패 사례의 종료 사유와 power/경계/훼손/중첩 QA 기록 | 5.1~5.5.4 결과와 원시 manifest/CSV | 같은 최종 후보 프로파일로 전체 검증 세트 재실행·합계 기록 |
| 실패 후보 미채택·직전 정상 후보 집합 복구 재현 | 실제 실패 단계의 채택 수 대조, 0단계 실패 테스트, 새 1단계 실패의 후보·잔차 배열 완전 일치 테스트 | 최종 실패 fixture 결과도 같은 코드/설정으로 기록 |
| D04 확정값 재실행·설정 버전·한계 리뷰 승인·D14-2 인계 | QA 설정 해시와 버전 기록 구현, 본 절 인계 초안 | **110 설정 채택 승인 대기**, 승인값 반영 후 재실행, 111 리뷰 승인, 122에 인계 |

### 7.1 최종 검증에 올릴 보수적 후보 (미승인)

oot는 단일 회수 +6과 가짜 +1이 함께 발생해 최종 후보로 승격하지 않는다. `7cc8dcb2`의 unity·깊이 상대 0.1·duration 최대 12 h·실패 즉시 종료 조합을 **리뷰용 후보**로 유지한다. 기본 CLI 값 전체를 승격하는 결정이 아니다. 이 후보의 L 98-59 단일 회수 65/108·가짜 1·QA 실패 18은 알려진 한계이고 다른 별 재실행 결과는 7.6절에 기록한다. 리뷰어가 이 손실/잔여 수준을 수용하지 않으면 완료하지 않고 수정·재검증한다.

| 구분 | 후보값 |
|---|---|
| 전처리 / D04 탐색 | biweight_1.0d / poc_linear20k, SNR≥7 AND SDE≥6 (110 승인 전에는 잠정) |
| 반복 전용 추가 조건 | 관측 통과 ≥2, 최소 점 100, 최대 후보 5. **통과 ≥2는 110 holdout의 게이트 조건이 아니며 111에서 별도 승인받을 안전 조건** |
| 재적합 | 주기 ±탐색 격자 2칸, 201점, duration 0.5~2배/최대 탐색 범위 12 h, D/P≤0.35 |
| QA | power 비≤0.5, edge≤1.5, other log2≤1, overlap≤3, unity z≤5 또는 깊이 상대 절댓값≤0.1 |
| 실패·중복 | 측정 불가 실패, QA 실패 즉시 중단·직전 잔차 보존, 임시 배수 {0.5,1,2}; 계속 마스킹은 미채택 |
| 설정 식별 | `bls_iterate_qa_v1/49ccec22320d` |
| 전체 설정 SHA-256 | `49ccec22320d283d4bf015f98acadab6ff4d2b6cfb27d1fbd3ae66ebf05ece4f` |

설정 해시는 `IterateConfig.params()`의 정렬된 canonical JSON에서 생성하며 계산 코드 버전은 별도로 manifest의 commit으로 식별한다. 새 manifest는 주입 격자 ID와 references.csv·checksums.json 해시도 기록한다. 과거 manifest에는 이 추가 필드가 없으며 원본을 고치지 않는다.

### 7.2 남은 두 현상의 범위와 처리

- 남은 g024·g027·g030·g033은 주입 격자 순서상 모두 start 위상이다. 재적합 D=6.72 h, P≈0.999311/0.999373 d로 정답 1 d보다 짧다. 187.893 d 기준선에서 단순 주기 드리프트 환산은 약 3.11/2.83 h다(관측된 transit 수 기반 매칭 오차와 다른 진단량). **지속시간만 강제로 8 h로 늘려 해결했다고 판단하지 않는다.** 재적합/전처리 영향의 정확한 원인은 미확정이며 현재 QA가 이 제거를 거절한 결과를 보존한다.
- g102의 새 0.605877 d 후보는 단순 P/2·2P 관계로 설명되지 않는다. 112로 해결 책임을 자동 이관하지 않는다. oot 미채택의 직접 근거로 유지하고, 향후 oot 채택을 재검토한다면 잔차 기원과 약한 피크의 QA 통계부터 별도 검증한다.
- g069의 약 4P 잔여와 겹침 쌍의 임시 고조파 규칙 한계는 112 검토 사례로 전달하되, 이번 반복 실험의 가짜·회수 수치에서 빼지 않는다.

### 7.3 검증 보강과 실행 전 준비

- 새 합성 테스트는 두 번째 모델이 잘못되면 첫 번째 정상 후보와 그 모델만 제거한 잔차 배열이 원소별 동일하게 보존됨을 확인한다. 원본 입력 배열도 보존한다.
- 피크가 없는 경우 `no_quality_peak`, 있는 피크가 모두 중복인 경우 `duplicate_or_harmonic_only`를 구분한다. 기존 구현은 빈 피크 목록도 중복 종료로 기록할 수 있어 정정했다.
- 원본 재평가 실패는 `candidate_validation_failed`와 후보의 검증 실패 플래그로 보존한다. 벤치마크의 accepted 목록은 QA 채택 기록이므로 운영 후보표에서는 validated_on_original=false를 제외해야 한다(122 인계).
- 종료 7종은 합성 테스트로 확인하며 실제 fixture에서 발생하지 않은 종료 사유를 실측으로 표현하지 않는다.
- 콘솔 QA 요약에 최소와 절댓값 최대를 추가해 음수 방향 큰 실패가 가려지지 않도록 했다. QA 판정은 바꾸지 않는다.
- 회귀 100 passed, 2 skipped(당시 TOI-270 입력 부재). 입력 준비 후 생략된 파일 생성·보존 통합 테스트 2개도 별도 실행해 통과했다(합계 102 passed). 공식 MAST에서 평가 4별+TOI-270의 누락 12 FITS를 받아 고정 SHA-256·TIC·Sector를 확인했다. L 98-59 포함 6별 15 FITS 입력 준비 완료다. checksum registry·Archive 참고값은 변경하지 않았다. 새 입력으로 실제 벤치마크는 실행하지 않았다.

### 7.4 110 승인 후 사용자 실행 절차

1. 110의 승인된 설정·승인 링크를 확인하고 사용자가 해당 변경을 111 브랜치에 반영한다. Git 명령은 사용자가 실행한다. 과거 결과를 승인 후 실행으로 소급해서 부르지 않는다.
2. 병합 뒤 회귀·설정 지문·전처리·110 게이트와 111 추가 조건을 재대조한다. 위 후보값이 바뀌면 새 지문을 먼저 기록한다.
3. 코드를 커밋하고 작업 트리가 깨끗한 상태에서 아래 검증을 사용자 실행한다. 대상은 기존 fixture이며 110 holdout 4별을 반복 튜닝에 쓰지 않는다. 기존 5별은 이미 본 별이므로 새로운 독립 평가라고 주장하지 않는다.
4. 아래 명령은 **110 승인과 병합 뒤 설정 재대조가 끝난 후** 사용한다(tess-bench 디렉터리, PowerShell). 정상 종료 코드 여부는 과학적 통과 판정이 아니다.

```powershell
$reviewArgs = @('--stage', 'evaluation', '--setting', 'poc_linear20k', '--window-offset-reference', 'unity', '--window-offset-rel-depth', '0.1', '--refine-duration-max-hours', '12', '--snr-min', '7', '--sde-min', '6', '--min-transits', '2', '--max-candidates', '5')
foreach ($target in @('l98_59', 'cm_dra', 'wasp18', 'toi700', 'hd21749')) {
    uv run --locked python -m tess_bench iterate --target $target @reviewArgs --noise-seeds 20260910
    if ($LASTEXITCODE -ne 0) { throw "iterate failed: $target" }
}
foreach ($target in @('wasp18', 'toi700')) {
    uv run --locked python -m tess_bench iterate --target $target @reviewArgs --include-raw-real --groups none --no-noise
    if ($LASTEXITCODE -ne 0) { throw "real fixture failed: $target" }
}
uv run --locked python -m tess_bench iterate --target toi270 --stage tuning --setting poc_linear20k --groups pairs --no-noise --tamper-depth-factor 3 --window-offset-reference unity --window-offset-rel-depth 0.1 --refine-duration-max-hours 12 --snr-min 7 --sde-min 6 --min-transits 2 --max-candidates 5
if ($LASTEXITCODE -ne 0) { throw 'tamper fixture failed' }
```

5. 5별 정상 실행은 1,120곡선(별당 224), 실제 곡선 검증은 4곡선(realclean/real ×2별), tamper는 쌍 3곡선이 있어야 한다. 각 manifest의 동일 커밋·기준 설정 지문·stage·격자·seed·입력/출력 checksum을 확인한다.
6. 별/곡선 종류별 direct·alias 회수와 분모, 가짜 후보, 종료 사유, QA 분포·측정 불가·복수 실패, 원본 재검증 실패와 wall time을 기록한다. 기존 결과와 비교하되 새로운 임의 허용 숫자를 결과를 보고 만들지 않는다.
7. tamper 세 사례에서 0단계 QA 실패·미채택을 확인한다. 정상 실행의 QA 실패 단계는 이전 후보 집합 보존과 대조한다. 실제 잔차 배열 검증은 합성 검증과 구분한다.
8. 같은 결과를 근거로 QA·종료·추가 통과 조건의 채택 여부를 리뷰 요청한다. 승인 기록과 D14-2(122) 인계 항목(설정 지문, 종료 7종, QA 식, 복구, 원본 재평가 필터, 112 한계)이 갖춰진 뒤 111 완료 조건을 체크한다. MR 병합·Jira 완료 전환을 자동 실행하지 않는다.

2026-09-19 준비 시점에는 110 승인 대기였으며, 이후 실행 준비 상태는 아래에 기록한다. 최종 실측·111 채택 승인은 별도 완료 조건이다.

### 7.5 110 병합 후 실행 준비 확인 (2026-09-20)

- 담당자 윤성용은 대화에서 110의 병합 승인을 20k·게이트 채택과 D03→D04 검증 책임 이관까지 포함하는 것으로 판단하고 Jira 110을 직접 완료 처리했다고 알렸다. 근거 MR은 [!77](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/77)이다. 이는 담당자 확인 기록이며 리뷰어의 별도 승인 문구를 새로 인용한 것은 아니다.
- 당시 충돌 없이 병합됐다는 사용자 보고를 기준으로 준비했으나, 이후 README 2개의 미해결 충돌을 확인했다. 두 문서의 양쪽 내용을 보존해 해결한 뒤 사용자가 병합 커밋 `2084018`을 완료했다. 반영된 설정은 `biweight_1.0d`, `poc_linear20k`(20,000점, 0.5일~기준선/3, duration 1.2·1.92·2.88·4.8 h)이며 111의 통과 횟수≥2는 7.1절대로 추가 안전 조건이다.
- CLI와 같은 인수 타입으로 구성한 7.1절 후보 지문은 `49ccec22320d283d4bf015f98acadab6ff4d2b6cfb27d1fbd3ae66ebf05ece4f`로 유지됐다. 6별 입력 파일 존재를 확인했다. 최종 실행 manifest에서 입력 checksum도 확인해야 한다.
- 병합 후 holdout manifest 테스트 4건은 과거 평가 코드 전체를 고정한 잠금 파일과 현재 코드가 달라 실패했다. 과거 `holdout_lock_v1.json`은 변경하지 않고, 계산을 모의 처리하는 manifest 테스트만 임시 잠금 파일로 격리했다. 실제 잠금 검증과 불일치 시 계산 전 중단 테스트는 유지한다. holdout 재평가는 실행하지 않는다.
- 검증: tess-bench `uv run --locked python -m pytest -q` 87 passed, astro-kernel 같은 명령 93 passed. 이번 변경은 테스트·문서에 한정하며 실험 계산·QA 문턱·설정·과거 산출물은 변경하지 않았다.
- 다음 단계: 변경을 커밋한 깨끗한 작업 트리에서 7.4절의 8개 실행을 사용자가 수행한다. 예상 곡선 수는 1,120+4+3=1,127이다. 아직 최종 실측 결과나 111 채택 승인·완료를 주장하지 않는다.

### 7.6 깨끗한 커밋에서 8개 재실행 확인 (2026-09-21 기록)

사용자가 2026-09-20 UTC에 실행한 8개 manifest 모두 코드 `2084018341e14fa249bfb1fd21feb9a2147f9e45`, `git_dirty=false`를 기록한다. 총 1,127곡선이며 입력·출력의 실제 SHA-256을 manifest와 대조해 불일치 0건을 확인했다. 아래 시간은 manifest의 total이며 콘솔 종료 출력과 소폭 다르다.

| 대상·실행 | manifest 파일명 (`results/manifests/`) | 곡선 | 초 |
|---|---|---:|---:|
| L 98-59 | iterate-l98_59-9db3fc85.json | 224 | 1771.7 |
| CM Dra | iterate-cm_dra-711105d5.json | 224 | 311.6 |
| WASP-18 | iterate-wasp18-eacf2d8b.json | 224 | 797.5 |
| TOI-700 | iterate-toi700-f2c57bc3.json | 224 | 1825.9 |
| HD 21749 | iterate-hd21749-27be47c4.json | 224 | 689.3 |
| WASP-18 원본 포함 | iterate-wasp18-7bb6cb1a.json | 2 | 7.3 |
| TOI-700 원본 포함 | iterate-toi700-0ae3279b.json | 2 | 16.0 |
| TOI-270 tamper ×3 | iterate-toi270-ad94eb5d.json | 3 | 12.0 |

각 정상 실행은 realclean 112곡선과 noise20260910 112곡선이다. 아래 회수는 단일·쌍 신호를 합산한 direct+alias이며 직접 회수율 또는 110 holdout 판정값이 아니다. 분모는 각 114개 주입 신호이며 QA 실패는 none을 포함한 112곡선 중 건수다.

| 대상 | realclean 회수 / 가짜 / QA 실패 | noise 회수 / 가짜 / QA 실패 |
|---|---|---|
| L 98-59 | 71/114 / 1 / 18 | 79/114 / 2 / 27 |
| CM Dra | 0/114 / 0 / 112 | 45/114 / 5 / 13 |
| WASP-18 | 49/114 / 1 / 96 | 68/114 / 3 / 25 |
| TOI-700 | 67/114 / 0 / 19 | 83/114 / 1 / 27 |
| HD 21749 | 36/114 / 0 / 8 | 66/114 / 2 / 27 |

- 병합 미완료 상태의 직전 실행 `621f7cf8 / 85e5bfaf / a11236cd / 6ea10349 / 92d0349b / 11bfefd1 / 70963f99 / a9623e48`은 `git_dirty=true`이므로 최종 코드 식별 근거로 쓰지 않는다. 새 결과와 기존 결과의 iterations·steps 및 존재하는 matches CSV를 행 순서와 실행 시간 열을 제외해 대조했으며 값 차이가 없었다. 원본 포함 none 실행 2개에는 주입 정답이 없어 matches 출력이 없다. 과거 manifest는 수정하지 않았다.
- 전체 QA 실패 377곡선에서 steps의 accepted 건수가 iterations의 n_accepted와 같고, 실패 단계 이후 채택이 없음을 확인했다. 이는 저장 기록의 일관성 검증이며 잔차 배열 자체의 복구 검증은 7.3절 합성 테스트 근거와 구분한다.
- tamper 3곡선은 모두 첫 단계(step=0) window_offset 실패·채택 0이다. 원본 포함 실행의 real에 표시된 가짜 1은 주입 정답이 없는 상태의 집계이므로 실제 행성 오탐으로 해석하지 않는다.
- 기존 CM Dra·WASP-18 한계와 L 98-59 단일 65/108·가짜 1은 재현됐다. 실행 정상 종료나 checksum 일치를 과학적 성능 통과 또는 운영 채택 승인으로 해석하지 않는다. 상세 집계와 122 인계는 아래에 완료했으며 QA 조건·알려진 한계 수용에 대한 리뷰가 남아 있다.

#### 7.6.1 곡선 종류별 회수와 종료 상세

| 실행 / baseline / 종류 | 주입 신호 | direct | alias | 미회수 | 가짜 후보 | 종료 사유(곡선 수) |
|---|---:|---:|---:|---:|---:|---|
| 9db3fc85 / l98_59-noise20260910 / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-noise20260910 / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-noise20260910 / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-noise20260910 / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | removal_qa_failed=1 |
| 9db3fc85 / l98_59-noise20260910 / single | 108 | 71 | 2 | 35 | 2 | no_quality_peak=82, removal_qa_failed=26 |
| 9db3fc85 / l98_59-realclean / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-realclean / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-realclean / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-realclean / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| 9db3fc85 / l98_59-realclean / single | 108 | 63 | 2 | 43 | 1 | no_quality_peak=90, removal_qa_failed=18 |
| 711105d5 / cm_dra-noise20260910 / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| 711105d5 / cm_dra-noise20260910 / pair:overlapping_transits | 2 | 1 | 1 | 0 | 1 | no_quality_peak=1 |
| 711105d5 / cm_dra-noise20260910 / pair:similar_strength | 2 | 1 | 0 | 1 | 0 | no_quality_peak=1 |
| 711105d5 / cm_dra-noise20260910 / pair:strong_weak | 2 | 1 | 0 | 1 | 0 | no_quality_peak=1 |
| 711105d5 / cm_dra-noise20260910 / single | 108 | 41 | 0 | 67 | 4 | no_quality_peak=95, removal_qa_failed=13 |
| 711105d5 / cm_dra-realclean / none | 0 | 0 | 0 | 0 | 0 | removal_qa_failed=1 |
| 711105d5 / cm_dra-realclean / pair:overlapping_transits | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |
| 711105d5 / cm_dra-realclean / pair:similar_strength | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |
| 711105d5 / cm_dra-realclean / pair:strong_weak | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |
| 711105d5 / cm_dra-realclean / single | 108 | 0 | 0 | 108 | 0 | removal_qa_failed=108 |
| eacf2d8b / wasp18-noise20260910 / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| eacf2d8b / wasp18-noise20260910 / pair:overlapping_transits | 2 | 1 | 1 | 0 | 1 | no_quality_peak=1 |
| eacf2d8b / wasp18-noise20260910 / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| eacf2d8b / wasp18-noise20260910 / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| eacf2d8b / wasp18-noise20260910 / single | 108 | 60 | 2 | 46 | 2 | no_quality_peak=83, removal_qa_failed=25 |
| eacf2d8b / wasp18-realclean / none | 0 | 0 | 0 | 0 | 0 | removal_qa_failed=1 |
| eacf2d8b / wasp18-realclean / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | removal_qa_failed=1 |
| eacf2d8b / wasp18-realclean / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | removal_qa_failed=1 |
| eacf2d8b / wasp18-realclean / pair:strong_weak | 2 | 1 | 0 | 1 | 0 | removal_qa_failed=1 |
| eacf2d8b / wasp18-realclean / single | 108 | 44 | 0 | 64 | 1 | no_quality_peak=16, removal_qa_failed=92 |
| f2c57bc3 / toi700-noise20260910 / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| f2c57bc3 / toi700-noise20260910 / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | removal_qa_failed=1 |
| f2c57bc3 / toi700-noise20260910 / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| f2c57bc3 / toi700-noise20260910 / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | removal_qa_failed=1 |
| f2c57bc3 / toi700-noise20260910 / single | 108 | 77 | 0 | 31 | 1 | no_quality_peak=83, removal_qa_failed=25 |
| f2c57bc3 / toi700-realclean / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| f2c57bc3 / toi700-realclean / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | removal_qa_failed=1 |
| f2c57bc3 / toi700-realclean / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| f2c57bc3 / toi700-realclean / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| f2c57bc3 / toi700-realclean / single | 108 | 61 | 0 | 47 | 0 | no_quality_peak=90, removal_qa_failed=18 |
| 27be47c4 / hd21749-noise20260910 / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-noise20260910 / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | removal_qa_failed=1 |
| 27be47c4 / hd21749-noise20260910 / pair:similar_strength | 2 | 2 | 0 | 0 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-noise20260910 / pair:strong_weak | 2 | 2 | 0 | 0 | 0 | removal_qa_failed=1 |
| 27be47c4 / hd21749-noise20260910 / single | 108 | 60 | 0 | 48 | 2 | no_quality_peak=83, removal_qa_failed=25 |
| 27be47c4 / hd21749-realclean / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-realclean / pair:overlapping_transits | 2 | 1 | 1 | 0 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-realclean / pair:similar_strength | 2 | 1 | 0 | 1 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-realclean / pair:strong_weak | 2 | 1 | 0 | 1 | 0 | no_quality_peak=1 |
| 27be47c4 / hd21749-realclean / single | 108 | 32 | 0 | 76 | 0 | no_quality_peak=100, removal_qa_failed=8 |
| 7bb6cb1a / wasp18-real / none | 0 | 0 | 0 | 0 | 1 | removal_qa_failed=1 |
| 7bb6cb1a / wasp18-realclean / none | 0 | 0 | 0 | 0 | 0 | removal_qa_failed=1 |
| 0ae3279b / toi700-real / none | 0 | 0 | 0 | 0 | 1 | no_quality_peak=1 |
| 0ae3279b / toi700-realclean / none | 0 | 0 | 0 | 0 | 0 | no_quality_peak=1 |
| ad94eb5d / toi270-realclean / pair:overlapping_transits | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |
| ad94eb5d / toi270-realclean / pair:similar_strength | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |
| ad94eb5d / toi270-realclean / pair:strong_weak | 2 | 0 | 0 | 2 | 0 | removal_qa_failed=1 |

#### 7.6.2 QA 분포와 실패 범위

분포는 8개 실행의 accepted·qa_failed 단계 전체를 합산한다. NaN·비유한 지표는 분포에서 제외하며 미산출 수를 별도로 기록한다. other/overlap의 미산출은 비교 대상 부재도 포함하므로 그 자체를 QA 측정 실패로 세지 않는다.

| 지표 | 유한 n | 미산출 n | 최소 | 중앙값 | 최대 | 절댓값 최대 |
|---|---:|---:|---:|---:|---:|---:|
| power_ratio | 949 | 0 | 3.3770886E-05 | 0.048995634 | 1.1446085 | 1.1446085 |
| edge_excess | 949 | 0 | 0.37479214 | 0.69468409 | 53.926128 | 53.926128 |
| window_offset_z | 949 | 0 | -146.01147 | 0.37482917 | 256.42515 | 256.42515 |
| window_offset_rel | 949 | 0 | -0.12317057 | 0.010131479 | 1.1792167 | 1.1792167 |
| other_depth_log2_max | 256 | 693 | 0.0043875291 | 0.24905703 | 4.5231428 | 4.5231428 |
| overlap_fraction | 949 | 0 | 0 | 0 | 1 | 1 |
| overlap_dev | 231 | 718 | 0.50971887 | 1.1008634 | 79.568044 | 79.568044 |

실패 항목(한 단계 복수 집계): edge_excess=137, other_candidate_damaged=42, overlap_distortion=77, power_not_reduced=145, window_offset=116.
복수 항목 실패 단계: 107개. 원본 재검증 실패 후보: 0개.

### 7.7 122 인계와 리뷰 결정 범위

| 인계 항목 | 전달할 규칙·근거 | 책임·남은 결정 |
|---|---|---|
| 설정 | 7.1절 전체 설정 SHA-256과 2084018 실행 코드, 110 설정과 반복 전용 추가 조건 구분 | 111 리뷰어가 QA 문턱·통과 횟수≥2·최대 5개 및 실측 한계를 수용한 뒤 122 운영 구현에 반영 |
| 제거·복구 | QA 성공 때만 후보와 잔차를 채택. 실패 즉시 종료하고 이전 정상 후보·잔차 유지 | 122에서 합성 배열 보존 테스트와 같은 계약 유지. CSV 일치만으로 배열 복구 증명이라고 쓰지 않음 |
| QA | 7.1절 식과 7.6.2절 분포. qa_not_measurable·non_finite 실패는 이번 실측에서 각각 0건 | 측정 불가를 0 또는 통과로 바꾸지 않음. 비교할 다른 후보·겹침이 없는 경우의 미산출과 구분 |
| 종료 7종 | no_quality_peak, insufficient_observations, duplicate_or_harmonic_only, removal_qa_failed, candidate_validation_failed, numerical_failure, max_iterations_reached | 122에서 종료 사유 보존. 이번 실측은 no_quality_peak·removal_qa_failed 두 종류이고 나머지는 합성 테스트 근거 |
| 원본 재평가 | validated_on_original=false 후보는 운영 후보표에서 제외 | 122 필수 필터. 이번 n_validation_failed=0이므로 실패 경로는 합성 검증과 구분 |
| 고조파·EB | 임시 배수 {0.5,1,2}; CM Dra 실측 회수 0/114와 잔여 별칭 한계 유지 | 112 정식 고조파 규칙과 EB 처리 연계는 후속 범위. 해당 후속 구현 완료를 111 결과 기록의 선행조건으로 두지 않음 |
| 채택 상태 | unity·상대 0.1·duration 최대 12 h 조합의 리뷰 후보. oot·실패 후 계속 마스킹 미채택 | 결과를 본 뒤 문턱 재조정하지 않았다. 리뷰 수용 전 운영 기본값 승격·111 완료를 선언하지 않음 |

완료 요청 범위는 반복 제거 루프의 종료·QA·복구 검증과 알려진 한계를 명시한 인계다. 모든 별의 신호 회수 성공 또는 독립 holdout 성능 보증이 아니다. 122 구현 완료를 기다리는 대신 이 인계의 수용 여부를 리뷰받는다.

리뷰 첨부: `experiments/tess-bench/results/review-111-2084018.zip` (8개 manifest와 출력 CSV, 상대 경로별 checksums.json; FITS 제외). ZIP SHA-256: `149025f37ac0b541a289e9d2b91e4d32b24ca3908bfb385c4ee399be2f82f9db`. 생성물은 Git에 추가하지 않고 MR에 첨부한다. 압축 해제 후 각 ID 폴더의 CSV를 사용하며 원본 manifest의 절대 경로는 실행 당시 기록으로 보존한다.

### 7.8 MR !117 QA 결함 수정과 재실행 요구 (2026-09-21)

리뷰 대상 4586191 이후 develop 508578b를 통합하면서 데이터 색인의 BLS holdout 근거·반복 제거·비닝 벤치마크 세 행을 보존했다.

- `overlap_metrics`는 산포가 비유한 또는 0 이하일 때 `(frac, NaN)`을 반환한다. 조건식 우선순위로 두 번째 반환값에 튜플이 들어가던 오류를 수정했다. 평탄 잔차와 실제 겹침 구간을 가진 입력에서 반환 타입과 루프의 정상 종료를 회귀 검증했다.
- 다른 후보가 없는 경우 깊이 지표 미산출을 허용한다. 비교 대상이 있으면 제거 전·후 깊이 중 하나라도 유한한 양수가 아니거나 측정 개수가 다르면 `other_depth_not_measurable`로 실패시킨다. 다른 유효 비교가 함께 있어도 해당 실패를 숨기지 않는다. 이는 qa_require_measurable 옵션과 무관하게 적용하는 후보 보호 조건이다.
- 제거 전·후 각각 NaN·0·음수인 6개 회귀 사례에서 두 번째 후보 거절, 이전 정상 후보 보존과 잔차 배열 원소별 일치를 확인했다. 비교 대상이 없는 첫 단계는 채택된다.
- 검증: 최신 통합 작업 파일에서 tess-bench 108 passed, astro-kernel 93 passed. Git은 사용자 실행이며 최종 diff 검사는 커밋 후 수행한다.
- **7.6절의 2084018 실행·CSV·ZIP은 수정 전 역사적 결과다. 새 QA 코드 검증 근거로 재사용하지 않는다.** QA 숫자 설정이 같아도 실패 처리 동작이 바뀌었으므로 새 코드 commit을 별도로 고정하고 7.4절 8개 실행 전체를 재실행한다. 기존 파일은 보존한다.
- 새 manifest는 동일한 수정 후 commit과 git_dirty=false, 입력·출력 checksum, 1,127곡선 집계·실패 후 미채택·이전 후보 보존을 확인한다. 새 run으로 리뷰 ZIP을 생성한 후 그 SHA-256과 결과를 MR에 갱신한다. 현재 수정 후 실측은 아직 실행하지 않았다.

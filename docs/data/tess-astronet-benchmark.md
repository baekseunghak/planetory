# AstroNet 단일 checkpoint 성능 평가

Jira `S15P21C206-118` / 담당 윤성용 / 상태: calibration·고정 evaluation 실측 완료, 팀의 운영 채택 보류 결정 확정(2026-09-21, 6절).
입력 정본은 [평가 세트](tess-astronet-eval-set.md), 실행 절차는 [실험 README](../../experiments/astronet-eval/README.md#118-조정용-추론),
임계값 결정 절차는 [파이프라인 AI 검증 계획](tess-pipeline/external-sources-and-ai.md#검증임계값-결정-계획)을 따른다.
운영 정본이나 배포 승인 문서가 아니다.

## 1. 실행과 재현성

2026-09-19 사용자가 집 PC에서 실행했다. 도구는 고정 AstroNet-Triage commit
`5675a57dd41dd0321df480453451096dc5a4a6b0`의 `model_1/model.ckpt-14000`을 CPU에서 사용한다.
같은 TIC의 후보를 평균 내지 않고 candidate_id별 점수를 보존한다. checkpoint의 양성은 PC/EB이고 음성은 junk다.
점수는 행성 확률이 아니며 PC와 EB를 구분하지 않는다.

| 항목 | 기록 |
| --- | --- |
| 입력 버전 | `astronet_eval_set_v1` 1.0.0, 전처리 `biweight_1.0d`, global/local 201/61 |
| 세트·변환 run | build-set `42c0d6d6`, convert `4b5a3d6d`, 55/55 변환 성공 |
| 조정 run | `calibration-20260919T130911Z-bb71f278` |
| 환경 | Docker digest·Python 3.6.9·TensorFlow 1.15.5·NumPy 1.18.5, CPU, intra/inter-op 각 2 threads |
| 조정 처리 | 20/20 성공: PC 8, EB 0, junk 9, 정답 제외 미확인 3. 실패 0 |
| wall time | 2.62623881초. 컨테이너 내부 검증·모델 준비·추론·CSV 저장 포함, Docker 기동 제외 |
| predictions.csv SHA-256 | `bf3d9ba24a2b490be96140de9fac89adfdf96a1069f48ce7222bbf7b4a339bfd` |
| manifest.json SHA-256 | `99a2c5203fc9cec69bf588baf6da3ff760cd9a14bf23bc4b1f62943a4eba06c1` |

CSV와 manifest는 `experiments/astronet-eval/results/predictions/calibration-20260919T130911Z-bb71f278/run/`에 있다.
원본 결과·공식 모델은 Git에 추가하지 않는다. MR 검토 때 원시 결과가 필요하면 이 checksum과 일치하는 파일을 첨부한다.
검증 시 predictions checksum 일치와 manifest의 처리 수·split을 확인했다.

## 2. 조정 결과

정답 17개(PC 8·junk 9)에 대한 **조정 성능**이며, 독립 평가 성능이 아니다.
정밀도는 TP/(TP+FP), 재현율은 TP/(TP+FN)이다. `score >= threshold`를 양성으로 집계한다.
여기서 FP는 잡음의 양성 통과, FN은 PC/EB 누락이며 서비스의 외부 FP 라벨과 다르다.

| 진단용 기준 | TP / PC 전체 | FN | FP / junk 전체 | 정밀도 | 재현율 |
| --- | --- | --- | --- | --- | --- |
| 공식 예제 참고값 0.4 | 4/8 | 4 | 0/9 | 4/4 (100%) | 4/8 (50%) |
| 조정 분포 간격 중간값 0.00349776993971318 | 7/8 | 1 | 0/9 | 7/7 (100%) | 7/8 (87.5%) |
| 최소 PC 점수 0.00006791892519686371 | 8/8 | 0 | 9/9 | 8/17 (47.06%) | 8/8 (100%) |

중간값은 최대 junk 점수 0.0033538946881890297와 그보다 큰 최소 PC 점수 0.0036416451912373304의 평균이다.
데이터를 본 뒤 산출한 진단값이며 최적 운영 기준이나 승인된 상한을 뜻하지 않는다.
TOI-700 e의 점수 0.00006791892519686371은 junk 9개 모두보다 낮다. 따라서 이 조정 세트에서도
단일 점수 경계로 모든 PC를 회수하면서 junk를 하나라도 제외하는 것은 불가능하다.

전체 순위 지표는 Average Precision(AP) **0.9338235294**, 사다리꼴 PR-AUC **0.9317555147**이다.
동점은 한 그룹으로 묶는다. AP는 recall 증가량 × 해당 precision의 합이고,
사다리꼴 PR-AUC는 시작점 (recall=0, precision=1)을 포함한 PR 점 사이의 사다리꼴 면적 합이다. 두 지표를 혼용하지 않는다.
점수 없는 실패는 순위·분류 지표에서 제외하고 성공률·실패 사유로 별도 집계한다. 이번에는 실패가 없다.

| 분류 | 점수 범위 | 해석 |
| --- | --- | --- |
| PC 8 | 0.0000679189 ~ 0.9937963486 | 낮은 점수의 실제 행성 존재 |
| EB 0 | 해당 없음 | 조정 세트에서 EB 성능 판단 불가 |
| junk 9 | 0.0002058278 ~ 0.0033538947 | 백색 합성 잡음에 한정 |
| 미확인 잔차 3 | 0.0068080574, 0.7428018451, 0.0515284874 | 정답이 없어 TP/FP 판단에서 제외 |

저장 결과의 재집계 명령(실험 재실행 없음):

```powershell
cd experiments/astronet-eval
uv run --locked python -m astronet_eval.metrics --run-dir results/predictions/calibration-20260919T130911Z-bb71f278/run --threshold 0.4 --threshold 0.00349776993971318 --threshold 0.00006791892519686371
```

## 3. 임계값과 후속 판단

2026-09-19 사용자 확인: 팀의 오탐·누락 허용 기준은 아직 합의되지 않았다.
서비스 하한·상한, threshold_version, 모델 채택은 **미확정**이다. 위 진단값을 서비스 판정으로 승격하지 않는다.
높은 점수도 행성 확정을 뜻하지 않으며 낮은 점수만으로 후보를 삭제하지 않는다.

팀은 누락을 얼마나 허용할지, 추가 검토로 넘길 잡음량을 얼마나 허용할지, 중간 검토 구간의 처리 방식을 정한다.
그 기준에 따라 calibration으로 하한·상한을 선택하고 고정한 뒤 evaluation 35개(정답 PC 10·EB 1·junk 18, 미확인 6)를 검증한다.
이 문단은 조정 완료 시점의 판단이다. 이후 사용자 위임 실험안과 독립 평가 결과는 4·5절에 기록한다.

표본은 3개 TIC뿐이고 calibration EB가 없으며 junk는 합성 백색 잡음이다. 학습 TIC 중복은 unknown이고
QLP 학습 전처리와 SPOC 입력 전처리의 동등성은 미검증이다. 작은 조정 표본의 100% 정밀도를 서비스 성능으로 일반화하지 않는다.
[라이선스 조사](tess-ai-model-feasibility.md#6-라이선스-확인-결과)의 GPL·checkpoint 적용 범위 검토도 남아 있다.
이 결과만으로 118 완료·운영 채택을 선언하지 않는다.

## 4. 사용자 위임에 따른 고정 실험안

3절 기록 이후 사용자가 팀 명세를 확인하고 정해진 수치가 없으면 실험 수치를 선택해 평가를 진행하도록 위임했다.
요구사항 AI-04는 라벨 데이터로 검증한 하한·상한을 요구하고 DEC-04는 자체 점수 분포 실측 후 결정하도록 한다.
AT-41은 하한 < 상한을 요구한다. 이 문서들에는 수치나 허용 FP/FN 비용이 없다.
운영 정본을 변경하지 않고 다음 가정으로 실험안 `triage_calibration_v1`을 고정한다.

| 항목 | 고정값·의미 |
| --- | --- |
| 목적 우선순위 | 실제 신호의 자동 기각 방지 → 조정 junk의 자동 승인 0 → 그 조건에서 실제 신호 자동 승인 수 최대화 |
| 하한 | 0.0: 유효 점수 [0,1]에서 below 없음, 자동 기각 비활성 |
| 상한 | 0.00349776993971318: 최대 junk와 인접한 위쪽 PC 사이 중간값 |
| 경계 | score < 하한: below, score >= 상한: approved, 그 외 review |
| 조정 정답 결과 | approved PC 7·junk 0, review PC 1·junk 9, below 0 |
| 미확인 3개 | 모두 상한 이상이지만 정답이 없어 오탐으로 판정하지 않음 |
| 비용 가정 | 실제 신호 자동 누락보다 검토 부담을 우선 감수. 팀 합의된 수치 비용은 아님 |
| 상태 | 사용자 위임 실험안, 팀 채택·서비스 적용 미승인 |

보편적 최적값을 주장하지 않는다. 하한을 0으로 둔 것은 조정 최소 PC 점수가 모든 junk보다 낮고 표본도 작아,
자동 기각 기준을 추정할 근거가 부족하기 때문이다. 이 안은 junk를 기각하는 기능이 없으므로 검토 부담이 크다.
상한은 조정 데이터에 맞춘 값이므로 evaluation에서 precision·recall이 떨어질 수 있다.

설정은 [triage_thresholds_v1.json](../../experiments/astronet-eval/configs/triage_thresholds_v1.json)에 기록한다.
입력·모델·조정 CSV hash와 선택 원리를 결합하고 평가 결과에 설정 사본과 SHA-256을 남긴다.
평가 전 설정을 고정하며 evaluation 결과로 v1을 재조정하지 않는다. 성능이 부족하면 이 안의 채택을 보류한다.
평가 전 설정 SHA-256: `a65eca2be4c4cadfd3731b3585018cd1bde8e3d8b2e0cad969482663a187e877`.
이 hash는 평가 실행 때 저장한 `threshold_plan.json` 원본 바이트 기준이다. Windows checkout으로 작업 파일의 줄바꿈이 LF에서 CRLF로 바뀌면 내용이 같아도 파일 hash는 달라진다. 리뷰 보완 시 평가 사본 hash 유지와 작업 파일의 JSON 값 일치를 확인했으며, 과거 실행의 hash를 현재 checkout 파일의 hash로 덮어쓰지 않는다.
이 위임은 실험 진행이며 팀 승인·라이선스 검토나 Jira 완료를 대신하지 않는다.

## 5. 독립 평가 결과

사용자가 2026-09-19 `evaluation-20260919T131808Z-183da766`을 실행했다. 4절 실험안 사본의 hash가
평가 전에 기록한 `a65eca2b…a187e877`과 일치하며, 결과 확인 뒤 임계값을 변경하지 않았다.
calibration 3 TIC와 evaluation 6 TIC는 겹치지 않는다. 모든 55개 candidate_id가 유일하다.
학습 데이터와의 중복 여부는 여전히 unknown이므로 이 독립성은 **조정 세트와의 분리**를 뜻한다.

| 분류 | 추론 성공 / 전체 | approved | review | below |
| --- | --- | --- | --- | --- |
| PC | 10/10 | 9 | 1 | 0 |
| EB | 1/1 | 1 | 0 | 0 |
| junk | 18/18 | 2 | 16 | 0 |
| 미확인 잔차(정답 제외) | 6/6 | 3 | 3 | 0 |
| 전체 | 35/35 | 15 | 20 | 0 |

정답 29개만의 이진 판정(approved 대 나머지)은 TP 10, FP 2, FN 1, TN 16이다.
정밀도 **10/12 = 83.33%**, PC/EB 재현율 **10/11 = 90.91%**, PC만의 통과율 **9/10 = 90%**,
EB 통과 **1/1**, 합성 백색 잡음 junk 오탐률 **2/18 = 11.11%**다. 실제 계통 오차·항성 변동 잡음에 대한 오탐률은 측정하지 않았으며, 이 값을 실제 오탐률의 통계적 하한으로 해석하지 않는다. EB 1건을 일반적 EB 성능으로 해석하지 않는다.
여기서 FN 1은 approved가 아닌 실제 신호이며 **자동 기각이 아니라 review**다.
below가 0인 것은 하한 0 정책의 결과로, 모델이 잡음을 제거했다는 의미가 아니다.

AP **0.9465709729**, 사다리꼴 PR-AUC **0.9448190034**다. 산식은 2절과 같다.
정답의 review 비율은 **17/29 = 58.62%**, 전체 review 비율은 **20/35 = 57.14%**다.
입력 생성은 전체 55/55, 추론은 calibration 20/20·evaluation 35/35로 모두 성공했고 실패 사유는 없다.
조정·평가의 성능을 합쳐 독립 평가 수치로 보고하지 않는다.

| 평가 TIC | PC/EB approved / 전체 | junk approved / 전체 | 주요 관찰 |
| --- | --- | --- | --- |
| 307210830 (L 98-59) | 3/3 | 0/3 | PC 3개 통과 |
| 100100827 (WASP-18) | 1/1 | 0/3 | PC 통과 |
| 257605131 (TOI-451) | 3/3 | 0/3 | PC 최저 점수 0.00528716 |
| 261136679 (π Men) | 1/1 | 2/3 | seed 20260910·20260911의 junk가 각각 0.00915604·0.00752770으로 통과 |
| 279741379 (HD 21749) | 1/2 | 0/3 | GJ 143 b 0.00115098로 review |
| 199574208 (CM Dra) | 1/1 | 0/3 | EB 0.98118502, 행성 판별 성공으로 해석하지 않음 |

미확인 잔차 6개 중 π Men·HD 21749·CM Dra 3개가 통과했다. 정답 라벨이 없으므로 FP 수에 넣지 않는다.
CM Dra 잔차는 43에서 관찰한 부극소 잔존과 함께 검토하며 높은 점수를 행성 증거로 쓰지 않는다.

#### 고정안의 상충관계와 표본 민감도

통과한 합성 junk의 점수 0.0091560418·0.0075276978은 고정 상한의 약 2.62배·2.15배다.
두 점을 모두 상한 아래로 보내려면 상한을 최대 junk 점수보다 크게 해야 하지만,
TOI-451 c의 0.0052871639도 함께 review로 이동해 PC/EB 재현율이 10/11(90.91%)에서 9/11(81.82%)로 줄어든다.
이는 저장된 점수 순서로 설명한 상충관계이며 새 임계값의 제안·재평가·선택이 아니다. 고정 v1은 변경하지 않는다.

분모도 작다. TP 10을 유지하면서 FP만 1개 늘어나는 가정에서는 정밀도가 10/12(83.33%)에서 10/13(76.92%)로 바뀐다.
실제 양성 11개 중 1개가 추가로 review로 이동하는 가정에서는 재현율이 10/11(90.91%)에서 9/11(81.82%)로 바뀐다.
이 예시는 표본 민감도를 설명하며 실제 추가 관측이나 신뢰구간이 아니다.

| 재현성 항목 | 값 |
| --- | --- |
| wall time | 2.483269341초, Docker 기동 제외·모델 준비 포함 |
| CSV SHA-256 | `08db768f2b02943f017790013b455200c449cccd2ebb0d1515e86de786d23a36` |
| manifest SHA-256 | `7ed71c71673cd1917a9351373746f1fb5dd98c070c8beb1aaa374637e4fac00f` |
| 임계값 버전 | `triage_calibration_v1`, lower 0, upper 0.00349776993971318 |
| 모델·환경 | 1절과 같은 checkpoint·자산 hash·Docker digest·CPU 환경 |

산출물 위치는 `experiments/astronet-eval/results/predictions/evaluation-20260919T131808Z-183da766/run/`이다.
입력·모델 자산·조정 CSV·평가 CSV·고정 설정까지 checksum 연결을 검사했다.
집계는 실제 추론을 재실행하지 않으며 다음 명령으로 재현한다. evaluation은 저장된 설정 외의 `--threshold`를 거부한다.

```powershell
cd experiments/astronet-eval
uv run --locked python -m astronet_eval.metrics --run-dir results/predictions/evaluation-20260919T131808Z-183da766/run
```

## 6. 최종 운영 채택 보류 결정과 완료 경계

**현재 AstroNet checkpoint와 임계값의 자동 판정용 운영 채택을 보류하고, 실험 결과만 내부 검토 자료로 보존한다.**
2026-09-21 사용자가 전달한 팀의 최종 답변을 결정 근거로 기록한다. 이전 MR !102의 실측·재현성 검증에
이번 최종 보류 결정을 더해 118을 마무리한다. 사용자 화면이나 자동 승인·기각에는 연결하지 않는다.
내부 검토 자료 보존은 내부 도구 배포나 보조 점수의 서비스 채택 승인을 뜻하지 않는다.
합성 백색 잡음의 자동 통과가 조정 0/9에서 독립 평가 2/18(11.11%)로 발생했고, 전체의 20/35(57.14%)가 검토 구간에 남는다.
이 잡음은 실제 계통 오차를 대표하지 않으므로 실제 서비스 오탐률로 일반화하거나 그 통계적 하한이라고 주장하지 않는다.
자동 기각을 비활성화했으므로 무누락을 모델 성능으로 주장할 수 없다. 서비스 허용 비용이 합의되지 않아
사후에 임의의 통과선을 만들어 성공/실패를 선언하지 않는다. 서비스의 FP/FN 허용 기준 미확정,
소수 TIC·표본과 합성 백색 잡음이라는 평가 범위의 한계를 운영 채택 보류 근거로 남긴다.

라이선스 증거는 고정 commit의 루트 LICENSE(GPL-3.0), 상속 파일의 Apache-2.0 헤더이며,
LICENSE SHA-256은 `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`이다.
코드와 checkpoint의 서비스 사용·재배포 조건은 재채택 전에 다시 검토한다.
이번 결정은 배포·재배포 승인이 아니며 기술적 실행 성공은 해당 조건의 검토를 대신하지 않는다.

118의 결론은 평가 결과와 최종 보류 결정의 보존이다. 이 결정을 문서에 반영한 후속 MR이 병합되면
118을 완료 처리하는 방향으로 팀이 승인했다. 모델 운영 채택·배포 또는 라이선스 검토 완료로 종료하지 않는다.
이 안을 수정할 경우 현재 evaluation 6 TIC는 이미 확인한 데이터이므로 새 버전의 독립 검증에는 새 미사용 세트가 필요하다.
AI-01~04와 후속 `S15P21C206-126`·`S15P21C206-130`은 삭제하지 않고 유지한다.
대안 모델 채택 또는 AI 출시 범위 조정은 별도 결정 사항으로 관리하며, 이번 문서에서 그 결론이나 완료를 대신하지 않는다.
재채택 시에는 서비스 FP/FN 허용 기준, 평가 범위·독립 검증, 코드·checkpoint 사용 조건을 함께 확인한다.

## 7. MR !102 화면·전달 리뷰 인계

백지웅의 `8f1baa83` 리뷰는 지표·카운트의 일관성을 확인하고 6절의 보류 제안에 동의했다.
보조 점수도 사용자 화면보다 **내부 검토 도구에서 먼저 검토**할 것을 권고했다. 다음은 후속 설계 입력이며
현재 UI·API·운영 정본을 변경하거나 팀 전체의 채택 결정을 대신하지 않는다.

| 검토 주제 | 인계할 의견·미확정 사항 |
| --- | --- |
| 점수 의미 | CM Dra EB 0.98118502와 확인 행성 TOI-700 e 0.0000679189가 반례다. 높은 점수를 행성 가능성으로 읽지 않도록 사용자 원점수 노출을 피하자는 권고를 기록한다. `approved`를 행성 확인·행성 후보 판정으로 번역하지 않는다. |
| 외부 확인 상태 | Archive 등 외부 확인 여부와 모델 판정의 출처·표현을 분리한다. 식쌍성도 높은 점수를 받을 수 있음을 명확히 전달한다. 평가용 `in_truth`는 지표 포함 여부이며 사용자 천체 확인 상태로 그대로 매핑하지 않는다. |
| 구간 | 현 실험안은 lower=0으로 below가 비어 있다. 향후 이 안을 표시한다면 실질 2구간임을 고려한다. 일반 3구간 데이터 계약을 이번 MR에서 삭제하지 않는다. |
| review 의미 | 상한 미달로 검토가 필요한 구간이며 실행 실패·처리 대기와 다르다. 검토 담당·절차·사용자 행동이 정해지지 않았으므로 사람 검토가 진행 중이거나 자동으로 시작된다고 표현하지 않는다. |
| 점수 없음 | 실패·입력 부족의 점수 없음과 유효한 낮은 점수를 다른 상태로 표시한다. 내부 reason의 사용자 문구 매핑과 알 수 없는 reason의 기본 문구는 실제 화면 연결 시 합의한다. |
| 판정 추적 | 후보별 threshold_version·모델/checkpoint·판정 시각을 함께 식별할 수 있어야 한다. 현재 실험 CSV는 run manifest와 함께 읽으며, 행 단위 제공 계약은 후속 API/배치 연결에서 검토한다. |

원점수 비노출·구간 문구·실패 표현은 리뷰 권고이며 확정 UI 요구사항이 아니다. 내부 검토 도구 또한 이번 MR에서 구현하지 않는다.
이 절은 당시 화면 리뷰 의견을 보존한다. 현재 모델의 운영 미연결과 118 완료 경계는 6절의 최종 결정을 따른다.

## 8. MR !102 재현성 보완과 리뷰 첨부

2026-09-20: `load_thresholds()`가 calibration manifest의 completed/calibration 상태, 실제 predictions.csv와
plan·manifest에 기록된 CSV hash의 일치, calibration/evaluation의 conversion manifest·assets hash 일치를 검사한다.
evaluation 실행에 `--calibration-manifest`가 필수이며 추론 전 검증과 완료 기록 전 재검증을 수행한다.
새 evaluation manifest에는 `calibration_manifest_sha256`을 기록한다. 고정 임계값·모델·점수는 변경하지 않았다.
`uv run --locked python -m pytest -q` 57개 통과(정상 연결, manifest/CSV 누락, hash 누락·불일치,
잘못된 split/status, 다른 conversion/model 연결 포함). 새로운 Docker 추론은 이번 보완에서 실행하지 않았다.

기존 evaluation `183da766`은 이전 실행기의 기록이다. 원본 manifest에 새 필드를 소급 기입하지 않는다.
`verification.json`은 **저장 결과 사후 검산**이며 당시 추론 전 검증이 수행됐다는 증거가 아니다.
재현성 검산용 ZIP `review-118-183da766.zip`(16,516 bytes)의 SHA-256은
`16a1e4786dd5782e74ba8e858bf901101bc44ae5195a401dbe789247f647a601`이다.
로컬 위치는 `experiments/astronet-eval/results/`이며 사용자가 GitLab MR에 첨부해야 한다. 원격 첨부 완료로 간주하지 않는다.

| ZIP 내부 파일 | SHA-256 |
|---|---|
| calibration/predictions.csv | `bf3d9ba24a2b490be96140de9fac89adfdf96a1069f48ce7222bbf7b4a339bfd` |
| calibration/manifest.json | `99a2c5203fc9cec69bf588baf6da3ff760cd9a14bf23bc4b1f62943a4eba06c1` |
| evaluation/predictions.csv | `08db768f2b02943f017790013b455200c449cccd2ebb0d1515e86de786d23a36` |
| evaluation/manifest.json | `7ed71c71673cd1917a9351373746f1fb5dd98c070c8beb1aaa374637e4fac00f` |
| evaluation/threshold_plan.json | `a65eca2be4c4cadfd3731b3585018cd1bde8e3d8b2e0cad969482663a187e877` |
| common/convert-manifest.json | `e5955cc1e676f2ffd214221d71fbf15f41137f51f48d7434a4d6e1776de34472` |
| common/assets.json | `2eed011062fed5e9241144543127c8a5a1a56d57a65b0e08e32709ee821facc0` |

ZIP을 `experiments/astronet-eval/results/review-118-183da766/`에 풀고 astronet-eval에서 실행한다.
manifest에 남은 옛 절대 경로를 열지 않으므로 다른 PC에서도 이 소형 결과만으로 집계할 수 있다.

```powershell
uv run --locked python -m astronet_eval.metrics --run-dir results/review-118-183da766/calibration
uv run --locked python -m astronet_eval.metrics --run-dir results/review-118-183da766/evaluation
```

실제 압축 해제 파일에 evaluation 재집계 명령을 실행해 TP 10·FP 2·FN 1·TN 16,
AP 0.9465709728867624, 사다리꼴 PR-AUC 0.9448190034314436을 확인했다.
이 재현성 보완 자체는 당시 최종 모델 역할·FP/FN 비용·라이선스의 팀 결정을 대신하지 않았다.
이후 확정된 운영 채택 보류와 118 완료 처리는 6절을 따른다.

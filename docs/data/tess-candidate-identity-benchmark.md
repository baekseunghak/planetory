# 고조파·판 사이 후보 동일성 실험 (112)

상태: **4별 비교·추가 배율 실험 완료, 계약 검토안 v1·미승인**. Jira `S15P21C206-112`.
상위: [데이터 문서](README.md). 입력 근거: [111 확정 결과](tess-bls-iteration-benchmark.md).
운영 구현은 122이며 이 문서의 제안값을 자동으로 운영에 적용하지 않는다.

## 입력 감사

인계 ZIP 안의 `review-111-c68c1e2.zip` SHA-256은
`c5741b705981aa0eda9434eaa83f908d93765ea57ed079cfccf3eae8580a1879`와 일치했다.
내부 checksums.json, 8개 manifest의 코드 c68c1e21 및 git_dirty=false를 검증했다.
1,127곡선, QA 실패 380곡선, 채택 단계 569개, 원본 재검증 실패 0개를 재집계했다.
같은 곡선 안의 채택 후보 쌍은 20개다. 기존 matches에서 미회수로 분류된 단계는
물리적 오탐 정답이 아니며, 원본 real 곡선에는 주입 정답 자체가 없다.

주기비가 가까운 유리수인지는 진단으로만 기록한다. 주기비·epoch 일치만으로
실제 공명 행성 두 개를 합쳐서는 안 된다. 기존 111의 임시 고조파 규칙은 수정하지 않았다.

## 실제 두 Bundle 비교

TOI-270 원본 FITS의 Sector 3·4를 A, Sector 3·4·5를 B로 실행했다.
기존 checksum 검증 로더·전처리·111 반복 루프를 재사용했다. realclean 주입 결과가 아닌
실제 관측 곡선이며 양쪽 모두 3개 후보, no_quality_peak 종료, 원본 재검증 통과다.
실행 전 입력·코드·설정·환경을 plan에 고정하고 종료 후 변조 여부를 확인했다.

| 대응 후보 | A 주기(day) | B 주기(day) | 제안식 오차/지속시간 |
| --- | --- | --- | --- |
| 0 | 5.6606641271 | 5.6603212600 | 0.053096 |
| 1 | 11.3806337812 | 11.3805842185 | 0.004337 |
| 2 | 3.3608719418 | 3.3601822976 | 0.317236 |

제안식은 두 판 관측 구간 합집합의 중앙 부근에서 epoch를 정수 주기만큼 이동하고,
epoch 차이와 구간 끝까지의 보수적 누적 주기 오차를 더해 두 지속시간 중 작은 값으로 나눈다.
배율 1의 직접 대응만 ID 유지에 사용한다. 허용값 0.125·0.25는 2개 유지/1개 추가·retired,
0.5·1.0은 3개 유지다. 이 별에서는 0.5가 더 작은 통과값이지만 최적값·일반화 증거로 보지 않는다.

## 실험용 생명주기 제안

- 직접 일치가 유일한 1:1일 때 기존 ID를 유지한다. ID는 실수 파라미터 해시로 만들지 않는다.
- 다대일·일대다·동률이면 ambiguous로 판 전환을 보류하며 임의로 가장 가까운 후보를 고르지 않는다.
- 검토안 v1은 P/4·P/3·P/2·2P·3P·4P 관계에서 어느 한쪽이라도 직접 대응이 없으면 possible_alias로 보류한다. 기존 후보가 이미 직접 대응됐어도 새 고조파 피크를 자동 추가하지 않는다. 주기 환산만으로 ID를 합치거나 retired시키지 않는다.
- 다른 후보의 추가·retired는 완전한 성공 판에서만 판정한다. 호출자는 `new_complete`를 명시해야 하며 True가 아니면 incomplete로 모든 생명주기 변경을 보류한다. 부분 계산·실패 판을 빈 후보표로 전달하면 안 된다.
- retired는 삭제가 아니다. 실제 DB ID 할당·status 변경은 이 실험에서 수행하지 않는다.
- 함수의 publishable은 실험상의 모호성 여부만 나타내며 운영 승인·스키마 통과를 뜻하지 않는다.

## 실행·산출물

코드: [입력 감사](../../experiments/tess-bench/tess_bench/candidate_identity_audit.py),
[두 Bundle 실행](../../experiments/tess-bench/tess_bench/candidate_bundle_regression.py),
[동일성 제안](../../experiments/tess-bench/tess_bench/candidate_identity.py).
결과는 Git 제외 경로 `experiments/tess-bench/results/candidate-identity-112/`에 보존한다.
`audit-111.json`, `two-bundles-v1/plan.json`, `bundle-A.json`, `bundle-B.json`, `manifest.json`,
`identity-sweep.json`은 초기 실측 자료다. 두 Bundle JSON의 step NaN은 기존 실험 표기이며 Gold 계약이 아니다.

```powershell
cd experiments/tess-bench
uv run --locked python -m tess_bench.candidate_identity_audit --source results/candidate-identity-112/source-111 --output results/candidate-identity-112/audit-new.json
uv run --locked python -m tess_bench.candidate_bundle_regression --output results/candidate-identity-112/two-bundles-new
uv run --locked pytest tests/test_candidate_identity.py -q
```

## 검증과 남은 완료 조건

최신 경계·통합 테스트 18개와 기존 반복 제거 관련 테스트 32개, 총 50개가 통과했다.
epoch 정수 주기 이동, 허용오차 경계 안/밖, alias 보류, 추가·retired,
일대다/다대일 모호성, 불완전 판 보류, 잘못된 입력과 감광 창 식별 불가를 확인했다.
실제 두 Bundle 계산 완료와 동일성 규칙 확정은 구분한다.
아래 감광 창 진단은 실행했으나 자동 병합을 정당화하지 못했다.
추가 배율과 여러 별의 비교는 아래와 같이 수행했다. 단순 box 이외의 모델 오차·관측 상관잡음에
견디는 자동 고조파 병합은 검증하지 못했다. 이를 검토안의 명시적 한계로 남긴다.
112 완료 조건의 강재민 스키마·계약 승인은 아직 받지 않았다. 122 운영 규약으로 확정 인계하지 않는다.

## 고조파 오병합 검증 — 자동 병합 문턱 미채택

[실행기](../../experiments/tess-bench/tess_bench/candidate_harmonic_benchmark.py)는
독립적인 두 box 창과 절편을 원본 정제 flux에 동시에 적합해 조건부 깊이·표준오차·SNR을 기록한다.
기간·epoch·duration은 고정하며 후보 검색이나 운영 제거 모델 변경은 하지 않는다.
각 창 단독·공통·바깥 관측점 수를 남기고 설계행렬 rank가 부족하면 unidentifiable로 반환한다.
이 SNR은 잔차의 표준편차와 독립 잡음 가정에 기초한 실험 진단이며 BLS SNR과 다른 값이다.
상관잡음·box 모델 오차의 불확실성을 충분히 반영하지 못하므로 유의성의 과학적 확정값이 아니다.

합성은 80일·2분 간격, 잡음 sigma=200ppm, seed 0~9다. 기본 신호는 4일/3시간/2000ppm,
강한 두 번째 신호는 1000ppm, 약한 두 번째는 2ppm이다. 두 신호 주입은 모델 곱셈으로 생성했다.
균등 깊이 주·부극소 사례는 이 box 관측만으로 4일 단일 신호와 동일하게 구성한 비식별 예시이며
실제 식쌍성 파형이나 분류 성능 검증이 아니다.

| 사례 | 실행 수 | 두 조건부 SNR 모두 3 이상 | 5 이상 | 7 이상 | 해석 |
| --- | ---: | ---: | ---: | ---: | --- |
| 단일 신호 + 2P 피크 | 10 | 0 | 0 | 0 | 추가 깊이 지지 없음 |
| 실제 두 신호, 정확한 2:1·같은 epoch | 10 | 10 | 10 | 10 | 강한 추가 깊이 구분 |
| 두 신호, epoch 다름 | 10 | 10 | 10 | 10 | 강한 두 신호 지지 |
| 두 신호, 4일/4.03일 | 10 | 10 | 10 | 10 | 가까운 두 신호 지지 |
| 실제 약한 두 번째 신호 | 10 | 0 | 0 | 0 | 지지 없음이 동일 신호의 증거는 아님 |
| 동일한 관측 창 | 10 | 0 | 0 | 0 | 전부 unidentifiable |
| 서로 다른 창 부분을 마스킹 | 10 | 0 | 0 | 0 | 전부 unidentifiable |
| 균등 주·부극소 비식별 예시 | 10 | 0 | 0 | 0 | 대표 공전주기 확정 불가 |
| 111 실제 채택 후보 쌍 | 20 | 20 | 20 | 20 | 자동 독립 신호 판정에도 불충분 |

111 쌍 중 7개는 적어도 한 단계가 기존 주입 정답 매칭에서 미회수로 분류됐다.
그 쌍까지 모두 SNR 7을 넘었으므로 높은 조건부 SNR만으로 독립 신호라고 확정하지 않는다.
반대로 SNR 미달을 자동 병합 근거로 쓰면 이 합성의 약한 두 신호 10건을 모두 오병합한다.
비식별 20건을 alias로 간주하는 것도 근거가 없다. 자동 병합은 비활성화했으며,
이를 ‘오병합률 0으로 검증된 병합 알고리즘’으로 표현하지 않는다.

111 입력은 승인 ZIP의 고정 후보를 유지하고 현재 코드로 해당 20개 쌍의 원본 정제곡선만 재구성했다.
raw FITS checksum을 승인 manifest와 대조하고 코드·설정·참조표·입력·환경을 실행 전 plan에 기록했다.
111의 전체 BLS 탐색은 재실행하지 않았다. 역사적 환경의 비트 단위 재현이나 독립 정답 세트는 아니다.
최신 결과는 `results/candidate-identity-112/harmonic-v3/`의 plan·evidence·summary·manifest다.

```powershell
uv run --locked python -m tess_bench.candidate_harmonic_benchmark --source results/candidate-identity-112/source-111 --output results/candidate-identity-112/harmonic-new
```

초기 제안에서 직접 대응된 기존 후보의 고조파가 새 후보로 추가되는 누락을 실패 테스트로 재현했다.
어느 한쪽이라도 직접 대응이 없으면 alias 검사를 하도록 수정했다. 절반 주기 epoch가 다른 통과를
가리킬 수 있으므로 possible_alias 보류는 주기 오차로 넓게 검사하며, 실제 병합에는 사용하지 않는다.

## 여러 별의 Sector 추가 비교

기존 fixture 4별을 사용한다. 별마다 등록된 마지막 Sector를 뺀 A와 전체 Sector B를 비교한다.
TOI-270 기존 결과를 재사용하고, 추가 3별은 새 입력·코드·설정 manifest로 실행했다.
실측 실행기는 `candidate_bundle_regression --target <target> --output <새 경로>`다.

| 별 | A Sector | B Sector | A/B 후보 수 | 종료 | ID 검증 해석 |
| --- | --- | --- | --- | --- | --- |
| TOI-270 | 3,4 | 3,4,5 | 3/3 | 양쪽 no_quality_peak | 0.5 제안값에서 3개 유지 |
| TOI-451 | 4 | 4,5 | 0/0 | 양쪽 no_quality_peak | 빈 결과 일치, 양성 ID 유지 증거 아님 |
| WASP-62 | 2,3,4 | 2,3,4,8 | 1/1 | 양쪽 removal_qa_failed | 양성 후보가 있어도 불완전 판이므로 ID 변경 보류 |
| pi Men | 4 | 4,8 | 0/0 | 양쪽 no_quality_peak | 빈 결과 일치, 양성 ID 유지 증거 아님 |

WASP-62 후보의 제안식 오차/지속시간은 0.070690이지만 QA 실패 판을 공개 가능한 판으로
취급하지 않는다. A와 B 모두 정상 종료·원본 재검증을 만족해야 비교에 의한 생명주기 변경을 허용한다.
최종 비교는 저장된 Bundle checksum을 확인한 뒤 현재 검토안으로 재평가했다.
`four-star-comparison-v2/comparison.json`은 비교 코드와 입력 checksum을 포함한다.
이를 ‘4별의 양성 후보 ID 유지 검증 통과’라고 표현하지 않는다. 양성 유지 근거는 여전히 TOI-270이다.

## 추가 고조파 배율 비교

[비교 실행기](../../experiments/tess-bench/tess_bench/candidate_ratio_sweep.py)는 111의 기존
`is_duplicate` 누적 오차식을 그대로 호출하고 배율 집합만 바꾼다. 20개 고정 채택 쌍에 대한
사후 민감도 검사이며 전체 반복 탐색을 재실행한 회수율 비교가 아니다.

| 배율 집합 | 걸리는 쌍/20 | 양쪽 모두 주입 정답에 매칭된 쌍 | 미매칭 단계 포함 쌍 |
| --- | ---: | ---: | ---: |
| 기존 1/2,1,2 | 0 | 0 | 0 |
| 1/4,1/3,1/2,1,2,3,4 | 4 | 0 | 4 |
| 111에서 관찰한 추가 배율 19개 | 4 | 0 | 4 |
| 분자·분모 1~9의 모든 기약 비율 | 11 | 6 | 5 |

좁은 3·4배 확장은 이 표본에서 더 넓은 관찰 배율 집합과 같은 4쌍을 표시했다.
따라서 v1의 **검토 필요 표지**로 좁은 집합을 사용한다. 미매칭이 물리적 오탐 정답은 아니므로
이 4쌍을 자동 병합해도 안전하다고 확정하지 않는다. 모든 유리수 비율로 넓히는 안은
정답에 매칭된 6쌍까지 차단하므로 미채택한다. 원시 후보·주기·alias 근거를 삭제하지 않는다.
결과는 `ratios-v1/report.json`과 manifest에 보존한다.

## 122 인계를 위한 계약 검토안 v1

버전은 `candidate_identity_v1_proposal`이다. 강재민 검토 전이며 운영 채택 상태가 아니다.

1. 직접 일치 허용값은 작은 쪽 지속시간의 0.5를 제안한다. 0.125·0.25보다 TOI-270 유지가 개선됐고
   1.0과 결과가 같아 더 작은 값을 선택했다. 제한된 표본에서의 선택이며 전역 최적값이 아니다.
2. 직접 일치는 유일한 1:1 관계에서만 ID를 유지한다. 동률·다대일·일대다는 ambiguous로 보류한다.
3. 나머지의 P/4·P/3·P/2·2P·3P·4P 근접 관계는 possible_alias로 보류하며 자동 병합하지 않는다.
4. 불완전 판·원본 검증 실패는 ID 유지/추가/retired를 적용하지 않고 기존 공개 판을 유지한다.
5. 완전한 판에서 직접 대응도 의심 관계도 없는 후보만 신규/retired 대상으로 낸다. retired 행은 삭제하지 않는다.
6. 이 실험은 판 사이 대응 제안이다. 한 판 안의 고조파 대표 선택·자동 병합 전체를 구현한 것으로 보지 않는다.

리뷰에서 확인할 사항은 0.5 직접 동일성 허용값의 제한된 근거 수용 여부,
possible_alias·ambiguous·incomplete를 122와 후속 소비자가 어떻게 보류 처리할지,
자동 병합 미검증 범위를 112 완료로 인정할 수 있는지다. 기존 티켓의 자동 병합 기대를
임의로 축소하여 완료 처리하지 않는다. 합의 전에는 Jira 진행 중을 유지한다.

## 최종 검토 자료

최신 실행 묶음은 `results/candidate-identity-112/review-v1/`이다. 최종 코드로 4별 A/B 계산,
저장 결과 비교, 감광 창 100건 및 추가 배율 비교를 다시 실행했고 위 결론이 유지됐다.
하위 `toi270`, `toi451`, `wasp62`, `pi_men`, `four-star-comparison`, `harmonics`, `ratios`의
manifest와 plan을 함께 제공한다. 이전 run은 과정 기록이며 최신 실행 근거와 구분한다.
원본 FITS는 리뷰 ZIP과 Git에 넣지 않고 checksum·위치만 남긴다.
실행 소스·설정과 결과를 `review-112-proposal-v1.zip`으로 별도 제공한다.
이 ZIP은 검토안의 증빙이며 112 승인·자동 병합 검증 완료의 증명은 아니다.

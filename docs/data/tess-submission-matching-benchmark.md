# 제출 매칭 규칙 검증 — S15P21C206-128

상태: **실측·공통 사례 검증 완료, rule-1 채택안 준비·운영 미활성화**. 정본은 [탐사 API](../../apps/backend/docs/exploration-api-spec.md),
공통 개발 사례는 [매칭 계약](../api/exploration/README.md#제출-매칭-수치-규칙-v0-rule-0-jira-s15p21c206-128)이다.
이 기록은 운영 설정, DB migration 또는 `rule-0`의 수치 값을 변경하지 않는다.

## 1. 최신 계약 반영

141의 API 5.4·6.2절은 `suggestedDurationHours=null`이면 추천 duration 상한을 적용하지 않도록 합의·구현했다.
주기도가 power만 제공하므로 주기만 보고 duration을 추정하지 않는다. `matching-v0.cjs`가 null을 0시간으로
곱하던 차이를 정정한다. 최소 창·위상 최대 폭·source 존재·fineTune 검사는 유지한다.
겹친 fineTune의 다른 봉우리에서 duration을 가져오거나 가까운 봉우리를 역추정하지 않는다.

기존 31개 사례의 expected와 규칙 수치는 유지한다. 최초 추가 Node 테스트 5개는 null 상한, 유효 상한,
최소·최대 폭, source·fineTune, 추천 목록 크기와 무관한 직접 선택을 검사한다.
백엔드 알고리즘을 바꾼 것이 아니며 전체 Java·프론트 교차 실행을 완료했다는 뜻은 아니다.

## 2. 저장된 111 결과의 부분 검산

2026-09-21, `c68c1e21f19e2d9d21c4c76df04d88fbe22e9052`, dirty=false인 주입 평가 5개 실행의
저장 CSV를 재집계했다. FITS 로딩·BLS 재실행은 하지 않았다. 각 실행의 steps·iterations·matches
총 15개 파일 SHA-256과 행 수, 곡선별 채택 단계 수와 회수 단계 연결을 검사했다.
원본 FITS·입력 설정 해시까지 재검증했다는 뜻은 아니다.

| 대상 | run | 곡선 | direct/alias 회수 신호 중 검사 수 |
| --- | --- | ---: | ---: |
| L 98-59 | 746e184e | 224 | 144 |
| CM Dra | 2973480f | 224 | 44 |
| WASP-18 | 4f88d63f | 224 | 113 |
| TOI-700 | b88c5e87 | 224 | 148 |
| HD 21749 | be776a89 | 224 | 100 |
| 합계 | 5개 실행 | 1,120 | 549 |

realclean과 noise20260910을 포함한 조건부 집계다. 미회수 신호·사용자 오선택·가짜 후보의 정답 판정은 포함하지 않는다.
원본 SNR 검증 실패 곡선은 최종 후보별 상태를 확정할 수 없으므로 제외하도록 했고, 이번 제외 수는 0이다.
별도 raw·tamper 7곡선은 주입 회수 비교 모집단에 넣지 않았다. 111 전체 1,127곡선 재검증 보고가 아니다.

검사는 정답 주기를 사용자 주기로 가정하고 `{1, 0.5, 2}` 중 주기 오차가 가장 작은 배율을 사용한다.
이 배율 선택은 진단용이며 실제 제출의 배율 1 우선·epoch·중첩 조건을 대체하지 않는다.
허용 반폭은 `max(후보 duration / 2, 20분 / 2)`로 계산했다. 20분은 rule-0의 10분 bin 2개 예시다.

| 부분 조건 | 결과 |
| --- | --- |
| 정답 duration / 회수 후보 duration이 0.5~2 안 | 549/549 |
| N 상한 없음에서 정규화 주기 오차 ≤ 1 | 549/549 |
| 예시 N 상한 5·10·20·50 각각에서 주기 오차 ≤ 1 | 각각 549/549 |
| 사용한 BLS n_transits 범위 | 3~82 |

**이 표로 N 상한을 고를 수 없다.** 이미 회수된 신호만 검사했고 모든 대안이 동일하게 통과한다.
BLS `n_transits`는 Gold 관측 창으로 산정한 매칭 N과 동일하다고 보장되지 않는다.
549/549를 사용자 제출 매칭 정확도나 `rule-1` 통과율로 쓰지 않는다.
epoch와 실제 관측 공백을 버린 채 baseline 전체를 연속 관측으로 채워 중첩을 계산하지 않는다.

저장 보고서: `experiments/tess-bench/results/matching-evidence-c68c1e2.json` (Git 제외).
SHA-256: `6f8ec9d4accb2ac1ad488b07fa75a6871063027e2927c4e97772aace75d87a04`.
보고서는 원 manifest 해시, 출력 해시·행 수, 신호별 수치, 검산기 해시를 포함한다.
원본 CSV 경로는 manifest의 로컬 경로를 사용한다. 다른 PC에서 파일이 없으면 실패하며 자동 다운로드하지 않는다.

재집계 명령(저장소 루트에서 실행, 출력 파일은 덮어쓰지 않으므로 새 경로 지정):

```powershell
cd experiments/tess-bench
uv run --locked python -m tess_bench.matching_evidence `
  --manifest results/manifests/iterate-l98_59-746e184e.json `
  --manifest results/manifests/iterate-cm_dra-2973480f.json `
  --manifest results/manifests/iterate-wasp18-4f88d63f.json `
  --manifest results/manifests/iterate-toi700-b88c5e87.json `
  --manifest results/manifests/iterate-hd21749-be776a89.json `
  --output results/matching-evidence-recheck.json
```

## 3. rule-1 확정까지 남은 범위

| 항목 | 현재 근거·상태 | 다음 작업 |
| --- | --- | --- |
| null 추천 duration, source 선택·fineTune | 최신 API 계약 확인, 참조 예제 정정 | C09·A04가 같은 경계 사례를 소비하는지 교차 확인 |
| N_transits 상한·최소 중첩 | 위 부분 실측은 상한 대안을 구분하지 못함 | 관측 공백을 포함한 실제 입력과 오선택 사례로 비교. N_peak(추천 수)와 별도로 명명 |
| dominanceRatio·minScoreGap·overlapRatioTolerance | 기존 0.5·0.1·0.1은 여전히 개발 가정 | 동일 입력에 복수 후보가 통과하는 제출과 기대 판정을 마련해 강재민과 비교. 정답 없는 숫자 최적화 금지 |
| 위상 최대·빈 구간·최소 창 | 기존 예제 및 화면 방침, 확정 rule-1 아님 | 백지웅과 cadence별 최소 폭, 공백, 경계·다시 풀기 사례 및 기대 판정 확인 |
| 공식 버전·인계 | 현재 rule-0 유지 | 승인된 값·단위·정상/경계/거절 fixture를 rule-1으로 고정하고 C09/A04 교차 검증·인계 |

다음 실제 비교에는 원본 시각에서 구성한 관측 창, 주입 epoch, 최종 공개 대상 후보,
사용자 선택(period·phaseStart·phaseEnd·source)과 기대 결과가 필요하다.
후보 자신을 그대로 제출한 사례만으로 우세/모호 문턱을 검증하지 않는다.
N 상한을 적용한다면 **주기 누적 오차용 제한 N과 중첩 비율 분모인 실제 관측 통과 수를 분리**해야 한다.
이전 참조 구현은 같은 N을 써서 cap을 켜면 overlapRatio가 1을 넘을 수 있었다.
최신 서버 `SubmissionMatching`은 이미 분리했고, 참조 구현도 동일하게 정정했다.
외부 `nTransitsObserved`를 덮어쓰는 경로도 제거해 서버처럼 관측 창에서 센다.
이번 작업에서 cap을 켜거나 그 수치를 임의로 확정하지 않는다.

128 완료는 rule-1 수치·공통 fixture에 대한 강재민·백지웅 공동 확인과 인계 뒤 판단한다.
111·122 병합 또는 이 부분 검산 통과만으로 완료 처리하지 않는다.

## 4. 기존 승인 반영과 실제 관측 창 재생

사용자가 제공한 기존 강재민 리뷰에 따라 `P_mod=min(P_user,P_c)`와 epoch 반폭 하한 해석을
규칙 JSON의 미결 목록에서 제거했다. fineTune과 다시 풀기(source=null)는 이미 해결된 상태를 유지한다.
선택 규칙과 매칭을 하나의 `rule-N`으로 버전 관리하는 답변도 기존 문서대로 유지한다.
이 정리는 새로운 수치 승인이나 미실행 프론트 검증을 뜻하지 않는다.

`tess_bench.matching_replay`는 아래 순서로 111 회수 후보와 제출 규칙의 관계를 비교한다.

1. 원 실행 manifest·CSV 연결과 raw FITS·주입 격자 해시를 확인한다. 원본에 접근하지 못하거나 다르면 중단한다.
2. 원 manifest의 known model·seed·전처리 설정으로 주입 곡선을 다시 구성한다. BLS 탐색은 하지 않는다.
3. 각 Sector를 10분 mean으로 비닝한다. 20,000점 초과로 간격 확대가 필요한 입력은 실패한다.
4. 서버 6.2 계약처럼 유한 bin 시작점의 연속 구간을 관측 창으로 만들고 공백을 보존한다.
   이는 제출 매칭의 관측점 규약이며 모델 평가의 bin 중심 규약과 혼동하지 않는다.
5. 원 주입 epoch·duration으로 직접 주기·절반 주기·두 배 주기 제출을 만들고 모든 매칭 조건을 검사한다.
   추가 반 주기 위상 이동은 **정답 없는 probe**로 기록한다. 다른 후보와 실제로 겹칠 수 있으므로 오탐 라벨을 붙이지 않는다.
6. N 상한 없음·5·10·20·50의 결과와 다중 후보 우세 진단을 남긴다. 결과로 자동 최적값을 선택하지 않는다.

회수된 549개 주입 신호에 한정한 비교다. 검증 실패 곡선 제외 조건은 2절과 같다.
`agrees_with_111_recovery`는 같은 후보를 선택했는지이며 사용자 정확도·행성 확인 여부가 아니다.
후보는 저장된 111 채택 단계이며 운영 Gold의 active/discoverable 후보나 122 ID 카탈로그가 아니다.
관측 창은 현재 코드로 재구성한 fixture 비닝 결과다. 과거 111 실행 환경의 완전 재현 또는 실제 Gold 게시 검증으로 표현하지 않는다.

실행 전에 입력·출력 원본과 현재 Python 코드·JS·규칙·lock 해시를 `plan.json`에 고정한다.
실행 뒤 동일성을 다시 검사하고 `input.json`, `result.json` 해시를 manifest에 기록한다.
예외는 `failure.json`과 비정상 종료로 남기며 completed manifest를 만들지 않는다.
Git 명령·다운로드·BLS 탐색은 실행하지 않는다. 실제 비교는 사용자가 실행한다.

```powershell
cd experiments/tess-bench
uv run --locked python -m tess_bench.matching_replay `
  --manifest results/manifests/iterate-l98_59-746e184e.json `
  --manifest results/manifests/iterate-cm_dra-2973480f.json `
  --manifest results/manifests/iterate-wasp18-4f88d63f.json `
  --manifest results/manifests/iterate-toi700-b88c5e87.json `
  --manifest results/manifests/iterate-hd21749-be776a89.json
```

출력은 `results/matching-replay/run-.../`에 새로 생성한다(Git 제외).
2026-09-21 준비 검증: 위 5개 실행의 원본·격자·CSV 사전 해시 검사 통과, Python 관련 테스트 21개와
Node 계약 테스트 12개, 기존 fixture 31개 통과. 이후 사용자가 실행한 실제 재생 결과는 5절에 기록한다.

## 5. 실제 재생 결과 (2026-09-21)

사용자 실행: `run-20260921T140641Z-3e9bf8ea`, `status=completed`, 233.655초.
회수 신호 549개가 있는 536곡선에서 4가지 제출을 만들었다. 총 2,196제출을 N 상한 5안으로
비교하여 결과 행은 10,980개다. 전체 1,120곡선이나 미회수 신호를 모두 평가한 것이 아니다.

| 제출 형태 | 전체 | 입력 검증 통과 | 기존 111 회수 후보와 일치 | 매칭 안 됨 | 입력 검증 거절 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 원래 주기 | 549 | 534 | 534 (matched) | 0 | 15 |
| 절반 주기 | 549 | 534 | 534 (matched_harmonic) | 0 | 15 |
| 두 배 주기 | 549 | 527 | 527 (matched_harmonic) | 0 | 22 |
| 반 주기 위상 이동 probe | 549 | 534 | 0 | 534 | 15 |

표의 결과는 N 상한 없음·5·10·20·50에서 모두 동일하다.
원래 주기의 조건부 일치는 534/534이며, 전체 시도 기준은 534/549다.
이를 전체 사용자 매칭 정확도나 독립 평가 성능으로 부르지 않는다.

거절 사유:

- 원래 주기·절반 주기·위상 이동의 각 15건은 `PHASE_WIDTH_MAX`다. 원 주입은 모두
  1일·8시간이며, 원래 주기에서도 위상 폭 1/3이 0.25를 넘는다. 주입 회수 성공과 UI 선택 허용은 다르다.
- 두 배 주기의 22건은 `OUTSIDE_PERIOD_GRID`다. 제출 주기는 8일 1건, 10일 21건으로
  각 입력의 `baseline/3` 탐색 상한을 벗어난다. 고조파를 허용해도 주기 격자 입력 검증을 우회하지 않는다.
- 위상 이동 probe는 534건 모두 매칭되지 않았지만, 음성 정답을 독립 부여한 세트가 아니므로 오탐률 0으로 표기하지 않는다.

**해석 범위:** 입력 검증을 통과한 정답 기반 직접·절반·두 배 제출은 기존 회수 후보와 일치했다.
이번 결과에 `dominance`가 산출된 행은 0개다. 따라서 여러 후보가 동시에 통과한 뒤의
우세/모호 문턱을 실측 검증하거나 최적화한 결과가 아니다. N 상한 대안도 구분되지 않았다.
관측 공백·상한 분모·합성 동률 경계는 테스트로 검증한 범위와 구분한다.
rule-0 값은 유지하고 이번 실행을 근거로 rule-1 운영 확정을 선언하지 않는다.

무결성·독립 집계:

- plan SHA-256 및 plan 입력·코드 snapshot 84개와 출력 2개, 총 86개 파일 해시 일치.
- input의 536곡선·2,196제출, result 10,980행과 manifest 일치.
- 저장 summary 20그룹의 전체·일치·상태별 건수를 result 행에서 독립 재집계하여 일치 확인.
- BLS 탐색·실험 재실행 없이 사용자의 저장 결과만 검산했다.

| 파일 | SHA-256 |
| --- | --- |
| plan.json | c225d153bd57466465fc9856f9affe2905f84dedaf2249ccae7e9304422f3e03 |
| input.json | 798efa2640338e9194883bd6fb6b02f475a5fb9d4694471189b90607ba4bd661 |
| result.json | 47f8b6523e7135f9f9022dcfe714b05d39eca18d8470129baf96a5cf87d0084b |
| manifest.json | 44e0beab0e84ba03a64b8cd61645af838abeb06675bc1f4a73670585487ea0fe |

파일은 `experiments/tess-bench/results/matching-replay/run-20260921T140641Z-3e9bf8ea/`에 있으며 Git 제외다.
공유가 필요하면 이 실행의 파일을 제공한다. 원본 FITS는 결과 공유에 포함하지 않는다.

## 6. rule-1 채택안과 선택 근거

이번 브랜치는 [rule-1 JSON](../api/exploration/matching-rules.v1.json)과
[공통 fixture](../api/exploration/matching-cases.v1.json)를 제공한다.
`status=proposed-not-activated`는 승인·배포가 끝났다는 뜻이 아니다.
기존 v0 승인을 v1 공동 승인으로 바꿔 기록하지 않으며, 최종 운영 채택 여부는 이 구체적인 안으로 판단한다.

| 필드·단위 | 제안 값 | 측정·계약 근거와 선택 이유 |
| --- | --- | --- |
| 누적 오차 N_transits 상한, 개수 | 없음(null) | 5개 대안 결과 동일. 오차 허용을 완화할 근거가 없어 실제 관측 통과 수 유지. 중첩 분모에는 상한을 적용하지 않음 |
| 최소 중첩 통과, 개수 | 1 | 최소 하나의 관측된 중첩을 요구. 공백에만 있는 후보 거절을 검증. 두 배 주기 정정에서 중첩이 줄므로 근거 없는 추가 제한은 도입하지 않음 |
| dominanceRatio·minScoreGap·overlapRatioTolerance, 무차원 | 0.5·0.1·0.1 | 기존 수치 유지 제안. 합성 다중 후보·동률·문턱 경계가 고정되어 있으나 실측 다중 통과가 없어 최적값·실제 구별 성능으로 주장하지 않음 |
| 위상 폭 상한, 무차원 | 0.25 | 기존 A04 시작값 유지 제안. 1일·8시간 15신호가 선택 불가라는 제한을 명시적으로 포함. 이 결과에 맞추어 사후 확대하지 않음 |
| 빈 위상 구간 제출 | false | 기존 A04 합의. 드래그는 허용, 제출 제한·선택 유지 |
| UI 최소 선택 폭, day | 2 × 제공 곡선 최소 binMinutes / 1440 | 별별 cadence 반영. phaseWidthMin은 이 값 / periodDays. 20분은 10분 자료의 예시이며 모든 자료의 상수가 아님 |
| 매칭 최소 반폭, day | max(후보 durationHours / 48, minWindowDays / 2) | 기존 C09 확인. UI 전체 폭과 같은 필드로 혼동하지 않음 |
| 추천 duration 상한 | 선택 source의 duration × 3 | 기존 C02-R3. source의 duration이 null이면 해당 상한만 생략. 추천 개수·목록 순서로 source를 추정하지 않음 |
| N_peak | 현재 추천 설정 사용 | N_transits와 무관. top-N 밖 직접 선택·재제출 허용. 이번 매칭안은 추천 개수를 새로 정하지 않음 |
| 배율 | 1·2·0.5, 배율 1 우선 | 기존 확정 계약 유지. 112의 배치 동일성과 제출 배율 허용 범위를 같은 정책으로 취급하지 않음 |

무상한·우세 문턱·위상 상한 유지는 **검증 범위를 밝힌 정책 선택 제안**이다.
실측으로 유일한 최적값을 발견했다거나 SRS 예시를 근거 없이 승인된 값으로 복사했다는 의미가 아니다.
값의 변경이 필요하면 같은 검증 입력과 새 버전으로 비교하며 이미 저장된 제출의 rule_version을 덮어쓰지 않는다.

## 7. 공동 fixture와 인계

실행: 저장소 루트에서 `node docs/api/exploration/matching-v1.cjs`.

- 기존 31개 전체 expected를 보존한다. 직접/고조파/불일치/모호, phaseEnd>1,
  duration·반올림·우세 문턱·배열 순서 경계는 기존 입력과 동일하다.
- 추가 `contractChecks` 16개는 각 JSON의 `expectedSubset` 필드를 **정확히 비교**한다.
  null duration, 겹친 fineTune의 명시 source, top-N 밖 retry·N 변경,
  최소/최대 선택 폭, 빈 관측 구간, 관측 통과·상한 분모, 동률·제거 후보를 담는다.
  전체 반환 객체를 고정한 사례와 특정 계약 필드만 고정한 사례를 구분한다.
- 이 47개는 합성 계약 검사다. 프론트·Java 소비자가 실행한 결과 또는 실측 47건으로 표현하지 않는다.

저장된 실제 `input.json`을 rule-1 제안 값으로 재평가한 결과,
10,980개 결과 행과 20개 summary 그룹이 기존 rule-0 실행과 모두 일치했다(변경 0행).
원 실행 결과를 수정하지 않았고 FITS 전처리·BLS는 재실행하지 않았다.
검증 기록: `experiments/tess-bench/results/matching-v1-verification.json` (Git 제외),
SHA-256 `60462503bea4e95fd7b3e3577d53f44aeb486428b20d84bac347343e380c8049`.
원 실행 manifest·input·result 해시와 검증 당시 5개 코드·규칙·fixture 해시를 포함한다.

| 소비자 | 전달물·전환 작업 | 이번 범위에서 확인한 상태 |
| --- | --- | --- |
| C02 | 6절 수치안, rule-1 JSON, 47개 입력·기대 결과 | 전달 자료 준비. 기존 v0 승인과 v1 채택은 구분 |
| C09 | 같은 fixture로 Java 결과 비교, 승인 후 새 operation_settings 버전·적용 시각 준비 | 서버의 null 상한·중첩 분모 구현과 참조 코드 정합화. 현재 Java 테스트의 v0 파일 참조는 아직 교체하지 않음 |
| A04 | 같은 validation fixture, cadence별 최소 폭, null 상한·명시 source, 빈 구간 제출 안내 | 기존 화면 방침 보존. 실제 프론트 조작·소비자 전환은 이번 티켓 제외 범위 |
| 저장·이력 | 기존 rule-0와 submissions.rule_version 보존, 새 버전은 승인 후 적용 | 기존 DB 행·migration·배포 설정 변경 없음 |

인계 시 `cases`는 전체 expected, `contractChecks`는 mode별 입력에서 expectedSubset만 검증한다.
선택 규칙과 매칭 값은 같은 rule-1로 묶고 별도 sel-1을 만들지 않는다.
값뿐 아니라 해석 알고리즘이 바뀌면 과거 판정 재현 방침과 새 rule_version을 함께 정한다.

## 8. 병합과 Jira 완료 확인

이 브랜치는 계약 차이 정정, 실측 근거, rule-1 제안·공통 fixture·인계 문서를 함께 병합하는 단위다.
수치 커널·제출 트랜잭션·UI를 추가 구현하거나 DB 활성화를 이번 MR에 섞지 않는다.

| Jira 완료 항목 | 준비 결과 | 남은 확인 |
| --- | --- | --- |
| 측정 근거·채택 값·rule_version | 5~6절과 rule-1 JSON | 제안 값을 실제 채택하는 확인 |
| 직접/고조파/불일치/모호/위상 경계 | 31+16개 고정 사례 검증 통과 | 공동 소비자의 같은 fixture 확인 |
| 단위·fold·반올림·관측부족·허용폭 | 공통 fixture와 필드 구분 | 실제 UI 조작 완료를 요구하는 범위로 확대하지 않음 |
| duration 출처·추천 N·fineTune 중첩 | 명시 source/null/목록 변화 계약 검사 | 동일 계약으로 인계 |
| 추천 밖 retry·관측 공백 | 공통 사례와 실제 관측 창 재생 | 기존 API 충돌은 이미 해결되어 재차단하지 않음 |
| v1 공동 승인·C09/A04 교체 인계 | 전환 책임·파일·이력 보존 절차 준비 | v1 확인 및 인계 수령 기록 |

2026-09-21 Jira 원문은 v1 공동 확인을 완료 조건으로 명시한다. 기존 개발용 v0 승인 댓글만으로
이 조건을 완료했다고 표시하지 않는다. 별도 장시간 BLS 실행은 추가로 요구하지 않는다.
이번 채택안과 인계의 확인이 남은 마지막 단계이며, 이를 확인한 뒤 MR 병합·Jira 완료 기록을 정리한다.

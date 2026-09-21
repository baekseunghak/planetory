# 제출 매칭 규칙 검증 — S15P21C206-128

상태: **부분 실측 검산 완료, rule-1 미확정**. 정본은 [탐사 API](../../apps/backend/docs/exploration-api-spec.md),
공통 개발 사례는 [매칭 계약](../api/exploration/README.md#제출-매칭-수치-규칙-v0-rule-0-jira-s15p21c206-128)이다.
이 기록은 운영 설정, DB migration 또는 `rule-0`의 수치 값을 변경하지 않는다.

## 1. 최신 계약 반영

141의 API 5.4·6.2절은 `suggestedDurationHours=null`이면 추천 duration 상한을 적용하지 않도록 합의·구현했다.
주기도가 power만 제공하므로 주기만 보고 duration을 추정하지 않는다. `matching-v0.cjs`가 null을 0시간으로
곱하던 차이를 정정한다. 최소 창·위상 최대 폭·source 존재·fineTune 검사는 유지한다.
겹친 fineTune의 다른 봉우리에서 duration을 가져오거나 가까운 봉우리를 역추정하지 않는다.

기존 31개 사례의 expected와 규칙 JSON은 유지한다. 추가 Node 테스트 5개는 null 상한, 유효 상한,
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
현재 참조 구현은 같은 N을 쓰므로 cap을 켜는 것만으로는 overlapRatio가 1을 넘을 수 있다.
이번 작업에서 cap을 켜거나 그 정책을 임의로 확정하지 않는다.

128 완료는 rule-1 수치·공통 fixture에 대한 강재민·백지웅 공동 확인과 인계 뒤 판단한다.
111·122 병합 또는 이 부분 검산 통과만으로 완료 처리하지 않는다.

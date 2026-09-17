# 위상 구간 선택·판단·제출 확인 개발 안내

대상은 [S15P21C206-185](https://ssafy.atlassian.net/browse/S15P21C206-185)이다. 2026-09-17 기준 **1단계 계산·검증 기반 구현**이며 화면 연결·실제 API 인수 완료를 뜻하지 않는다. 기능 기준은 [분석 프론트 명세 §5~6](../../../docs/development/analysis-frontend-spec.md), [SRS EXP-06·07·12 및 SUB-01·02](../../../docs/requirements/planetory-requirements-spec.md), 입력 계약은 [탐사 API §5.1·5.4·6.2](../../backend/docs/exploration-api-spec.md)를 따른다. 기존 [접기 개발 안내](phase-folding.md)의 최신 결과·실패 복구·32배 보기 계약을 유지한다.

## 작업 순서와 브랜치

| 단계 | 범위                                                        | 현재 상태      |
| ---- | ----------------------------------------------------------- | -------------- |
| 1    | 서버 선택 규칙 읽기, 위상 정규화, 시간 환산, 수치 오류 검사 | 로컬 구현·검증 |
| 2    | 접힌 그래프 선택 밴드·양 끝 핸들, 마우스·키보드             | 미구현         |
| 3    | 시간 곡선 예상 띠, 미리보기, 재접기 잠금·초기화·실패 복구   | 미구현         |
| 4    | 판단 3종·근거 3종·메모, 단계 진행, 제출 초안·확인 화면      | 미구현         |
| 5    | 통합 회귀·접근성 검사, 실제 API 수치 대조                   | 미구현         |

각 단계의 결과를 설명한 뒤 다음 단계를 진행한다. 시각 리디자인은 포함하지 않는다. 실제 제출 통신은 #187 경로와 연결하며, 합성 응답 검증만으로 #185 완료를 선언하지 않는다.

브랜치는 `feature/S15P21C206-185-web-analysis-selection`, 작업 폴더는 워크스페이스의 `.worktrees/analysis-185`이다. #184가 develop 병합 전이므로 푸시된 `6d2448a`에서 의존 브랜치로 분기했다. 준비 시 원격 develop `3145c1b`와 AGENTS.md를 확인했으며 develop을 #185에 병합한 것은 아니다. #184 병합 뒤 기준 브랜치와 MR 차이를 다시 확인한다. 기존 작업 폴더는 변경하지 않는다.

## 1단계 입력 읽기

[분석 응답 어댑터](../src/features/analysis/analysis-data.ts)는 기존 `periodSelectionRules`에 더해 `selectionContract`를 만든다. [규칙 디코더](../src/features/analysis/selection-rules.ts)는 다음 공개 필드만 읽는다.

| 원본 필드                                       | 소비 방식                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `selectionRules.version`                        | 현재 선택·주기도 규칙 버전과 일치 확인                                |
| `selectionRules.minWindowDays`                  | 시간 최소값. 현재 주기로 나누어 최소 위상 폭 계산                     |
| `selectionRules.phaseWidthMax`                  | 공통 최대 위상 폭. 0보다 크고 1 이하인 유한값                         |
| `selectionRules.maxDurationMultipleOfSuggested` | 선택한 봉우리의 추천 시간에 곱하는 상한 계수. 3으로 하드코딩하지 않음 |
| `selectionRules.allowEmptyPhaseSpan`            | boolean 그대로 보존. 아래 미검증 경계 참고                            |
| `bundle.observationBounds`                      | 유한한 `[시작 BTJD, 끝 BTJD]`. 실제 관측 범위로 사용                  |

정상 메타데이터는 `kind: "ready"`, 누락·잘못된 구간 선택 전용 값은 `kind: "unavailable"`과 `issues`를 반환한다. 임의 기본값이나 프론트 계산 케이던스를 넣지 않는다. 이번에 추가한 선택 메타데이터 문제 때문에 기존 곡선 조회를 차단하지 않는다. 기존 `version`·`fineTune` 등 주기 선택 계약의 엄격한 응답 검사 자체는 바꾸지 않는다.

## 계산 함수와 반환값

[phase-selection.ts](../src/features/analysis/phase-selection.ts)는 React·DOM·Worker에 의존하지 않는 순수 함수다.

- `normalizePhaseRange(start, end)`: 두 주기 화면의 연속 좌표를 받아 시작만 `[0, 1)`로 정규화하고 폭을 보존한다. `-0.05~0.05`와 `0.95~1.05`는 같은 구간을 나타낸다. 끝점이 1보다 큰 상태를 허용하며 역전·폭 0·폭 1 이상·비유한 입력은 거절한다. 드래그 방향 정리는 후속 UI 책임이며 이 함수는 잘못된 순서를 몰래 뒤집지 않는다.
- `getSelectionLimits(context, periodogram, change)`: 문맥·선택 규칙·봉우리 규칙 버전, 주기도 범위와 실제 선택 봉우리의 미세 조정 범위를 확인한다. 최소 위상 폭은 `minWindowDays / periodDays`다. 최대 시간은 공통 위상 상한으로 계산한 시간과 **선택한 gridIndex**의 추천 시간 상한 중 작은 값이다. 직접 선택의 source는 null로 유지하며 근처 봉우리나 rank로 추정하지 않는다. 최소·최대가 양립하지 않으면 별도 오류를 반환한다.
- `closestEpoch(reference, period, center, bounds)`: 관측 범위 안에 놓이는 정수 주기 중 기준 시각에 가장 가까운 epoch를 고른다. 동률이면 더 이른 시각이다. 범위 끝점은 포함하며 가능한 epoch가 없거나 계산 가능한 정수 범위를 벗어나면 거절한다. 관측점을 순회하지 않고 가까운 주기와 범위 경계의 정수 후보만 확인한다.
- `previewPhaseSelection(...)`: 위 검사를 조합해 `kind: "preview"` 또는 `kind: "invalid"`를 반환한다. 입력·배열을 변경하지 않는다. 미리보기 시간은 `폭 × 주기`, 화면용 시간 단위는 여기에 24를 곱한다.

`normalizePhaseRange`·`getSelectionLimits`·`closestEpoch`는 위치·코드를 가진 `SelectionInputError`를 던지고, 화면 연결용 `previewPhaseSelection`은 이를 `issues: [{ field, code, message }]`로 반환한다. 예를 들어 폭 초과는 `selection.phaseEnd`, 잘못된 봉우리 출처는 `selection.sourcePeakGridIndex`, epoch 부재는 `selection` 위치의 오류다. 이 로컬 코드들은 서버 응답 코드가 아니다.

정상 미리보기의 `selection`에는 `periodDays`, `sourcePeakGridIndex`, `phaseStart`, `phaseEnd` 원본값만 둔다. `epochPreviewBtjd`, `durationPreviewDays`, `durationPreviewHours`는 별도 필드이며 서버 최종값이나 제출 원본값으로 취급하지 않는다. 제출 허가 플래그는 만들지 않는다.

### 샘플 계산

주기 2일을 직접 선택하고 위상 `0.95~1.05`, 기준 시각 100 BTJD, 관측 범위 90~110 BTJD를 넣으면 폭은 약 0.1, 가려진 시간은 약 0.2일 = **4.8시간**, 기준 시각 미리보기는 **100 BTJD**다. `phaseEnd`는 1.05를 유지한다. 값은 합성 계산 예시이며 실제 항성의 주기 추정 결과가 아니다.

테스트는 기존 [분석 샘플](../dev/analysis-fixtures.ts)·[주기도 샘플](../dev/periodogram-fixtures.ts)을 읽고 검사별로 규칙·시각을 명시적으로 바꾼다. 기존 예시의 최소 20분·최대 위상 0.25·추천 시간 계수 3은 운영 정책이나 서버 합의값으로 승격하지 않는다. 겹치는 봉우리·계수 2·폭 경계·거절 사례도 검사 코드에 고정한다.

## 검증과 미확정 경계

`apps/frontend`에서 `npm test`, `npm run build`로 계산 회귀·타입·배포 빌드·개발 코드 제외를 검사한다. Chrome이 설치되어 있으면 기존 화면 회귀는 다음 명령으로 확인한다.

```powershell
npx playwright test tests/browser/analysis-data.spec.ts tests/browser/periodogram-contract.spec.ts --project=chrome
```

2026-09-17 단위 검사 **115개(추가 16개)**, 타입·배포 빌드·개발 코드 제외 검사와 기존 데이터·주기도 Chrome 검사 **7개**를 확인했다. [추가 검사](../tests/unit/phase-selection.test.ts)는 FAV-07·08·09의 수치 부분을 다룬다. epoch 정수 후보 선택은 서로 다른 기준 시각·주기·중심·범위 144조합을 유한 주기 열거 결과와 비교했다. 선택 UI·예상 띠·제출 서버를 검사한 결과는 아니다.

- `allowEmptyPhaseSpan`의 관측점 포함 판정과 서버 공통 수치 허용 오차는 Q03/담당자 합의가 남아 있다. 이번 미리보기는 관측점 유무를 판정하지 않으며 `pendingChecks: ["phase-coverage", "server-validation"]`를 명시한다. 모든 값이 계산됐다는 이유로 제출을 허가하면 안 된다.
- 경계 비교에는 임의 epsilon이나 소수점 반올림을 넣지 않는다. 0.95 같은 십진수는 이진 부동소수점으로 표현되므로 반복 구간 정규화 결과의 끝자리는 다를 수 있다. 서버 공통 fixture로 허용 오차를 확정하기 전 비트 단위 동일성·왕복 인수를 주장하지 않는다.
- 키보드 핸들 간격과 빈 구간 정책은 해당 UI 구현 전에 확인한다. 메모 제한·판단/근거 입력은 4단계에서 현행 계약을 적용한다.
- FAV-04·10·31의 화면·초안 복구·복귀, #187 제출 경로를 통한 실제 서버 검증은 후속 단계다. 실제 API 없이 별도 검증 API를 가정하지 않는다.

이 단계는 기존 계약의 소비·계산 기반을 추가한다. API·DB·SRS 정책·디자인·기존 Worker 상태 전이는 변경하지 않는다.

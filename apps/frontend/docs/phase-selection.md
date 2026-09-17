# 위상 구간 선택·판단·제출 확인 개발 안내

대상은 [S15P21C206-185](https://ssafy.atlassian.net/browse/S15P21C206-185)이다. 2026-09-17 기준 **1단계 계산·검증 기반과 2단계 선택 밴드·핸들 구현**이며 실제 API 인수 완료를 뜻하지 않는다. 기능 기준은 [분석 프론트 명세 §5~6](../../../docs/development/analysis-frontend-spec.md), [SRS EXP-06·07·12 및 SUB-01·02](../../../docs/requirements/planetory-requirements-spec.md), 입력 계약은 [탐사 API §5.1·5.4·6.2](../../backend/docs/exploration-api-spec.md)를 따른다. 기존 [접기 개발 안내](phase-folding.md)의 최신 결과·실패 복구·32배 보기 계약을 유지한다.

## 작업 순서와 브랜치

| 단계 | 범위                                                        | 현재 상태      |
| ---- | ----------------------------------------------------------- | -------------- |
| 1    | 서버 선택 규칙 읽기, 위상 정규화, 시간 환산, 수치 오류 검사 | 로컬 구현·검증 |
| 2    | 접힌 그래프 선택 밴드·양 끝 핸들, 마우스·키보드             | 로컬 구현·검증 |
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

## 2단계 화면 사용과 상태 경계

[선택 UI](../src/features/analysis/PhaseSelection.tsx)는 접기 결과가 준비된 뒤 사용할 수 있다. 자동 제안 구간이나 BLS 정답으로 초기화하지 않는다.

- **기본 드래그:** 별도 버튼 없이 그래프에서 양방향으로 드래그해 새 구간을 선택한다. 음수 위상·1을 넘는 반복에서도 같은 구간으로 정규화한다. 실제 좌표는 반올림하지 않고 표시 문자열만 서식화한다. 단순 클릭·더블클릭이 기존 구간을 덮어쓰지 않도록 가로 3 CSS px 이상 움직인 경우에 드래그로 처리한다.
- **Shift+드래그:** 선택값을 바꾸지 않고 그래프를 가로 이동한다. 두 주기 표시 범위 밖으로 이동하지 않는다. 누르기 시작한 시점의 Shift 상태로 동작을 결정하며, 핸들에서는 Shift 여부와 무관하게 경계 조정을 우선한다.
- **구간 선택 시작:** 키보드 대체 경로다. 사용자가 누르면 화면 중앙에 최소·최대 허용 폭의 중간 폭으로 편집할 밴드를 만들고 시작 핸들에 포커스를 둔다. 추천 통과 위치나 제출 확정을 뜻하지 않는다. 그리기 모드 버튼은 제공하지 않는다.
- **시작·끝 핸들:** 위·아래에 각각 44px 이상의 조작 영역을 두어 좁은 구간에서도 겹치지 않는다. 방향키 간격·Shift 배수는 [상세 명세 §6](../../../docs/development/analysis-frontend-spec.md)의 사용자 결정을 따른다. Tab 순서는 시작→끝이며 핸들 키 입력은 차트의 방향키 동작으로 전파하지 않는다.
- **폭 오류:** 허용 범위 밖·역전·폭 0은 점선 밴드와 오류로 표시하며 유효 선택으로 내보내지 않는다. 최소·최대 폭으로 몰래 보정하지 않는다. 핸들로 다시 조정하거나 새 구간을 그릴 수 있다. 좌표 자체는 표시 가능한 두 주기의 바깥 경계로 제한한다.
- **보기와 취소:** 확대·보기 이동만으로 선택을 초기화하지 않는다. 보기 밖 핸들은 가장자리에 `↔`와 접근성 설명을 남기며 전체 보기로 확인할 수 있다. Esc·포인터 취소는 선택 드래그 직전 구간 또는 이동 드래그 직전 보기로 돌아간다. 선택 드래그 중 보기가 바뀌면 이전 좌표 매핑을 사용하지 않고 해당 제스처를 취소한다. 이동 중 휠로 배율을 바꾸면 해당 이동 제스처를 중단한다.
- **재접기:** 계산 중 편집을 즉시 잠그고 진행 중 드래그는 마지막 편집 완료 값으로 돌린다. 성공하면 선택 UI만 비우며 Canvas는 유지한다. 실패 시 마지막 성공 결과에 붙은 선택을 보존한다. 판단·메모까지 포함하는 원자적 초안 복구는 3~4단계에서 확장한다.

선택 상태는 Context의 밴드·요약 소비자에만 전달한다. 핸들 이동으로 Worker 재접기·API 요청·관측점 전체 재그리기를 유발하지 않는다. 드래그 안내는 영역 높이를 유지하고 이동 이벤트마다 상태 문구를 갱신하지 않는다. 범위가 계산상 유효해도 관측점 포함 여부·서버 검증은 여전히 미확정이며 제출 허가로 취급하지 않는다.

## 검증과 미확정 경계

`apps/frontend`에서 `npm test`, `npm run build`로 계산 회귀·타입·배포 빌드·개발 코드 제외를 검사한다. Chrome이 설치되어 있으면 기존 화면 회귀는 다음 명령으로 확인한다.

```powershell
npx playwright test tests/browser/analysis-data.spec.ts tests/browser/periodogram-contract.spec.ts --project=chrome
```

1단계에서 2026-09-17 단위 검사 **115개(추가 16개)**, 타입·배포 빌드·개발 코드 제외 검사와 기존 데이터·주기도 Chrome 검사 **7개**를 확인했다. [추가 검사](../tests/unit/phase-selection.test.ts)는 FAV-07·08·09의 수치 부분을 다룬다. epoch 정수 후보 선택은 서로 다른 기준 시각·주기·중심·범위 144조합을 유한 주기 열거 결과와 비교했다.

2단계에서 단위 115개와 빌드를 다시 통과했고, 아래 Chrome 검사 **22개(기존 접기 16개 + 선택 UI 6개)**를 통과했다. 포커스 복귀·재접기 중 드래그 중단 보완 후 선택 UI 6개와 빌드를 다시 확인했다.

기본 드래그 선택·Shift 이동 복원 후에는 Chrome **24개(기존 접기 16개 + 선택 UI 8개)**와 타입·배포 빌드·개발 코드 제외 검사를 통과했다. 버튼 없는 직접 선택, Shift 이동 중 선택·접기 revision·배율 유지와 API 추가 요청 없음, 이동 취소·경계 제한, Shift를 누른 핸들의 경계 조정 우선, 더블클릭 시 구간 보존을 추가로 확인했다. 기존 5185 서버에 연결한 로컬 설정으로 실행했으며 다른 브라우저·실제 API 인수는 포함하지 않았다.

```powershell
npx playwright test tests/browser/phase-selection.spec.ts tests/browser/folded-curve.spec.ts --project=chrome
# 화면 확인용 합성 데이터 서버
npm run dev -- --mode fixture --port 5185 --strictPort
```

확인 경로는 `http://127.0.0.1:5185/analysis/259377024?returnTo=%2Fsky`다. [화면 검사](../tests/browser/phase-selection.spec.ts)는 방향키·Shift 간격, 포커스, 두 반복의 경계 선택, 역방향 드래그, 폭 오류, Esc·포인터 취소, 확대 중 값 유지, 1024px 폭·44px 조작 영역, 규칙 누락, 재접기 잠금·실패 복원·성공 초기화를 다룬다. 핸들 키 입력 전후 API 요청 0건과 해당 Canvas의 `clearRect` 추가 호출 0건을 확인했다. 이는 동작 회귀 검사이며 프레임 시간 벤치마크나 모든 렌더러 성능 검증은 아니다.

Windows에서 검사 완료 후 Vite 종료가 대기하여 해당 테스트 서버만 종료했다. 후속 6개 검사는 5185 서버에 연결한 로컬 임시 설정으로 실행했다. [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)를 참고해 이름·포커스·상태 알림·조작 영역·가로 넘침을 검토했다. 기본 Chrome 캡처가 빈 이미지로 저장되어 별도의 GPU 비활성화 Chrome에서 시각 확인했다. Edge·Firefox·Safari, 실제 보조기술, 시간 곡선 예상 띠·제출 서버는 이번 검증에 포함하지 않았다.

- `allowEmptyPhaseSpan`의 관측점 포함 판정과 서버 공통 수치 허용 오차는 Q03/담당자 합의가 남아 있다. 이번 미리보기는 관측점 유무를 판정하지 않으며 `pendingChecks: ["phase-coverage", "server-validation"]`를 명시한다. 모든 값이 계산됐다는 이유로 제출을 허가하면 안 된다.
- 경계 비교에는 임의 epsilon이나 소수점 반올림을 넣지 않는다. 0.95 같은 십진수는 이진 부동소수점으로 표현되므로 반복 구간 정규화 결과의 끝자리는 다를 수 있다. 서버 공통 fixture로 허용 오차를 확정하기 전 비트 단위 동일성·왕복 인수를 주장하지 않는다.
- 핸들 키보드 간격은 2026-09-17 사용자 답변으로 결정했다. 빈 구간 정책·서버 수치 허용 오차는 아직 합의가 필요하다. 메모 제한·판단/근거 입력은 4단계에서 현행 계약을 적용한다.
- FAV-10의 핸들·확대 조합 일부를 확인했다. FAV-04·10·31의 전체 단계·초안 복구·복귀와 #187 제출 경로를 통한 실제 서버 검증은 후속 단계다. 실제 API 없이 별도 검증 API를 가정하지 않는다.

1~2단계는 기존 계약의 계산·선택 UI를 추가하고 핸들 키보드 간격 결정을 상세 명세에 반영한다. API·DB·SRS 정책·디자인·기존 Worker 상태 전이는 변경하지 않는다.

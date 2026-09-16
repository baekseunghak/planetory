# 위상 접기 계산과 Worker 기반

`S15P21C206-184` 1·2단계 구현 기록이다. 현재 곡선의 전 점 접기와 Worker 수명·대기열에 주기 선택 이후 그래프 표시·확대를 연결했다. 성공 주기·그래프·초안의 원자적 UI 복구는 3단계에서 연결한다. 디자인 변경과 직접 선택 주기의 미세 조정은 포함하지 않는다.

기준은 [분석 프론트 명세 §5·6](../../../docs/development/analysis-frontend-spec.md), [요구사항 EXP-08·DAT-11](../../../docs/requirements/planetory-requirements-spec.md), [탐사 API](../../backend/docs/exploration-api-spec.md)다. 기존 실험의 Worker 재사용·최신 입력 대기 구조를 운영 코드에 적용했으며 `experiments`를 import하지 않는다. API 초안과 합성 응답 검증은 실제 서버 연동 완료를 의미하지 않는다.

## 입력과 계산

[buildFoldData](../src/features/analysis/fold-data.ts)는 #182에서 해석한 `AnalysisContext`와 `CurveData`를 받는다. 현재 문맥의 준비된 곡선인지 검사하고 각 세그먼트에서 다음과 같이 시각을 복원한다.

```text
BTJD[i] = startBtjd + i × binMinutes / 1440
phase[i] = positive_mod((BTJD[i] - foldReferenceTimeBtjd) / periodDays, 1)
```

화면 시간축의 공백 압축·확대 범위·정정 주기를 사용하지 않는다. 서버의 Bundle 공통 기준 시각을 그대로 사용하며 중앙값을 다시 계산하지 않는다. 위상은 `[0, 1)`이고, 표시 반올림·재비닝·정렬 없이 원본 순서로 계산한다. 부동소수점 경계에서 음의 0과 1로 반올림된 작은 음수 나머지는 0으로 정규화한다. 비유한 값, 0 이하 주기, 안전한 정수 범위를 초과하는 반복 횟수는 오류로 처리한다.

`null` 밝기만 제외하고 밝기 0은 보존한다. 각 유효점에는 실제 BTJD·밝기·segmentId·Sector·원본 배열 index가 남는다. 유효점 0개는 빈 입력으로 구분하며 성공 접기나 과학적 무신호 판단으로 취급하지 않는다. Worker의 빈 시각 배열 요청은 실패한다.

`dataId`는 TIC·곡선 문맥(Bundle·제거 후보·계산 버전 포함)·기준 시각·세그먼트 revision/시각/간격/개수를 함께 식별한다. 배열은 해당 revision의 불변 응답이라는 계약을 따른다. 새 문맥에서는 기존 client를 dispose하고 새 client를 만든다.

## Worker 사용 계약

[FoldClient](../src/features/analysis/fold-client.ts)는 곡선당 하나를 생성한다. 큰 시각 배열은 초기화 때 한 번 복제하고, 이후에는 주기·revision만 보낸다. 메인 스레드의 시간 곡선 배열은 transfer로 분리하지 않는다. Worker는 결과 `Float64Array`의 버퍼를 transfer한다.

```text
init { dataId, times, reference } → ready / init-error
fold { dataId, revision, period } → folded { phases } / fold-error
```

주기 입력마다 client 내부 revision이 증가한다. 실행 중 작업 1개와 최신 대기 입력 1개만 유지하고 프레임마다 최신 대기값을 전달한다. 교체된 요청은 `null`로 종료하며 늦은 성공·실패와 다른 문맥/다른 Worker의 응답은 적용하지 않는다. 큰 배열을 주기 입력마다 보내거나 BLS·잔차 API를 호출하지 않는다.

정상 결과는 `{ dataId, revision, periodDays, phases }`다. 호출자는 Promise 결과가 `null`인지 확인한 뒤 **상태 적용 직전에 `client.isCurrent(result)`도 확인**해야 한다. Promise가 성공한 직후 새 입력이 들어오거나 client가 폐기될 수 있기 때문이다. 이 revision은 client 계산 수명 안의 번호이며 #183 주기 이벤트의 revision과 동일하다고 가정하지 않는다. 화면 연결에서 원래 이벤트와 계산 결과를 함께 관리한다.

- `cancel()`은 Worker·예약 프레임·감시 타이머를 해제하고 현재 요청을 `null`로 종료한다. 다음 요청으로 다시 초기화할 수 있다.
- `dispose()` 후에는 요청을 실행하지 않는다. 별·Bundle·곡선 전환과 화면 해제 시 사용한다.
- Worker 시작/전송/응답 해석 오류와 무응답은 최신 요청을 실패시키고 다음 요청에서 새 Worker를 만든다.
- 계산 오류나 잘못된 결과의 길이·위상 값은 실패로 반환한다. 정상 캐시는 다음 주기 요청에서 재사용한다.
- `timeoutMs`는 생성자가 반드시 전달하는 운용 설정이다. 기본 15초나 제품 응답시간 목표를 두지 않았다. 초기화와 실행 작업을 각각 감시하며 새 대기 입력이 기존 실행의 감시 시간을 연장하지 않는다. 화면 연결 시 설정 근거와 취소·재시도 안내를 함께 정해야 한다.

[Worker 계산부](../src/features/analysis/fold-worker-core.ts)는 초기화 실패 시 이전 캐시를 비운다. [Worker 진입점](../src/features/analysis/fold.worker.ts)은 메시지 처리와 결과 버퍼 전송만 담당한다.

## 검증 기록과 한계

2026-09-16에 다음을 실행했다.

- 단위 테스트 전체 **85개 통과**: 새 접기 테스트 18개 포함. 원본 위치·다중 Sector 실제 시각·0/결측 구분, 수치 경계·잘못된 입력, 10만 점 결과 보존, 초기화 재사용, 연속 입력 100건의 대기열 상한, 늦은/다른 문맥 응답, 오류·무응답·취소·폐기·재시도를 검증했다.
- Chromium의 실제 module Worker 테스트 **1개 통과**: Vite를 통한 Worker 시작, 원본 배열 보존, 주기별 계산 결과, 연속 입력 교체, 현재 결과 식별을 확인했다. 테스트의 5초 감시는 제품 제한이 아니다. 검증 후 Windows의 테스트용 Vite 서버 종료에서 대기해 이번 실행의 경로·포트를 확인하고 해당 프로세스만 종료했다. 이후 테스트 러너는 `1 passed`, 종료 코드 0으로 끝났다.
- 타입 검사·프로덕션 빌드·개발 fixture 배포 제외 검사·변경 파일 포맷 검사를 통과했다.

위 내용은 1단계 당시의 검증이다. 당시에는 화면에 연결하지 않아 새 Worker의 프로덕션 번들 연결을 검증하지 않았으며, 아래 2단계에서 추가 확인했다. 10만 점 테스트는 결과 보존 검사이며 성능 목표 충족 증거가 아니다. 실제 API, 실제 세 항성의 접힌 화면, D20 서버 공통 수치 fixture 비교와 epoch·duration 검증은 후속 작업으로 남긴다.

## 2단계: 주기 선택과 그래프 연결

[PeriodSelectionWorkspace](../src/features/analysis/PeriodSelection.tsx)의 주기 변경 이벤트를 [접기 패널](../src/features/analysis/FoldedCurvePanel.tsx)에 연결했다. 추천 봉우리 선택과 직접 주기 선택 모두 Worker로 현재 곡선을 접는다. 직접 선택의 미세 조정은 계속 보류한다. API 응답/필드나 샘플 데이터를 바꾸지 않았고 주기 조작으로 BLS·잔차 API를 호출하지 않는다.

[접힌 곡선](../src/features/analysis/FoldedCurveChart.tsx)은 원본 관측점별 위상을 `-0.5~1.5`의 두 주기에 반복 표시한다. 과학 계산 입력은 늘리지 않으며 관측점을 선으로 이어 공백을 채우지 않는다. 새 봉우리/주기를 선택하면 ×1, 같은 주기를 미세 조정하면 가로 배율만 유지하고 표시 중심은 0.5로 돌아간다. 새 주기 선택 직후 미세 조정이 이어져 앞 계산이 생략되어도 새 선택의 ×1 초기화 의미를 보존한다.

- 휠은 포인터 아래 위상을 유지하며 x축만 ×1·2·4·8로 확대한다. 브라우저 확대에 쓰는 Ctrl/Meta+휠은 가로채지 않는다.
- 그래프의 +/−는 중앙 기준 확대/축소, 0·Home·더블클릭은 전체 보기, ←/→ 또는 이동 버튼은 가로 이동이다. 확대만으로 y축 범위를 바꾸지 않는다.
- 관측점에 포인터를 올리거나 그래프에서 ↑/↓를 누르면 원본 순서의 BTJD·Sector·위상·밝기를 텍스트로 확인한다. Canvas는 보조기술에서 숨기고 조작 가능한 그룹·설명·수치 대안을 제공한다.
- 같은 Canvas를 유지하고 실제 크기/DPR 변화 때만 해상도를 재설정한다. 화면 크기 변경과 배율 변경에 맞춰 다시 그린다.

처음에는 주기 선택 안내를 표시한다. 계산 중에는 마지막 성공 그래프를 유지하고 상태 문구와 `접기 취소`를 제공한다. 실패·취소 시 `접기 다시 계산`을 제공하며 성공 결과가 없다면 가짜 빈 그래프를 만들지 않는다. 그래프에는 계산을 완료한 주기를 별도로 적는다. **이 단계는 실패 시 주기 입력·초안을 성공 상태로 함께 되돌리지 않는다.** 그 원자적 복구와 후속 입력 잠금은 3단계 범위다. 구간 선택·판단·제출 UI도 아직 없다.

연결부의 무응답 감시는 임시 30초로 설정했다. 화면이 무한히 계산 상태로 남는 것을 막는 운용 안전장치이며 실측 응답시간 목표나 서버 과학 계약이 아니다. 1단계의 15초 실험 상수를 가져오지 않았고 자동 재시도도 하지 않는다. 성능 실측·운용 기준 확정은 후속 검증에서 다룬다.

### 샘플로 확인하기

로컬 #184 서버의 `/analysis/259377024?returnTo=%2Fsky`에서 `1위 봉우리 선택`을 누른다. 이 샘플은 Sector 14의 **합성 밝기 1,009점**, 합성 주기도 5,000점과 추천 봉우리 3개를 사용한다. 서버가 접힌 결과를 반환하는 방식이 아니라 기존 곡선 응답을 Worker가 선택 주기로 접어 표시한다. 실제 BLS 탐지·실제 항성의 통과 신호를 보여 준다고 해석하지 않는다. 실제 세 항성은 주기도 미연결 상태를 유지한다.

### 2단계 검증과 접근성 검토

2026-09-16 기준 타입·빌드·개발 fixture 배포 제외, 단위 88개, Chromium 프로젝트 49개, 프로덕션 3개를 확인했다. 첫 Chromium 실행에서는 기존 검사 포함 46개가 통과했고 새 검사 3개는 샘플 점 수(11이 아닌 1,009), WheelEvent의 정수 픽셀 좌표, 앱의 최소 지원 폭(1,024px)을 잘못 가정해 실패했다. 테스트만 수정한 뒤 새 파일 5개가 모두 통과했다. 실제 배포 빌드의 `fold.worker-*.js`를 로드해 테스트에서 가로챈 API 응답을 접는 것도 확인했다. 실제 백엔드 연결 검증은 아니다.

개발 화면에서도 봉우리 선택→접기 성공→×2 확대를 직접 확인했다. [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)를 기준으로 변경 파일의 레이블·키보드·포커스·상태 알림·제스처 대안·오류 재시도·줄바꿈을 검토했다. [FoldedCurveChart.tsx](../src/features/analysis/FoldedCurveChart.tsx), [FoldedCurvePanel.tsx](../src/features/analysis/FoldedCurvePanel.tsx), [folded-curve.css](../src/features/analysis/folded-curve.css)에서 이번 범위의 미해결 지적은 없다. 실제 스크린리더·Safari 검증은 하지 않았다. 반응형은 현행 지원 범위인 폭 1,024px 이상에서 확인했고, 그 미만의 데스크톱 이용 안내 정책은 유지한다.

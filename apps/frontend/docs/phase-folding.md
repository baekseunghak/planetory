# 위상 접기 계산과 Worker 기반

`S15P21C206-184` 1단계 구현 기록이다. 현재 곡선의 전 점 접기와 Worker 수명·대기열을 구현했고 화면에는 아직 연결하지 않았다. 주기 선택 이후 그래프 표시·확대는 2단계, 성공 주기·그래프·초안의 UI 복구는 3단계에서 연결한다. 디자인 변경과 직접 선택 주기의 미세 조정은 포함하지 않는다.

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

아직 페이지가 FoldClient를 사용하지 않아 프로덕션 페이지 번들에 Worker는 포함되지 않는다. 위 빌드는 기존 앱 회귀 확인이고, 새 Worker의 프로덕션 번들 연결은 2단계에서 확인한다. Canvas·후속 입력 잠금·UI 원자적 복구·접근성은 아직 구현/검증하지 않았다. 10만 점 테스트는 결과 보존 검사이며 성능 목표 충족 증거가 아니다. 실제 API, 실제 세 항성의 접힌 화면, D20 서버 공통 수치 fixture 비교와 epoch·duration 검증은 후속 작업으로 남긴다.

# 200 일별 중앙값 비교와 해석 안내

- Jira: S15P21C206-200
- 상태: 프론트 구현·합성 HTTP 검증, 실제 API 인수 대기
- 기준: develop `bdafb0ce`. 199 미병합 브랜치를 가져오지 않고 독립적으로 개발한다.
- 정본: [서비스 API 12.2.1](../../backend/docs/service-api-spec.md), [통계 지표 사전](../../../docs/requirements/planetory-statistics-policy.md)

## 구현

P1 활성화 시 `/me?section=statistics`의 기존 개인 통계 아래 비교 영역을 표시한다. `GET /api/v1/me/statistics` 한 번의 응답에서 current와 comparison을 읽는다. 별도 전체 API 요청·영속 캐시·DB 변경은 없다. 타인 프로필에는 노출하거나 요청하지 않는다. current가 유효하고 comparison만 손상되면 현재 통계는 유지하고 비교 영역에 오류와 재시도를 표시한다. HTTP 실패·인증 만료·취소는 기존 공통 경로를 사용한다.

공통 4지표의 서버 중앙값과 myValue만 사용한다. 현재 개인 값으로 과거 본인 값을 대신하지 않는다. 성공 기준일, 누적 계산 종료, 원천 관측 시각, 집계 완료와 90일 모수 선정 기간을 구분한다. 모수 전체 회원 수와 지표별 유효 표본 수를 표시한다. 순위·백분위·우열·맞춘 개수는 계산하지 않는다.

UNAVAILABLE은 준비 중, STALE은 마지막 성공본 유지, 중앙값 0은 유효한 0, NO_SAMPLE은 표본 없음으로 표시한다. 본인 값의 HISTORICAL_SOURCE_UNAVAILABLE은 당시 자료 부족, JOINED_AFTER_CUTOFF는 가입 전 기준 통계다. inCohort=null은 포함 여부 미확정으로 유지한다.

현재 백엔드는 과거 본인 값을 재현하지 못하므로 정상적으로 본인 비교 막대가 표시되지 않는다. 중앙값은 텍스트로 제공한다. 두 값 모두 AVAILABLE일 때만 동일 너비의 두 셀 안에 같은 척도의 막대를 표시하며 원래 수치를 표에 함께 제공한다. 이 분기는 현재 백엔드의 구현 완료를 의미하지 않는다.

## 검증

- `npm run build`: 타입·번들·운영 fixture 제외 검사 통과. 기존 Vite 경고 유지.
- `npm test`: 438개 통과(200 신규 4개 포함, 아직 병합되지 않은 199 테스트 제외).
- Chromium: 기존 개인 5개와 비교 상태 3개 통과. 과거 값 대체 금지, 시각·90일 안내, 1024px·표 포커스, STALE·가입 전·표본 없음, 비교 손상 시 현재값 보존과 재시도를 확인했다.
- 막대 셀 너비를 동일하게 지정한 뒤 비교 가능한 합성 값(25%/50%)의 실제 막대 길이 1:2와 과거 값 부재 시 막대 없음 2개를 추가 실행해 통과했다. 최종 타입·비교 파서 4개 재검증도 통과했다.
- web-design-guidelines 기준 caption·scope·포커스·알림 밖 재시도 버튼·빈 상태·숫자/시각 서식을 검토했다. 실기기 스크린리더 검증은 하지 않았다.

```powershell
cd apps/frontend
npm ci --ignore-scripts
npx playwright test --config=playwright.comparison.config.ts --project=chromium
```

profiles/P1 서버 58400을 사용한다. 이번 실행은 수동 시작한 같은 서버를 재사용했고 테스트 명령 exit 0을 확인했다. 테스트 fixture는 실제 운영 자료가 아니다. `tests/fixtures/comparison.ts`는 PersonalStatisticsService·StatisticsSnapshotService의 현행 응답을 따른다. 비교 가능한 본인 값 사례는 별도 브라우저 테스트에서만 만든 가상 계약 사례로, 실계정에서 도달했다고 주장하지 않는다.

## 남은 인수

정적 검토 후 `asOf`와 `cohortEnd`의 동등성 검사를 문자열 대신 시각 값으로 비교하도록 보완했다. `Z`와 `.000Z`는 같은 시각으로 수용하고 응답 원문은 보존한다. 1ms 차이는 계속 거절한다. 양쪽 필드의 표기 차이·시각 차이 회귀 검사 2개를 추가했으며 타입·diff 검사와 비교/개인 통계 단위 검사 12개가 통과했다. 이 파서 보완 후 전체 테스트와 브라우저 검사는 반복하지 않았다.

실제 계정의 대표·빈·가입 전 응답과 DB Snapshot, 갱신 전후·지연 시각을 대조해야 한다. 현재 계약에서는 과거 본인 값이 없어 실제 두 막대 비교 인수를 완료할 수 없다. 과거 원천 확보는 별도 백엔드 계약 작업이며 현재값으로 우회하지 않는다. 실제 API 및 배포·다른 브라우저·스크린리더 인수는 미수행이다. 기존 P1 Docker 빌드 활성화 연결도 별도이며 이번 변경에 포함하지 않는다. Jira 완료·커밋·푸시는 하지 않는다.

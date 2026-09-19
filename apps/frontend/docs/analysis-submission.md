# #187 분석 제출 접수·복구 개발 안내

2026-09-19 기준 `S15P21C206-187`의 계약 확정 기록이다. 기준은 [탐사 API 2.2·2.3·6.1~6.6](../../backend/docs/exploration-api-spec.md), [탐사 API C02 계약 예제](../../../docs/api/exploration/contracts.json), [분석 프론트 명세](../../../docs/development/analysis-frontend-spec.md)와 Jira A06-1의 완료 조건이다. 앞선 [#182 분석 읽기](analysis-data.md), [#185 판단·제출값 확인](phase-selection.md)의 `CandidateReview`를 사용한다.

**현재 범위:** 제출 요청 본문 구성, 요청 ID 생성·보존, 접수 결과 파싱, 응답 유실 복구를 fixture로 구현한다. **실제 서버에는 제출 엔드포인트가 아직 없다**(`apps/backend/src/main`에 `submissions` 컨트롤러 0건, C10 = `S15P21C206-142`·`143`이 「해야 할 일」). 티켓 완료 조건인 실제 API 인수와 강재민의 DB 증거는 그 뒤에 수행하며, **이 MR로 티켓을 닫지 않는다.**

## 엔드포인트

| 요청                                             | 용도                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `POST /api/v1/stars/{ticId}/submissions`         | 제출값 확인 단계의 [제출]. 본문 `requestId`가 멱등 단위 |
| `GET /api/v1/submissions/by-request/{requestId}` | 응답 유실 복구. 조회 전용이며 접수를 만들지 않는다      |

탐사 API의 모든 응답에 `X-Current-Bundle` 헤더가 붙는다(D-5). 쓰기는 이와 별개로 `BUNDLE_CHANGED`로 거절되므로, 제출 경로에서는 헤더를 판 교체 **감지**에만 쓰고 헤더만 보고 재전송하지 않는다.

## 응답과 처리

| HTTP·코드                    | 뜻                                                | 프론트 처리                                                                       | 요청 ID   |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- | --------- |
| 201                          | 새 접수                                           | 접수 확정                                                                         | 소비      |
| 200                          | 같은 ID·같은 본문 재전송                          | 저장된 결과 재현. 새 행·성과 없음(SUB-09)                                         | 소비      |
| 400 `VALIDATION_FAILED`      | 6.2절 검증 실패                                   | `fieldErrors[]`를 해당 입력 옆에 표시. Submission·History 없음                    | 보존      |
| 400 `EPOCH_OUT_OF_RANGE`     | 관측 범위 안 epoch 없음                           | 위상 선택으로 되돌린다                                                            | 보존      |
| 401                          | 인증 만료                                         | 공용 클라이언트의 `onUnauthorized`가 처리                                         | 보존      |
| 403 `STAR_LOCKED`            | 별이 열리지 않음                                  | 분석 진입 자체가 무효. 재시도하지 않는다                                          | 폐기      |
| 404 `STAR_NOT_PUBLISHED`     | 없는 TIC·비공개                                   | 존재를 드러내지 않는다                                                            | 폐기      |
| 409 `IDEMPOTENCY_CONFLICT`   | 같은 ID·**다른** 본문                             | 저장된 결과를 재현하지 않고 거절. 본문이 바뀌었으므로 새 ID로만 다시 보낼 수 있다 | **새 ID** |
| 409 `REQUEST_IN_PROGRESS`    | 같은 ID 처리 중                                   | by-request로 확인 후 같은 ID로 재전송                                             | 보존      |
| 409 `BUNDLE_CHANGED`         | 판·계산 버전이 현재와 다름                        | EXP-01대로 최신 판 재조회. 곡선 단계·제거 조합 유지, 주기·위상 초기화(AT-117)     | **새 ID** |
| 409 `STAR_ALREADY_COMPLETED` | 완료된 별에 `no_candidate`                        | 저장되지 않음                                                                     | 폐기      |
| 409 `SKIP_NOT_AVAILABLE`     | 건너뛰기 조건 미충족                              | 저장되지 않음                                                                     | 폐기      |
| 응답 유실                    | 타임아웃·취소·5xx·본문 파손·전송 후 네트워크 끊김 | **결과 불명.** 새 ID를 만들지 않고 by-request로 복구                              | 보존      |

`by-request` 조회는 200 같은 본문 / 404 미접수 / 409 `REQUEST_IN_PROGRESS`다.

### 404를 미접수로 단정하지 않는다

명세 6.6절은 404를 「미접수, 같은 ID로 재전송」으로 적고, Jira는 「조회 404를 무조건 미접수로 단정하지 않는다」고 적는다. 두 문장은 충돌하지 않는다. **어느 쪽이든 새 ID를 만들지 않고 같은 ID로 재전송**하면 된다. 실제로 접수돼 있었다면 200 재현이 오고, 미접수였다면 201이 온다. 프론트가 404를 근거로 "제출되지 않았습니다"라고 **단정해 안내하지 않는 것**이 지켜야 할 규칙이다.

## 요청 ID 규칙

ID는 UUID v4이며 본문 `requestId`에 싣는다(2.2절). 서비스 API에는 요청 키가 없으므로(SB-D17) 이 본문 필드가 유일한 멱등 키다.

**새 ID를 만드는 경우는 둘뿐이다.**

1. 사용자가 판단·근거·메모·선택을 바꿔 **의도적으로 다시 제출**할 때
2. `BUNDLE_CHANGED`·`IDEMPOTENCY_CONFLICT`로 본문을 새로 구성해야 할 때

**같은 ID를 유지하는 경우:** 응답 유실, `REQUEST_IN_PROGRESS`, by-request 404, 타임아웃, 네트워크 오류, 사용자의 단순 [다시 시도], 페이지 새로고침.

미해결 ID가 남아 있는 동안에는 **초안을 잠근다.** 잠그지 않으면 사용자가 메모를 고친 뒤 복구 재전송이 나가 `IDEMPOTENCY_CONFLICT`가 되고, 실제로 접수된 결과를 확인할 방법이 사라진다.

### 보존 위치

ID는 새로고침을 넘겨야 하므로 `sessionStorage`에 회원·TIC 단위로 저장한다. 키는 `planetory:analysis-draft:` 접두사를 공유해 [로그아웃 시 초안 정리](../src/auth/session-draft-storage.ts)가 함께 지우도록 한다. 공용 파일을 수정하지 않는다.

저장값에는 ID와 함께 **본문 지문**을 둔다. 복구 재전송 전에 지금 만든 본문이 그 지문과 같은지 확인하고, 다르면 보존 ID를 쓰지 않는다.

## 특수 제출 (6.5절)

| 종류           | 본문                                                           | 비고                                                                   |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `candidate`    | `selection`·`userJudgment`·`evidenceChecks`·`memo`·`viewState` | 기존 `CandidateReview`                                                 |
| `no_candidate` | `selection`·`userJudgment`·`evidenceChecks` **없음**           | 이전 후보의 수치·판단·근거를 섞지 않는다(완료 조건). 완료된 별이면 409 |
| `skipped`      | 같이 없음                                                      | 튜토리얼 별의 조건 충족 시에만. 아니면 409                             |

`no_candidate`는 "더 없음"이지 "모르겠음"이 아니다. `UNSURE` 판단을 담은 `candidate` 제출과 본문·의미가 모두 다르다.

## 합성 응답의 원리

[submission-fixtures.ts](../dev/submission-fixtures.ts)는 개발 서버에서만 쓰는 `submission-fixture-187-v1`이다. **서버를 다시 구현한 것이 아니다.** 멱등 저장소와 프론트가 실제로 틀릴 수 있는 검사(요청 ID, 판, 곡선 단계, 종류별 필드, enum, 위상 규칙)만 두고 후보 매칭·성과 판정·격자 대조는 실제 서버(C10)에 맡긴다. 상태는 이 개발 프로세스 안에만 있고 서버를 다시 띄우면 지워진다.

시나리오 대부분은 **진짜 상태에서 나온다.** 저장소가 있으므로 같은 ID·같은 본문 재전송은 저장된 결과를 실제로 재현하고, 다른 본문은 본문 지문이 달라 거절된다. 판 교체·검증 실패도 실제 대조 결과다. 가짜로 만들 수 없는 것은 **응답 유실**과 **처리 중** 둘뿐이라 이 둘만 개발 전용 헤더 `X-Fixture-Submit`으로 받는다. 앱은 이 헤더를 보내지 않으며 테스트와 수동 확인만 사용한다.

| 값             | 재현하는 상황                                                       |
| -------------- | ------------------------------------------------------------------- |
| `drop-saved`   | 접수까지 끝난 뒤 소켓을 끊는다. by-request가 200을 준다             |
| `drop-unsaved` | 접수 전에 끊는다. by-request 404 뒤 같은 ID 재전송이 201이어야 한다 |
| `in-progress`  | POST와 첫 by-request가 409, 그다음 조회가 200                       |

응답 유실은 상태 코드를 주지 않고 소켓을 끊어 재현한다. 상태 코드가 **없는 것**이 요점이다. 공용 클라이언트가 이때 `outcomeUnknown`을 켜므로 프론트는 이 값을 복구 진입 조건으로 쓴다.

새 TIC을 만들지 않고 [#183 주기도 정상 샘플](periodogram-data.md) `259377024`를 그대로 쓴다. 별 접근 거절(403·404·503)은 분석 진입 응답을 그대로 재사용해 한 곳에서 판정한다.

## 직접 확인

`npm.cmd run dev:fixture`는 58267 포트다. 쓰기에 필요한 토큰은 `GET /api/v1/auth/csrf`가 준다.

```powershell
$base = 'http://127.0.0.1:58267/api/v1'
$csrf = Invoke-RestMethod "$base/auth/csrf"
$context = Invoke-RestMethod "$base/stars/259377024/analysis-context"
$body = @{
  requestId = [guid]::NewGuid().ToString()
  submissionKind = 'candidate'
  curveContext = $context.currentCurveContext
  selection = @{ periodDays = 11.7346; sourcePeakGridIndex = 3600; phaseStart = 0.49; phaseEnd = 0.51 }
  userJudgment = 'LIKELY_PLANET'
  evidenceChecks = @('oddeven')
  memo = '합성 확인'
  retryOfSubmissionId = $null
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/stars/259377024/submissions" -Method Post -Body $body `
  -ContentType 'application/json' -Headers @{ 'X-CSRF-TOKEN' = $csrf.token }
```

같은 본문을 한 번 더 보내면 201이 아니라 200이 오고 `submissionId`가 같다. 유실·처리 중을 보려면 `-Headers`에 `'X-Fixture-Submit' = 'drop-saved'`를 더한다.

회귀는 [submission-contract.spec.ts](../tests/browser/submission-contract.spec.ts)가 같은 경로를 HTTP로 9건 검사한다.

## 미결

- **`fieldErrors` 필드 이름이 문서와 구현에서 다르다.** 명세 6.2절 예제와 `contracts.json`은 `{field, message}`인데, 구현된 [`ErrorResponse.FieldError`](../../backend/src/main/java/com/planetory/backend/global/error/ErrorResponse.java)는 `(field, reason)`이고 공용 클라이언트도 `reason`을 읽는다. **구현을 따른다.** 문서 예제 쪽 수정이 필요하며 전달 항목으로 남긴다.
- **메모 길이.** 명세 6.1절은 `0~2,000 코드포인트 확인 필요`, 구현은 `MEMO_LIMIT = 200`이다. 서버 검증이 없는 동안에는 늘려도 확인할 방법이 없으므로 **200을 유지**한다. C10 연동 때 실제 상한으로 맞춘다.
- **ID 보존 기간.** 2.2절이 C02/C10 계약에 넘겼고 아직 값이 없다. 현재는 세션 수명(탭 종료까지)으로 두었다.
- **`retryOfSubmissionId`.** [다시 풀기](6.8절)는 `S15P21C206-192` 범위다. 이 티켓에서는 항상 `null`로 보낸다.

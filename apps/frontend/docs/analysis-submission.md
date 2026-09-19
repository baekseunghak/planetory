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

[submission-request.ts](../src/features/analysis/submission-request.ts)가 `sessionStorage`에 회원·TIC 단위로 저장한다. 키는 `planetory:analysis-draft:` 접두사를 공유해 [로그아웃 시 초안 정리](../src/auth/session-draft-storage.ts)가 함께 지우도록 한다. 공용 파일을 수정하지 않는다. 접두사가 바뀌면 조용히 깨지는 전제이므로 [submission-request.spec.ts](../tests/browser/submission-request.spec.ts)가 실제 브라우저에서 지워지는지 확인한다.

저장값에는 ID와 함께 **본문 지문**을 둔다. `reserveRequestId`는 저장된 지문이 지금 본문과 같으면 그 ID를 그대로 쓰고, 다르면 사용자가 본문을 바꾼 것이므로 새로 만든다. **새 ID 생성은 이 한 곳에서만 일어난다.**

지문은 키 순서와 무관하고 `requestId`를 빼고 계산한다. 지금 정하려는 값이 그것이기 때문이다. 유한하지 않은 수는 따로 적는다. `JSON.stringify`가 `NaN`·`Infinity`·`null`을 모두 `null`로 만들어 서로 다른 본문이 같은 지문을 갖게 되면, 다른 본문을 같은 ID로 보내 `IDEMPOTENCY_CONFLICT`가 난다.

개발용 응답에도 같은 계산이 있지만 **일부러 공유하지 않는다.** 한쪽이 틀려도 양쪽이 같이 틀리면 검사가 통과해 버린다. 서버 자리의 계산과 클라이언트의 계산은 따로 두어야 어긋남이 드러난다.

### 저장소를 쓸 수 없을 때

비공개 모드나 차단된 사이트 데이터에서는 `sessionStorage` 접근 자체가 던진다. 이때도 **제출을 막지 않는다.** ID는 이번 시도에서 유효하고 잃는 것은 새로고침 뒤의 복구뿐이므로, `ReservedRequest.volatile`로 알리고 화면이 그 사실을 안내한다.

손상된 기록은 쓰지 않고 지운다. 이 경우 같은 본문에 새 ID가 붙어 중복 접수가 될 수 있지만, 깨진 ID로 **남의 결과를 내 접수로 받아오는 것**보다 낫다.

## 특수 제출 (6.5절)

| 종류           | 본문                                                           | 비고                                                                   |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `candidate`    | `selection`·`userJudgment`·`evidenceChecks`·`memo`·`viewState` | 기존 `CandidateReview`                                                 |
| `no_candidate` | `selection`·`userJudgment`·`evidenceChecks` **없음**           | 이전 후보의 수치·판단·근거를 섞지 않는다(완료 조건). 완료된 별이면 409 |
| `skipped`      | 같이 없음                                                      | 튜토리얼 별의 조건 충족 시에만. 아니면 409                             |

`no_candidate`는 "더 없음"이지 "모르겠음"이 아니다. `UNSURE` 판단을 담은 `candidate` 제출과 본문·의미가 모두 다르다.

### 섞이지 않게 만드는 방법

[submission-input.ts](../src/features/analysis/submission-input.ts)의 특수 제출 생성기는 **선택·판단·근거를 인자로 받지 않는다.** 만든 뒤 지우는 방식이면 나중에 필드가 하나 늘었을 때 지우는 쪽을 빠뜨린다. 처음부터 받지 않으면 빠뜨릴 것이 없다. 재현용 `viewState`도 넣지 않는다. 보내지 않은 선택을 어디서 보고 있었는지는 이 제출의 의미가 아니다.

일반 제출은 #185가 만든 제출값 확인 스냅샷을 **깊은 복사**해서 보낸다. 본문을 만든 뒤 초안을 건드려도 보낼 내용이 따라 바뀌지 않는다.

세 종류의 본문은 서로 다르므로 지문도 다르다. 같은 별에서 종류를 바꿔 제출하면 보존한 ID를 재사용하지 않고 새 ID가 만들어진다.

### 무엇을 제안할지

`specialSubmissions`가 정한다. 조건의 최종 권한은 서버이고(6.5절의 409) 프론트는 **근거가 있을 때만 제안한다.**

- **건너뛰기**는 조건을 서버만 안다(튜토리얼 여부, 오답 횟수, 상세 보기 경유). 진입 응답의 `tutorial.skipAvailable`이 참일 때만 내놓는다. 근거가 없으면 제안하지 않는다.
- **더 없음**은 완료한 별에만 막는다. 진행 단계를 모르면 막지 않는다. 잘못 막으면 할 수 있는 일을 못 하게 되지만, 잘못 보내면 409를 받고 끝이다.

이를 위해 [analysis-data.ts](../src/features/analysis/analysis-data.ts)가 `progress.stage`와 `tutorial.skipAvailable`을 읽는다. **필수가 아니다.** 관측 export 문맥에는 이 필드가 없을 수 있어 없으면 각각 `null`·`false`로 둔다. 값이 있는데 아는 단계가 아니면 거절한다.

개발 서버에 튜토리얼 별 `259377030`을 더했다. 정상 샘플과 자료는 같고 건너뛰기만 허용된다. [#183 주기도 안내](periodogram-data.md#직접-확인)의 표에도 한 줄 넣었다.

## 접수 결과에서 읽는 것

[submission-data.ts](../src/features/analysis/submission-data.ts)는 6.4절 `submissionResult` 중 이 티켓이 넘겨줘야 할 부분만 읽는다. **`signal`·`achievement`·`judgmentStatistics`·`original`은 읽지 않는다.** 결과 해설(A06-2)의 몫이고 후보 정답을 담으므로 이 티켓의 상태로 복사하지 않는다.

읽는 값은 `submissionId`·`historyId`·`requestId`·`ticId`·`bundleId`·`submittedAt`·`submissionKind`·`curveContext`·`match.status`·`progress`·`skyVersion`·`nextActions`다. 티켓의 산출물인 「요청 상태·접수된 Submission/History 식별자·서버 결과·현재 상태 재조회 신호」에 해당한다.

### 201과 200은 본문으로 구분할 수 없다

재전송 응답은 **접수 당시 값을 그대로** 담는다. 성과가 있었다면 재현 본문에도 `newlyRecognized: true`가 그대로 실려 온다. 본문만 보고 판단하면 새로고침이나 복구 재전송 때마다 축하가 다시 뜨고 집계가 두 번 올라간다.

그래서 `SubmissionReceipt.outcome`은 **본문이 아니라 HTTP 상태 코드**에서 온다. `201`이면 `created`, `200`이면 `replayed`이며 그 외 성공 코드는 계약에 없으므로 거절한다. 한 번만 일어나야 하는 처리는 `created`에서만 한다.

### 대조하는 것

- **`ticId`와 `requestId`가 보낸 값과 같아야 한다.** by-request 복구에서 이걸 대조하지 않으면 다른 요청의 결과를 내 제출로 착각해 실제 중복 제출을 놓친다.
- `match.status`가 제출 종류에 맞아야 한다. `no_candidate`에 `matched`가 실려 오면 응답을 잘못 읽은 것이다.
- `progress.currentCurveStep`이 제출한 `curveContext.curveStep`과 같아야 한다(6.3절 8번).
- 완료 사유는 완료한 별에만 있다.
- `submittedAt`은 UTC 활동 시각으로만 받는다. 시간대 없는 문자열과 BTJD 숫자는 거절한다.

`nextActions`의 **모르는 값은 버리고 접수 결과는 살린다.** 힌트 하나를 이해하지 못해 버튼이 하나 줄어드는 것보다, 되살릴 수 없는 접수 결과를 잃는 쪽이 훨씬 비싸다. 목록 자체가 없으면 거절한다.

### 실패의 분류

[`classifySubmissionError`](../src/features/analysis/submission-data.ts)가 「응답과 처리」 표의 **마지막 열을 코드로** 옮긴다. 각 실패는 `requestId: "keep" | "renew" | "discard"`를 함께 돌려주며, 요청 ID 규칙이 여러 곳으로 흩어지지 않도록 이 한 곳에서 정한다.

`outcomeUnknown`은 **상태 코드보다 우선한다.** 5xx는 거절처럼 보이지만 쓰기 요청이 나간 뒤라면 저장됐을 수 있다. 현재 판 번호는 `BUNDLE_CHANGED` 본문이 아니라 `X-Current-Bundle` 헤더로 받는다. `ApiError`가 본문의 추가 필드를 싣지 않으며 다른 로더도 같은 방식이다.

## 화면 연결

**[제출값 확인] 단계**의 `제출하기 · 연결 예정`이 실제 제출이 됐다. 누르면 요청 ID를 예약하고 사다리를 돈다. **1단계**에는 더 없음·건너뛰기를 두었다.

둘 다 되돌릴 수 없으므로 한 번 더 묻되 **브라우저의 `confirm`을 쓰지 않는다.** 스타일을 맞출 수 없고 스레드를 막으며 자동 검사가 다루기도 어렵다. 접수 결과와 같은 대화상자로 묻고, 되돌릴 수 없는 동작이므로 **안전한 쪽(취소)에 먼저 포커스**를 준다. 강조 버튼은 [보내기]에만 둔다.

대화상자 뼈대는 [use-modal-dialog.ts](../src/features/analysis/use-modal-dialog.ts)로 뺐다. 같은 함정을 두 번 밟지 않기 위해서다.

제출 결과는 **가운데 대화상자**로 읽는다. 되돌릴 수 없는 동작의 결과이고, 320px 패널에 접수 번호와 안내를 욱여넣지 않아도 된다. 결과 해설(A06-2)이 붙을 자리도 여기다. Figma에 없는 새 패턴이라 [design.md](design.md#figma에-반영이-필요한-것)에 기록했다.

접수하면 **접수 번호·기록 번호·접수 시각**만 보여 준다. 결과 풀이와 다음 단계는 A06-2의 몫이며, 화면에 그렇게 적었다.

### 닫아도 결과를 잃지 않는다

닫으면 `접수 완료 · sub-7001` 한 줄과 [접수 결과 보기]가 남는다. 결과 불명이면 「접수 여부가 아직 확인되지 않았습니다」로 남는다. **거절만은 닫을 때 상태를 지운다.** 입력으로 돌아가는 것과 같고 남길 접수 결과가 없기 때문이다.

### 대화상자에서 배운 것 둘

**React의 `onClose`·`onCancel`이 이 대화상자에서 발화하지 않았다.** `<form method="dialog">` 제출로 브라우저가 먼저 닫는데 React 상태는 열린 채로 남아, 화면에는 아무것도 없는데 다시 열리지 않는 어긋남이 생겼다. 네이티브 `addEventListener("close"/"cancel")`로 바꾸고 닫기 버튼도 명시적 `onClick`으로 바꿨다.

**요소를 항상 그려 둔다.** 열릴 때만 그리면 리스너를 붙이는 시점에 ref가 비어 있어 Escape가 영영 동작하지 않는다. 처음에는 의존성으로 해결했지만, 닫힌 `<dialog>`는 어차피 보이지 않으므로 요소를 계속 두고 내용만 비우는 편이 함정이 없다.

**닫은 뒤 포커스**는 [접수 결과 보기]로 옮긴다. 대화상자를 연 버튼은 제출 뒤 비활성이 되는 일이 많아, 그대로 되돌리면 포커스가 문서 맨 위로 떨어진다.

### 접수 경위를 뭉치지 않는다

복구했다고 늘 「이미 접수돼 있던」 것은 아니다. 조회가 미접수를 알려 같은 번호로 다시 보내 **이번에 접수된** 경우도 있다. 네 경우를 각각 다르게 적는다.

| 복구   | 응답 | 문구                                                           |
| ------ | ---- | -------------------------------------------------------------- |
| 아니오 | 201  | 제출이 접수되었습니다                                          |
| 아니오 | 200  | 같은 내용이 이미 접수돼 있어 그 결과를 그대로 보여 줍니다      |
| 예     | 201  | 응답을 받지 못해 다시 확인했고, 이번에 접수되었습니다          |
| 예     | 200  | 이미 접수돼 있던 제출을 확인했습니다. 다시 접수되지 않았습니다 |

### 초안 잠금

보내는 중·확인 중·결과 불명·접수 완료에서 판단·근거·메모를 잠근다. **제출값 확인 화면은 남긴다.** 접수 결과를 그 자리에서 보여 주고, 결과를 모르는 동안 무엇을 보냈는지 볼 수 있어야 한다.

거절(400·409 본문 충돌·판 교체·권한)은 접수가 아니므로 잠그지 않는다. [입력으로 돌아가기]로 계속 고칠 수 있다.

### 결과를 모를 때

자동 복구가 끝나도 확인되지 않으면 [접수 결과 확인] 버튼을 내놓는다. 이 버튼은 **조회만 한다.** 회귀 검사가 이 버튼을 눌러도 POST가 늘지 않는 것을 확인한다.

안내에 "제출되지 않았습니다"라고 쓰지 않는다. 대신 "다시 제출하지 말고 접수 결과를 확인해 주세요"라고 적는다.

### 접근성

거절과 결과 불명은 `role="alert"`, 접수는 `role="status"`이며 결과가 정해진 순간에만 포커스를 옮긴다. 진행 중 갱신으로는 옮기지 않는다. 색은 보조이고 문구가 1차 신호다.

이름을 가진 영역은 `<section>`을 쓴다. 역할 없는 `<div>`에 `aria-labelledby`를 붙이면 ARIA가 금지한 조합이라 axe가 `aria-prohibited-attr`로 잡는다.

axe WCAG 2 A/AA·2.1 AA 검사를 특수 제출·접수·거절·결과 불명 네 상태에서 돌려 위반 0건을 확인했다.

## 합성 응답의 원리

[submission-fixtures.ts](../dev/submission-fixtures.ts)는 개발 서버에서만 쓰는 `submission-fixture-187-v1`이다. **서버를 다시 구현한 것이 아니다.** 멱등 저장소와 프론트가 실제로 틀릴 수 있는 검사(요청 ID, 판, 곡선 단계, 종류별 필드, enum, 위상 규칙)만 두고 후보 매칭·성과 판정·격자 대조는 실제 서버(C10)에 맡긴다. 상태는 이 개발 프로세스 안에만 있고 서버를 다시 띄우면 지워진다.

시나리오 대부분은 **진짜 상태에서 나온다.** 저장소가 있으므로 같은 ID·같은 본문 재전송은 저장된 결과를 실제로 재현하고, 다른 본문은 본문 지문이 달라 거절된다. 판 교체·검증 실패도 실제 대조 결과다. 가짜로 만들 수 없는 것은 **응답 유실**과 **처리 중**뿐이라 이들만 개발 전용 헤더 `X-Fixture-Submit`으로 받는다. 앱은 이 헤더를 보내지 않으며 테스트와 수동 확인만 사용한다.

| 값                 | 재현하는 상황                                                       |
| ------------------ | ------------------------------------------------------------------- |
| `drop-saved`       | 접수까지 끝난 뒤 응답을 잃는다. by-request가 200을 준다             |
| `drop-unsaved`     | 접수 전에 잃는다. by-request 404 뒤 같은 ID 재전송이 201이어야 한다 |
| `in-progress`      | POST와 첫 by-request가 409, 그다음 조회가 200                       |
| `reset-connection` | 접수한 뒤 **한 바이트도 보내지 않고** 연결을 끊는다                 |

### 소켓을 끊는 것만으로는 유실이 되지 않는다

처음에는 응답 유실을 소켓 끊기로 재현했다. 브라우저에서 돌려 보니 **접수 결과가 `replayed`로 돌아왔다.** 앱이 보낸 POST는 한 번인데 서버는 두 번 받았다.

**브라우저는 재사용된 연결이 응답 한 바이트도 없이 닫히면 POST를 스스로 다시 보낸다.** 앱의 `fetch` 호출 횟수에는 잡히지 않는다. 두 번째 요청이 멱등 저장소에 걸려 200 재현이 됐고, 그래서 유실이 아니라 성공으로 보였다.

그래서 유실은 **헤더를 보낸 뒤 본문을 끊어** 「받긴 했지만 읽을 수 없는 응답」으로 만든다. 공용 클라이언트가 이때 `outcomeUnknown`을 켜고, 프론트는 이 값을 복구 진입 조건으로 쓴다. 헤더가 실제로 소켓에 나간 뒤에 끊어야 한다. `writeHead` 직후 `destroy`하면 Node가 버퍼째 버려 다시 바이트 없는 초기화가 된다.

이 발견 자체가 요청 ID 설계의 근거이므로 `reset-connection`으로 남겼다. 앱이 **보지도 막지도 못하는** 재전송이라 요청 ID가 유일한 방어다. [submission-recovery.spec.ts](../tests/browser/submission-recovery.spec.ts)가 이 경우에 Submission이 하나만 남는지 확인한다.

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

같은 본문을 한 번 더 보내면 201이 아니라 200이 오고 `submissionId`가 같다. 유실·처리 중·연결 초기화를 보려면 `-Headers`에 `'X-Fixture-Submit' = 'drop-saved'`를 더한다.

회귀는 [submission-contract.spec.ts](../tests/browser/submission-contract.spec.ts)가 같은 경로를 HTTP로 9건 검사한다.

## 미결

- **`fieldErrors` 필드 이름이 문서와 구현에서 다르다.** 명세 6.2절 예제와 `contracts.json`은 `{field, message}`인데, 구현된 [`ErrorResponse.FieldError`](../../backend/src/main/java/com/planetory/backend/global/error/ErrorResponse.java)는 `(field, reason)`이고 공용 클라이언트도 `reason`을 읽는다. **구현을 따른다.** 문서 예제 쪽 수정이 필요하며 전달 항목으로 남긴다.
- **메모 길이.** 명세 6.1절은 `0~2,000 코드포인트 확인 필요`, 구현은 `MEMO_LIMIT = 200`이다. 서버 검증이 없는 동안에는 늘려도 확인할 방법이 없으므로 **200을 유지**한다. C10 연동 때 실제 상한으로 맞춘다.
- **ID 보존 기간.** 2.2절이 C02/C10 계약에 넘겼고 아직 값이 없다. 현재는 세션 수명(탭 종료까지)으로 두었다.
- **`retryOfSubmissionId`.** [다시 풀기](6.8절)는 `S15P21C206-192` 범위다. 이 티켓에서는 항상 `null`로 보낸다.
- **자동 복구의 한도.** 2.2절이 재조회 순서와 ID 보존 기간을 C02/C10 계약에 넘겼고 아직 값이 없다. 현재는 전송 2회(최초 + by-request 404 확인 뒤 1회), 재조회 3회(0.3·0.8·2.0초)로 두고 그 뒤는 사용자의 명시적 [접수 결과 확인]으로 넘긴다. [`loadAnalysis`](../src/features/analysis/load-analysis.ts)의 2회 시도 뒤 수동 재시도와 같은 방식이다. C10 연동 때 실제 처리 시간으로 다시 정한다.

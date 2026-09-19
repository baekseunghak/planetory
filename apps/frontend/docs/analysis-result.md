# #188 제출 결과·해설 개발 안내

2026-09-19 기준 `S15P21C206-188`의 계약 확정 기록이다. 기준은 [탐사 API 6.4·6.5·6.7](../../backend/docs/exploration-api-spec.md)(Draft 0.4 / SRS v1.3.1), [ERD 스키마](../../backend/src/main/resources/db/migration/V1__initial_schema.sql)의 CHECK 제약, Jira A06-2의 완료 조건이다. 앞선 [#187 제출 접수·복구](analysis-submission.md)의 접수 결과를 사용한다.

**현재 범위:** 서버의 매칭·판단·성과·완료·공개·AI 결과를 **혼동 없이** 보여 주고 허용된 다음 행동을 연결한다. #187이 접수 사실만 다뤘다면 여기서는 그 결과를 읽는다.

**실제 서버에는 제출·결과 조회 엔드포인트가 아직 없다**(`apps/backend/src/main`에 `submissionResult`·`detail-view` 0건). C12-1 = `S15P21C206-145`가 「해야 할 일」이다. fixture로 구현하며 **이 작업으로 티켓을 닫지 않는다.**

## 여섯 축은 서로 독립이다

이 티켓의 핵심은 **하나의 결론으로 합치지 않는 것**이다. 여섯 축은 각각 다른 것을 말하며 한 축의 값으로 다른 축을 추측하면 안 된다.

| 축        | 값                                                                                              | 무엇을 말하나                             |
| --------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 매칭      | `matched` `matched_harmonic` `not_matched` `duplicate` `ambiguous_match` `none_wrong` `skipped` | 내가 고른 주기가 **어떤 신호와 맞았는가** |
| 판단 채점 | `AGREES` `DISAGREES` `UNSURE` `UNSCORED` `NOT_APPLICABLE`                                       | 내 판단이 **정답과 맞았는가**             |
| 성과      | `recognized` `judgment_mismatch` `pending_publish` `already_recognized` `none`                  | 이번에 **성과로 인정됐는가**              |
| 진행      | `unexplored` `in_progress` `completed` + 완료 사유                                              | 이 별의 **탐색이 끝났는가**               |
| 공개      | `UNPUBLISHED` `NOT_ELIGIBLE`                                                                    | 이 분석을 **공개할 수 있는가**            |
| AI        | `completed` `input_insufficient` `error` `not_evaluated`                                        | AI가 **실행됐는가**                       |

**매칭에 성공해도 성과가 없을 수 있고, 성과가 없어도 탐색이 끝날 수 있다.** 완료 조건이 명시한 「마지막 확정/FP의 오판·UNSURE도 완료와 미인정/보류가 함께 보인다」가 정확히 이 경우다. 매칭은 `matched`, 채점은 `DISAGREES`, 성과는 `judgment_mismatch`, 진행은 `completed`가 동시에 참이다.

## 섞으면 안 되는 것

### 신호를 붙이지 않는 경우

`signal`은 **매칭 성공(`matched`·`matched_harmonic`·`duplicate`)에만** 있다. `not_matched`·`ambiguous_match`는 `null`이다(AT-14·75).

`ambiguous_match`는 특히 주의한다. 서버가 **어느 후보도 고르지 않은** 상태이므로 신호·AI·통계를 하나도 붙이지 않고 성과·진행도 변하지 않는다. 다음 행동은 `RETRY`뿐이다(AT-13). 「가장 가까운 후보」를 프론트가 골라 보여 주면 서버가 일부러 고르지 않은 것을 뒤집는 것이다.

### 없음을 0으로 바꾸지 않는 경우

| 상황             | 서버 값                                                    | 화면                                                            |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| AI 실행 불가     | `ai.status`가 `input_insufficient`·`error`·`not_evaluated` | **점수를 0으로 그리지 않는다.** 왜 없는지 적는다(RES-04, AT-15) |
| 공개 참여자 없음 | `participantCount: 0`, `percentages: null`                 | **0%로 그리지 않는다.** 아직 아무도 없다고 적는다               |
| 미매칭           | `judgmentStatistics: null`                                 | **임의 신호의 통계를 붙이지 않는다**                            |
| 상세 대상 없음   | 409 `DETAIL_UNAVAILABLE`                                   | 대상이 없다고 적고 `answer_viewed`도 바뀌지 않는다              |

AI와 외부 출처는 **나란히 두고 어느 쪽도 다른 쪽을 덮어쓰지 않는다**(RES-05, AT-16). AI 오류·데이터 부족·미매칭·후보 미충족은 각각 `ai.status`와 `match.status`로 구분된다(NFR-09).

### 통계의 분모가 다르다

| 대상        | 형식                      | 분모                                |
| ----------- | ------------------------- | ----------------------------------- |
| 미확정 매칭 | `kind: "public_analyses"` | 최신 유효 **공개** 분석의 판단 분포 |
| 확정·FP     | `kind: "graded"`          | **첫 매칭** 회원 수와 일치율        |

둘은 세는 대상이 달라 같은 문구를 쓸 수 없다. 완료 조건이 「각각 올바른 문구·분모로 표시된다」고 요구한다.

## 고조파 정정

`matched_harmonic`은 **내가 고른 주기와 신호의 주기가 배수 관계**라는 뜻이다. 둘을 함께 보여 주고 어느 쪽이 내 입력인지 분명히 한다.

배율 방향은 **정정 주기 = 제출 주기 × `harmonicMultiplier`** 다. 절반 주기를 골랐으면 `m = 2`, 두 배 주기를 골랐으면 `m = 0.5`다.

`serverDerived`의 `epochBtjd`·`durationHours`는 **서버가 산정한 값**이며 제출값 확인 단계에서 보여 준 미리보기와 다를 수 있다. 미리보기를 결과로 재활용하지 않는다.

## 상세 보기 (6.7절)

`POST /api/v1/submissions/{submissionId}/detail-view`. 본문 없이 보내며 멱등이다.

| `targetKind`         | 대상                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CURRENT_MATCH`      | 그 제출이 매칭한 신호. `userJudgmentAgrees`에 일치 여부(RES-02)                                                                               |
| `CURRENT_CURVE_HINT` | 그 제출의 `curveContext`에서 제거되지 않은 탐색 가능 후보 중 `bls_power` 최고 **하나**. 누적 매칭 집합이 아니라 **그 제출 단계 기준**(RES-09) |
| `null`               | 대상 없음                                                                                                                                     |

호출하면 **열람 기록이 남는다**(`answerViewed: true`). 이 기록은 튜토리얼 건너뛰기 조건(6.5절)에 쓰이므로 사용자가 누르지 않았는데 대신 호출하면 안 된다.

미확정 후보의 `explanation`에는 **「정답」이라는 표현을 쓰지 않는다.** 아직 확정되지 않은 것을 확정처럼 말하게 된다.

응답의 `tutorial.skipAvailable`이 참이면 화면 끝에 [다음 튜토리얼로]를 두고 `skipped` 제출로 실행한다. 제출 경로는 [#187](analysis-submission.md)이 이미 만들었다.

## 다음 행동

`nextActions`는 **서버 힌트**다. 프론트가 조건을 다시 계산하지 않고 받은 목록만 내놓으며, 실행하면 서버가 다시 검증한다.

`NEXT_CURVE`(남은 탐색 가능 신호 있음) · `VIEW_DETAIL` · `RETRY` · `PUBLISH_ANALYSIS`(미확정 매칭) · `LATER` · `VIEW_RESULT` · `GO_HOME` · `DISCUSS`(not_matched) · `SKIP_TUTORIAL`.

**게시 화면으로 강제 이동시키지 않는다**(AT-36). `PUBLISH_ANALYSIS`는 선택지일 뿐이며 SC-11 게시 처리 UI는 `S15P21C206-195` 범위다.

## 판정 어휘는 계층마다 다르다

같은 「판정」이라는 말이 세 곳에서 서로 다른 어휘를 쓴다. 하나로 섞으면 안 된다.

| 값                                      | 표기                                      | 무엇인가                                                                                                                                                               |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal.disposition`                    | **대문자** `CONFIRMED` `UNCONFIRMED` `FP` | API의 표시 어휘. [탐사 명세 6.4·6.7](../../backend/docs/exploration-api-spec.md), [구판 분석 명세](../../../docs/api/analysis/README.md)와 그 예제 5개가 일관되게 쓴다 |
| `achievement.star.byType` 키            | **소문자** `confirmed` `unconfirmed` `fp` | 같은 응답 안에서 표기가 다르다. 탐사 명세 네 곳이 모두 소문자다                                                                                                        |
| DB `candidate_dispositions.disposition` | 소문자 `confirmed` `fp` **`pc`** `none`   | 저장 어휘. `pc`가 API의 `UNCONFIRMED`에 대응하며 프론트는 이 어휘를 보지 않는다                                                                                        |
| `signal.external[].disposition`         | **원천 표기**                             | 우리 열거형이 아니다                                                                                                                                                   |

**`external[].disposition`을 우리 열거형으로 해석하면 안 된다.** [ERD](../../../docs/architecture/database-erd.md)가 `external_signal_references.disposition`을 「원천 표기」로 정의한다. TOI의 `PC`처럼 출처가 쓰는 말이 그대로 오므로, 출처 이름·조회일과 함께 **받은 문자열을 그대로** 보여 주고 우리 판정으로 번역하지 않는다. 확정·FP는 여기에 행성명·출처·조회일·링크가 온다(RES-02).

파서는 `signal.disposition`과 `byType` 키를 **각각의 표기 그대로** 대조한다. 한쪽을 다른 쪽에 맞춰 대소문자를 바꾸면 서버가 실제로 보내는 값과 어긋난다.

## 미결

- **DB의 `pc`가 API의 `UNCONFIRMED`에 대응한다는 문장이 어디에도 없다.** 두 어휘가 나란히 쓰이는 것은 확인했지만 대응표가 문서에 없다. 프론트는 API 어휘만 보므로 구현에는 영향이 없으나, C10·C12 담당(강재민)이 매핑을 적어 두면 좋다.
- **같은 응답에서 `signal.disposition`은 대문자, `byType` 키는 소문자다.** 명세가 일관되게 그렇게 적으므로 그대로 따르되, 실제 구현이 나오면 표기를 대조한다.
- `answerClass`(`graded`·`analysis`)와 `planetTruth`(`planet`·`not_planet`)는 문서와 스키마가 같은 소문자다.
- 실제 서버 응답으로 검증하지 못한다. 제출·결과 조회·상세 보기가 모두 미구현이다(C10 = `S15P21C206-142`·`143`, C12-1 = `S15P21C206-145`).

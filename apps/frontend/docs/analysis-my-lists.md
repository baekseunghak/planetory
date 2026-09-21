# #196 마이페이지 내 별·History 목록 개발 안내

`S15P21C206-196`(A13)의 계약을 적는다. 기준은 [탐사 API 4.4·8.1](../../backend/docs/exploration-api-spec.md)과 **실제 백엔드 구현**이다. 명세만 읽고 구현을 안 보면 커서 규칙처럼 문서에 안 적힌 것을 놓친다.

## 슬롯을 채우는 일이다

`S15P21C206-214`(W16)가 `features/profile/ProfileSlots.tsx`에 세 자리를 만들어 두었다.

```ts
type ProfileSlotComponents = {
  stars?: ComponentType<ProfileSlotProps>;
  history?: ComponentType<ProfileSlotProps>;
  statistics?: ComponentType<ProfileSlotProps>;
};
```

지금 `main.tsx`가 `profileSections`를 넘기지 않아 기본값 `{}`이고 「연결 준비 중입니다」가 뜬다. [#190](analysis-history.md)이 `historyGraphRenderer`를 채운 것과 같은 방식이다.

**이 티켓은 `stars`와 `history` 둘을 채운다.** `statistics`는 `S15P21C206-198`~`200` 몫이고 백엔드 통계 엔드포인트가 아직 없다.

**권한 분기는 W16이 이미 막아 두었다.** `ProfileSection`이 타인 프로필에서 `stars` 외 슬롯을 렌더하지 않고, 타인이고 `starListVisibility === "PRIVATE"`이면 비공개 안내를 낸다. **여기서 다시 검사하지 않는다** — 두 곳에서 판단하면 어긋난다.

## 커서는 조건에 묶인다 — `size`까지

두 목록 모두 불투명 커서이고, **묶인 값 중 하나라도 다르면 400**이다. 구현을 읽어 확인한 묶음이다.

| 목록                 | 커서에 묶이는 것                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| 기록(`HistoryQuery`) | 회원 · `ticId` · `candidateId` · `result` · `from` · `to` · **`size`** |
| 별(`StarListCursor`) | 요청 회원 · 대상 회원 · `scope` · `sort` · **`size`**                  |

**`size`가 들어 있다는 것이 함정이다.** 페이지 크기를 바꾸면서 들고 있던 커서를 그대로 보내면 400을 받는다. 필터뿐 아니라 **크기 변경도 커서를 버려야 한다.**

위치 값도 정렬 키를 둘 다 담는다 — 기록은 `submittedAt`+`submissionId`, 별은 `lastActivityAt`+`ticId`. 시각 하나만으로 이어읽으면 같은 시각 항목이 경계에서 통째로 밀리거나 빠진다.

빈 문자열 필터는 미지정과 같다(`result=""`). 그러나 **`size`를 안 보내는 것과 `size=20`을 보내는 것은 커서 묶음에서 같다** — 서버가 기본값 20을 적용한 뒤 묶기 때문이다.

## 없는 것을 0으로 바꾸지 않는다

`unpublishedSignalCount`는 **본인 조회에만 있다.** 구현이 그 필드에만 `@JsonInclude(NON_NULL)`을 걸어 타인 조회에서는 **키 자체가 사라진다.**

```java
// null일 때만 필드를 뺀다. 본인은 항상 값이 있고(0 포함) 타인은 null이다.
```

그래서 화면은 **없음과 0을 갈라야 한다.**

- 키가 없으면 → 그 줄을 **비운다.** 「공개하지 않은 신호 0개」라고 적지 않는다
- 값이 `0`이면 → 「공개하지 않은 신호가 없다」는 사실이다

명세 4.4가 이유를 적었다 — 「"공개하지 않은 신호가 없다"와 "볼 수 없다"는 다른 뜻이다」.

## 필터는 서버에 있지만 이 티켓은 쓰지 않는다

**정정.** 처음 이 문서는 `stage`·`grade`·`ticId`가 「P1이며 구현돼 있지 않다」고 적었다. **틀렸다.** `S15P21C206-152`가 붙였고 컨트롤러가 받는다.

| 필터    | 허용값                                     | 계약 밖 |
| ------- | ------------------------------------------ | ------- |
| `stage` | `unexplored` · `in_progress` · `completed` | 400     |
| `grade` | `A` · `S` · `SS` · `SSS`                   | 400     |
| `ticId` | 양의 정수                                  | 400     |

그리고 **커서가 이 셋에도 묶인다.** 조건을 하나 더 실으면 이어읽기 조건이 달라진다.

그런데도 이 화면은 **필터를 보내지 않는다.** 티켓의 제외 범위가 「마이페이지 별 검색/진행 필터의 P1 확장」이기 때문이다. 서버가 못 받아서가 아니라 **범위 밖이라서** 안 보낸다. 나중에 붙일 때는 기록 목록과 같은 규칙을 쓴다 — 조건이 바뀌면 커서를 버린다.

기록 목록은 `ticId`·`candidateId`·`result`·`from`·`to`를 받는다. `result`의 허용값은 `matched`·`not_matched`·`none_wrong`·`ambiguous_match`·`skipped`이며, **`matched`는 `matched`·`matched_harmonic`·`duplicate` 셋을 묶는다.** 화면의 이름표를 서버 값과 일대일로 두면 어긋난다.

**진행 단계 값은 `unexplored`다.** `not_started`가 아니다 — 저장소의 다른 파서도 이 셋을 쓴다.

## 막다른 길을 만들지 않는다

**`detailAvailable=false`인 기록에는 상세 링크를 걸지 않는다.** 8.1이 「false이면 개인 상세 진입·재시도를 제공하지 않는다」고 하고, [#190](analysis-history.md)이 그 기록을 열면 「최초 응답이 없어 상세를 제공할 수 없는 기록입니다」를 낸다. 목록에서 링크를 주면 눌러서 막다른 길에 가는 것뿐이다.

`snapshotAvailable`과는 **독립이다.** 하나가 거짓이라고 다른 하나를 끄지 않는다.

## 이 티켓이 맡지 않는 것

- **`statistics` 슬롯**(`S15P21C206-198`~`200`). 통계 엔드포인트가 없다
- **WebGL 대체 목록**(`S15P21C206-207`, 하서진). 그쪽은 `scope=discovered`를 쓴다 — 「성과로 막 발견해 아직 제출하지 않은 별도 골라 분석에 진입할 수 있어야 하기 때문」(4.4). **마이페이지의 제출 이력 조건을 그쪽에 옮기지 않는다**(완료 조건 4)
- 마이페이지 별 검색·진행 필터(P1)와 공개 설정 UI
- [#190](analysis-history.md)의 상세·그래프 재구현

## 결정

**`/history` 라우트를 쓰지 않는다.** `app/paths.ts`에 `historyList`(`/history`, owner 백지웅)가 예약돼 있으나 페이지도 입구도 없다. 이 티켓의 범위는 마이페이지이고, 같은 목록을 독립 화면으로도 열면 [#190](analysis-history.md) 상세가 돌아갈 곳이 둘이 되어 어디서 왔는지를 또 관리해야 한다. **마이페이지 섹션 하나로 둔다.** 라우트는 비워 둔 채 남긴다.

**개발용 응답은 이쪽 소유로 새로 둔다.** `profiles` 모드는 `profile-fixture-plugin`(하서진)과 `community-fixture-plugin`(하서진·백승학)을 함께 쓴다. `/v1/me/histories`는 community 쪽이 첨부 선택용으로 주지만 `/v1/me/stars`는 **galaxy 모드에서만** 준다. 남의 fixture를 넓히면 그쪽 검사의 전제를 바꾸게 되므로 **목록 화면이 필요한 경우를 담은 플러그인을 따로 만든다.**

**갈 곳이 없는 링크는 걸지 않는다.** 포함 범위에 「다시 풀기·별 결과·공개 검토로 연결」이 있으나 `S15P21C206-192`·`193`·`195` 화면이 없고 백엔드도 `retry-draft`·`stars/{ticId}/result`가 미구현이다. **지금 있는 곳만 잇고 나머지는 자리를 비워 둔다.**

## 미결

- **실제 API 인수.** 완료 조건이 「실제 내 별/History 목록 API·커서·필터 검사」와 「목록→상세/재도전/공개→목록 E2E」를 요구한다. 로컬 OAuth 설정이 없어 [#190](analysis-history.md)·[#191](analysis-public-history.md)과 같은 지점에서 막힌다. **개발용 응답까지만 닫고 티켓을 완료로 보지 않는다.**
- **이동 대상 화면.** 위 셋이 생기면 링크를 잇는다. 그때 어느 티켓이 잇는지 정한다.

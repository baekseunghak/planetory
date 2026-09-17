# Planetory 서비스 백엔드 주요 API 명세

- 작성일: 2026-09-09
- 갱신일: 2026-09-14 — HOME-09 사용법 다시 보기 정합화(`S15P21C206-33`, 리뷰 대상). 기존 2026-09-11 변경: SB-D17~24 반영. 원본 문서 옛 문구는 [원본 문서 정합화 요청](../../../docs/project/planetory-doc-sync-requests.md) 참조
- 상태: **팀 협의용 초안 — 구현 완료 또는 최종 합의된 API가 아님**
- 담당: 백승학 / 서비스 백엔드
- DB 기준: [ERD v1.2 변경안](../../../docs/architecture/database-erd.md). PostgreSQL 및 기존 확정 물리 관계를 따른다. v1.2의 별 자리 저장 열·모든 계정의 초기 은하 좌표 생성 제안은 별지도 표현 계약과 함께 교차 리뷰 대상이다.
- 기준: [요구사항 v1.2 변경안](../../../docs/requirements/planetory-requirements-spec.md), [기능별 분석 및 최신 결정](../../../docs/development/service-backend/README.md)
- 적용 순서: 승인된 SRS 기준선 → 팀 결정 → 담당자 제안(SB-D). SB-D 중 SRS와 다르거나 SRS 미결(DEC)을 채우는 항목은 **제안**이며, 팀 결정 전에는 확정하지 않는다(역할 분배 문서 5장). 탐사 D-7·D-9·D-11은 통합 검토안으로 연결하며 해당 MR의 리뷰 상태를 따른다.

기능별로 “언제 호출하는지 → 무엇을 보내는지 → 무엇을 받는지 → 실패하면 어떻게 처리하는지”를 설명한다. **기능 정책은 기준 문서를 따르며, 아래 URL·필드명·페이지 방식·상태 코드는 협의용 제안이다.** 확정된 인증 오류 401/403 외의 세부 계약은 프론트·탐사·DB 담당자 검토 후 확정한다. 예시 ID·제목·시각·수치는 가상 데이터다.

## 1. 먼저 보는 API 목록

모든 경로는 서비스 Spring Boot 기준이다. 서비스 데이터는 EC2-A의 PostgreSQL 한 곳에 있으며 프론트가 DB에 직접 접속하지 않는다. 경로의 `{postId}` 등은 실제 ID로 바꿔 호출한다.

| 기능 | 우선순위 | 메서드·경로 | 쉽게 설명한 역할 | 상세 |
|---|---|---|---|---|
| 내 정보 | P0 | `GET /api/v1/me` | 로그인 여부와 내 프로필 확인 | [회원](#member) |
| 닉네임 수정 | P0 | `PATCH /api/v1/me/profile` | 내 닉네임 변경 | [회원](#member) |
| 첫 방문 안내 완료 | P0 | `PATCH /api/v1/me/onboarding` | onboardingDone=true 저장, 반복 요청 허용 | [회원](#member) |
| 공개 설정 | P1 | `PATCH /api/v1/me/settings` | 내 별 목록 공개 여부 변경 | [회원](#member) |
| 타인 프로필 | P0 | `GET /api/v1/members/{memberId}` | 다른 회원의 공개 정보 조회 | [회원](#member) |
| 내 별 목록 | P0 | `GET /api/v1/me/stars` | 내가 발견한 별과 진행 상태 확인. 응답 정의는 탐사 명세 4.4절 | [회원](#member) |
| 타인 별 목록 | P0 | `GET /api/v1/members/{memberId}/stars` | 공개 설정이 허용한 별 목록 조회. 응답 정의는 탐사 명세 4.4절 | [회원](#member) |
| 로그아웃 | P0 | `POST /api/v1/auth/logout` | 현재 로그인 종료 | [회원](#member) |
| 피드·검색 | 피드 P0 / 검색 P1(P0 상향 요청) | `GET /api/v1/community/feed` | 일반 글·공식 스레드를 제목·본문·작성자·TIC·게시판·태그로 검색 | [검색](#feed) |
| 핫 토픽 | P1(P0 상향 요청) | `GET /api/v1/community/hot-topics` | 산식 확정(DEC-09): 유효 참여자(세 판단 합계) 10명 이상 공식 스레드 | [검색](#feed) |
| 일반 글 | P0 | `POST /api/v1/posts`, `GET/PATCH/DELETE /api/v1/posts/{postId}` | 일반 글 작성·조회·수정·삭제 | [게시글](#posts) |
| 댓글 목록·작성 | P0 | `GET/POST /api/v1/comments` | 일반 글 또는 공식 스레드의 토론 조회·작성 | [댓글](#comments) |
| 댓글 수정·삭제 | P0 | `PATCH/DELETE /api/v1/comments/{commentId}` | 본인 댓글 수정·삭제 | [댓글](#comments) |
| 첨부 선택 | P0 | `GET /api/v1/me/histories` | 해당 별의 내 기록을 선택 | [첨부](#attachments) |
| 글 첨부 조회 | P0 | `GET /api/v1/posts/{postId}/history-attachments/{historyId}` | 글에 붙은 제한된 공개 자료 조회 | [첨부](#attachments) |
| 댓글 첨부 조회 | P0 | `GET /api/v1/comments/{commentId}/history-attachments/{historyId}` | 댓글에 붙은 제한된 공개 자료 조회 | [첨부](#attachments) |
| 출처 카드 | P0 | `GET /api/v1/source-cards` | 같은 별의 공식 스레드·공개 분석 미리보기 | [첨부](#attachments) |
| 반응 설정 | P0 | `PUT /api/v1/posts/{postId}/my-reaction` | 동의·비동의·취소 중 원하는 상태로 변경 | [반응](#reactions) |
| 반응자 | P0 | `GET /api/v1/posts/{postId}/reactions` | 동의·비동의한 회원의 닉네임 목록 | [반응](#reactions) |
| 공식 스레드 | P0 | `GET /api/v1/signal-threads/{threadId}` | 신호 요약과 공개 판단 통계 조회 | [공개 분석](#analyses) |
| 공개 분석 목록 | P0 | `GET /api/v1/signal-threads/{threadId}/analyses` | 선택 공개한 분석들을 조회 | [공개 분석](#analyses) |
| 공개 분석 상세 | P0 | `GET /api/v1/public-analyses/{analysisId}` | 공개 필드·그래프·출처 조회 | [공개 분석](#analyses) |
| 공개 등록 | P0 | `POST /api/v1/public-analyses` | 내 기록을 공식 공간에 공개 | [공개 분석](#analyses) |
| 취소·재공개 | P0 | `PUT /api/v1/public-analyses/{analysisId}/visibility` | 내 공개 여부 설정 | [공개 분석](#analyses) |
| 일괄 공개 | P0 | `POST /api/v1/public-analyses/batch` | 선택한 기록들을 신호별로 공개 | [일괄 공개](#batch) |
| 이번 챌린지 | P0 | `GET /api/v1/challenges/current` | 현재 회차 조회, 프론트에서 새 회차 안내 판단 | [챌린지](#challenge) |
| 숨김 상태 적용 | P0 | 별도 운영 API 없음 | DB hidden을 모든 조회에 반영 | [숨김](#moderation) |
| 팔로우·일반 알림·통계 | P1 | 12장 후보 목록 | P0 이후 상세화 | [후속 범위](#later) |

OAuth 로그인 시작/콜백 주소는 인증 담당자와 제공자 등록 설정에 맞춰 별도 확정한다. 프론트가 제공자 ID를 임의 전송하여 로그인시키는 API는 만들지 않는다. 세션 갱신 API도 활동·만료 정책 확정 전에는 추가하지 않는다.

## 2. 공통 약속

### 2.1 로그인과 권한

- 세션 방식 로그인을 사용한다(SB-D14). 브라우저가 세션 쿠키를 전달하고 서버는 세션에서 회원을 식별한다. 요청 본문에 `authorId`나 운영자 여부를 받지 않는다.
- 인증 없음·만료는 **401**: 프론트가 재로그인 안내. 인증됐지만 권한 부족은 기본 **403**: 권한 부족 안내.
- 실제 없는 자원은 **404**. 비노출 자원의 상태 코드는 자원 종류별로 이미 정한 것을 따른다: 삭제·숨김된 일반 글·댓글(부모 비공개 포함)은 존재를 감추는 404(SB-D22), 타인의 비공개 별 목록은 프로필에 공개 상태가 드러나므로 403(SB-D23), 미공개·미발견 별은 탐사 명세의 404 `STAR_NOT_PUBLISHED`·403 `STAR_LOCKED`. 취소·숨김된 공개 분석과 숨김 공식 스레드의 직접 조회 코드만 미정이며, 합의 전에도 공개 응답에서 비공개 내용을 반환하지 않는 규칙은 유지한다.
- 마지막 유효한 인증 API 요청의 서버 접수 시각부터 30분간 유지하고 다음 유효 인증 요청마다 연장한다. 자동 폴링도 포함한다. 별도 5분 활동 확인·갱신 API는 사용하지 않는다. 만료된 세션은 401이며 갱신으로 되살리지 않는다. 쿠키 이름·저장소·재시작 후 유지 정책은 미정. 인증 구현 시 쿠키 보안 설정·CSRF 방어·로그인 시 세션 ID 교체·로그아웃 무효화를 함께 검토한다.
- 회원 차단 API는 v1에 없다. 탈퇴 API 제공 시점과 데이터 정책은 보류한다.

브라우저 호출 예시(세션 인증 및 CSRF 토큰 전달 방식이 합의됐다는 가정):

```javascript
const response = await fetch('/api/v1/posts', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-TOKEN': csrfToken // 이름·발급 경로는 인증 담당자와 확정
  },
  body: JSON.stringify({
    title: '이 밝기 감소 구간을 어떻게 보시나요?',
    body: '비슷한 간격으로 반복되는지 의견을 듣고 싶습니다.',
    purposeTag: 'DISCUSSION',
    ticId: '123456789',
    historyIds: [],
    sourceLinks: []
  })
});
if (response.status === 401) {
  // 재로그인 안내 후, 저장되지 않은 입력을 어떻게 복구할지 프론트에서 처리
}
```

### 2.2 데이터와 목록

| 항목 | 제안 |
|---|---|
| 기본 경로·본문 | `/api/v1`, JSON. 204 응답에는 본문 없음 |
| ID | `memberId`, `ticId`, `historyId` 등은 문자열로 주고받음. 물리 DB 타입을 강제하지 않음 |
| 시각 | 서버 기준 ISO 8601 UTC 문자열. 예: `2026-09-09T03:00:00Z`. 화면은 한국 시간으로 변환 |
| 목록 | `items`, `nextCursor`, `hasNext`. 첫 요청은 cursor 생략. size 기본 20·최대 100은 제안값 |
| 정렬 | 최신순 목록은 서버 생성 시각 내림차순, 동률은 고정 ID/순번으로 결정. 커서는 프론트가 해석하지 않음 |
| 빈 목록 | 200과 `items: []`, `nextCursor: null`, `hasNext: false` |
| 부분 수정 | PATCH에서 생략한 필드는 유지. 배열을 보내면 전체 교체. 빈 배열은 모두 제거. nullable 필드의 null은 연결 해제 |
| 공개 상태 | 일반 삭제·개별 숨김·상위 스레드 숨김·본인 공개 취소를 매 조회 적용. 캐시·카드·직접 URL도 동일 |

커서는 같은 검색·필터·정렬 조건에서만 사용한다. 다른 조건의 커서는 400 제안. 페이지 사이 새 글이나 상태 변경으로 목록이 달라질 수 있으며, 전체 목록의 고정 스냅샷을 보장하는 방식은 현재 범위에 넣지 않는다. 화면 안 중복은 ID로 제거한다.

### 2.3 중복·동시 요청

- SB-D17: 일반 글·댓글 작성은 NFR-02 멱등 대상이 아니므로 서버 차원의 엄격한 중복 방지(유일 제약·트랜잭션 잠금)를 도입하지 않는다. P1에서도 도입하지 않는다. 프론트는 등록 중 버튼을 비활성화하고 작성 POST를 자동 재시도하지 않는다. 응답 유실·시간 초과 시 실패로 단정하지 않고 등록 여부 확인 안내와 목록 확인을 제공한다.
- 공개 분석은 작성자+History 유일성, 성과는 회원+고유 신호 유일성으로 중복을 막는다.
- SB-D19 확정: 일반 글·댓글의 같은 필드 동시 수정은 DB에서 마지막으로 저장된 값이 남는다. 다중 탭의 같은 필드 덮어쓰기는 초기 허용한다. ERD에 수정용 version 열을 추가하거나 If-Match·412/428 계약을 요구하지 않는다. updatedAt은 표시용이며 충돌 방지 토큰이 아니다.
- 프론트는 실제 변경한 필드만 PATCH로 전송하고 서버도 해당 필드만 갱신한다. 생략 필드는 유지하며 배열은 전달 시 전체 교체하므로 같은 배열의 동시 수정도 마지막 저장값을 따른다. 최신 저장 상태에 변경 필드를 적용한 결과로 TIC·첨부 등 연관 조건을 재검증한다.
- 수정 중 저장 버튼을 비활성화하고 PATCH를 자동 재시도하지 않는다. 응답 유실·시간 초과 시 저장 실패로 단정하지 않고 저장 여부 확인 안내 후 상세를 재조회한다. 재조회에서도 접근이 거부되면 해당 오류를 안내한다.
- 수정·삭제 시 소유권·현재 상태를 트랜잭션 안에서 검사하고 상태 검사와 실제 저장 사이의 경합도 방지한다. 삭제가 먼저 확정된 자원의 뒤늦은 수정은 거부하며 콘텐츠를 되살리지 않는다. 타인 수정도 거부한다. 버전 충돌 감지·수정 이력 복구는 필요 시 별도 후속 범위로 정한다.
- PUT은 토글이 아니라 원하는 최종 상태를 전달한다. 같은 상태를 반복해도 반응 수를 중복 생성하지 않는다. 서로 다른 상태의 동시 요청은 서버 저장 순서가 최종 기준인 안이다.
- 성공했던 요청 재시도라도 현재 인증·자원 접근 권한을 다시 검사한다. 재시도로 취소·숨김된 자료가 공개되거나 신규 성과가 생기면 안 된다.

**일반 글·댓글 삭제·숨김(SB-D22, 사용자 확정)**

| 상황 | 처리 |
|---|---|
| 삭제 | 목록·검색 제외, 상세·첨부·출처 조회 차단. 부모 글 삭제 시 댓글 공개 조회도 차단한다. 댓글만 삭제하면 해당 댓글을 목록·댓글 수에서 제외한다. |
| 작성자 조회·복원 | 삭제·숨김 콘텐츠는 작성자에게도 본문을 제공하지 않는다. 삭제 복원·휴지통은 초기 제공하지 않는다. |
| 숨김 | 본인도 수정 불가. 본인 삭제는 소유권 검사 후 허용하며 본문 조회 없이 처리한다. 부모가 삭제·숨김 상태인 본인 댓글 삭제에도 같은 예외를 적용한다. |
| 조회·수정 거부 | 없거나 삭제·숨김 상태(부모 비공개 포함)면 404와 동일한 비노출 안내. 인증 없음은 기존 401. 공개된 타인 콘텐츠 수정·삭제는 403. 비공개 자원에 대한 타인 삭제는 404. |
| DELETE | 본인 삭제 성공 204. 이미 삭제됐어도 소유권을 확인할 수 있으면 204·추가 변경 없음. 자원이 없거나 소유권 확인 불가면 404. |
| 숨김 해제 | hidden → visible만 허용하고 deleted → visible로 되돌리지 않는다. 부모 공개·자체 상태를 함께 검사하며 부모 복원으로 개별 숨김·삭제를 해제하지 않는다. |
| 보존 범위 | 일반 글·댓글의 status=deleted 및 접근 차단 계약이다. 즉시 물리 삭제·보관기간을 확정하지 않는다. 독립 공개 분석·History·기성과·등급은 취소하지 않는다. 공식 스레드 사용자 삭제와 공개 분석 취소는 이 계약에 포함하지 않는다. |

공통 안내 문구는 “게시물을 찾을 수 없거나 볼 수 없습니다”를 사용한다. 삭제와 숨김 해제의 경합에서도 삭제가 먼저 확정되면 복원되지 않도록 DB 상태 조건을 검사한다. 운영 API·감사 테이블은 추가하지 않는다. 검증: 삭제 후 작성자 조회, 댓글/첨부 직접 접근, 반복 DELETE, 숨김 중 본인 삭제, 타인 접근, 부모 복원 시 개별 상태 유지, 삭제와 숨김 해제 경합.

### 2.4 오류 응답

**일반 작성 재시도 정책(SB-D17):** 일반 글·댓글은 P0·P1 구분 없이 서버 차원의 중복 저장 방지를 도입하지 않는다. 결과를 받지 못하면 글 목록 또는 해당 부모의 댓글 목록 확인 후 사용자가 다시 작성하도록 안내한다. 이 제한은 일반 글·댓글에만 적용하며 공개 분석·성과·별 발견의 DB 유일 제약과 트랜잭션은 P0로 유지한다.

```json
{
  "code": "TIC_MISMATCH",
  "message": "게시글과 같은 별의 자료만 첨부할 수 있습니다.",
  "fieldErrors": [{"field": "historyIds", "reason": "다른 TIC의 기록이 포함되어 있습니다."}]
}
```

프론트 분기는 `code`로 하고 `message`는 안내 문구로 사용한다. 실패 응답에 타인의 비공개 ID·원문·세션값을 담지 않는다.

| HTTP | 코드 예시 | 프론트 처리 |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `TIC_MISMATCH` | 잘못된 입력 안내·수정 |
| 401 | `AUTH_REQUIRED` | 재로그인 안내 |
| 403 | `FORBIDDEN`, `CONTENT_NOT_ACCESSIBLE`, `STAR_LIST_PRIVATE` | 권한 부족·접근 불가 안내. 타인 비공개 별 목록(SB-D23)이 여기에 해당 |
| 404 | `RESOURCE_NOT_FOUND` | 없는 대상과 삭제·숨김 글·댓글(SB-D22)을 같은 안내로 처리. 취소·숨김 공개 분석의 직접 조회 코드는 미정 |
| 409 | `NICKNAME_UNAVAILABLE`, `THREAD_HIDDEN` | 충돌 원인에 따라 새로 조회·입력 변경·동일 요청 재시도 |
| 503 | `DEPENDENCY_UNAVAILABLE` | 원본 자료 조회 등 일시 장애. 입력을 유지하고 재시도 |

이 표의 업무 코드와 세부 HTTP 매핑은 제안이다. 내부 장애를 ‘자료가 없음’으로 바꿔 반환하지 않는다.

<a id="member"></a>

## 3. 회원·프로필·세션 — F01~03

### 3.1 내 정보 및 닉네임

홈 진입·새로고침에서 `GET /api/v1/me`를 호출한다. 성공 200 예시:

```json
{
  "memberId": "u-101",
  "nickname": "별찾는사람",
  "role": "MEMBER",
  "starListVisibility": "PUBLIC",
  "tutorialCompleted": false,
  "onboardingDone": false,
  "achievementSummary": {
    "discoveredStarCount": 57, "completedStarCount": 5,
    "signalCount": 9, "byType": {"confirmed": 5, "unconfirmed": 3, "fp": 1},
    "starCountByGrade": {"A": 3, "S": 1, "SS": 1, "SSS": 0}
  }
}
```

`role`은 화면 표시용이며 실제 운영 권한은 서버가 재검사한다. 튜토리얼 완료는 탐사 도메인의 판정을 사용한다. 이메일·제공자 원본 ID·토큰은 이 응답에 포함하지 않는 최소안이다.

`achievementSummary`는 MY-01 마이페이지 요약이다. 값은 저장 열이 아니라 호출 시 집계한다: 발견 별 수는 `star_unlocks`, 완료 별 수는 `user_star_progress.progress_stage`, 성과 수·유형별 수는 `user_candidate_achievements`(`achievement_type`), 등급 분포는 `user_star_progress.achievement_count`를 1/2/3/4 이상으로 묶어 센다(ERD: 등급 문자는 열로 두지 않음). 원천 조회는 [탐사 API 명세 9.1절](exploration-api-spec.md) `GET /me/achievements`의 `summary`와 같은 내부 함수를 쓰며 서비스가 별도 산식을 두지 않는다. 회원 단위 합계 열·캐시는 추가하지 않는다(P1 `global_stats`·`stats_snapshots`는 전체·비교 통계용이며 개인 요약과 무관). 순위·백분위는 없다(STA-04). 타인 프로필(3.2절)은 이 중 공개 범위(SB-D23)만 같은 원천에서 내려준다.

`PATCH /api/v1/me/profile` 요청:

```json
{"nickname": "새로운별찾기"}
```

성공 200은 `{"memberId":"u-101","nickname":"새로운별찾기"}`. 닉네임은 상시 변경 가능하고 기존 글·댓글·반응자 표시에도 최신 값이 반영된다. 중복은 409 `NICKNAME_CONFLICT`, 금칙어·형식 오류는 400 `VALIDATION_FAILED`. SB-D14의 확정 입력 기준을 적용한다. 닉네임 변경 시 세션 재발급 없이 이후 조회에 최신 이름을 반영한다. 이메일 수정·제공자 연결은 포함하지 않는다.

**첫 방문 안내 완료(P0, 36번 통합 검토 중 사용자 승인)**

`PATCH /api/v1/me/onboarding`에 `{"onboardingDone":true}`를 보내면 200 `{"onboardingDone":true}`. 현재 인증 회원의 user_settings.onboarding_done만 변경한다. 반복 true 요청은 동일 결과이며 false·null은 400 VALIDATION_FAILED, 회원 ID 입력은 받지 않는다. 안내를 닫기 전에 완료로 기록하지 않으며 실패 시 다시 안내될 수 있다.

설정 행이 없으면 기존 ERD 기본값으로 생성하고 이미 있는 별 목록 공개·알림 설정을 덮어쓰지 않는다. GET /me의 onboardingDone은 행이 없으면 false다. 탐사 D-8의 튜토리얼 1번 첫 제출 성공 처리도 같은 단방향 완료 규칙을 사용하며 병렬 실행해도 true가 false로 되돌아가지 않는다. 별 클릭은 완료 처리가 아니다. 이 필드만 P0이며 starListVisibility 등 다른 설정을 P0로 올리지 않는다. SB-D20 주간 챌린지 안내는 계속 브라우저별 기록으로 관리한다.

**사용법 다시 보기(HOME-09 v1.2 변경안).** 마이페이지에서 GIF+설명 5단계(별 선택 → 봉우리 → 구간 → 판단 → 제출)를 읽는 화면이다. 다시 보기의 열기·이전·다음·닫기는 이 PATCH를 호출하지 않으며 onboardingDone을 false로 재설정하지 않는다. 분석·제출·성과·발견도 발생하지 않고 tutorialCompleted와 별 진행은 유지된다. 최초 안내 완료 API의 true 전용 규칙은 변경하지 않는다. [별지도 표현 계약 2절](../../../docs/development/sky-presentation-contract.md)을 따른다.

검증: 최초 true·반복 true·false/null 거부·미인증 401·설정 행 미존재·기존 설정 보존·튜토리얼 제출과 동시 완료·다른 기기 조회에서 완료 유지.

첫 방문 안내 완료는 `PATCH /api/v1/me/onboarding`을 쓴다. 이전 초안의 `PATCH /api/v1/me/settings`는 폐기한다. onboardingDone은 true로만 가는 단방향 사건 기록이라 false를 400으로 거부하는데, 3.2절의 P1 공개 설정은 양방향이므로 같은 경로에 두면 "필드가 없다"와 "값이 틀렸다"를 구분하는 분기가 필요해진다. 경로를 나누면 P1이 `PATCH /api/v1/me/settings`를 예외 없이 쓴다. 요청·응답 본문과 검증 규칙은 바꾸지 않았다.

`S15P21C206-157`에서 닉네임 변경·첫 방문 안내 완료·타인 공개 프로필 API를 구현했다. 기존 `GET /me`와 탐사 성과 요약을 재사용한다. 게시글·댓글·반응자의 최신 닉네임 표시와 C10 첫 제출 연동은 해당 후속 구현에서 함께 검증한다.

### 3.2 공개 설정(P1)·타인 프로필·별 목록(P0)

**ERD 기준:** 공개 설정 변경은 user_settings의 P1 범위를 따른다. P0에서는 기본 공개를 사용하고 설정 변경 API·화면은 제공하지 않는다. 설정 행이 없을 때 PUBLIC으로 응답하되, 기존 행이 있으면 star_list_public 값을 존중한다. P1의 PUBLIC/PRIVATE는 DB의 true/false에 대응한다.

P1에서 `PATCH /api/v1/me/settings`에 `{"starListVisibility":"PRIVATE"}`를 보내면 200으로 변경된 설정을 반환한다. 값은 `PUBLIC`/`PRIVATE`, 기본은 PUBLIC. 이 설정이 공개 게시글·반응·공식 판단 통계를 비공개로 바꾸지는 않는다.

`GET /api/v1/members/u-102`의 공개 응답(SB-D23):

```json
{"memberId":"u-102","nickname":"관측자","starListVisibility":"PRIVATE",
 "achievementSummary":{"signalCount":7,"starCountByGrade":{"A":3,"S":1,"SS":0,"SSS":0}}}
```

성과 요약은 별 목록 비공개와 무관하게 제공한다(MY-04·DEC-34). 3.1절 본인 요약과 같은 내부 함수로 집계하며 등급은 achievement_count에서 계산한다. 이메일·제공자 정보·로그인/세션 기록·개인 History는 포함하지 않는다. 가입일·팔로우 목록·활동 이력은 초기 제외하고 필요할 때 확장한다.

`GET /api/v1/me/stars`와 `GET /api/v1/members/{memberId}/stars`의 응답·정렬·필터는 **[탐사 API 명세 4.4절](exploration-api-spec.md)이 MY-02 전체 필드로 정의하며, 이 절은 그 정의를 참조한다**([API 명세 파트 분담](README.md) 2장 결정). 진행 단계·행성 수·등급·곡선 단계·미게시 수·최근 활동 시각이 모두 탐사 데이터이므로 이 문서에서 별도 항목 구조를 두지 않는다. 이전 초안의 `ticId/discoveredAt/isComplete` 최소 항목은 폐기한다.

서비스 쪽에서 유지하는 규칙만 남긴다.

- 타인 비공개 목록은 403 `STAR_LIST_PRIVATE`(권한 부족 안내, SB-D23)로 거부하며 별별 진행도 함께 숨긴다. 프로필에 공개 상태가 이미 드러나므로 404로 숨기지 않는다.
- 본인 조회에만 있는 필드(미게시 신호 수 등)를 타인 조회에서 빼는 규칙은 탐사 명세 4.4절·NFR-14를 따른다.
- 이 목록의 완료 여부는 탐사 진행 상태이며 공개 여부·성과 유무와 다르다.

**성과 요약 매핑:** 서비스 achievementSummary.signalCount는 탐사 9.1 summary.recognizedTotal, starCountByGrade는 gradeDistribution에서 가져온다. discoveredStarCount·completedStarCount·byType은 같은 이름으로 매핑한다. startedStarCount는 현재 서비스 응답에서 제외한다. 이름만 투영하며 산식을 중복 구현하지 않는다.

### 3.3 로그아웃

`POST /api/v1/auth/logout`, 본문 없음, 성공 204. 현재 세션만 종료하고 다른 기기는 유지한다. 다중 기기 로그인 허용, 전체 기기 로그아웃은 초기 제외다. 이미 종료된 세션의 반복 요청도 204로 처리하는 안이며 CSRF 계약은 인증 담당자와 확정한다. 세션 저장소는 SB-D07에서 확정했다(EC2-A Redis, 구현 `S15P21C206-237`).

<a id="feed"></a>

## 4. 피드·검색·핫 토픽 — F05·13

### 4.1 피드 검색

예: TIC `123456789`에서 제목이나 본문에 ‘밝기’가 들어간 일반 글·공식 스레드를 조회한다.

`GET /api/v1/community/feed?ticId=123456789&q=밝기&size=20`

예: 닉네임 ‘관측자’가 쓴 자유 게시판 질문 글: `GET /api/v1/community/feed?author=관측자&board=FREE&tag=QUESTION`

| 쿼리 | 필수 | 의미·제안 |
|---|---|---|
| q | 아니오 | 키워드 부분 일치·영문 대소문자 무시, 앞뒤 공백 제거 후 1~100자. URL에는 인코딩해 전달 |
| searchIn | 아니오 | `TITLE_BODY`(기본) / `TITLE` / `BODY`. q 없이 보내면 400 |
| author | 아니오 | 작성자 현재 닉네임 정확 일치(영문 대소문자 무시). 공식 스레드 제외 |
| ticId | 아니오 | 해당 TIC만 정확 일치 |
| board | 아니오 | `STAR` / `FREE`(ERD posts.board) |
| tag | 아니오 | `ANALYSIS`/`QUESTION`/`DISCUSSION`/`INFORMATION`/`GENERAL`. 공식 스레드 제외 |
| cursor, size | 아니오 | 다음 페이지·페이지 크기. 기본 20개·최대 100개 |

**우선순위:** SRS COM-03은 P1이며 P0 상향을 팀에 요청한다(정합화 요청 D1).

**검색 정책(SB-D24 제안, SB-D21 대체):** 검색 대상 필드는 SRS COM-03과 같고, 쿼리 형식·일치 방식은 담당자 제안이다. 일반 글·공식 스레드에서 제목·본문 키워드(`q`, 부분 일치, `searchIn`=TITLE_BODY 기본/TITLE/BODY), 작성자(`author`, 현재 닉네임 정확 일치·영문 대소문자 무시), TIC(`ticId`, 정확 일치), 게시판 종류(`board`=STAR/FREE), 대표 목적 태그(`tag`)로 검색·필터한다(SRS COM-03). 키워드는 영문 대소문자를 무시하고 앞뒤 공백 제거·내부 공백 유지 후 1~100자이며 LIKE 와일드카드는 이스케이프해 문자 그대로 찾는다. 조건은 모두 AND, 조건이 없으면 접근 가능한 전체 피드다. 공식 스레드는 제목과 시스템이 채운 신호 요약 본문으로 검색되며, 작성자·태그 조건이 있으면 제외한다(SYSTEM은 회원이 아니고 태그가 없다). 바뀐 이전 닉네임으로는 찾지 않는다. 댓글은 검색 대상이 아니다. 생성 시각 내림차순 → ID 내림차순, 기본 20개·최대 100개, 결과 없음 200 빈 목록, 삭제·숨김 제외. 오타 보정·형태소 분석·별도 검색 엔진은 제외한다. 본문 부분 일치 성능을 위해 PostgreSQL `pg_trgm` GIN 인덱스(title, body)를 사용한다(ERD 반영 요청). 허용값 밖의 enum·길이 초과는 400이다. 공식 스레드 제목 생성 규칙은 별도 협의한다.

예: TIC 123456789 + q=밝기는 해당 별에서 제목 또는 본문에 밝기가 포함된 일반 글·공식 스레드만 반환한다. 검증은 조건별 단독·AND 조합, searchIn 세 값, 닉네임 변경 전후 author 검색, 작성자·태그 조건 시 공식 스레드 제외, `%`·`_` 문자 그대로 검색, 영문 대소문자, 앞뒤/내부 공백, 조건 없음·결과 없음, 삭제·숨김 제외, 최신순·동률 정렬과 페이지 크기를 포함한다.

```json
{
  "items": [
    {"type":"POST","id":"p-201","ticId":"123456789","title":"밝기 감소에 관한 질문","author":{"memberId":"u-101","nickname":"별찾는사람"},"commentCount":4,"createdAt":"2026-09-09T03:00:00Z"},
    {"type":"SIGNAL_THREAD","id":"st-301","ticId":"123456789","title":"TIC 123456789 신호 s-401 밝기 분석","author":{"type":"SYSTEM","displayName":"SYSTEM"},"commentCount":8,"judgmentSummary":{"participantCount":15,"likelyPlanet":8,"unlikelyPlanet":4,"unsure":3},"createdAt":"2026-09-09T02:00:00Z"}
  ],
  "nextCursor": null,
  "hasNext": false
}
```

`type`으로 일반 글 상세와 공식 스레드 상세를 구분한다. 공식 원글 작성자를 최초 공개 회원으로 표시하지 않는다. 최초 발견 전 별 게시판의 접근 제한과 삭제·숨김은 서버에서 검사한다. 내 스레드 탭의 포함 기준은 미정이므로 임의 API를 추가하지 않는다.

### 4.2 핫 토픽

**우선순위·상태:** SRS COM-09는 P1이며 P0 상향을 팀에 요청한다. 산식은 DEC-09로 팀이 확정했다(10.1 안건 5, SB-D16 대안 채택). SRS 10.1 안건 5의 기본안이던 “최근 7일 (답글 수 + 동의·비동의 수) 가중, 별 스레드 기준”은 폐기했다.

**확정(SB-D16, DEC-09):** 공식 스레드의 현재 유효 참여자 `participantCount >= 10`이면 핫 토픽으로 선정한다. 어느 판단이 다수인지는 무관하다.

`GET /api/v1/community/hot-topics?size=20`, 성공 200. 공통 피드 목록 구조를 재사용하고 공식 스레드 항목의 hotReasons에 JUDGMENT_THRESHOLD를 반환하는 안이다.

- 현재 공개 분석 통계 F16의 LIKELY_PLANET+UNLIKELY_PLANET+UNSURE 합계 N을 재사용한다. 회원×신호당 최신 유효 공개 판단 한 건이며 반복 제출 횟수를 더하지 않는다. 별도 투표 버튼은 추가하지 않는다.
- 예: 세 판단이 4/3/3이면 합계 10명으로 선정된다. 한 회원의 판단 변경은 비율만 바꾸고 총인원은 늘리지 않는다.
- 생성일·집계 기간 제한 없이 현재 유효 판단을 사용한다. 정렬은 참여자 수 내림차순 → 공식 스레드 생성 시각 내림차순 → 공식 스레드 ID 내림차순이다. 오래된 인기 스레드가 상단에 계속 남을 수 있음을 허용한다.
- 핫 토픽은 공식 스레드만 대상으로 한다. 일반 게시글과 댓글 수 조건은 초기 범위에서 제외·보류한다. 일반 글 agree/disagree 및 댓글 작성·삭제는 핫 토픽 인원에 영향을 주지 않는다. 일반 피드·검색은 계속 일반 글과 공식 스레드 모두 포함한다.
- 본인 공개 취소·개별/상위 숨김에 따라 F16의 유효 N을 다시 조회한다. 삭제·숨김 콘텐츠는 임계값과 무관하게 노출하지 않는다.
- N이 10명 미만이면 다음 조회에서 제외하고 다시 10명 이상이면 재진입한다. 최신 공개 취소 시 이전 유효 공개가 남아 있으면 해당 회원은 계속 1명으로 집계하며, 없을 때만 제외한다. 상위 숨김 복원 후에도 현재 유효 N과 접근 권한으로 다시 판정한다.
- 기존 유효 공개 집계를 조회해 선정하며 별도 선정 이력·배치는 추가하지 않는다. 검증: 9/10/11명 경계, 반복 제출, 이전 판단 복귀, 제외·재진입, 숨김·복원, 정렬 동률, 댓글 변화에 따른 인원 불변.

<a id="posts"></a>

## 5. 일반 게시글 — F06

**구현 상태(S15P21C206-158):** 기존 `posts` 테이블을 사용해 일반 글 작성·상세·변경 필드 PATCH·상태 삭제를 구현했다. 공개되고 한 명 이상 발견한 TIC만 연결할 수 있으며, 제목·본문·태그와 소유권을 서버에서 검사한다.

아직 구현하지 않아 응답이 고정값인 항목이 있다. `attachments`와 `sourceLinks`는 항상 빈 배열, `reactionSummary`는 `{"agree":0,"disagree":0,"myReaction":"NONE"}`다. 실제 값은 반응 F07·History 첨부 F09·출처 카드 F24에서 채우며, 그 전까지 이 값들을 "반응·첨부·출처가 없다"는 사실로 읽지 않는다. `commentCount`는 visible 댓글 수를 반환한다. `TIC_MISMATCH`도 첨부 구현 전까지 발생하지 않는다.

첨부 배열은 작성·수정 모두 비어 있을 때만 받는다. 5.2절의 연결 해제 예제처럼 `historyIds`·`sourceLinks`를 빈 배열로 함께 보내는 요청은 정상 처리하며, 항목이 담긴 요청만 400 `VALIDATION_FAILED`로 거절한다.

작성·수정에서 연결할 수 없는 TIC를 보내면 탐사 도메인의 판정을 그대로 전달해 404 `STAR_NOT_PUBLISHED`가 된다. 입력 검증 실패지만 별의 존재·공개 여부를 숨기는 기존 판정을 재사용한 결과이며, 400으로 바꿀지는 별 도메인 담당과 함께 정한다.

### 5.1 작성

작성 화면의 최종 ‘게시’에서 `POST /api/v1/posts`를 호출한다. 화면 진입이나 자동 채움만으로 글을 저장하지 않는다. SB-D17에 따라 등록 중 중복 클릭을 막고 자동 재시도하지 않는다.

```json
{
  "title": "이 밝기 감소 구간을 어떻게 보시나요?",
  "body": "반복 간격이 일정한지 의견을 듣고 싶습니다.",
  "purposeTag": "DISCUSSION",
  "ticId": "123456789",
  "historyIds": ["h-501"],
  "sourceLinks": [{"type":"PUBLIC_ANALYSIS","id":"pa-601"}]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| title, body | 예 | 제목 1~100자·본문 1~10,000자. 공백만 입력 금지, 일반 텍스트 |
| purposeTag | 예(제안) | 대표 목적. ERD tag: ANALYSIS/QUESTION/DISCUSSION/INFORMATION/GENERAL |
| ticId | 아니오 | 별 연결. null이면 별 없는 일반 글 |
| historyIds | 아니오 | 같은 TIC의 본인 History. 생략 시 빈 목록 |
| sourceLinks | 아니오 | 같은 TIC의 공개 분석 또는 공식 스레드. type은 PUBLIC_ANALYSIS/SIGNAL_THREAD |

TIC가 있으면 posts.board=star, 없으면 free로 서버가 결정한다. TIC가 없으면 History·출처 카드 목록은 비어야 한다. 일반 본문 URL과 자료 선택 기능은 구분한다. 최초 발견 여부·소유권·상위 공개 상태를 서버에서 검증한다. 일반 글 작성은 공식 분석 공개·성과·판단 통계를 생성하지 않는다.

성공 201 예시:

```json
{"postId":"p-201","createdAt":"2026-09-09T03:00:00Z"}
```

### 5.2 조회·수정·삭제

`GET /api/v1/posts/p-201`, 성공 200:

```json
{
  "postId":"p-201","title":"이 밝기 감소 구간을 어떻게 보시나요?",
  "body":"반복 간격이 일정한지 의견을 듣고 싶습니다.","purposeTag":"DISCUSSION","ticId":"123456789",
  "author":{"memberId":"u-101","nickname":"별찾는사람"},
  "attachments":[{"historyId":"h-501","type":"HISTORY"}],
  "sourceLinks":[{"type":"PUBLIC_ANALYSIS","id":"pa-601","available":true}],
  "reactionSummary":{"agree":3,"disagree":1,"myReaction":"NONE"},
  "commentCount":4,"createdAt":"2026-09-09T03:00:00Z","updatedAt":"2026-09-09T03:00:00Z"
}
```

`PATCH /api/v1/posts/p-201`은 변경 필드만 전달한다. 성공 200으로 변경된 상세와 updatedAt을 반환한다. `{"ticId":null,"historyIds":[],"sourceLinks":[]}`는 별과 자료 연결을 함께 해제하는 예다. 별만 변경하고 부적합 첨부를 남기면 400 `TIC_MISMATCH`. 원본 History의 수치·판단을 수정하지 않는다.

`DELETE /api/v1/posts/p-201`, 별도 버전 헤더 없이 호출, 성공 204. 댓글·첨부의 일반 공개 접근도 차단하며 독립 공개 분석·성과를 취소하지 않는다. SB-D22에 따라 삭제 후 작성자도 조회할 수 없고 복원은 제공하지 않는다. 본인 소유권을 확인할 수 있는 반복 DELETE는 204다. 공개된 타인 글 수정/삭제는 403이다. 동시 수정은 공통 저장 순서 규칙을 따른다.

<a id="comments"></a>

## 6. 댓글 — F08

**구현 상태(S15P21C206-159):** 일반 글(`POST`)과 공식 신호 스레드(`SIGNAL_THREAD`)에 1단계 댓글 작성·목록·본문 PATCH·상태 삭제를 구현했다. 부모 종류·공개 상태와 작성자 소유권을 서버에서 검사하며, 생성은 부모 Post 행을 잠가 부모 삭제가 먼저 확정되면 새 댓글을 저장하지 않는다.

History·출처 첨부는 F09·F24 구현 전이라 `historyIds`·`sourceLinks`가 비어 있을 때만 받으며, 응답의 `attachments`와 `sourceLinks`는 항상 빈 배열이다. 항목이 담긴 배열은 400 `VALIDATION_FAILED`다.

공식 스레드의 ‘토론’과 일반 글의 댓글만 대상이다. 개별 공개 분석에 댓글을 붙이거나 2단계 답글을 만드는 API는 추가하지 않는다.

`GET /api/v1/comments?parentType=POST&parentId=p-201&size=20&cursor=`, 성공 200. `size`는 기본 20, 최대 100이며 최신순이다.

응답은 피드 4.1과 같은 목록 구조를 쓴다.

```json
{"items": [{"commentId":"c-801", "author": {}, "body":"", "attachments":[], "sourceLinks":[],
            "createdAt":"2026-09-09T03:10:00Z", "updatedAt":"2026-09-09T03:10:00Z"}],
 "nextCursor": null, "hasNext": false}
```

`cursor`는 불투명 값이며 `parentType`·`parentId`·`size`에 묶는다. 셋 중 하나라도 다른 요청에 쓰거나
형식이 깨졌으면 400 `VALIDATION_FAILED`로 거절한다. `hasNext`는 `nextCursor != null`과 같은 뜻이며
마지막 페이지는 `nextCursor`가 null이다. 정렬 키는 `createdAt` 내림차순·동률은 `commentId` 내림차순이고
커서도 두 값을 함께 담아 경계에서 중복·누락이 없다. 최신순이므로 페이지를 넘기는 동안 새 댓글이 달리면
이미 본 페이지의 내용이 밀릴 수 있다. 이어읽기는 커서 기준이라 같은 댓글을 두 번 주지는 않는다.

공식 스레드는 `parentType=SIGNAL_THREAD&parentId=st-301`. 두 부모 필드는 필수다. 성공 200 목록 항목은 `commentId`, `author`, `body`, `attachments`, `sourceLinks`, `createdAt`, `updatedAt`. 기본 정렬은 최신순 제안.

`POST /api/v1/comments` 요청:

```json
{
  "parentType":"SIGNAL_THREAD","parentId":"st-301",
  "body":"다른 관측 구간에서도 같은 패턴이 보입니다.",
  "historyIds":["h-501"],"sourceLinks":[]
}
```

부모·본문 필수, 본문은 1~2,000 Unicode 코드 포인트이며 공백만 입력할 수 없다. 자료 배열 생략 시 빈 목록이다. TIC는 부모에서 결정한다. 같은 TIC의 본인 History와 공개 출처는 F09·F24에서 구현한다. 성공 201은 `{"commentId":"c-801","createdAt":"2026-09-09T03:10:00Z"}`.

`PATCH /api/v1/comments/c-801`은 본문·자료만 수정하며 부모 이동은 제공하지 않는 안이다. 별도 버전 헤더 없이 호출하며 성공 200으로 변경된 댓글과 updatedAt을 반환한다. `DELETE` 성공은 204. 작성자 소유권과 부모 상태를 검사한다. SB-D22에 따라 부모 비공개 상태에서 수정은 거부하되 본인 댓글 삭제는 허용하며 본문을 응답하지 않는다.

**예외:** 다른 TIC 자료 400, 타인 수정 403, 없는 부모 404, 숨겨진 부모 접근 거부. 댓글 작성과 부모 숨김이 동시에 발생해도 숨겨진 댓글 내용이 공개돼서는 안 된다. 댓글 1~2,000자·공백만 입력 및 첨부만 작성 금지. 삭제 댓글은 목록·댓글 수에서 제외하고 삭제 자리 표시를 남기지 않는다(SB-D22).

<a id="attachments"></a>

## 7. 내 History 선택·공개 첨부·출처 — F09·24

### 7.1 내 기록 선택

`GET /api/v1/me/histories?ticId=123456789&size=20`

내가 가진 불변 기록을 선택하는 목록이다. 전체 응답·필터·정렬은 [탐사 명세 8.1절](exploration-api-spec.md#81-히스토리-목록)을 따른다. 첨부 선택 화면은 부모 TIC를 전달하고 서버는 실제 작성·첨부 시 같은 TIC인지 재검증한다. API 전체에 TIC 필수를 별도로 강제하지 않는다. **하나의 계약으로 연결하며 같은 원본 API를 양쪽에서 중복 구현하지 않는다.**

```json
{
  "items":[{
    "historyId":"h-501","ticId":"123456789","candidateId":"c-401",
    "userJudgment":"UNSURE","submittedAt":"2026-09-09T02:30:00Z",
    "publication":{"publicAnalysisId":null,"isPublic":false,"isModerationHidden":false},
    "achievementGranted":false
  }],
  "nextCursor":null,"hasNext":false
}
```

고유 신호 식별자는 ERD `candidates.id`에 맞춰 `candidateId`로 통일한다(분담 문서 2장 결정, 옛 `signalId` 표기 폐기). 미매칭 기록의 candidateId는 null일 수 있다. 위 예시는 첨부 선택 화면이 쓰는 최소 항목이며, 전체 항목 구조(`submissionKind`·`matchResult`·`curveStep`·`snapshotAvailable`·`relabel` 등)와 날짜·결과 필터·재도전용 원본 조회는 [탐사 API 명세 8.1절](exploration-api-spec.md)이 정의한다. 일반 글 첨부는 가능 여부를 별도로 검사하며, 공식 공개 분석은 미확정 고유 신호 매칭 자격이 필요하다. `achievementGranted`는 현재 공개 여부와 다르다.

### 7.2 공개 첨부와 출처 카드

**그래프 조회 계약(SB-D18, 리뷰 반영):** 첨부 조회와 `GET /api/v1/public-analyses/{analysisId}`의 그래프는 분석 화면 곡선 조회·잔차 결과 곡선과 같은 DTO다. **곡선 형식은 탐사 API 명세(강재민 작성 중)에서 한 번만 정의하고 이 절은 그것을 참조한다.** 그 명세가 병합되기 전까지 아래 구조를 합의 기준으로 두며, 이 절에서 별도 배열 형식을 새로 정하지 않는다. `graphMode=CURRENT|SUBMITTED`(생략 시 CURRENT)와 같은 공개 권한 검사는 유지한다.

**CURRENT — 세그먼트 배열(ERD `light_curve_segments` 기준)**

| 필드 | 의미 |
|---|---|
| bundleId, foldReferenceTimeBtjd | 실제 그래프를 만든 현재 판과 접기 기준 시각(BTJD) |
| curveContext | curveStep, removedCandidateIds, residualModelVersion, periodogramConfigVersion |
| residual | status(`QUEUED`/`RESIDUAL_CALCULATING`/`RESIDUAL_READY`/`PERIODOGRAM_CALCULATING`/`COMPLETED`/`FAILED`또는 null), jobId. 결과·작업이 모두 없으면 status·jobId=null. 제거 조합이 없으면 생략 |
| segments[] | segmentId, sector, binningRevision, startBtjd, binMinutes, nPoints, flux[], fluxScatter, gaps |

- 시각 배열은 보내지 않는다. i번째 점 시각은 `startBtjd + binMinutes / 1440 × i`(ERD 규칙)이고 결측은 null이다. JSON NaN/Infinity는 보내지 않는다.
- 산포(`fluxScatter` = ERD `flux_scatter`)는 세그먼트마다 둔다. DAT-11의 20,000점 초과 시 넓힌 실제 간격은 `binMinutes`로 표현한다. EXP-03·NFR-10의 Sector 경계·다년 공백 접기는 세그먼트 경계와 `gaps`로 판단한다.
- 첨부·공개 분석의 History 그래프 조회는 작업을 자동 생성하지 않는다. 진행 중이면 `curve.segments:null`과 기존 `curve.residual.jobId`로 폴링한다. 작업이 아예 없으면 가짜 QUEUED/jobId를 만들지 않고 미계산 상태로 안내한다. 사용자 확정: 초기에는 공개 조회자에게 타인의 잔차 재계산 요청 기능을 제공하지 않는다. 제공 가능한 원본 그래프 또는 제출 스냅샷만 표시하고 둘 다 없으면 그래프 제공 불가를 안내한다. 원본과 잔차는 구분해 표시하고 나머지 공개 내용은 계속 표시한다. 본인 분석용 잔차 요청 API의 기존 권한은 유지한다. 결과와 작업이 모두 없으면 residual의 status·jobId를 모두 null로 반환하고 폴링하지 않는다. null은 작업 생성 전 조회 표현이며 작업 상태 enum은 추가하지 않는다. 실제 작업이 있을 때만 그 상태와 ID를 반환하며, 타인에게 개인 작업 조회 권한을 추가하지 않는다. 계산 중은 503이 아니며 503은 의존성 장애·판 일관성 재조회 실패에 사용한다.

**History 그래프 — 첨부·공개 분석 공통**

| 묶음 | 필드 | 의미 |
|---|---|---|
| curve | 탐사 5.2절 세그먼트 DTO 또는 null | CURRENT는 동일 판의 곡선, SUBMITTED는 null |
| reproduction | submittedBundleId, currentBundleId, residualReproducible, fallbackReason | 제출 판과 현재 판, 잔차 재현 가능 여부. 은퇴 후보로 불가하면 `RETIRED_CANDIDATE`와 현재 원본 곡선 대체 |
| selection | userPeriodDays, correctedPeriodDays, harmonicMultiplier, epochBtjd, durationHours | ERD `submitted_period`·`matched_period`·`harmonic_multiplier`·`epoch_btjd`·`duration_hours`. 현재 판 재환산은 **사용자 원본 주기(userPeriodDays)** 기준(분석 프론트 명세 6.3) |
| snapshot | bins, foldedFlux[], foldedError[] 또는 `null` | analysis_snapshots. 운영 bins=150. i번째 위상은 `-0.5 + (i + 0.5) / bins`로 고정하며 축 범위 필드는 두지 않는다(제출 위상 구간 `phase_start`·`phase_end`와 이름 충돌 방지) |

매칭 실패 기록처럼 스냅샷이 없으면 409 대신 `snapshot: null`을 반환하고 프론트는 “제출 당시” 토글을 비활성화한다. SUBMITTED 요청에 최신 그래프를 대신 담지 않는다.

CURRENT 형식 예시. 가상 데이터이며 nPoints·gaps를 보이는 배열 길이에 맞췄다. 응답 외형은 탐사 8.3절을 따르고 CURRENT의 snapshot은 null, SUBMITTED의 curve는 null이다.

```json
{
  "historyId": "h-501",
  "curve": {
  "ticId": "123456789", "bundleId": "b-2",
  "foldReferenceTimeBtjd": 1683.4231,
  "curveContext": {"bundleId":"b-2", "curveStep": 1, "removedCandidateIds": ["c-401"], "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"},
  "residual": {"status": "COMPLETED", "jobId": "rj-77"},
  "segments": [
    {"segmentId": "seg-1", "sector": 14, "binningRevision": 1, "startBtjd": 1683.35, "binMinutes": 10, "nPoints": 4,
     "flux": [1.0001, 0.9998, null, 1.0003], "fluxScatter": 0.0012, "gaps": [[2, 2]]}
  ]},
  "reproduction": {"submittedBundleId": "b-1", "currentBundleId": "b-2", "residualReproducible": true, "fallbackReason": null},
  "selection": {"userPeriodDays": 3.21, "correctedPeriodDays": 3.21, "harmonicMultiplier": 1, "epochBtjd": 1684.02, "durationHours": 2.4},
  "snapshot": null
}
```

세그먼트는 탐사 5.2절, graph 외형과 snapshot:null 처리는 8.3절을 참조한다. 호출 경로의 graphMode는 탐사 내부 mode로 매핑한다. 아래 첨부 응답은 graphMode=SUBMITTED이지만 스냅샷이 없는 기록의 예다(curve:null, snapshot:null). graph 외형은 이 전체 객체이며 중첩 객체를 다시 평탄화하지 않는다.

**데이터 판 전환·실패 처리**

| 상황 | 서버·화면 처리 |
|---|---|
| CURRENT 조회 | 현재 Bundle ID를 선택하고 곡선·모델·잔차·주기도를 동일 Bundle과 계산 버전으로 조회한다. 응답의 currentBundleId는 실제 그래프를 만든 판이다. 서로 다른 판의 배열과 메타데이터를 섞지 않는다. |
| 조회·계산 중 판 전환 확인 | 응답 준비 시 선택한 판이 아직 current인지 확인한다. archived이거나 자료가 판 전환으로 사라졌다면 옛 결과를 최신 결과로 반환하지 않고 최신 판으로 조회 전체를 최대 1회 재시도한다. 같은 판을 여러 번 재계산하는 무제한 재시도는 하지 않는다. |
| 재시도에도 일관된 결과 확보 실패 | 503 `GRAPH_TEMPORARILY_UNAVAILABLE`로 재조회 안내. 실패를 빈 배열·0 값·계산 완료로 표현하지 않는다. 일반 작성 POST 자동 재시도 금지와는 별개의 읽기 복구 정책이다. |
| 응답 이후 판 전환 | 다음 조회에서 받은 currentBundleId가 바뀌면 최신 데이터 갱신 안내 후 그래프를 교체한다. 별도 실시간 알림 채널은 추가하지 않으며 탐사 화면의 기존 재조회 흐름과 연계한다. 진행 중 분석을 과거 판에 고정하지 않는다. |
| 마지막 정상 그래프 | 로딩·실패 중 유지할 수 있지만 표시 중인 판과 갱신 필요 상태를 구분한다. 옛 그래프를 최신 판으로 표시하거나 새 판의 수치와 합치지 않는다. |
| SUBMITTED 조회 | DB의 제출 당시 스냅샷과 제출 당시 메타데이터를 사용한다. 제출 Bundle ID를 보존하며 Gold 최신 판 갱신으로 스냅샷을 재계산하지 않는다. |

CURRENT 검사는 응답 후까지 최신성을 영구 보장하지 않는다. 원천 조회의 일관성과 판 전환 검사를 함께 적용하며 실제 DB 읽기 방식은 탐사·DB 담당자가 검증한다. 계산 중 새 판을 발견하면 최신 판으로 재로드하는 DAT-14·AT-80을 우선한다.

**Redis 적용 범위(DAT-14)**

| 항목 | 구현 기준 |
|---|---|
| 원천과 기록 | Gold 원천 배열·후보 모델, Submission/History·제출 스냅샷은 PostgreSQL에 둔다. Redis 유실로 제출·성과 기록이 없어지면 안 된다. |
| 캐시 대상 | 제거 후보 조합의 잔차 곡선·잔차 주기도와 계산 상태. 요청받은 조합을 필요할 때 계산·저장하며 Gold 전체를 Redis로 복제하지 않는다. |
| 키 | (tic_id, publication_bundle_id, 정렬·중복 제거한 removed_candidate_ids, residual_model_version, periodogram_config_version). 클라이언트 값은 현재 판·후보 관계를 검증한 뒤 사용한다. |
| 재사용 | 같은 키의 결과가 있으면 재사용, 없으면 원천에서 계산한다. 같은 조건의 결과는 회원 간 공유 가능하지만 요청마다 현재 인증·부모/분석 공개 상태·접근 권한을 확인한 뒤 제공한다. 캐시에 회원별 공개 응답을 그대로 저장하지 않는다. |
| 동시 계산 | 같은 키의 계산은 한 작업만 수행하도록 잠근다. 나머지는 해당 작업 상태를 조회한다. 잠금 만료 후 재실행된 경우 이전 작업의 늦은 저장·잠금 해제가 새 작업을 훼손하지 않게 소유권을 확인한다. |
| 단계 | QUEUED → RESIDUAL_CALCULATING → RESIDUAL_READY → PERIODOGRAM_CALCULATING → COMPLETED, 실패 시 FAILED와 실패 단계·원인·재시도 가능 여부. 잔차 준비와 주기도 완료를 구분한다. 그래프가 미완료면 이 상태를 안내하고 성공 배열로 위장하지 않는다. 탐사 상태 조회 API의 URL·응답은 탐사 담당자와 합의한다. |
| 판 변경 | 새 Bundle은 새 키를 사용하고 archived 판 캐시는 정리한다. 삭제 완료 여부와 관계없이 옛 키를 현재 결과로 사용하지 않는다. 진행 중 옛 작업의 완료 시에도 판·작업 소유권을 확인해 폐기 대상 캐시를 다시 살리지 않는다. |
| 유실·장애 | 캐시 미존재·만료는 재계산 대상으로 처리한다. Redis 연결 장애는 캐시 미존재와 구분하고 무제한 우회 계산을 시작하지 않는다. 상태·잠금을 확보할 수 없으면 503으로 안내하며 기존 제출·성과는 유지한다. |
| 자원 | 결과 TTL·메모리 상한·잠금 유효시간·계산 동시 상한은 실제 결과 크기와 계산 시간 측정 후 설정한다. 로그인 세션의 30분 정책을 계산 캐시에 그대로 적용하지 않는다. 세션 저장소는 SB-D07에서 확정했다. |

**검증 사례:** 같은 제거 집합의 순서 변경 시 같은 키 / Bundle·계산 버전 변경 시 다른 키 / 같은 키 동시 요청의 계산 중복 방지 / 판 전환과 늦은 계산 완료 경합 / 캐시 만료 후 재계산 / Redis 장애 시 제한 없는 계산 금지 / 숨김 후 캐시 접근 차단 / 스냅샷 없음(snapshot: null) / 잔차 미완료 시 residual.status 반환 / 은퇴 후보 원본 대체 / 조회 전체 재시도 상한. 구현 완료 시 실제 테스트로 검증한다.

글은 `GET /api/v1/posts/p-201/history-attachments/h-501`, 댓글은 `GET /api/v1/comments/c-801/history-attachments/h-501`로 조회한다. 각각 post_history_attachments의 (post_id, history_id), comment_history_attachments의 (comment_id, history_id) 유일 쌍에 대응한다. 단일 attachmentId는 사용하지 않는다. 부모와 해당 History의 첨부 관계가 실제로 있어야 하며, 관계가 없으면 404다. 부모·상위 스레드 공개 상태, 소유자·TIC 적합성을 검사한 뒤 제한된 자료를 반환한다. History ID를 아는 것만으로 조회 권한이 생기지 않는다. 성공 200 최소 구조는 아래와 같다. 공개 필드는 9.2 공개 분석 상세와 같으며 메모를 포함한다(SB-D23). 수치 단위·필드명은 탐사와 합의한다.

```json
{"parentType":"POST","parentId":"p-201","historyId":"h-501","ticId":"123456789","submittedAt":"2026-09-09T02:30:00Z","judgment":"UNSURE","graph":{"historyId":"h-501","curve":null,"reproduction":{"submittedBundleId":"b-1","currentBundleId":"b-2","residualReproducible":true,"fallbackReason":null},"selection":{"userPeriodDays":3.21,"correctedPeriodDays":3.21,"harmonicMultiplier":1,"epochBtjd":1684.02,"durationHours":2.4},"snapshot":null}}
```

이미지는 저장하지 않는다. 현재 PostgreSQL 곡선 배열과 제출의 절대 epoch·duration·주기로 재현한다. 이전 Bundle 제출 표시와 은퇴 후보로 잔차 재현 불가 시 현재 원본 곡선 대체 안내가 필요하다. 매칭 성공에는 analysis_snapshots의 150구간 folded_flux/folded_err로 당시/최신 토글을 제공하고 불일치에는 축약 스냅샷이 없다. 배열 상세 응답·참조 경로는 탐사와 합의하며 부모 공개 권한을 적용한다.

`GET /api/v1/source-cards?type=PUBLIC_ANALYSIS&id=pa-601&ticId=123456789`:

```json
{"type":"PUBLIC_ANALYSIS","id":"pa-601","ticId":"123456789","author":{"memberId":"u-102","nickname":"관측자"},"judgment":"LIKELY_PLANET","submittedAt":"2026-09-09T02:00:00Z","available":true}
```

세 쿼리는 필수. SIGNAL_THREAD 카드는 9장의 judgmentSummary와 신호 요약을 포함한다. 미리보기 성공 후에도 게시·별 변경·조회 때 다시 검증한다. 취소·숨김된 출처는 내용을 반환하지 않는다. 기존 글에서는 `available:false` 같은 안내만 남기는 안이며 비노출 ID 반환 범위는 별도 합의한다. 타인의 개인 History 원본 전체 접근은 허용하지 않는다.

<a id="reactions"></a>

## 8. 일반 글 반응 — F10

`PUT /api/v1/posts/p-201/my-reaction`에 아래처럼 **원하는 최종 상태**를 보낸다.

```json
{"reaction":"AGREE"}
```

AGREE=동의, DISAGREE=비동의, NONE=취소. 성공 200:

```json
{"postId":"p-201","myReaction":"AGREE","agree":4,"disagree":1}
```

같은 요청 반복은 숫자를 더하지 않는다. AGREE에서 DISAGREE로 바꾸면 기존 동의가 제거되고 비동의가 하나 생긴다. 회원·일반 글당 최대 하나이며 본인 글도 가능하다. 공식 스레드 세 판단과는 별개다.

`GET /api/v1/posts/p-201/reactions?reaction=AGREE&size=20`의 reaction은 AGREE/DISAGREE 필수:

```json
{"items":[{"memberId":"u-101","nickname":"별찾는사람"}],"nextCursor":null,"hasNext":false}
```

모든 인증 회원이 페이지 순회로 반응자 전원을 볼 수 있는 안이다. 최신 닉네임 사용. 목록·합계는 각 응답의 조회 시점 기준이어서 별도 호출 사이 변동 가능하다. 숨김·삭제 상태의 변경/취소 허용과 탈퇴 회원 표시는 미정이다.

<a id="analyses"></a>

## 9. 공식 스레드·공개 분석 — F07·16·22

### 9.1 공개 등록

내 분석 검토 화면의 ‘공개’에서 `POST /api/v1/public-analyses` 호출:

```json
{"historyId":"h-501"}
```

작성자·TIC·신호·판단·수치는 클라이언트가 덮어쓰지 못하며 서버가 원본 History에서 확인한다. SB-D23에 따라 필드별 공개 선택은 두지 않으며 요청은 선택한 기록 자체만 보낸다. 메모도 SRS COM-18에 따라 공개되며, 공개 검토 화면에서 메모를 보여주고 “닉네임·판단·근거·메모·분석 수치·그래프가 공개됩니다”를 안내한다.

```json
{
  "analysisId":"pa-601","threadId":"st-301","historyId":"h-501",
  "isPublic":true,"created":true,"achievementGranted":true,"newlyGranted":true,
  "skyVersion":"u-101:58",
  "achievement":{"result":"recognized","newlyRecognized":true,"unlockedStars":[{"ticId":"123456790"}],"star":{"count":1,"grade":"A","byType":{"confirmed":0,"unconfirmed":1,"fp":0}},"unlockShortfall":0},
  "judgmentSummary":{"participantCount":1,"likelyPlanet":0,"unlikelyPlanet":0,"unsure":1,"asOf":"2026-09-09T03:00:00Z"}
}
```

새 공개 기록 201, 같은 기록 재요청 200 제안. achievementGranted는 조회 시점에 해당 회원×신호의 성과가 존재하는지, newlyGranted는 이번 실행이 신규 성과를 생성했는지다. 최초 성공은 둘 다 true, 응답 유실 후 재시도는 achievementGranted=true·newlyGranted=false다. created는 이번에 공개 기록을 만들었는지다. 화면의 성과 보유 표시는 achievementGranted를 사용한다. 실패 항목에서 성과 조회도 실패했으면 null(확인 불가)로 처리하고 false로 단정하지 않는다.

- posts.kind=system_thread, user_id=NULL로 공식 공간을 만든다. threadId는 posts.id, candidateId는 candidates.id다. comments.post_id도 일반/공식 posts를 가리킨다. published_analyses.history_id UNIQUE이며 post_id로 공식 스레드를 참조한다.
- 세 판단 모두 공개·최초 성과 인정 가능. 이미 성과를 받은 duplicate의 새 제출도 공개 가능하나 추가 성과 없음.
- 신호별 공개·공식 공간·최초 성과·진행 수·별 발견은 아래 SB-D15의 단일 트랜잭션으로 반영한다. 최초 성과 INSERT마다 stars_per_achievement개(기본 1)를 발견하고 trigger_achievement_id+seq로 중복을 막는다. TIC별 성과 수 1/2/3/4 이상을 A/S/SS/SSS로 표시하며 FP도 상한이 없다. 완료·등급 상승 자체는 발견 트리거가 아니다.
- 일반 Post·댓글·반응은 자동 생성하지 않는다. 미공개·공개 실패가 개인 기록이나 탐색 완료를 되돌리지 않는다.
- 이미 취소된 동일 기록을 POST로 재전송하면 취소 상태를 유지해 반환하는 안이다. 의도적 재공개는 아래 visibility API로 구분해 오래된 재시도가 취소를 되돌리지 않게 한다.
- 다른 사람 History는 접근 거부, 미매칭/부적격은 409 `PUBLICATION_NOT_ELIGIBLE` 제안. 상위 운영 숨김은 409 `THREAD_HIDDEN`; 대체 스레드·성과를 만들지 않는다. 최초 공개 전 라벨이 바뀐 옛 기록의 자격은 미정.

**공개·성과 저장 경계(SB-D15, 사용자 확정)**

| 항목 | 구현 계획 |
|---|---|
| 저장 단위 | 신호 한 건마다 같은 PostgreSQL·같은 트랜잭션에서 회원 상태·공개 자격 검증 → 공식 스레드 확보 → published_analyses 저장 → 최초 user_candidate_achievements 생성 → user_star_progress 갱신 → star_unlocks 저장을 처리한다. 서비스·탐사 내부 호출도 이 트랜잭션에 참여한다. |
| 중간 실패 | 해당 실행에서 새로 저장·변경한 내용을 전부 롤백한다. 기존 공식 스레드·기성과 및 별도 제출에서 이미 저장된 Submission/History는 유지한다. 커밋 전에 성공 응답을 보내지 않는다. |
| 회원별 동시 처리 | users의 해당 회원 행을 잠근 뒤 상태·기존 성과를 검사한다. 같은 회원의 성과 생성·진행 수 갱신·별 선택을 순서대로 처리한다. 미확정 공개뿐 아니라 확정/FP 성과 경로도 공통 처리 함수를 사용한다. 다른 별 발견 경로도 같은 회원 잠금 규칙을 따른다. |
| DB 중복 방지 | 공식 스레드는 candidate_id 부분 유일 제약, 공개 기록은 history_id, 성과는 (user_id, candidate_id), 별 발견은 (user_id, tic_id)와 (trigger_achievement_id, seq) 유일 제약을 사용한다. 서로 다른 회원이 동시에 첫 공개를 해도 공식 스레드는 하나만 확보한다. |
| 재시도 | 동일 History는 기존 공개 기록을 재사용한다. 실제로 새 성과가 생성된 경우에만 진행 수·별 발견을 추가한다. 응답 유실 후 재요청에도 성과를 다시 지급하지 않고, 취소된 공개를 되살리지 않는다. |
| 일괄 공개 | 신호별 독립 트랜잭션으로 처리한다. 성공 항목은 커밋하고 실패 항목만 롤백한다. 전체 일괄 요청을 하나의 트랜잭션으로 감싸지 않는다. |
| 통계 | 공개 판단 분포는 커밋된 유효 공개 기록으로 조회한다. global_stats의 10분 갱신·일별 StatsSnapshot은 공개 트랜잭션에 넣지 않는다. |

**팀 교차 검토·구현 확인:** 관련 쓰기가 같은 PostgreSQL 연결·트랜잭션에 참여하는지, 확정/FP 경로도 공통 잠금·지급 함수를 쓰는지 확인한다. 잠금 순서를 통일하고 유일 충돌은 충돌 무시 후 기존 행 조회 등 트랜잭션을 망가뜨리지 않는 방식으로 처리한다. 잠금 시간 초과·교착 시 신호 단위로 롤백하며 실패 항목으로 안내한다. 탐사 D-11 통합 검토안대로 미발견 별이 부족하면 있는 만큼만 열고 성과는 인정하며 achievement.unlockShortfall로 부족 수를 반환한다. 이 결정안의 최종 상태는 탐사 MR 리뷰를 따른다. 이번 결정은 팀 검토나 구현 완료를 의미하지 않는다.

**필수 검증:** 동일 History 동시 공개·응답 유실 재시도 / 다른 회원의 동일 신호 최초 공개 / 같은 회원의 다른 신호 동시 성과(확정/FP와 공개 혼합 포함) / 성과 저장 뒤 별 저장 실패 시 전체 롤백 / 일괄 일부 실패 시 성공분 유지. 성과 수가 실제 성과 행 수와 같고 추가 별 지급이 중복되지 않는지 확인한다.

**공개 후 성과·지도 응답(탐사 D-7·D-9·D-11 통합 검토안)**

개별 공개와 일괄 성공 항목에 탐사 6.4절과 같은 achievement 객체 및 skyVersion을 포함한다. achievement.newlyRecognized는 기존 newlyGranted와 같은 이번 실행의 신규 여부이며 achievementGranted는 현재 보유 여부로 별개다. unlockedStars는 이번 실행에서 새로 열린 별만 담고 star는 현재 TIC 성과 수·등급·유형별 수다. skyVersion은 커밋 이후 회원 지도의 버전이며 새 별이 없어도 현재 버전을 제공한다. 재시도에는 신규 여부 false·unlockedStars 빈 배열로 중복 화면 효과를 막는다.

9.2절 내부 지급 함수의 newlyRecognized·unlockedStars를 그대로 받고, star는 같은 트랜잭션의 현재 진행·성과 집합, skyVersion은 탐사 지도 갱신 계약에서 가져온다. 회원 데이터는 서버에서 결정한다. 예시 unlockedStars는 TIC만 축약했으며 전체 항목은 탐사 반환 DTO를 따른다. 함수 시그니처 자체에 없는 필드를 단순 반환한다고 가정하지 않는다. 실패 항목에는 존재 여부를 확인하지 못한 성과·지도 값을 만들어 넣지 않는다. 공개 ID는 서비스 응답에서 analysisId, 탐사 publication에서는 publicAnalysisId로 명시적으로 매핑한다.

일괄 요청의 항목별 skyVersion은 각 신호 커밋 시점이며 프론트는 전체 처리 후 지도 메타를 다시 조회한다. 서로 다른 항목의 버전·성공 배열을 하나의 고정 스냅샷으로 가정하지 않는다. 잠금 순서는 공통 탐사 함수와 동일하게 정하고, 문서의 업무 처리 순서를 별도 잠금 획득 순서로 구현하지 않는다.

### 9.2 스레드·공개 목록·상세

`GET /api/v1/signal-threads/st-301`, 성공 200:

```json
{
  "threadId":"st-301","ticId":"123456789","candidateId":"c-401",
  "title":"TIC 123456789 신호 s-401 밝기 분석","author":{"type":"SYSTEM","displayName":"SYSTEM"},
  "judgmentSummary":{
    "participantCount":15,"likelyPlanet":8,"unlikelyPlanet":4,"unsure":3,
    "percentages":{"likelyPlanet":53.3,"unlikelyPlanet":26.7,"unsure":20.0},
    "asOf":"2026-09-09T03:00:00Z"
  }
}
```

판단은 회원×고유 신호당 **최신 유효 공개 제출 한 건**이다. 최신 기준은 Submission 서버 접수 시각·동률 Submission id이며 공개한 시각이 아니다. 미공개 재제출은 영향을 주지 않는다. N=0은 percentages를 null로 반환하고 ‘아직 공개된 분석이 없습니다’를 표시하는 안이다. 비율은 행성일 확률이 아니다.

`GET /api/v1/signal-threads/st-301/analyses?judgment=UNSURE&size=20`:

- judgment는 생략 또는 LIKELY_PLANET/UNLIKELY_PLANET/UNSURE. 목록은 현재 유효한 공개 기록을 대상으로 하며 과거 공개 분석도 포함한다. 한 회원의 기록이 여럿 보일 수 있지만 통계 기여는 한 건이다.
- 성공 200 공통 목록의 항목: analysisId, author, submittedAt, judgment, contributesToSummary. 마지막 필드는 현재 통계 대표 기록인지 나타내는 제안이다.
- 판단 필터는 목록만 좁힌다. 전체 judgmentSummary의 N을 바꾸지 않는다. 목록 건수와 참여자 N은 다를 수 있다.
- 목록 정렬은 제출 시각 내림차순·Submission id 제안. 신호 통계는 실시간 쿼리로 같은 요청 안에서 한 번 계산해 공유한다. 별도 요청 사이에는 변화할 수 있다.

`GET /api/v1/public-analyses/pa-601`은 analysisId, threadId, ticId, author, submittedAt, firstPublishedAt, judgment, 근거 체크, 메모, 판단 재현에 필요한 수치(period·기준 시각·통과 지속시간 등), graph(최신 판·제출 당시 스냅샷), 제거 후보 조합·데이터 판·계산 버전만 반환한다(SB-D23). 다른 제출·미공개 기록·성과 내부 처리 정보는 반환하지 않는다. 수치 단위·필드명은 탐사와 합의한다. 개인 원본 전체를 그대로 응답하는 방식은 금지한다.

채점형은 성과 여부와 무관하게 해당 신호에 matched/matched_harmonic한 회원의 첫 매칭 제출을 사용한다. 접수 시각 오름차순·동률 Submission id 오름차순으로 선택하며 재제출로 바꾸지 않는다. 세 판단 막대 대신 ‘이 신호를 찾은 사람 중 기록과 일치 N% · M명’으로 표시한다. 공개 분석 API를 확정/FP 전체에 확장하지 않는다. 결과 화면용 API는 탐사 담당자와 별도 계약한다.

### 9.3 취소·재공개

`PUT /api/v1/public-analyses/pa-601/visibility`:

```json
{"isPublic":false}
```

성공 200은 `{"analysisId":"pa-601","isPublic":false,"isModerationHidden":false,"isEffectivelyPublic":false}`. 재공개는 true. published_at은 첫 등록 시각을 유지하며 취소는 unpublished_at 기록, 재공개는 NULL로 해제한다. 작성자만 변경 가능하며 같은 상태 반복은 중복 반영하지 않는다.

본인 공개 상태와 운영 숨김은 별도로 유지한다. 운영 숨김 중 true 요청은 409로 거부하는 안이다. false 요청은 본인 관리 경로에서 허용하는 안이며 최종 권한 합의가 필요하다. 숨겨진 콘텐츠를 응답에 다시 담지 않는다. 취소 후 남은 유효 기록 중 최신 판단을 선택하고 없으면 통계에서 회원을 제외한다. 성과·등급·History·탐색 완료는 유지한다.

<a id="batch"></a>

### 9.4 여러 신호 일괄 공개 — F23

TIC 종료 화면에서 신호별 대표 기록(기본 최신 미공개 제출)을 검토한 후 호출한다.

`POST /api/v1/public-analyses/batch`:

```json
{"ticId":"123456789","items":[{"historyId":"h-501"},{"historyId":"h-502"}]}
```

본문 전체 형식 오류·항목 상한 초과는 처리 전 400. 항목 상한은 요청당 20개를 **제안**하며 탐사 처리 시간·트랜잭션 제한을 확인한 뒤 팀이 확정한다(14장). 같은 신호 복수 선택은 검토 화면에서 한 건으로 제한하고 서버에서도 처리 전 거부하는 안이다. 서로 다른 신호는 항목별로 처리한다.

```json
{
  "results":[
    {"historyId":"h-501","status":"PUBLISHED","analysisId":"pa-601","threadId":"st-301","achievementGranted":true,"newlyGranted":true,"skyVersion":"u-101:58","achievement":{"result":"recognized","newlyRecognized":true,"unlockedStars":[{"ticId":"123456790"}],"star":{"count":1,"grade":"A","byType":{"confirmed":0,"unconfirmed":1,"fp":0}},"unlockShortfall":0}},
    {"historyId":"h-502","status":"FAILED","error":{"code":"DEPENDENCY_UNAVAILABLE","message":"분석 자료를 잠시 불러올 수 없습니다."},"retryable":true}
  ]
}
```

요청을 처리한 결과는 일부 실패도 **200 + 항목별 결과**로 반환하는 안이다. 프론트는 HTTP 성공만 보고 ‘모두 성공’으로 표시하지 않는다. status는 PUBLISHED/FAILED/NOT_PUBLISHED 제안이며 이미 취소된 기록의 단순 재전송은 NOT_PUBLISHED와 의도적 재공개 필요 안내로 구분한다.

성공분은 유지하고 실패한 h-502만 재전송한다. 응답이 유실돼 전체 재시도해도 같은 History와 성과를 중복 생성하지 않는다. 항목별 처리 중 상태는 프론트 표시 상태이며 비동기 Job 도입을 뜻하지 않는다. 여러 성과의 성과당 별 발견·누적 등급 표시는 순차 개별 인정과 동일한 결과여야 한다.

<a id="moderation"></a>

## 10. DB 숨김 상태 적용 — F12

v1에서는 신고·숨김/복원 운영 API·화면·감사를 제공하지 않는다. 운영자는 DB에서 posts/comments.status 또는 published_analyses.hidden_at을 변경한다. 일반 요청으로 hidden을 수정할 수 없어야 한다.

- 모든 공개 조회는 현재 DB 상태를 검사한다. 상위 숨김은 분석·댓글·첨부·출처·검색·직접 URL에 적용하고 신규 공개·대체 생성을 막는다.
- 본인 취소 unpublished_at과 hidden_at은 독립이다. 부모 복원으로 본인 취소·개별 숨김을 해제하지 않는다.
- 신호 통계는 현재 유효 집합을 쿼리한다. DB 직접 변경은 앱 이벤트가 없어도 반영돼야 한다. 오래된 캐시 응답으로 접근을 우회하지 않는다.
- 원본 History·기성과·탐색 완료를 유지한다. 외부 라벨만으로 기존 성과·등급·과거 StatsSnapshot을 재계산하지 않는다.

<a id="challenge"></a>

## 11. 주간 챌린지·첫 접속 안내 — F17

홈 진입에서 `GET /api/v1/challenges/current`를 호출한다. ERD의 challenge_rounds와 탐사 자격으로 현재 회차를 조회하며 회원별 안내 확인 기록은 저장하지 않는다.

```json
{
  "round": {
    "roundId": "cr-901",
    "roundNo": 1,
    "ticId": "123456789",
    "startsOn": "2026-09-07",
    "endsOn": "2026-09-14",
    "status": "active",
    "description": "밝기 변화가 얕은 별에서 두 번째 신호를 찾아보세요"
  },
  "eligible": true,
  "participantCount": 12
}
```

roundNo/startsOn/endsOn/status는 ERD의 round_no/starts_on/ends_on/status에 대응한다. 날짜는 예시다. 시작 요일·기준 시간대·종료일 포함 여부는 합의 후 경계 계산에 적용한다. 진행 회차가 없으면 200 `{"round":null,"eligible":false}`. 서버는 shouldShow·acknowledged를 반환하지 않는다.

- 튜토리얼 5개 완료 회원만 별 발견 자격이 있다. 회차는 미확정·AI 승인 별 하나다. 미완료 회원에게는 eligible=false, ticId=null로 대상 노출을 제한하는 최소안을 유지하며 소개 표시 여부는 별도 합의한다.
- SB-D20 확정: 진행 중 회차에 참여 가능한 회원에게만 새 챌린지 안내를 표시한다. 프론트는 현재 roundId와 브라우저의 회원별 마지막 안내 회차를 비교한다. 실제 안내 표시 후에만 회차를 기록하며 API 조회만으로 기록하지 않는다. 확인 테이블·서버 확인 API는 추가하지 않는다.
- 같은 회원·브라우저에서 기록된 회차는 재안내하지 않고 다음 회차에는 다시 안내한다. 이 방식은 기기·브라우저 간 확인 상태를 공유하지 않는다. 브라우저 저장소 삭제·다른 기기 접속 시 같은 회차 안내가 다시 나올 수 있다. 엄격한 회원별 1회 안내를 보장하지 않는다.
- 브라우저 저장 실패는 챌린지 이용을 막지 않으며 안내 반복을 허용한다. 같은 브라우저의 다른 회원은 별도 기록을 사용한다. 여러 탭의 동시 안내까지 정확히 한 번으로 보장하지 않는다. 기기 간 확인 공유는 P1 일반 알림에서 검토한다.
- 시작일 미접속 회원은 진행 중 다음 홈 진입에서 참여 자격을 확인해 안내한다. 종료·취소되어 진행 대상이 아닌 회차는 새 회차로 안내하지 않는다. GET은 별 발견 상태를 변경하지 않고 탐사·회차 처리 계약에서 별 발견을 멱등 반영한다.
- 기기 간 읽음 동기화가 필요하면 P1 notifications의 type=challenge, payload의 회차 참조, read_at을 활용하는 방향으로 상세화한다. 별도 회원×회차 확인 테이블을 추가하지 않는다. 알림 중복 생성 방지는 P1 계약에서 정한다.

챌린지 달성·성공·전용 보상 API는 없으며 일반 탐사 성과는 별도다. description은 ERD v1.1 challenge_rounds.description이며 participantCount는 SRS v1.1·탐사 4.3절의 대상 별 공식 스레드 유효 공개 분석 참여자 수 원천을 공유한다. 스레드가 없으면 0이다. 사용자 확정: 대상 별의 모든 공식 신호 스레드에서 현재 유효 공개 분석을 가진 회원을 별 단위로 중복 제거해 집계한다(COUNT DISTINCT 회원 ID). 여러 신호에 참여해도 1명이며 스레드별 N을 합산하지 않는다. 공개 취소·숨김 후 다른 유효 공개 분석이 남으면 포함하고, 하나도 없으면 제외한다. 핫 토픽·판단 분포의 신호별 집계는 변경하지 않는다. 회차가 없으면 기존 round:null 응답을 유지한다.

<a id="later"></a>

## 12. 추가 운영 및 P1 API 후보

아래는 책임과 범위를 확인하기 위한 후보이며 요청·응답이 확정된 API가 아니다. 미정 정책을 임의 구현하지 않는다.

| 범위 | 우선순위 | 경로 후보 | 구현 전에 정할 내용 |
|---|---|---|---|
| 챌린지 회차 설정 | P0 DB 작업 | 관리 API 없음 | planned/active/closed. 기간·대상 검증과 적용 책임 협의 |
| 튜토리얼·규칙 | P0 DB 작업 | 관리 API 없음 | operation_settings 새 rule_version 행·과거 보존·Submission 참조 |
| 데이터 재처리 | P0 배치 계약 | 관리 API 선행 구현 없음 | 배치 담당 실행·권한·중복·실패 복구 |
| 신고 | v1 제외 | 없음 | v1.1 이후 재도입 시 상세화 |
| 회원·별 팔로우 | P1 | `PUT/DELETE /api/v1/me/following/members/{memberId}`, `PUT/DELETE /api/v1/me/following/stars/{ticId}` | 대상 자격·수신 설정·목록 공개·피드 포함 |
| 일반 알림·설정 | P1 | `GET /api/v1/me/notifications`, `PATCH /api/v1/me/notification-settings` | 종류·읽음·채널·보관·중복. F17 첫 접속 안내와 분리 |
| 내·전체·비교 통계 | P1 | `GET /api/v1/me/statistics`, `GET /api/v1/statistics` | 전체 global_stats 10분 갱신·비교 stats_snapshots 일별. 첫 매칭 산식·90일 경계·분모 0 |
| 전문가 제보 | 보류 | 경로 미정 | SRS RPT P1과 ERD expert_reports 제외 충돌. 팀 합의 후 구현 |
| 탈퇴 | 보류, 데이터 정책 P1 | API 제공 시점·경로 미정 | 보관·익명화·재가입과 접근 차단. 제공 시 탈퇴/작성 DB 확정 순서 적용 |

회원 차단·다중 제공자 연결·이메일 수정·챌린지 전용 성공/보상은 이번 API에 추가하지 않는다. 개인 History 삭제 API도 현재 범위에 없다.

## 13. 탐사·프론트와 함께 확인할 계약

| 연결 지점 | 서비스가 필요한 정보·보장 | 협의자 |
|---|---|---|
| TIC·게시판 자격 | 별 존재·최초 발견·회원별 분석 진입 자격. 열람과 분석 진입 구분 | 탐사 |
| History | 소유자·TIC·고유 신호·불변 분석값·제출 시각/id·Bundle·버전·공개 허용 필드 | 탐사·프론트 |
| 최초 공개 성과 | 회원×신호 1회, 등급/별 발견 포함 신호별 원자성·응답 유실 재시도 | 탐사·DB |
| 공개 통계 | 최신 유효 공개 선택, 취소·숨김 시 이전 기록 복귀, 같은 시각 조회 | 탐사·프론트 |
| 챌린지 | 튜토리얼 완료·회차 자격·멱등 별 발견·첫 접속 안내 | 탐사·프론트 |
| 외부 라벨·재개 | 기존 성과·스냅샷 보존, 공개 기록 출처 유지, 재개 안내 P0/P1 경계 | 탐사·데이터 |

서비스와 탐사는 업무 구분이며 별도 서버를 뜻하지 않는다. SB-D15에 따라 공개·성과·별 발견은 단일 Spring Boot의 내부 호출과 같은 PostgreSQL 트랜잭션으로 처리한다. 메시지 브로커는 추가하지 않는다. 팀 교차 검토에서 관련 쓰기가 다른 저장소에 분리된 것으로 확인되면 이 전제를 다시 설계한다.

## 14. 팀 검토 체크리스트

### 입력·검색 조건과 남은 협의

**사용자 확정:** SB-D14의 입력·로그인 정책을 적용한다. 검색은 SB-D24 제안, 핫 토픽 산식은 DEC-09 확정(SB-D16)이며 일괄 공개 상한은 별도 협의 대상이다. 사용자 승인과 팀 교차 검토 완료는 구분한다.

| 항목 | 기준·상태 | 남은 작업 |
|---|---|---|
| 제목 / 본문 / 댓글 | 확정: 각각 1~100 / 1~10,000 / 1~2,000 Unicode 코드 포인트. 공백만 입력 거부 | 프론트·서버 같은 계산 검증 |
| 닉네임 | 확정: NFC·앞뒤 공백 제거 후 2~20자. 한글 완성형·영문·숫자·밑줄만. 내부 공백 불허, 영문 대소문자 무시 중복 | DB 중복 제약 반영·금칙어 관리 담당 |
| 자료 수 | 확정: 글·댓글 각각 History 최대 3개, 출처 카드 최대 3개. 동일 종류·ID 중복 거부 | 본문 필수, 첨부만 작성 불허 |
| 일괄 공개 | 제안: 요청당 20개, 같은 신호 한 건(9.4절) | 탐사 처리 시간·트랜잭션 제한 확인 후 팀 확정 |
| 검색 | P1(P0 상향 요청). SB-D24 제안: 제목·본문 키워드(searchIn)·작성자 현재 닉네임·TIC·게시판·태그 AND, 앞뒤 공백 제거·내부 유지, 최신순·기본 20/최대 100개 | pg_trgm GIN 인덱스 ERD 반영·성능 측정·공식 제목 생성 규칙·팀 교차 검토. 바인딩·와일드카드 이스케이프로 문자 그대로 검색 |
| 핫 토픽 임계값 | DEC-09 확정(SB-D16): 공식 스레드 N >= 10, 일반 글·댓글 조건 제외 | 구현·팀 교차 검토 |
| 핫 토픽 기간·정렬 | SB-D16 확정: 기간 제한 없음, 참여자 수→스레드 생성 시각→ID 내림차순 | 조회·동률 검증 |
| 핫 토픽 탈락 | SB-D16 확정: N < 10 제외, N >= 10 재진입, 숨김은 무조건 비노출 | 공개 취소·숨김·복원 후 유효 집합 검증 |

**입력 처리 세부(SB-D14):** 제목은 앞뒤 공백 제거·줄바꿈 불허. 본문·댓글은 줄바꿈 허용·공백만 입력 불허. HTML·Markdown은 서식으로 실행/해석하지 않고 일반 텍스트로 렌더링한다. 제목·본문·댓글 이모지는 허용하되 코드 포인트 수로 세어 화면상 한 글자와 다를 수 있다.

닉네임은 한글 완성형·영문 A-Z/a-z·숫자 0-9·밑줄만 허용한다. 예약어 최소 목록은 SYSTEM/ADMIN/관리자/운영자이며 정규화·영문 소문자 비교 후 정확 일치 시 거부한다. 추가 금칙어 목록과 관리자는 별도 합의한다. 변경 횟수 제한은 없다. 자동 초기 닉네임에도 같은 검증을 적용한다.

**DB 반영 필요:** nickname UNIQUE만으로 대소문자 무시 중복을 보장한다고 가정하지 않는다. 정규화된 닉네임을 저장하고 lower(nickname) 유일 인덱스로 보장하는 안을 DB 담당자와 검토한다. 기존 충돌 데이터 확인 후 마이그레이션해야 한다. 정책은 확정이며 물리 반영은 아직 수행하지 않았다.

**세션 기준(SB-D14):** 마지막 인증 요청 10:00이면 만료 10:30, 10:20에 요청하면 만료 10:50. 만료 시각 이후 요청은 401이다. 유효 인증 후 입력 오류·권한 부족도 요청 활동으로 보고 정적 파일·미인증 요청은 연장 근거로 쓰지 않는다. 회원 상태·소유권은 매 요청 검사한다. 시간 만료가 이미 인증된 처리 중 요청을 중간 취소한다는 의미는 아니다. 저장소는 SB-D07에서 확정했고(EC2-A Redis) 세션 TTL은 계산 캐시 TTL과 분리한다. Redis 장애 시 인증 요청은 401이 아니라 **503**이다(`S15P21C206-237`). 쿠키·CSRF 세부는 후속 설계다.

**동시 수정 확정(SB-D19):** 2.3절의 변경 필드만 저장·같은 필드 마지막 저장·PATCH 자동 재시도 금지·결과 불명확 시 상세 재조회 규칙을 적용한다. 검증은 같은 본문 동시 수정, 서로 다른 필드 수정 시 양쪽 변경 보존, 배열 교체와 TIC 적합성, 응답 유실 시 재조회, 삭제 선확정 후 수정 거부, 타인 수정 거부를 포함한다.

- [ ] URL·필드·enum·날짜·페이지·오류 형식을 프론트와 합의했다.
- [x] SB-D14 입력 제한·로그인 정책을 사용자와 확정했다.
- [ ] 입력 정책의 DB·프론트 반영, 페이지·일괄 상한을 검토했다.
- [ ] 세션·CSRF 전달 계약, 401/403과 비노출 404 대상을 합의했다.
- [x] 핫 토픽 산식을 DEC-09 팀 결정으로 확정했다(SB-D16 채택, 안건 5 기본안 폐기).
- [ ] 검색·핫 토픽 P0 상향과 검색 세부 방식(SB-D24 제안)을 팀과 합의했다.
- [ ] 검색·핫 토픽 정책을 팀과 교차 검토했다.
- [x] SB-D23 타인 프로필·공개 분석 공개 범위(메모 포함, SRS 기준)를 사용자와 확정했다.
- [ ] 공개 분석 수치 필드명·단위를 탐사와 합의했다.
- [x] SB-D15 공개·성과·별 발견의 신호별 트랜잭션과 공통 회원 잠금 방향을 사용자와 확정했다.
- [ ] 탐사·DB 담당자와 동일 트랜잭션 참여, 전체 성과/별 발견 경로의 잠금 규칙, 미발견 별 부족 정책을 검토했다.
- [x] SB-D19 일반 글·댓글의 동시 수정·재조회·삭제 후 수정 거부 정책을 사용자와 확정했다.
- [x] SB-D22 일반 글·댓글 삭제·숨김·본인 삭제·반복 DELETE·비노출 오류 정책을 사용자와 확정했다.
- [ ] 삭제·숨김의 DB 상태 경합과 캐시 접근 차단을 팀과 교차 검토했다.
- [x] SB-D20 참여 가능 회원의 브라우저별 안내·실제 표시 후 기록·기기별 반복 허용을 사용자와 확정했다.
- [ ] 챌린지 시작 요일·시각·시간대 및 기간 경계를 팀과 합의했다.
- [ ] P1 미정 사항을 후속 Task로 이관하고 검토자·날짜를 기록했다.

## 15. 작성 이력

| 날짜 | 변경 |
|---|---|
| 2026-09-09 | v0.12와 SB-D01~12를 기준으로 서비스 API 한국어 초안 작성. P0 예시·오류·권한과 P1 후보 분리. 경로·필드·세부 상태 코드는 팀 검토 전 제안으로 표시 |

| 2026-09-10 | ERD v1.0 기준으로 수정 version 요구 제거, 공개 설정 P1, 부모+History 첨부 조회, 챌린지 서버 확인 기록 제거. 당시 네 항목 부분 반영; 아래 전체 정합화 기록으로 대체 |
| 2026-09-10 | v1.0 반영: 운영 API·감사 제외, 첫 매칭 채점형·성과당 발견·현재 판 재현·통계 주기·ERD 관계 반영. 검색 범위 유지, 전문가 제보는 원본 충돌 보류 |

| 2026-09-10 | 재공개 시각·댓글 부모 확정, 성과 응답 분리, 중복 작성 영속성 제안·그래프 배열 계약·입력/핫 토픽 제안 추가. ERD 변경과 수치 확정은 팀 검토 대상 |

| 2026-09-10 | SB-D13: 세 판단 합계 임계값 방식 팀 동의 반영. J 미정, 생성일 제한 제안 제거, 댓글 조건 병행은 별도 합의 |

| 2026-09-10 | SB-D14 입력·요청 기준 30분 세션·현재 세션 로그아웃·다중 로그인 확정. DB 제약·저장소는 후속 설계 |
| 2026-09-10 | SB-D15 신호별 공개·성과·별 발견 원자성, 공통 회원 잠금·DB 유일 제약, 일괄 부분 성공 확정. 탐사·DB 교차 검토와 구현은 후속 작업 |
| 2026-09-10 | SB-D16 사용자 승인: 공식 스레드 참여자 10명·참여자 수/생성 시각/ID 내림차순·기간 제한 없음·기준 미달 제외/재진입 확정. 일반 글·댓글 조건 보류. SB-D13의 미정 세부 정책 대체 |

| 2026-09-11 | SB-D17 사용자 확정: 일반 글·댓글의 엄격한 중복 방지는 P1에서도 도입하지 않음. P0 버튼 비활성화·POST 자동 재시도 금지·결과 불명확 시 목록 확인 안내. 공개 분석·성과 중복 방지는 P0 유지 |
| 2026-09-11 | SB-D18 사용자 위임에 따라 그래프의 동일 판 조회·판 전환 재조회 1회·실패/스냅샷 대체 계약과 DAT-14 Redis 상태·결과·잠금·무효화 기준 반영. 자원 수치·탐사 API·DB 구현은 팀 검토 대상 |
| 2026-09-11 | SB-D19 사용자 확정: 일반 글·댓글 변경 필드만 PATCH, 같은 필드 마지막 저장, 저장 중 버튼 비활성화·자동 재시도 금지·응답 유실 시 상세 재조회. 삭제 선확정 후 수정·타인 수정 거부 |

| 2026-09-11 | SB-D20 사용자 확정: 참여 가능 회원의 브라우저별 회차 안내, 실제 표시 후 기록, 기기 변경·저장 실패 시 반복 허용. 서버 확인 API 없음, 기기 간 공유 P1 |

| 2026-09-11 | SB-D21 사용자 확정: 일반 글·공식 스레드 TIC 정확 일치·제목 부분 일치/영문 대소문자 무시·AND·공백 처리·최신순·기본 20/최대 100개·빈 목록·삭제/숨김 제외 |

| 2026-09-11 | SB-D22 사용자 확정: 일반 글·댓글 삭제/숨김 비노출, 본인 조회·수정 제한, 본인 삭제·반복 DELETE 204, 숨김 해제로 삭제물 부활 금지. 공개 분석 취소·개인정보 보관 정책과 분리 |
| 2026-09-11 | SB-D23 사용자 확정: 타인 프로필 회원 ID·닉네임·별 목록 공개 상태·성과 요약, 비공개 별 목록 403. 공개 분석·History 첨부는 판단·근거·메모·재현 수치·그래프·버전 공개(SRS COM-18·19 기준), 필드별 선택 없음 |
| 2026-09-11 | SB-D24 리뷰 반영·사용자 확정: 검색을 SRS COM-03 범위로 확장(제목·본문 키워드·작성자·TIC·게시판·태그). SB-D21 대체. `title` 쿼리를 `q`+`searchIn`으로 교체 |
| 2026-09-11 | 리뷰 반영: 적용 순서를 SRS v1.0 → 팀 결정 → 담당자 제안으로 변경. 검색·핫 토픽을 SRS대로 P1(P0 상향 요청)으로 표기하고, 핫 토픽 SB-D16을 DEC-09 안건 5의 대안 제안으로 전환 |
| 2026-09-11 | 리뷰 반영: 7.2 그래프 계약을 ERD 세그먼트 배열·잔차 상태·reproduction/selection/snapshot 구조로 정리하고 탐사 API 명세 참조로 전환. 스냅샷 부재 409를 snapshot:null로, 필드명을 ERD 단위(fluxScatter·durationHours·userPeriodDays)에 맞춤 |
| 2026-09-11 | 리뷰 반영 철회: 일반 글·댓글 요청 키(Idempotency-Key) 제안을 전량 삭제. 중복 방지는 SB-D17(자동 재시도 금지·목록 확인 안내)만 유지하고 요청 키·전달 위치·영속 테이블 논의는 문서에서 제거 |
| 2026-09-11 | SB-D17 명확화: 엄격한 중복 방지를 P1로 미룬다는 표현을 삭제. 서버 차원 중복 방지(유일 제약·트랜잭션 잠금)는 P0·P1 어느 단계에서도 도입하지 않는다 |
| 2026-09-11 | 저장소 구조 문서에 맞춰 `backend/docs/`에서 `apps/backend/docs/`로 이동하고 상대 링크 갱신 |
| 2026-09-11 | 핫 토픽 산식(DEC-09) 팀 확정 반영: SRS 10.1 안건 5의 기본안(답글+반응 가중)을 폐기하고 SB-D16(공식 스레드 유효 참여자 세 판단 합계 10명 이상, 기간 제한 없음)을 채택. "제안·미결" 표기를 모두 "확정"으로 정리(SRS도 함께 갱신) |
| 2026-09-11 | 지도 프론트 통합 문서(하서진) 대조 정합: 3.2절 `me/stars`·`members/{id}/stars` 항목 구조를 탐사 명세 4.4절 참조로 교체(분담 문서 결정 반영), `signalId`를 ERD 기준 `candidateId`로 통일, 2.1·2.4절 비노출 자원 코드를 SB-D22·23 확정 사례로 갱신, 일괄 공개 상한을 9.4절·14장 모두 "20개 제안"으로 통일, 7.2절 예시의 `nPoints`·`gaps`를 배열 길이와 일치시킴 |
| 2026-09-11 | 3.1절 `GET /me`에 MY-01 `achievementSummary` 추가(타인 프로필과의 비대칭 해소). 저장 열 없이 호출 시 집계, 탐사 9.1절 summary와 같은 내부 함수 사용을 명시 |

| 2026-09-11 | 36번 통합 검토: History 필드·그래프 외형·성과 DTO 매핑·챌린지 v1.1 정합화. 메모 공개 유지 및 첫 방문 안내 완료 설정 P0는 사용자 확인. 탐사 D-7/9/11 연결은 리뷰 대상 |

| 2026-09-14 | `S15P21C206-33` 지도 담당 결정 반영안: HOME-09 사용법 다시 보기를 GIF+설명 5단계 읽기로 정의. 기존 onboardingDone=true 전용·false/null 400·반복 true 멱등 규칙 유지. 탐사 API 4.1과 충돌하던 재설정 문구 정합화(교차 리뷰 대상) |

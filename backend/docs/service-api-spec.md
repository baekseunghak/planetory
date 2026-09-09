# Planetory 서비스 백엔드 주요 API 명세

- 작성일: 2026-09-09
- 상태: **팀 협의용 초안 — 구현 완료 또는 최종 합의된 API가 아님**
- 담당: 백승학 / 서비스 백엔드
- 기준: [요구사항 v0.12](../../docs/requirements/planetory-requirements-spec.md), [기능별 분석 및 최신 결정](../../docs/requirements/planetory-service-backend-feature-analysis.md)
- 적용 순서: 최신 사용자 보충 결정 → v0.12 → 충돌하지 않는 이전 결정.

기능별로 “언제 호출하는지 → 무엇을 보내는지 → 무엇을 받는지 → 실패하면 어떻게 처리하는지”를 설명한다. **기능 정책은 기준 문서를 따르며, 아래 URL·필드명·페이지 방식·상태 코드는 협의용 제안이다.** 확정된 인증 오류 401/403 외의 세부 계약은 프론트·탐사·DB 담당자 검토 후 확정한다. 예시 ID·제목·시각·수치는 가상 데이터다.

## 1. 먼저 보는 API 목록

모든 경로는 서비스 Spring Boot 기준이다. 데이터가 EC2 두 대에 나뉘어 있어도 프론트가 각 DB에 직접 접속하지 않는다. 경로의 `{postId}` 등은 실제 ID로 바꿔 호출한다.

| 기능 | 우선순위 | 메서드·경로 | 쉽게 설명한 역할 | 상세 |
|---|---|---|---|---|
| 내 정보 | P0 | `GET /api/v1/me` | 로그인 여부와 내 프로필 확인 | [회원](#member) |
| 닉네임 수정 | P0 | `PATCH /api/v1/me/profile` | 내 닉네임 변경 | [회원](#member) |
| 공개 설정 | P0 | `PATCH /api/v1/me/settings` | 내 별 목록 공개 여부 변경 | [회원](#member) |
| 타인 프로필 | P0 | `GET /api/v1/members/{memberId}` | 다른 회원의 공개 정보 조회 | [회원](#member) |
| 내 별 목록 | P0 | `GET /api/v1/me/stars` | 내가 발견한 별과 진행 상태 확인 | [회원](#member) |
| 타인 별 목록 | P0 | `GET /api/v1/members/{memberId}/stars` | 공개 설정이 허용한 별 목록 조회 | [회원](#member) |
| 로그아웃 | P0 | `POST /api/v1/auth/logout` | 현재 로그인 종료 | [회원](#member) |
| 피드·검색 | P0 | `GET /api/v1/community/feed` | 일반 글·공식 스레드를 TIC·제목으로 검색 | [검색](#feed) |
| 핫 토픽 | P0 | `GET /api/v1/community/hot-topics` | 댓글 수 또는 판단 수 기준을 충족한 글 조회 | [검색](#feed) |
| 일반 글 | P0 | `POST /api/v1/posts`, `GET/PATCH/DELETE /api/v1/posts/{postId}` | 일반 글 작성·조회·수정·삭제 | [게시글](#posts) |
| 댓글 목록·작성 | P0 | `GET/POST /api/v1/comments` | 일반 글 또는 공식 스레드의 토론 조회·작성 | [댓글](#comments) |
| 댓글 수정·삭제 | P0 | `PATCH/DELETE /api/v1/comments/{commentId}` | 본인 댓글 수정·삭제 | [댓글](#comments) |
| 첨부 선택 | P0 | `GET /api/v1/me/histories` | 해당 별의 내 기록을 선택 | [첨부](#attachments) |
| 공개 첨부 조회 | P0 | `GET /api/v1/history-attachments/{attachmentId}` | 게시물에 붙인 제한된 공개 자료 조회 | [첨부](#attachments) |
| 출처 카드 | P0 | `GET /api/v1/source-cards` | 같은 별의 공식 스레드·공개 분석 미리보기 | [첨부](#attachments) |
| 반응 설정 | P0 | `PUT /api/v1/posts/{postId}/my-reaction` | 동의·비동의·취소 중 원하는 상태로 변경 | [반응](#reactions) |
| 반응자 | P0 | `GET /api/v1/posts/{postId}/reactions` | 동의·비동의한 회원의 닉네임 목록 | [반응](#reactions) |
| 공식 스레드 | P0 | `GET /api/v1/signal-threads/{threadId}` | 신호 요약과 공개 판단 통계 조회 | [공개 분석](#analyses) |
| 공개 분석 목록 | P0 | `GET /api/v1/signal-threads/{threadId}/analyses` | 선택 공개한 분석들을 조회 | [공개 분석](#analyses) |
| 공개 분석 상세 | P0 | `GET /api/v1/public-analyses/{analysisId}` | 공개 필드·그래프·출처 조회 | [공개 분석](#analyses) |
| 공개 등록 | P0 | `POST /api/v1/public-analyses` | 내 기록을 공식 공간에 공개 | [공개 분석](#analyses) |
| 취소·재공개 | P0 | `PUT /api/v1/public-analyses/{analysisId}/visibility` | 내 공개 여부 설정 | [공개 분석](#analyses) |
| 일괄 공개 | P0 | `POST /api/v1/public-analyses/batch` | 선택한 기록들을 신호별로 공개 | [일괄 공개](#batch) |
| 운영 숨김·복원 | P0 | `PUT /api/v1/admin/moderations/{targetType}/{targetId}` | 콘텐츠 숨김 상태 변경 | [운영](#moderation) |
| 운영 감사 | P0 | `GET /api/v1/admin/audit-logs` | 누가 무엇을 변경했는지 조회 | [운영](#moderation) |
| 이번 챌린지 | P0 | `GET /api/v1/challenges/current` | 현재 회차와 새 안내 여부 확인 | [챌린지](#challenge) |
| 안내 확인 | P0 | `PUT /api/v1/me/challenge-notices/{roundId}` | 해당 회차 안내를 확인했다고 기록 | [챌린지](#challenge) |
| 회차 관리 등 | P0 | 운영 API 후보는 12장 | 회차·규칙 관리 계약 협의 | [후속 범위](#later) |
| 신고·팔로우·일반 알림·통계·제보 | P1 | 12장 후보 목록 | P0 이후 상세화 | [후속 범위](#later) |

OAuth 로그인 시작/콜백 주소는 인증 담당자와 제공자 등록 설정에 맞춰 별도 확정한다. 프론트가 제공자 ID를 임의 전송하여 로그인시키는 API는 만들지 않는다. 세션 갱신 API도 활동·만료 정책 확정 전에는 추가하지 않는다.

## 2. 공통 약속

### 2.1 로그인과 권한

- 세션 방식을 우선 검토한다. 브라우저가 세션 쿠키를 전달하고 서버는 세션에서 회원을 식별한다. 요청 본문에 `authorId`나 운영자 여부를 받지 않는다.
- 인증 없음·만료는 **401**: 프론트가 재로그인 안내. 인증됐지만 권한 부족은 기본 **403**: 권한 부족 안내.
- 실제 없는 자원은 **404**. 숨김·비공개 자원의 존재를 감출 때도 404를 사용할지는 합의가 필요하다. 합의 전 공개 응답에서 비공개 내용을 반환하지 않는 규칙은 유지한다.
- 쿠키 이름·저장소·만료·활동 갱신은 미정. 인증 구현 시 쿠키 보안 설정·CSRF 방어·로그인 시 세션 ID 교체·로그아웃 무효화를 함께 검토한다.
- 회원 차단 API는 v1에 없다. 탈퇴 API 제공 시점과 데이터 정책은 보류한다.

브라우저 호출 예시(세션 인증 및 CSRF 토큰 전달 방식이 합의됐다는 가정):

```javascript
const response = await fetch('/api/v1/posts', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-TOKEN': csrfToken, // 이름·발급 경로는 인증 담당자와 확정
    'Idempotency-Key': requestKey // 새 작성 시 발급, 같은 요청 재시도에는 재사용
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

- 일반 글·댓글 POST에는 `Idempotency-Key`를 요구하는 안을 제안한다. 범위는 회원+작업+키. 같은 키·같은 본문은 새 레코드 없이 기존 결과, 같은 키·다른 본문은 409 `IDEMPOTENCY_CONFLICT`. 처리 중이면 409 `REQUEST_IN_PROGRESS` 후 같은 키로 재시도한다. 키 보관기간은 미정이다.
- 공개 분석은 작성자+History 유일성, 성과는 회원+고유 신호 유일성으로 중복을 막는다. 요청 키만으로 성과 중복을 방지한다고 가정하지 않는다.
- 수정·삭제에는 서버가 준 `version`을 `If-Match: "3"`처럼 보내는 안을 제안한다. 변경된 버전이면 412 `VERSION_CONFLICT`, 필요한 헤더가 없으면 428 `PRECONDITION_REQUIRED`. 새로 조회 후 사용자가 변경 내용을 확인한다.
- PUT은 토글이 아니라 원하는 최종 상태를 전달한다. 같은 상태를 반복해도 반응 수·감사 이력·확인 기록을 중복 생성하지 않는다. 서로 다른 상태의 동시 요청은 서버 저장 순서가 최종 기준인 안이다.
- 성공했던 요청 재시도라도 현재 인증·자원 접근 권한을 다시 검사한다. 재시도로 취소·숨김된 자료가 공개되거나 신규 성과가 생기면 안 된다.

### 2.4 오류 응답

```json
{
  "code": "TIC_MISMATCH",
  "message": "게시글과 같은 별의 자료만 첨부할 수 있습니다.",
  "fieldErrors": [{"field": "historyIds", "reason": "다른 TIC의 기록이 포함되어 있습니다."}],
  "requestId": "req-example-001"
}
```

프론트 분기는 `code`로 하고 `message`는 안내 문구로 사용한다. 실패 응답에 타인의 비공개 ID·원문·세션값을 담지 않는다.

| HTTP | 코드 예시 | 프론트 처리 |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `TIC_MISMATCH` | 잘못된 입력 안내·수정 |
| 401 | `AUTH_REQUIRED` | 재로그인 안내 |
| 403 | `FORBIDDEN`, `CONTENT_NOT_ACCESSIBLE` | 권한 부족·접근 불가 안내. 비노출 자원은 404 계약 추후 합의 |
| 404 | `RESOURCE_NOT_FOUND` | 없는 대상 안내 |
| 409 | `NICKNAME_UNAVAILABLE`, `THREAD_HIDDEN`, `IDEMPOTENCY_CONFLICT`, `REQUEST_IN_PROGRESS` | 충돌 원인에 따라 새로 조회·입력 변경·동일 요청 재시도 |
| 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | 최신 버전 조회 / 버전 헤더 추가 |
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
  "tutorialCompleted": false
}
```

`role`은 화면 표시용이며 실제 운영 권한은 서버가 재검사한다. 튜토리얼 완료는 탐사 도메인의 판정을 사용한다. 이메일·제공자 원본 ID·토큰은 이 응답에 포함하지 않는 최소안이다.

`PATCH /api/v1/me/profile` 요청:

```json
{"nickname": "새로운별찾기"}
```

성공 200은 `{"memberId":"u-101","nickname":"새로운별찾기"}`. 닉네임은 상시 변경 가능하고 기존 글·댓글·반응자 표시에도 최신 값이 반영된다. 중복은 409, 금칙어·형식 오류는 400 제안. 길이·문자·정규화 기준은 미정이다. 이메일 수정·제공자 연결은 포함하지 않는다.

### 3.2 공개 설정·타인 프로필·별 목록

`PATCH /api/v1/me/settings`에 `{"starListVisibility":"PRIVATE"}`를 보내면 200으로 변경된 설정을 반환한다. 값은 `PUBLIC`/`PRIVATE`, 기본은 PUBLIC. 이 설정이 공개 게시글·반응·공식 판단 통계를 비공개로 바꾸지는 않는다.

`GET /api/v1/members/u-102`의 최소 공개 응답은 `{"memberId":"u-102","nickname":"관측자","starListVisibility":"PRIVATE"}`. 가입일·성과 요약·팔로우 목록 등 추가 공개 필드는 합의 후 확장한다.

`GET /api/v1/me/stars?size=20` 또는 공개가 허용된 `GET /api/v1/members/u-102/stars?size=20`:

```json
{
  "items": [{"ticId":"123456789","discoveredAt":"2026-09-09T03:00:00Z","isComplete":false}],
  "nextCursor": null,
  "hasNext": false
}
```

타인 비공개 목록은 접근 거부하며 별별 진행도 함께 숨긴다. 403/404 매핑은 공통 비노출 정책에서 확정한다. `isComplete`는 탐사 진행 상태이며 공개 여부·성과 유무와 다르다. 최근 활동 정렬·필터·프로필 성과 요약의 상세 계약은 탐사 담당자와 정한다.

### 3.3 로그아웃

`POST /api/v1/auth/logout`, 본문 없음, 성공 204. 현재 세션 종료를 최소안으로 제안한다. 이미 종료된 로그인에서도 204로 처리하는 안이며 CSRF 등 인증 프레임워크 계약과 함께 확정한다. 모든 기기 로그아웃은 미정이다. 유휴 30분·5분 활동 갱신은 아직 확정값이 아니다.

<a id="feed"></a>

## 4. 피드·검색·핫 토픽 — F05·13

### 4.1 피드 검색

예: TIC `123456789`에서 제목에 ‘밝기’가 들어간 일반 글·공식 스레드를 조회한다.

`GET /api/v1/community/feed?ticId=123456789&title=밝기&size=20`

| 쿼리 | 필수 | 의미·제안 |
|---|---|---|
| ticId | 아니오 | 해당 TIC만 조회. 정확 일치 제안 |
| title | 아니오 | 제목 검색. 부분 일치 제안. URL에는 인코딩해 전달 |
| cursor, size | 아니오 | 다음 페이지·페이지 크기 |

두 검색 조건은 AND로 결합하는 안이다. 조건 없으면 전체 피드. 제목 대소문자·공백 처리, 공식 제목 생성 규칙은 미정. 본문·작성자·태그 검색은 현재 최소 범위에서 제외한다.

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

`GET /api/v1/community/hot-topics?size=20`, 성공 200. 목록 구조는 피드와 같고 각 항목에 `hotReasons`를 추가하는 안이다. 값은 `COMMENT_THRESHOLD`, `JUDGMENT_THRESHOLD`이며 둘 다 충족할 수 있다.

- 일반 글: 유효 댓글 수 기준으로 선정한다. agree/disagree를 세 판단에 합치지 않는다.
- 공식 스레드: 유효 토론 댓글 수 **또는** 공개 분석의 세 판단 합계 N으로 선정한다.
- 세 판단은 기존 공개 분석 통계 재사용으로 해석한 안이다. 별도 투표 기능이 아니다. 같은 회원의 반복 제출 수를 더하지 않는다.
- 임계값 C/J, 이상/초과, 누적/기간 집계, 기준 미달 시 탈락, 정렬은 **미정**이다. 이 값들이 확정되기 전 핫 토픽 구현 완료로 처리하지 않는다.
- 삭제·운영 숨김은 즉시 제외. 필터나 캐시가 비공개 자료를 다시 노출하면 안 된다.

<a id="posts"></a>

## 5. 일반 게시글 — F06

### 5.1 작성

작성 화면의 최종 ‘게시’에서 `POST /api/v1/posts`를 호출한다. 화면 진입이나 자동 채움만으로 글을 저장하지 않는다. 공통 Idempotency-Key 제안 적용.

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
| title, body | 예 | 제목·본문. 길이·마크업 허용은 미정. HTML을 임의 신뢰하지 않음 |
| purposeTag | 예(제안) | 대표 목적. 예시 DISCUSSION 외 허용 목록은 별도 확정 |
| ticId | 아니오 | 별 연결. null이면 별 없는 일반 글 |
| historyIds | 아니오 | 같은 TIC의 본인 History. 생략 시 빈 목록 |
| sourceLinks | 아니오 | 같은 TIC의 공개 분석 또는 공식 스레드. type은 PUBLIC_ANALYSIS/SIGNAL_THREAD |

TIC가 없으면 History·출처 카드 목록은 비어야 한다. 일반 본문 URL과 자료 선택 기능은 구분한다. 최초 발견 여부·소유권·상위 공개 상태를 서버에서 검증한다. 일반 글 작성은 공식 분석 공개·성과·판단 통계를 생성하지 않는다.

성공 201 예시:

```json
{"postId":"p-201","version":1,"createdAt":"2026-09-09T03:00:00Z"}
```

### 5.2 조회·수정·삭제

`GET /api/v1/posts/p-201`, 성공 200:

```json
{
  "postId":"p-201","version":1,"title":"이 밝기 감소 구간을 어떻게 보시나요?",
  "body":"반복 간격이 일정한지 의견을 듣고 싶습니다.","purposeTag":"DISCUSSION","ticId":"123456789",
  "author":{"memberId":"u-101","nickname":"별찾는사람"},
  "attachments":[{"attachmentId":"ha-701","type":"HISTORY"}],
  "sourceLinks":[{"type":"PUBLIC_ANALYSIS","id":"pa-601","available":true}],
  "reactionSummary":{"agree":3,"disagree":1,"myReaction":"NONE"},
  "commentCount":4,"createdAt":"2026-09-09T03:00:00Z","updatedAt":"2026-09-09T03:00:00Z"
}
```

`PATCH /api/v1/posts/p-201`은 `If-Match: "1"`과 변경 필드만 전달한다. 성공 200으로 새 version과 변경된 상세를 반환한다. `{"ticId":null,"historyIds":[],"sourceLinks":[]}`는 별과 자료 연결을 함께 해제하는 예다. 별만 변경하고 부적합 첨부를 남기면 400 `TIC_MISMATCH`. 원본 History의 수치·판단을 수정하지 않는다.

`DELETE /api/v1/posts/p-201`, If-Match 필요, 성공 204. 댓글·첨부의 일반 공개 접근도 차단하며 독립 공개 분석·성과를 취소하지 않는다. 삭제 표시·작성자 재조회·복구 여부는 미정이다. 이미 삭제된 ID의 반복 DELETE 응답도 이 정책과 함께 확정한다. 타인 수정/삭제는 403, 버전 충돌은 412 제안.

<a id="comments"></a>

## 6. 댓글 — F08

공식 스레드의 ‘토론’과 일반 글의 댓글만 대상이다. 개별 공개 분석에 댓글을 붙이거나 2단계 답글을 만드는 API는 추가하지 않는다.

`GET /api/v1/comments?parentType=POST&parentId=p-201&size=20`

공식 스레드는 `parentType=SIGNAL_THREAD&parentId=st-301`. 두 부모 필드는 필수다. 성공 200 목록 항목은 `commentId`, `version`, `author`, `body`, `attachments`, `sourceLinks`, `createdAt`, `updatedAt`. 기본 정렬은 최신순 제안.

`POST /api/v1/comments` 요청:

```json
{
  "parentType":"SIGNAL_THREAD","parentId":"st-301",
  "body":"다른 관측 구간에서도 같은 패턴이 보입니다.",
  "historyIds":["h-501"],"sourceLinks":[]
}
```

부모·본문 필수, 자료 배열 생략 시 빈 목록. TIC는 부모에서 결정한다. 같은 TIC의 본인 History와 공개 출처만 허용한다. 성공 201은 `{"commentId":"c-801","version":1,"createdAt":"2026-09-09T03:10:00Z"}`.

`PATCH /api/v1/comments/c-801`은 본문·자료만 수정하며 부모 이동은 제공하지 않는 안이다. If-Match 필요, 성공 200으로 변경된 댓글 반환. `DELETE`는 If-Match와 함께 호출, 성공 204. 작성자 소유권과 부모 상태를 검사한다. 부모 숨김 중 본인 댓글 수정·삭제 허용은 추가 합의한다.

**예외:** 다른 TIC 자료 400, 타인 수정 403, 없는 부모 404, 숨겨진 부모 접근 거부. 댓글 작성과 부모 숨김이 동시에 발생해도 숨겨진 댓글 내용이 공개돼서는 안 된다. 본문 길이·첨부만 있는 댓글 허용·삭제 표시는 미정.

<a id="attachments"></a>

## 7. 내 History 선택·공개 첨부·출처 — F09·24

### 7.1 내 기록 선택

`GET /api/v1/me/histories?ticId=123456789&size=20`

내가 가진 불변 기록을 선택하는 목록이다. TIC 필수 제안. 탐사 History 조회 기능과 **하나의 계약으로 연결하며 같은 원본 API를 양쪽에서 중복 구현하지 않는다.**

```json
{
  "items":[{
    "historyId":"h-501","ticId":"123456789","signalId":"s-401",
    "judgment":"UNSURE","submittedAt":"2026-09-09T02:30:00Z",
    "publication":{"analysisId":null,"isPublic":false,"isModerationHidden":false},
    "achievementGranted":false
  }],
  "nextCursor":null,"hasNext":false
}
```

미매칭 기록의 signalId는 null일 수 있다. 일반 글 첨부는 가능 여부를 별도로 검사하며, 공식 공개 분석은 미확정 고유 신호 매칭 자격이 필요하다. `achievementGranted`는 현재 공개 여부와 다르다. 날짜·결과 필터 및 재도전용 원본 조회는 탐사 계약에서 추가 정의한다.

### 7.2 공개 첨부와 출처 카드

`GET /api/v1/history-attachments/ha-701`은 현재 부모에 붙어 있는 첨부를 통해서만 제한된 자료를 반환한다. 성공 200 최소 구조는 아래와 같다. 공개할 수치·메모·근거·그래프 필드는 탐사와 필드 단위로 합의해야 한다.

```json
{"attachmentId":"ha-701","ticId":"123456789","submittedAt":"2026-09-09T02:30:00Z","judgment":"UNSURE","graphRefs":[]}
```

graphRefs는 접근 제어된 그래프 조회 참조 배열 제안이다. 빈 배열은 예시일 뿐 그래프 누락을 정상 완료로 확정하지 않는다. 이미지 생성 실패와 원본 Bundle 부재는 일시 실패/영구 미제공을 구분해 합의한다. 공개 자료를 영구 공개 파일 URL로 제공해 숨김을 우회하지 않는다.

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

작성자·TIC·신호·판단·수치는 클라이언트가 덮어쓰지 못하며 서버가 원본 History에서 확인한다. 공개 검토에서 메모 등 선택 공개 필드를 조절할 수 있는지와 요청 필드는 아직 합의 대상이다. 현재 최소 요청은 선택한 기록 자체를 보내는 안이며 공개 범위 합의 전 실제 출시하지 않는다.

```json
{
  "analysisId":"pa-601","threadId":"st-301","historyId":"h-501",
  "isPublic":true,"created":true,"firstAchievementGranted":true,
  "judgmentSummary":{"participantCount":1,"likelyPlanet":0,"unlikelyPlanet":0,"unsure":1,"asOf":"2026-09-09T03:00:00Z"}
}
```

새 공개 기록 201, 같은 기록 재요청 200 제안. `firstAchievementGranted`는 이번 처리에서 최초 성과를 부여했는지이며 기존 성과 보유 여부와 다르다. 재요청 시 created/firstAchievementGranted는 false이고 새 성과를 만들지 않는다.

- 미확정 매칭의 첫 유효 공개에서 SYSTEM 공식 스레드를 고유 신호당 하나 확보한다.
- 세 판단 모두 공개·최초 성과 인정 가능. 이미 성과를 받은 duplicate의 새 제출도 공개 가능하나 추가 성과 없음.
- 신호별 공개·공식 공간 생성·최초 성과·등급/별 발견·통계는 함께 일관되게 처리한다. 구현 트랜잭션 경계는 탐사와 합의한다.
- 일반 Post·댓글·반응은 자동 생성하지 않는다. 미공개·공개 실패가 개인 기록이나 탐색 완료를 되돌리지 않는다.
- 이미 취소된 동일 기록을 POST로 재전송하면 취소 상태를 유지해 반환하는 안이다. 의도적 재공개는 아래 visibility API로 구분해 오래된 재시도가 취소를 되돌리지 않게 한다.
- 다른 사람 History는 접근 거부, 미매칭/부적격은 409 `PUBLICATION_NOT_ELIGIBLE` 제안. 상위 운영 숨김은 409 `THREAD_HIDDEN`; 대체 스레드·성과를 만들지 않는다. 최초 공개 전 라벨이 바뀐 옛 기록의 자격은 미정.

### 9.2 스레드·공개 목록·상세

`GET /api/v1/signal-threads/st-301`, 성공 200:

```json
{
  "threadId":"st-301","ticId":"123456789","signalId":"s-401",
  "title":"TIC 123456789 신호 s-401 밝기 분석","author":{"type":"SYSTEM","displayName":"SYSTEM"},
  "judgmentSummary":{
    "participantCount":15,"likelyPlanet":8,"unlikelyPlanet":4,"unsure":3,
    "percentages":{"likelyPlanet":53.3,"unlikelyPlanet":26.7,"unsure":20.0},
    "asOf":"2026-09-09T03:00:00Z"
  }
}
```

판단은 회원×고유 신호당 **최신 유효 공개 제출 한 건**이다. 최신 기준은 Submission 서버 접수 시각·동률 고정 순번이며 공개한 시각이 아니다. 미공개 재제출은 영향을 주지 않는다. N=0은 percentages를 null로 반환하고 ‘아직 공개된 분석이 없습니다’를 표시하는 안이다. 비율은 행성일 확률이 아니다.

`GET /api/v1/signal-threads/st-301/analyses?judgment=UNSURE&size=20`:

- judgment는 생략 또는 LIKELY_PLANET/UNLIKELY_PLANET/UNSURE. 목록은 현재 유효한 공개 기록을 대상으로 하며 과거 공개 분석도 포함한다. 한 회원의 기록이 여럿 보일 수 있지만 통계 기여는 한 건이다.
- 성공 200 공통 목록의 항목: analysisId, author, submittedAt, judgment, contributesToSummary. 마지막 필드는 현재 통계 대표 기록인지 나타내는 제안이다.
- 판단 필터는 목록만 좁힌다. 전체 judgmentSummary의 N을 바꾸지 않는다. 목록 건수와 참여자 N은 다를 수 있다.
- 목록 정렬은 제출 시각 내림차순·고정 제출 순번 제안. 통계와 목록의 같은 시점 제공 여부는 집계 구현과 함께 확정한다.

`GET /api/v1/public-analyses/pa-601`은 analysisId, threadId, ticId, author, submittedAt, judgment와 허용된 period/구간/근거/메모/graphRefs/버전만 반환한다. 수치 단위·필드별 공개 범위는 탐사와 합의해야 한다. 개인 원본 전체를 그대로 응답하는 방식은 금지한다.

기존 채점형 분포는 성과 자격 회원의 최신 제출이라는 별도 모집단이다. 이 공개 분석 API를 확정/FP 전체에 확장하지 않는다. 결과 화면용 채점형 API는 탐사 담당자와 별도 계약한다.

### 9.3 취소·재공개

`PUT /api/v1/public-analyses/pa-601/visibility`:

```json
{"isPublic":false}
```

성공 200은 `{"analysisId":"pa-601","isPublic":false,"isModerationHidden":false,"isEffectivelyPublic":false}`. 재공개는 true. 작성자만 변경 가능하며 같은 상태 반복은 중복 반영하지 않는다.

본인 공개 상태와 운영 숨김은 별도로 유지한다. 운영 숨김 중 true 요청은 409로 거부하는 안이다. false 요청은 본인 관리 경로에서 허용하는 안이며 최종 권한 합의가 필요하다. 숨겨진 콘텐츠를 응답에 다시 담지 않는다. 취소 후 남은 유효 기록 중 최신 판단을 선택하고 없으면 통계에서 회원을 제외한다. 성과·등급·History·탐색 완료는 유지한다.

<a id="batch"></a>

### 9.4 여러 신호 일괄 공개 — F23

TIC 종료 화면에서 신호별 대표 기록(기본 최신 미공개 제출)을 검토한 후 호출한다.

`POST /api/v1/public-analyses/batch`:

```json
{"ticId":"123456789","items":[{"historyId":"h-501"},{"historyId":"h-502"}]}
```

본문 전체 형식 오류·항목 상한 초과는 처리 전 400. 항목 상한은 미정이다. 같은 신호 복수 선택은 검토 화면에서 한 건으로 제한하고 서버에서도 처리 전 거부하는 안이다. 서로 다른 신호는 항목별로 처리한다.

```json
{
  "results":[
    {"historyId":"h-501","status":"PUBLISHED","analysisId":"pa-601","threadId":"st-301","firstAchievementGranted":true},
    {"historyId":"h-502","status":"FAILED","error":{"code":"DEPENDENCY_UNAVAILABLE","message":"분석 자료를 잠시 불러올 수 없습니다."},"retryable":true}
  ]
}
```

요청을 처리한 결과는 일부 실패도 **200 + 항목별 결과**로 반환하는 안이다. 프론트는 HTTP 성공만 보고 ‘모두 성공’으로 표시하지 않는다. status는 PUBLISHED/FAILED/NOT_PUBLISHED 제안이며 이미 취소된 기록의 단순 재전송은 NOT_PUBLISHED와 의도적 재공개 필요 안내로 구분한다.

성공분은 유지하고 실패한 h-502만 재전송한다. 응답이 유실돼 전체 재시도해도 같은 History와 성과를 중복 생성하지 않는다. 항목별 처리 중 상태는 프론트 표시 상태이며 비동기 Job 도입을 뜻하지 않는다. 여러 성과의 등급 상승·별 발견은 순차 개별 인정과 동일한 결과여야 한다.

<a id="moderation"></a>

## 10. 운영 숨김·복원·감사 — F12

신고는 P1이어도 운영 숨김은 P0에서 독립적으로 제공한다. 실제 운영자 권한이 필요하며 SYSTEM 표기는 운영 계정이 아니다.

`PUT /api/v1/admin/moderations/SIGNAL_THREAD/st-301`:

```json
{"hidden":true,"reason":"운영 검토 중인 콘텐츠입니다."}
```

targetType은 POST/COMMENT/PUBLIC_ANALYSIS/SIGNAL_THREAD. hidden·비어 있지 않은 reason 필수. 대상 운영 상태 조회를 위한 `GET`도 같은 경로로 제공하고 version을 반환하는 안이다. 변경 PUT은 If-Match 필요. 최초 상태 조회는 `{"hidden":false,"version":0}`처럼 반환한다. 성공 200:

```json
{"targetType":"SIGNAL_THREAD","targetId":"st-301","hidden":true,"version":1,"updatedAt":"2026-09-09T04:00:00Z"}
```

복원은 hidden=false. 같은 상태 요청은 새 조치 이력을 만들지 않으며 사유만 정정하는 기능은 현재 추가하지 않는다. 상태 변경과 감사 저장은 함께 성공해야 한다.

- 상위 스레드 숨김은 하위 분석·토론·첨부·출처·검색·직접 조회에 적용한다. 새 공개와 대체 스레드 생성도 차단한다.
- 복원은 개별 숨김·작성자 공개 취소를 해제하지 않는다. 원본 History·기존 성과를 삭제/회수하지 않는다.
- 공개 판단 통계는 유효 집합을 다시 선택한다. 외부 라벨 변경도 기존 성과·등급·과거 StatsSnapshot을 자동 재계산하지 않는다.

`GET /api/v1/admin/audit-logs?targetType=SIGNAL_THREAD&targetId=st-301&size=20`: 두 대상 필터는 함께 전달하는 안. 200 공통 목록 항목은 auditId, operatorId, targetType, targetId, beforeHidden, afterHidden, reason, occurredAt. 운영자 식별·사유를 일반 회원 응답에 공개하지 않는다. 감사 보관기간·세부 열람 역할은 미정이다.

<a id="challenge"></a>

## 11. 주간 챌린지·첫 접속 안내 — F17

홈 첫 진입에서 `GET /api/v1/challenges/current`를 호출한다. 정시 푸시나 일반 알림함 없이 현재 회차와 회원별 확인 상태를 함께 받는 안이다.

```json
{
  "round":{
    "roundId":"cr-901","title":"이번 주의 관측 대상","ticId":"123456789",
    "startsAt":"2026-09-07T00:00:00Z","endsAt":"2026-09-14T00:00:00Z"
  },
  "eligible":true,
  "notice":{"shouldShow":true,"acknowledged":false}
}
```

진행 회차가 없으면 200 `{"round":null,"eligible":false,"notice":{"shouldShow":false,"acknowledged":false}}`. 시각은 예시이며 실제 시작 요일·시각·시간대는 미정이다. 시작 포함·종료 제외를 제안한다.

- 튜토리얼 5개 완료 회원만 챌린지 별 발견 자격이 있다. 회차는 미확정·AI 승인 별 하나다.
- 미완료 회원은 eligible=false, ticId=null로 분석 대상 노출을 제한하는 최소안이다. 소개·안내까지 보여줄지는 합의 후 정한다. 서버 자격 검사는 화면 표시와 별개다.
- 시작일에 접속하지 않은 회원도 회차가 진행 중이면 다음 접속에서 안내하는 안. 이미 접속 중이면 다음 홈 진입 때 재조회한다.
- GET은 안내 확인 상태를 변경하지 않는다. 프론트에서 표시를 확인한 뒤 아래 API를 호출하는 안이다. 조회 자체로 별 발견을 새로 처리하지 않으며 발견은 탐사 완료/회차 시작 계약에서 멱등 처리한다.

`PUT /api/v1/me/challenge-notices/cr-901` 요청 `{"acknowledged":true}`, 성공 204. false로 되돌리는 기능은 제공하지 않는 안이다. 회원×회차당 한 번 기록하고 반복 요청도 204. 다른 회원 ID를 받지 않는다. 최초 확인은 유효 진행 회차만 허용하는 안이며 종료/취소 직후 경합은 409 `CHALLENGE_NOT_ACTIVE` 후 새로 조회한다.

여러 탭·화면 표시 후 네트워크 실패에서는 안내가 재노출될 수 있다. 정확히 한 번 화면에 보인다는 보장은 하지 않는다. 챌린지 달성·성공·전용 보상 API는 없으며 일반 탐사 성과는 별도다. 회차 참여 수의 정의·응답은 미정이다.

<a id="later"></a>

## 12. 추가 운영 및 P1 API 후보

아래는 책임과 범위를 확인하기 위한 후보이며 요청·응답이 확정된 API가 아니다. 미정 정책을 임의 구현하지 않는다.

| 범위 | 우선순위 | 경로 후보 | 구현 전에 정할 내용 |
|---|---|---|---|
| 챌린지 회차 등록·수정 | P0 | `POST /api/v1/admin/challenge-rounds`, `PATCH /api/v1/admin/challenge-rounds/{roundId}` | 대상 자격·기간·겹침·진행 중 변경·취소 상태와 버전 |
| 튜토리얼·발견 규칙·공개 상태 운영 | P0 | 경로 미정, F21 작업별 분리 | 탐사 담당의 검증·실행 책임, 설정 버전·적용 시점·감사 |
| 데이터 재처리 | P0 운영 범위 협의 | 경로 미정 | 데이터 담당 실행 계약·중복 실행·권한. Gold 작업을 서비스 DB 수정 API로 대신하지 않음 |
| 신고 | P1 | `POST /api/v1/reports`, `GET/PATCH /api/v1/admin/reports/{reportId}` | 네 대상 종류·사유·중복·처리 상태·신고자 비공개 |
| 회원·별 팔로우 | P1 | `PUT/DELETE /api/v1/me/following/members/{memberId}`, `PUT/DELETE /api/v1/me/following/stars/{ticId}` | 대상 자격·수신 설정·목록 공개·피드 포함 |
| 일반 알림·설정 | P1 | `GET /api/v1/me/notifications`, `PATCH /api/v1/me/notification-settings` | 종류·읽음·채널·보관·중복. F17 첫 접속 안내와 분리 |
| 내·전체·비교 통계 | P1 | `GET /api/v1/me/statistics`, `GET /api/v1/statistics` | 산식·90일 모집단·일별 기준 시각·분모 0·재집계 |
| 전문가 제보 | P1 | `/api/v1/admin/expert-reports` 아래 후보 | 자료 선택→생성→승인→발송, 수신자·개인정보·응답 유실과 중복 발송 |
| 탈퇴 | 보류, 데이터 정책 P1 | API 제공 시점·경로 미정 | 보관·익명화·재가입과 접근 차단. 제공 시 탈퇴/작성 DB 확정 순서 적용 |

회원 차단·다중 제공자 연결·이메일 수정·챌린지 전용 성공/보상은 이번 API에 추가하지 않는다. 개인 History 삭제 API도 현재 범위에 없다.

## 13. 탐사·프론트와 함께 확인할 계약

| 연결 지점 | 서비스가 필요한 정보·보장 | 협의자 |
|---|---|---|
| TIC·게시판 자격 | 별 존재·최초 발견·회원별 분석 진입 자격. 열람과 분석 진입 구분 | 탐사 |
| History | 소유자·TIC·고유 신호·불변 분석값·제출 시각/순번·Bundle·버전·공개 허용 필드 | 탐사·프론트 |
| 최초 공개 성과 | 회원×신호 1회, 등급/별 발견 포함 신호별 원자성·응답 유실 재시도 | 탐사·DB |
| 공개 통계 | 최신 유효 공개 선택, 취소·숨김 시 이전 기록 복귀, 같은 시각 조회 | 탐사·프론트 |
| 챌린지 | 튜토리얼 완료·회차 자격·멱등 별 발견·첫 접속 안내 | 탐사·프론트 |
| 외부 라벨·재개 | 기존 성과·스냅샷 보존, 공개 기록 출처 유지, 재개 안내 P0/P1 경계 | 탐사·데이터 |

서비스와 탐사는 업무 구분이며 별도 서버를 뜻하지 않는다. 같은 Spring Boot·RDB 안에서 처리할 수 있으면 내부 호출·DB 트랜잭션부터 검토한다. 이벤트 이름을 정한다는 이유로 메시지 브로커를 추가하지 않는다. 다른 저장소에 걸친 쓰기가 필요하면 원자성 구현을 별도 합의한다.

## 14. 팀 검토 체크리스트

- [ ] URL·필드·enum·날짜·페이지·오류 형식을 프론트와 합의했다.
- [ ] 제목/본문/닉네임 길이, 첨부 개수, 페이지·일괄 요청 상한을 확정했다.
- [ ] 세션·CSRF 전달 계약, 401/403과 비노출 404 대상을 합의했다.
- [ ] 검색 AND/일치 방식, 핫 토픽 C/J·기간·정렬·탈락 기준을 확정했다.
- [ ] 공개 분석의 메모·근거·그래프·수치 공개 필드를 합의했다.
- [ ] 공개와 성과의 트랜잭션, 중복·취소 후 재시도, 일괄 실패 계약을 합의했다.
- [ ] 숨김·삭제·복원·버전 충돌과 캐시의 기대 결과를 합의했다.
- [ ] 챌린지 시작 시각·미완료 회원 안내·확인 기록 기준을 합의했다.
- [ ] P1 미정 사항을 후속 Task로 이관하고 검토자·날짜를 기록했다.

## 15. 작성 이력

| 날짜 | 변경 |
|---|---|
| 2026-09-09 | v0.12와 SB-D01~12를 기준으로 서비스 API 한국어 초안 작성. P0 예시·오류·권한과 P1 후보 분리. 경로·필드·세부 상태 코드는 팀 검토 전 제안으로 표시 |

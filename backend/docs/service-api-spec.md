# Planetory 서비스 백엔드 주요 API 명세

- 작성일: 2026-09-09
- 갱신일: 2026-09-10 — SRS·ERD v1.0 정합화, 사용자 검색·핫 토픽 및 최소 안내 결정 유지
- 상태: **팀 협의용 초안 — 구현 완료 또는 최종 합의된 API가 아님**
- 담당: 백승학 / 서비스 백엔드
- DB 기준: [ERD v1.0](../../docs/development/database-erd.md). PostgreSQL 및 확정 물리 관계를 따른다.
- 기준: [요구사항 v1.0](../../docs/requirements/planetory-requirements-spec.md), [기능별 분석 및 최신 결정](../../docs/development/planetory-service-backend-feature-analysis.md)
- 적용 순서: 최신 사용자 보충 결정 → v1.0 → 충돌하지 않는 이전 결정.

기능별로 “언제 호출하는지 → 무엇을 보내는지 → 무엇을 받는지 → 실패하면 어떻게 처리하는지”를 설명한다. **기능 정책은 기준 문서를 따르며, 아래 URL·필드명·페이지 방식·상태 코드는 협의용 제안이다.** 확정된 인증 오류 401/403 외의 세부 계약은 프론트·탐사·DB 담당자 검토 후 확정한다. 예시 ID·제목·시각·수치는 가상 데이터다.

## 1. 먼저 보는 API 목록

모든 경로는 서비스 Spring Boot 기준이다. 데이터가 EC2 두 대에 나뉘어 있어도 프론트가 각 DB에 직접 접속하지 않는다. 경로의 `{postId}` 등은 실제 ID로 바꿔 호출한다.

| 기능 | 우선순위 | 메서드·경로 | 쉽게 설명한 역할 | 상세 |
|---|---|---|---|---|
| 내 정보 | P0 | `GET /api/v1/me` | 로그인 여부와 내 프로필 확인 | [회원](#member) |
| 닉네임 수정 | P0 | `PATCH /api/v1/me/profile` | 내 닉네임 변경 | [회원](#member) |
| 공개 설정 | P1 | `PATCH /api/v1/me/settings` | 내 별 목록 공개 여부 변경 | [회원](#member) |
| 타인 프로필 | P0 | `GET /api/v1/members/{memberId}` | 다른 회원의 공개 정보 조회 | [회원](#member) |
| 내 별 목록 | P0 | `GET /api/v1/me/stars` | 내가 발견한 별과 진행 상태 확인 | [회원](#member) |
| 타인 별 목록 | P0 | `GET /api/v1/members/{memberId}/stars` | 공개 설정이 허용한 별 목록 조회 | [회원](#member) |
| 로그아웃 | P0 | `POST /api/v1/auth/logout` | 현재 로그인 종료 | [회원](#member) |
| 피드·검색 | P0 | `GET /api/v1/community/feed` | 일반 글·공식 스레드를 TIC·제목으로 검색 | [검색](#feed) |
| 핫 토픽 | P0 | `GET /api/v1/community/hot-topics` | 유효 참여자 10명 이상인 공식 스레드, 참여자 수순 조회 | [검색](#feed) |
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
- 실제 없는 자원은 **404**. 숨김·비공개 자원의 존재를 감출 때도 404를 사용할지는 합의가 필요하다. 합의 전 공개 응답에서 비공개 내용을 반환하지 않는 규칙은 유지한다.
- 마지막 유효한 인증 API 요청의 서버 접수 시각부터 30분간 유지하고 다음 유효 인증 요청마다 연장한다. 자동 폴링도 포함한다. 별도 5분 활동 확인·갱신 API는 사용하지 않는다. 만료된 세션은 401이며 갱신으로 되살리지 않는다. 쿠키 이름·저장소·재시작 후 유지 정책은 미정. 인증 구현 시 쿠키 보안 설정·CSRF 방어·로그인 시 세션 ID 교체·로그아웃 무효화를 함께 검토한다.
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
- ERD의 posts/comments에는 수정용 version 열이 없으므로 version 필드·If-Match·412/428 계약을 제거한다. 수정은 전달한 필드만 변경하고 같은 필드의 동시 수정은 마지막으로 저장된 값이 남는 최소안이다. 수정·삭제 시 소유권·현재 상태를 트랜잭션 안에서 확인하며, 삭제 후 수정으로 콘텐츠가 되살아나면 안 된다. updatedAt은 표시용이며 충돌 방지 토큰으로 사용하지 않는다. 오래된 화면의 덮어쓰기 방지가 필요해지면 별도 계약으로 합의한다.
- PUT은 토글이 아니라 원하는 최종 상태를 전달한다. 같은 상태를 반복해도 반응 수를 중복 생성하지 않는다. 서로 다른 상태의 동시 요청은 서버 저장 순서가 최종 기준인 안이다.
- 성공했던 요청 재시도라도 현재 인증·자원 접근 권한을 다시 검사한다. 재시도로 취소·숨김된 자료가 공개되거나 신규 성과가 생기면 안 된다.

### 2.4 오류 응답

**중복 작성 저장 계약 — DB 담당자 검토가 필요한 제안:** 현재 ERD에는 일반 글·댓글 요청 키를 영속 저장하는 구조가 없다. 따라서 위 Idempotency-Key 계약은 아직 구현 확정이 아니다. Redis 캐시만으로 DB 커밋 후 응답 유실·Redis 재시작까지 안전한 재시도를 보장한다고 가정하지 않는다.

- 권장안은 PostgreSQL에 회원·작업·키의 유일 조합, 검증된 요청 본문의 해시, 결과 자원 ID·생성 시각을 저장하고 콘텐츠 작성과 같은 트랜잭션에서 확정하는 것이다. 테이블 또는 기존 테이블 열로 둘지는 ERD 변경 검토 대상이며 이번 문서 수정으로 확정하지 않는다.
- 동시 요청은 유일 제약으로 직렬화한다. 트랜잭션 롤백 시 키와 글을 함께 되돌리고, 커밋 후 응답만 유실되면 저장된 자원으로 복구한다. 실행 중 대기가 제한을 넘으면 REQUEST_IN_PROGRESS로 안내한다.
- 키 형식은 UUID, 보관기간은 24시간을 제안한다. 보관기간이 지난 키·기록 유실 상황의 재전송은 중복 방지 보장 밖이다. 프론트는 결과가 불명확하면 무조건 새 키로 재전송하지 말고 작성 목록 확인을 안내한다.
- DB 합의 전에는 자동 재시도 가능한 작성 API라고 표시하지 않는다. 버튼 연속 클릭 방지는 프론트에서 하되 서버 중복 방지를 대체하지 않는다. 공개 분석은 기존 history_id와 성과 유일성으로 별도 처리한다.

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

성공 200은 `{"memberId":"u-101","nickname":"새로운별찾기"}`. 닉네임은 상시 변경 가능하고 기존 글·댓글·반응자 표시에도 최신 값이 반영된다. 중복은 409, 금칙어·형식 오류는 400 제안. SB-D14의 확정 입력 기준을 적용한다. 닉네임 변경 시 세션 재발급 없이 이후 조회에 최신 이름을 반영한다. 이메일 수정·제공자 연결은 포함하지 않는다.

### 3.2 공개 설정(P1)·타인 프로필·별 목록(P0)

**ERD 기준:** 공개 설정 변경은 user_settings의 P1 범위를 따른다. P0에서는 기본 공개를 사용하고 설정 변경 API·화면은 제공하지 않는다. 설정 행이 없을 때 PUBLIC으로 응답하되, 기존 행이 있으면 star_list_public 값을 존중한다. P1의 PUBLIC/PRIVATE는 DB의 true/false에 대응한다.

P1에서 `PATCH /api/v1/me/settings`에 `{"starListVisibility":"PRIVATE"}`를 보내면 200으로 변경된 설정을 반환한다. 값은 `PUBLIC`/`PRIVATE`, 기본은 PUBLIC. 이 설정이 공개 게시글·반응·공식 판단 통계를 비공개로 바꾸지는 않는다.

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

`POST /api/v1/auth/logout`, 본문 없음, 성공 204. 현재 세션만 종료하고 다른 기기는 유지한다. 다중 기기 로그인 허용, 전체 기기 로그아웃은 초기 제외다. 이미 종료된 세션의 반복 요청도 204로 처리하는 안이며 CSRF 계약은 인증 담당자와 확정한다. 세션 저장소는 미정이다.

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

**확정 정책(SB-D16, 사용자 승인):** SB-D13의 세 판단 합계 기준을 구체화하여 공식 스레드의 현재 유효 참여자 `participantCount >= 10`이면 핫 토픽으로 선정한다. 어느 판단이 다수인지는 무관하다. 세부 정책의 사용자 승인과 팀 교차 검토 완료는 구분한다.

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

`DELETE /api/v1/posts/p-201`, 별도 버전 헤더 없이 호출, 성공 204. 댓글·첨부의 일반 공개 접근도 차단하며 독립 공개 분석·성과를 취소하지 않는다. 삭제 표시·작성자 재조회·복구 여부는 미정이다. 이미 삭제된 ID의 반복 DELETE 응답도 이 정책과 함께 확정한다. 타인 수정/삭제는 403 제안. 동시 수정은 공통 저장 순서 규칙을 따른다.

<a id="comments"></a>

## 6. 댓글 — F08

공식 스레드의 ‘토론’과 일반 글의 댓글만 대상이다. 개별 공개 분석에 댓글을 붙이거나 2단계 답글을 만드는 API는 추가하지 않는다.

`GET /api/v1/comments?parentType=POST&parentId=p-201&size=20`

공식 스레드는 `parentType=SIGNAL_THREAD&parentId=st-301`. 두 부모 필드는 필수다. 성공 200 목록 항목은 `commentId`, `author`, `body`, `attachments`, `sourceLinks`, `createdAt`, `updatedAt`. 기본 정렬은 최신순 제안.

`POST /api/v1/comments` 요청:

```json
{
  "parentType":"SIGNAL_THREAD","parentId":"st-301",
  "body":"다른 관측 구간에서도 같은 패턴이 보입니다.",
  "historyIds":["h-501"],"sourceLinks":[]
}
```

부모·본문 필수, 자료 배열 생략 시 빈 목록. TIC는 부모에서 결정한다. 같은 TIC의 본인 History와 공개 출처만 허용한다. 성공 201은 `{"commentId":"c-801","createdAt":"2026-09-09T03:10:00Z"}`.

`PATCH /api/v1/comments/c-801`은 본문·자료만 수정하며 부모 이동은 제공하지 않는 안이다. 별도 버전 헤더 없이 호출하며 성공 200으로 변경된 댓글과 updatedAt을 반환한다. `DELETE` 성공은 204. 작성자 소유권과 부모 상태를 검사한다. 부모 숨김 중 본인 댓글 수정·삭제 허용은 추가 합의한다.

**예외:** 다른 TIC 자료 400, 타인 수정 403, 없는 부모 404, 숨겨진 부모 접근 거부. 댓글 작성과 부모 숨김이 동시에 발생해도 숨겨진 댓글 내용이 공개돼서는 안 된다. 댓글 1~2,000자·공백만 입력 및 첨부만 작성 금지. 삭제 표시는 미정.

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

**그래프 조회 계약 제안:** 아래 첨부 조회와 `GET /api/v1/public-analyses/{analysisId}`에 `graphMode=CURRENT|SUBMITTED`를 붙인다. 생략은 CURRENT. 별도 무권한 파일 URL 대신 같은 공개 권한 검사를 거쳐 배열을 받는다. 브라우저가 토글할 때 같은 경로를 다른 graphMode로 다시 호출한다.

| 모드 | 응답 필드 | 원천·의미 |
|---|---|---|
| CURRENT | timeBtjd[], flux[], fluxErrorScalar, periodDays, epochBtjd, durationDays, foldReferenceTimeBtjd | 현재 Bundle 곡선 또는 잔차 배열. 시각·주기·기간은 일 단위, flux는 상대 밝기. flux 오차의 정규화·잔차 처리 방식은 탐사와 합의 |
| SUBMITTED | bins, phaseStart, phaseEnd, foldedFlux[], foldedError[] | analysis_snapshots. 운영 bins=150, 위상 범위 -0.5~0.5. i번째 위상은 -0.5+(i+0.5)/bins |

CURRENT의 timeBtjd/flux는 같은 길이이며 시간순이다. SUBMITTED의 두 배열 길이는 bins와 같다. 결측 구간은 null로 표현하는 안이고 JSON NaN/Infinity는 보내지 않는다. 배열 해상도·정규화는 원본 계산 규칙을 보존하며 서비스 API에서 임의 재비닝하지 않는다.

응답 예시(형식 설명을 위해 3구간으로 축약한 가상 데이터이며 실제 150구간 응답과 구분):

```json
{
  "graph": {
    "mode": "SUBMITTED",
    "bins": 3,
    "phaseStart": -0.5,
    "phaseEnd": 0.5,
    "foldedFlux": [1.0, 0.98, 1.0],
    "foldedError": [0.001, 0.002, 0.001]
  }
}
```

권한이 유효해도 스냅샷이 없는 미매칭 기록의 SUBMITTED 요청은 409 `SNAPSHOT_UNAVAILABLE` 제안이며 CURRENT 전환을 안내한다. 일시 배열 조회 장애는 503이다. 은퇴 후보로 잔차 재현이 불가능하면 CURRENT 원본 곡선과 `residualReproducible:false`, `fallbackReason:RETIRED_CANDIDATE`를 반환하는 안이다. 새 판 전환으로 여러 원천의 Bundle이 섞이지 않게 하나의 판으로 조회하고 응답에 currentBundleId를 포함한다. 토글 조회 사이 판이 달라지면 프론트가 갱신 사실을 표시한다.

글은 `GET /api/v1/posts/p-201/history-attachments/h-501`, 댓글은 `GET /api/v1/comments/c-801/history-attachments/h-501`로 조회한다. 각각 post_history_attachments의 (post_id, history_id), comment_history_attachments의 (comment_id, history_id) 유일 쌍에 대응한다. 단일 attachmentId는 사용하지 않는다. 부모와 해당 History의 첨부 관계가 실제로 있어야 하며, 관계가 없으면 404다. 부모·상위 스레드 공개 상태, 소유자·TIC 적합성을 검사한 뒤 제한된 자료를 반환한다. History ID를 아는 것만으로 조회 권한이 생기지 않는다. 성공 200 최소 구조는 아래와 같다. 공개할 수치·메모·근거·그래프 필드는 탐사와 필드 단위로 합의해야 한다.

```json
{"parentType":"POST","parentId":"p-201","historyId":"h-501","ticId":"123456789","submittedAt":"2026-09-09T02:30:00Z","judgment":"UNSURE","graph":{"mode":"CURRENT","submittedBundleId":"b-1","currentBundleId":"b-2","isPreviousSubmission":true,"residualReproducible":true,"snapshotAvailable":true}}
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

작성자·TIC·신호·판단·수치는 클라이언트가 덮어쓰지 못하며 서버가 원본 History에서 확인한다. 공개 검토에서 메모 등 선택 공개 필드를 조절할 수 있는지와 요청 필드는 아직 합의 대상이다. 현재 최소 요청은 선택한 기록 자체를 보내는 안이며 공개 범위 합의 전 실제 출시하지 않는다.

```json
{
  "analysisId":"pa-601","threadId":"st-301","historyId":"h-501",
  "isPublic":true,"created":true,"achievementGranted":true,"newlyGranted":true,
  "judgmentSummary":{"participantCount":1,"likelyPlanet":0,"unlikelyPlanet":0,"unsure":1,"asOf":"2026-09-09T03:00:00Z"}
}
```

새 공개 기록 201, 같은 기록 재요청 200 제안. achievementGranted는 조회 시점에 해당 회원×신호의 성과가 존재하는지, newlyGranted는 이번 실행이 신규 성과를 생성했는지다. 최초 성공은 둘 다 true, 응답 유실 후 재시도는 achievementGranted=true·newlyGranted=false다. created는 이번에 공개 기록을 만들었는지다. 화면의 성과 보유 표시는 achievementGranted를 사용한다. 실패 항목에서 성과 조회도 실패했으면 null(확인 불가)로 처리하고 false로 단정하지 않는다.

- posts.kind=system_thread, user_id=NULL로 공식 공간을 만든다. threadId는 posts.id, signalId는 candidates.id다. comments.post_id도 일반/공식 posts를 가리킨다. published_analyses.history_id UNIQUE이며 post_id로 공식 스레드를 참조한다.
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

**팀 교차 검토·구현 확인:** 관련 쓰기가 같은 PostgreSQL 연결·트랜잭션에 참여하는지, 확정/FP 경로도 공통 잠금·지급 함수를 쓰는지 확인한다. 잠금 순서를 통일하고 유일 충돌은 충돌 무시 후 기존 행 조회 등 트랜잭션을 망가뜨리지 않는 방식으로 처리한다. 잠금 시간 초과·교착 시 신호 단위로 롤백하며 실패 항목으로 안내한다. 미발견 별이 설정 개수보다 적거나 없는 경우의 지급 정책은 별도 협의한다. 이번 결정은 팀 검토나 구현 완료를 의미하지 않는다.

**필수 검증:** 동일 History 동시 공개·응답 유실 재시도 / 다른 회원의 동일 신호 최초 공개 / 같은 회원의 다른 신호 동시 성과(확정/FP와 공개 혼합 포함) / 성과 저장 뒤 별 저장 실패 시 전체 롤백 / 일괄 일부 실패 시 성공분 유지. 성과 수가 실제 성과 행 수와 같고 추가 별 지급이 중복되지 않는지 확인한다.

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

판단은 회원×고유 신호당 **최신 유효 공개 제출 한 건**이다. 최신 기준은 Submission 서버 접수 시각·동률 Submission id이며 공개한 시각이 아니다. 미공개 재제출은 영향을 주지 않는다. N=0은 percentages를 null로 반환하고 ‘아직 공개된 분석이 없습니다’를 표시하는 안이다. 비율은 행성일 확률이 아니다.

`GET /api/v1/signal-threads/st-301/analyses?judgment=UNSURE&size=20`:

- judgment는 생략 또는 LIKELY_PLANET/UNLIKELY_PLANET/UNSURE. 목록은 현재 유효한 공개 기록을 대상으로 하며 과거 공개 분석도 포함한다. 한 회원의 기록이 여럿 보일 수 있지만 통계 기여는 한 건이다.
- 성공 200 공통 목록의 항목: analysisId, author, submittedAt, judgment, contributesToSummary. 마지막 필드는 현재 통계 대표 기록인지 나타내는 제안이다.
- 판단 필터는 목록만 좁힌다. 전체 judgmentSummary의 N을 바꾸지 않는다. 목록 건수와 참여자 N은 다를 수 있다.
- 목록 정렬은 제출 시각 내림차순·Submission id 제안. 신호 통계는 실시간 쿼리로 같은 요청 안에서 한 번 계산해 공유한다. 별도 요청 사이에는 변화할 수 있다.

`GET /api/v1/public-analyses/pa-601`은 analysisId, threadId, ticId, author, submittedAt, judgment와 허용된 period/구간/근거/메모/graph/데이터·계산 버전만 반환한다. 수치 단위·필드별 공개 범위는 탐사와 합의해야 한다. 개인 원본 전체를 그대로 응답하는 방식은 금지한다.

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

본문 전체 형식 오류·항목 상한 초과는 처리 전 400. 항목 상한은 미정이다. 같은 신호 복수 선택은 검토 화면에서 한 건으로 제한하고 서버에서도 처리 전 거부하는 안이다. 서로 다른 신호는 항목별로 처리한다.

```json
{
  "results":[
    {"historyId":"h-501","status":"PUBLISHED","analysisId":"pa-601","threadId":"st-301","achievementGranted":true,"newlyGranted":true},
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
    "status": "active"
  },
  "eligible": true
}
```

roundNo/startsOn/endsOn/status는 ERD의 round_no/starts_on/ends_on/status에 대응한다. 날짜는 예시다. 시작 요일·기준 시간대·종료일 포함 여부는 합의 후 경계 계산에 적용한다. 진행 회차가 없으면 200 `{"round":null,"eligible":false}`. 서버는 shouldShow·acknowledged를 반환하지 않는다.

- 튜토리얼 5개 완료 회원만 별 발견 자격이 있다. 회차는 미확정·AI 승인 별 하나다. 미완료 회원에게는 eligible=false, ticId=null로 대상 노출을 제한하는 최소안을 유지하며 소개 표시 여부는 별도 합의한다.
- ‘이번 주 챌린지가 새로 생겼습니다’는 프론트가 현재 roundId와 해당 회원에 대해 브라우저에 저장한 마지막 안내 회차를 비교해 표시하는 최소안이다. 저장 키는 회원별로 구분한다. 확인 여부를 서버로 전송하는 API는 제공하지 않는다.
- 이 방식은 기기·브라우저 간 확인 상태를 공유하지 않는다. 브라우저 저장소 삭제·다른 기기 접속 시 같은 회차 안내가 다시 나올 수 있다. 엄격한 회원별 1회 안내를 보장하지 않는다.
- 시작일 미접속 회원은 진행 중 다음 홈 진입에서 안내할 수 있다. 종료·취소되어 진행 대상이 아닌 회차는 새 회차로 안내하지 않는다. GET은 별 발견 상태를 변경하지 않고 탐사·회차 처리 계약에서 별 발견을 멱등 반영한다.
- 기기 간 읽음 동기화가 필요하면 P1 notifications의 type=challenge, payload의 회차 참조, read_at을 활용하는 방향으로 상세화한다. 별도 회원×회차 확인 테이블을 추가하지 않는다. 알림 중복 생성 방지는 P1 계약에서 정한다.

챌린지 달성·성공·전용 보상 API는 없으며 일반 탐사 성과는 별도다. 회차 참여 수 정의는 미정이다.

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

### 확정한 입력 조건과 별도 협의할 검색 기준

**사용자 확정:** SB-D14의 입력·로그인 정책과 SB-D16의 핫 토픽 정책을 적용한다. 검색 일치 방식·일괄 공개 상한은 별도 협의 대상이다. 사용자 승인과 팀 교차 검토 완료는 구분한다.

| 항목 | 기준·상태 | 남은 작업 |
|---|---|---|
| 제목 / 본문 / 댓글 | 확정: 각각 1~100 / 1~10,000 / 1~2,000 Unicode 코드 포인트. 공백만 입력 거부 | 프론트·서버 같은 계산 검증 |
| 닉네임 | 확정: NFC·앞뒤 공백 제거 후 2~20자. 한글 완성형·영문·숫자·밑줄만. 내부 공백 불허, 영문 대소문자 무시 중복 | DB 중복 제약 반영·금칙어 관리 담당 |
| 자료 수 | 확정: 글·댓글 각각 History 최대 3개, 출처 카드 최대 3개. 동일 종류·ID 중복 거부 | 본문 필수, 첨부만 작성 불허 |
| 일괄 공개 | 요청당 20개, 같은 신호 한 건 | 탐사 처리 시간·트랜잭션 제한 확인 |
| 검색 | TIC 정확 일치, 제목 부분 일치, 두 조건 AND | 검색어를 SQL 패턴으로 해석하지 않고 바인딩·와일드카드 이스케이프. 대소문자 무시 제안 |
| 핫 토픽 임계값 | SB-D16 확정: 공식 스레드 N >= 10, 일반 글·댓글 조건 보류 | 팀 교차 검토·구현 |
| 핫 토픽 기간·정렬 | SB-D16 확정: 기간 제한 없음, 참여자 수→스레드 생성 시각→ID 내림차순 | 조회·동률 검증 |
| 핫 토픽 탈락 | SB-D16 확정: N < 10 제외, N >= 10 재진입, 숨김은 무조건 비노출 | 공개 취소·숨김·복원 후 유효 집합 검증 |

**입력 처리 세부(SB-D14):** 제목은 앞뒤 공백 제거·줄바꿈 불허. 본문·댓글은 줄바꿈 허용·공백만 입력 불허. HTML·Markdown은 서식으로 실행/해석하지 않고 일반 텍스트로 렌더링한다. 제목·본문·댓글 이모지는 허용하되 코드 포인트 수로 세어 화면상 한 글자와 다를 수 있다.

닉네임은 한글 완성형·영문 A-Z/a-z·숫자 0-9·밑줄만 허용한다. 예약어 최소 목록은 SYSTEM/ADMIN/관리자/운영자이며 정규화·영문 소문자 비교 후 정확 일치 시 거부한다. 추가 금칙어 목록과 관리자는 별도 합의한다. 변경 횟수 제한은 없다. 자동 초기 닉네임에도 같은 검증을 적용한다.

**DB 반영 필요:** nickname UNIQUE만으로 대소문자 무시 중복을 보장한다고 가정하지 않는다. 정규화된 닉네임을 저장하고 lower(nickname) 유일 인덱스로 보장하는 안을 DB 담당자와 검토한다. 기존 충돌 데이터 확인 후 마이그레이션해야 한다. 정책은 확정이며 물리 반영은 아직 수행하지 않았다.

**세션 기준(SB-D14):** 마지막 인증 요청 10:00이면 만료 10:30, 10:20에 요청하면 만료 10:50. 만료 시각 이후 요청은 401이다. 유효 인증 후 입력 오류·권한 부족도 요청 활동으로 보고 정적 파일·미인증 요청은 연장 근거로 쓰지 않는다. 회원 상태·소유권은 매 요청 검사한다. 시간 만료가 이미 인증된 처리 중 요청을 중간 취소한다는 의미는 아니다. 저장소·쿠키·CSRF 구현은 후속 설계다.

수정 충돌은 마지막 저장값이 남는 현재 최소안을 유지한다. 자동 재시도로 오래된 수정 본문을 덮어쓰지 않으며, 여러 탭 사이 변경 감지·복구가 필요하면 별도 기능으로 합의한다.

- [ ] URL·필드·enum·날짜·페이지·오류 형식을 프론트와 합의했다.
- [x] SB-D14 입력 제한·로그인 정책을 사용자와 확정했다.
- [ ] 입력 정책의 DB·프론트 반영, 페이지·일괄 상한을 검토했다.
- [ ] 세션·CSRF 전달 계약, 401/403과 비노출 404 대상을 합의했다.
- [x] SB-D16 핫 토픽 대상·10명 기준·정렬·기간·제외·재진입 정책을 사용자와 확정했다.
- [ ] 검색 AND/일치 방식을 확정하고 핫 토픽 정책을 팀과 교차 검토했다.
- [ ] 공개 분석의 메모·근거·그래프·수치 공개 필드를 합의했다.
- [x] SB-D15 공개·성과·별 발견의 신호별 트랜잭션과 공통 회원 잠금 방향을 사용자와 확정했다.
- [ ] 탐사·DB 담당자와 동일 트랜잭션 참여, 전체 성과/별 발견 경로의 잠금 규칙, 미발견 별 부족 정책을 검토했다.
- [ ] 숨김·삭제·복원·동시 수정 저장 순서와 캐시의 기대 결과를 합의했다.
- [ ] 챌린지 기간 경계·미완료 회원 안내·브라우저별 안내 기준을 합의했다.
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

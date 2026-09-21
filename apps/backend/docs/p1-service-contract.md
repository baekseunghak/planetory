# P1 서비스 프론트 기준 계약

상태: **2026-09-21 서진 요청으로 작성한 프론트 구현 기준·백엔드 인계안**. 백엔드 담당자는 이 문서와 연결된 프론트 파서·HTTP fixture를 읽고 구현한다. MR 교차 리뷰·실제 백엔드 구현·배포 인수 완료와 구분한다. 기존 개인 분석 API나 데이터 보관 정책을 이 문서가 임의 변경하지 않는다.

상위: [서비스 API](service-api-spec.md), [SRS](../../../docs/requirements/planetory-requirements-spec.md). 작업: `S15P21C206-219`, 제공자 `172/173`, 통합 인수 `244 P1-219`.

## 1. 공통

- `/api` 기준 상대 경로다. 인증 쿠키 필요, 모든 쓰기는 기존 CSRF 헤더를 쓴다. `Cache-Control: no-store`다. 미인증 401, 서버 미구현/장애 503을 빈 성공 응답으로 바꾸지 않는다.
- 회원/TIC/글 ID는 문자열이다. `size` 기본20·최대100, `cursor`는 서버가 생성한 불투명 문자열이다. 목록은 `{items,nextCursor,hasNext}`다. 마지막 페이지는 `nextCursor:null,hasNext:false`다.
- 쓰기를 자동 재전송하지 않는다. 응답 유실·5xx·잘못된 성공 응답은 결과 불명확으로 안내하고 GET 재조회 후 다음 변경을 허용한다.
- 제품 활성화: `VITE_P1_ENABLED=true`. 기본 비활성은 아직 구현되지 않은 P1 API를 기존 P0 배포가 호출하지 않도록 한다. 활성화는 백엔드 권한 검사를 대체하지 않는다. HTTP fixture는 개발 전용이며 운영 번들에 넣지 않는다.

## 2. 팔로우 · 219

사용자 동선은 커뮤니티 `/community/following`의 소식 피드와 마이페이지 `/me/following`의 관계 관리로 나눈다. 별 팔로우의 화면 명칭은 **관심 별**이다. 구독은 별 해금/성과 지급과 무관하다.

| 메서드·경로 | 응답·의미 |
|---|---|
| GET/PUT/DELETE `/api/v1/me/following/members/{memberId}` | 조회/팔로우/해제. 200 `{kind:"MEMBER",id:"u-301",following:true}`. DELETE 성공은 false다. |
| GET/PUT/DELETE `/api/v1/me/following/stars/{ticId}` | 같은 계약의 `kind:"STAR"`. 공개 게시판을 볼 수 있는 별이면 개인 미해금이어도 구독 가능하다. |
| GET `/api/v1/members/{memberId}/follow-summary` | 200 `{memberId:"u-301",followers:2,followingMembers:3,followingStars:4}`. 회원 팔로잉과 별 구독을 합산하지 않는다. 타인 관계 목록 자체는 제공하지 않는다. |
| GET `/api/v1/me/following/members?size=20&cursor=...` | 내가 팔로우한 회원 목록 |
| GET `/api/v1/me/following/stars?size=20&cursor=...` | 내가 구독한 별 목록 |
| GET `/api/v1/me/followers?size=20&cursor=...` | 나를 팔로우한 회원 목록 |
| GET `/api/v1/community/following-feed?size=20&cursor=...` | 공개 가능한 팔로우 피드. 기존 서비스4.1 FeedItem + `matchedBy:["MEMBER","STAR"]` |

목록 항목: `{kind:"MEMBER",id:"u-301",label:"탐사자"}` 또는 `{kind:"STAR",id:"259377017",label:"TOI-270"}`. 이름이 없으면 서버가 `TIC {ticId}`를 제공한다. 화면은 별 이름을 임의 매칭하지 않는다.

### 2.1 생산자 구현 기준

- 자기 팔로우는 400 `FOLLOW_SELF`, 탈퇴/존재하지 않는 회원 및 비공개·미공개 별은 404 `FOLLOW_TARGET_UNAVAILABLE`이다. 화면에서 버튼을 숨기는 것만으로 권한 처리를 끝내지 않는다.
- `(actor,target kind,target id)` 유일 관계로 PUT/DELETE 반복이 같은 결과를 반환한다. 삭제 후 GET은 following=false다. 관계·수치·목록은 서버 저장 결과에서 읽는다. 읽기에 누락된 수치를 0으로 추측하지 않는다.
- 관계 목록은 등록시각 내림차순·동률 대상ID 내림차순이다. 피드는 **글 생성시각 내림차순·동률 type/ID의 안정 순서**다. 회원 팔로우는 해당 회원의 일반 원글, 별 구독은 해당 별의 일반 글·공식 스레드다. 팔로우 이전 글도 포함한다. 댓글 작성만으로 피드 항목을 추가하지 않는다.
- 한 글이 회원·별 양쪽에 해당해도 `{type,id}`당 한 번만 반환하고 matchedBy에 두 근거를 표시한다. 페이지를 나눈 뒤 중복 제거하지 않는다. 숨김·삭제·공개 취소는 매 읽기와 반환 전에 판정하며 이전 cursor로 우회하지 못한다.
- 목록·피드의 커서는 회원·종류·정렬·size에 묶는다. 조건이 다른 cursor는400이다. 개인정보·개인 History·비공개 분석을 실어 보내지 않는다.
- 본인 설정 비공개는 별 목록/은하에 대한 것이며 공개 글과 팔로우 요약 수를 숨기지 않는다. 타인 팔로워·팔로잉 **명단 공개 API는 이번 범위에 없다**.

### 2.2 백엔드 AI가 확인할 파일과 인수

- 소비 파서: [follow/contracts.ts](../../frontend/src/features/follow/contracts.ts)
- 실제 HTTP 호출·응답 유실 복구: [Follow.tsx](../../frontend/src/features/follow/Follow.tsx)
- 합성 제공자: [follow-fixture-plugin.ts](../../frontend/dev/follow-fixture-plugin.ts). 권한/페이지/DB 경합 검증을 대체하지 않는다.
- 생산자 검증: 자기/탈퇴/미해금 공개 별, 중복 PUT·반복 DELETE, 두 계정 관계 격리, 정렬·페이지 중복, 숨김·권한 철회, GET과 요약 일치, CSRF/401/503을 검증한다.
- FE 계약 테스트 통과 후에도 실제 두 계정·실제 DB·배포 검증은 `244 P1-219`에 남는다. API를 다르게 구현해야 한다면 이 문서와 소비 파서를 같은 MR에서 변경하고 교차 리뷰한다.

## 3. 알림 · 220

프론트 `/notifications`는 헤더 종 아이콘으로 진입한다. 주 메뉴에 중복 항목을 추가하지 않는다. 제공자는174/175이며 실제 인수는244 P1-220이다.

| 메서드·경로 | 요청·응답 |
|---|---|
| GET `/api/v1/me/notifications?size=20&cursor=...&unreadOnly=false` | `{items:[Notice],nextCursor:null,hasNext:false,readBoundary:"opaque"}` |
| GET `/api/v1/me/notifications/unread-count` | `{unreadCount:2}` |
| GET `/api/v1/me/notifications/{notificationId}/target` | `{notificationId:"n1",available:true,target:{kind:"POST",postId:"p1"}}` |
| PATCH `/api/v1/me/notifications/{notificationId}` | `{read:true}` → `{notificationId:"n1",read:true}` |
| PATCH `/api/v1/me/notifications/read` | `{through:"opaque"}` → `{unreadCount:0}` |

`Notice` 예시: `{notificationId:"n1",kind:"COMMENT",createdAt:"2026-09-21T01:00:00Z",read:false,available:true,title:"탐사 기록에 새 댓글이 달렸습니다",body:"새 의견을 확인하세요."}`. 시간은 UTC ISO8601이다. 종류는 ACHIEVEMENT(성과·등급), REOPEN(재탐색), CHALLENGE(현재 회차), FOLLOW(팔로우 소식), COMMENT(내 글의 댓글)다. 전문가/비전문가 신규 알림 정책은 여기서 만들지 않는다.

### 3.1 현재 권한과 목적지

- 알림 자체는 본인만 조회/변경한다. 타인 ID는404, 인증은401, CSRF 오류는기존403이다. false/null 읽음 변경은400이다. 읽음은 true로만 진행하며 반복 PATCH는 같은 결과다.
- 목록/카운트/대상 조회 모두 현재 공개 상태를 검사한다. 숨김·삭제·첨부 철회 후 목록에는 과거 민감한 제목/본문을 남기지 않고 `available:false,title:"",body:""`를 반환한다. 미확인 수는 본인 알림 저장 상태에서 집계하며 오류를 0으로 바꾸지 않는다.
- 클릭 시 target을 새로 조회한다. 접근 불가면200 `{notificationId:"n1",available:false,target:null}`이며 프론트는 이동하지 않는다. 허용되어도 목적지 API가 권한을 다시 검사한다. 이 조회가 권한 토큰이나 보호 우회 수단은 아니다.
- target은 URL 문자열이 아닌 고정 DTO다. `POST/postId`, `THREAD/threadId`, `STAR/ticId`, `CHALLENGE/roundId` 중 하나다. POST/THREAD에 commentId가 있으면 서버가 해당 댓글이 있는 페이지의 discussionCursor도 제공하고 프론트는 토론 영역으로 이동한다. 외부 URL/임의 경로는 거절한다.
- STAR 목적지는 본인이 해금하여 개인 상세를 볼 수 있는 TIC에만 사용한다. 팔로우한 미해금 별 소식은 공개 게시글/스레드 목적지를 사용한다. 삭제 댓글/종료 회차/권한 철회를 검증한다. 종료 회차는 현재 퀘스트를 보여주되 회차 변경을 안내하고 자동으로 분석을 시작하지 않는다.

### 3.2 읽음 범위·경합

목록은 생성시각 내림차순·동률 ID 내림차순이다. readBoundary는 첫 조회 당시의 본인 전체 알림 경계를 표현하는 불투명 값이며 필터/현재 페이지의 항목 목록만을 뜻하지 않는다. 모두 읽음은 그 시점까지에만 적용하며 그 이후 새 알림은 읽지 않은 상태를 유지한다. 서버는 다른 회원/위조 경계를400으로 거절한다. 응답의 unreadCount는 적용 후 실제 값이다. 응답 유실 시 PATCH를 자동 반복하지 않고 목록과 수를 재조회한다.

벨은 보이는 동안60초마다 갱신하며 focus/pageshow 복귀 재조회는 공용 훅을 사용한다. 화면을 숨길 때 알림 내용을 비우고 새 응답 전까지 이전 내용을 복원하지 않는다. 이벤트가 오면 벨/목록을 함께 갱신한다.

소비 코드: [notifications/contracts.ts](../../frontend/src/features/notifications/contracts.ts), [Notifications.tsx](../../frontend/src/features/notifications/Notifications.tsx). 합성 제공자: [notifications-fixture-plugin.ts](../../frontend/dev/notifications-fixture-plugin.ts). DB·알림 생성·수신 설정·경합 검증은 실제 제공자 작업이며 fixture 통과로 대체하지 않는다.

## 4. 개인 설정 · 221

설정은 마이페이지에서 들어간다. 주 메뉴의 중복 설정 진입은 제거한다. 닉네임 편집·가입일·사용법 다시 보기는 기존 P0 계약을 유지한다. 가입 안내 완료 API와 설정 API를 섞지 않는다.

- 공개 범위: 기존 GET `/api/v1/me`의 `starListVisibility`, PATCH `/api/v1/me/settings`의 `{starListVisibility:"PUBLIC"|"PRIVATE"}`를 그대로 사용한다. 이 값 하나로 **전체 보유 별의 공개 은하와 별 목록**을 제어한다. PUBLIC이 개인 History/정답 열람/분석 재시도 권한까지 공개한다는 뜻은 아니다. 은하 방문의 상세 투영은 별도 방문 계약을 따른다.
- GET `/api/v1/me/notification-settings` → `{preferences:{ACHIEVEMENT:true,REOPEN:true,CHALLENGE:true,FOLLOW:true,COMMENT:true}}`.
- PATCH 같은 경로에 `{preferences:{FOLLOW:false}}`처럼 **변경한 키만** 전송한다. 응답은 저장 후 전체 preferences다. 알림5종 모두 boolean이며 GET 누락을 true로 추측하지 않는다. 현재 프론트 기준 최초 기본은5종 모두true다. 알림 전달 채널은 서비스 내 알림함이며 이메일/푸시는 포함하지 않는다.
- 빈 객체·알 수 없는 종류·null·boolean 이외 값은400 VALIDATION_FAILED. 기존 키는 보존하며 한 탭에서 FOLLOW를 바꿔도 다른 탭이 저장한 COMMENT를 덮어쓰지 않는다. 원자적인 부분 갱신이 필요하다.
- 설정은 **이후 생성하는 알림**에 적용한다. 이미 생성한 알림/읽음 상태/팔로우 관계는 삭제하지 않는다. 수신 차단을 풀어도 과거 차단 기간의 알림을 소급 생성하지 않는다.
- 응답 유실 시 쓰기를 자동 재전송하지 않고 GET으로 확인한다. 실제 계정별 유지·알림 생성과의 경합은175/244 P1-221에서 검증한다.

소비 코드: [SettingsPage.tsx](../../frontend/src/features/profile/SettingsPage.tsx), [NotificationPreferences.tsx](../../frontend/src/features/notifications/NotificationPreferences.tsx). 합성 서버: [settings-fixture-plugin.ts](../../frontend/dev/settings-fixture-plugin.ts).

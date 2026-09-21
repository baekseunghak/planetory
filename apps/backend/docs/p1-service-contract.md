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

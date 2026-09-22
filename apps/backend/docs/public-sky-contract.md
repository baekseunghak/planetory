# 공개 은하 조회 계약 — S15P21C206-250

작성 2026-09-21. 프론트 소비 기준이며 **백엔드 구현 완료 문서가 아니다**. 사용자 결정: 승인된 시제품 모습으로 P1을 병행 구현하고 백엔드는 이 계약에 맞춘다. 기존 개인 지도 API는 유지한다.

## 제품 범위

- 로그인한 회원이 다른 회원의 공개 프로필 → 은하 방문으로 이동한다. `/members/:memberId/sky`.
- `starListVisibility=PUBLIC`은 은하와 별 목록을 함께 공개한다. PRIVATE·탈퇴·없는 회원은 공개 은하/타일/상세 모두 404 `PUBLIC_SKY_NOT_AVAILABLE`. 로그인하지 않은 요청은 401.
- 공개 은하는 **해당 회원의 전체 보유 별**이다. 제출 이력이 있는 별만 고르지 않는다. 기존 A13 제출 목록 필터의 의미를 바꾸지 말 것.
- 해당 소유자의 저장된 world_x/world_y/depth_z/layout_ordinal을 그대로 반환한다. 방문자용 랜덤 배치·재계산·군집 합산 금지. 같은 소유자의 지도/상세 좌표와 행성 개수는 동일해야 한다.
- 방문자는 회전·이동·확대·별/행성 상세만 읽는다. 개인 분석 시작·결과·History·퀘스트·미열람 정답·요청 ID·재탐사 상태는 공개하지 않는다. 서버의 조회 DTO를 명시적인 공개 필드로 구성한다.

## GET /api/v1/members/{memberId}/sky

개인 지도 메타의 representation/layoutVersion/presentationVersion/version/starCount/bounds/tileSize/zoomLevels/asOf와 아래 공개 외형을 반환한다. firstVisit, centerTicIds는 공개 응답에 넣지 않는다.

```json
{"owner":{"memberId":"42","nickname":"탐사자"},"scope":"all-owned","visibility":"PUBLIC","representation":"individual-stars","layoutVersion":"personal-spiral-v1","presentationVersion":"personal-galaxy-v1","version":"42:7","starCount":1000,"bounds":{"minX":-2000,"maxX":2000,"minY":-2000,"maxY":2000},"tileSize":512,"zoomLevels":[{"level":0,"scale":0.25},{"level":1,"scale":1},{"level":2,"scale":4}]}
```

위 범위와 개수는 외형 예시다. 실제 저장 자료에서 계산한다. 빈 계정은 starCount=0이며 실패 응답을 0개로 바꾸지 않는다. 배율 단계는 개인 지도 현행 계약처럼 연속된 1단계 이상이며 모든 배율에서 개별 별을 유지한다.

## GET /api/v1/members/{memberId}/sky/tiles

개인 `/me/sky/tiles`와 같은 level,x,y,w,h,version,limit,cursor 및 반개구간 경계·rangeStarCount·versionChanged·다음 페이지 규칙을 사용한다. cursor는 소유자/권한 범위/버전/영역/배율에 묶고 다른 회원에게 재사용할 수 없다. 응답의 stars에는 ticId,x,y,depthZ,layoutOrdinal,planetCount,progressStage,completedWithoutPlanets만 허용한다. marker/reopened 및 개인 탐사 상태는 제외한다. 진행 단계는 공개 요약 3종만 허용한다.

전체 범위의 페이지를 끝까지 읽으면 starCount와 중복 제거 개수가 일치해야 한다. 1,000개 페이지 제한은 전체 별 제한이 아니다. PRIVATE 전환 시 기존 cursor도 즉시 거부한다.

## GET /api/v1/members/{memberId}/stars/{ticId}

```json
{"memberId":"42","ticId":"123456789","version":"42:7","presentationVersion":"personal-galaxy-v1","position":{"x":1612.4,"y":-233.0,"depthZ":0.42,"layoutOrdinal":9,"layoutVersion":"personal-spiral-v1"},"planets":{"count":1,"items":[{"candidateId":"candidate-1","kind":"confirmed","periodDays":3.37,"depthPpm":320}]}}
```

- memberId는URL 소유자와 일치한다. ticId/version/presentationVersion/position/planets 검증은 개인 지도와 동일하다. depthZ는 무차원 [-1,1]; 프론트 월드 깊이 환산은 기존 계약의 256이다.
- 그 소유자가 성과 인정받은 행성 후보만, candidateId 오름차순/중복 없이/count 일치. 카탈로그 전체 행성·방문자의 행성을 섞지 않는다. periodDays 양수 또는 null, depthPpm 음수 아닌 수 또는 null. 알 수 없는 수치를 0으로 만들지 않는다.
- position은 별지도 저장 좌표이다. 행성 표면·궤도·색은 프론트 연출이며 관측 사진이나 실제 궤도 데이터라고 주장하지 않는다.
- 해당 소유자가 보유하지 않은 TIC는 404. unlock 사유·시간/actions/progress 상세/개인 제출 이력은 반환하지 않는다.

## 권한·캐시·실패

모든 공개 읽기는 인증 후 소유자 공개 여부를 조회 직후와 응답 확정 전에 확인한다. Cache-Control: no-store. 서버·CDN·브라우저 영속 캐시에 개인 DTO를 공개 응답처럼 저장하지 않는다. 프론트는 메모리만 쓰고 소유자 이동, 숨김/pagehide, 로그아웃에 파기한다. 복귀/최대 60초마다 새로 읽는다. 실패 응답 또는 권한 철회가 확인되면 기존 천체도 제거한다. 즉각적인 푸시 철회는 현재 계약에 없으므로 최대 60초 가시 화면 갱신 간격을 갖는다.

## 백엔드 인수 체크

- [ ] 공개 0개/1,000개/5,000개에서 전체 페이지 개수·좌표·행성 수가 개인 지도와 일치한다.
- [ ] 제출하지 않은 보유 별도 포함된다. 소유하지 않은 별은 제외한다.
- [ ] PRIVATE/탈퇴/404 및 페이지 중간 공개 철회가 모든 API·cursor에 적용된다.
- [ ] 소유자 A/B와 로그인 회원 변경 시 교차 자료 누출이 없다.
- [ ] 개인 History/분석/정답/jobId 및 퀘스트 데이터가 DTO에 없다.
- [ ] 같은 버전에서 타일과 상세가 같고 버전 변경은 기존 재조회 계약을 따른다.
- [ ] 실제 로그인+공개 설정 전환+방문 경로는 P1 통합 인수에서 검증한다.

프론트: `src/features/public-sky`, Chrome `tests/p1/public-sky.spec.ts`. 메모리 fixture는 로컬 시각/실패 검사용으로 운영 서버 구현이나 권한 검증 증거를 대체하지 않는다.


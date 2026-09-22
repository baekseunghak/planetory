# 공개 은하 조회 계약 — S15P21C206-250·251

작성 2026-09-21, 갱신 2026-09-22. 250 프론트는 develop 병합되었으며, 251 백엔드는 이 계약의 세 조회 API 구현과 격리 PostgreSQL 검증을 완료했다. 사용자 결정에 따라 승인된 시제품 모습으로 P1을 병행 구현하며 기존 개인 지도 API는 유지한다. 비작성자 리뷰·develop 반영은 별도이며 실제 로그인·공개 설정 전환·배포 인수는 244에서 진행한다.

## 제품 범위

- 로그인한 회원이 다른 회원의 공개 프로필 → 은하 방문으로 이동한다. `/members/:memberId/sky`.
- `starListVisibility=PUBLIC`은 은하와 별 목록을 함께 공개한다. PRIVATE·탈퇴·없는 회원은 공개 은하/타일/상세 모두 404 `PUBLIC_SKY_NOT_AVAILABLE`. 로그인하지 않은 요청은 401.
- 공개 은하는 **해당 회원의 전체 보유 별**이다. 제출 이력이 있는 별만 고르지 않는다. 기존 A13 제출 목록 필터의 의미를 바꾸지 말 것.
- 해당 소유자의 저장된 world_x/world_y/depth_z/layout_ordinal을 그대로 반환한다. 방문자용 랜덤 배치·재계산·군집 합산을 금지한다. 같은 소유자의 개인·공개 지도와 상세 좌표는 동일해야 한다. 공개 행성은 아래 성과 조건을 추가하므로 개인 행성 수와 다를 수 있으며, 공개 타일의 planetCount와 공개 상세의 planets.count는 같은 버전에서 일치해야 한다.
- 방문자는 회전·이동·확대·별/행성 상세만 읽는다. 개인 분석 시작·결과·History·퀘스트·미열람 정답·요청 ID·재탐사 상태는 공개하지 않는다. 서버의 조회 DTO를 명시적인 공개 필드로 구성한다.

## GET /api/v1/members/{memberId}/sky

개인 지도 메타의 representation/layoutVersion/presentationVersion/starCount/bounds/tileSize/zoomLevels/asOf를 재사용하고 공개 전용 version과 아래 공개 외형을 반환한다. firstVisit, centerTicIds는 공개 응답에 넣지 않는다. memberId는 기존 회원 식별자 형식인 `u-42`를 사용한다.

```json
{"owner":{"memberId":"u-42","nickname":"탐사자"},"scope":"all-owned","visibility":"PUBLIC","representation":"individual-stars","layoutVersion":"personal-spiral-v1","presentationVersion":"personal-galaxy-v1","version":"u-42:7:public-v1:0123456789abcdef0123456789abcdef","starCount":1000,"bounds":{"minX":-2000,"maxX":2000,"minY":-2000,"maxY":2000},"tileSize":512,"zoomLevels":[{"level":0,"scale":0.25},{"level":1,"scale":0.5},{"level":2,"scale":1},{"level":3,"scale":2},{"level":4,"scale":4}],"asOf":"2026-09-22T00:00:00Z"}
```

위 범위와 개수는 외형 예시다. 실제 저장 자료에서 계산한다. 빈 계정은 starCount=0이며 실패 응답을 0개로 바꾸지 않는다. 배율 단계는 개인 지도 현행 계약처럼 연속된 1단계 이상이며 모든 배율에서 개별 별을 유지한다.

## GET /api/v1/members/{memberId}/sky/tiles

개인 `/me/sky/tiles`와 같은 level,x,y,w,h,version,limit,cursor 및 반개구간 경계·rangeStarCount·versionChanged·다음 페이지 규칙을 사용한다. cursor는 공개 전용 namespace(`public-sky-v1`)와 로그인 방문자/소유자/공개 version/요청 영역/배율/limit에 묶는다. 개인 API 또는 다른 방문자·소유자·조회 조건의 cursor를 혼용하지 않는다. 응답의 stars에는 ticId,x,y,depthZ,layoutOrdinal,planetCount,progressStage,completedWithoutPlanets만 허용한다. marker/reopened 및 개인 탐사 상태는 제외한다. 진행 단계는 `unexplored`, `in_progress`, `completed` 세 공개 요약만 허용한다.

전체 범위의 페이지를 끝까지 읽으면 starCount와 중복 제거 개수가 일치해야 한다. limit 기본 1,000·최대 2,000은 페이지 크기이며 전체 별 제한이 아니다. PRIVATE 전환 시 기존 cursor도 404 `PUBLIC_SKY_NOT_AVAILABLE`로 거부한다. 공개 상태가 유지되더라도 version이 바뀌면 stars 빈 배열·nextCursor=null·versionChanged=true를 반환하며, 이를 빈 은하로 처리하지 않고 메타부터 다시 조회한다. 현재 version의 잘못된 cursor는 400 `VALIDATION_FAILED`다.

### 완료 표식의 공개 의미

공개 `completedWithoutPlanets`는 `progressStage='completed' && planetCount=0`, 즉 **탐색은 완료했으나 현재 공개 조건을 충족하는 행성이 없음**을 뜻한다. 개인 지도는 저장된 `user_star_progress.planet_count`를 쓰지만 공개 지도는 현재 공개 행성 수를 쓴다. 따라서 같은 별의 플래그가 개인/공개에서 달라도 정상이며, 공개 플래그를 소유자가 아무 행성도 발견하지 못했다는 뜻으로 해석하지 않는다.

성과 미인정 또는 현재 FP 라벨 때문에 공개 행성이 0개가 될 수 있다. 라벨 변경으로 공개 플래그가 바뀌어도 기존 성과·등급·개인 진행 행을 재계산하거나 회수하지 않는다. 방문 화면의 툴팁·키보드 안내·목록은 “공개 행성 0개 · 탐색 완료 · 현재 공개할 행성이 없습니다”, 빈 상세는 “현재 공개할 행성이 없습니다. 개인 탐사 결과와 다를 수 있습니다.”로 표시한다. 개인 화면의 “표시할 내 행성 없이 완료” 문구를 공개 화면에 재사용하지 않는다.

## GET /api/v1/members/{memberId}/stars/{ticId}

```json
{"memberId":"u-42","ticId":"123456789","version":"u-42:7:public-v1:0123456789abcdef0123456789abcdef","presentationVersion":"personal-galaxy-v1","position":{"x":1612.4,"y":-233.0,"depthZ":0.42,"layoutOrdinal":9,"layoutVersion":"personal-spiral-v1"},"planets":{"count":1,"items":[{"candidateId":"c-1","kind":"confirmed","periodDays":3.37,"depthPpm":320}]}}
```

- memberId는 URL 소유자와 일치한다. ticId/presentationVersion/position/planets의 형식 검증은 기존 지도 검증을 재사용하며 version은 공개 메타·타일과 일치해야 한다. depthZ는 무차원 [-1,1]; 프론트 월드 깊이 환산은 기존 계약의 256이다.
- 소유자의 `user_candidate_achievements`가 있는 후보와 현재 HOME-05 행성 표시 조건의 교집합만 제공한다. 현재 `candidate_dispositions.disposition='fp'`는 제외하고, 나머지는 현재 `candidates.is_confirmed=true` 또는 소유자의 해당 후보 최신 제출 판단이 `LIKELY_PLANET`일 때 포함한다. 최신 판단은 제출 시각·ID 내림차순으로 정한다. 성과 없는 수치 매칭 후보는 공개에서 제외하므로 개인 행성 수와 다를 수 있다. 개인 API와 A13 목록 의미는 바꾸지 않는다.
- 외부 라벨 갱신으로 기존 성과 유형을 바꾸거나 성과를 회수하지 않는다(GRD-06). 공개 행성의 포함 여부·kind는 현재 후보 상태로 판단하며, 과거 `achievement_type='fp'`만을 이유로 영구 제외하지 않는다. 공개 취소·일반 운영 숨김도 기존 성과를 회수하지 않으므로 별도 제외 조건으로 쓰지 않는다.
- candidateId는 `c-1` 형식의 문자열 오름차순이며 중복 없이 count와 일치한다. 카탈로그 전체 행성·방문자의 행성을 섞지 않는다. periodDays 양수 또는 null, depthPpm 음수 아닌 수 또는 null을 반환하며 수치가 없을 때 0으로 바꾸거나 감광 깊이를 정수로 반올림하지 않는다.
- position은 별지도 저장 좌표이다. 행성 표면·궤도·색은 프론트 연출이며 관측 사진이나 실제 궤도 데이터라고 주장하지 않는다.
- 해당 소유자가 보유하지 않은 TIC는 404. unlock 사유·시간/actions/progress 상세/개인 제출 이력은 반환하지 않는다.

## 권한·캐시·실패

모든 공개 읽기는 인증 후 활성 소유자의 공개 설정을 확인한다. DB의 `users.status='active'`, `withdrawn_at IS NULL`, `user_settings.star_list_public`을 사용하며 설정 행이 없으면 기존 기본값 PUBLIC을 적용한다. 본문·버전·개수는 하나의 REPEATABLE_READ 읽기 트랜잭션으로 구성하고, 응답 확정 직전에 별도 READ_COMMITTED·REQUIRES_NEW 읽기 트랜잭션에서 최신 권한을 재검사한다. 같은 REPEATABLE_READ 안에서 반복 조회하는 것으로 철회 재검사를 대신하지 않는다.

Cache-Control: no-store를 적용한다. 서버·CDN·브라우저 영속 캐시에 개인 DTO를 공개 응답처럼 저장하지 않는다. 프론트는 메모리만 쓰고 소유자 이동, 숨김/pagehide, 로그아웃에 파기한다. 복귀/최대 60초마다 새로 읽는다. 실패 응답 또는 권한 철회가 확인되면 기존 천체도 제거한다. 즉각적인 푸시 철회는 현재 계약에 없으므로 최대 60초 가시 화면 갱신 간격을 갖는다.

## 공개 버전과 조회 비용

공개 version은 `<기존 회원 지도 version>:public-v1:<32자리 MD5 지문>`이다. 예를 들어 `u-42:7:public-v1:0123456789abcdef0123456789abcdef`이며 예시 지문은 실제 자료의 검산값이 아니다. 프론트는 version을 불투명 문자열로 비교하며 개인 version과 같다고 가정하거나 숫자 순서를 해석하지 않는다.

기존 회원 지도 revision은 현재 구현에서 새 별 발견 때 증가한다. 새 별을 지급하지 못한 성과 추가, 진행 단계·현재 라벨·행성 수치 갱신까지 추적하지 못하므로 공개 version에는 닉네임, 전체 보유 별의 저장 좌표/layout/진행 요약, 정렬된 공개 행성의 TIC·후보 ID·kind·주기·깊이 지문을 함께 넣는다. 타일 개수·상세 행성·지문은 같은 공개 행성 SQL 조건을 사용한다. 권한 검사는 지문과 별도로 수행한다.

각 요청은 타일 크기와 관계없이 전체 보유 별·성과 후보를 읽어 정렬·집계하고 후보별 최신 제출 판단을 조회한다. 보유 수뿐 아니라 제출 수와 정렬 비용도 조회 시간에 영향을 준다. 모든 원천 변경을 무효화할 근거 없이 지문을 임의 캐시하지 않는다. 비용이 문제가 되면 원천 변경 트랜잭션에서 공개 버전을 함께 갱신하는 계약을 먼저 마련한다. 기존 테이블과 `planetory_app` 조회 권한을 재사용하며 251은 새 마이그레이션을 추가하지 않는다.

타일 페이지마다 소유자 전체 지문을 다시 계산하므로 좁은 영역이나 다음 페이지도 전체 집계 비용을 지불한다. 메타→5페이지→상세 측정에는 총 7회 지문 계산이 포함된다. 244 인수에서는 소유자 별·성과·제출 수와 페이지 수를 늘리고 좁은 타일도 측정해 전환 필요성을 판단한다. 현재 패치에서는 버전 갱신 방식이나 캐시를 변경하지 않는다.

## 백엔드 인수 체크

- [x] 공개 0개/1,000개/5,000개에서 전체 페이지 누락·중복이 없고 starCount·rangeStarCount와 일치한다. 소유 별과 저장 좌표는 개인 지도와 동일하다.
- [x] 성과 없는 후보·현재 FP를 제외하고 최신 판단·라벨 갱신 조건을 적용한다. 공개 타일과 공개 상세 행성 수가 일치하며 개인 행성 수와의 차이는 허용한다.
- [x] 제출하지 않은 보유 별도 포함된다. 소유하지 않은 별은 제외한다.
- [x] PRIVATE/탈퇴/404 및 페이지 중간 공개 철회가 모든 API·cursor에 적용된다.
- [x] 소유자 A/B와 로그인 회원 변경 시 교차 자료 누출이 없다.
- [x] 개인 History/분석/정답/jobId 및 퀘스트 데이터가 DTO에 없다.
- [x] 같은 버전에서 타일과 상세가 같고 버전 변경은 기존 재조회 계약을 따른다.
- [x] 성과만 추가되거나 라벨·수치·최신 판단·진행이 변경돼도 공개 projection 변경을 버전이 감지한다.
- [x] 최소 앱 역할 SQL 권한과 기존 SkyTiles/StarDetail/StarList 회귀를 격리 DB에서 검증한다.
- [ ] 실제 로그인+공개 설정 전환+방문·배포 경로는 244 P1 통합 인수에서 검증한다.

프론트: `src/features/public-sky`, Chrome `tests/p1/public-sky.spec.ts`. 메모리 fixture는 로컬 시각/실패 검사용으로 운영 서버 구현이나 권한 검증 증거를 대체하지 않는다.

### 2026-09-22 격리 검증 결과

251 전용 PostgreSQL 18.6·별도 세션/캐시 Redis에서 `PublicSkyTest` 14건을 통과했다. 인증된 MockMvc 경로로 응답 필드·no-store·401/404·철회 경합을 검증하고, `SET ROLE planetory_app` 연결에서 세 조회의 실제 SQL을 실행했다. 현재 후보 수치 열은 NOT NULL이므로 null 보존은 공개 DTO 직렬화 검증이며 실제 null 저장 검증과 구분한다.

기존 `SkyTilesTest` 17건·`StarDetailTest` 23건·`StarListTest` 26건·`StarPathHttpTest` 7건, 프론트 공개/지도 계약 단위 10건을 통과했다. 실제 DB 표본의 MockMvc 메타·타일·상세 응답을 `build/public-sky-contract.json`으로 저장하고 프론트 `readPublicMeta`·`publicTiles`·`readPublicSystem`에 입력해 저장 좌표·공개 버전·행성 수 3개의 호환을 확인했다. 실제 브라우저 로그인 종단 검증은 아니다.

합성 별 5,000개와 첫 별의 성과 인정 미확정 행성 1,000개에서 메타→전체 5페이지→상세를 3회 읽었다. 각 회차의 별 5,000개 중복 제거 수와 타일·상세 행성 1,000개가 일치했다. 최종 서비스 호출 측정은 1,627.787/1,623.515/1,604.078ms, 중앙값 1,623.515ms다. 이 측정은 로컬 DB 소유자 연결·서비스 호출·합성 표본에 한하며 실제 앱 역할 기능 검증과 별도로 수행했다. HTTP 지연·운영 규모·성능 인수 기준을 보장하지 않는다. 새 인덱스·캐시·마이그레이션은 추가하지 않았다.


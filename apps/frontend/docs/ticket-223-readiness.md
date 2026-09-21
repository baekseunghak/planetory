# 223 별 검색·필터·위치 이동

기준: 2026-09-21 develop `c711da9`, [탐사 API 4.1·4.4](../../backend/docs/exploration-api-spec.md). 실제 develop 서버는 필터와 locate를 아직 제공하지 않는다. 제공된 문서의 전송 형식을 소비하는 프론트와 serve 전용 합성 HTTP fixture를 작성했다.

## 구현

- [x] 은하 위 접을 수 있는 내 별 찾기. TIC·진행 단계·등급 조합, 입력 검증, 검색/초기화, 불투명 cursor 페이지, 빈/로딩/오류/재시도.
- [x] 지도는 `GET /api/v1/me/stars?scope=discovered&sort=recent&size=20`에 필요한 `ticId/stage/grade/cursor`만 보낸다. 확정 행성 여부 필터나 미발견 별 카탈로그를 추가하지 않는다.
- [x] 선택은 `GET /api/v1/me/sky/locate?ticId=...`의 좌표·depthZ·level·bounds·version·layoutVersion·layoutOrdinal을 검사한다. 월드 좌표를 생성하지 않는다. 서버 level의 scale로 카메라를 움직이고 bounds를 타일 조회에 전달한다.
- [x] 검색 조건은 URL의 filterTic/filterStage/filterGrade에 보존한다. 상세 닫기·분석 복귀 경로에 같은 조건을 유지한다. 다른 조건·판·회원으로 바뀌면 늦은 결과/위치 응답을 폐기한다.
- [x] 검색을 열기 전 추가 목록 요청 없음. P0 지도·대체 목록 흐름을 유지한다. 403 locate는 별을 선택하거나 상세를 보여주지 않는다.
- [x] `ProfileStarFilters`와 `ProfileSlotProps.starFilters`로 A13 내 별 목록의 공용 필터 입력을 제공한다. 타인에게는 이 필터를 적용하지 않으며 기존 PRIVATE 차단을 유지한다.

## A13 연결 계약

`App.profileSections.stars` 소비자는 기존 memberId/isOwn/starListVisibility와 함께 선택적 `starFilters`를 받는다. 본인 목록은 `starSearchPath(starFilters ?? emptyStarFilters, cursor, "submitted")`를 호출한다. 필터 변경 때 cursor를 초기화하고 기존 요청을 중단한다. 지도는 discovered, 마이페이지는 submitted를 유지한다. 별 선택 후 복귀 URL에 현재 검색을 보존한다.

이 기준 develop의 main.tsx에는 실제 A13 stars 슬롯이 아직 등록되지 않았다. **입력 어댑터만 준비되었으며 실제 목록 소비자의 적용·연결 검증은 미완료**다. 기존 연결 자리를 전체 목록 구현으로 대체하거나 다른 담당자의 화면을 구현했다고 보고하지 않는다.

## 검증 및 남은 것

- [x] 신규 단위: TIC 정규화·scope·cursor·URL 보존, locate의 ID/판/좌표/깊이/경계 거부. 기존 포함 단위342개 통과.
- [x] Chrome 별 검색 8개: 필터·서버 배율·상세 복귀, 입력/빈 결과,403, cursor/뒤로가기, 목록 모드, 늦은 locate 폐기, 조회 오류 재시도.
- [x] Chrome 기존 프로필8개·별 상세9개·대체 목록11개 통과. 타입·렌더러 운영 빌드·개발 fixture 제외 통과. 대체 목록 URL 검사는 검색 조건 보존에 따른 query 순서 변화와 무관하게 선택 TIC와 list 모드를 확인하도록 바꿨다.
- [ ] A13 소비자에서 실제 필터 요청과 목록/History 왕복. 준비된 입력 슬롯만으로 완료 체크하지 않는다.
- [ ] 실제 C17 API와 동일 자료로 지도/목록/locate 의미 대조, 두 계정·배포 인수는244 P1-223.
- [ ] 리뷰·병합·Jira 완료 전환.

`npm run dev:star-search` → `http://127.0.0.1:58384/sky`. `npm run test:star-search`는 Chrome·58385를 사용한다. 합성 별은 개발 서버에서만 공급한다.

248 디자인 변경을 이 독립 브랜치에 중복 포함하지 않았다. 이번 변경은 시제품의 은하 표시 자체를 다시 작성하지 않으며 시각 일치 최종 검토는248 병합 후 함께 확인한다.

## 2026-09-21 선행 기능 통합

최신develop(af29c8e)와219→220→221→222를 병합했다.248 배치와 검색의 충돌을 해결하면서 카메라 선택의 scrollIntoView 재도입을 피하고, 검색 패널이 제목/목록 전환 버튼을 가리지 않게 배치했다. Chrome 검색8개 중7개 통과 후 겹침으로 실패한 목록 전환1개를 수정해 재검증 통과했다. A13 실제 소비자 연결 미완료는 유지한다. 백엔드 인계 문서는 P1 계약6절을 따른다.

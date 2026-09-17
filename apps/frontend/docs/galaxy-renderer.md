# 204 개별 별 은하 렌더러

2026-09-17 보완: 206은 기존 상세 조회 주체를 `StarDetail.tsx`로 확장하고 `SceneControl.focusStar`·동일 canvas 행성 확대·복귀를 연결했다. [206 인수 기록](ticket-206-readiness.md)이 현재 상세 구현 기준이며 아래 미래형 설명은 204 작성 당시 범위다.

2026-09-17 보완: 205의 조작·히트 테스트·마커는 [205 인수 기록](ticket-205-readiness.md)을 따른다. 아래 204 구현 당시 범위와 구분한다.

2026-09-15. 사용자 승인된 [표현 계약 v1.3 / MR !41](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/41)과 `7f67c5683f79e541da556ef4e6aed966ff317c11`의 개인 시제품 참조를 적용한다. 문서 팀 승인·병합 및 실제 API 인수는 대기 중이다.

## 실행

- `npm run dev:galaxy` → 기본58272. 기존 서버와 구분한 이번 확인 주소는 `http://127.0.0.1:58275/sky?reference=1`이다.
- `204 렌더 검증 도구`에서1/10/100/1000/2501개 계정, 원본 카메라, 회전·기울기·LOD, 고정 별 선택, 실패/복구를 확인한다. `reference=1`은 개발 전용 화면 크기 비교 모드다.
- 실제 모드는 `VITE_SKY_RENDERER_ENABLED=true`와 기존 `API_PROXY_TARGET`/인증을 사용한다. API가 없으면 오류이며 합성 은하를 만들지 않는다.
- `npm run build:renderer`는 렌더 플래그를 켠 운영 빌드다. 플래그는 빌드 시점 값이고 기본값은 false다. Docker는 `--build-arg VITE_SKY_RENDERER_ENABLED=true`로 활성화한다. Node22/로컬 Nginx는 [통합 검증](local-validation-201-204.md)을 통과했으며 실제 배포는 별도 인수다.
- 실제 클릭·드래그·휠·키보드·마커는205, 상세 HTTP/정보/행성 확대/복귀 UI는206이다. 개발 도구의 고정 선택 버튼을 해당 기능 완료로 세지 않는다.

## 데이터와 카메라

203의9/15 개별 별 보완을 의존 변경으로 포함했다. `SkyDataPage → SkyDataStore → GalaxyScene → GalaxyRenderer`로 연결한다. 203 선행 브랜치와 같은 데이터 계약을 사용한다. [203 어댑터](sky-data-adapter.md)와 [203 인수 기록](ticket-203-readiness.md)을 따른다.

1. 메타 `representation=individual-stars`, `layoutVersion=personal-spiral-v1`, `presentationVersion=personal-galaxy-v1`을 검증한다.
2. 캔버스 크기를 읽고203의 `galaxyMatrix`로 투영한다. API z는 정규화된 채 버퍼에 저장하고 행렬에서 **256을 한 번만** 곱한다.
3. 같은 행렬의 역투영으로 각 변20% 여백과 전체 깊이를 포함한 bbox를 요청한다. `version/level/bbox/limit/cursor` 범위를 유지한 페이지를 모두 표시한다. 페이지 크기는 표시 개수 상한이 아니다.
4. `renderPlan`은 적재 자료 중 화면과 발광 여백에 걸친 별만 인스턴스로 넘긴다. 좌표와 순번을 변경하지 않는다. 전체 계정 목록을 프레임마다 조회·순회하지 않는다.
5. 초기 카메라는 참조의 `{x:0,y:0,zoom:1,yaw:0.12,tilt:1,roll:-0.28}`다. `fitAll`은 메타 저장 경계와 전체 깊이를 여백 안에 담는 보수적인 전체 보기다. 회전한 월드 AABB와 실제 점 분포는 달라 여백이 더 생길 수 있다. 새 발견 때 카메라를 자동 초기화하지 않는다.

원본 비교는1440×836 캔버스, DPR1, 캡처와 같은 x/y/zoom에서 한다. 기본/전체 보기와 캡처 당시 카메라를 혼동하지 않는다. 배율0.001~10000, 기울기±1.42다.

## 표현과 GPU

- `model.starStyle`은 저장 x/y와 `layoutOrdinal`만 읽어 참조 색·크기를 계산한다. 좌표 생성 함수는 운영 코드에 없다. 행성 수·진행·완료·등급·배열 순서로 색칠하지 않는다.
- 금빛 중심, 푸른/보라 팔, 작은 코어와 약한 발광을 사용한다. 원본 코어 `exp(-d*22)+exp(-d*4.5)*.22`, 본체 .88, 발광 .048/8배를 이식했다. 점 스프라이트를 WebGL2 인스턴스 사각형으로 옮겨 GPU/픽셀 중심에 따른 미세 차이는 허용한다.
- 전체 지도 궤도·행성은 모든 배율에서0개다. 군집/성운 버퍼와 별400/궤도별60/성운80 상한을 삭제했다. 낮은 LOD 군집으로 되돌리는 분기도 없다.
- 별 본체와 발광은 같은 별 버퍼를2회 그린다. 상세 궤도는 LINES1회, 행성은 인스턴싱1회다. GPU 버퍼는 quad/별/궤도/행성 총4개를 재사용한다.
- 자료·카메라·선택 변경 때만 패킹한다. 바뀐 구간을 한 번의 `bufferSubData`로 합치고 용량 부족 때 같은 객체 저장 공간만 늘린다. 정지 프레임은 재패킹/전송하지 않는다.
- `RendererMetrics`는 실제 호출 횟수, 그리는 별/행성 수, 버퍼/할당/전송량/패킹/시간을 보고한다. 이 수치나2501개 성공은10만 별 성능 합격이 아니다.

## 선택 별과 다음 티켓 연결

```ts
type SceneControl = {
  getCamera(): GalaxyCamera | null;
  setCamera(patch: Partial<GalaxyCamera>, options?: { level?: number }): void;
  fitAll(): void;
  setSystem(system: OwnedSystem | null): void;
};
```

- 205는 같은 `cameraMatrix`/`screenPoint`/가시 후보로 입력·히트 테스트를 연결한다. x/y는 회전된 화면 평면상의 월드 팬 값이다. API 저장 x/y를 그대로 팬에 넣지 말고 같은 투영에서 중심을 계산한다. level 생략 시 메타 scale에서 고른다. 옛 `overview/scale/rotation` 입력은 삭제했고 `zoom/yaw`를 사용한다.
- `store.select(ticId)`는 ID를 유지한다. 206은 `readOwnedSystem(raw,meta,ticId,loadedStar)` 후 `setSystem`에 전달한다. 권한·최신 판단은 서버 책임이다.
- 같은 version/presentationVersion/선택 ID가 아니면 상세를 즉시 그리지 않는다. 타일과 상세 위치·순번·개수 불일치도 오류다. 204 PersonalGalaxyScene이 실제 선택 상세 HTTP 조회·취소·수동 재조회까지 연결한다. 206은 이 선택 수명주기를 재사용해 정보·카메라 전환을 붙이며 중복 요청 주체를 만들지 않는다.
- 유효한 선택 별 하나의 `planets.items` 전부를 candidateId 순서로 그린다. 4개 상한·외부 카탈로그 보충이 없다. 0개이면 별만 남는다.
- 행성 표면·공전은 연출이며 수치/ID는 보존한다. `periodDays=null`을0으로 바꾸지 않는다. 206 확대 대상과 정보는 같은 candidateId로 연결한다.
- 선택 전 카메라를 보관해 `setCamera`로 복구한다. 이번 개발 버튼은 인터페이스 검증이며206 화면 전체를 대신하지 않는다.
- 숨긴 탭은 RAF를 멈추고 복귀 첫 프레임 시간 차를 초기화한다. 모션 줄이기는 공전을 멈춘다. context loss는 안내 뒤 자원을 다시 만들고 장면을 복원한다. WebGL 미지원 목록 대체는207이다.

## 이전 비교 보존

`/dev/galaxy-comparison`은 [과거 판단 기록](galaxy-comparison.md)이다. 당시 모델·좌표·군집 렌더러를 `dev/legacy-galaxy`로 격리했고 현재 `src`에서 import하지 않는다. 옛 API도 `/api/dev-legacy-galaxy-204/...`로 격리했다. 이 코드의 군집/상한은 현행 계약이 아니다. serve+galaxy에만 제공하고 운영 번들/엔드포인트 검사로 제외한다.

## 2026-09-17 실제 연결 보완

GalaxyPage의 PersonalGalaxyScene이 /v1/me/stars/{ticId}를 조회하고 readOwnedSystem으로 검증한 뒤 personalSystem prop을 전달한다. 순수 GalaxyScene의 SceneControl.setSystem은 개발/후속 통합용으로 유지한다. 어느 방식이든 선택·버전·표현 버전이 맞는 별 하나만 표시한다.

exposure.ts는 많은 별을 멀리서 볼 때의 광량을 낮추고 줌1~6에서 부드럽게1로 회복한다. 1,000개 이하는1을 유지한다. 총수는 meta.starCount를 사용해 페이지 도착마다 밝기가 튀지 않게 한다. 좌표·색·개수는 변하지 않는다. 렌더러 setCamera의 zoom/starCount 인자가 이 정책에 연결된다.

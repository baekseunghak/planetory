# 별지도 데이터 어댑터 연결 계약

2026-09-18 / 215: 같은 level·타일 집합 내 카메라 이동은 진행 중 페이지 요청을 보존한다. 완료 타일 집합 최대4개의 배열/객체를 재사용하고 버전 교체·dispose 때 비운다. 오류·버전·페이지 검증 규칙은 유지한다. [성능 구조·측정](performance-215.md).

2026-09-15 · `S15P21C206-203` / W05. [MR !41의 7f67c568 계약](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/7f67c5683f79e541da556ef4e6aed966ff317c11/docs/development/sky-presentation-contract.md), SRS v1.3·탐사 API Draft 0.4에 맞춘 선행 구현이다. 사용자가 문서 승인은 내일 받고 개발을 먼저 진행하도록 요청했다. 팀 승인·실제 API 인수를 뜻하지 않는다.

## 렌더러 연결

```tsx
<SkyDataPage renderScene={(props) => <GalaxyScene {...props} />} />
```

204의 `GalaxyScene`은 첫 카메라와 캔버스 크기가 정해지면 `store.setView({level,box})`를 호출한다. `SkyDataPage`가 임의의 전체 영역 요청을 함께 보내지 않는다. 카메라 입력 전에는 메타만 준비되며, 최대 축소도 가시 bbox의 개별 별 페이지를 요청한다. `overview` 우회 경로가 없다.

| 입력·함수                                  | 의미                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `data.meta`                                | representation·배치/표현 버전·전체 starCount·bounds·tileSize·zoomLevels·firstVisit·선택적 asOf |
| `data.stars`, `data.loadedCount`           | 현재 가시 타일에 적재된 개별 별과 그 수. 전체 발견 수나 실제 화면 내 가시 수가 아니다          |
| `store.setView({level,box})`               | 같은 입력은 유지하고, 변경된 가시 범위/단계를 요청한다. box=null은 가시 영역 없음              |
| `data.pageProgress`                        | 진행 중/실패한 범위의 적재 수·기대 수·받은 페이지 수. 완결된 범위는 여기서 제거된다            |
| `data.pending/failures/error/needsRefresh` | 페이지 진행·부분 실패·계약/메타 오류·최신성 재확인 상태                                        |
| `store.select(ticId)`                      | ID만 보존한다. 미적재는 삭제·미발견·권한 거절을 뜻하지 않는다                                  |
| `store.retry()/refresh()`                  | 실패 페이지 이어받기 또는 메타 갱신. 카메라와 선택을 초기화하지 않는다                         |

군집 `clusters/overview/clustered`, 타일 `colorLevel/sizeLevel/orbits`를 소비하지 않는다. 구 응답·필수 필드 누락·미지원 버전은 오류로 처리한다. 배율 단계는 메타의 연속된 1개 이상을 사용한다. `layoutOrdinal`은 저장한 회원별 안정 순번이며 현재 적재 순서로 생성하지 않는다. 상태·행성 수로 색/크기를 결정하지 않는다.

## 카메라와 조회 범위

`galaxyMatrix(camera,width,height)`는 원본 시제품의 yaw·tilt·roll·팬·줌 투영을 제공한다. 입력은 `{x,y,zoom,yaw,tilt,roll}`이다. 기본 카메라와 비교 벡터는 [고정 참조](../dev/sky-reference/README.md)를 따른다. 카메라 x/y는 회전 후 투영 평면의 이동량이다.

```ts
const matrix = galaxyMatrix(camera, canvasWidth, canvasHeight);
const box = viewportBounds(matrix);
await store.setView({ level: levelForScale(data.meta, camera.zoom), box });
const visibleCount = visibleStarCount(data.stars, matrix);
```

행렬의 입력 z는 API의 정규화 `depthZ`다. 행렬 안에서 정확히 한 번 `depthZ×256`을 적용하므로 렌더러가 입력에 다시 256을 곱하면 안 된다. 204는 같은 행렬을 셰이더·CPU 투영·히트 테스트에 사용한다. 반환 행렬의 clip z는 정규화 깊이를 보존하며, 물리적인 거리/원근 모델을 새로 정의하지 않는다.

`viewportBounds`는 화면 각 변의 폭/높이 20% 여백(전체 1.4배)과 깊이 -1~1 전체를 역투영한다. 기존 `orthographicMatrix`는 디버그 검사 화면용이며 최종 은하의 투영 비교 기준은 `galaxyMatrix`다. 실제 가시 수는 행렬로 별을 화면 투영한 뒤 계산한다. 프레임마다 전체 계정을 순회하는 방식으로 연결하지 않는다.

타일 경계는 `[min,max)`이며 음수는 floor를 사용한다. 한 점짜리 메타 경계도 해당 셀을 포함한다. 화면 밖 범위는 요청하지 않는다. 너무 큰 격자(65,536셀 초과)는 확대 안내 오류로 중단하며, 이 방어값을 별 개수 제한이나 최종 성능 보증으로 해석하지 않는다.

## 페이지·캐시·복구

- `GET /api/v1/me/sky/tiles`에 level·x/y/w/h·version·limit, 이어받을 때 cursor를 전송한다. limit 기본 1000, 1~2000 정수이며 화면 별 수 상한이 아니다. w/h 각각 tileSize×64 이하로 나눈다. keys/타일 ID 목록을 보내지 않는다.
- 네트워크 묶음은 최대 8×8셀, 동시 범위 요청은 4개다. 같은 범위 페이지는 순서대로 받는다. 다음 요청에서 회원·version·level·원 bbox·limit를 유지하고 불투명 cursor를 그대로 인코딩한다.
- 완료 셀은 회원·version·level·격자 셀로 캐시한다. 부분 범위는 회원·version·level·bbox·limit와 마지막 cursor/검증된 페이지로 격리한다. 같은 TIC를 여러 배율/범위에서 받으면 같은 자료인지 확인하고 하나로 표시한다.
- 페이지의 bounds/rangeStarCount 고정, 숫자값 기준 TIC 오름차순, 중복 순번/ID·좌표 범위·페이지 크기·전체 수를 검증한다. nextCursor=null이고 누적 고유 수=rangeStarCount일 때만 완료 셀로 이동한다.
- 통신 실패는 검증된 이전 페이지와 정상 셀을 보존한다. 사용자가 재시도하면 실패한 페이지부터 이어받는다. 잘못된 cursor 400 또는 계약 오류는 자동 반복하지 않으며 수동 재시도 때 그 범위를 첫 페이지부터 재검증한다.
- 이동/배율/버전 변경은 요청 세대로 늦은 응답을 차단한다. 버전 변경은 옛 cursor를 버리고 메타 및 현재 범위를 처음부터 받는다. 한 번 자동 갱신한 뒤 다시 버전이 바뀌면 명시적 재시도로 전환한다.
- 캐시 기본 예산은 완료 1,024셀이다. 현재 가시 셀은 고정하며 화면 밖 오래된 셀부터 제거한다. 중단된 부분 범위는 다음 가시 요청과 정확히 일치할 때만 이어받는다. 완료 셀마다 자기 별만 저장한다.

새 메타 조회 중 실패하면 이전 한 버전의 자료에 최신성 확인 안내를 표시한다. 새 버전 확정 때 옛 캐시를 비우며 섞지 않는다. 불투명 version 문자열을 숫자/문자순으로 정렬하지 않는다. 제공된 서버 asOf의 역행과 이미 폐기한 버전은 거절한다.

## 선택 상세·변경 이벤트·회원 경계

`readPersonalDetailProjection(response,meta,ticId,loadedStar?)`는 W07이 공유할 최소 지도/행성 필드를 검증한다. 같은 version·presentationVersion·layoutVersion, 저장 좌표/순번과 지도 planetCount 일치, candidateId 문자열 정렬·중복 없음·count=items.length를 확인한다. 0/1/2/5개와 null 수치를 보존한다. 다른 버전은 `SkyContractError`다. **W07의 실제 HTTP 상세 조회·메타/타일/상세 재조회·전체 상세 화면은 206에서 연결한다.** 이 함수로 206 완료를 주장하지 않는다.

분석 제출·공개·재개 담당자는 성공한 실제 응답의 `skyVersion/asOf`로 기존 `publishSkyChange(memberId,event)`를 호출한다. 지도는 같은 회원의 변경만 수신한다. 상대 분석 화면이나 새 서버 쓰기 기능을 만들지 않는다.

로그아웃/unmount는 요청·캐시·선택을 제거한다. `useSkyData`는 현재 회원 ID와 일치하는 저장소만 반환하므로 effect 정리 전에 다른 회원의 스냅샷을 노출하지 않는다. 401은 공통 인증 흐름이 처리한다. 개인 좌표/진행을 localStorage에 저장하지 않는다.

## 검증 모드

`npm run dev:sky-data`는 고정 회원과 가상 별 2,501개의 실제 HTTP 페이지를 제공한다. 배치 예제는 참조 코드의 서버 역할이며 운영 클라이언트에서 좌표를 생성하지 않는다. SVG 화면은 데이터 검사용이다. 최종 3D 모습·조작·전체 성능은 204/205/215에서 인수한다.

개발 경로는 중간 페이지 실패·복구·새 버전·테스트 초기화를 제공한다. 일반 실행/preview/운영 빌드에는 가상 API·계정·검사 화면이 없다. 실제 서버는 기존 `API_PROXY_TARGET`/`VITE_API_BASE`로 연결한다. 패키지·프레임워크 버전은 변경하지 않는다.

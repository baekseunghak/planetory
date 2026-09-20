# 215 별지도 성능 측정과 개선

2026-09-18. 대표 Jira: S15P21C206-215. `origin/develop` e344c207에서 시작했고 같은 날 develop 75463e0과 인프라 후속 6d6c3e9를 통합했다. 214 프로필은 215의 선행 조건이 아니며, 후속 통합에는 develop에 이미 병합된 분석·프로필 구현이 포함된다. [항목별 상태](ticket-215-readiness.md), [표현 계약](../../../docs/development/sky-presentation-contract.md), [렌더 구조](galaxy-renderer.md)를 함께 본다.

2026-09-20 후속은 MR !87 병합 후 최신 develop `d252e5ef`에서 시작했다. `fix/S15P21C206-215-web-camera-cost`에서 확대 이동의 반복 준비 비용을 줄인다. 아래 이전 날짜의 실행 기록은 새 검증 결과로 대체하지 않고 보존한다.

## 바뀐 구현

- `SkyDataStore`: 같은 타일 범위 안의 카메라 이동은 진행 중 페이지 요청을 취소하지 않는다. 완료된 타일 집합 4개까지 배열과 별 객체를 재사용한다. 다른 버전·회원의 자료는 섞지 않으며 기존 응답 검증 후에만 객체를 재사용한다. 버전 교체와 dispose는 해당 캐시를 비운다.
- `renderPlan`: 불변 별 배열의 월드 경계와 순서를 보존하는 경계 트리를 재사용한다. 전체가 가시 영역에 있으면 원본 배열을 그대로 사용한다. 부분 화면에서는 완전히 안/밖인 하위 영역을 한 번에 판정하고 경계 영역의 별만 정확히 투영한다. 원본 배열의 연속 구간을 함께 반환하며 기존 80px 발광 여백·깊이·별 순서를 유지한다. Perspective 행렬은 기존 정확한 개별 투영 경로를 사용한다.
- `GalaxyRenderer`: 불변 원본 배열별 float32 속성을 한 번 준비해 보관하고, 화면 이동 때 가시 구간만 typed-array로 복사한다. 매번 별의 문자열 ID를 Set에 넣거나 색·크기를 개별 대입하지 않는다. 선택 강조는 복사본에만 반영한다. 장면이 동일하면 재패킹하지 않는다. 바뀐 버퍼 구간은 양 끝에서 찾고 단일 `bufferSubData`로 반영한다. GPU 버퍼 객체는 기존 4개를 유지한다. WeakMap 캐시이므로 store와 장면에서 사라진 원본 배열의 수명을 연장하지 않는다.
- 같은 두 삼각형을 네 꼭짓점의 triangle strip으로 그려 각 인스턴스의 중복 정점 2개를 제거한다. 발광/표면 셰이더 수식과 삼각형 경계는 같다.
- 정지한 별 배경은 캔버스와 동일한 실제 픽셀 크기의 RGBA8 renderbuffer에 보관한다. 다음 프레임은 `blitFramebuffer(..., NEAREST)`로 픽셀을 그대로 복사하고 행성/궤도만 다시 그린다. 카메라·DPR/크기·별 자료·선택·광량·행성 확대 전환이 바뀌면 배경을 재생성한다. 캐시 할당이 불가능하면 기존 직접 그리기를 사용한다. context 복구 때 재생성하고 dispose 때 해제한다.
- `gpuBuffers=4`는 정점 데이터용 WebGLBuffer 개수다. 배경용 framebuffer/renderbuffer 각 1개는 별도이며 `backgroundBytes=width×height×4`로 픽셀 메모리를 보고한다. `backgroundBlits`는 복사 횟수, `bodyDrawCalls`는 실제 해당 프레임의 별 그리기 횟수(재사용 시 0), `bodyDrawCallsTotal`은 누적 횟수다. 프레임 측정에는 복사와 행성 그리기도 포함한다. draw call이 줄었다는 사실만으로 성능 합격을 선언하지 않는다.
- `ProjectedStarIndex`: 불변 별 배열별 월드 쿼드트리를 재사용한다. 포인터 주변 노드만 화면에 투영한다. 튜토리얼·챌린지 마커는 해당 ID만 찾으며, 전체 키보드 후보 목록은 대괄호 탐색이 필요할 때 만든다. 행성은 기존 작은 화면 격자를 사용한다. 현재 affine 카메라에 최적화했으며, 다른 투영을 도입하면 별도 성능 검증이 필요하다.

별 좌표·색·크기·노출·공전 수·카메라 조작 규칙은 변경하지 않았다. 군집, 임의 배경별, 표시 개수 상한, 행성 4개 상한을 추가하지 않았다. 공간 인덱스는 클릭 후보 검색과 가시 영역 판정용이며 서버 데이터/성과 개수를 합치지 않는다.

## 재현 방법

Node 22.12 이상과 lockfile 의존성을 준비한 뒤 프론트 디렉터리에서 실행한다. 다른 성능 측정이나 브라우저 테스트와 동시에 실행하지 않는다.

```powershell
npm ci
npm run dev:performance
```

별도 터미널:

```powershell
npm run measure:performance -- run-01 chrome 100000 1440 1
npm run measure:performance -- run-02 chrome 100000 1440 2
npm run measure:performance -- run-03 msedge 100000 1024 1
npm run measure:performance -- run-04 firefox 100000 1440 1
npm run measure:performance -- run-05 chrome 500 1440 1
npm run measure:performance -- run-06 chrome 1 1440 1
```

추가 GPU 진단은 `node scripts/profile-gpu-scenes.mjs gpu-check chrome 2`로 실행한다. 전체/선택 화면의 정지·키보드 이동 GPU 타이머 결과를 별도 폴더에 보관한다. 인수 프레임 창과 동시에 실행하지 않으며, 확장 미지원(이 PC의 Firefox 포함)은 GPU 시간 미측정이다.

각 명령은 순서대로 실행한다. 결과 폴더가 이미 있으면 덮어쓰지 않고 실패한다. Chrome/Edge는 설치 채널, Firefox는 Playwright `moz-firefox` 채널을 사용한다. 실제 browserVersion과 DPR은 결과에 남긴다. 이 PC의 과거 번들 Firefox 실행 실패와 구분한다.

`127.0.0.1:58360/sky`는 별도 production-compiled 진입점에서 **현재 서비스의 실제 라우터·인증 게이트·지도·퀘스트·별 상세**를 실행한다. HTTP 응답만 로컬 합성 서버다. 정상 제품 진입점에는 측정 프로브·가상 API·초기화 도구를 넣지 않는다. 개인 계정·실제 DB·Docker는 사용하지 않는다.

측정 명령의 종료0은 자료 수집/기능 assertion이 끝났다는 의미다. 성능 합격 여부는 `eligible`과 `framePass`, 힙 값으로 따로 판정한다. `zoom-loading`은 첫 휠 반복 구간의 이름이며 네트워크 대기를 뜻하지 않는다. `pendingFrames`로 실제 추가 적재를 판별하고 확대 드래그는 같은 위치로 복귀해 적재 후 `near-drag-warm`을 재측정한다.

## 자료와 측정 창

- 저장 좌표 예시 생성기는 합의된 `personal-spiral-v1`이다. 1 / 500 / 100000개를 사용한다. 100000개 자료는 행성 항목 총5000개이며 별별 0, 1, 5, 32(이 자료의 최대)개를 상세 화면에서 검증한다. `manifest`에 데이터 SHA-256과 표현 버전을 기록한다.
- 하나의 배열을 직접 renderer에 주입하지 않는다. C05 형식의 메타·bbox·level·version·cursor·페이지 HTTP 응답을 실제 store가 검증하고 적재한다. 요청별 개수/다음 cursor와 Resource Timing을 보관한다.
- 최초 별 표시와 전체 적재 완료 시간을 분리한다. 최초 표시 시간은 첫 실제 draw 다음 RAF의 근삿값이며 GPU presentation fence 측정은 아니다. 페이지 대기/오류가 끝난 뒤 5초 RAF 간격을 수집한다.
- 전체 보기, 최대 축소, 키보드 이동/회전, 마우스 드래그, hover, 휠 확대/축소, 선택 별의 0/1/5/32개 공전, 확대 상태 이동을 실행한다. 전체 지도에서 행성·궤도는0이다.
- 별 선택 비교는 각각 상세 URL로 새 페이지에 진입한다. 실제 상세 화면/HTTP 검증이며 클릭 기능 회귀는 별도 Playwright 검사로 확인한다. 힙 최고치는 이 페이지 전환과 적재를 포함하며 강제 GC를 하지 않는다.
- p95는 nearest-rank, worst는 관측 최댓값이다. 허용 기준은16.7ms/33ms/힙300MB이고 반올림으로 통과시키지 않는다. pending frame 또는 숨긴 문서가 있으면 해당 창은 인수 판정에서 제외한다. 첫 표시2초는 별도 목표다.
- CPU draw 제출·장면 패킹·포인터 후보 수, 실제 draw/버퍼/전송 누적 수, DOM 수, Chromium CDP JS heap을 기록한다. Firefox의 JS heap은 미측정으로 표기한다. GPU timer query와 CPU profile은 프레임 인수 창 **밖에서** 별도로 수집한다. GPU 확장 미지원/disjoint는 측정 성공으로 보지 않는다. GPU 시간만으로 fill-rate 원인을 확정하지 않는다.

## 측정 환경과 증거

Windows 11 Enterprise build26200, Core Ultra7 155H(16코어/22스레드), RAM 약31.5GiB. Intel Arc 드라이버32.0.101.8424와 RTX4050이 설치돼 있지만 실제 측정 renderer는 Intel Arc/ANGLE D3D11이었다. 배율은 테스트 context의 DPR이며 canvas 실제 픽셀 크기도 기록한다. 다른 기기·배포 환경의 보장은 아니다.

`performance-results/`에 raw/summary JSON, 화면 캡처, CPU profile을 보존한다. `benchmark-dist/`와 전체 원시 결과는 Git에서 제외한다. 커밋되는 [요약 증거](performance-215-evidence.json)는 각 원시 결과의 해시, 브라우저, 데이터/번들 해시와 판정 수치를 담는다. 실패한 이전 실행도 기록에서 제거하지 않는다.

## 결과와 남은 조건

결과 요약 재생성: `node scripts/summarize-performance.mjs`. 실제 실행 폴더의 raw/summary를 읽어 해시와 수치를 기록한다. 원시 결과를 지우거나 실패한 실행을 성공한 실행으로 덮어쓰지 않는다.

최종 실행 결과는 [215 인수 기록](ticket-215-readiness.md)에 기재한다. 최초 baseline과 최종 실행의 시나리오가 추가된 경우 같은 시나리오끼리만 비교한다. 9월15일 renderer 단독 측정을 최신 서비스 전체 통과 증거로 재사용하지 않는다.

현재 티켓은 성능 기준을 만족하기 전까지 완료하지 않는다. 실제 백엔드 C05와 I13 배포 환경을 붙인 최종 인수는 `S15P21C206-216`에서 이어받되, 로컬 성능 미달을 그 티켓으로 떠넘기지 않는다. Safari는 이 Windows PC에서 확인할 수 없으며 실제 macOS/Safari 검증이 남는다.

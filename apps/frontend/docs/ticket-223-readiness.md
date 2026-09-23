# 223 별 검색·필터·위치 이동

최초 구현 기준: 2026-09-21 develop `c711da9`, [탐사 API 4.1·4.4](../../backend/docs/exploration-api-spec.md). 최초 기록의 서버 미제공 판정은 당시 상태이며 현재 서버 상태를 뜻하지 않는다. 프론트와 serve 전용 합성 HTTP fixture를 작성했다. **현재 A13 연결·검증 결과는 아래 2026-09-22 기록을 따른다.**

## 구현

- [x] 은하 위 접을 수 있는 내 별 찾기. TIC·진행 단계·등급 조합, 입력 검증, 검색/초기화, 불투명 cursor 페이지, 빈/로딩/오류/재시도.
- [x] 지도는 `GET /api/v1/me/stars?scope=discovered&sort=recent&size=20`에 필요한 `ticId/stage/grade/cursor`만 보낸다. 확정 행성 여부 필터나 미발견 별 카탈로그를 추가하지 않는다.
- [x] 선택은 `GET /api/v1/me/sky/locate?ticId=...`의 좌표·depthZ·level·bounds·version·layoutVersion·layoutOrdinal을 검사한다. 월드 좌표를 생성하지 않는다. 서버 level의 scale로 카메라를 움직이고 bounds를 타일 조회에 전달한다. bounds는 타일 계약과 같은 좌·상단 포함/우·하단 제외 반개구간으로 검사한다.
- [x] 검색 조건은 URL의 filterTic/filterStage/filterGrade에 보존한다. 상세 닫기·분석 복귀 경로에 같은 조건을 유지한다. 다른 조건·판·회원으로 바뀌면 늦은 결과/위치 응답을 폐기한다.
- [x] 검색을 열기 전 추가 목록 요청 없음. P0 지도·대체 목록 흐름을 유지한다. 403 locate는 별을 선택하거나 상세를 보여주지 않는다.
- [x] `ProfileStarFilters`와 `ProfileSlotProps.starFilters`로 A13 내 별 목록의 공용 필터 입력을 제공한다. 타인에게는 이 필터를 적용하지 않으며 기존 PRIVATE 차단을 유지한다.

## A13 연결 계약

`App.profileSections.stars` 소비자는 기존 memberId/isOwn/starListVisibility와 함께 선택적 `starFilters`를 받는다. 본인 목록은 `starSearchPath(starFilters ?? emptyStarFilters, cursor, "submitted")`를 호출한다. 필터 변경 때 cursor를 초기화하고 기존 요청을 중단한다. 지도는 discovered, 마이페이지는 submitted를 유지한다. 별 선택 후 복귀 URL에 현재 검색을 보존한다.

최초 기록에는 A13 stars 슬롯 미등록으로 적혀 있었으나, 2026-09-22 확인한 `main.tsx`에는 `MyStarsSection`과 `MyHistorySection`이 등록돼 있다. 기존 A13 화면을 재구현하지 않고 `MyStarsSection`이 전달된 필터를 실제 HTTP 요청에 사용하도록 보완했다. 아래 Chrome 검사는 이 실제 소비자와 기존 분석·History 복귀 링크를 조작한다.

## 검증 및 남은 것

- [x] 신규 단위: TIC 정규화·scope·cursor·URL 보존, locate의 ID/판/좌표/깊이/경계 거부. 우·하단 끝점이 locate에서만 승인되지 않도록 회귀를 고정했다. 기존 포함 단위342개는 최초 구현 당시 기록이다.
- [x] Chrome 별 검색 8개: 필터·서버 배율·상세 복귀, 입력/빈 결과,403, cursor/뒤로가기, 목록 모드, 늦은 locate 폐기, 조회 오류 재시도.
- [x] Chrome 기존 프로필8개·별 상세9개·대체 목록11개 통과. 타입·렌더러 운영 빌드·개발 fixture 제외 통과. 대체 목록 URL 검사는 검색 조건 보존에 따른 query 순서 변화와 무관하게 선택 TIC와 list 모드를 확인하도록 바꿨다.
- [x] A13 실제 소비자의 필터 요청·결과와 분석/History 왕복을 로컬 HTTP fixture로 검증했다. 준비된 입력 슬롯이나 지도 검사만으로 체크하지 않는다. 상세는 2026-09-22 기록을 따른다.
- [ ] 실제 C17 API와 동일 자료로 지도/목록/locate 의미 대조, 두 계정·배포 인수는244 P1-223.
- [ ] 이번 A13 연결·취소 보완의 리뷰·반영·증거 등록 후 Jira 완료 전환. 사용자가 확인한 기존 223 병합과 이번 미커밋 보완을 구분한다.

`npm run dev:star-search` → `http://127.0.0.1:58384/sky`. `npm run test:star-search`는 Chrome·58385를 사용한다. 합성 별은 개발 서버에서만 공급한다.

248 디자인 변경을 이 독립 브랜치에 중복 포함하지 않았다. 이번 변경은 시제품의 은하 표시 자체를 다시 작성하지 않으며 시각 일치 최종 검토는248 병합 후 함께 확인한다.

## 2026-09-21 선행 기능 통합

당시 develop(af29c8e)와219→220→221→222를 병합했다.248 배치와 검색의 충돌을 해결하면서 카메라 선택의 scrollIntoView 재도입을 피하고, 검색 패널이 제목/목록 전환 버튼을 가리지 않게 배치했다. Chrome 검색8개 중7개 통과 후 겹침으로 실패한 목록 전환1개를 수정해 재검증 통과했다. 당시 남았던 A13 연결은 아래 보완으로 검증했다. 백엔드 인계 문서는 P1 계약6절을 따른다.

## 2026-09-22 A13 연결·검증 종료

상태: **이번 로컬 보완의 구현·담당 프론트 검증 완료, 추가 변경 반영 대기**. 기존 223 병합을 되돌리지 않는다. 실제 C17·두 계정·배포 인수는 기존 분리대로 244 P1-223에 남기며, 이 검증을 223의 새 선행 조건으로 늘리지 않는다.

이전의 프로필 19개와 지도 검색 8개는 마이페이지에서 검색 조건을 조작하는 검사가 아니었다. 이번에는 [A13 직접 검사](../tests/profiles/own-star-search.spec.ts)를 추가해 실제 `ProfileStarFilters → MyStarsSection → HTTP` 경로를 확인했다.

| 직접 확인한 완료 조건 | 결과 |
| --- | --- |
| TIC·진행·등급 조합, submitted/size=20 요청, 결과와 초기화 | 통과 |
| 빈 검색과 제출 없음 구분, 입력 오류, 잘못된 URL의 무조건 전체 조회 방지 | 통과 |
| 실제 분석 복귀 링크, History 상세 왕복, 새로고침·뒤로가기 시 필터 복원 | 통과 |
| 필터 조회 503 시 이전 결과 제거, 같은 조건으로 재시도 | 통과 |
| 실제 내 별 목록 20+5건 이어 읽기, 503 시 첫 페이지 보존, 같은 cursor 재시도와 필터 변경 시 초기화 | 통과 |
| 지연된 다음 페이지의 AbortSignal 취소와 늦은 결과 격리 | 수정 후 통과 |
| 본인에서 타인 프로필로 전환할 때 필터 미전달, 비공개 목록 요청·표시 차단 | 통과 |

지연 요청 검사는 `usePagedList.more()`가 새 AbortController를 현재 요청에 등록하지 않아 조건 변경 시 전송 취소가 누락되는 것을 재현했다. 현재 요청으로 등록하도록 수정했다. 기존의 세대 번호를 통한 늦은 응답 무시는 유지한다. 첫 실행의 다른 실패 1개는 select를 찾는 테스트 selector 문제였으며, 제품 UI 변경 없이 combobox 접근성 이름을 사용해 바로잡았다.

검사는 기존 7건 fixture와 테스트 내부 전용 25건 합성 응답을 사용한다. 다른 담당자의 fixture·분석 로직·실제 DB·운영 데이터는 변경하지 않는다. 분석 화면에서는 진입과 실제 복귀 링크를 검사했으며 분석 계산·채점을 검증했다고 해석하지 않는다.

### 실행 결과와 재현

`apps/frontend`에서 실행했다. 각 명령의 종료 코드가 0임을 확인했다.

```powershell
npx --no-install playwright test --config=playwright.profiles.config.ts --project=chrome --reporter=list
# 기존 19개 + A13 직접 검사 7개 = 26개 통과
npm run test:star-search
# Chrome 지도 검색 8개 통과
npm test
# 단위 테스트 384개 통과, 실패/건너뜀 0
npm run build
# TypeScript, production build, 개발용 fixture·계정 기능 제외 검사 통과
git diff --check
# 통과
```

로컬 실행 로그: `test-results/223-closeout-profiles.log`, `223-closeout-sky.log`, `223-closeout-unit.log`, `223-closeout-build.log`. 생성 로그는 Git에 추가하지 않았다. 빌드에는 기존 Vite 설정의 확장자 경고와 500kB 이상 번들 경고가 남지만 오류로 종료되지 않았으며 이번 검색 연결의 실패 근거로 분류하지 않는다.

**종료 판단:** 이번에 지적한 A13 연결·검증 공백은 해소했다. 이를 다시 미검증으로 남기거나 끝없는 추가 테스트의 이유로 삼지 않는다. 이번 미커밋 수정의 리뷰·반영과 결과 등록이 끝나면 223 기능 티켓을 완료 처리할 수 있으며, 244 통합 인수는 별도다. 커밋·푸시·MR·Jira 변경은 이 작업에서 실행하지 않았다.

## 2026-09-22 최신 develop 기준 후속 반영

기존 MR !147은 `3bdf7a93`으로 develop에 병합돼 있다. 기존 MR을 다시 병합하거나 되돌리지 않고, 그 뒤 확인한 동일 티켓의 A13 연결·요청 취소 누락만 후속 수정으로 반영한다. 새 기능 범위를 추가하지 않는다.

- 기준: 원격을 새로 조회한 develop `e7b578fd`.
- 후속 브랜치: `fix/S15P21C206-223-web-own-star-search`, 대상은 `develop`.
- 원본 작업 폴더는 보존하고 별도 worktree에 7개 파일의 보완만 옮겼다. README의 다른 담당자 변경은 유지했다.
- 후속 브랜치 재검증: Chrome 프로필 26개(기존 19개와 A13 직접 검사 7개), 지도 검색 8개, 단위 405개가 모두 통과했다. 단위 개수는 최신 develop의 추가 검사를 포함한 결과이며 앞선 384개 기록을 소급 변경하지 않는다.
- TypeScript·production build·개발용 fixture 제외 검사와 `git diff --check`가 통과했다.
- 로컬 원시 로그는 작업 공간의 `output/ticket-workflow/223-followup-20260922/`에 보존하고 커밋하지 않는다. 재현 명령과 검증 범위는 위와 같다.

비작성자 1명 이상의 신규 변경 승인과 해당 MR의 병합 조건을 확인한 뒤 반영한다. 과거 MR의 승인이나 로컬 테스트 통과를 이번 후속 MR의 승인으로 대체하지 않는다. 실제 C17·두 계정·배포 인수는 기존의 244 P1-223 범위를 유지한다.

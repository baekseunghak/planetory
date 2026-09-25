# 268 내 행성 NASA 자료·설명 패널 연결

- Jira: `S15P21C206-268`
- 상태: 프론트 구현 및 합성 HTTP 브라우저 검증 완료. 실제 회원·Gold·NASA·모델·서비스 DB를 잇는 배포 인수는 별도로 확인해야 한다.
- 계약: [탐사 API 명세](../../backend/docs/exploration-api-spec.md)의 회원별 별 단위 설명 경로와 [267 설명 계약](../../../docs/development/nasa-planet-explanation-267.md)을 따른다. 268에서는 저장 상태 조회와 생성 요청을 분리한다.

## 화면에서 이용하는 방법

`/sky`에서 본인이 발견한 별을 열고 **내가 찾은 행성** 중 확정 행성을 선택한다. 기존 행성 정보의 `반복 주기`와 `어두워진 정도` 아래에 **NASA 행성 자료 보기** 버튼이 나타난다. 이 버튼은 저장 상태만 읽는다. NASA에 등록된 같은 항성의 모든 행성을 보여주거나 내 행성 목록·성과 수를 바꾸지 않는다. 미확정 후보를 선택하면 NASA 확정 행성 설명의 비대상임을 안내한다.

처음 자료가 없으면 **NASA 자료 요청**, NASA 수치는 있고 쉬운 설명만 없으면 **쉬운 설명 요청**을 누른다. 두 버튼만 후보 ID를 담은 `POST /api/v1/me/stars/{ticId}/planet-explanations`를 보낸다. 첫 버튼을 누른 시점에 서버 설정에 따라 NASA 외부 조회가 발생할 수 있고, 설명이 활성화되고 호출 한도가 주입돼 있으면 모델 호출이 발생할 수 있다. 공통 API 클라이언트가 인증 쿠키와 CSRF 헤더를 붙인다. 이 POST에만 30초 대기 제한을 사용하며 다른 API의 기본 15초 제한은 유지한다.

정상 NASA 자료는 행성 이름, 공전 주기·반지름·질량, 발견 방법·연도, 논쟁 표시가 있을 때 그 주의 문구, [NASA Exoplanet Archive](https://exoplanetarchive.ipac.caltech.edu/) 출처와 마지막 정상 조회 시각을 보여준다. 수치 문자열은 서버가 준 자릿수를 유지한다. `limit=-1`은 미만, `1`은 초과, `0`은 기록된 수치, `null`은 한계 표기 없이 기록된 값으로 읽는다. 값이 없으면 정보 없음으로 표시한다. 쉬운 설명이 준비되면 같은 후보의 이름→공전 주기→반지름→질량→발견 순서 다섯 문장과 생성 시각을 별도 구역에 표시한다. 모델 설명이 실패하거나 비활성이어도 정상 NASA 수치는 계속 보인다. 앞의 `반복 주기`·`어두워진 정도`는 기존 탐사 자료이며 NASA 수치와 섞어 표기하지 않는다.

| 조회 결과 | 화면 안내·다음 행동 |
| --- | --- |
| `not_requested` | NASA 원천이 없으면 **NASA 자료 요청**, 원천이 있으면 **쉬운 설명 요청** |
| `pending`·원천 `refreshing` | 준비 중을 표시하고 열린 패널에서 3초 뒤 저장 상태를 다시 GET으로 확인 |
| `ready` | 검증된 NASA 수치와 쉬운 설명을 함께 표시 |
| `failed`·`disabled` | NASA 수치가 있으면 유지하고 설명 상태를 별도로 안내. `retryAt` 전이거나 시도가 소진되면 다시 요청 버튼을 숨김 |
| `quota_exceeded` | 다음 허용 시각을 안내하고 반복 버튼을 숨김. 직후 GET이 미요청으로 돌아와도 열린 패널에서는 허용 시각까지 버튼을 숨김 |
| 원천 `not_found` | 현재 NASA 기본 자료에서 찾지 못했음을 안내하며 실제 행성 부재로 단정하지 않음. **NASA 자료 재확인**으로 수동 POST 가능 |
| 원천 `identity_unresolved` | 내부 후보와 NASA 행성 연결을 검토해야 함을 안내. **NASA 자료 재확인**으로 수동 POST 가능 |
| 원천 `temporarily_unavailable` + 재조회 `interrupted`·`busy` 등 | 일시 장애를 안내하고 사용자가 다시 요청 가능 |
| 원천 `temporarily_unavailable` + 재조회 `disabled` | NASA 조회가 운영 설정으로 중지됐음을 안내하고 POST 요청 버튼을 숨김. 상태 GET은 가능 |
| 원천 `not_eligible`·접근 철회 | 기존 자료를 내리고 별 정보 재조회 안내 |

POST 결과가 네트워크 오류나 timeout으로 불명확해지면 같은 POST를 자동 반복하지 않고 GET으로 현재 저장 상태를 확인한다. 준비 중에는 재조회만 수행한다. 사용자가 별이나 행성을 바꾸거나 패널을 닫으면 이전 HTTP 대기를 취소한다. 응답의 `ticId`·지도 `version`·`candidateId`·`kind`가 현재 본인 별 상세와 모두 맞아야 표시한다. 계정 전환은 별 상세 전체를 새 회원 키로 다시 만들고 이전 대기를 취소한다. 서버는 매 요청마다 권한과 대상 자격을 다시 검사한다.

`not_found`·`identity_unresolved` 상태의 수동 재확인은 서버가 저장한 NASA 조회 결과의 보관 기간 중에 같은 상태를 돌려줄 수 있다. 화면에도 이 점을 안내한다.

## 구현·배포 연결

- [설명 패널](../src/features/sky-renderer/PlanetExplanation.tsx)은 본인 별 상세의 확정 행성에만 나타난다. [응답 검사](../src/features/sky-renderer/detail.ts)는 목록의 개수·ID·종류와 고정 NASA 출처 주소를 확인한다. 외부 문헌 HTML은 표시하지 않는다.
- 새 프론트 환경변수나 의존성은 없다. 기존 `/api` 프록시·인증/CSRF 설정을 사용한다. 백엔드가 조회 전용 GET·후보별 POST·`facts`와 상태를 먼저 제공해야 한다. 배포 준비와 비활성·한도 기본값은 [NASA 운영 가이드](../../../docs/operations/nasa-planet-info-runbook.md)를 따른다.
- 270의 항성별 NASA 전체 목록과 271의 결과 페이지 선택 위젯은 이 패널의 범위가 아니다.

## 검증과 남은 인수

저장소 `apps/frontend`에서 타입 검사와 452개 단위 테스트, 배포 빌드·개발용 자료 제외 검사를 통과했다. Chrome의 `tests/detail/detail.spec.ts` 표적 브라우저 6건은 최초 GET→후보별 POST→수치·설명 표시, 설명 실패의 NASA 수치 유지, NASA 자료 부재·식별 보류·일시 장애·운영 중지·자격 철회 구분, POST 응답 유실 후 GET 확인, 호출 한도 뒤 반복 버튼 차단, 별 전환의 늦은 응답 폐기를 확인했다. 별도 개발용 HTTP fixture와 Playwright route가 응답을 공급했으며 실제 NASA·모델·DB가 아니다. 결과 화면과 별도 NASA 전체 목록도 검증하지 않았다.

```powershell
cd apps/frontend
npm ci
npm run typecheck
npm test
npm run build
npx playwright test --config=playwright.detail.config.ts --project=chrome --grep "NASA|late NASA|lost POST|daily limit"
```

Windows 로컬 검증에서는 Playwright가 직접 시작한 Vite 서버가 테스트 완료 후 종료 대기하여, 같은 `interaction` fixture를 58336 포트에서 별도로 실행하고 테스트 설정의 `webServer`만 임시로 생략해 Chrome 표적 사례를 실행했다. 브라우저 사례 결과와 프로세스 종료를 구분해 확인했다. 번들 Chromium은 이 PC에 없어 설치된 Chrome을 사용했다. 운영 인수에서는 본인·타인 계정의 권한 전환, 실제 Gold 연결, V25·V26 마이그레이션, NASA·모델 활성/비활성, 재시작 뒤 pending 회복과 요청 비용·지연을 백엔드와 함께 확인해야 한다.

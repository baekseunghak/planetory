# 분석 API 예제 읽는 법

이 디렉터리는 **백엔드 합의 전인 로컬 API 초안의 합성 fixture**다. 요청·응답 모양과 요구사항별 상태 조합을 검토하기 위한 정적 JSON이며 실행 중인 Mock HTTP 서버나 실제 관측 데이터가 아니다. 계약 설명은 [API 초안](../README.md), 화면 의미와 행동은 [상태 모델](../state-model.md)을 함께 읽는다.

## 상황별 파일

[manifest.json](manifest.json)은 예제 파일 목록·설명·교환 수를 담은 목차다. 파일 번호는 읽기 순서이며 서로 이어지는 하나의 사용자 세션을 뜻하지 않는다.

| 파일 | 살펴볼 상황 |
|---|---|
| [01-session-and-curve.json](01-session-and-curve.json) | 세션의 고정 Bundle, 곡선·주기도·선택 설정. 브라우저 응답에 후보 정답표를 포함하지 않는 경계 |
| [02-result-states.json](02-result-states.json) | 정상 최초 성과, 마지막 확정/FP 오판, UNSURE 판단 보류, 미확정 미게시 탐색 완료, 채점형 판단 분포 |
| [03-retry-and-idempotency.json](03-retry-and-idempotency.json) | 완료 별의 과거 제출 복원, 올바른 새 제출의 최초 성과, 같은 요청 재전송, 이미 인정된 신호의 duplicate |
| [04-unmatched-and-details.json](04-unmatched-and-details.json) | not_matched 이후 제출 단계의 미제거 후보 힌트, 힌트 대상 없음, ambiguous_match |
| [05-residual-failure.json](05-residual-failure.json) | 오판 뒤 잔차 요청, 계산 단계별 응답, 주기도 계산 실패, 같은 문맥의 재시도와 준비 완료 |
| [06-publication-partial-failure.json](06-publication-partial-failure.json) | 공개 검토, 일부 성공, 실패분 재시도, 같은 요청 재전송, duplicate인 새 분석의 선택 공개와 추가 성과 없음, 최신 누적 등급 재조회 |
| [07-public-statistics.json](07-public-statistics.json) | 세 판단 8/4/3 분포, 최신 비공개 기록, 과거 기록의 늦은 공개, 취소 후 이전 공개 선택, 숨김·복원 독립, 제출 시각 동률, 0명 |
| [08-visibility-and-errors.json](08-visibility-and-errors.json) | 본인 공개 취소와 운영 숨김, 숨긴 부모 스레드의 공개 차단, 타인 개인 기록·잠긴 별·만료 Bundle·유효성 오류 |
| [09-special-submissions.json](09-special-submissions.json) | 더 없음 의견, 설정된 튜토리얼 건너뛰기, 탐색 불가능 신호의 재개 대기, 무신호 별 제공 제외 |
| [10-harmonic-and-epoch-tie.json](10-harmonic-and-epoch-tie.json) | 사용자 원본 주기와 고조파 정정 주기의 분리, epoch 동률이면 더 이른 시각 선택, 원본 주기로 duration 계산 |

## JSON의 각 부분

| 항목 | 읽는 법 |
|---|---|
| `schema_version`, `scenario_id`, `description` | 예제 형식 버전·식별자·상황 설명. 서비스의 분석 데이터 버전이나 HTTP 본문 필드가 아님 |
| `source_requirements` | 예제가 참조하는 요구사항 ID. 해당 수용 테스트를 실제 서비스에서 통과했다는 실행 기록이 아님 |
| `setup` | 시나리오 선행조건·합성 기록·독립 사례 여부. 서버 전용 정보를 포함할 수 있으므로 브라우저 응답이나 요청 본문에 합치지 않음 |
| `exchanges` | 이름 붙인 요청·응답 예시의 배열. 배열 전체를 API에 전송하지 않음 |
| `exchanges[].name` | 교환을 찾고 비교하기 위한 예제 이름 |
| `exchanges[].request` | 제안 HTTP 요청의 `method`·`path`·`body`. 실제 요청 본문 예시는 `body`이며 GET 등에는 없을 수 있음 |
| `exchanges[].response` | 제안 HTTP 응답의 `status`·`body`. 합성 기대 응답이며 서버에서 관측한 응답이 아님 |
| `exchanges[].server_event` | 해당 교환 전에 적용된 것으로 가정하는 서버 측 사건의 메타데이터. HTTP 요청·응답 필드나 신규 엔드포인트가 아님 |

특히 07의 `APPEND`·`PATCH`·`WITHDRAW_ALL`은 공개 상태 변화에 따른 집계 예시를 만들기 위한 사건이다. `fixture_record_id`는 비공개 선행 기록까지 가리키는 테스트용 식별자이며 실제 공개 분석 ID가 아니다. 클라이언트가 이 값을 보내 서버 기록을 직접 수정하는 계약으로 읽지 않는다.

## 독립 사례와 내부 순서

각 파일은 별도 합성 상황이다. 여러 파일에서 같은 `mock-*` 식별자가 나와도 파일 사이의 DB 상태나 성과를 이어 붙이지 않는다. `setup`을 먼저 읽고 아래의 내부 순서로 해석한다.

- **01·03·05·06·07:** 배열 순서대로 연결된 흐름을 읽는다. 03은 새 제출과 같은 요청 재전송을 구분하고, 05는 실패한 작업과 재시도 작업을 구분한다. 06은 성공분을 보존한 채 실패분을 재시도한다. 07은 각 교환의 `server_event`를 그 조회 전에 적용하고 이후 교환에도 누적한다.
- **02:** `independent_exchanges=true`이므로 각 결과는 별도 초기 상태다. 앞 결과의 성과를 다음 결과에 누적하지 않는다.
- **04:** `req-not-matched → hint`만 연결된 한 사례다. `req-no-hint`와 `req-ambiguous`는 각각 독립 사례다.
- **08·09:** 독립 오류·경계 사례 모음이다. 앞 교환이 뒤 교환의 선행 행동이라는 뜻이 아니다. 09의 건너뛰기 예시 설정 3과 운영 기본값 0은 구분한다.
- **10:** 독립된 고조파·파생값 예시다.

파일 번호나 배열 순서만으로 자동 HTTP 재생을 구현하지 않는다. 예제에는 전체 로그인·초기 데이터 생성·모든 중간 조회가 포함되어 있지 않다.

## 로컬 검증 실행과 범위

Node가 설치된 환경에서 작업 디렉터리를 `Planetory/docs/api/analysis/examples`로 두고 실행한다.

```powershell
node ../validate-examples.cjs
```

저장소 루트인 `Planetory`에서 실행할 때는 다음 경로를 사용한다.

```powershell
node docs/api/analysis/validate-examples.cjs
```

[검증기](../validate-examples.cjs)는 JSON 구조와 파일·참조 연결, 합성 값의 계산 관계 및 명시된 상태 조합을 검사한다. 통과 결과는 검증기에 작성된 검사 범위에서 **예제의 정합성을 확인했다는 뜻**이다.

실제 후보 매칭·BLS, 인증·접근 권한 집행, DB 트랜잭션·동시성, 브라우저 화면 동작, 잔차 계산 및 성능은 이 fixture 검증으로 확인하지 않는다. 특히 [상태 모델의 Mock 최소기준](../state-model.md#8-담당자-확인-질문과-mock-검증-기준)에 있는 접기 응답 역전·화면 복구 등은 향후 화면 테스트에 연결할 항목이며, 이 JSON 검증기가 해당 UI 동작을 실행했다는 뜻이 아니다.

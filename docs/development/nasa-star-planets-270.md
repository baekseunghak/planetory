# 결과 화면의 NASA 확정 행성 목록·설명 계약 (S15P21C206-270)

- 상태: API·V29 구현과 일회용 PostgreSQL 격리 검증 완료. 실제 회원·Gold, 공유/운영 DB와 배포 화면 인수는 별도다.
- 목적: 본인 답 제출 뒤 결과 화면에서 해당 항성의 NASA 확정 행성을 하나씩 선택해, 각 행성의 검증된 자료와 쉬운 한국어 설명을 본다. 공개 HTTP 형식은 [탐사 API 8.4.1절](../../apps/backend/docs/exploration-api-spec.md#841-결과-화면의-nasa-확정-행성-s15p21c206-270), 적용·장애 대응은 [운영 가이드 10절](../operations/nasa-planet-info-runbook.md#10-결과-화면의-nasa-전체-목록-운영-270)이 담당한다.
- 경계: [266 후보별 NASA 원천](nasa-planet-info-266.md), [267 다섯 설명과 검증](nasa-planet-explanation-267.md), [268 별 상세의 한 후보 요청](nasa-planet-request-268.md)은 유지한다. 270의 NASA 목록은 기존 `GET /me/stars/{ticId}`의 개인 `planets.items`, 지도 공전 수, Gold 후보 분류, 성과·정답을 바꾸지 않는다. 선택 위젯은 271 범위다.

## 1. 권한과 식별

세 요청 모두 세션의 **현재 active 회원**과 서버 DB의 해당 TIC에서 만든 실제 `candidate` 또는 `no_candidate` 답 제출을 확인한다. `skipped` 제출만 있거나 제출이 없으면 목록을 만들거나 보여주지 않고 404 `RESOURCE_NOT_FOUND`다. 경로 TIC는 조회 대상을 가리킬 뿐 권한 증거가 아니며, 클라이언트가 보낸 행성명·후보 ID·공전주기·배열 순서로 NASA 행성을 연결하지 않는다. POST는 세션과 CSRF 검사를 통과한다. 외부 호출을 마친 뒤에도 회원·제출·행성의 현재 자격과 시도 순번을 다시 확인하고, 자격이 사라진 결과는 저장하거나 반환하지 않는다. 인증 실패와 본인 결과 접근 정책은 기존 결과 API를 따른다. 목록 GET은 원천·설명 생성, 상태 변경, 답 공개를 유발하지 않는다.

`TIC 150428135`는 항성 하나이고 `TOI-700 b/c/d/e`는 NASA의 서로 다른 행성이다. 기존 `candidateId`는 내부 곡선 신호이고 NASA 행성 ID가 아니다. 270의 `planetId`는 `np-`와 소문자 SHA-256 64자리로, 서버가 확인한 양의 정수 TIC 문자열·콜론·NASA의 정확한 `pl_name`을 UTF-8로 이어 해시한 값이다. 예를 들어 해시 입력은 `150428135:TOI-700 b`다. 같은 TIC·행성명은 조회 순서나 내부 후보 유무와 관계없이 같은 ID를 갖는다. NASA가 행성명을 정정하면 새 ID가 되며, 옛 ID를 새 행성에 추측으로 재연결하지 않는다. 후보 ID를 꾸며 만들거나 Gold 참조를 임의로 채우지 않는다. 실제 Gold의 `nasa_exoplanet_archive` 목업 참조는 다른 더미 TIC에 복사됐으므로, 이 목록의 NASA 식별이나 후보 연결을 증명하지 않는다.

## 2. 원천 조회와 완전성

원천은 266과 같은 고정 NASA TAP `ps`의 `default_flag=1` 기본 해다. 서버가 확인한 TIC만 고정 ADQL 틀에 넣고, `soltype=Published Confirmed`만 목록의 대상이다. 다만 **동일 `pl_name`의 중복 판정은 반환된 모든 기본 해에서 먼저** 한다. 같은 정확 이름으로 `Published Confirmed` 1행과 비확정 1행이 있어도 확정 행을 임의 선택하지 않고 그 이름을 `identity_unresolved`로 표시한다. 비확정 기본 해만 있는 이름은 목록에서 제외한다. `pscomppars`의 여러 문헌 혼합값으로 빈 측정값을 메우지 않는다. NASA `tic_id`가 요청 TIC와 다르거나 응답 JSON의 숫자 **파싱**·전체 형식이 실패하면 목록 전체를 `invalid_response`로 거절한다. 파싱한 뒤의 행성별 부호·표시값·설명 입력 검증 실패는 그 행성만 `invalid_source`와 목록 `partial`로 둔다. 수치 정규화는 266의 버전 1과 같은 공전주기 days, 반지름 earth_radius, 실제 질량 earth_mass, 부호 있는 오차, `limit=-1/0/1/null`, 문헌·발견 정보, `controversial=true/false/null`을 사용한다. null은 0이나 추정값이 아니다. 외부 HTML은 표시용 일반 문자열로 안전하게 변환하고, 출처 링크는 서버가 고정한 Archive URL만 제공한다.

한 TIC 조회는 **최대 64행**이다. 65번째 행이 있거나 본문 크기 제한·파싱·항성명/TIC 검증이 실패하면 현재 응답을 부분 목록으로 확정하지 않는다. 이전에 성공한 snapshot이 있으면 저장된 행성과 `fetchedAt`을 보존하고 `status=stale`, `refreshStatus=최근 실패`로 알린다. 정상 0행은 `status=empty`, `complete=true`, `planets=[]`인 완전한 빈 목록이다. 이것은 해당 시각의 NASA `ps` 기본 해에서 찾지 못했다는 뜻이며, 영구적인 행성 부재 판정은 아니다. `complete=true`는 **TTL 안의 정상 `ready` 또는 `empty`**일 때만 준다. 첫 조회 전·부분 결과·TTL 만료·최근 재확인 실패에서는 과거 행성을 함께 보여줘도 `false`다. 따라서 `planets`가 비어 있지 않다고 최신 전체 목록이라고 표시하지 않는다.

같은 `pl_name`의 기본 해가 둘 이상이면 어느 행도 임의 선택하지 않고 그 행성의 `sourceStatus=identity_unresolved`로 둔다. 다른 유효 행성은 유지하되 목록 `status=partial`, `complete=false`로 부분 확인임을 드러낸다. 파싱 이후의 개별 행성 원천 검증이나 설명이 실패해도 나머지 항목의 검증된 사실·설명은 유지한다. 성공한 재조회에서 행성이 삭제되거나 이름이 바뀌면 이전 행을 `active=false`로 보존하고 현재 행성만 활성화한다. 과거 행성 설명을 다른 이름에 붙이지 않으며, 65행·큰 본문·JSON 파싱 장애 응답으로 기존 목록을 줄이지 않는다. 정상 목록은 266과 같은 `ready` 7일, 정상 0행·부분 목록은 1일, 일시 장애는 5분 뒤 재확인 정책을 공유한다. 이는 NASA 발행 주기 보장이 아니다.

## 3. 조회·요청·설명

| 메서드·경로 | 처리 |
| --- | --- |
| `GET /api/v1/stars/{ticId}/result/nasa-planets` | 본인 제출 자격을 다시 검사한 뒤 저장된 현재 목록·개별 설명 상태만 반환한다. NASA·모델 호출과 DB 쓰기는 없다 |
| `POST /api/v1/stars/{ticId}/result/nasa-planets` | 자격과 CSRF 검사 후 NASA 목록을 최초 수집하거나 재확인하고, 완전한 결과만 저장한다. 모델을 호출하지 않는다. 저장 재사용·진행 중 임대·간격 내 실패는 추가 NASA 호출 없이 현재 bundle을 반환할 수 있다 |
| `POST /api/v1/stars/{ticId}/result/nasa-planets/{planetId}/explanation` | 현재 검증된 목록의 선택 행성 한 건만 설명을 생성하거나 재사용한다. 다른 행성에 대한 모델 호출은 없다. 없는·현재 목록 밖 ID는 404다 |

세 경로는 같은 별 단위 bundle 형식을 사용해 저장된 **모든 행성의 현재 상태**를 한 응답으로 보낸다. 목록 POST는 항성당 한 번의 NASA 목록 조회를 시작하며 행성마다 다시 조회하지 않고 모델도 생성하지 않는다. UI는 검증된 `facts`를 먼저 사용할 수 있다. 준비 중이나 POST 응답 유실 뒤에는 GET으로 저장 상태를 확인한다. GET 반복은 새 시도권을 예약하지 않는다. 다음 POST는 사용자 행동으로 시작하며 자동 재전송하지 않는다. NASA 클라이언트는 기존 연결·요청 timeout과 프로세스당 동시 제한을 공유하고 외부 호출 동안 DB 트랜잭션을 열어 두지 않는다. 별 단위 DB 임대·증가하는 시도 순번과 조건부 완료 저장으로 중복 조회·만료 임대 복구·늦은 구 응답 덮어쓰기를 제한한다.

설명은 267의 `name/orbitalPeriod/radius/mass/discovery` **다섯 문장**과 사실 검증을 재사용한다. 선택 행성의 현재 원천 `sourceHash`·구조 버전, 모델·프롬프트 버전이 모두 같을 때만 기존 설명을 재사용한다. `fetchedAt`만 새로워지면 재생성하지 않는다. 원천 또는 버전이 바뀌면 구 설명을 노출하지 않고 현재 원천으로 생성한다. 행성별 설명 임대·시도 순번·최대 3회·실패 뒤 기본 1시간을 적용하고, 외부 호출 중 장기 DB 트랜잭션을 열지 않는다. 저장 직전 현재 행성·원천·회원 자격을 다시 검사해 늦은 완료를 버린다. 한 행성의 모델 실패는 정상 `facts`와 다른 행성 설명을 없애지 않는다.

모델 생성은 기본 비활성이다. 활성화 시 기존 `NASA_EXPLANATION_DAILY_PER_MEMBER`와 `NASA_EXPLANATION_DAILY_GLOBAL`의 **공통 V28** 모델 시도권을 사용한다. 둘 다 기본 0이므로 유료 신규 호출은 막힌다. 268 후보별 POST와 270 행성별 POST가 한 예산을 공유하며, 별도 우회 집계는 없다. 이미 저장된 동일 입력의 `ready`·진행 중 `pending` 재사용과 GET·NASA 조회는 새 시도권을 쓰지 않는다. 기능이 꺼지면 저장된 현재 `ready`만 그대로 제공하고, 설명이 없는·진행 중·실패한 행성은 `disabled`로 안내한다. 한도 소진은 해당 행성만 `explanationStatus=quota_exceeded`, `failure=daily_limit`, `retryAt=다음 UTC 자정`으로 반환한다. 이 상태 자체는 설명 테이블에 저장하지 않아 다음 GET은 기존 저장 상태를 보여준다.

## 4. 응답 계약과 상태 읽기

아래는 271이 소비할 **형식 예시**다. 시간·행성값은 시험용이며 실제 NASA 측정값을 주장하지 않는다. 측정 객체의 숫자·오차는 정밀도를 지키는 문자열 또는 null이고, 미제공 측정은 객체 또는 그 `value`가 null일 수 있다. `sourceHash`는 정상 정규화 JSON의 SHA-256이며 개인·유료 정보가 아니다. `facts.sourceUrl`은 서버 고정 출처다.

```json
{
  "star": {"ticId": "150428135", "hostName": "TOI-700"},
  "status": "ready",
  "complete": true,
  "fetchedAt": "2026-09-25T05:20:00Z",
  "refreshStatus": "ok",
  "retryAt": null,
  "planets": [
    {
      "planetId": "np-881febc05b880dcaa8f5601b89a620c4315737d60d635001813dccea00f19fdf",
      "name": "TOI-700 b",
      "sourceStatus": "ready",
      "facts": {
        "planetName": "TOI-700 b",
        "orbitalPeriod": {"value": "9.977219", "errorPlus": null, "errorMinus": null, "limit": 0, "unit": "days", "reference": null},
        "radius": {"value": null, "errorPlus": null, "errorMinus": null, "limit": null, "unit": "earth_radius", "reference": null},
        "mass": null,
        "discoveryMethod": "Transit",
        "discoveryYear": 2020,
        "controversial": null,
        "sourceTable": "ps",
        "sourceUrl": "https://exoplanetarchive.ipac.caltech.edu/"
      },
      "sourceHash": "<정규화 JSON의 SHA-256 소문자 64자리>",
      "sourceVersion": 1,
      "fetchedAt": "2026-09-25T05:20:00Z",
      "changedAt": "2026-09-25T05:20:00Z",
      "explanationStatus": "ready",
      "explanation": {
        "name": "{검증된 이름 설명}",
        "orbitalPeriod": "{검증된 공전주기 설명}",
        "radius": "{검증된 반지름 설명}",
        "mass": "{검증된 질량 설명}",
        "discovery": "{검증된 발견 설명}"
      },
      "generatedAt": "2026-09-25T05:21:00Z",
      "retryAt": null,
      "failure": null,
      "model": "gpt-5.4-mini",
      "promptVersion": "nasa-ko-v4"
    }
  ]
}
```

| 범위·상태 | `complete`·필드 규칙 | 화면 의미 |
| --- | --- | --- |
| 목록 `not_requested` | `false`, `fetchedAt=null`, `planets=[]` | 아직 NASA 목록을 요청하지 않았다 |
| 목록 `pending` | 기존 행성이 있어도 `complete=false`로 표시하고 `fetchedAt` 유지, 없으면 빈 배열 | 같은 TIC의 요청이 진행 중이므로 GET으로 확인한다 |
| 목록 `ready` | TTL 안의 완전한 1~64행 snapshot, `complete=true` | 검증된 각 행성 자료를 선택할 수 있다 |
| 목록 `empty` | TTL 안의 정상 0행, `complete=true`, `planets=[]` | 이번 NASA 조회에서 확정 기본 해가 없었다 |
| 목록 `partial` | `complete=false`; 문제 행성은 개별 상태로 표시하고 정상 행성은 유지 | 중복 기본 해·개별 자료 검증 실패를 전체 확정 목록으로 표시하지 않는다 |
| 목록 `temporarily_unavailable` | 성공 snapshot이 없고 최근 NASA 시도가 실패해 `complete=false` | timeout·429·5xx·본문 상한·파싱 오류는 행성 없음으로 표현하지 않는다 |
| 목록 `stale` | 이전 행성이 있거나 TTL이 만료됐다. `complete=false`, 과거 `fetchedAt`·최근 `refreshStatus`·가능하면 bundle `retryAt` 유지 | 과거 자료를 참고로만 표시하고 최신 전체 목록으로 표시하지 않는다 |
| 행성 `sourceStatus=ready` | 검증된 `facts/sourceHash/sourceVersion` | 설명 실패·비활성이어도 원천 수치는 표시 가능하다 |
| 행성 `sourceStatus=identity_unresolved` | 중복 기본 해 등 식별 보류, `facts/sourceHash/sourceVersion=null` | 해당 이름의 값을 임의 선택하지 않는다. 다른 행성은 유지한다 |
| 행성 `sourceStatus=invalid_source` | 파싱 이후 부호·표시값·설명 입력 검증 거절, `facts/sourceHash/sourceVersion=null` | 유효한 수치처럼 표시하지 않고 다른 정상 행성은 유지한다. JSON 숫자 파싱 실패 자체는 목록 전체 실패다 |
| 설명 `ready` | 현재 원천·모델·프롬프트의 다섯 `explanation`과 `generatedAt` | 현재 행성에만 연결한다 |
| 설명 `not_requested/pending/disabled/failed/quota_exceeded/source_unavailable/invalid_source/busy/source_changed` | `explanation=null`, `generatedAt=null`; 필요한 경우 `retryAt/failure` 제공 | 원천 수치와 설명 상태를 분리한다 |

`planetId`만 행성 선택 키다. 화면은 `name`·공전주기·배열 위치에서 다른 항목의 설명을 추측하지 않는다. 저장된 항성명은 NASA가 제공하지 않을 수 있어 `star.hostName=null`을 허용한다. bundle `retryAt`은 목록 재확인 가능 시각이며 `pending`에서는 현재 임대 만료 시각이다. 항목 `retryAt`은 해당 설명의 다음 시도 시각이다. 항목 `fetchedAt`은 **원천 상태와 무관하게** 마지막 완전 NASA 응답에서 그 이름을 관찰한 시각, `changedAt`은 그 항목의 정규화 자료 또는 상태가 바뀐 시각이다. 따라서 `identity_unresolved/invalid_source`에도 두 시각이 기록될 수 있으며 bundle의 시각과 다를 수 있다. `model/promptVersion`은 현재 생성 설정과 계약 버전으로 **모든 항목에 제공**하며 원천 미검증 행성에서도 null로 생략하지 않는다. `sourceStatus`·설명 상태와 각 null 필드를 유지해 0·1·복수 행성, 부분 실패, 오래된 성공 snapshot을 구분한다. API 오류는 `{code,message,fieldErrors,requestId}` 공통 형식이다. 인증 누락은 401, 본인 제출 자격이 없는 TIC·`skipped`만 있는 별은 404, POST의 CSRF 누락은 기존 보안 정책, 없는 `planetId`는 404다. NASA·모델의 항목별 예상 장애는 자격 있는 200 bundle 안의 상태이며, DB·인증 장애를 빈 목록으로 바꾸지 않는다.

## 5. 저장·검증 경계

V29는 `nasa_star_catalog`(TIC별 조회 상태·갱신 임대), `nasa_star_planet`(후보 FK 없는 외부 행성 ID·활성 표식·검증 원천), `nasa_star_planet_explanation`(행성별 검증된 설명·임대·시도)을 추가한다. 기존 후보별 V25·V26과 공통 예산 V28은 수정하지 않는다. V29의 상세 열·FK·앱 역할 권한은 [ERD G절](../architecture/database-erd.md#g-요청된-외부-조회-자료와-한국어-설명-v25v26v28v29-266270)을 따른다. 성공 갱신에서는 이전 현재 행성을 비활성화한 뒤 새 현재 행성을 활성화하고, 이름 정정·삭제 전의 행은 보존하되 응답에서 숨긴다. NASA snapshot 교체·설명 완료는 세대와 원천 해시를 조건으로 저장한다. 오래된 응답, 이름 정정·삭제, 회원 자격 철회는 새 결과를 덮거나 잘못 연결하지 못한다.

격리 PostgreSQL·로컬 NASA HTTP fixture·모델 stub에서 최종 일곱 클래스 통합 회귀 **98/98, 실패·오류 0, `BUILD SUCCESSFUL in 1m 27s`**를 확인했다. 내역은 `NasaPlanetExplanationTest` 17, `NasaPlanetInfoTest` 8, `NasaStarPlanetTest` 10, `StarResultTest` 13, `SubmissionTest` 37, `StarPathHttpTest` 9, `StarPlanetExplanationHttpTest` 4건이다. 270 전용 10건은 실제 답 제출·`skipped`·회원 철회, 정상 0/복수 행성·내부 후보 없는 행성, 확정과 비확정을 포함한 중복 이름, 개별 잘못된 수치, 재확인 장애와 과거 목록 보존, localhost HTTP fixture의 65행 상한, 한 행성 모델 실패, 목록·설명 임대 만료와 늦은 응답을 직접 확인했다. `StarPathHttpTest`에는 새 경로의 세션·CSRF 사례가 포함된다. 다른 여섯 클래스는 266~268 원천·설명·제출·결과 경로 회귀와 V28 공통 한도를 확인한다. 큰 본문·JSON 숫자 파싱 실패 각각의 270 전용 fixture와 실제 NASA·GMS 새 실호출, 실제 회원·Gold 연결, 공유/운영 DB 적용, 271 브라우저 인수는 **미실행**이다. 271은 이 JSON fixture로 병렬 개발할 수 있으나 실제 서버와의 최종 인수는 270 배포·검증 뒤에 한다.

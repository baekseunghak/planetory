# NASA 행성 설명 요청·재사용과 상세 패널 연결 (S15P21C206-268)

- 상태: 268 백엔드 표적 회귀 36건, 프론트 타입 검사·단위 452건·빌드와 Chrome 상세 화면 fixture 6건 통과. 실제 회원·Gold 연결, 공유/운영 DB 적용, 서버 배포와 실제 회원 브라우저 인수는 별도로 확인해야 한다.
- 목적: [266 원천 계약](nasa-planet-info-266.md)과 [267 설명 계약](nasa-planet-explanation-267.md)의 저장 결과를 회원의 기존 별 상세에서 안전하게 요청·재사용한다. HTTP 필드·오류는 [탐사 API 4.2.1절](../../apps/backend/docs/exploration-api-spec.md#421-회원별-별-단위-nasa-한국어-설명-s15p21c206-267), 설정·배포·장애 대응은 [운영 가이드](../operations/nasa-planet-info-runbook.md)를 따른다.

## 1. 대상과 화면 위치

별 상세의 `planets.items`는 그 회원이 해당 TIC에서 수치 매칭한 확정 후보와 최신 판단이 행성 같음인 미확정 후보만 담는다. 268은 이 기존 목록에서 선택한 확정 후보의 NASA PS 기본 해와 한국어 설명을 상세 패널에 보여준다. 미확정 후보는 설명 비대상으로 안내한다. 목록의 ID·개수·공전 표현·성과·공식 분류는 바꾸지 않는다. 다른 회원의 후보, 미매칭 후보, 공식 FP 및 NASA 카탈로그의 나머지 행성은 추가하지 않는다. 확정 후보를 회원이 비행성으로 판단했더라도 그 제출만으로 공식 분류가 바뀌지 않으므로 기존 표시 대상에 남을 수 있다.

TIC는 항성 ID이고 `candidateId`는 내부 신호 ID다. NASA 행성명은 검증된 Gold `source='archive'` 참조와 NASA `ps`의 같은 TIC·정확한 `pl_name`으로만 연결한다. 주기 근접도, 이름 유사도, 배열 순번으로 누락된 연결을 추측하지 않는다. 262 목업의 `source='nasa_exoplanet_archive'`는 다른 TIC로 복사된 `pscomppars` 참고값이므로 실제 식별 검증으로 취급하지 않는다. 실제 Gold 공급 연결은 [266 계약 2절](nasa-planet-info-266.md#2-식별자와-요청-흐름)의 남은 인수다.

270은 같은 항성의 **NASA 전체 확정 행성 목록**을 본인 제출 결과에서 제공하는 백엔드 작업이고, 271은 그 결과 화면의 행성 선택 위젯이다. 268의 별 상세 패널이나 `planets.items`를 270 목록으로 대체하지 않는다. 두 화면이 같은 원천 수치를 소비하더라도 각자의 대상 선정·권한을 분리한다.

## 2. 현재 자격·재사용 경계

매 HTTP 요청은 세션의 현재 회원, 별 발견, 회원의 실제 수치 매칭 제출, 후보의 활성·확정 상태와 검증된 Gold 연결을 다시 확인한다. 클라이언트가 보낸 TIC·후보 ID만으로 외부 조회 자격을 만들지 않는다. 별 상세에서 목록을 읽은 뒤 후보가 사라지거나 다른 후보로 바뀌면 그 항목의 설명과 NASA 수치를 보내지 않는다. 장시간 NASA·GMS 호출의 저장 직전에도 후보·원천 해시·시도 순번을 검사해 오래된 결과가 현재 자료를 덮지 못하게 한다.

저장된 NASA 원천은 `nasa_planet_info`(V25), 한국어 설명은 `nasa_planet_explanation`(V26)에 후보별로 보관한다. 원천 정규화 해시와 구조 버전, 모델·프롬프트 버전이 현재 조합과 맞는 검증된 설명만 재사용한다. NASA가 정상적으로 재확인됐어도 해시가 같으면 설명을 다시 만들지 않는다. 값이 바뀌면 이전 설명은 노출하지 않고 현재 원천으로 새 설명을 요청한다. NASA 갱신이 일시 실패한 경우 기존 정상 원천과 `fetchedAt`·최근 재확인 실패 상태를 함께 보존한다. NASA 성공 뒤 GMS만 실패하면 정상 원천 수치와 출처·조회 시각은 사용할 수 있고, 설명만 별도 실패·재시도 상태가 된다.

원천 재확인 간격은 `ready` 7일, `not_found`·`identity_unresolved` 1일, 일시 장애 뒤 기본 5분이다. 이는 NASA의 발행 주기가 아닌 서비스 재조회 정책이다. 설명 실패 재시도는 같은 후보·원천·모델·프롬프트 조합에서 최대 3회, 실패 뒤 기본 1시간이다. GET 조회와 생성 요청의 정확한 HTTP 동작·상태 형식은 아래 3절과 API 명세를 함께 따른다.

## 3. 조회·생성 요청

`GET /api/v1/me/stars/{ticId}/planet-explanations`는 저장된 현재 상태만 읽는다. 원천 미생성 확정 후보는 설명 스위치 상태와 관계없이 `status=not_requested`, `sourceStatus=not_requested`이고, NASA·GMS를 호출하지 않는다. `POST`는 같은 경로에 `{ "candidateId": "c-401" }`처럼 **별 상세에 있는 확정 후보 하나**를 보내 생성 또는 기존 결과 재사용을 요청한다. 다른 후보를 한꺼번에 생성하지 않는다. 설명 기능이 꺼져 있어도 POST는 266의 NASA 원천 수집을 할 수 있으며, 성공 시 `status=disabled`, `sourceStatus=ready`, `facts`를 제공하고 모델은 호출하지 않는다. 두 메서드 모두 동일한 `{ticId, version, items}` 응답 형식을 사용하며, `items`는 별 상세의 현재 회원별 후보 목록이다. 요청한 한 후보와 나머지 항목을 배열 순번으로 연결하지 않는다. POST는 인증 세션·CSRF를 통과하고 현재 자격을 다시 검사한 뒤 재사용 가능한 결과가 있으면 그대로 돌려준다. 중복 클릭과 응답 유실 뒤 재전송은 같은 대상·원천·프롬프트 조합의 임대·시도 순번을 재사용한다. DB 트랜잭션은 외부 호출 동안 열어 두지 않는다. 프론트는 준비 중이면 새 POST를 반복하지 않고 GET으로 상태를 다시 읽는다.

POST 본문 `candidateId`의 누락·형식 오류는 400 `VALIDATION_FAILED`다. ID 형식이 맞더라도 현재 회원·TIC의 확정 목록에 없거나 미확정·다른 별 후보면 404 `RESOURCE_NOT_FOUND`다. 미발견 별이나 TIC 형식 오류는 GET·POST 모두 403 `STAR_LOCKED`로 덮는다. 권한 있는 요청은 후보별 원천·설명 실패나 한도 초과를 항목 상태로 싣고 200 Bundle을 반환한다. 조회·요청 예시와 null 규칙은 [API 명세 4.2.1절](../../apps/backend/docs/exploration-api-spec.md#421-회원별-별-단위-nasa-한국어-설명-s15p21c206-267)을 따른다.

설명 생성은 POST 안에서 동기 처리한다. 프론트는 POST만 30초 동안 기다리지만, NASA 조회 최대 2회(각 10초)와 설명 생성(20초)을 순서대로 수행하면 서버 처리가 그보다 길 수 있다. 따라서 30초 초과나 응답 유실은 서버 실패의 증거가 아니다. 자동으로 POST를 재전송하지 않고 먼저 GET으로 저장 상태를 확인한다. `pending`이면 3초 간격 GET으로 기다리고, `ready`이면 저장 결과를 사용한다. 아직 결과가 없거나 실패했을 때 새 요청이 필요한지는 사용자에게 안내하고 다음 POST는 사용자의 명시적인 동작에 맡긴다. 재전송이 있더라도 백엔드의 DB 임대와 시도 순번 검사가 동일 작업의 중복 외부 호출·저장을 제한한다. 하루 모델 시도 한도에 닿아도 이미 저장된 `ready`·`pending`은 그대로 반환한다. 새 시도가 필요한 항목은 `status=quota_exceeded`, `failure=daily_limit`, 다음 UTC 자정의 `retryAt`으로 안내하며 새 V26 `pending` 행은 만들지 않는다. 이 한도 상태는 DB에 별도 저장하지 않아 다음 GET은 이전 설명 상태를 돌려주며, 같은 POST를 다시 보내면 한도 상태를 재확인한다.

## 4. 사용자에게 보여줄 자료와 상태

응답의 후보별 `facts`는 NASA `ps` 기본 해의 행성명, 공전주기·반지름·실제 질량, 발견 방법·연도, 문헌상 논쟁 표식과 원천 표를 담는다. 원천이 `ready`여도 정규화 버전 1·SHA-256·표시 자료 검증을 통과한 경우만 공개하며 `invalid_source`에서는 보통 null이다. 각 측정의 `value`, 양·음 오차 원값은 정밀도를 보존하는 문자열 또는 null이고 `limit`, 단위, 참조는 266의 정규화 의미를 유지한다. `limit=-1`은 미만, `0`은 측정값, `1`은 초과, null은 원천에 표식이 없다는 뜻이다. 결측값을 0이나 추정값으로 바꾸지 않는다. NASA 문헌 HTML은 화면에 전달하거나 렌더링하지 않는다. 출처 링크는 서버가 고정한 공식 Archive 주소만 열고, 화면에 표시하는 일반 문자열도 이스케이프한다. 설명의 다섯 문장은 검증된 `nasa-ko-v4` 결과일 때만 보여준다.

`/sky`의 별 상세에서 확정 내 행성을 선택하면 기존 `.planet-information`에 「NASA 행성 자료 보기」 버튼이 나타난다. 열기는 GET만 실행해 현재 저장 상태를 확인한다. 원천 미생성이면 「NASA 자료 요청」, 정상 원천은 있지만 설명이 없으면 「쉬운 설명 요청」 버튼이 해당 `candidateId` 한 건의 POST를 보낸다. 패널은 공전주기·반지름·질량과 발견 방법/연도, 문헌상 논쟁 표식, 고정 NASA PS 출처 링크·`fetchedAt`을 먼저 보여주고, 검증된 다섯 설명과 `generatedAt`은 별도 영역에 둔다. 설명 실패·비활성 상태에서도 정상 `facts`는 유지한다. 원천 `not_found`·`identity_unresolved`는 일시적인 timeout·429·5xx나 권한 철회와 다른 문구로 안내하고, 수동 「NASA 자료 재확인」을 허용한다. 이때 서버가 보관 간격 안의 기존 상태를 다시 반환할 수 있음을 안내한다. 최근 재조회 실패의 `interrupted`·`busy`는 원천 상태가 아니라 `refreshStatus`로 읽으며, 원천 `temporarily_unavailable`에 `refreshStatus=disabled`가 붙으면 NASA 조회가 운영 설정으로 중지됐다고 안내하고 요청 버튼을 숨긴다. 모델 실패를 행성 부재라고 말하지 않는다. 재확인 실패로 과거 정상 NASA 자료를 사용하는 경우 최근 실패와 마지막 정상 조회 시각을 함께 알린다.

`pending`이면 새 POST를 연속으로 보내지 않고 3초 간격 GET으로 저장 상태를 확인한다. POST를 보낸 프론트는 30초 뒤 응답을 받지 못하면 GET으로 먼저 결과를 확인한다. 버튼과 패널은 키보드로 접근하고, 로딩/오류 변화는 읽을 수 있는 텍스트로 제공한다. 설명 문장을 다른 후보에 붙이지 않도록 현재 회원·`ticId`·지도 `version`·`candidateId`가 모두 일치하는 응답만 적용한다. 별·후보·계정이 바뀌면 진행 요청을 취소하고 늦은 응답을 버린다.

## 5. 운영·검증 경계

설명 기능은 기본 비활성이다. 활성화는 [운영 가이드 8절](../operations/nasa-planet-info-runbook.md#8-한국어-설명-생성-배포운영-267)의 키·모델·쿼터·동시 수·timeout 점검 뒤 수행한다. V25 NASA 원천→V26 설명→269의 V27 봉우리 제출 제약→V28 일별 한도 순서의 Flyway 성공과 앱 역할 권한을 확인한다. V28은 사용자별·전체의 일별 모델 생성 시도권 예약 수를 기록한다. 한도 수치는 아직 미지정이므로 `NASA_EXPLANATION_DAILY_PER_MEMBER=0`, `NASA_EXPLANATION_DAILY_GLOBAL=0`이 기본값이며 새 유료 호출을 차단한다. 설명을 활성화하려면 운영자가 승인된 **양의 정수 한도 두 개**를 명시 주입해야 하고, 활성 스위치와 0 한도가 함께 있으면 앱 기동을 실패시킨다. 외부 모델 호출 직전 예약에 성공하면 이후 모델 실패나 권한 철회가 있어도 비용 가능성이 있어 횟수를 되돌리지 않는다. 중복 요청·저장 결과 재사용은 새 시도권을 예약하지 않는다. 두 집계는 한 짧은 DB 트랜잭션에서 같이 증가하므로 인스턴스가 여러 개여도 전체 예약 수가 하나로 제한된다. 사용자 탈퇴로 사용자별 집계가 정리돼도 전체 집계는 유지한다. 설정명·집계 확인은 [운영 가이드](../operations/nasa-planet-info-runbook.md#84-읽기-전용-사전사후-점검)를 따른다. 여러 서버에서 프로세스당 동시 상한을 더하면 동시에 시작하는 요청 수가 늘 수 있으므로 운영자는 배포 인스턴스 수와 공급자 쿼터를 함께 확인한다.

백엔드는 격리 DB와 NASA fixture·모델 stub로 StarPathHttp 8건, StarPlanetExplanationHttp 4건, NasaPlanetInfo 8건, NasaPlanetExplanation 16건, 합계 **36건 실패 0건**을 통과했다. 권한 경계, 저장 조회·단일 요청, 중복·동시·만료 임대와 늦은 결과, NASA·GMS 각각의 실패, 원천 변경 후 설명 재생성을 이 표적 회귀에 포함한다. 저장소 `apps/backend`에서 재실행한다. 기존 개발·운영 DB나 유료 제공자를 호출하지 않으며, 일회용 DB 테스트는 Docker 접근이 필요하다.

```powershell
.\gradlew.bat test --tests com.planetory.backend.domain.exploration.StarPathHttpTest --tests com.planetory.backend.domain.exploration.StarPlanetExplanationHttpTest --tests com.planetory.backend.domain.exploration.service.NasaPlanetInfoTest --tests com.planetory.backend.domain.exploration.service.NasaPlanetExplanationTest -PskipLocalDb
```

269의 V27 봉우리 제출 제약과 268의 V28 일별 집계를 함께 둔 통합 백엔드 검증은 위 268 표적 36건에 `SubmissionTest` 37건을 더한 5종 **73/73 통과**다. 이는 마이그레이션 번호 충돌과 제출 경로 회귀를 확인한 로컬 결과이며 대상 서버에 Flyway를 적용한 결과는 아니다.

프론트는 `apps/frontend`에서 `npm run typecheck`, `npm test`(**452/452**), `npm run build`를 통과했고, 개발 fixture를 사용하는 Chrome 상세 화면 6건도 통과했다. 실행 명령과 사례는 [268 화면 준비 기록](../../apps/frontend/docs/ticket-268-readiness.md#검증과-남은-인수)을 따른다. 이 브라우저 검증은 운영 서버나 실제 계정 연결이 아니다. Compose는 비밀 자리표시자가 있는 임시 환경에서 `NASA_*` 16개 전달, 기본 0/0과 임시 override를 확인했다. 과거 267의 NASA/GMS 소량 실호출은 [267 검증 기록](nasa-planet-explanation-267.md#5-검증-및-아직-확정하지-않은-것)으로만 취급한다. 이번 268의 신규 NASA TAP 조회·유료 GMS 호출, 실제 회원·Gold 연결, 공유/운영 DB 적용·서버 배포 및 실제 회원 브라우저 인수는 수행하지 않았다.

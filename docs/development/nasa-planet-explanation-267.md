# NASA 행성 정보 한국어 설명·별 단위 전달 계약 (S15P21C206-267)

- 상태: 267 후보별 내부 설명과 별 단위 공개 백엔드 응답 구현·격리 검증 완료. 현재 프롬프트는 `nasa-ko-v5`(번호 선택, `S15P21C206-277`)다. 아래 v4 기록은 당시 검증이다. `nasa-ko-v4`는 표적 회귀, TOI-700 b 한 후보의 실제 NASA TAP·GMS 생성·문장 검증, 가상 후보 4개를 시드한 인증 별 단위 GET의 실제 NASA TAP·GMS 생성과 V25·V26 저장을 통과했다. v4 별 단위 GET 1회 표본은 첫 조회 14,554ms, 즉시 재조회 82ms였다. 기존 MockMvc·별 상세·실제 세션·모델 stub 검증과 266 회귀·Spring 기동도 통과했다. 267 당시 실제 회원·Gold 연결, 공유/운영 DB 적용·서버 배포·268 화면 검증은 미실행이었다. 후속 268의 화면 fixture 검증과 남은 실제 회원 인수는 [268 계약](nasa-planet-request-268.md)을 따른다.
- 목적: [266 NASA 자료 저장 계약](nasa-planet-info-266.md)의 검증된 기본 해를 회원이 이해하기 쉬운 한국어로 설명한다. 배포 변수·적용·복구 절차는 [NASA 운영 가이드](../operations/nasa-planet-info-runbook.md)가 담당한다.
- 범위: Spring Boot 내부 Spring AI 호출, 응답 검증, 후보 단위 설명 저장·재사용, 인증 회원의 별 단위 공개 응답이다. 268은 [후속 요청·재사용 계약](nasa-planet-request-268.md)에 따라 GET 조회와 POST 생성 요청을 나누고 기존 프론트엔드의 표시·버튼·로딩·재시도 UX를 연결한다. 이 문서의 267 실호출 GET 결과는 변경 전 경로의 검증 기록이다.

## 1. 설명할 수 있는 자료

입구는 267의 `NasaPlanetExplanationService.lookup(memberId, candidateId)`이며, 내부에서 266의 `NasaPlanetInfoService.lookup(memberId, candidateId)`을 호출한다. 266이 회원 권한과 수치 매칭된 확정 후보, 공급 단계의 검증을 전제로 하는 Gold의 단일 `archive` 식별자, NASA PS의 같은 TIC·정확한 `pl_name`을 확인한다. **266 결과의 `status=ready`이고 `planet`이 있는 경우만 설명 입력으로 사용한다.** 다른 상태에서는 모델을 호출하지 않고 `source_unavailable`과 원래 266 결과를 함께 반환한다. 설명 수치는 Gold의 TESS 곡선·후보 측정값이나 262 목업의 `pscomppars` 외부 참조가 아니라 266이 별도로 조회한 NASA `ps` 기본 해에서 온다. 세 원천의 구분과 목업의 식별 한계는 [266 계약 2절](nasa-planet-info-266.md#2-식별자와-요청-흐름)을 따른다. TIC는 항성 식별자이며 설명과 저장의 단위는 그 항성의 전체 행성 목록이 아니라 내부 `candidateId` 하나다. NASA 카탈로그로 기존 `planets.items`를 늘리거나 Gold 분류·성과를 수정하지 않는다.

사용자의 제출·판단만으로 행성 확정을 선언하지 않는다. 후보의 공식 `disposition=fp`는 기존 `planets.items` 대상에서 제외되므로 NASA 행성 설명도 보내지 않는다. 반대로 확정 후보는 회원이 비행성으로 판단해도 그 제출만으로 후보 분류가 바뀌지 않으므로 설명 대상에 남을 수 있다. 행성 같음으로 남은 미확정 후보는 별 단위 응답에 있을 수 있지만 `not_applicable`과 `content=null`이며 NASA·모델을 호출하지 않는다. FP의 원인이 먼지였다는 별도 근거가 없으면 먼지라고 설명하지 않는다. 나중에 공식 후보 판정이 달라지면 그때의 권한·분류·원천을 다시 확인한다.

입력의 수치는 266의 정규화 자료에 있는 공전주기 `pl_orbper`(일), 반지름 `pl_rade`(지구 반지름), **실제 질량** `pl_masse`(지구 질량)만 사용한다. 질량이 비어 있어도 최소 질량 `M sin(i)`이나 다른 해의 값으로 채우지 않는다. 발견 방법·연도는 같은 정규화 자료에서 온다. `sourceHash`는 정규화 JSON SHA-256, `sourceVersion`은 정규화 구조 버전이며 NASA 원문 전체의 해시나 NASA 발행 버전이 아니다. 267은 **버전 1과 소문자 64자리 SHA-256**만 설명 입력으로 받아들이고 그 외는 `invalid_source`로 반환한다. 재확인 때 이 해시가 같으면 같은 원천 설명을 재사용할 수 있다.

NASA의 행성명·항성명·발견 방법 등 외부 문자열은 **자료**로만 취급한다. 모델에는 원문 이름·발견 방법·문헌을 보내지 않으므로 문자열에 명령처럼 보이는 문장이 있어도 출력 정책으로 해석할 경로가 없다. 서버는 실제 행성명을 검증된 식별자로만 사용한다. 발견 방법은 `Transit`, `Radial Velocity`, `Imaging`, `Microlensing`, `Astrometry`, `Pulsar Timing`, `Transit Timing Variations`, `Eclipse Timing Variations`만 한국어로 바꾼다. 알 수 없거나 지시문처럼 보이는 발견 방법은 설명에서 결측으로 취급하며, 발견 연도가 있으면 연도는 별도로 표시할 수 있다. NASA `pl_refname`·`disc_refname`에는 HTML 조각이 있을 수 있으므로 설명 생성 입력과 결과에는 포함하지 않는다. 268에서 원문 출처를 별도로 표시한다면 일반 문자열로 이스케이프하고 링크는 별도 검증해야 한다.

NASA의 `Published Confirmed`는 설명할 원천의 내부 확인 조건으로만 사용하며 사용자 문장에는 노출하지 않는다. 발견 방법의 영문 값도 한국어로 풀어 쓰고, 방법·연도 중 하나만 있을 때는 있는 사실만 표시한다. 결측은 전체 NASA 지식의 부재가 아니라 **조회한 자료에 값이 없다는 뜻**으로 말한다. 방법 설명은 [NASA Science의 발견 방식](https://science.nasa.gov/exoplanets/how-we-find-and-characterize/)과 [NASA Exoplanet Archive의 통과 시각 자료](https://exoplanetarchive.ipac.caltech.edu/docs/transit.html)를 근거로 한다. 통과 시각 변화는 발견 대상 자신이 아니라 **다른 행성**의 통과 시각일 수 있으므로 이를 구분한다.

## 2. 생성 경계와 응답 형식

백엔드는 설명에 필요한 값·단위를 먼저 결정적으로 표준화한다. 모델에는 원천 JSON의 **SHA-256 해시 문자열**, 각 사실의 자료 유무, 선택 가능한 고정 한국어 문장 틀만 전달한다. 해시는 원문 NASA 문자열이 아니며 모델 초안이 입력 원천과 같은지 확인하는 토큰이다. 실제 행성명·숫자·단위·발견 방법·연도는 모델에 보내지 않고 검증 뒤 서버가 채운다. 자유 웹 검색·자동 도구 호출·RAG·벡터 DB·별도 Python 서버는 사용하지 않는다. 시민용 설명에서 측정 오차 표기를 뺀 과거 계약은 `nasa-ko-v3`다. `nasa-ko-v4`가 같은 사실·검증 경계를 지키면서 다섯 문장을 대화하듯 자연스럽게 이어 쓰는 틀을 도입했고, 현재 `nasa-ko-v5`는 같은 틀을 번호로 고르게 한다. v2~v4로 저장된 설명은 재사용하지 않고 다음 자격 있는 요청에서 재생성한다. 선택된 외부 모델 연결은 GMS의 OpenAI 호환 주소 `https://gms.ssafy.io/gmsapi/api.openai.com/v1`과 `gpt-5.4-mini`다. 키는 백엔드 실행 환경의 `GMS_KEY`로만 주입한다. 기본은 `NASA_EXPLANATION_ENABLED=false`, `NASA_EXPLANATION_CHAT_MODEL=none`이다. 실생성을 켤 때는 두 값을 각각 `true`, `openai`로 설정하고 키를 주입해야 한다. 불완전한 활성화 설정은 기동 시 거절한다. 승인되지 않은 유료 실호출은 수행하지 않는다. 정확한 설정값과 배포 경계는 운영 가이드를 따른다.

구조화 모델 초안은 입력과 같아야 하는 `sourceHash`, **고정 문자 그대로** `planetName="{{name}}"`, 아래 **다섯 설명 항목** `name`, `orbitalPeriod`, `radius`, `mass`, `discovery`를 갖는다. `nasa-ko-v5`부터 각 항목에는 번호를 붙여 보여 준 허용 문장 틀 중 고른 **번호**(`"1"`, `"2"`)만 쓴다. v4처럼 선택지를 `[문장1, 문장2]` 목록 문자열로 보이면 모델이 가끔 목록 전체를 값으로 복사해 `invalid_output`이 났기 때문이다(`S15P21C206-277`, 운영 1/2·재현 1/24, v5 재현 30/30 통과). `planetName`에 실제 이름이 들어오면 거절한다. 저장하는 설명 내용은 검증 뒤 채운 다섯 필드다. 필드의 값이 없는 경우에도 근거 없는 문장으로 채우지 않고 결측을 명시한다. 모델 응답에 외부 링크, HTML, Markdown 링크나 추가 사실을 허용하지 않는다.

v4·v5의 다섯 필드는 각각 독립적으로 읽을 수 있는 완전한 한국어 문장이다. `name → orbitalPeriod → radius → mass → discovery` 순서로 이어 읽으면 하나의 설명처럼 흐른다. 현재 다섯 필드와 후보별 응답 구조를 유지하므로 268이 새 필드나 행성 추정 규칙 없이 같은 후보의 문장을 순서대로 보여줄 수 있다. 문장은 친근한 존댓말로 쓰되 NASA 자료에 없는 연결 사실이나 행성 여부 판단을 덧붙이지 않는다. 2026-09-25 TOI-700 b 한 후보의 실제 NASA TAP·GMS 호출 뒤 서버가 검증한 v4 출력은 `name` “TOI-700 b에 대해 함께 알아볼까요?”, `orbitalPeriod` “이 행성이 별을 한 바퀴 도는 데 9.977219일이 걸려요.”, `radius` “크기를 살펴보면, 반지름은 지구 반지름의 0.914배예요.”, `mass` “질량은 이번 NASA 자료에서 확인할 수 없어요.”, `discovery` “발견 기록을 보면, 이 행성은 2020년, 별 앞을 지나며 별빛이 잠깐 어두워지는 모습을 관측해 발견됐어요.”다. 이는 한 후보의 생성·검증 표본이며 별 단위 공개 응답 표본은 아니다.

| 필드 | 사용 가능한 근거 | 금지할 해석 |
| --- | --- | --- |
| `name` | 검증된 정확한 `planetName` | 같은 TIC의 다른 행성명, 별칭으로 교체 |
| `orbitalPeriod` | `periodDays`의 값·단위·`limit` | null을 숫자로 대체하거나 상·하한을 확정값으로 말하기 |
| `radius` | `radiusEarth`의 값·단위·`limit` | 지구와 크기가 같다는 식의 임의 비교·추정 |
| `mass` | `massEarth`의 값·단위·`limit` | 최소 질량을 실제 질량으로 바꾸거나 결측값 추정 |
| `discovery` | `discoveryMethod`, `discoveryYear` | 발견 시기·방법을 누락된 필드에서 추측 |

수치와 단위의 기준 문자열은 서버가 만든다. 266의 정규화 단위를 `days → N일`, `earth_radius → 지구 반지름의 N배`, `earth_mass → 지구 질량의 N배`로만 옮기며 km·kg 같은 새 수치로 환산하지 않는다. 정규화된 `BigDecimal`의 표기를 반올림해 측정 정확도를 새로 만들지 않는다. `limit=0`은 보고된 값, `-1`은 **미만(`<`)**, `1`은 **초과(`>`)**로 설명한다. `limit=null`은 값이 자료에 기록된 것으로만 말하며 상·하한이나 확정값 여부를 추측하지 않는다. `errorPlus`·`errorMinus`는 266의 정규화 자료에 그대로 보존하고 입력 검증에도 사용하지만, 시민용 다섯 문장에는 오차 수치와 `+`·`-` 범위를 넣지 않는다. 값이 null이면 오차만으로 수치를 만들지 않고 결측을 명시한다. `controversial=true`이면 문헌상 논쟁 표식을 이름 설명의 주의 문구에 반영하되 내부 확정 후보의 판정이나 성과를 바꾸지 않는다. `controversial=null`은 논쟁이 없다는 확정 판단으로 쓰지 않는다.

파싱 가능한 JSON만으로 성공 처리하지 않는다. 서버는 초안 `sourceHash` 일치, `planetName`의 고정 토큰과 구조를 먼저 확인한다. 각 항목은 해당 사실과 결측 상태에 허용된 **안전한 문장 틀의 번호이거나 그 틀과 완전히 일치하는 문장**이어야 한다. 선택지 수를 넘는 번호, 목록 복사, 그 밖의 값은 거절한다. 실패 로그의 `detail`에는 검증 실패일 때 걸린 항목 이름만, 모델·HTTP 오류일 때 예외 종류만 남긴다. 통과한 틀에 서버가 원천 이름·숫자·단위·허용된 발견 방법·연도를 삽입하고 완성한 각 설명 항목이 **240자 이하**인지 확인한다. 모델이 제시한 숫자·환산값은 설명 사실로 사용하지 않는다. 원천에 없는 수치·단위, 숫자와 한계 방향의 불일치, 거주가능성·생명체·확정 분류 같은 판단, 지시문이나 HTML이 섞이면 전체 설명을 거절한다. 검증 실패 응답을 화면에 보낼 수 있는 설명으로 저장하지 않는다.

## 3. 저장·재사용과 경합

`V26__nasa_planet_explanation.sql`은 266의 `nasa_planet_info`에 후보별 0~1행으로 매달리는 서비스 테이블을 추가한다. 기존 V25 파일과 원천 테이블은 고치지 않는다. 성공 설명에는 설명 본문과 함께 해당 `candidate_id`, 원천 `source_hash`·`source_version`, 사용한 모델·프롬프트 버전, 생성 시각을 저장한다. 설명 원천이 갱신되었는지 판정할 때는 **해시와 정규화 구조 버전**을 비교한다. 모델이나 프롬프트 버전이 바뀌면 재생성 대상이 된다. `fetchedAt`만 바뀌고 원천 해시가 같으면 재생성하지 않는다.

| V26 열 | 뜻과 운영 확인점 |
| --- | --- |
| `candidate_id` | PK이자 266 자료의 FK. 한 내부 후보의 설명 한 행 |
| `source_hash`, `source_version` | 설명을 만들 때 실제 사용한 정규화 원천. 현재 V25와 다르면 설명 재사용 금지 |
| `model_name`, `prompt_version` | 사용 모델과 출력 계약. 현재 설정·상수와 다르면 재생성 대상 |
| `status`, `content`, `generated_at` | `ready/pending/failed`; `ready`일 때만 검증된 다섯 필드 JSON과 생성 시각이 함께 있음 |
| `last_attempt_at`, `next_retry_at`, `last_failure` | 최근 설명 시도·다음 허용 시각·최근 실패 분류. 비밀·원문 응답을 기록하지 않음 |
| `in_flight_until`, `attempt_generation`, `attempt_count` | 동시 요청 임대·늦은 완료 차단 순번·같은 입력 조합의 1~3회 시도 횟수 |

원천은 계속 266의 `nasa_planet_info`에 있고 설명 테이블에는 복사하지 않는다. `content`의 다섯 설명은 267 별 단위 응답으로 전달할 수 있는 검증된 결과이며, 원본 NASA 문헌 HTML이나 모델의 미검증 초안은 넣지 않는다. 스키마·권한의 간략한 관계는 [서비스 DB ERD G절](../architecture/database-erd.md#g-요청된-외부-조회-자료와-한국어-설명-v25v26-266267)을 따른다.

동일 후보의 동시 생성은 DB 임대와 증가하는 시도 순번으로 제한한다. 모델을 부르기 **전에** 짧은 DB 작업으로 시도권을 확보하고 커밋한다. 모델 네트워크 호출 동안 DB 트랜잭션을 열어 두지 않는다. 완료 저장은 시도 순번뿐 아니라 현재 266 행의 `ready` 상태·같은 원천 해시/버전과 후보 식별 조건을 다시 확인한다. 따라서 오래 걸린 구 원천 응답은 새 원천 설명을 덮거나 연결하지 못한다. 저장 조건이 맞지 않으면 현재 결과를 다시 읽고 구 결과를 폐기한다.

모델 호출 실패, timeout, 형식/사실 검증 실패는 설명 생성 상태에만 반영한다. 설명 상태는 `ready`·`pending`·`failed`로 구분한다. 266의 정상 원천 JSON·상태·재확인 시각은 건드리지 않는다. 실패 시 기존 설명이 있다면 원천·모델·프롬프트 버전이 현재 입력과 일치하는 경우에만 재사용한다. 실패 후 재시도는 설명 생성만 대상으로 하며 **같은 후보·원천 해시/버전·모델·프롬프트 조합에서 최대 3회**, 실패 사이 기본 1시간으로 제한한다. SDK의 자동 재시도는 사용하지 않는다. 원천이나 설명 버전이 바뀌면 새 조합의 횟수로 다시 시작한다. NASA 원천 재조회나 회원 성과 갱신을 유발하지 않고, 모델 장애를 행성 부재나 NASA 식별 실패로 바꾸지 않는다.

## 4. 후보별 내부 결과와 별 단위 공개 응답

### 4.1 후보별 내부 결과

`NasaPlanetExplanationService.lookup(memberId, candidateId)`는 `Lookup(status, source, content, generatedAt, model, promptVersion, retryAt, failure)`를 반환한다. `source`는 266의 권한·식별·정규화 결과이며 설명 성공 여부와 별개로 보존한다. `content`는 검증을 통과한 `name/orbitalPeriod/radius/mass/discovery` 다섯 문장이고, 성공 시에만 `generatedAt`이 있다. 설명 원천 해시·버전은 내부 `source`에서 확인한다.

| 267 `status` | 뜻 |
| --- | --- |
| `ready` | 현재 원천 해시/버전과 모델·프롬프트 버전에 맞는 검증된 설명이 있다 |
| `pending` | 다른 요청의 생성 임대가 진행 중이다. `content`는 없다 |
| `failed` | 모델 호출이나 결과 검증이 실패했다. 분류된 `failure`를 확인한다. 3회 소진 뒤 `retryAt`은 null이다 |
| `source_unavailable` | 266 결과가 `ready`와 행성 자료를 갖추지 못했다. `source`의 원래 상태를 따로 확인한다 |
| `disabled` | 설명 스위치가 꺼져 있다. 정상 원천 자료는 계속 사용할 수 있다 |
| `invalid_source` | 266 자료의 원천 버전·해시·설명용 식별·단위·숫자 검증에서 거절했다 |
| `busy` | 프로세스당 동시 모델 호출 제한에 걸렸다 |
| `source_changed` | 조회 중 원천이 바뀌거나 구 결과의 조건부 저장이 거절됐다. 구 설명은 사용하지 않는다 |

모델 초안의 다섯 문장 필드 중 하나라도 누락되거나 null이면 `invalid_output`으로 분류해 해당 후보의 `content`를 내보내지 않는다. 이 경우를 `model_error`로 기록하지 않는다.

### 4.2 인증 회원의 별 단위 응답

267은 `GET /api/v1/me/stars/{ticId}/planet-explanations`를 처음 제공했으며 당시 GET이 원천 조회와 설명 생성도 수행했다. 268은 같은 GET을 **저장 결과 조회 전용**으로 바꾸고, 같은 경로의 POST 본문 `candidateId`로 확정 후보 한 건의 생성을 요청하도록 확장한다([268 계약](nasa-planet-request-268.md#3-조회생성-요청)). 기존 `GET /api/v1/me/stars/{ticId}`의 응답과 `planets.items`는 변경하지 않는다. 인증된 회원 ID는 서버 세션에서 가져온다. TIC 형식 오류나 회원이 열지 않은 별은 기존 별 상세와 똑같이 `STAR_LOCKED`로 덮는다. 서버는 **그 회원·그 TIC의 기존 `planets.items`를 구성하는 권한 필터**로 대상을 정한다. 클라이언트가 보낸 후보 ID는 POST의 요청 대상 한 건을 지정할 뿐, 목록을 늘리거나 검증되지 않은 NASA 연결을 만드는 근거가 아니다. NASA에 등록된 같은 별의 다른 행성도 추가하지 않는다.

응답은 `{ticId, version, items}`이며 `version`은 목록을 읽은 **같은 별 상세 스냅샷**의 지도 버전을 그대로 사용한다. `items`는 해당 조회 시점의 별 상세 `planets.items`와 같은 필터·`candidateId` 순서·개수를 따른다. 각 항목은 `{candidateId, kind, status, content, sourceStatus, fetchedAt, refreshStatus, generatedAt, retryAt, failure}`를 갖는다. 최상위 개수 필드는 두지 않는다. 별 상세의 `planets.count`는 미확정 후보도 포함한 표시 개수이므로 "설명 가능한 행성 수"로 해석하지 않는다. 검증된 `content.name` 속 행성명 외의 NASA 원문 행성명·문헌 문자열, 프롬프트, 원천 해시, 모델 설정은 공개하지 않는다. 화면은 `ticId`, `version`, `candidateId`로 기존 행성 목록과 설명을 연결하고 주기 근접도나 목록 인덱스로 추정하지 않는다.

`kind=unconfirmed`는 `status=not_applicable`, `content/facts/sourceStatus/fetchedAt/refreshStatus/generatedAt/retryAt/failure=null`로 반환하며 266·267을 호출하지 않는다. 268 GET에서 저장 이력이 없는 확정 후보는 `not_requested`이고 외부 호출도 하지 않는다. POST는 지정한 확정 후보 한 건만 후보별 267 `lookup`을 호출한다. 그 사이 후보가 266 대상 자격을 잃으면 해당 항목을 `status=source_unavailable`, `sourceStatus=not_eligible`, 다른 설명·수치·시각·실패 필드는 null로 보내고 다른 항목의 처리는 계속한다. 준비된 설명의 `content`는 다섯 검증된 문장만 담는다. 그 외 상태에서 `content`는 null이며 NASA 원천이 정상이라면 `facts`의 수치는 별도로 제공한다. 예상 가능한 후보별 NASA·모델 실패가 나머지 항목 전체를 실패시키지 않는다. 모델·외부 HTTP 호출은 별 상세의 읽기 트랜잭션 밖에서 실행한다.

공개 응답의 필드·상태별 null 규칙과 HTTP 오류는 [탐사 API 4.2.1절](../../apps/backend/docs/exploration-api-spec.md#421-회원별-별-단위-nasa-한국어-설명-s15p21c206-267)이 정본이다. 설명은 NASA 원천의 교육용 요약이며 측정값과 발견 사실의 독립적인 권위 원천이 아니다. 268은 이전 별·버전·후보의 늦은 응답을 새 선택에 적용하지 않고, 수치 원천의 `fetchedAt`과 최근 `refreshStatus` 및 과거 정상 원천 사용 여부를 구별해 표시한다. 버튼·로딩·재시도·출처 링크의 화면 방식은 [268 계약](nasa-planet-request-268.md)이 정한다. 설명이 없어도 266의 정상 수치 자료는 소비할 수 있다.

## 5. 검증 및 아직 확정하지 않은 것

후보별 설명의 격리 검증은 실제 유료 모델 대신 구조화 응답 stub과 Testcontainers의 일회용 PostgreSQL을 사용한다. 저장소 `apps/backend`에서 실행한다.

```powershell
.\gradlew.bat test --tests com.planetory.backend.domain.exploration.service.NasaPlanetExplanationTest -PskipLocalDb
```

266 회귀와 키 없는 앱 전체 기동까지 함께 확인하려면 다음을 실행한다. `-PskipLocalDb`는 기존 로컬 DB 자동 기동만 건너뛰고, 테스트의 일회용 PostgreSQL은 Testcontainers가 만든다.

```powershell
.\gradlew.bat test --tests com.planetory.backend.domain.exploration.service.NasaPlanetInfoTest --tests com.planetory.backend.domain.exploration.service.NasaPlanetExplanationTest --tests com.planetory.backend.PlanetoryApplicationTests -PskipLocalDb
```

별 단위 공개 응답과 기존 별 상세 회귀는 다음으로 확인한다. `StarPlanetExplanationHttpTest`는 DB 없는 독립 MockMvc와 mock 서비스 2건, `StarDetailTest`는 격리 스키마를 둔 로컬 PostgreSQL 24건, `NasaPlanetExplanationTest`는 Testcontainers PostgreSQL과 모델 stub 11건이다. 실제 NASA·GMS 서비스는 호출하지 않는다.

```powershell
.\gradlew.bat test --tests com.planetory.backend.domain.exploration.StarPlanetExplanationHttpTest --tests com.planetory.backend.domain.exploration.StarDetailTest --tests com.planetory.backend.domain.exploration.service.NasaPlanetExplanationTest -PskipLocalDb
```

2026-09-25 이 조합의 별 단위 HTTP 2건·별 상세 회귀 24건·후보별 설명 회귀 11건이 모두 통과했다(`BUILD SUCCESSFUL`, 실패·오류·건너뜀 0건). 이 stub·mock 조합 자체는 실제 NASA·GMS 연결이나 공유/운영 DB, 서버 배포와 268 프론트 표시를 확인하지 않는다.

`nasa-ko-v3` 오차 문구 제외 뒤에는 `NasaPlanetExplanationTest`와 `StarPlanetExplanationHttpTest`를 `-PskipLocalDb --console=plain`로 다시 실행해 `BUILD SUCCESSFUL`을 확인했다. 이 회귀 자체는 실제 GMS 문장 품질 시험이 아니며, 과거 실호출 JSON은 v2 표본이다. 별도의 v3 실호출 결과는 아래에 기록한다.

별도 `StarPathHttpTest` 실행에서는 격리 스키마를 둔 로컬 PostgreSQL과 실제 로그인 세션으로 미인증 401, 본인 별 200, 잠긴 별 `STAR_LOCKED`를 포함한 8건이 모두 통과했다(`BUILD SUCCESSFUL`, 실패·오류·건너뜀 0건).

정상 다섯 사실, 저장 결과 재사용과 모델·프롬프트 변경 뒤 재생성, 행성 식별·해시·숫자·단위·형식 불일치, null·상한·하한·부호 있는 오차, 지시문처럼 보이는 외부 문자열과 HTML 참조 제외, timeout과 최대 3회 재시도, 동시 생성·원천 변경 뒤 늦은 완료, 원천 미준비·기본 비활성, Spring AI 모델 stub의 JSON 파싱을 확인한다. 2026-09-25에 Java 컴파일과 이 클래스의 **11개 사례가 모두 통과**했다. 별도 회귀 실행에서 266의 `NasaPlanetInfoTest`와 키 없는 기본 비활성 설정의 `PlanetoryApplicationTests`를 함께 통과시켰다. 별도 실행에서는 `NASA_EXPLANATION_ENABLED=true`, `NASA_EXPLANATION_CHAT_MODEL=openai`, 테스트용 키 placeholder를 넣어 활성 Spring AI Bean의 기동도 확인했다. 이때 모델 요청은 만들지 않았다. 재실행의 기대 결과는 `BUILD SUCCESSFUL`이며, 실패 시 `build/test-results/test/TEST-com.planetory.backend.domain.exploration.service.NasaPlanetExplanationTest.xml`의 첫 원인을 확인한다. 이 명령은 기존 개발·공유·운영 DB를 초기화하지 않는다. 이 격리 테스트는 실제 GMS 연결, 모델의 한국어 품질·오류율·호출 비용·지연을 확인하지 않는다.

같은 날 리뷰 보완으로 모델의 문장 필드 누락 사례를 추가했다. `NasaPlanetExplanationTest` **12건 모두 통과**했고 누락 응답은 `invalid_output`, `content=null`로 기록됨을 확인했다. 이 회귀 실행 자체는 실제 v4 GMS를 호출하지 않았다.

2026-09-25 별도 연결 확인에서는 GMS `gpt-5.4-mini`에 v2 문장 선택지만 1회 보내 허용된 JSON 초안을 받았다(총 389토큰). 이 확인은 과거 v2 모델의 형식 응답만 검증한 별도 단계다.

같은 날 일회성 `StarPlanetExplanationLiveTest`에서 Testcontainers PostgreSQL·Redis에 시험 회원과 가상 후보 4개, 검증을 가정한 Gold `archive` 참조 `TOI-700 b/c/d/e`를 시드했다. 인증된 별 단위 GET이 **실제 NASA PS와 실제 GMS `gpt-5.4-mini`**를 호출한 결과 4/4 항목이 `kind=confirmed`, `status=ready`, `sourceStatus=ready`였고 각 `content`의 다섯 필드가 채워졌다(JUnit 1/1 통과). 임시 테스트 소스는 실행 후 삭제했고, 응답은 Git에서 제외된 `apps/backend/build/reports/planet-explanations-live.json`에 남겼다. 이 JSON은 오차 문장을 포함할 수 있는 **과거 v2 응답 표본**이며 v3의 기대 문구로 사용하지 않는다. 키 값과 원문 NASA HTML은 이 기록에 포함하지 않는다.

이어 같은 Testcontainers PostgreSQL·Redis, TIC `150428135`의 시험 회원·가상 후보·Gold `archive` 참조 `TOI-700 b/c/d/e`로 `nasa-ko-v3`를 일회성 재검증했다. 인증된 별 단위 GET이 실제 NASA PS와 GMS `gpt-5.4-mini`를 호출했고, 4/4 항목이 `kind=confirmed`, `status=ready`, `sourceStatus=ready`이며 각각 다섯 `content` 필드가 채워졌다. 주기·반지름 등 시민용 문장에는 측정 오차 또는 `+/-` 수치가 없었고, DB의 `prompt_version`은 네 행 모두 `nasa-ko-v3`였다. JUnit 1/1, 실패·오류·건너뜀 0건, `BUILD SUCCESSFUL`(전체 테스트 실행 약 50초)을 확인했다. 임시 테스트 소스는 실행 후 삭제했고, **v3 응답은 별도** Git 제외 파일 `apps/backend/build/reports/planet-explanations-live-v3.json`에 남겼다. 앞의 v2 JSON은 보존한다.

`nasa-ko-v4` 문장 틀 적용 뒤 `NasaPlanetExplanationTest` 11건과 `StarPlanetExplanationHttpTest` 2건의 표적 회귀를 `-PskipLocalDb --console=plain`로 실행해 `BUILD SUCCESSFUL`(재실행 약 17초)을 확인했다. 이 실행은 모델 stub·격리 HTTP 검증이며 실제 NASA PS·GMS 호출은 포함하지 않았다. 앞의 v2·v3 실호출 JSON을 v4 응답으로 해석하지 않는다.

같은 날 일회성 `NasaV4LiveProbeTest`에서 TOI-700 b 한 후보를 실제 NASA TAP으로 조회하고 Spring AI의 GMS `gpt-5.4-mini` 생성기와 `NasaPlanetExplanationText.render`를 통과시켰다. 결과는 당시 `nasa-ko-v4` 문장 틀로 생성·검증된 위 다섯 문장으로 확인했다(JUnit 1/1, 실패 0건). 응답은 Git 제외 파일 `apps/backend/build/reports/planet-explanations-live-v4.json`에 보관한다. 이 시험은 인증된 별 단위 GET, 회원·Gold 연결, V26 저장 경로를 거치지 않았다.

이어서 일회성 `NasaV4FullTimingProbeTest`는 Testcontainers PostgreSQL·Redis에 TIC `150428135`의 가상 회원·후보 4개와 `TOI-700 b/c/d/e` Gold `archive` 참조를 시드했다. 인증된 MockMvc `GET /api/v1/me/stars/{ticId}/planet-explanations`가 실제 NASA TAP과 GMS `gpt-5.4-mini`를 거친 첫 조회는 **14,554ms**, 즉시 같은 요청을 반복한 캐시 조회는 **82ms**였다. 두 응답 모두 4/4 항목이 `kind=confirmed`, `status=ready`, `sourceStatus=ready`였고, 격리 DB에서 V25 NASA 원천·V26 설명 캐시가 각각 4행임을 확인했다. JUnit 1/1, 실패·오류·건너뜀 0건, `BUILD SUCCESSFUL`이다. 임시 테스트 소스는 삭제했고 Git 제외 결과는 `apps/backend/build/reports/planet-explanations-v4-timing.json`에 남겼다. 이 수치는 해당 환경의 1회 표본이며 운영 서버·브라우저 지연을 대표하지 않는다. Gradle 전체 약 57초와 JUnit suite 40.954초는 API 응답 시간이 아니다.

v2·v3 및 이번 v4 별 단위 실험은 모두 **가상 회원·후보·Gold 참조를 이용한 격리 백엔드 경로**에 한정된다. 앞의 v4 한 후보 직접 검증과 이번 인증 GET·저장 검증도 서로 구분한다. 267 검증 시점에는 실제 회원과 실제 Gold 연결, 공유/운영 DB의 V26 적용, 서버 배포, 268 프론트 표시와 운영 비용·지연 분포·품질 평가를 확인하지 않았다. 후속 268의 프론트 fixture 결과와 실제 회원 인수 경계는 [268 계약](nasa-planet-request-268.md#5-운영검증-경계)에 기록한다. 앞선 약 50초는 v3 테스트 전체 실행 시간이며 API 응답 지연 측정값이 아니다. 운영 활성화 전에는 호출 예산·제한과 실제 응답 품질·지연을 대상 환경에서 확인한다.

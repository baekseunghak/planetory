# 요청된 확정 행성 NASA 자료 저장 계약 (S15P21C206-266)

- 상태: 266 내부 조회·정규화·PostgreSQL 저장 구현 완료, 격리 DB·HTTP fixture 검증 완료. 공유/운영 DB 적용과 사용자 화면 검증은 미실행.
- 범위: [요구사항 HOME-05·08](../requirements/planetory-requirements-spec.md), [탐사 API 4.2](../../apps/backend/docs/exploration-api-spec.md), [서비스 DB ERD](../architecture/database-erd.md)를 보강한다. 이 문서는 266의 상세 계약이고, 인프라 실행 순서는 [운영 가이드](../operations/nasa-planet-info-runbook.md)가 담당한다.
- 공식 원천: [NASA TAP 사용법](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html), [PS/PSCompPars 열 정의](https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html), [NASA FAQ](https://exoplanetarchive.ipac.caltech.edu/docs/faq.html). 조회일 2026-09-25.

## 1. 왜 필요하고 어디까지 구현됐는가

회원이 **이미 수치 매칭한 확정 후보**의 행성 정보를 볼 때 NASA Exoplanet Archive를 매번 호출하면 외부 장애와 반복 대기 시간이 상세 화면에 전파된다. 266은 요청된 후보 하나에 대해 NASA의 기본 문헌 해를 조회해 서비스 PostgreSQL에 저장하고, 정상 자료를 재사용할 내부 계약을 제공한다. 저장된 수치의 한국어 설명은 [267 계약](nasa-planet-explanation-267.md), 조회·생성 HTTP 경로와 화면 연결은 [268 계약](nasa-planet-request-268.md)이 담당한다. 266은 설명 생성 모델·키·별도 Python 서비스·Redis 캐시를 요구하지 않는다.

현재 별 상세 `GET /api/v1/me/stars/{ticId}`의 `planets.items`는 **회원이 해당 TIC에서 직접 매칭한 후보**만 담는다. 확정 후보는 오판했어도 포함되고, 미확정 후보는 최신 판단이 `LIKELY_PLANET`일 때만 포함된다. FP·미매칭·타인 발견은 제외된다. 사용자가 2026-09-25에 기존 범위를 유지하도록 결정했으므로, NASA에서 같은 항성의 행성 네 개를 받더라도 그중 요청된 내부 후보와 검증 연결된 하나만 보강한다. NASA 목록으로 `planets.items`나 지도 행성 수를 교체하지 않는다.

| 작업 | 현재 상태 | 책임 |
| --- | --- | --- |
| 266 | 구현·격리 검증 완료 | 대상 권한/식별 검사, NASA PS 조회, 정규화, DB 재사용·상태·경합 |
| 267 | [설명·전달 계약](nasa-planet-explanation-267.md) | 저장된 `ready` 자료로만 한국어 설명 생성, 회원의 별 단위 설명 응답. 모델·키·프롬프트·설명 버전은 267 계약 |
| 268 | [요청·화면 계약](nasa-planet-request-268.md) | GET 저장 조회·POST 한 후보 생성, 기존 `planets.items`의 상세 패널 연결, 클라이언트 로딩·오류/출처 표시 |

## 2. 식별자와 요청 흐름

`TIC 150428135`는 **항성** 하나다. NASA PS 기본 해에서는 이 TIC에 `TOI-700 b`, `c`, `d`, `e` 네 행성이 반환되는 것을 2026-09-25에 소량 확인했다. `c-42` 같은 내부 `candidateId`는 우리 곡선에서 찾은 **신호**의 ID이며 NASA 행성 ID가 아니다. `TOI-700 d` 같은 NASA `pl_name`도 TIC와 같지 않다. 이 예시는 식별자 차이를 설명하며, 실제 `c-42`가 그 행성과 연결됐다는 주장은 아니다.

| 자료 계층 | 현재 확인한 원천과 역할 | 266에서의 취급 |
| --- | --- | --- |
| Gold 관측 곡선·후보 | 262 목업의 계약 예시는 TESS/SPOC 광도곡선을 가공했다. 예시 후보 구성에는 별도 Archive 참고값도 사용했다 | 회원의 분석·후보 목록에 쓰지만 행성 물성 설명의 직접 원천은 아니다 |
| Gold 외부 참조 | 262 예시의 `source='nasa_exoplanet_archive'`, `external_id`는 고정 NASA Archive `pscomppars` 참고값의 `pl_name`에서 왔다 | `external_signal_references`의 후보 연결 표식이다. 원천 라벨과 이름만으로 실제 TIC·후보와의 검증된 연결을 증명하지 않는다 |
| 요청 시 NASA 자료 | 266은 NASA TAP `ps`에서 같은 TIC의 `default_flag=1` 기본 해를 별도로 조회한다 | 정확한 행성명·분류를 확인한 뒤 `nasa_planet_info`에 저장하며, 267 설명 수치의 직접 원천이 된다 |

현재 262 Publisher는 예시의 곡선·외부 참조를 **다른 더미 TIC로 복사**하고 실제 Gold 입력·후보 동일성 대조는 구현하지 않았다. 따라서 그 목업의 `nasa_exoplanet_archive` 참조는 새 TIC의 검증된 행성 식별자가 아니다. 266의 현행 조회는 검증된 공급 계약을 전제로 한 `source='archive'`만 받으며, 두 표기를 자동으로 같은 자격으로 취급하지 않는다. 운영 공급자가 실제 TIC·후보와 Archive 행성명의 직접 매칭을 검증하고 표기 계약을 확정하기 전에는 262 목업으로 266·267의 `ready`를 기대하지 않는다. 배치 공급의 표기는 [Gold 계약 4.3절](../../contracts/gold/README.md#43-s15p21c206-79-게시-후보-집계)에서 정했다(2026-09-27, `S15P21C206-276`). 124가 PSCompPars 행과 직접 대응시킨 후보에만 `source='archive'`, `external_id`=정확한 `pl_name`을 싣는다. 합성 검증만 했으므로 실제 run의 표본 연결은 운영 게시 때 확인한다.

```text
268 별 단위 POST가 선별한 확정 후보의 내부 요청(memberId, candidateId)
  → candidates + submissions + star_unlocks + users 상태 검사
  → Gold의 external_signal_references(source='archive', external_id=정확한 pl_name) 검사
  → nasa_planet_info의 같은 후보·TIC·행성명 정상/빈 결과 재사용
  → 만료 시 DB 시도 순번 확보 → 고정 NASA TAP 호스트로 TIC 조회 → 정확한 pl_name 한 행만 선택
  → 정규화와 해시를 DB에 반영 → 상태·조회 시각·자료 반환
```

`NasaPlanetInfoService.lookup(memberId, candidateId)`가 후보별 내부 생성 진입점이다. 후보가 active·confirmed이고 판정 행이 있으면 `confirmed`여야 하며, 별이 published이고 회원이 active·별을 발견·해당 후보를 수치 매칭한 제출이 있어야 한다. 실패한 대상은 일반 `RESOURCE_NOT_FOUND`로 덮는다. **별의 TIC만 알거나 다른 회원의 발견만 있어서는 조회하지 않는다.** 이 메서드는 공개 HTTP 경로가 아니며, 268의 POST가 서버 세션의 회원 ID와 권한 필터를 통과한 후보 ID만 전달한다. 268 GET은 저장 상태만 읽고 이 메서드의 외부 조회 경로를 시작하지 않는다.

연결은 공급 단계에서 검증됐다고 계약한 Gold의 `source='archive'` 참조 한 개와 NASA의 정확한 `tic_id`+`pl_name` 일치로만 성립한다. 참조가 없거나 둘 이상이거나 동일 TIC·행성명이 다른 **활성** 내부 후보에도 연결돼 있으면 `identity_unresolved`이며 NASA를 부르지 않는다. 지난 판의 은퇴 후보는 현재 후보의 연결을 막지 않는다. 이름 유사도·공전주기 근접·모델 추측으로 빈 연결을 채우지 않는다. 저장 후 Gold가 참조의 행성명을 바꾸면 기존 행을 자동 재연결하지 않고 `identity_changed`를 돌려 수동 검토 대상으로 남긴다. 검증된 정정 뒤에도 기존 캐시 행은 그대로이므로 [운영 가이드 6.1절](../operations/nasa-planet-info-runbook.md#61-검증된-gold-식별자-정정-뒤-identity_changed-복구)에 따라 옛 자료를 비우고 시도 순번을 올려야 새 식별자로 조회한다. 266은 Gold 참조를 생성·수정하지 않는다. 따라서 참조가 공급되지 않은 대상은 268에서도 NASA 보강값을 표시할 수 없다.

기존 `external_signal_references`에는 매칭 검증 수준을 나타내는 별도 열이 없다. `source='archive'`라는 문자열 자체도 검증 증거가 아니다. 이 서비스는 Gold 공급자가 `candidate_id`에 검증된 Archive 행성명을 연결해 게시했다는 계약을 전제로 읽으며, **그 공급·실데이터 검증은 266의 격리 시험으로 확인되지 않았다.** 268 인수 전에 실제 Gold 공급 경로와 표본 TIC·후보·행성명 연결을 확인해야 한다.

## 3. NASA 원천 선택과 값의 뜻

고정 주소는 `https://exoplanetarchive.ipac.caltech.edu/TAP/sync`다. 서버가 만든 ADQL은 `select top 65 <고정 열> from ps where tic_id='TIC <검증된 양의 정수>' and default_flag=1`이며 JSON으로 받는다. 65행째가 오면 64행 상한 초과로 실패시킨다. 테이블·열·호스트·쿼리 틀에 요청 문자열을 넣지 않는다.

`ps`는 행성×문헌 해마다 한 행을 가질 수 있다. `default_flag=1`인 **단일 기본 해**를 사용하고, 정확한 행성명이 둘 이상이면 임의로 고르지 않는다. `pscomppars`는 행성당 한 행이지만 여러 문헌에서 채운 값이 섞여 서로 같은 해가 아닐 수 있어 선택하지 않았다. 선택 행의 `soltype`이 `Published Confirmed`가 아니면 `identity_unresolved`이다. `pl_controv_flag=1`은 확정 상태에 대한 문헌상 논쟁 표식이며 삭제하거나 `false`로 바꾸지 않는다. null도 null로 보존한다. NASA 분류는 내부 `candidates.is_confirmed`, Gold 판정·성과를 다시 쓰는 근거가 아니다.

| 내부 정규화 항목 | NASA PS 열 | 단위·출처·결측 처리 |
| --- | --- | --- |
| 행성/항성 이름, TIC | `pl_name`, `hostname`, `tic_id` | NASA 원문. TIC는 `TIC n`과 요청 n이 같아야 한다 |
| 해·논쟁 상태 | `soltype`, `pl_controv_flag`, `default_flag` | 기본 해 1개만 선택; 논쟁 flag의 null 허용 |
| 공전주기 | `pl_orbper`, `pl_orbpererr1/2`, `pl_orbperlim` | 일(days). `pl_refname`을 이 측정의 reference로 저장 |
| 반지름 | `pl_rade`, `pl_radeerr1/2`, `pl_radelim` | 지구 반지름(earth_radius), 같은 기본 해의 `pl_refname` |
| 실제 질량 | `pl_masse`, `pl_masseerr1/2`, `pl_masselim` | 지구 질량(earth_mass). 없는 경우 null. `M sin(i)`나 composite의 best mass로 대체하지 않음 |
| 발견 방법·연도·문헌 | `discoverymethod`, `disc_year`, `disc_refname` | 발견 문헌은 행성 물리값의 `pl_refname`과 다를 수 있어 별도로 보존 |

측정의 `errorPlus`는 NASA `err1`, `errorMinus`는 NASA `err2`의 **부호를 포함한 원값**이다. `limit`은 `0` 측정값, `-1` 상한(`<`), `1` 하한(`>`)이며 null은 원천 미제공이다. 상한 값을 일반 측정값처럼 말하거나, 오차의 절댓값으로 방향을 지우지 않는다. `value`가 null이어도 객체와 단위·참조는 남는다. 숫자는 `BigDecimal`로 읽고 불필요한 소수 0만 제거한다. NASA의 `pl_refname`과 `disc_refname`은 HTML 조각일 수 있으므로 267/268은 화면에서 일반 문자열로 이스케이프하고, 허용된 링크만 별도 검증해 연다.

정규화 JSON의 `sourceTable`은 `ps`다. 버전 `1`은 위 열 선택과 JSON 구조의 계약 버전이다. 모든 측정 객체에는 `value`, `errorPlus`, `errorMinus`, `limit`, `unit`, `reference`를 둔다. `sourceHash`는 이 **정규화 JSON의 SHA-256**이며 원본 NASA 문서 전체의 바이트 해시가 아니다. 9.0과 9.00처럼 숫자 표기만 달라지면 같은 해시다. 값·오차·출처·상태 가운데 하나가 바뀌면 해시가 바뀌고 `changed_at`이 갱신된다. `fetched_at`은 마지막 정상 재확인 시각으로 매번 갱신한다.

## 4. 저장 구조와 상태 전이

`V25__nasa_planet_info.sql`이 `nasa_planet_info`를 만든다. `candidate_id`가 PK라 **요청된 내부 후보당 최대 한 행**이다. `candidate_id`와 `tic_id`는 기존 Gold 테이블 FK지만 Gold의 열·데이터는 바꾸지 않는다. 자동 만료 삭제·전체 선수집·별당 전체 행성 테이블은 없다.

| 열 | 의미 |
| --- | --- |
| `candidate_id`, `tic_id`, `archive_planet_name` | 내부 후보·항성·공급 단계의 검증을 전제로 선택한 정확한 행성명. 참조가 바뀌면 자동 재연결 금지 |
| `status` | `pending`, `ready`, `not_found`, `identity_unresolved`, `temporarily_unavailable` 중 하나 |
| `normalized`, `source_hash`, `source_version` | 정상 JSON, 정규화 해시, 구조 버전 1. 이전 정상값 보존 가능 |
| `fetched_at`, `changed_at` | 마지막 정상 조회 시각, 마지막 정규화 값 변경 시각 |
| `last_attempt_at`, `next_refresh_at` | 마지막 시작 시각, 다음 재확인 가능 시각. 빈 결과·장애를 정상 자료와 구분 |
| `in_flight_until`, `attempt_generation` | 서버 간 중복 시도 제한용 임대 만료와 증가 순번. 새 시도가 이전 결과를 덮지 못함 |
| `last_refresh_status` | `in_progress`, `ok`, `not_found`, `identity_unresolved`, `timeout`, `rate_limited`, `upstream_error`, `invalid_response`, `busy`, `interrupted` 등 최근 시도 결과. 수동 식별자 정정 직후에는 `identity_corrected` |

| 사건 | DB 결과 | 내부 반환 |
| --- | --- | --- |
| 최초 요청·재확인 시작 | 한 문장으로 `generation` 확보, 진행 임대 설정 | 다른 동시 요청은 `refreshing` 또는 기존 `ready` 자료 |
| 정확한 기본 해 1행 | `ready`; JSON·해시·시각 저장 | 자료와 조회·변경 시각 |
| HTTP 200, 정확한 행성 없음 | `not_found`; 기존 정상 JSON이 있으면 DB 안에 보존하되 제공하지 않음 | 빈 결과. 장애라고 단정하지 않음 |
| 중복 기본 해 또는 확인되지 않은 해 | `identity_unresolved`; 이전 JSON 보존하되 제공하지 않음 | 식별 검토 필요 |
| timeout·429·5xx·잘못된 응답 | 이전 `ready` 자료·해시·`fetched_at` 보존, 최근 실패 이유만 갱신. 이전 성공이 없으면 `temporarily_unavailable` | 이전 정상 자료와 실패 상태 또는 일시 장애 |
| 늦은 요청 완료 | `WHERE generation=시작 순번`이 0행 갱신 | 현재 DB의 더 새 결과 반환 |

외부 호출 전에 임대 기록 SQL을 완료하고 HTTPS를 호출한다. `lookup`은 `NOT_SUPPORTED` 트랜잭션 경계로 호출자의 DB 트랜잭션을 중지한다. 동일 후보가 동시에 요청되면 다른 요청은 저장된 자료 또는 `refreshing`을 받고 새 외부 호출을 만들지 않는다. 임대 시간이 지나 새 시도가 시작될 수 있으며, 그 뒤 도착한 구 시도 결과는 순번 조건으로 무시한다. 프로세스당 동시 HTTPS 최대 2개가 기본이며, DB 임대는 여러 서버 사이의 후보별 경합을 막는다. HTTP 시도마다 전송 전에 시작한 요청 마감은 연결·헤더·본문 읽기에 함께 적용한다. 임대는 두 번의 요청 마감과 재시도 간 200ms를 포함하도록 `requestTimeout×2+3초`로 둔다.

사용자 결정(2026-09-25): `ready`는 7일, `not_found`·`identity_unresolved`는 1일 뒤 재확인한다. 일시 장애 뒤 재시도 기본 간격은 5분으로 구현했다. 이전 정상 자료는 실패 중에도 `refreshStatus`와 `fetchedAt`을 함께 전달하며, 자동 삭제는 하지 않는다. 이 주기는 NASA가 보장한 갱신 주기가 아닌 **서비스 재조회 정책**이다.

## 5. 후속 작업의 소비 규칙

267은 `lookup`에서 `status=ready`와 `planet!=null`인 경우에만 설명을 만든다. `sourceHash`·`sourceVersion`·모델·프롬프트 버전과 설명 재생성·실패 경계는 [267 설명·전달 계약](nasa-planet-explanation-267.md)이 정한다. NASA 데이터의 null·상한·논쟁 표식을 설명에서 확정 측정처럼 표현하지 않는다. 266 테이블에 모델 키·모델 이름·설명 본문 열을 추가하지 않는다.

268의 별 단위 백엔드 응답은 기존 별 상세의 `planets.items`를 먼저 권한 필터로 사용한다. **그 목록에 있는 확정 candidateId 한 건**만 POST에서 이 내부 서비스에 요청하고 미확정에는 호출하지 않는다. GET은 저장된 상태만 읽는다. `not_found`, `identity_unresolved`, `temporarily_unavailable`, `refreshing`을 서로 다른 상태로 전달하고, 과거 정상값을 표시할 때에는 `fetchedAt`과 `refreshStatus`를 함께 제공한다. 공개 URL·필드는 [탐사 API 4.2.1절](../../apps/backend/docs/exploration-api-spec.md#421-회원별-별-단위-nasa-한국어-설명-s15p21c206-267)이 정한다. 266은 기존 별 상세 응답을 변경하지 않았다.

## 6. 로컬 실행·검증

실행 위치는 저장소 `apps/backend`이다. Docker 엔진은 Testcontainers가 **일회용 PostgreSQL**을 만들 때만 사용한다. 아래 테스트는 NASA 실서비스를 호출하지 않고 로컬 HTTP fixture로 timeout·429·5xx 등을 재현한다.

```powershell
.\gradlew.bat test --tests com.planetory.backend.domain.exploration.service.NasaPlanetInfoTest -PskipLocalDb
```

기대 결과는 `BUILD SUCCESSFUL`과 6개 사례 통과다. 실패하면 `build/test-results/test/TEST-com.planetory.backend.domain.exploration.service.NasaPlanetInfoTest.xml`에서 **첫 원인**을 확인한다. Docker 접근 실패는 엔진 권한·기동 상태를 확인하고, 마이그레이션 실패는 새 일회용 DB의 Flyway 오류부터 본다. 기존 개발 DB·운영 DB를 초기화하지 않는다.

2026-09-25에 실제 NASA TAP으로 `TIC 150428135`의 위 선택 열을 **읽기 전용 소량 조회**해 4행, 3169 UTF-8 바이트, `Published Confirmed`를 관찰했다. 이 확인은 HTTP fixture·DB 경합 테스트와 구분하며 앱 배포·회원 데이터 연결·운영 성능 인수를 뜻하지 않는다. 조회량 보장 수치나 공식 rate limit은 확인되지 않았다.

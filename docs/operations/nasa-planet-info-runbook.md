# 확정 행성 NASA 자료·한국어 설명 운영 가이드 (S15P21C206-266·267·268)

- 상태: 266·267의 격리 검증 완료. 268의 GET 저장 조회·POST 단일 후보 요청/V28 일별 한도는 백엔드 표적 36건, 프론트 타입 검사·단위 452건·빌드와 Chrome 상세 fixture 6건을 통과했다. 267 당시 `nasa-ko-v4`는 TOI-700 b 한 후보의 실제 NASA TAP·GMS 생성과 가상 회원·후보·Gold 참조의 생성형 GET·V25·V26 저장을 격리 검증했다. 첫 GET 14,554ms·즉시 캐시 GET 82ms는 **268 이전** 1회 표본이다. 실제 회원·Gold 연결, 공유/운영 DB 마이그레이션·서버 배포·268 실제 회원 화면, 새 운영 비용·지연 분포·품질 평가는 **미실행**이다. 검증 경계는 8.7절과 9절에서 구분한다.
- 대상: 서비스 백엔드 배포·DB 담당자. NASA 자료의 의미는 [266 개발 계약](../development/nasa-planet-info-266.md), 한국어 설명의 구조·검증·저장은 [267 개발 계약](../development/nasa-planet-explanation-267.md), 현재 요청·화면 연결은 [268 개발 계약](../development/nasa-planet-request-268.md)을 따른다. 이 문서는 실행 환경·확인·복구의 정본이다.
- 변경 대상: 기존 Spring 백엔드 프로세스와 PostgreSQL에 V25 NASA 자료, V26 설명, 269의 V27 봉우리 제출 제약, V28 일별 모델 시도 한도를 순서대로 적용한다. 별도 컨테이너, Python Worker, Redis 인스턴스, 벡터 DB는 필요하지 않다.

## 1. 한눈에 보는 배포 흐름

1. **왜:** 회원이 실제 매칭한 확정 후보의 NASA 수치를 재사용하고, NASA 일시 장애 때 이전 정상 자료를 보존한다. NASA 자료는 Gold·후보 판정·성과·별 발견을 수정하지 않는다.
2. **어디서:** 서비스 백엔드가 요청 시 NASA TAP에 HTTPS로 접속하고, 기존 서비스 PostgreSQL의 `nasa_planet_info`를 읽고 쓴다. 266 자체에는 공개 API가 없다. 268의 인증된 `GET /api/v1/me/stars/{ticId}/planet-explanations`는 저장 결과만 읽고, 같은 경로의 POST가 지정한 확정 후보 한 건의 내부 조회·설명을 시작한다. 실제 서버 배포와 회원 요청은 아직 검증하지 않았다.
3. **무엇을:** DB 접속과 Flyway 소유자 권한, NASA 호스트 DNS/아웃바운드 443을 확인한다. 새 NASA 설정은 전부 선택값이며 기본값은 아래 표다. 모델 키는 267 설명 생성을 승인해 활성화할 때만 필요하다.
4. **어떻게 확인:** 격리 테스트 → 적용 대상 DB의 Flyway 이력·테이블 권한 확인 → 백엔드 기동/health 확인 → 268 GET에서 외부 호출 없이 저장 상태 확인 → 권한 있는 확정 후보 한 건의 POST와 재조회·DB 행 확인 → 상세 화면 상태 확인 순서다.
5. **어떻게 복구:** 외부 장애에는 이미 저장한 `ready`를 제공하고 제한된 재시도만 한다. 필요하면 새 외부 조회를 설정으로 중지한다. V25 테이블과 기존 자료는 삭제하지 않는다.

## 2. 사전 조건과 권한

| 연결 | 필요한 조건 | 확인 이유 |
| --- | --- | --- |
| NASA | 백엔드 실행 서버의 `exoplanetarchive.ipac.caltech.edu` DNS 해석, 그 호스트로 아웃바운드 HTTPS TCP 443, 정상 TLS 검증 | 고정 TAP 주소만 사용. 프록시·방화벽·CA 설정 문제는 빈 행성 결과와 구분해야 함 |
| PostgreSQL 런타임 | 기존 `DATABASE_URL`·`DATABASE_USER`·`DATABASE_PASSWORD` 연결. 별·후보·제출·검증 참조 SELECT와 신규 테이블 SELECT/INSERT/UPDATE | 기존 Gold는 읽기만, 신규 서비스 테이블만 쓰기 |
| Flyway 소유자 | 기존 `DATABASE_MIGRATION_USER`·`DATABASE_MIGRATION_PASSWORD` 또는 분리된 소유자 접속. 새 테이블·FK·COMMENT·GRANT 생성 권한 | V25는 `planetory_app` 역할에 신규 테이블 쓰기를 부여한다. 런타임 계정이 소유자와 같으면 권한 분리 검증이 성립하지 않음 |
| Redis | 기존 세션/계산 캐시 구성만 유지 | 266은 NASA 이중 캐시를 추가하지 않음 |

NASA 공식 문서에서 **이 서비스에 적용할 호출량 제한 수치가 확인되지 않았다.** 무제한이라고 가정하지 않는다. 266의 보수적 제어는 프로세스당 동시 2건, 대상 후보별 DB 임대, 최대 64행/256 KiB, 외부 HTTP 최대 2회, 재시도 간 200ms다. 서버가 여러 대면 프로세스당 동시 수의 합이 전체 외부 동시 수가 된다. 부하 실측 전에는 이 값을 상향하지 않는다.

## 3. 환경변수 표

`application.properties`가 아래 `NASA_PLANET_INFO_*` 값을 읽는다. 로컬 직접 실행은 백엔드 프로세스 환경에, Compose 배포는 `infra/service/compose.yaml`의 `backend.environment`에 선언된 7개 변수를 통해 주입한다. 서버 `.env`에 값을 적는 것만으로 컨테이너에 전달되는 것은 아니며, 이 7개 변수는 Compose 전달 항목에 포함돼 있다. 시간값은 Spring Duration 표기(`3s`, `5m`, `1d`)이며 기본값을 바꾸고 백엔드를 다시 배포하면 **새 요청부터** 적용된다. 저장된 `next_refresh_at`은 과거 정책으로 이미 계산돼 있으므로 배포 직후 모든 행이 즉시 재조회되지는 않는다. 실제 비밀번호나 토큰 값은 이 문서에 적지 않는다.

| 변수 | 필수/비밀 | 기본값·단위 | 변경 효과와 범위 |
| --- | --- | --- | --- |
| `DATABASE_URL` | 기존 배포 필수 / 아니오 | 배포 환경에서 별도 주입하는 JDBC URL | 서비스 DB와 Flyway 대상. 잘못 지정하면 다른 DB에 V25가 적용될 수 있어 대상 확인 필수 |
| `DATABASE_USER` | 기존 배포 필수 / 아니오 | 배포 환경에서 별도 주입 | 런타임 계정. `planetory_app` 역할의 신규 테이블 권한 필요 |
| `DATABASE_PASSWORD` | 기존 배포 필수 / **예** | 기본값 없음 | 런타임 DB 인증. 비밀 저장소에서만 주입 |
| `DATABASE_MIGRATION_USER` | 분리 배포에서는 필수 / 아니오 | 미지정 시 런타임 사용자 | Flyway 소유자. 운영은 역할 분리를 확인한 뒤 지정 |
| `DATABASE_MIGRATION_PASSWORD` | 분리 배포에서는 필수 / **예** | 미지정 시 런타임 비밀번호 | Flyway 소유자 인증. 비밀 저장소에서만 주입 |
| `NASA_PLANET_INFO_ENABLED` | 선택 / 아니오 | `true`, 불리언 | `false`면 NASA 새 조회를 중지한다. 기존 `ready` 자료는 상태·조회 시각과 함께 내부 호출에 남는다. 이미 진행 중인 외부 요청을 강제 중단하지는 않음 |
| `NASA_PLANET_INFO_READY_TTL` | 선택 / 아니오 | `7d`, 기간 | 마지막 정상 자료의 재확인 간격. 사용자 결정값. NASA 최신성 보장 주기가 아님 |
| `NASA_PLANET_INFO_EMPTY_TTL` | 선택 / 아니오 | `1d`, 기간 | `not_found`·`identity_unresolved` 재확인 간격. 빈 결과를 영구 행성 부재로 취급하지 않음 |
| `NASA_PLANET_INFO_RETRY_DELAY` | 선택 / 아니오 | `5m`, 기간 | timeout·429·5xx 등 일시 실패 뒤 다음 재시도 가능 시각. 반복 실패 때 요청마다 외부 호출하지 않도록 함 |
| `NASA_PLANET_INFO_CONNECT_TIMEOUT` | 선택 / 아니오 | `3s`, 초. 허용 `>0`~`5s` | TCP/TLS 연결 제한. 초과 설정이면 앱 기동이 실패하도록 검사 |
| `NASA_PLANET_INFO_REQUEST_TIMEOUT` | 선택 / 아니오 | `6s`, 초. 허용 `>0`~`10s` | HTTP 한 번의 헤더·본문 마감. 최대 2회 시도하며 임대 길이는 이 값×2+3초. 연결 시간은 같은 요청 마감 안에 포함되고, 재시도 사이 200ms는 3초 여유에 포함 |
| `NASA_PLANET_INFO_MAX_CONCURRENT` | 선택 / 아니오 | `2`, 프로세스당 요청 수. 허용 1~8 | 한 서버의 외부 HTTPS 동시 수. 초과 요청은 `busy`로 잠시 거절하고 기존 정상 자료를 보존 |

호스트 URL, ADQL 테이블·열, 64행·256 KiB 상한, 재시도 2회는 운영 입력으로 바꾸지 않는다. 다른 호스트를 환경변수로 넣을 수 없으므로 요청값이 임의 URL이 되는 경로가 없다. 이 기능에는 NASA API 키가 없다. 267의 LLM 키·모델은 266의 필수 설정이나 V25 선행조건이 아니다.

배포 전 저장소의 Compose 파일에서 일곱 변수 이름과 기본값을 확인한다. 아래 명령은 설정 파일만 읽으며 비밀 값을 출력하지 않는다. 실제 배포 노드에서는 승인된 서버 `.env`와 Compose를 적용한 뒤 백엔드를 다시 배포해야 한다. 설정이 잘못된 경우 기동이 실패할 수 있으므로 `/actuator/health`와 5절의 DB 상태를 확인한다.

```powershell
# 저장소 루트에서 실행한다.
Select-String -Path infra/service/compose.yaml -Pattern 'NASA_PLANET_INFO_' | Select-Object -ExpandProperty Line
```

## 4. 적용 순서와 호환성

1. 대상 DB와 백업·복구 위치, 현재 `flyway_schema_history`의 최고 버전을 확인한다. 이 브랜치는 최신 `origin/develop`의 V24 다음 번호 **V25**를 선택했다. 다른 MR이 먼저 병합되면 병합 직전 번호를 다시 확인하고 새 번호로 조정한다. 적용된 V1~V24는 수정하지 않는다.
2. 운영 변경 승인을 받은 뒤 Flyway 소유자 계정으로 **V25와 `R__table_comments.sql` 설명 보완이 포함된 코드 버전**을 배포한다. 애플리케이션 시작 시 Flyway가 버전 마이그레이션 다음 반복 마이그레이션을 실행한다. `baseline`, `outOfOrder`, `repair`, `clean`으로 순서를 우회하지 않는다. 기존 앱은 V25 테이블을 사용하지 않아 새 테이블이 있어도 기존 요청 형식이 바뀌지 않는다. 새 앱은 V25가 없으면 조회 시 SQL 오류가 나므로 마이그레이션 성공을 확인한 뒤 트래픽을 보낸다.
3. 신규 테이블에는 기존 행을 backfill하지 않는다. 첫 **자격 있는 실제 요청**만 후보 행을 만든다. Gold 원본·별·후보·성과의 UPDATE/DELETE가 V25에 없다.
4. 새 테이블은 FK로 `candidates`·`stars`를 참조한다. 기존 후보를 정리해야 하는 별도 작업에서는 먼저 참조 영향을 검토해야 한다. 266에는 자동 삭제·정리 스케줄이 없다. 장기 용량·보관 상한 변경은 데이터 정책 합의 후 별도 마이그레이션으로 다룬다.

운영 DB 적용, DB 데이터 삭제, V25 되돌림 DDL은 **이번 작업에서 수행하지 않는다**. 실제 대상과 영향·백업/복원 가능성을 확인하고 실행 직전에 별도 승인받아야 한다.

## 5. 읽기 전용 사전·사후 확인 예시

아래 명령은 **PowerShell** 예시다. 빈 대괄호 값은 실제 환경에서 받은 비민감 주소로 치환하되 비밀번호를 명령줄이나 로그에 넣지 않는다. 각 확인은 해당 실행 위치에서 직접 수행한다. 운영 환경의 호스트·포트·권한·배포 완료 상태를 여기서 단정하지 않는다.

### 5.1 백엔드 실행 서버: NASA 이름과 HTTPS

목적: DNS와 아웃바운드 TCP 443을 확인한다. 예상 결과는 이름에 대한 주소와 `TcpTestSucceeded : True`다. 실패하면 NASA 빈 결과로 처리하지 말고 DNS·프록시·방화벽·TLS 경로를 확인한다.

```powershell
Resolve-DnsName exoplanetarchive.ipac.caltech.edu
Test-NetConnection exoplanetarchive.ipac.caltech.edu -Port 443
```

목적: 인증 정보 없이 NASA TAP이 작은 JSON을 돌려주는지 확인한다. 예상 결과는 `TIC 150428135`의 1~수 행과 `pl_name`이다. 이는 **읽기 전용 외부 소량 호출**이며 현재 카탈로그 내용은 바뀔 수 있다. 실패하면 HTTP 상태·프록시·TLS를 확인하고 여러 번 반복 호출하지 않는다.

```powershell
$query = "select top 5 tic_id,pl_name,soltype from ps where tic_id='TIC 150428135' and default_flag=1"
$url = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=' + [uri]::EscapeDataString($query) + '&format=json'
Invoke-RestMethod -Uri $url -TimeoutSec 15 | Select-Object tic_id, pl_name, soltype
```

### 5.2 Flyway 적용 대상 DB에 접근 가능한 관리 단말: 스키마 확인

목적: 연결 대상을 먼저 출력해 의도한 DB인지 확인한다. 아래 변수는 **주소·DB명·읽기 계정의 placeholder**이며 실제 값은 운영 절차에서 받는다. `psql`이 없으면 DB 담당자의 읽기 전용 접속 도구로 같은 SQL을 실행한다. 예상 결과는 의도한 host/database/user다. 다르면 여기서 중지한다.

```powershell
$env:PGHOST = '<db-host>'
$env:PGDATABASE = '<db-name>'
$env:PGUSER = '<read-only-user>'
psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user, inet_server_addr();'
```

목적: V25 적용 여부와 성공 표시를 읽는다. 예상 결과는 `version=25`, `success=t` 한 행이다. 없다면 앱으로 트래픽을 보내지 않고 Flyway 소유자 로그·직전 migration 실패를 확인한다. 이 명령은 migration을 실행하지 않는다.

```powershell
psql -X -v ON_ERROR_STOP=1 -c "SELECT version, description, success, installed_on FROM flyway_schema_history WHERE version='25';"
```

목적: 신규 테이블의 상태와 마지막 실패 이유를 **개인 식별 정보 없이 집계**한다. 예상 결과는 배포 직후 0건일 수도 있고, 267 별 단위 API의 실제 요청 뒤 `ready`·`not_found` 등이 증가할 수 있다. `temporarily_unavailable` 증가 때는 6절에 따라 원인을 찾는다. 실패하면 SELECT 권한·스키마 search_path·V25 적용 여부를 확인한다.

```powershell
psql -X -v ON_ERROR_STOP=1 -c 'SELECT status, last_refresh_status, count(*) FROM nasa_planet_info GROUP BY status, last_refresh_status ORDER BY status, last_refresh_status;'
```

### 5.3 배포 후 애플리케이션

백엔드 실행 서버 또는 허가된 점검 단말에서 기존 `/actuator/health`의 정상 응답을 확인한다. URL과 포트는 배포 환경의 실제 진입 경로를 사용하며 이 문서의 예시를 운영 주소로 고정하지 않는다. 실패하면 앱 기동/Flyway/DB 연결 로그를 먼저 확인한다.

```powershell
$baseUrl = '<approved-backend-base-url>'
Invoke-RestMethod -Uri "$baseUrl/actuator/health" -TimeoutSec 10
```

266 단독 배포에는 NASA 공개 경로가 없으므로 이 health 확인만으로 NASA 저장이 검증되지는 않는다. 268 백엔드를 배포한 뒤에는 Gold 공급자가 검증한 Archive 행성명 연결이 실제로 있는 시험 후보를 먼저 확인한다. 권한 있는 시험 회원이 **자신이 매칭한 확정 후보가 한 건뿐인 별**에서 GET으로 저장 상태를 읽고, 승인된 소량 실호출을 진행할 때만 같은 경로의 POST에 해당 `candidateId` 한 건을 보낸다([요청 계약](../development/nasa-planet-request-268.md#3-조회생성-요청)). 그 뒤 GET으로 정상 자료·`fetchedAt`·`refreshStatus`와 V25·V26의 같은 후보 상태를 확인한다. GET 전후에 저장 행이나 NASA·GMS 시도 수가 증가하면 읽기 전용 계약 위반이다. 다른 회원이나 미발견 TIC으로 확대 조회하지 않는다. 화면 연결은 별도 브라우저 인수다.

## 6. 증상별 대응

로그에는 `NASA PS refresh failed: candidateId=..., ticId=..., reason=...` 형태로 분류된 실패만 남긴다. NASA 응답 원문이나 인증 정보를 로그에 적지 않는다. 마지막 상태는 `nasa_planet_info.last_refresh_status`, 시각은 `last_attempt_at`·`fetched_at`·`next_refresh_at`에서 확인한다. 아래 `timeout`·`busy`·`interrupted` 등은 최근 시도 결과인 공개 응답 `refreshStatus` 또는 DB `last_refresh_status`의 값이다. 정상 원천이 없으면 별도 `sourceStatus=temporarily_unavailable`일 수 있고, 이전 정상 원천을 보존한 경우는 `sourceStatus=ready`와 최근 실패 `refreshStatus`를 함께 보여준다. 아래 재시도는 운영자가 직접 반복 호출하라는 뜻이 아니며, 설정된 다음 시각의 **다음 실제 회원 요청**에서 최대 2회만 시도한다.

| 증상/상태 | 우선 확인 | 대응과 재시도 경계 |
| --- | --- | --- |
| `timeout` | DNS·443·프록시·TLS·NASA 응답 지연, 요청 timeout 설정 | 이전 `ready` 유지. 5분 기본 대기 뒤 실제 요청에서 재시도. 상한 10초를 넘겨 설정하지 않음 |
| `rate_limited` / HTTP 429 | 외부 호출 증가, 인스턴스 수×동시 수, NASA 응답 | 즉시 대량 재시도 금지. 기존 자료 유지, 5분 기본 대기. 필요하면 기능 스위치 중지·동시 수 감축 |
| `upstream_error` / HTTP 5xx 또는 연결 실패 | NASA 상태, egress, 프록시, 응답 상태 | 이전 자료 유지, 요청당 최대 2회 후 5분 대기. 지속 시 새 호출 중지 |
| `not_found` / HTTP 200 빈 목록 또는 정확한 이름 부재 | 검증된 `external_signal_references`의 TIC·행성명, NASA PS 현재 표 | 행성 없음 확정으로 표시하지 않음. 1일 뒤 재확인. 과거 JSON은 DB에 보존하되 표시하지 않음 |
| `identity_unresolved` / `identity_changed` | Gold archive 참조가 한 후보당 하나인지, 다른 후보와 충돌하는지, NASA `soltype`·중복 기본 해 | 이름 유사도로 수동 연결 금지. Gold 식별자 정정 뒤 기존 캐시 식별자가 다르면 아래 절차로 캐시를 초기화. 자동 변경·공개 없음 |
| `invalid_response` | NASA 응답 JSON·TIC·default flag, 64행/256 KiB 상한 | 정상자료 보존. 쿼리/원천 스키마 변화 확인 후 코드·문서 같이 수정. 제한을 무턱대고 높이지 않음 |
| `busy` / 동시 상한 | 현재 인스턴스의 NASA 동시 요청 수 | 정상자료 보존, 5분 기본 지연. 실측 없이 상한을 높이지 않음 |
| `interrupted` / 조회 임대 만료 | 조회를 시작한 인스턴스 종료·응답 유실, `in_flight_until`과 최근 시도 순번 | 만료된 `pending`은 공개 `sourceStatus=temporarily_unavailable`, `refreshStatus=interrupted`로 구분한다. 새 자격 있는 POST가 다음 시도 가능 시각에 복구한다. 이미 완료한 정상 원천은 덮지 않는다 |
| DB 연결·권한·Flyway 오류 | DB 대상·V25 이력, `planetory_app` 권한, Flyway 소유자·FK | 외부 장애/빈 결과로 저장하지 않음. 새 앱 트래픽 중지, 대상·권한·migration 실패 원인 해결. `repair/clean` 임의 실행 금지 |

### 6.1 검증된 Gold 식별자 정정 뒤 `identity_changed` 복구

Gold 공급자가 후보의 TIC·Archive 행성명을 검증해 정정한 뒤, DB 담당자가 대상 DB와 `candidate_id`를 확인한다. 현재 Gold의 `source='archive'`에서 행성명이 정확히 하나이고 공백만으로 이루어지지 않았으며 다른 활성 후보와 공유되지 않는지 확인한다. 262 목업의 `nasa_exoplanet_archive`는 이 복구 대상이 아니다([266 원천 구분](../development/nasa-planet-info-266.md#2-식별자와-요청-흐름)). 기존 `nasa_planet_info`의 TIC·행성명과 다를 때만 아래 SQL을 승인된 DB 관리 접속에서 실행한다. `:candidateId`, `:previousTicId`, `:previousName`은 확인한 후보 ID와 **기존 캐시 행**의 값으로 바인딩한다. 실행 직전에는 대상·영향·복구 근거를 확인하고 승인을 받는다.

```sql
WITH verified AS (
    SELECT c.id, c.tic_id, MIN(e.external_id) AS archive_planet_name
      FROM candidates c
      JOIN external_signal_references e
        ON e.candidate_id=c.id AND e.tic_id=c.tic_id AND e.source='archive'
     WHERE c.id=:candidateId AND c.status='active' AND c.is_confirmed
     GROUP BY c.id, c.tic_id
    HAVING COUNT(DISTINCT e.external_id)=1 AND MIN(e.external_id) !~ '^[[:space:]]*$'
)
UPDATE nasa_planet_info n
   SET tic_id=v.tic_id, archive_planet_name=v.archive_planet_name,
       status='pending', normalized=NULL, source_hash=NULL, source_version=NULL,
       fetched_at=NULL, changed_at=NULL, next_refresh_at=now(),
       in_flight_until=NULL, attempt_generation=n.attempt_generation+1,
       last_refresh_status='identity_corrected'
  FROM verified v
 WHERE n.candidate_id=v.id
   AND n.tic_id=:previousTicId AND n.archive_planet_name=:previousName
   AND (n.tic_id,n.archive_planet_name) IS DISTINCT FROM (v.tic_id,v.archive_planet_name)
   AND NOT EXISTS (
       SELECT 1 FROM external_signal_references other
       JOIN candidates other_candidate
         ON other_candidate.id=other.candidate_id AND other_candidate.status='active'
        WHERE other.source='archive' AND other.tic_id=v.tic_id
          AND other.external_id=v.archive_planet_name AND other.candidate_id<>v.id
   )
RETURNING n.candidate_id, n.tic_id, n.archive_planet_name,
          n.status, n.last_refresh_status, n.attempt_generation;
```

반환 행은 **정확히 1개**여야 한다. 0개면 대상·기존 값·Gold 참조·타 후보 중복을 재확인하고 임의로 조건을 제거하지 않는다. 기존 NASA 정규화값과 해시·조회 시각을 함께 비우고 시도 순번을 올리므로, 정정 전 진행 중이던 조회가 옛 행성 자료를 다시 저장할 수 없다. 다음 자격 있는 회원 요청에서 새 식별자로 조회한다. `planetory_app`에는 `DELETE` 권한이 없으며 행 삭제로 복구하지 않는다. 이 절차는 Gold 자체를 수정하지 않는다.

## 7. 자료를 보존하는 중지·롤백

1. 외부 NASA 경로만 중지해야 하면 배포 환경에서 `NASA_PLANET_INFO_ENABLED=false`로 설정해 승인된 배포 절차로 백엔드를 재시작한다. 새 NASA 호출이 멈추며 기존 정상값은 읽을 수 있다. 한국어 설명의 새 모델 호출까지 멈추려면 8.6절의 별도 스위치도 확인한다. 268의 화면 표시 정책은 공개 API 계약을 따른다.
2. 코드 회귀가 필요하면 기존 앱 이미지로 되돌리되 **V25 테이블은 그대로 둔다**. 구 앱은 신규 테이블을 사용하지 않는다. 새 앱 재배포 시 캐시된 정상값을 다시 읽는다. 롤백 전후 DB 대상·Flyway 이력을 확인한다.
3. 자동 삭제가 없으므로 보관 자료가 누적된다. 삭제·TRUNCATE·DROP TABLE·Flyway `clean`, 공유/운영 DB 복원은 되돌리기 어렵다. 정확한 대상·영향·복구 근거를 제시해 실행 직전 별도 승인받는다. V25를 이미 적용한 DB에서 SQL 파일을 지우거나 구 버전으로 바꾸면 Flyway 검증 실패가 날 수 있으므로 적용 이력을 임의 조작하지 않는다.

2026-09-25 검증은 일회용 PostgreSQL·로컬 HTTP fixture와 NASA 소량 읽기뿐이다. 운영 지연·호출량·DB 증가량·배포 완료 여부는 아직 측정하지 않았다.

## 8. 한국어 설명 생성 배포·운영 (267)

### 8.1 기능 경계와 선행 조건

267은 **266이 `ready`로 확인한 내부 후보 하나의 NASA 정규화 자료**를 입력으로 사용한다. 같은 Spring 백엔드 안에서 구조화된 한국어 설명을 만들고 검증한 뒤 서비스 PostgreSQL에 저장한다. 설명 실패는 원래 NASA 수치, Gold 분류, 성과와 회원의 행성 목록을 바꾸지 않는다. 267은 인증된 별 단위 공개 API를 처음 제공했고, 268은 그 GET을 저장 조회 전용으로 바꾸고 POST 단일 후보 요청·상세 화면을 연결한다. `nasa-ko-v3`부터 시민용 문장에서는 측정 오차 수치와 부호를 빼지만 266의 원천 오차 자료와 검증은 보존한다. 현재 v4는 다섯 문장을 친근한 말투로 이어 읽되 같은 후보의 NASA 확인 사실만 말한다. 과거 v2·v3 저장 설명은 다음 자격 있는 POST에서 재생성하며, 재생성 실패 시 구 문장을 표시하지 않는다. FP 후보는 행성 설명 대상에서 제외하고, 별도 근거 없이 먼지라고 단정하지 않는다. 입력·검증·재사용의 세부 계약은 [267 개발 계약](../development/nasa-planet-explanation-267.md)을 따른다.

| 선행 항목 | 담당자가 확인할 것 | 확인 이유 |
| --- | --- | --- |
| 266과 Gold 연결 | V25 적용 성공, 시험 후보의 검증된 `archive` 행성명 연결, 266의 `ready` 자료 | 빈 자료·식별 불명확·다른 회원의 행성을 설명하지 않기 위해서다 |
| PostgreSQL | V26 적용 권한을 가진 Flyway 소유자와 별도 런타임 계정의 설명 테이블 권한 | 설명은 원천과 분리해 저장하며 Gold에 쓰지 않는다 |
| GMS 네트워크 | 백엔드 실행 서버에서 `gms.ssafy.io` DNS, 아웃바운드 TCP 443, 정상 TLS 검증 | 모델 호출 실패를 설명 데이터의 결측과 구분하기 위해서다 |
| GMS 이용 권한 | 보호된 배포 환경에 `GMS_KEY`를 주입할 수 있는 경로, 호출 예산·요금·쿼터 확인 | 운영 환경의 유료 실호출은 별도 승인 뒤 소량 평가로 시작한다 |

모델 연동 기본 주소는 `https://gms.ssafy.io/gmsapi/api.openai.com/v1`, 선택 모델은 `gpt-5.4-mini`다. 2026-09-25 별도 1회 형식 확인에 이어 일회성 격리 백엔드 시험에서 실제 NASA PS·GMS를 통한 별 단위 설명을 v2·v3 각각 4건 확인했다. v4도 TOI-700 b 한 후보의 직접 생성·검증과 가상 회원·Gold 참조의 인증 별 단위 GET 4건 및 V25·V26 저장을 확인했다. 이 시험은 실제 회원·Gold 연결, 운영 쿼터나 실제 청구액의 검증이 아니다. 운영 활성화 전에는 보호된 배포 환경의 모델 권한과 결제·쿼터 정책을 확인한다. 자격 증명의 실제 값은 파일·명령줄·로그·문서에 적지 않는다. NASA `pl_refname`·`disc_refname`에는 HTML 조각이 있을 수 있으므로 운영 점검에도 그 원문을 출력하지 않는다.

### 8.2 설명 생성 설정과 주입 위치

설명 생성 설정은 백엔드의 `apps/backend/src/main/resources/application.properties`가 읽는다. 로컬 직접 실행은 백엔드 프로세스 환경에, 컨테이너 실행은 `infra/service/compose.yaml`의 `backend.environment`를 통해 주입한다. 서버에서는 보호된 배포 환경의 값만 사용한다. 시간은 Spring Duration 표기(`8s`, `1h`), 동시 수와 출력 토큰은 양의 정수다. **기본값은 설명 생성 비활성**이며 `GMS_KEY` 없이 기동한다. 변수 이름만 확인하고 실제 키 값은 화면·문서·명령 출력에 노출하지 않는다.

| 환경변수 | 기본값·단위 | 목적과 적용 조건 |
| --- | --- | --- |
| `NASA_EXPLANATION_ENABLED` | `false`, 불리언 | 267 내부 설명 생성 스위치. `false`는 새 모델 호출을 만들지 않는다. 266의 NASA 수치 조회 스위치와 별개다 |
| `NASA_EXPLANATION_CHAT_MODEL` | `none`, Spring AI 채팅 공급자 선택 | 키 없는 기본 기동에서는 자동 모델 생성을 끈다. 승인된 활성화 때 `openai`로 설정해 GMS의 OpenAI 호환 API를 사용한다 |
| `GMS_KEY` | 없음, **비밀 문자열** | 활성화 때만 보호된 비밀 저장소에서 백엔드에 주입한다. `application.properties`·`.env` 예시·명령줄·로그에 실제 값을 두지 않는다 |
| `NASA_EXPLANATION_MODEL` | `gpt-5.4-mini`, 모델 식별자 | 생성 모델과 저장 결과의 모델 버전을 정한다. 변경 시 이전 모델의 설명을 그대로 재사용하지 않고 새 검증 결과를 만든다 |
| `NASA_EXPLANATION_MAX_OUTPUT_TOKENS` | `320`, 출력 토큰/모델 시도. 허용 64~512 | 모델의 응답 길이 상한이다. 입력 토큰·전체 비용 상한을 뜻하지 않는다 |
| `NASA_EXPLANATION_TIMEOUT` | `8s`, 모델 시도당 시간. 허용 `>0`~`20s` | GMS 응답 대기 마감이다. 지연이 나더라도 긴 DB 트랜잭션을 유지하지 않는다 |
| `NASA_EXPLANATION_MAX_CONCURRENT` | `1`, 백엔드 프로세스당 모델 요청 수. 허용 1~4 | 한 인스턴스의 유료 호출 동시 수를 제한한다. 인스턴스가 여러 개면 전체 상한은 인스턴스 수에 따라 늘어난다 |
| `NASA_EXPLANATION_RETRY_DELAY` | `1h`, 실패 뒤 시간. 허용 `1m`~`1d` | 같은 원천·모델·프롬프트의 실패 뒤 다음 실제 POST에서 재시도할 수 있는 최소 간격이다 |
| `NASA_EXPLANATION_DAILY_PER_MEMBER` | `0`, UTC 날짜별 모델 시도권/회원. 허용 0~1,000 | 승인된 수치가 없어 기본값은 새 유료 시도를 차단한다. 활성화 전 양의 정수를 명시 주입한다. GET·재사용 POST·NASA 시도는 세지 않는다 |
| `NASA_EXPLANATION_DAILY_GLOBAL` | `0`, UTC 날짜별 모델 시도권/전체. 허용 0~100,000 | 승인된 수치가 없어 기본값은 새 유료 시도를 차단한다. 활성화 전 양의 정수를 명시 주입한다. 다중 백엔드 인스턴스를 합친다 |

유료 설명 생성을 활성화할 때는 기동 전에 `NASA_EXPLANATION_ENABLED=true`, `NASA_EXPLANATION_CHAT_MODEL=openai`, 비어 있지 않은 `GMS_KEY`, 승인된 양의 정수 `NASA_EXPLANATION_DAILY_PER_MEMBER`와 `NASA_EXPLANATION_DAILY_GLOBAL`을 한 조합으로 확인한다. 한도 수치는 아직 미지정이므로 예시 숫자를 운영 정책으로 복사하지 않는다. 활성화한 상태에서 모델 연결·키가 빠지거나 한도 둘 중 하나가 0이면 설명 기능만 꺼지는 것이 아니라 **백엔드 전체 기동이 실패한다**. 설정을 바로잡을 수 없다면 `NASA_EXPLANATION_ENABLED=false`로 되돌려 기동한다. 키 값 자체는 확인 화면이나 로그에 출력하지 않는다.

기본 비활성 상태에서도 268 GET은 원천 미생성 후보를 `status/sourceStatus=not_requested`로 읽기만 한다. 권한 있는 한 후보 POST는 `NASA_PLANET_INFO_ENABLED=true`이면 NASA 원천을 수집할 수 있으며, 성공하면 `sourceStatus=ready`, `status=disabled`와 검증된 수치 `facts`를 반환한다. 이때 GMS를 호출하거나 V28 모델 시도권을 예약하지 않는다. NASA 조회까지 멈추려면 266의 별도 `NASA_PLANET_INFO_ENABLED=false`를 설정해야 한다. 두 스위치는 저장 행을 삭제하지 않는다.

승인된 서버 `.env`에만 넣는 활성화 형식은 다음과 같다. `<...>`는 실제 승인값으로 바꾼 뒤 적용해야 하며, 이 예시 자체를 실행하지 않는다. `GMS_KEY`의 값은 서버의 보호된 주입 경로에서만 전달하고 저장소·로그·화면에 남기지 않는다. Compose의 `backend.environment`가 이 이름들을 컨테이너로 전달한다. 적용 뒤에는 Backend를 재배포하고 `/actuator/health`와 8.4절 V28 집계를 확인한다.

```dotenv
NASA_EXPLANATION_ENABLED=true
NASA_EXPLANATION_CHAT_MODEL=openai
NASA_EXPLANATION_DAILY_PER_MEMBER=<approved-positive-per-member-limit>
NASA_EXPLANATION_DAILY_GLOBAL=<approved-positive-global-limit>
GMS_KEY=<approved-secret-value>
```

GMS 기본 주소는 `https://gms.ssafy.io/gmsapi/api.openai.com/v1`로 고정한다. Spring AI의 자동 HTTP 재시도는 `spring.ai.openai.max-retries=0`으로 꺼 두고, 설명 저장 상태가 관리하는 시도만 사용한다. 같은 `sourceHash`·`sourceVersion`·모델·프롬프트 버전당 **최대 3회**가 코드 상한이며, 실패 후 기본 1시간을 기다린다. 이 횟수와 프롬프트 버전은 운영 환경변수로 임의 증폭하지 않는다. V28의 하루 한도는 **외부 모델 호출 직전 시도권을 예약할 때** DB에서 회원별·전체를 원자적으로 증가시키며, 두 상한 중 하나라도 다 차면 새 모델 시도를 시작하지 않는다. 예약 뒤 모델 실패나 권한 철회가 있어도 비용 가능성이 있으므로 카운터를 되돌리지 않는다. 중복 요청과 저장 결과 재사용은 예약하지 않는다. 사용자 탈퇴로 회원별 기록이 정리돼도 날짜별 전체 예약 수는 별도 테이블에 남는다. 이 수치는 GMS 공급자 요금·쿼터의 대체물이 아니다. 모델 가격, GMS 계정 쿼터, 월 지출 한도는 공개 자료로 확인되지 않았으므로 활성화 전 운영자가 계정의 **유한한 쿼터·지출 한도**를 설정·확인한다. 수치가 확정되지 않으면 비활성 상태를 유지한다.

### 8.3 안전한 적용 순서

1. **대상을 확인한다.** 5.2절의 DB 식별 조회로 적용 대상이 맞는지 확인하고, Flyway 이력에서 V25·V26·269의 V27이 성공했는지 읽는다. 미적용 DB에는 V25→V26→V27→V28을 순서대로 적용해야 한다. 이미 적용된 버전 SQL 파일은 수정하지 않는다. 269의 V27은 봉우리 제출 제약을 수정하며 설명 한도 테이블은 V28에서 만든다.
2. **스키마를 먼저 준비한다.** 승인된 배포 절차에서 Flyway 소유자 권한으로 미적용 버전의 V25 NASA 원천, V26 설명, 269의 V27 봉우리 제출 제약, V28 일별 시도 집계를 번호대로 적용한다. V28은 회원별 `nasa_explanation_daily_usage`와 탈퇴 뒤에도 전체 호출 수를 보존하는 `nasa_explanation_daily_total`을 만든다. 반복 마이그레이션 `R__table_comments.sql`에는 두 테이블의 설명을 포함하며, V28 이전 스키마에서는 테이블이 있을 때만 설명한다. 런타임 계정에는 이 두 테이블과 설명 테이블의 필요한 SELECT·INSERT·UPDATE만 부여하고 DELETE는 부여하지 않는다. `baseline`·`outOfOrder`·`repair`·`clean`으로 순서를 우회하지 않는다. 기존 V25·V26 행이나 Gold 데이터를 backfill·수정하지 않는다.
3. **설명 기능을 끄고 기동한다.** 설명 생성 스위치를 기본 비활성으로 두고 `GMS_KEY`를 주입하지 않은 상태에서 새 백엔드의 기동과 `/actuator/health`를 확인한다. 이 단계에서 GMS 네트워크 연결이나 유료 모델 호출은 필요하지 않아야 한다. NASA 조회 스위치와 설명 생성 스위치는 별개다. 비활성이어도 266의 `ready` 수치 조회는 유지된다.
4. **설정·예산을 확인한다.** 사용하기로 한 비밀 저장소에서 백엔드 프로세스에 `GMS_KEY`를 전달한다. 컨테이너 배포라면 `infra/service/compose.yaml`의 `backend.environment`를 거쳐 컨테이너 안으로 전달되는지 **변수 이름·존재 여부만** 확인한다. 계정의 유한 쿼터·지출 한도와 320 출력 토큰, 8초 timeout, 프로세스당 동시 1건, 실패 뒤 1시간, 같은 입력 최대 3회 및 자동 재시도 0회를 점검한다. 승인된 회원별·전체 UTC 일별 한도를 각각 양의 정수로 지정한다. 두 기본값 0을 그대로 둔 채 설명을 켜면 백엔드 기동이 실패해야 한다. 실제 키를 `docker compose config`, 환경 덤프 또는 진단 로그에 출력하지 않는다.
5. **유료 실호출 승인 뒤 소량 활성화한다.** 예산과 관찰 대상을 정한 뒤 `NASA_EXPLANATION_CHAT_MODEL=openai`와 `NASA_EXPLANATION_ENABLED=true`를 함께 적용한다. 모델은 `gpt-5.4-mini`를 사용한다. 권한 있는 시험 회원이 **본인이 매칭한 확정 후보가 한 건뿐인 별**에서 GET으로 미생성 상태를 확인하고, 승인된 후보 ID 한 건의 POST를 보내 생성 결과·토큰 사용량·비용을 측정한다. 다시 GET으로 저장 결과를 확인하며 외부 호출이 늘지 않아야 한다. 268 화면 연결·표시는 별도로 확인한다. 임의 후보 목록을 미리 돌거나 같은 결과를 반복 호출하지 않는다.

일회성 격리 시험의 실제 GMS 호출은 공유·운영 DB에 V26을 적용하거나 서버를 배포한 검증이 아니다. 대상 환경에서 활성화할 때에는 영향·비용을 확인해 해당 운영 승인 절차를 따른다.

### 8.4 읽기 전용 사전·사후 점검

아래 예시는 실제 DB·서버에 접속할 권한이 있는 담당자가 승인된 점검 단말에서 사용한다. `<...>`는 비민감 주소나 읽기 계정의 자리표시자다. 비밀번호는 명령줄 인자에 넣지 않고 기존 비밀 주입 절차를 따른다.

1. **GMS 경로의 기본 연결만 확인한다.** 백엔드 실행 서버에서 다음 명령의 DNS 주소와 `TcpTestSucceeded : True`를 기대한다. 이는 **유료 API 호출이 아니며** 키 유효성·모델 응답·비용을 검증하지 않는다. 실패하면 DNS·방화벽·프록시·TLS 경로를 확인하고 설명 기능은 비활성으로 둔다.

   ```powershell
   Resolve-DnsName gms.ssafy.io
   Test-NetConnection gms.ssafy.io -Port 443
   ```

2. **DB 대상과 Flyway 순서를 읽는다.** 5.2절처럼 `PGHOST`, `PGDATABASE`, `PGUSER`를 올바른 읽기 전용 대상으로 지정한 뒤 실행한다. 기대 결과는 의도한 DB명·계정 및 `25`, `26`, `27`, `28` 각각 `success=t`다. 버전 하나가 없거나 실패했다면 설명 기능을 켜지 않는다.

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user, inet_server_addr();'
   psql -X -v ON_ERROR_STOP=1 -c "SELECT version, description, success FROM flyway_schema_history WHERE version IN ('25','26','27','28') ORDER BY version::int;"
   ```

3. **설명 테이블 권한·상태를 집계한다.** 신규 테이블의 앱 역할 권한 조회는 `SELECT/INSERT/UPDATE=true`, `DELETE=false`를 기대한다. 상태 집계는 배포 직후 0건일 수 있다. 268 POST의 실제 요청 뒤 `ready`가 늘어도 현재 NASA 원천과 맞는 설명만 소비한다. 저장된 과거 설명은 원천 변경 시 남을 수 있으므로, 아래 `stale_ready`가 0보다 크다고 즉시 삭제하지 않는다. 해당 집계는 설명 본문·후보 ID·키를 출력하지 않는다.

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -c "SELECT has_table_privilege('planetory_app','nasa_planet_explanation','SELECT') AS can_read, has_table_privilege('planetory_app','nasa_planet_explanation','INSERT') AS can_insert, has_table_privilege('planetory_app','nasa_planet_explanation','UPDATE') AS can_update, has_table_privilege('planetory_app','nasa_planet_explanation','DELETE') AS can_delete;"
   psql -X -v ON_ERROR_STOP=1 -c 'SELECT status, count(*) FROM nasa_planet_explanation GROUP BY status ORDER BY status;'
   psql -X -v ON_ERROR_STOP=1 -c "SELECT count(*) FILTER (WHERE e.status='ready' AND n.status='ready' AND e.source_hash=n.source_hash AND e.source_version=n.source_version) AS same_source_ready, count(*) FILTER (WHERE e.status='ready' AND (n.status<>'ready' OR e.source_hash<>n.source_hash OR e.source_version<>n.source_version)) AS stale_ready FROM nasa_planet_explanation e JOIN nasa_planet_info n USING (candidate_id);"
   ```

4. **V28 한도 테이블을 읽는다.** 앱 역할은 두 테이블에 SELECT/INSERT/UPDATE가 있고 DELETE는 없어야 한다. 일별 전체 예약 수와 회원별 최대 예약 수를 **식별자 없이** 집계한다. 활성화 전에는 행이 없어도 정상이다. 모델 호출 직전 예약 뒤 실제 호출 실패나 권한 철회가 있어도 비용 가능성이 있으므로 카운터를 되돌리지 않는다. 두 수치를 현재 설정의 하루 상한과 비교하고, 초과하거나 계속 증가하면 POST와 모델 로그의 분류된 상태를 확인한다. 회원 탈퇴로 회원별 행이 사라져도 전체 테이블 행은 보존된다.

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -c "SELECT n, has_table_privilege('planetory_app',n,'SELECT') AS can_read, has_table_privilege('planetory_app',n,'INSERT') AS can_insert, has_table_privilege('planetory_app',n,'UPDATE') AS can_update, has_table_privilege('planetory_app',n,'DELETE') AS can_delete FROM (VALUES ('nasa_explanation_daily_usage'),('nasa_explanation_daily_total')) AS t(n);"
   psql -X -v ON_ERROR_STOP=1 -c 'SELECT usage_day, attempt_count AS global_attempts FROM nasa_explanation_daily_total ORDER BY usage_day DESC LIMIT 7;'
   psql -X -v ON_ERROR_STOP=1 -c 'SELECT usage_day, MAX(attempt_count) AS max_member_attempts FROM nasa_explanation_daily_usage GROUP BY usage_day ORDER BY usage_day DESC LIMIT 7;'
   ```

5. **앱 기동을 읽기 전용으로 확인한다.** 5.3절과 같이 승인된 백엔드 진입 주소에 `/actuator/health`를 요청한다. 기대 결과는 기존 서비스와 같은 정상 health다. 이 응답만으로 설명 생성·GMS 연결·요금 상한을 검증했다고 판단하지 않는다.

### 8.5 장애 대응과 호출 비용

| 증상 | 먼저 확인할 것 | 대응 |
| --- | --- | --- |
| 키 없이 비활성 기동 실패 | 설명 스위치와 Spring AI 모델 자동 설정, 앱 시작 예외 | 설명 기능을 비활성으로 유지하고 설정 오류를 고친다. 키 값을 로그에 붙여 넣지 않는다 |
| GMS 연결/인증 오류, timeout, HTTP 429/5xx | DNS·443·TLS, 키의 **존재 여부**, 모델 접근 권한·쿼터, 8초 마감 시간 | NASA 정상 자료는 유지한다. 설명만 같은 원천·모델·프롬프트당 최대 3회, 실패 뒤 기본 1시간 간격으로 시도한다. 429 때는 기능을 끄고 쿼터·요금·응답을 확인한다 |
| 응답 JSON·행성·숫자·단위 검증 실패 | 모델 버전·프롬프트 버전, 정규화 원천 해시, 실패 분류 | 부정확한 설명은 저장·표시하지 않는다. 원문 응답을 로그에 남기지 않고 격리 fixture로 재현한다 |
| 원천이 생성 중 바뀌거나 늦은 결과가 도착 | V25의 `source_hash`·`source_version`, 설명 시도 순번·임대 | 이전 원천의 설명이 최신 자료에 붙지 않는지 확인한다. 다음 자격 있는 요청에서 최신 원천만 다시 생성한다 |
| 설명은 있는데 표시되지 않음 | 266 상태가 `ready`인지, 저장된 원천 해시·버전과 현재 V25 행이 같은지 | 서로 다르면 과거 설명을 보여주지 않는다. NASA 재확인과 설명 생성을 각각의 상태로 진단한다 |
| 일별 시도 한도 도달 | V28 전체·회원별 UTC 날짜 집계, 현재 상한 설정, 인스턴스 수 | 기존 NASA 수치·설명과 `ready/pending`은 유지한다. 새 설명이 필요한 POST에는 `quota_exceeded`·`daily_limit`과 다음 UTC 자정 `retryAt`을 돌려주며 새 V26 `pending`은 만들지 않는다. 이 상태는 저장하지 않아 다음 GET은 이전 설명 상태로 돌아간다. 한도를 우회하려고 집계 행을 비우지 않는다. 다음 UTC 날짜 또는 승인된 설정 조정 뒤에만 새 모델 시도를 허용한다 |
| Flyway·DB 권한 오류 | V25→V26→V27→V28 성공 이력, 신규 테이블 권한, 대상 DB | 설명 기능을 끄고 마이그레이션·권한을 바로잡는다. NASA 자료 오류로 위장하거나 `repair/clean`을 임의 실행하지 않는다 |

재시도는 **POST의 설명 생성 요청에만** 적용하며 NASA 재확인 주기와 독립이다. GET은 저장 결과만 읽고 모델 시도 수를 늘리지 않는다. POST도 같은 원천 해시·원천 구조 버전·모델·프롬프트 버전의 검증된 결과가 있으면 재사용한다. 호출 중에는 장시간 DB 트랜잭션을 잡지 않으며, 동시 요청은 DB 임대와 시도 순번으로 중복·늦은 저장을 제한한다. 다중 서버에서는 설정된 **프로세스당** 동시 상한의 합이 전체 외부 동시 수가 된다. V28의 전체 하루 시도 수는 DB에서 함께 제한한다.

같은 원천·모델·프롬프트 조합은 최초 1회와 재시도 최대 2회이므로 설정값 기준 모델 출력 상한의 합은 **320×3=960 completion tokens**다. 이는 그 조합에서의 출력 상한일 뿐이다. 입력 토큰, 원천·모델·프롬프트 변경 뒤의 새 조합, 후보 수, 인스턴스 수, 공급자 요금까지 포함한 **원화 예산의 자동 차단**으로 간주하지 않는다. 비용 수치는 실제 GMS 청구 기준과 운영 대상 환경의 소량 평가에서 확인하기 전까지 확정하지 않는다. 미승인 상태에는 설명 기능을 비활성으로 둔다.

3회가 모두 실패하면 같은 조합의 자동 재시도는 멈추고 내부 결과의 `retryAt`은 비어 있다. 모델·프롬프트 결함을 수정한 새 버전이나 새 NASA 원천이 들어오면 별도 조합으로 다시 시도한다. 횟수 열을 임의로 초기화해 반복 호출하지 않는다.

로그와 점검 결과에 `GMS_KEY`·Authorization 헤더, 프롬프트 전문, 모델 원문 응답, NASA 문헌 HTML, 회원 개인정보를 남기지 않는다. 상태 코드·분류된 실패 이유·시도 시각·집계 건수처럼 복구에 필요한 최소 정보만 본다. 모델 응답의 토큰 메타데이터가 있으면 집계 로그에 기록하고, 없으면 `unavailable`로 구분한다. 토큰 집계는 청구서나 원화 비용 확인을 대신하지 않는다. 원천 숫자와 설명 본문을 로그에 덤프하지 않는다.

### 8.6 중지·복구와 롤백 한계

GMS 장애·비용 초과 우려에는 설명 생성 스위치를 비활성으로 바꿔 승인된 배포 절차로 재시작한다. 새 유료 호출을 중지하되 V25 정상 수치와 V26의 이전 검증 설명을 삭제하지 않는다. 이미 시작한 호출은 스위치 변경만으로 즉시 취소되지 않을 수 있으므로 호출 마감까지 관찰한다. 설명 재개 전에는 키 권한·네트워크·쿼터와 실패 간격을 확인하고 한 후보로 소량 재검증한다.

코드 롤백은 **V28 적용 이력을 보존하는 빌드**와 호환성을 확인하고 수행한다. V28이 적용된 DB에서 마이그레이션 파일을 제거하거나 V25·V26·V27·V28 파일을 수정하면 Flyway 검증에 실패할 수 있다. 신규 테이블을 삭제하거나 설명·일별 시도 행을 일괄 수정/비우는 것은 자료 손실 또는 한도 우회를 수반하므로 자동 복구 절차로 두지 않는다. 실제 대상·영향·복원 근거를 확인하고 실행 직전 별도 승인받는다. 266의 Gold 식별자 정정 SQL은 V25 원천을 비우므로 이후 설명은 원천 해시 불일치로 숨겨져야 하며, 설명 행을 새 행성의 설명으로 재연결하지 않는다.

### 8.7 현재 검증과 남은 인수

267의 후보별 단위·격리 DB 검증은 모델 stub로 형식·사실·한계값·오류·원천 변경·저장 재사용을 확인했다. 별 단위 공개 API는 격리 HTTP·실제 세션 경계를 검증했다. 과거 일회성 `StarPlanetExplanationLiveTest`는 Testcontainers PostgreSQL·Redis의 가상 회원·후보와 `TOI-700 b/c/d/e` Gold `archive` 참조에서 인증 GET으로 실제 NASA PS·GMS를 호출해 4/4 항목의 `ready`와 다섯 설명 필드를 확인했다(JUnit 1/1). 임시 테스트 소스는 삭제했고 응답은 Git에서 제외된 `apps/backend/build/reports/planet-explanations-live.json`에 남겼다. 이 파일은 오차 문구가 남을 수 있는 **과거 v2 표본**이므로 v3 표시 인수 기준으로 사용하지 않는다.

`nasa-ko-v3`도 같은 격리 구성과 TIC `150428135`의 가상 참조 네 개로 일회성 재검증했다. 실제 NASA PS·GMS `gpt-5.4-mini`를 이용한 인증 GET에서 4/4 항목이 `kind=confirmed`, `status=ready`, `sourceStatus=ready`와 다섯 설명 필드를 갖췄다. 시민용 주기·반지름 등의 문장에는 측정 오차나 `+/-` 수치가 없었고 V26 `prompt_version` 네 행은 모두 `nasa-ko-v3`였다(JUnit 1/1, 실패·오류·건너뜀 0건, `BUILD SUCCESSFUL`). 임시 테스트 소스는 삭제했고 v3 응답은 별도 Git 제외 파일 `apps/backend/build/reports/planet-explanations-live-v3.json`에 남겼다. **실제 회원·Gold 연결, 모델별 운영 비용/품질·지연 평가, 공유/운영 DB 적용, 서버 배포와 268 회원 화면 인수는 수행하지 않았다.** 268은 사용자에게 원천 시각과 설명 상태를 구분해 표시한다.

`nasa-ko-v4`는 후보별 설명 11건·별 단위 HTTP 2건의 초기 모델 stub 표적 회귀를 통과했고, 문장 누락 검사를 추가한 뒤 후보별 설명 12건도 통과했다(`BUILD SUCCESSFUL`). 별도 일회성 `NasaV4LiveProbeTest`는 TOI-700 b 한 후보를 실제 NASA TAP에서 조회하고 Spring AI GMS `gpt-5.4-mini` 생성기·서버 문장 검증을 통과해 현행 `nasa-ko-v4`의 다섯 시민용 문장을 확인했다(JUnit 1/1, 실패 0건). Git 제외 응답은 `apps/backend/build/reports/planet-explanations-live-v4.json`에 보관한다. 이 직접 시험은 인증된 별 단위 GET, 회원·Gold 연결, V26 저장을 거치지 않았다. 앞의 v2·v3 응답 파일은 이전 문장 계약의 검증 기록이다.

같은 날 별도의 일회성 `NasaV4FullTimingProbeTest`는 Testcontainers PostgreSQL·Redis, TIC `150428135`의 가상 회원·후보 4개, `TOI-700 b/c/d/e` Gold `archive` 참조로 인증된 MockMvc 별 단위 GET을 실행했다. 실제 NASA TAP·GMS `gpt-5.4-mini`를 사용한 **첫 GET 14,554ms**, 곧바로 반복한 **캐시 GET 82ms**를 측정했다. 두 응답 모두 4/4 `kind=confirmed`, `status=ready`, `sourceStatus=ready`였고 V25·V26 캐시가 각각 4행이었다(JUnit 1/1, `BUILD SUCCESSFUL`). 임시 테스트 소스는 삭제했고 Git 제외 결과는 `apps/backend/build/reports/planet-explanations-v4-timing.json`에 남겼다. 격리 환경의 1회 표본이며 운영 또는 브라우저 응답 지연을 뜻하지 않는다. Gradle 전체 약 57초와 JUnit suite 40.954초는 GET 지연에 포함하지 않는다. 실제 회원·Gold 연결, 공유·운영 DB 적용과 서버 배포, 268 화면 인수, 운영 지연 분포·품질·청구액은 확인하지 않았다.

## 9. 268 상세 화면 연결의 운영 인수 경계

268은 기존 회원의 별 상세 `planets.items`에 있는 **수치 매칭 확정 후보**의 NASA 수치·설명을 요청하고 재사용하는 흐름과 그 상태를 상세 패널에 연결한다. 같은 항성의 NASA 전체 행성 목록은 270 백엔드와 271 결과 화면의 별도 범위다. 따라서 268을 배포해도 기존 별 상세의 개인 행성 개수와 지도 공전 대상이 NASA 카탈로그 개수로 늘어나면 안 된다. 검증된 Gold `archive` 참조가 없거나 262 목업처럼 다른 TIC에 복사된 참조만 있으면 NASA `ready`를 기대하지 않는다. GET은 저장 상태 조회, POST 본문 `{ "candidateId": "c-401" }`은 현재 확정 후보 한 건의 동기 생성·재사용 요청이다. 프론트 POST 대기는 30초이고, 설정상 NASA 조회 2회에 각 최대 10초와 설명 생성 최대 20초를 순서대로 수행할 수 있으므로 서버 처리가 30초를 넘을 수 있다. 30초에 응답이 없거나 연결이 끊겨도 외부 호출 실패로 단정하지 않는다. 자동 POST 재전송 없이 GET으로 저장 상태를 확인하고 `pending`이면 GET으로 다시 확인한다. 그래도 결과가 없어 새 요청이 필요하면 사용자의 다음 요청 동작에 맡긴다. 중복 요청이 들어와도 백엔드 DB 임대·시도 순번으로 같은 작업의 중복 유료 호출과 늦은 저장을 제한한다.

| 점검 단계 | 실행·확인 | 정상 기준과 중지 조건 |
| --- | --- | --- |
| 배포 대상 | 5.2절의 DB 식별 결과, 8.4절의 V25·V26·V27·V28 성공 이력, 적용할 이미지·Compose 버전을 확인한다 | 대상 DB가 다르거나 Flyway 실패가 있으면 트래픽을 보내지 않는다. 적용된 V25·V26·V27·V28 파일은 고치지 않는다 |
| 설정 전달 | 저장소 루트에서 아래 Compose 설정 검사를 실행하고, `backend.environment`의 일곱 `NASA_PLANET_INFO_*` 변수와 아홉 `NASA_EXPLANATION_*` 변수·`GMS_KEY` 항목을 확인한다 | 기본 비활성 설명 설정에서도 구성 검사가 통과해야 한다. 비밀 값은 출력하지 않는다 |
| 기본 기동 | 보호된 서버 환경의 설정으로 백엔드를 배포한 뒤 5.3절 `/actuator/health`와 8.4절의 테이블 권한·상태 집계를 확인한다 | 건강 상태만으로 NASA·GMS 호출 성공을 주장하지 않는다. 스키마·권한·세션 장애를 외부 자료 부재로 처리하지 않는다 |
| 자격 있는 표본 | 운영 승인과 호출 예산 확인 뒤, 검증된 Gold 행성명이 붙은 **본인 제출의 확정 후보 한 건**으로 실제 요청·재조회·화면 표시를 확인한다 | 후보 ID, TIC, 지도 `version`이 같아야 한다. 다른 회원·미발견 별·권한 철회·별 전환의 이전 응답은 노출하지 않는다 |
| 실패·복구 | NASA timeout/429, GMS 실패, POST 30초 초과·응답 유실, 재시작 중 임대 만료와 중복 요청을 격리 환경에서 확인한다 | GET 재조회로 저장 결과를 확인하고 `pending`에는 조회만 반복한다. 마지막 정상 NASA 원천과 시각은 보존한다. 설명 실패를 행성 부재로 바꾸지 않는다. 새 외부 호출이 반복되면 두 기능 스위치와 임대·시도 상태를 확인한다 |

```powershell
# 저장소 루트: 비밀 값을 화면에 출력하지 않는 구성 문법 검사다.
Push-Location infra/service
docker compose config -q
Pop-Location
```

배포는 [EC2 서비스 배포](../../infra/service/README.md#배포와-롤백)의 최신 `develop` 수동 Backend/Frontend job을 따른다. 해당 job은 Backend 교체 전 DB 덤프와 `/actuator/health` 확인을 하며, Frontend는 `/health/renderer-enabled`로 렌더러 포함 여부를 확인한다. 화면 검증은 배포 후 **권한 있는 시험 회원의 실제 브라우저**에서 별 상세를 열어 수행한다. 버튼에서 어떤 HTTP 요청을 내는지, 저장 결과를 재사용할 때 외부 호출이 없는지, 로딩·부분 성공·없음·실패·재시도와 출처·시각이 구별되는지를 함께 확인한다. 기존 v4 14,554ms/82ms 측정은 격리 환경의 이전 GET 경로 한 번의 표본이며 새 화면 지연이나 운영 예산의 기준값으로 사용하지 않는다.

실제 운영 DB의 V25·V26·V27·V28 적용, 유료 GMS 활성화, 회원·Gold 식별자 연결, 실제 회원의 배포 브라우저 화면 왕복, 장기 비용·호출량·지연 분포는 각각 대상 환경에서 확인해야 한다. 실패 시 `NASA_EXPLANATION_ENABLED=false`로 새 모델 호출을 중지하고, 필요하면 `NASA_PLANET_INFO_ENABLED=false`로 새 NASA 조회도 중지한다. 두 설정은 기존 정상 행을 삭제하지 않으며 이미 시작된 호출을 즉시 취소하지는 않는다. 스위치 변경 뒤에는 백엔드를 다시 배포하고 상태를 확인한다.

268의 현재 로컬 검증은 백엔드 StarPathHttp 8건·StarPlanetExplanationHttp 4건·NasaPlanetInfo 8건·NasaPlanetExplanation 16건으로 **36건 실패 0건**이다. 269의 V27과 268의 V28을 함께 둔 백엔드 5종 통합 검증은 이 36건에 `SubmissionTest` 37건을 더해 **73/73 통과**했다. 프론트는 타입 검사, `npm test` **452/452**, 배포 빌드와 별도 fixture의 Chrome 상세 6건을 통과했다. Compose는 자리표시자 환경에서 `NASA_*` 16개 항목의 전달과 일별 한도 기본 0/0·임시 값 전달을 확인했다. 이 실행은 이번 268의 신규 NASA TAP 조회·유료 GMS 호출, 운영 DB의 V28 적용, 실제 회원·Gold 연결 또는 배포 브라우저 인수를 수행하지 않았다. 재실행 명령과 검증 범위는 [268 개발 계약 5절](../development/nasa-planet-request-268.md#5-운영검증-경계)을 따른다.

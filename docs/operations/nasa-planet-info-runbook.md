# 확정 행성 NASA 자료 운영 가이드 (S15P21C206-266)

- 상태: 구현·일회용 PostgreSQL/HTTP fixture 검증 완료. 공유·운영 DB 마이그레이션, 서버 배포, 운영 NASA 연결·성능 측정은 **미실행**.
- 대상: 서비스 백엔드 배포·DB 담당자. 데이터 의미와 267/268 경계는 [개발 계약](../development/nasa-planet-info-266.md)을 따른다. 이 문서는 실행 환경·확인·복구의 정본이다.
- 변경 대상: 기존 Spring 백엔드 프로세스와 PostgreSQL에 `V25__nasa_planet_info.sql` 테이블 하나를 더한다. 별도 컨테이너, Python Worker, Redis 인스턴스, 벡터 DB는 필요하지 않다.

## 1. 한눈에 보는 배포 흐름

1. **왜:** 회원이 실제 매칭한 확정 후보의 NASA 수치를 재사용하고, NASA 일시 장애 때 이전 정상 자료를 보존한다. NASA 자료는 Gold·후보 판정·성과·별 발견을 수정하지 않는다.
2. **어디서:** 서비스 백엔드가 요청 시 NASA TAP에 HTTPS로 접속하고, 기존 서비스 PostgreSQL의 `nasa_planet_info`를 읽고 쓴다. 이번 266에는 공개 API가 없다. 267/268이 내부 서비스를 호출해야 실제 회원 요청이 발생한다.
3. **무엇을:** DB 접속과 Flyway 소유자 권한, NASA 호스트 DNS/아웃바운드 443을 확인한다. 새 NASA 설정은 전부 선택값이며 기본값은 아래 표다. 모델 키는 267 이후에만 필요하다.
4. **어떻게 확인:** 일회용 DB 테스트 → 적용 대상 DB의 Flyway 이력·테이블 권한 확인 → 백엔드 기동/health 확인 → 268 연결 뒤 권한 있는 확정 후보 한 건의 상태·DB 행 확인 순서다.
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

`application.properties`가 아래 `NASA_PLANET_INFO_*` 값을 읽는다. 시간값은 Spring Duration 표기(`3s`, `5m`, `1d`)이며 기본값을 바꾸면 **새 요청부터** 적용된다. 저장된 `next_refresh_at`은 과거 정책으로 이미 계산돼 있으므로 배포 직후 모든 행이 즉시 재조회되지는 않는다. 실제 비밀번호나 토큰 값은 이 문서에 적지 않는다.

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

목적: 신규 테이블의 상태와 마지막 실패 이유를 **개인 식별 정보 없이 집계**한다. 예상 결과는 배포 직후 0건일 수도 있고, 268 실제 요청 뒤 `ready`·`not_found` 등이 증가할 수 있다. `temporarily_unavailable` 증가 때는 6절에 따라 원인을 찾는다. 실패하면 SELECT 권한·스키마 search_path·V25 적용 여부를 확인한다.

```powershell
psql -X -v ON_ERROR_STOP=1 -c 'SELECT status, last_refresh_status, count(*) FROM nasa_planet_info GROUP BY status, last_refresh_status ORDER BY status, last_refresh_status;'
```

### 5.3 배포 후 애플리케이션

백엔드 실행 서버 또는 허가된 점검 단말에서 기존 `/actuator/health`의 정상 응답을 확인한다. URL과 포트는 배포 환경의 실제 진입 경로를 사용하며 이 문서의 예시를 운영 주소로 고정하지 않는다. 실패하면 앱 기동/Flyway/DB 연결 로그를 먼저 확인한다.

```powershell
$baseUrl = '<approved-backend-base-url>'
Invoke-RestMethod -Uri "$baseUrl/actuator/health" -TimeoutSec 10
```

266 단독 배포에는 NASA 공개 경로가 없으므로 이 health 확인만으로 NASA 저장이 검증되지는 않는다. 268을 배포한 뒤에는 Gold 공급자가 검증한 Archive 행성명 연결이 실제로 있는 시험 후보를 먼저 확인한다. 그 다음 권한 있는 시험 회원이 **자신이 매칭한 확정 candidateId 한 개**를 요청하고, 정상 자료·`fetchedAt`·`refreshStatus`와 테이블의 같은 후보 상태를 확인한다. 시험 회원·후보·진입 URL은 268 API 정본에서 승인받은 값을 사용한다. 다른 회원이나 미발견 TIC으로 확대 조회하지 않는다.

## 6. 증상별 대응

로그에는 `NASA PS refresh failed: candidateId=..., ticId=..., reason=...` 형태로 분류된 실패만 남긴다. NASA 응답 원문이나 인증 정보를 로그에 적지 않는다. 마지막 상태는 `nasa_planet_info.last_refresh_status`, 시각은 `last_attempt_at`·`fetched_at`·`next_refresh_at`에서 확인한다. 아래 재시도는 운영자가 직접 반복 호출하라는 뜻이 아니며, 설정된 다음 시각의 **다음 실제 회원 요청**에서 최대 2회만 시도한다.

| 증상/상태 | 우선 확인 | 대응과 재시도 경계 |
| --- | --- | --- |
| `timeout` | DNS·443·프록시·TLS·NASA 응답 지연, 요청 timeout 설정 | 이전 `ready` 유지. 5분 기본 대기 뒤 실제 요청에서 재시도. 상한 10초를 넘겨 설정하지 않음 |
| `rate_limited` / HTTP 429 | 외부 호출 증가, 인스턴스 수×동시 수, NASA 응답 | 즉시 대량 재시도 금지. 기존 자료 유지, 5분 기본 대기. 필요하면 기능 스위치 중지·동시 수 감축 |
| `upstream_error` / HTTP 5xx 또는 연결 실패 | NASA 상태, egress, 프록시, 응답 상태 | 이전 자료 유지, 요청당 최대 2회 후 5분 대기. 지속 시 새 호출 중지 |
| `not_found` / HTTP 200 빈 목록 또는 정확한 이름 부재 | 검증된 `external_signal_references`의 TIC·행성명, NASA PS 현재 표 | 행성 없음 확정으로 표시하지 않음. 1일 뒤 재확인. 과거 JSON은 DB에 보존하되 표시하지 않음 |
| `identity_unresolved` / `identity_changed` | Gold archive 참조가 한 후보당 하나인지, 다른 후보와 충돌하는지, NASA `soltype`·중복 기본 해 | 이름 유사도로 수동 연결 금지. Gold 식별자 정정 뒤 기존 캐시 식별자가 다르면 아래 절차로 캐시를 초기화. 자동 변경·공개 없음 |
| `invalid_response` | NASA 응답 JSON·TIC·default flag, 64행/256 KiB 상한 | 정상자료 보존. 쿼리/원천 스키마 변화 확인 후 코드·문서 같이 수정. 제한을 무턱대고 높이지 않음 |
| `busy` / 동시 상한 | 현재 인스턴스의 NASA 동시 요청 수 | 정상자료 보존, 5분 기본 지연. 실측 없이 상한을 높이지 않음 |
| DB 연결·권한·Flyway 오류 | DB 대상·V25 이력, `planetory_app` 권한, Flyway 소유자·FK | 외부 장애/빈 결과로 저장하지 않음. 새 앱 트래픽 중지, 대상·권한·migration 실패 원인 해결. `repair/clean` 임의 실행 금지 |

### 6.1 검증된 Gold 식별자 정정 뒤 `identity_changed` 복구

Gold 공급자가 후보의 TIC·Archive 행성명을 검증해 정정한 뒤, DB 담당자가 대상 DB와 `candidate_id`를 확인한다. 현재 Gold의 `source='archive'` 행성명이 정확히 하나이고 다른 후보와 공유되지 않는지 확인한다. 기존 `nasa_planet_info`의 TIC·행성명과 다를 때만 아래 SQL을 승인된 DB 관리 접속에서 실행한다. `:candidateId`, `:previousTicId`, `:previousName`은 확인한 후보 ID와 **기존 캐시 행**의 값으로 바인딩한다. 실행 직전에는 대상·영향·복구 근거를 확인하고 승인을 받는다.

```sql
WITH verified AS (
    SELECT c.id, c.tic_id, MIN(e.external_id) AS archive_planet_name
      FROM candidates c
      JOIN external_signal_references e
        ON e.candidate_id=c.id AND e.tic_id=c.tic_id AND e.source='archive'
     WHERE c.id=:candidateId AND c.status='active' AND c.is_confirmed
     GROUP BY c.id, c.tic_id
    HAVING COUNT(DISTINCT e.external_id)=1 AND MIN(e.external_id)<>''
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
        WHERE other.source='archive' AND other.tic_id=v.tic_id
          AND other.external_id=v.archive_planet_name AND other.candidate_id<>v.id
   )
RETURNING n.candidate_id, n.tic_id, n.archive_planet_name,
          n.status, n.last_refresh_status, n.attempt_generation;
```

반환 행은 **정확히 1개**여야 한다. 0개면 대상·기존 값·Gold 참조·타 후보 중복을 재확인하고 임의로 조건을 제거하지 않는다. 기존 NASA 정규화값과 해시·조회 시각을 함께 비우고 시도 순번을 올리므로, 정정 전 진행 중이던 조회가 옛 행성 자료를 다시 저장할 수 없다. 다음 자격 있는 회원 요청에서 새 식별자로 조회한다. `planetory_app`에는 `DELETE` 권한이 없으며 행 삭제로 복구하지 않는다. 이 절차는 Gold 자체를 수정하지 않는다.

## 7. 자료를 보존하는 중지·롤백

1. 외부 NASA 경로만 중지해야 하면 배포 환경에서 `NASA_PLANET_INFO_ENABLED=false`로 설정해 승인된 배포 절차로 백엔드를 재시작한다. 새 NASA 호출이 멈추며 기존 정상값은 읽을 수 있다. 267/268 화면 노출까지 끄려면 그 작업의 기능 스위치·배포 계약도 함께 확인한다.
2. 코드 회귀가 필요하면 기존 앱 이미지로 되돌리되 **V25 테이블은 그대로 둔다**. 구 앱은 신규 테이블을 사용하지 않는다. 새 앱 재배포 시 캐시된 정상값을 다시 읽는다. 롤백 전후 DB 대상·Flyway 이력을 확인한다.
3. 자동 삭제가 없으므로 보관 자료가 누적된다. 삭제·TRUNCATE·DROP TABLE·Flyway `clean`, 공유/운영 DB 복원은 되돌리기 어렵다. 정확한 대상·영향·복구 근거를 제시해 실행 직전 별도 승인받는다. V25를 이미 적용한 DB에서 SQL 파일을 지우거나 구 버전으로 바꾸면 Flyway 검증 실패가 날 수 있으므로 적용 이력을 임의 조작하지 않는다.

2026-09-25 검증은 일회용 PostgreSQL·로컬 HTTP fixture와 NASA 소량 읽기뿐이다. 운영 지연·호출량·DB 증가량·배포 완료 여부는 아직 측정하지 않았다.

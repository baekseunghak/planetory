# 백엔드 개발 환경 안내

대상 Task: S15P21C206-48. 작업 브랜치: `S15P21C206-48-be-initial-settings`.
범위는 프로젝트·DB 연결·Flyway·Swagger와 로컬 검증까지다. Task 정의에 있던 GitLab CI 빌드·테스트 연결은 기본 세팅을 먼저 병합하기 위해 후속 Task로 분리했다(Jira에 기록). EC2 배포, 인증·도메인 API 구현도 후속 작업이다.

## 1. 설치 버전

| 항목 | 고정 버전 / 기준 |
|---|---|
| Java | Toolchain 21. 검증 PC: Temurin 21.0.11+10 |
| Spring Boot | 4.1.1 |
| Gradle | Wrapper 9.7.1, 배포 ZIP SHA-256 검증 포함 |
| PostgreSQL | Docker 이미지 `postgres:18.6-alpine` |
| Flyway | Boot 4.1.1 의존성 관리 사용. 검증 해석 버전 12.4.0 |
| PostgreSQL JDBC | Boot 의존성 관리 사용. 검증 해석 버전 42.7.13 |
| Swagger | `springdoc-openapi-starter-webmvc-ui:3.1.1` |
| JPA / Lombok | Boot 의존성 관리 사용(Hibernate 7). Lombok은 엔티티·설정 클래스에 한정 |
| Docker Compose | `include`를 지원하는 v2.20.0 이상. 검증 PC: v5.3.1 |

Gradle을 별도로 설치하지 않는다. JDK 21도 미리 설치할 필요가 없다. `settings.gradle`의 foojay toolchain resolver가 JDK 21이 없으면 자동으로 내려받아 컴파일·테스트에 사용한다. 시스템 기본 Java가 다른 버전이어도 Wrapper 실행에는 Java 17 이상이면 충분하다. IDE에서는 Project SDK·Gradle JVM을 21로 지정한다. 데이터 접근은 JPA와 JdbcClient를 함께 쓴다(7장). 스키마는 Flyway만 변경하며 `spring.jpa.hibernate.ddl-auto=validate`라 엔티티와 스키마가 어긋나면 기동에 실패한다.

공식 기준: [Boot 4.1.1](https://spring.io/blog/2026/08/20/spring-boot-4-1-1-available-now/), [Boot 요구 환경](https://docs.spring.io/spring-boot/system-requirements.html), [springdoc](https://springdoc.org/), [PostgreSQL 버전](https://www.postgresql.org/support/versioning/).

## 2. DB 실행 — 저장소 루트

1. Docker Desktop에서 Linux 엔진이 실행 중인지 확인한다.
2. 로컬 개발 공용 기본값(포트 15432, 비밀번호 `ssafy`)을 쓰므로 `.env`는 만들지 않아도 된다. 값을 바꿀 때만 `.env.example`을 `.env`로 복사해 수정한다.
3. 다음 명령으로 DB만 실행한다. Hadoop·Spark·프론트엔드는 함께 실행되지 않는다.

```sh
docker compose --profile service up -d --wait service-db
docker compose ps service-db
docker compose exec -T service-db psql -U planetory -d planetory_poc -c "SELECT version();"
```

| 항목 | 값 |
|---|---|
| DB 이름 / 사용자 | `planetory_poc` / `planetory` — 기존 Compose 이름 유지 |
| PC에서 접속 | `localhost:15432` (Compose 기본값, `.env`의 `POSTGRES_PORT`로 변경 가능) |
| 비밀번호 | `ssafy` — 로컬 개발 공용 기본값. 포트는 127.0.0.1에만 바인딩 |
| 컨테이너끼리 접속 | `service-db:5432` |
| 데이터 볼륨 | 루트 Compose 기준 `planetory-local_service-db-pg18-data` |
| 볼륨 마운트 | `/var/lib/postgresql` — PostgreSQL 18 이미지 레이아웃 |

기본 포트를 15432로 둔 이유는 PC에 직접 설치한 PostgreSQL(5432)과의 충돌을 피하기 위해서다. 포트나 비밀번호를 바꿨다면 앱에도 `DATABASE_URL`·`DATABASE_PASSWORD`로 같은 값을 넘긴다. 컨테이너 내부 포트와 backend의 Compose 연결 URL은 바꾸지 않는다.

DB 정의는 루트 Compose가 포함하는 `experiments/distributed-pipeline/compose.yaml`에 있다. 기존 파일을 재사용했으며 PostgreSQL 16 볼륨을 18에 연결하지 않는다. service 네트워크는 호스트 IDE의 DB 연결과 backend 의존성 다운로드를 위해 일반 bridge로 설정하고 공개 포트는 `127.0.0.1`에만 바인딩한다. Hadoop 네트워크는 내부 전용을 유지한다.

DB를 잠시 멈출 때는 `docker compose stop service-db`를 사용한다. `down -v`는 데이터를 삭제하므로 일상적인 종료 명령으로 사용하지 않는다. 초기화된 볼륨에서는 `.env`의 비밀번호를 바꾸는 것만으로 DB 비밀번호가 변경되지 않는다.

## 3. 로컬 빌드·실행 — apps/backend

프로필을 지정하지 않으면 `local`로 뜬다(`spring.profiles.default=local`). `local` 프로필(`application-local.properties`)에 로컬 DB 기본값(`localhost:15432`, `ssafy`)·Swagger·예제 API가 들어 있다. 237 이후 local은 별도 세션/캐시 Redis를 `localhost:16379`·`localhost:16380`에서 사용하며(루트 Compose `session-redis`·`cache-redis`, `docker compose --profile service up -d session-redis cache-redis`) 다른 주소는 연결 환경변수로 지정한다([연결 안내](oauth-setup.md#redis-연결과-저장-경계237)). 배포 이미지는 Dockerfile의 `ENV SPRING_PROFILES_ACTIVE=prod`로 이 기본값을 쓰지 않으며, `prod`에는 비밀번호 기본값이 없어 `DATABASE_*` 또는 `SPRING_DATASOURCE_*`를 주입하지 않으면 기동에 실패한다.

`bootRun`과 `test`는 먼저 `startLocalDb` 태스크로 루트 Compose의 `service-db`를 띄운다(`docker compose --profile service up -d --wait service-db`). 이미 떠 있으면 바로 끝난다. `CI=true`·`SKIP_LOCAL_DB=true` 환경이거나 `-PskipLocalDb`를 주면 건너뛴다. 로컬 Compose의 `backend` 컨테이너는 `SKIP_LOCAL_DB=true`로 실행한다.

```sh
cd apps/backend
./gradlew --version
./gradlew clean build
./gradlew bootRun
```

Windows PowerShell에서는 `./gradlew` 대신 `.\gradlew.bat`을 쓴다.

`Ctrl+C`로 서버를 종료한다. Windows에서 build/libs의 JAR를 직접 실행 중이면 파일 잠금 때문에 `clean`이 실패하므로 서버를 먼저 종료한다. IDE에서는 Project SDK와 Gradle JVM을 21로 지정한다. IDE의 main 실행은 Gradle을 거치지 않으므로 DB를 자동으로 띄우지 않는다. 예제 API와 Swagger는 local에서만 켠다.

DB·Redis와 backend를 모두 Docker로 실행하려면 루트에서 다음 명령을 쓴다. `service-db`·`session-redis`·`cache-redis`가 함께 뜬다. 호스트에서 실행 중인 8080 서버는 먼저 종료한다. 2026-09-28 별도 프로젝트 이름으로 격리해 `backend` 기동, health `UP`, CSRF 조회 200과 세션 키가 `session-redis`에만 쌓이는 것을 확인했다.

```sh
docker compose --profile service up -d --build backend
```

### 환경변수

세션·계산 캐시 연결의 `SESSION_REDIS_*`·`CACHE_REDIS_*` 변수와 필수값은 [OAuth Redis 연결 안내](oauth-setup.md#redis-연결과-저장-경계237)를 따른다.
Gold 읽기 캐시는 기본 비활성이다. 지정한 별을 미리 올리려면 `GOLD_CACHE_ENABLED=true`, `GOLD_CACHE_TIC_IDS=<TIC_ID_1>,<TIC_ID_2>`를 설정한다. 시작 시와 판 전환 알림 후 현재 판의 곡선·원본 주기도만 `cache-redis`에 적재하고, 후보 모델·권한·current 판은 DB에서 읽는다. 상세 운영 절차와 임시 128mb 용량 경계는 [서비스 배포 안내](../../../infra/service/README.md#세션캐시-redis)를 따른다.

| 변수 | 역할 / 기본값 |
|---|---|
| `DATABASE_PASSWORD` | 앱이 읽는 DB 비밀번호. `local` 프로필 기본 `ssafy`, `prod` 등 그 외 프로필은 기본값 없음(필수) |
| `DATABASE_URL` | 앱이 읽는 JDBC URL. `local` 프로필 기본 `jdbc:postgresql://localhost:15432/planetory_poc` |
| `DATABASE_USER` | 앱이 읽는 DB 사용자. 기본 `planetory` |
| `POSTGRES_PASSWORD` / `POSTGRES_PORT` | 루트 Compose `service-db`용. 기본 `ssafy` / `15432`. 바꾸면 앱의 `DATABASE_*`도 맞춘다 |
| `SPRING_DATASOURCE_*` | 로컬 Compose `backend`가 사용하는 Spring 표준 연결 설정. `DATABASE_*`보다 우선 |
| `SPRING_PROFILES_ACTIVE` | 미지정 시 `local`(로컬 DB 기본값·Swagger·예제 API·SQL 로그). 배포 이미지는 `prod` |
| `SKIP_LOCAL_DB` / `CI` | `true`면 Gradle의 로컬 DB 자동 기동을 건너뜀 |
| `SWAGGER_ENABLED` | local 외 환경에서 문서 노출을 명시적으로 제어, 기본 false |
| `DERIVED_COMPUTE_URL` | 잔차·주기도 Worker 주소(예: `http://localhost:8090`). 비우면 잔차 요청은 503 「준비되지 않았습니다」. Worker 실행은 [apps/derived-compute](../../derived-compute/README.md) |

## 4. Flyway 최초 스키마

### V21 전체·비교 통계

`V21__statistics_aggregation.sql`은 173의 V20 다음에 적용한다. 기존 V1~V19를 수정하거나 repair/outOfOrder를 사용하지 않는다. MV 최초 미적재와 실제 0건을 구분하며 Snapshot global의 NULL 회차에도 중복 방지를 적용한다. 최소 역할과 실행·재시작 방법은 [통계 실행 런북](../../../docs/operations/statistics-runbook.md), 구조는 [ERD](../../../docs/architecture/database-erd.md#f-운영·챌린지·알림·통계)를 따른다. 통계 명령은 기동 Flyway를 강제로 끄므로 사전 migration은 소유자 전용 절차로 완료해야 한다. 공유/운영 DB 적용은 별도다.

파일: `src/main/resources/db/migration/V1__initial_schema.sql`.
기준: [ERD v1.1](../../../docs/architecture/database-erd.md) 그림과 3장 본문. 그림에 생략된 memo·계산 버전·time_system·round_id·수정 시각 등도 본문에 따라 포함했다.

- 33개 테이블, 57개 FK, 닉네임 대소문자 무시 유일 인덱스, 별당 current 판·신호당 공식 스레드 부분 유일 인덱스, pg_trgm 검색 인덱스, 댓글 목록용 `comments (post_id, created_at)` 인덱스를 만든다.
- PK는 ERD의 BIGINT IDENTITY를 `GENERATED BY DEFAULT AS IDENTITY`로 구현했다. 별 TIC·1:1 FK PK·튜토리얼 순번·규칙 버전은 별도 생성하지 않는다.
- ERD가 명시한 선택 값은 nullable로 두고 기본적인 식별자·필수 본문·상태는 NOT NULL로 작성했다. 숫자는 명시된 numeric을 사용하며 임의의 정밀도 상한을 정하지 않았다. 이 null/default 해석은 초기 SQL 리뷰 대상이다.
- CHECK는 상태값, 공식 스레드 작성자·별 게시판 조건, 첨부 대상 XOR, 제출 위상·판단·매칭 후보 조건, 배열 길이 등을 검증한다. 소유자·동일 TIC처럼 여러 행을 비교하는 업무 검증은 API 구현 시 추가한다.
- `pg_trgm`은 public 스키마에 설치한다. 테스트 스키마와 개발 스키마에서 같은 확장을 사용하며, 테스트가 확장을 삭제하지 않는다.
- 사용자·별·운영 설정값을 자동으로 넣지 않는다. P1 테이블 생성이 P1 API 구현을 의미하지 않는다.
- FK 삭제 전파는 지정하지 않았다(NO ACTION). 탈퇴 처리 정책을 임의로 확정하지 않는다.

### V13 History 첨부 앱 권한

160은 V1의 `post_history_attachments`·`comment_history_attachments`를 재사용한다. `V13__history_attachment_app_grants.sql`이 앱 역할에 SELECT·INSERT·DELETE와 identity 시퀀스 USAGE·SELECT를 부여한다. UPDATE·TRUNCATE와 History 원본 변경 권한은 허용하지 않는다. 소유자·동일 TIC·개수 검사는 서비스 트랜잭션이 담당한다. 기존 V1~V12는 수정하지 않으며 실행 환경에 적용할 때 Flyway 소유자 역할로 V13을 실행한다. 공유·운영 DB에는 이번 작업에서 적용하지 않는다.

### V4 ERD v1.2 반영

파일: `V4__apply_erd_v1_2_star_coordinates_and_peak_source.sql`. V1 이후 ERD에서 바뀐 열 두 묶음을 반영한다.

**submissions 선택 봉우리(C02-R3):** `source_peak_grid_index`·`source_peak_suggested_duration_hours`·`duration_limit_hours`를 nullable로 추가한다. 셋은 모두 NULL(직접 주기 선택·candidate 외 제출)이거나 candidate 제출에서 모두 채워져야 하며, grid index는 0 이상, 두 시간 값은 양의 유한 값이다. 상한 배율 3배는 규칙 값이므로 DB에서 고정 비교하지 않는다.

**star_unlocks 별 자리 좌표:** `star_unlocks`에 `world_x`·`world_y`·`layout_version`을 NOT NULL로 추가하고, x/y 유한 값·`depth_z` -1~1·빈 배치 버전 금지 CHECK를 건다. 폐기 예정인 `generation`·`angle_deg`·`radius_jitter`는 nullable로 바꾼다.
보존할 운영 좌표가 없으므로 이관 SQL은 없다. `star_unlocks` 행이 이미 있는 DB에서는 V4가 실패한다. 타일 조회용 공간 인덱스는 성능 검증 후 별도 마이그레이션으로 추가한다.

**V4 적용·검증용 DB 준비**

- 검증은 새 전용 DB에서 한다. 기존 개발 DB의 데이터를 지우지 않아도 된다. 역할(V2)은 클러스터 전역이라 같은 컨테이너의 다른 DB와 공유되며 V2가 기존 역할을 그대로 재사용한다.

  ```sh
  docker compose exec -T service-db createdb -U planetory planetory_v4_check
  ```

  ```powershell
  $env:DATABASE_URL = 'jdbc:postgresql://localhost:15432/planetory_v4_check'
  .\gradlew.bat bootRun
  ```

  Gradle 테스트는 실행마다 격리 스키마를 새로 만들므로 별도 DB 준비가 필요 없다.
- **`star_unlocks` 행만 삭제하지 않는다.** `MemberService.login()`은 이미 있는 회원에게 가입 초기화(첫 별·진행 상태 생성)를 다시 실행하지 않는다. 회원을 남기고 별 지급 기록만 지우면 첫 별이 없는 회원이 남는다.
- 기존 개발 DB를 꼭 V4로 올려야 하면, 데이터를 버려도 되는 로컬 볼륨은 아래 마이그레이션 규칙의 볼륨 초기화로 전체를 새로 만든다. 부분 정리가 필요하면 회원 단위로 `users`와 연결된 `user_settings`·`user_star_progress`·`star_unlocks` 및 성과·제출·게시글 등 참조 데이터를 함께 정리해, 회원이 없거나 회원·설정·첫 별·진행 상태가 모두 있는 상태만 남긴다.
- 공유·운영 DB의 행 삭제나 초기화는 담당자 합의 없이 하지 않는다.

앱 시작 시 Flyway가 자동 실행되고 이력은 `flyway_schema_history`에 저장된다. `baseline-on-migrate=false`, `clean-disabled=true`, Spring SQL 자동 초기화는 꺼져 있다. 기존 비어 있지 않은 DB를 임의 baseline/clean/repair로 통과시키지 않는다.

```sh
docker compose exec -T service-db psql -U planetory -d planetory_poc -c "SELECT version, description, installed_on, success FROM flyway_schema_history ORDER BY installed_rank;"
```

### V9 운영 규칙 검증·초기 규칙

파일: `V9__operation_rules.sql` (S15P21C206-151). 형식·절차 정본은 [운영 규칙 변경 런북](../../../docs/operations/operation-rule-runbook.md)이다.

- `operation_settings.values`를 형식 1로 검사하는 CHECK, 적용 시각 유일 인덱스, 이력 보호 트리거를 만든다. `tutorial_stars`·`challenge_rounds`는 공개된 별만 대상으로 받고 회차 기간이 뒤집히면 거절한다.
- 모든 환경에 초기 규칙 `rule-0`을 넣는다. `tutorial.skip_after`는 마이그레이션 연결의 세션 설정 `planetory.tutorial_skip_after`에서 오며, `local` 프로필은 `spring.flyway.init-sqls`로 3을 주고 설정이 없으면(배포, Flyway를 직접 구성하는 테스트) 0이다.
- **마이그레이션 SQL에 Flyway placeholder(`${...}`) 같은 전용 문법을 쓰지 않는다.** `experiments/gold-roundtrip`이 파일을 Flyway 없이 그대로 실행한다. `OperationRulesTest`가 모든 마이그레이션을 같은 방식으로 실행해 확인한다.
- 테스트 데이터는 `operation_settings`에 행을 넣지 말고 V9가 넣은 `rule-0`을 참조한다. `'{}'` 같은 값은 CHECK가 거절하고, 적용된 행은 지우거나 비울 수 없으므로 `TRUNCATE`에 이 테이블을 넣지 않는다. 규칙 행이 필요한 테스트는 되돌리는 트랜잭션 안에서 넣는다(`OperationRulesTest`).
- 기존 개발 DB에 형식 이전 규칙 행·공개되지 않은 대상 별·기간이 뒤집힌 회차가 있으면 V9가 건수를 알리고 되돌아간다. 행을 고치거나, 데이터를 버려도 되는 로컬 볼륨이면 아래 규칙의 볼륨 초기화로 새로 만든다.

### V14 공개 분석 등록 권한

`V14__public_analysis_app_grants.sql`(161)은 기존 `published_analyses`에 SELECT·INSERT와 시퀀스 권한을 부여하고 UPDATE·DELETE·TRUNCATE는 차단한다. 공식 스레드 부분 유일 인덱스와 History별 공개 유일 제약은 V1을 재사용한다. 162의 취소·재공개는 실제 구현 시 필요한 상태 열의 UPDATE 권한을 별도로 추가한다.

V13은 160의 History 첨부 권한에 사용한다. **160을 먼저 병합하고 V13 → V14 순서로 적용한다.** 161 단독 브랜치의 테스트는 새 일회용 DB/격리 스키마에서 수행한다. V13 없이 V14를 적용한 임시 DB를 이후 통합 DB로 재사용하지 않는다. 개발·공유 DB에 V14를 먼저 적용하거나 out-of-order·repair로 순서를 우회하지 않는다. 병합 전 최신 develop의 번호를 다시 확인한다.

160을 포함한 develop을 161에 병합해 V13·V14 통합 검증을 수행했다. `MemberCommunityPermissionTest`는 일회용 PostgreSQL을 V12까지 만든 뒤 V13 → V14를 순서대로 적용하고 새 Flyway 인스턴스의 validate·재실행(추가 적용 0개)을 검증한다. 공개·첨부의 동시 사용은 `PublicAnalysisTest`, 부모 경로 권한은 `HistoryAttachmentTest`로 검증한다. 공유·운영 DB 적용과 실제 프론트·잔차 공급자 연결은 별도 인수다.

### 마이그레이션 규칙

- 새 변경은 `V2__설명.sql`, `V3__설명.sql`처럼 버전 번호와 두 개의 밑줄로 추가한다. 설명은 영문 snake_case로 쓴다.
- **develop에 병합된 파일은 수정하지 않는다.** V1 포함. 내용을 고치려면 다음 번호의 새 파일로 ALTER한다. 병합된 파일이 바뀌면 이미 적용한 DB에서 checksum 불일치로 기동이 실패한다.
- 버전 번호는 **develop 병합 순서**로 확정한다. 브랜치에서 잡은 번호가 먼저 병합된 다른 MR과 겹치면 rebase 후 번호를 올린다. `out-of-order`는 켜지 않는다.
- 변경 SQL은 먼저 독립 검증 환경(테스트 스키마 또는 새 로컬 DB)에 적용하고 앱 재시작·이력·제약을 확인한다.
- 로컬 DB에서 checksum 오류가 나면(병합 전 브랜치 파일을 고친 경우 등) 데이터를 버려도 되는 로컬 볼륨은 `docker compose --profile service down -v service-db` 후 다시 올린다. 공유·운영 DB에서는 `repair`를 임의로 실행하지 않는다.

### 후속으로 분리한 항목

| 항목 | 남은 작업 |
|---|---|
| global_stats | 집계 산식·열·유일 인덱스 확정 후 materialized view 및 갱신 Job 작성 |
| candidates.quality | 자료형·의미 확정 후 열 추가 |
| ai_executions.status | TEXT 열은 유지. 허용값 확정 후 CHECK 추가 |
| 운영 규칙 값·튜토리얼 TIC | 초기 규칙 `rule-0`은 V9가 넣는다(아래 V9 절). 값 확정(D20·D11)은 새 규칙 버전으로, 튜토리얼 TIC(DEC-01)은 운영자가 [운영 규칙 변경 런북](../../../docs/operations/operation-rule-runbook.md) 절차로 넣는다 |
| `rule_version` FK 범위 | `candidate_dispositions`·`candidate_status_history`의 `rule_version`은 ERD가 관계선을 그리지 않아 FK 없이 TEXT로 뒀다. 같은 의미라면 FK를 추가할지 ERD 담당자가 결정 |
| DB 역할·불변성 | 애플리케이션/마이그레이션/배치 역할 분리 및 History 수정·삭제 제한. 현재 로컬은 Compose 개발 계정이 스키마를 소유하며 운영 권한 구성이 아님 |
| 첨부·공개 분석 | 소유자·TIC·게시글 종류 검증, 불변 필드 보호의 서비스/트리거 책임 확정 |

### 초기 스키마 담당·적용 순서 (합의 내용)

- V1은 ERD v1.1을 기준으로 이 Task에서 작성했고, **ERD 담당자가 작성한 스키마를 먼저 병합한 뒤 부족한 부분을 보완**하기로 했다.
- ERD 담당자의 열·null/default 해석 검토는 병합 후 진행한다. 불일치가 발견되면 **V1을 고치지 않고 V2부터 ALTER로 반영**한다.
- 이후 도메인 테이블 변경 SQL은 해당 기능 담당자가 자기 MR에 마이그레이션을 포함하고, ERD 담당자가 리뷰한다. ERD 문서와 SQL이 어긋나면 ERD 문서를 먼저 갱신한다.
- `pg_trgm` 확장 생성은 DB 계정에 CREATE 권한이 필요하다. 운영 DB 계정 권한 분리는 인프라 담당자와 후속 Task에서 정한다.

## 5. Swagger와 상태 확인

- Swagger UI: http://localhost:8080/swagger-ui/index.html
- OpenAPI JSON: http://localhost:8080/v3/api-docs
- 예제: `GET /api/v1/hello` → 200, `{"message":"Planetory 백엔드가 실행 중입니다."}`
- 상태: `GET /actuator/health` → DB 연결을 포함한 상태. 정상은 200·UP, 장애는 503. 상세 접속 정보는 노출하지 않는다.

Swagger에서 `GET /api/v1/hello`를 펼치고 **Try it out → Execute**를 누른다. 예제는 데이터를 수정하지 않는다. 공개용 오류·인증 계약은 도메인 구현 Task에서 적용한다.

## 6. 검증 결과 (2026-09-14)

| 확인 | 결과 |
|---|---|
| JDK 21 / Wrapper 9.7.1 컴파일 | 통과 |
| PostgreSQL 실제 버전 | 18.6, 컨테이너 healthy |
| 전체 빌드·테스트 | `clean build` 통과, 테스트 7개 실패 0 (통합 3 + 웹 계층 4) |
| 독립 테스트 스키마 | 실행마다 UUID 스키마 생성, 종료 시 해당 스키마만 정리 |
| Flyway | 테스트에서 V1 적용 후 migrate 두 번 모두 신규 적용 0건 |
| 실제 개발 DB | 33개 테이블 생성·V1 성공 이력 1건 |
| 서버 재시작 | 기존 v1 유지, `No migration necessary` 확인 |
| Swagger UI | 실제 Try it out·Execute 호출로 200 및 기대 응답 확인 |
| Docker `backend` 이미지 빌드·실행 | 미검증 (DB 컨테이너 + 호스트 JDK 실행만 검증) |
| GitLab CI·EC2 배포 | MR의 `backend:build`는 DB 없는 테스트와 `GoldCatalogSchemaTest`만(`-PmrTests`), develop 병합 뒤 `backend:test`가 전체를 실행한다(S15P21C206-91, [CI/CD](../../../docs/operations/cicd.md#백엔드-테스트-mr-관문과-전체-실행-s15p21c206-91)). CI에서만 테스트별 5분 제한을 둔다(`build.gradle`). 실제 파이프라인 통과는 미검증 |
| 팀원 재현 | MR 리뷰 시 리뷰어가 이 문서만으로 3장까지 재현해 확인 |

`@SpringBootTest` 통합 테스트는 H2가 아니라 실행 중인 PostgreSQL을 사용한다. `@WebMvcTest`는 DB 없이 실행된다. 설정된 DB에 테스트 스키마 생성·삭제 권한이 필요하며, 운영 DB에는 연결하지 않는다. 실패해 스키마가 남으면 `backend_test_...` 이름을 확인해 정리한다. 자동 테스트는 자기 실행에서 생성한 이름만 삭제한다.

JUnit 결과는 `build/test-results/test/`, HTML 결과는 `build/reports/tests/test/index.html`에 생성된다. 빌드 결과·비밀번호·로컬 환경 파일은 Git에서 제외한다.

## 7. 코드 구조와 작성 규칙

패키지 루트는 `com.planetory.backend`다. 이전 SSAFY 프로젝트(JobUp)의 도메인 수직 분할 구조를 따르되, 인증·오류 형식은 이 프로젝트의 API 명세에 맞췄다.

```
global/config     OpenApiConfig(Swagger 제목·세션 쿠키 스킴), ClockConfiguration
global/error      ErrorCode, ErrorResponse, BusinessException, GlobalExceptionHandler
global/entity     BaseTimeEntity(created_at 공통 부모)
global/dev        HelloController — local 프로필 전용 예제 API
domain/<도메인>/  controller · dto(request/response) · entity · repository · service · exception
```

### 도메인 패키지

- 서비스·저장소 의존성이 없는 도메인 간 공유 조건은 순환 참조 방지를 위해 `domain` 바로 아래에 둘 수 있다(`PublicAnalysisVisibility`). 서비스·저장소·컨트롤러를 이 위치로 이동하는 예외는 아니다.
- 담당 영역([API 명세 파트 분담](README.md))별로 `domain/member`, `domain/post`, `domain/comment`, `domain/exploration`처럼 나눈다. 다른 도메인의 repository를 직접 주입하지 않고 service를 통해 호출한다.
- 요청·응답 DTO는 Java `record`로 쓴다. Lombok은 엔티티(`@Getter`, `@NoArgsConstructor(access = PROTECTED)`)와 `@RequiredArgsConstructor`·`@Slf4j`에 한정하고 `@Data`·`@Setter`는 쓰지 않는다.
- 컨트롤러 경로는 `/api/v1`로 시작하며 `@Operation(summary)`를 붙여 Swagger에 설명이 나오게 한다.

### 데이터 접근 — JPA와 JdbcClient 병행

| 대상 | 방식 | 이유 |
|---|---|---|
| 회원·설정·게시글·댓글·반응·알림 등 관계형 테이블 | JPA (`JpaRepository`) | CRUD·연관 탐색·부분 수정이 대부분. `validate`가 스키마 불일치를 기동 시점에 잡는다 |
| `light_curve_segments.flux`, `periodograms.power`, `manifest` 등 배열·JSONB 중심 탐사 테이블 | `JdbcClient` | 배열 슬라이싱·집계는 결국 PostgreSQL SQL이 필요하다. 탐사 담당자가 테이블별로 정한다 |

- 둘은 같은 DataSource와 `@Transactional`을 공유한다. 한 서비스 메서드 안에서 섞어 써도 트랜잭션은 하나다.
- 엔티티는 `created_at`을 `BaseTimeEntity`에서 상속한다. 값은 DB DEFAULT가 채우므로 애플리케이션에서 넣지 않는다. `updated_at`은 서비스가 갱신 시점을 정하므로 엔티티가 직접 둔다.
- `open-in-view=false`다. 지연 로딩은 `@Transactional` 서비스 안에서 끝내고, 응답 DTO 변환도 그 안에서 한다.
- CHECK 제약·부분 유일 인덱스는 `validate`가 검사하지 않는다. 마이그레이션에서 바꿨다면 엔티티와 테스트를 같이 확인한다.

### 오류 처리

- 형식은 [서비스 API 명세 2.4절](service-api-spec.md)의 `code`·`message`·`fieldErrors`다.
- 도메인 예외는 `BusinessException`을 상속하고 `ErrorCode`만 지정한다. 새 코드는 `ErrorCode`에 추가한다. `GlobalExceptionHandler`에 도메인별 메서드를 추가하지 않는다.
- `@Valid` 실패는 자동으로 400 `VALIDATION_FAILED` + `fieldErrors`가 된다. Spring MVC 표준 예외(405·415·파라미터 누락 400 등)는 원래 상태 코드를 유지하고 `code`는 HTTP 상태 이름이다. 예상 못 한 예외는 500 `INTERNAL_ERROR`로 감추고 원인은 서버 로그에만 남긴다.

### 테스트

| 종류 | 도구 | DB |
|---|---|---|
| 컨트롤러 | `@WebMvcTest(controllers = …)` + `@MockitoBean` 서비스 | 불필요 |
| 서비스 | 순수 JUnit + Mockito, 시간은 `Clock.fixed` 주입 | 불필요 |
| 리포지토리 | `@DataJpaTest` 또는 `@JdbcTest` + 실제 PostgreSQL | 필요 |
| 기동·마이그레이션 | `PlanetoryApplicationTests` (UUID 스키마 격리) | 필요 |

`GlobalExceptionHandlerTest`가 컨트롤러 테스트 템플릿이다. 공통 픽스처는 `src/test/java/.../support`, 도메인 픽스처는 `domain/<도메인>/support`에 둔다.

### V15 공개 취소·재공개 권한

`V15__public_analysis_visibility_grant.sql`(162)은 `planetory_app`에 `published_analyses.unpublished_at` 열 UPDATE만 부여한다. SELECT·INSERT는 V14를 유지하며 운영 숨김·최초 공개 시각·History 연결 변경과 DELETE·TRUNCATE는 허용하지 않는다. PostgreSQL 행 잠금에 필요한 UPDATE 권한도 이 열 권한으로 충족한다.

기존 V1~V14를 수정하지 않고 V13 → V14 → V15를 순서대로 적용한다. `MemberCommunityPermissionTest`에서 업그레이드·Flyway validate·재실행 0건과 금지 열의 42501을, `PublicAnalysisTest`에서 실제 앱 역할의 공개→취소→재공개를 검증한다. 공유·운영 DB 적용은 별도 인수다.

### V16 일반 글 반응 권한

`V16__post_reaction_app_grants.sql`(163)은 기존 `post_reactions`에 `planetory_app`의 SELECT·INSERT·UPDATE·DELETE만 부여하고 TRUNCATE는 금지한다. NONE은 관계 행의 삭제이므로 DELETE가 필요하다. IDENTITY 시퀀스의 사용 권한은 기존 V11을 재사용하며 다른 테이블 권한·스키마는 변경하지 않는다.

V15 다음에 적용한다. `MemberCommunityPermissionTest`는 V12 → V15의 3건, V15 → V16의 1건 적용·validate·재실행 0건과 실제 앱 계정의 생성·변경·삭제·TRUNCATE 거절을 검증한다. `PostReactionTest`는 빈 일회용 DB에 전체 마이그레이션을 적용하고 실제 JPA 앱 역할 경로도 검증한다. 공유·운영 DB에는 이번 작업에서 적용하지 않는다.


<a id="v17-출처-관계-권한"></a>

### V18 출처 관계 권한

`V18__source_link_app_grants.sql`(167)은 V1 `post_source_links`에 `planetory_app`의 SELECT·INSERT·DELETE와 IDENTITY 시퀀스 USAGE·SELECT만 부여한다. 배열 교체는 부모 잠금 아래 DELETE·INSERT로 수행하므로 UPDATE·TRUNCATE는 허용하지 않는다. 테이블·열·제약은 변경하지 않는다.

145번의 `V17__submission_detail_target.sql`과 번호가 겹쳐, develop 미병합인 출처 권한 파일을 V18로 옮겼다. V17 제출 상세 마이그레이션을 먼저 병합·적용하고 V18을 뒤에 적용한다. 번호 충돌을 피하려고 out-of-order나 repair를 켜지 않는다. 기존 V17 출처 파일을 적용한 일회용 검증 DB는 새로 만들며 공유·운영 DB 이력은 수정하지 않는다. `MemberCommunityPermissionTest`는 V16→V18 출처 권한 1건·validate·재실행 0건, 실제 앱 역할의 생성·삭제와 권한 경계를 검증한다. `SourceCardTest`는 같은 역할로 실제 서비스 저장·조회·교체를 실행한다. 이번 검증은 일회용 PostgreSQL에만 적용하며 공유·운영 DB 적용은 별도다.

### V19 공식 검색 본문

`V19__official_search_summary.sql`(169)은 공개 후보 네 수치를 공식 posts.body에 투영하는 생성·갱신 트리거와 기존 본문 채움을 추가한다. 테이블·열·인덱스·역할 권한을 추가하지 않는다. 숫자·템플릿·동시성·기존 값 처리 정본은 [검색 본문 계약](../../../docs/api/community/README.md#공식-제목본문의-구현-차이)을 따른다. SECURITY DEFINER 함수는 신뢰 스키마를 명시하고 PUBLIC 실행을 금지한다. 후보 변경 실패 시 본문 변경도 롤백한다.

V18 다음으로 적용하며 병합 시 번호 충돌을 다시 확인한다. 공유·운영 DB에는 이번 작업에서 적용하지 않는다. 기존 공식 본문 전체에 대한 UPDATE가 발생하므로 적용 전 대상 건수·잠금 시간을 확인하고 별도 승인 후 실행한다.

169 리뷰 보완에서 develop 미병합 V19에 후보 수치 변경의 격리 수준 검사를 추가했다. 적용 계약은 [검색 본문 계약](../../../docs/api/community/README.md#공식-제목본문의-구현-차이)을 따른다. 수정 전 V19를 적용한 일회용 검증 DB는 새로 만들어 검증하며 checksum을 repair로 우회하지 않는다. 영속 DB에 이전 V19를 적용한 이력이 있다면 파일 재적용 대신 별도 후속 마이그레이션이 필요하므로 적용 전에 이력을 확인한다.

### V20 팔로우 권한

`V20__follow_app_grants.sql`(173)은 기존 follows에 앱 SELECT·INSERT·DELETE를 부여하고 UPDATE·TRUNCATE를 금지한다. V11의 IDENTITY sequence 권한을 재사용하고 새 테이블·열을 만들지 않는다. 반복 PUT은 등록 시각을 유지하며 같은 회원의 쓰기는 users 행 잠금으로 직렬화한다. 현재 합성 측정 범위에서는 추가 인덱스를 만들지 않는다.

V19 다음에 적용하며 V21은 178 통계 작업 소유다. 적용한 V1~V19를 수정하거나 repair/outOfOrder로 우회하지 않는다. `MemberCommunityPermissionTest`는 V19→V20 1건·validate·재실행0, `FollowTest`는 새 일회용 DB 전체 적용과 실제 앱 로그인 역할의 HTTP/쓰기/조회·경합을 검사한다. V20→V21과 통합 새 DB/업그레이드는 178의 별도 일회용 환경에서 검증한다. 공유·운영 DB에는 적용하지 않았다.

팔로우 커서는 기존 조회 커서처럼 binding·정규 인코딩·값 범위를 검사하며 프로세스 키를 사용하지 않는다. follow-v2는 앱 재시작 후에도 유지하고 이전 서명형 follow-v1만 첫 페이지 GET으로 전환한다. 커서는 권한이 아니므로 실제 인증 회원·현재 관계·공개 자격을 매번 DB에서 검사한다. 관리 relationId도 DB 소유권 검사로 보호한다. 컴포넌트 재초기화와 동일 DB 조회/해제를 테스트하며 JVM 재시작·237 Redis 로그인 유지 통합은 별도다. 전역 게시판 공개 자격은 `StarBoardVisibility.OPEN`을 StarRepository·FollowService·CommunityReadService에서 공유한다. FE 연결·오류 복구 계약은 [서비스 API](service-api-spec.md#follow-policy)를 따른다.


173 측정(2026-09-22): 일회용 PostgreSQL 18.6, 합성 회원/관계/발견 기록 각1만 건과 소량 기능 표본, size20, 실제 앱 역할, ANALYZE 후 실제 목록 SQL의 EXPLAIN ANALYZE를 각3회 실행했다. 회원 팔로잉/공개 별/역방향 팔로워의 DB 실행시간 중앙값은 각각 0.106/0.470/0.484ms였다. 공개 별 측정에는 발견 기록 끝의 TIC도 포함했다. 해당 범위에서는 V20에 인덱스를 추가하지 않았다. 전체 HTTP 지연·최대 규모·고밀도 팔로워 성능을 보장하는 측정은 아니며, 실제 규모에서 역방향 follows 탐색·관계 정렬·TIC 단독 자격 비용을 다시 확인한다. 재현은 FollowTest의 합성관계10000개 실행계획 사례이며 원시 계획은 무시되는 build 테스트 결과에 남는다.

### 세그먼트 COMMENT 후속 인계 (123)

123에서는 새 migration을 추가하지 않는다. 준비했던 산포 COMMENT 파일과 그 전용 Flyway
단계는 열린 브랜치의 번호 충돌·역순 적용을 피하기 위해 제거했다. 기존 V1과 V20 팔로우는 유지한다.
`flux_scatter`와 `start_btjd` COMMENT 정정은 Backend 후속에서 함께 처리한다.
수정 문구·완료 조건은 [정합화 요청](../../../docs/project/planetory-doc-sync-requests.md#123-review-comment-handoff)을 따른다.
후속 담당자는 열린 migration·실제 적용 이력·병합 및 배포 순서를 확인한 뒤 새 번호를 결정한다.
번호만 올리거나 repair/outOfOrder로 우회하지 않는다. 적용 이력이 있는 영속 DB에서 파일 삭제·이력 삭제를
수행하는 절차가 아니다. 리뷰어가 사용한 V22 적용 검증 DB는 별도의 일회용 환경이며 운영 적용 근거가 아니다.

<a id="notification-key"></a>

## 알림 서명키·V23 전환 (175)

`NOTIFICATION_SIGNING_KEY`는 알림 페이지 커서·모두 읽음 경계의 HMAC-SHA256 서명에 쓰는 서버 공통 키다. 인증/세션 키와 분리한 최소 32바이트의 고엔트로피 비밀을 환경변수로 주입한다. 값은 저장소·문서·로그에 남기지 않는다. 모든 인스턴스·재시작에서 동일 값을 유지하며 키를 교체하면 이전 커서/읽음 경계가 400으로 무효화되므로 목록 첫 페이지를 다시 조회한다. 회원별 키나 프로세스 임시 키를 만들지 않는다.

로컬 직접 실행은 백엔드 프로세스 환경에, 컨테이너는 루트 및 `infra/service/compose.yaml`의 backend 환경에 주입한다. 서버의 보호된 배포 환경에서 제공하며 실제 값은 이 작업에서 설정하지 않았다. 미설정/32바이트 미만이면 서명이 필요한 목록·모두 읽음은 503이다. 설정·미확인 수·개별 읽음은 키에 의존하지 않는다.

V23과 RELABEL을 포함한 FE 6종 소비자를 함께 반영한다. 기존 설정값과 notifications 원본을 보존하고 기존 사건을 새 알림함으로 소급하지 않는다. 일회용 PostgreSQL 테스트에서만 마이그레이션을 검증했으며 공유/운영 DB 변경은 별도 실행 승인 대상이다. 전환·DB 사건 생산 경계와 운영 인수 범위는 [F15.7](../../../docs/development/service-backend/community.md#notification-policy)을 따른다.

## V24 탈퇴 스키마·권한 (180)

V24는 `withdrawal_requests`, `stars.board_open`, 글·댓글의 `author_withdrawn_at`, 공개 분석의 `withdrawn_at`과 두 정리 함수를 추가한다. 적용은 회원 데이터 삭제 경로를 준비하는 스키마 변경이며 **공유·운영 DB에는 이 작업에서 적용하지 않는다**. 일회용 PostgreSQL에서 전체 migration·V18 구버전 업그레이드와 실제 앱 역할의 함수 실행 권한을 검증한다. 운영 적용 전 [DEC-11](../../../docs/requirements/planetory-decision-register.md#dec-11)의 처리 근거·본문 삭제 절차·복원 계획을 확인하고 별도 승인받는다. 기본 기능 스위치는 `planetory.withdrawal.enabled=false`다.

## V25 요청된 NASA 행성 자료 (266)

`V25__nasa_planet_info.sql`은 최신 develop의 V24 다음 번호로, 실제 요청된 확정 후보의 NASA PS 기본 해를 보관하는 서비스 테이블 하나와 앱 역할의 SELECT/INSERT/UPDATE 권한을 추가한다. 기존 V1~V24나 Gold 판정·성과는 수정하지 않는다. 일회용 PostgreSQL에서 전체 migration과 HTTP fixture 조회·경합을 검증했다. 공유/운영 DB 적용은 미실행이다. 테이블·상태 계약은 [개발 문서](../../../docs/development/nasa-planet-info-266.md), Flyway 순서·필수 권한·환경변수·실행/복구는 [운영 가이드](../../../docs/operations/nasa-planet-info-runbook.md)를 따른다. 다른 MR이 먼저 병합되면 번호를 다시 정한다.

## V26 NASA 행성 한국어 설명 (267)

`V26__nasa_planet_explanation.sql`은 V25의 `nasa_planet_info(candidate_id)`에 종속된 후보당 0~1행의 설명 테이블을 만든다. 같은 원천 해시·정규화 버전·모델·프롬프트 조합의 설명과 시도 횟수를 보관하며, 앱 역할에는 새 테이블 SELECT/INSERT/UPDATE만 부여한다. V25와 과거 마이그레이션을 수정하지 않고 V25 다음에 적용한다. 다른 MR이 먼저 develop에 병합되면 번호와 적용 순서를 다시 확인하고, 이미 적용된 DB의 파일·Flyway 이력을 `repair` 또는 `outOfOrder`로 고치지 않는다.

기본 비활성 상태에서도 V26 스키마는 앱 기동보다 먼저 필요하다. 보호된 배포 환경에만 모델 키 `GMS_KEY`를 주입하며 값은 파일·명령·로그에 적지 않는다. 실행 설정, 순서, 사후 확인과 중지·복구는 [운영 가이드](../../../docs/operations/nasa-planet-info-runbook.md), 필드·안전 검증과 267의 별 단위 응답은 [267 개발 계약](../../../docs/development/nasa-planet-explanation-267.md)을 따른다. `nasa-ko-v4`는 표적 회귀, TOI-700 b 한 후보의 실제 NASA PS·GMS 생성, 가상 회원·후보 4개의 인증 별 단위 GET 및 V25·V26 저장을 격리 환경에서 확인했다. 첫 GET 14,554ms와 즉시 재조회 82ms는 그 환경의 1회 표본이다. 실제 회원·Gold 연결, 모델의 운영 품질·비용·지연 분포, 공유/운영 DB 적용·서버 배포와 268 화면 연결은 검증하지 않았다. 특히 262 Publisher의 목업 외부 참조는 [266 식별 계약](../../../docs/development/nasa-planet-info-266.md#2-식별자와-요청-흐름)의 실제 후보 연결을 증명하지 않는다.

## V28 NASA 설명 일별 모델 시도 한도 (268)

`V28__nasa_explanation_daily_usage.sql`은 UTC 날짜와 회원 ID를 키로 하는 `nasa_explanation_daily_usage`, UTC 날짜를 키로 하는 `nasa_explanation_daily_total` 두 테이블을 만든다. 모델 시도권 확보 때 회원별·전체 수를 한 짧은 트랜잭션에서 올려 다중 서버의 일별 상한을 함께 지킨다. 한도 수치는 미지정이라 기본값이 각각 0이며, 설명 활성화 전 운영 승인된 양의 정수를 명시해야 한다. 회원 삭제로 회원별 행이 정리돼도 전체 일별 수는 남는다. 앱 역할에는 두 테이블의 SELECT/INSERT/UPDATE만 추가하고 DELETE는 주지 않는다. V25 NASA 원천·V26 설명과 269의 `V27__peak_submission_optional_duration.sql`을 수정하지 않고 그 다음 번호로 적용한다. GET 저장 조회, 재사용 POST, NASA 조회는 이 모델 시도 수에 포함하지 않는다.

기본값·환경변수 전달·DB 집계·중지 절차는 [운영 가이드](../../../docs/operations/nasa-planet-info-runbook.md#8-한국어-설명-생성-배포운영-267), 현재 GET/POST와 화면 경계는 [268 개발 계약](../../../docs/development/nasa-planet-request-268.md)을 따른다. 공유/운영 DB 적용·실제 GMS 비용 확인은 별도다.

## V29 결과 화면의 NASA 항성별 확정 행성 (270)

`V29__nasa_star_planets.sql`은 V28 다음에 `nasa_star_catalog`, `nasa_star_planet`, `nasa_star_planet_explanation` 세 테이블을 추가한다. 후보 ID 없이 `(tic_id, planet_id)`로 NASA 행성을 식별하고, 성공 조회에서 빠진 옛 행은 `active=false`로 보존한다. 목록 조회의 완전성·임대와 행성별 원천/설명 상태를 분리한다. V25·V26·V27·V28을 수정하지 않으며 Gold·후보 분류·성과에 쓰기 권한을 추가하지 않는다. 앱 역할은 세 신규 테이블의 SELECT/INSERT/UPDATE만 받는다. V28의 회원별·전체 일별 모델 시도권은 268 후보 설명과 270 선택 행성 설명이 공유한다.

Flyway 소유자와 앱 역할, 기존 V25→V28 적용 여부를 확인한 뒤 대상 DB에 적용한다. `repair`, `clean`, `outOfOrder`로 기존 이력을 우회하지 않는다. 기본 설명 비활성·한도 0/0에서도 V29 스키마는 270 API 기동 전에 필요하다. 테이블·상태는 [ERD G절](../../../docs/architecture/database-erd.md#g-요청된-외부-조회-자료와-한국어-설명-v25v26v28v29-266270), HTTP와 권한은 [270 개발 계약](../../../docs/development/nasa-star-planets-270.md), 적용 명령·기대 결과·장애/복구는 [운영 가이드 10절](../../../docs/operations/nasa-planet-info-runbook.md#10-결과-화면의-nasa-전체-목록-운영-270)을 따른다. 공유/운영 DB 적용과 실제 회원·GMS 호출은 별도 인수다.

## V30 챌린지 회차 추가 대상 (283)

`V30__challenge_round_extra_targets.sql`은 V29 다음에 추가 대상 테이블 `challenge_round_extra_targets`, 공개 별 검사 트리거(V9 함수 재사용), 대표·추가 대상을 합친 뷰 `challenge_round_targets`와 두 객체의 앱 역할 SELECT를 추가한다. `challenge_rounds.target_tic_id`는 대표 대상으로 그대로 두므로 기존 회차 INSERT와 V30 전 앱은 대표 대상만으로 동작한다. V21의 `global_stats`는 정의를 바꿀 수 없어 지우고 회차 참여(`rounds`)만 대상 전부로 넓혀 다시 만들며 SELECT·MAINTAIN 권한도 다시 준다. 운영 MV는 2026-09-27까지 채운 적이 없다(`ispopulated` false).

V1~V29를 수정하지 않으며 `repair`·`outOfOrder`로 순서를 우회하지 않는다. 관련 테스트는 `OperationRulesTest`, `ExplorationDomainPermissionTest`, `StatisticsMigrationTest`, `TutorialProgressTest`, `QuestPanelTest`, `AchievementServiceTest`다. 구조는 [ERD v1.17](../../../docs/architecture/database-erd.md), 추가 대상 등록과 명령 재실행은 [챌린지 회차 런북 4절](../../../docs/operations/challenge-round-runbook.md#4-회차-대상-별-더하기)을 따른다. 공유/운영 DB 적용은 별도다.

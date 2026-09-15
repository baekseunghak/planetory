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

프로필을 지정하지 않으면 `local`로 뜬다(`spring.profiles.default=local`). `local` 프로필(`application-local.properties`)에 로컬 DB 기본값(`localhost:15432`, `ssafy`)·Swagger·예제 API가 들어 있어 환경변수 없이 실행된다. 배포 이미지는 Dockerfile의 `ENV SPRING_PROFILES_ACTIVE=prod`로 이 기본값을 쓰지 않으며, `prod`에는 비밀번호 기본값이 없어 `DATABASE_*` 또는 `SPRING_DATASOURCE_*`를 주입하지 않으면 기동에 실패한다.

`bootRun`과 `test`는 먼저 `startLocalDb` 태스크로 루트 Compose의 `service-db`를 띄운다(`docker compose --profile service up -d --wait service-db`). 이미 떠 있으면 바로 끝난다. `CI=true`·`SKIP_LOCAL_DB=true` 환경이거나 `-PskipLocalDb`를 주면 건너뛴다. 로컬 Compose의 `backend` 컨테이너는 `SKIP_LOCAL_DB=true`로 실행한다.

```sh
cd apps/backend
./gradlew --version
./gradlew clean build
./gradlew bootRun
```

Windows PowerShell에서는 `./gradlew` 대신 `.\gradlew.bat`을 쓴다.

`Ctrl+C`로 서버를 종료한다. Windows에서 build/libs의 JAR를 직접 실행 중이면 파일 잠금 때문에 `clean`이 실패하므로 서버를 먼저 종료한다. IDE에서는 Project SDK와 Gradle JVM을 21로 지정한다. IDE의 main 실행은 Gradle을 거치지 않으므로 DB를 자동으로 띄우지 않는다. 예제 API와 Swagger는 local에서만 켠다.

DB와 backend를 모두 Docker로 실행하려면 루트에서 다음 명령을 쓴다. 호스트에서 실행 중인 8080 서버는 먼저 종료한다. 이번 검증은 DB 컨테이너 + 호스트 JDK 실행이며 backend 이미지 빌드·실행은 별도로 검증해야 한다.

```sh
docker compose --profile service up -d --build backend
```

### 환경변수

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

## 4. Flyway 최초 스키마

파일: `src/main/resources/db/migration/V1__initial_schema.sql`.
기준: [ERD v1.1](../../../docs/architecture/database-erd.md) 그림과 3장 본문. 그림에 생략된 memo·계산 버전·time_system·round_id·수정 시각 등도 본문에 따라 포함했다.

- 33개 테이블, 57개 FK, 닉네임 대소문자 무시 유일 인덱스, 별당 current 판·신호당 공식 스레드 부분 유일 인덱스, pg_trgm 검색 인덱스, 댓글 목록용 `comments (post_id, created_at)` 인덱스를 만든다.
- PK는 ERD의 BIGINT IDENTITY를 `GENERATED BY DEFAULT AS IDENTITY`로 구현했다. 별 TIC·1:1 FK PK·튜토리얼 순번·규칙 버전은 별도 생성하지 않는다.
- ERD가 명시한 선택 값은 nullable로 두고 기본적인 식별자·필수 본문·상태는 NOT NULL로 작성했다. 숫자는 명시된 numeric을 사용하며 임의의 정밀도 상한을 정하지 않았다. 이 null/default 해석은 초기 SQL 리뷰 대상이다.
- CHECK는 상태값, 공식 스레드 작성자·별 게시판 조건, 첨부 대상 XOR, 제출 위상·판단·매칭 후보 조건, 배열 길이 등을 검증한다. 소유자·동일 TIC처럼 여러 행을 비교하는 업무 검증은 API 구현 시 추가한다.
- `pg_trgm`은 public 스키마에 설치한다. 테스트 스키마와 개발 스키마에서 같은 확장을 사용하며, 테스트가 확장을 삭제하지 않는다.
- 사용자·별·운영 설정값을 자동으로 넣지 않는다. P1 테이블 생성이 P1 API 구현을 의미하지 않는다.
- FK 삭제 전파는 지정하지 않았다(NO ACTION). 탈퇴 처리 정책을 임의로 확정하지 않는다.

### V2 ERD v1.2 반영

파일: `V2__apply_erd_v1_2_star_coordinates_and_peak_source.sql`. V1 이후 ERD에서 바뀐 열 두 묶음을 반영한다.

**submissions 선택 봉우리(C02-R3):** `source_peak_grid_index`·`source_peak_suggested_duration_hours`·`duration_limit_hours`를 nullable로 추가한다. 셋은 모두 NULL(직접 주기 선택·candidate 외 제출)이거나 candidate 제출에서 모두 채워져야 하며, grid index는 0 이상, 두 시간 값은 양의 유한 값이다. 상한 배율 3배는 규칙 값이므로 DB에서 고정 비교하지 않는다.

**star_unlocks 별 자리 좌표:** `star_unlocks`에 `world_x`·`world_y`·`layout_version`을 NOT NULL로 추가하고, x/y 유한 값·`depth_z` -1~1·빈 배치 버전 금지 CHECK를 건다. 폐기 예정인 `generation`·`angle_deg`·`radius_jitter`는 nullable로 바꾼다.
보존할 운영 좌표가 없으므로 이관 SQL은 없다. `star_unlocks` 행이 이미 있는 개발 DB에서는 V2가 실패하므로 해당 행을 초기화한 뒤 적용한다. 타일 조회용 공간 인덱스는 성능 검증 후 별도 마이그레이션으로 추가한다.

앱 시작 시 Flyway가 자동 실행되고 이력은 `flyway_schema_history`에 저장된다. `baseline-on-migrate=false`, `clean-disabled=true`, Spring SQL 자동 초기화는 꺼져 있다. 기존 비어 있지 않은 DB를 임의 baseline/clean/repair로 통과시키지 않는다.

```sh
docker compose exec -T service-db psql -U planetory -d planetory_poc -c "SELECT version, description, installed_on, success FROM flyway_schema_history ORDER BY installed_rank;"
```

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
| 운영 seed·튜토리얼 TIC | ERD·탐사 담당자가 값 확정 후 별도 입력. `submissions.rule_version`이 `operation_settings`를 FK로 참조하므로 **탐사 제출 API를 붙이기 전에 seed 마이그레이션(또는 환경별 seed)이 먼저 적용되어야 한다** |
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
| GitLab CI·EC2 배포 | 후속 Task, 미검증 |
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

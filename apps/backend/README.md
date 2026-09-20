# Backend

Java 21 · Spring Boot 4.1.1 · Gradle Wrapper 9.7.1 · PostgreSQL 18.6 기반 서비스 백엔드다.

PostgreSQL 연결, ERD v1.1 기반 Flyway 최초 마이그레이션, JPA·JdbcClient 병행 데이터 접근, 공통 오류 응답, 로컬 Swagger UI·예제 API를 제공한다. OAuth 로그인·회원 생성·세션 인증·내 정보 조회는 [OAuth 설정 안내](docs/oauth-setup.md)를 따른다. 닉네임 변경·타인 공개 프로필·첫 방문 안내 완료 저장, 일반 게시글 CRUD와 일반 글·공식 스레드의 1단계 댓글 CRUD는 [서비스 API 명세](docs/service-api-spec.md) 3장·5장·6장을 따른다. 제공자 자격 증명과 실제 튜토리얼 초기 데이터는 별도로 설정하며, 피드·첨부·반응 API는 아직 구현하지 않았다.

이 문서는 처음 받은 PC에서 서버를 띄우기까지만 담는다. 버전 근거·마이그레이션 규칙·코드 작성 규칙은 [개발 환경 안내](docs/development-setup.md)를 본다.

## 빠른 시작

준비물은 **Docker Desktop(실행 중)** 하나다. Gradle·JDK 21은 설치하지 않아도 된다(Gradle Wrapper가 받아 온다. Wrapper 실행용 Java 17 이상만 있으면 된다).

```sh
cd apps/backend
./gradlew bootRun          # Windows: .\gradlew.bat bootRun
```

이 명령 하나로 다음이 순서대로 일어난다.

1. 루트 Compose의 PostgreSQL 컨테이너(`service-db`)를 띄운다. 이미 떠 있으면 바로 넘어간다.
2. `local` 프로필로 서버를 띄운다. 프로필을 지정하지 않으면 `local`이 기본이다.
3. 첫 기동이면 Flyway가 스키마를 만든다(`Successfully applied 1 migration`). 이후에는 `No migration necessary`.

뜨고 나면 확인:

| 확인 | 주소 | 기대 결과 |
|---|---|---|
| Swagger UI | http://localhost:8080/swagger-ui/index.html | API 목록 화면 |
| 예제 API | Swagger에서 `GET /api/v1/hello` → Try it out → Execute | 200, `{"message":"Planetory 백엔드가 실행 중입니다."}` |
| 상태 | http://localhost:8080/actuator/health | `{"status":"UP"}` |

빌드·테스트도 같은 방식이다. 테스트 전에 DB를 자동으로 띄운다.

```sh
./gradlew clean build      # Windows: .\gradlew.bat clean build
```

### IDE에서 실행

`PlanetoryApplication`의 main을 그냥 실행하면 된다. 프로필·환경변수 설정은 필요 없다.

단, IDE의 main 실행은 Gradle을 거치지 않아 **DB를 자동으로 띄우지 않는다.** 처음 한 번 `./gradlew bootRun`(또는 아래 DB 명령)으로 DB를 올려 두면 이후에는 IDE 실행만으로 된다. DB 컨테이너는 PC를 재부팅해도 Docker Desktop과 함께 다시 뜬다.

- **VS Code**: Extension Pack for Java 설치 후 `PlanetoryApplication.java`에서 Run. 빨간줄이 보이면 명령 팔레트 → `Java: Clean Java Language Server Workspace`.
- **IntelliJ**: `apps/backend`를 Gradle 프로젝트로 열고 Gradle JVM·SDK를 21로 지정한다. Settings → Build → Compiler → Annotation Processors → **Enable annotation processing**을 켠다(Lombok).

### 로컬 기본값

팀 전체가 같은 값을 쓴다. 바꿀 필요가 없다.

| 항목 | 값 |
|---|---|
| DB 접속 | `localhost:15432` / DB `planetory_poc` / 사용자 `planetory` / 비밀번호 `ssafy` |
| 서버 | `localhost:8080` |

- 로컬 개발 전용 값이다. DB 포트는 `127.0.0.1`에만 열린다. 배포 이미지는 `prod` 프로필로 뜨며 이 기본값을 쓰지 않는다.
- 15432를 쓰는 이유: PC에 PostgreSQL을 직접 설치한 경우의 5432와 겹치지 않게 하려고.
- DBeaver·DataGrip 같은 DB 클라이언트로도 위 값으로 접속할 수 있다.

### DB만 따로 다루기 — 저장소 루트

```sh
docker compose --profile service up -d --wait service-db   # 띄우기
docker compose --profile service stop service-db           # 멈추기(데이터 유지)
```

`docker compose up`만 하면 아무것도 뜨지 않는다. 모든 서비스에 프로필이 걸려 있다.

DB를 직접 관리해서 Gradle의 자동 기동을 끄고 싶으면 `-PskipLocalDb`를 붙인다.

## 자주 막히는 곳

| 증상 | 원인 | 해결 |
|---|---|---|
| `로컬 DB를 띄우지 못했습니다` | Docker Desktop이 꺼져 있음 | Docker Desktop 실행 후 다시 시도 |
| IDE 실행 시 `Connection refused` | IDE main 실행은 DB를 띄우지 않음 | `./gradlew bootRun`을 한 번 실행하거나 DB 띄우기 명령 실행 |
| `SQL State: 28P01` password authentication failed | 예전에 다른 비밀번호로 DB를 띄운 적이 있음. 비밀번호는 볼륨을 처음 만들 때 고정된다. 루트 `.env`에 옛 `POSTGRES_PASSWORD`가 남아 있어도 같은 증상 | `.env`의 `POSTGRES_*` 줄을 지우고 아래 "로컬 DB 초기화" |
| `Connection refused` (Gradle 실행) | 포트 불일치 | `docker compose ps service-db`에서 `127.0.0.1:15432->5432` 확인. 다르면 루트 `.env`의 `POSTGRES_PORT` 줄을 지운다 |
| `Validate failed: Migration checksum mismatch` | 적용된 뒤에 마이그레이션 파일이 바뀜(병합 전 브랜치에서 수정한 경우) | 아래 "로컬 DB 초기화" |
| `Port 8080 was already in use` | 다른 터미널·IDE·컨테이너에서 서버가 이미 실행 중 | 기존 서버를 종료한다 |
| Swagger가 404 | `SPRING_PROFILES_ACTIVE`가 다른 값으로 설정돼 있음 | 로그에 `profile: "local"`이 보이는지 확인하고 IDE 실행 구성·환경변수에서 프로필 설정을 지운다 |
| IDE에서 `import ... cannot be resolved` 빨간줄 | IDE가 Gradle 의존성을 아직 못 읽음 | VS Code: 명령 팔레트 → `Java: Clean Java Language Server Workspace`. IntelliJ: Gradle 새로고침 |
| Lombok 메서드(`getXxx`)를 못 찾음 | 어노테이션 처리 꺼짐 | IntelliJ Annotation Processors 설정. 터미널 빌드는 영향 없음 |
| Windows에서 `clean` 실패 | 실행 중인 서버가 build 폴더를 잡고 있음 | 서버 종료 후 다시 실행 |

### 로컬 DB 초기화

로컬 데이터를 모두 지운다. 공유·운영 DB에서는 쓰지 않는다.

```sh
# 저장소 루트
docker compose --profile service down -v service-db
docker compose --profile service up -d --wait service-db
```

## 더 보기

공개 분석 등록(161)은 `POST /api/v1/public-analyses`로 본인 History를 공식 스레드에 등록하고 성과·별 발견을 같은 트랜잭션으로 확정한다. `PublicAnalysisTest`가 실제 제출부터 공개·동시성·롤백·앱 역할 권한을 검증한다. 취소/재공개·목록/상세·일괄 API는 후속 티켓이며, 입력과 재시도 계약은 [서비스 API 9.1절](docs/service-api-spec.md#publication)을 따른다. V14 적용 순서는 [마이그레이션 안내](docs/development-setup.md#v14-공개-분석-등록-권한)를 확인한다.

히스토리 조회(148)는 개인 목록·상세·CURRENT/SUBMITTED 그래프와 서비스 도메인용 공개 투영을 제공한다. [계약·160 인계](docs/exploration-api-spec.md#851-서비스-도메인-인계148--160공개-분석-조회), `./gradlew -PskipLocalDb test --tests '*HistoryTest'`. 일회용 PostgreSQL에서 실제 제출·조회·권한·판 교체를 검증한다. 잔차 공급자만 대체하며 147·160·프론트 실제 연결은 별도 인수다.

제출 처리(143)는 `POST /api/v1/stars/{ticId}/submissions`다. V12가 요청 해시와 최초 응답 보존 열을 추가한다. `./gradlew -PskipLocalDb test --tests '*SubmissionTest'`는 Docker의 일회용 PostgreSQL에서 저장·재전송·롤백·보안 필터를 검증하며 기존 개발 DB를 사용하지 않는다. 봉우리/잔차는 테스트 경계만 대체하고 실제 141·147 연결은 담당자 인계 후 검증한다. [채택 계약과 인수 구분](../../docs/api/exploration/submission-readiness.md).

- [개발 환경 안내](docs/development-setup.md) — 설치 버전, 환경변수 전체, Flyway 규칙, 스키마 담당 합의, 검증 결과, 코드 구조·작성 규칙
- [서비스 API 명세](docs/service-api-spec.md) · [탐사 API 명세](docs/exploration-api-spec.md) · [API 명세 파트 분담](docs/README.md)
- [프로젝트 문서 지도](../../docs/README.md) — 요구사항·아키텍처·데이터·운영 문서 진입점

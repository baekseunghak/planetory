# Backend

Java 21 · Spring Boot 4.1.1 · Gradle Wrapper 9.7.1 · PostgreSQL 18.6 기반 서비스 백엔드다.

PostgreSQL 연결, ERD v1.1 기반 Flyway 최초 마이그레이션, JPA·JdbcClient 병행 데이터 접근, 공통 오류 응답, 로컬 Swagger UI·예제 API를 제공한다. OAuth 로그인·회원 생성·세션 인증·내 정보 조회는 [OAuth 설정 안내](docs/oauth-setup.md)를 따른다. 닉네임 변경·타인 공개 프로필·첫 방문 안내 완료 저장, 일반 게시글 CRUD와 일반 글·공식 스레드의 1단계 댓글 CRUD, 본인 History 첨부·공개 조회와 일반 글 반응은 [서비스 API 명세](docs/service-api-spec.md) 3~9장을 따른다. 전체/별 기본 피드·공식 스레드·공개 분석 목록/상세도 제공한다. 제공자 자격 증명과 실제 튜토리얼 초기 데이터는 별도로 설정하며 피드의 제목·본문·현재 닉네임·TIC·게시판·태그 검색을 제공한다(169). 공개 출처 카드는 아래 167 안내를 따른다.

이 문서는 처음 받은 PC에서 서버를 띄우기까지만 담는다. 버전 근거·마이그레이션 규칙·코드 작성 규칙은 [개발 환경 안내](docs/development-setup.md)를 본다.

S15P21C206-166의 신호별 대표 공개 후보 조회와 최대 20개 순차 일괄 공개는 [서비스 API 9.4절](docs/service-api-spec.md#batch)을 따른다. 기존 단건 공개·성과 처리를 항목별 독립 트랜잭션으로 재사용하며 신규 테이블·마이그레이션은 없다.

S15P21C206-150의 판 전환 후처리는 `POST /internal/bundles/{bundleId}/activated`로 실행한다([탐사 API 10장](docs/exploration-api-spec.md)). 회원 세션이 아니라 `INTERNAL_SERVICE_TOKEN`으로 설정한 공유 비밀을 요청 헤더 `X-Planetory-Service-Token`에 넣어 부른다. **설정하지 않으면 `/internal/**` 전체가 401이라 로컬에서도 부를 수 없다.** 실제 호출자인 Publisher(S15P21C206-87)는 아직 없으므로 지금은 직접 부를 때만 필요하다.

```sh
INTERNAL_SERVICE_TOKEN=local-only ./gradlew bootRun
curl -X POST http://localhost:8080/internal/bundles/b-1/activated -H 'X-Planetory-Service-Token: local-only'
```

## 빠른 시작

준비물은 **Docker Desktop(실행 중)**과 별도 Redis 두 인스턴스다. local 기본 연결은 세션 `localhost:16379`, 캐시 `localhost:16380`이다. 다른 주소에서는 `SESSION_REDIS_HOST`·`SESSION_REDIS_PORT`·`CACHE_REDIS_HOST`·`CACHE_REDIS_PORT`를 설정한다. 로그인 저장소와 계산 캐시를 같은 인스턴스로 지정하지 않는다. [Redis 연결·검증 경계](docs/oauth-setup.md#redis-연결과-저장-경계237)를 따른다. Gradle·JDK 21은 설치하지 않아도 된다(Gradle Wrapper가 받아 온다. Wrapper 실행용 Java 17 이상만 있으면 된다).

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

로컬 Redis가 없다면 아래 두 개발용 컨테이너를 먼저 실행한다(운영 설정이 아니다). Gradle은 Redis를 자동으로 시작하지 않는다.

```powershell
docker run -d --name planetory-local-session -p 127.0.0.1:16379:6379 redis:8.2-alpine
docker run -d --name planetory-local-cache -p 127.0.0.1:16380:6379 redis:8.2-alpine
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

일반 글 반응(163)은 최종 상태 PUT과 반응자 커서 GET을 제공하며 상세·수정 응답에 실제 반응 합계를 반환한다. `./gradlew -PskipLocalDb test --tests '*PostReactionTest' --tests '*MemberCommunityPermissionTest' --tests '*PublicAnalysisTest'`로 일회용 PostgreSQL의 HTTP·동시성·삭제 경합·최소 권한·공개 판단 비변경을 검증한다. [서비스 API 8장](docs/service-api-spec.md#reactions), [V16 권한 안내](docs/development-setup.md#v16-일반-글-반응-권한)를 따른다.

공개 분석 등록(161)은 `POST /api/v1/public-analyses`로 본인 History를 공식 스레드에 등록하고 성과·별 발견을 같은 트랜잭션으로 확정한다. `PublicAnalysisTest`가 실제 제출부터 공개·동시성·롤백·앱 역할 권한을 검증한다. 취소/재공개(162)와 목록/상세(164)를 제공하며 일괄 API는 후속 티켓이다. 입력과 재시도 계약은 [서비스 API 9.1절](docs/service-api-spec.md#publication)을 따른다. V14 적용 순서는 [마이그레이션 안내](docs/development-setup.md#v14-공개-분석-등록-권한)를 확인한다.

히스토리 조회(148)는 개인 목록·상세·CURRENT/SUBMITTED 그래프와 서비스 도메인용 공개 투영을 제공한다. [계약·160 인계](docs/exploration-api-spec.md#851-서비스-도메인-인계148--160공개-분석-조회), `./gradlew -PskipLocalDb test --tests '*HistoryTest'`. 일회용 PostgreSQL에서 실제 제출·조회·권한·판 교체를 검증한다. 160은 이 공개 투영과 Graph를 재사용하며 147 잔차 공급자·프론트 실제 렌더러 연결은 별도 인수다.

History 첨부(160)는 기존 글·댓글 쓰기와 부모 경로 GET에 연결한다. `./gradlew -PskipLocalDb test --tests '*HistoryAttachmentTest' --tests '*MemberCommunityPermissionTest'`로 실제 제출부터 첨부·공개 HTTP·권한 철회·V13 앱 역할 권한을 검증한다. 그래프 503 시 같은 부모 경로의 `includeGraph=false`로 공개 내용을 별도 조회한다. 상세 입력·권한·관련 티켓 경계는 [서비스 API 7장](docs/service-api-spec.md#attachments)을 따른다.

제출 처리(143)는 `POST /api/v1/stars/{ticId}/submissions`다. V12가 요청 해시와 최초 응답 보존 열을 추가한다. `./gradlew -PskipLocalDb test --tests '*SubmissionTest'`는 Docker의 일회용 PostgreSQL에서 저장·재전송·롤백·보안 필터를 검증하며 기존 개발 DB를 사용하지 않는다. 봉우리/잔차는 테스트 경계만 대체하고 실제 141·147 연결은 담당자 인계 후 검증한다. [채택 계약과 인수 구분](../../docs/api/exploration/submission-readiness.md).

- [개발 환경 안내](docs/development-setup.md) — 설치 버전, 환경변수 전체, Flyway 규칙, 스키마 담당 합의, 검증 결과, 코드 구조·작성 규칙
- [서비스 API 명세](docs/service-api-spec.md) · [탐사 API 명세](docs/exploration-api-spec.md) · [API 명세 파트 분담](docs/README.md)
- [프로젝트 문서 지도](../../docs/README.md) — 요구사항·아키텍처·데이터·운영 문서 진입점

전체·비교 통계(178)는 인증된 `GET /api/v1/statistics`와 별도 `statistics` 운영 명령이다. V21은 173의 V20 다음에 적용한다. MV 10분·일별 기준선은 [통계 실행 런북](../../docs/operations/statistics-runbook.md)을 따르며 웹 요청에서 갱신하지 않는다. `StatisticsAggregationTest`, `StatisticsMigrationTest`, `StatisticsCommandTest`는 전용 일회용 PostgreSQL에서 모수·중앙값·실패·최소권한·신규 및 업그레이드를 검증한다. 공유/운영 DB 적용과 스케줄 활성화는 별도다.

커뮤니티 조회(164)는 전체/별 기본 피드, SYSTEM 공식 스레드 상세, 판단 필터 공개 분석 목록과 제한된 공개 상세를 제공한다. 서비스 API 4.1·9.2절의 지원 쿼리·커서·별 열림·no-store 계약을 따른다. CommunityReadTest는 일회용 PostgreSQL에서 HTTP·동일 스냅샷·공개 그래프 접근 철회를 검증한다. 검색 전체(169)·핫 토픽(171)·팔로우(173)는 후속 범위다.

출처 카드(167)는 같은 별의 공식 스레드·공개 분석 미리보기와 글·댓글 연결을 제공한다. 취소·숨김된 기존 출처는 ID 없는 안내만 반환하며 본문 수정에서 보존한다. [서비스 API 5~7장](docs/service-api-spec.md#attachments), [V18 권한](docs/development-setup.md#v18-출처-관계-권한)을 따른다. `SourceCardTest`는 일회용 PostgreSQL에서 HTTP·공개 상태·동일 스냅샷·교체 및 삭제 경합·최소 앱 권한·성과 비변경을 검증한다.

핫 토픽(171)은 [서비스 API 4.2절](docs/service-api-spec.md#42-핫-토픽)에 따라 현재 유효 참여자 10명 이상 공식 스레드를 전역 순위와 전용 커서로 제공한다. 위 164 구현 당시의 후속 범위 중 171을 구현했다. `./gradlew -PskipLocalDb test --tests '*HotTopicsTest' --tests '*CommunityReadTest' --tests '*PublicAnalysisTest'`는 일회용 PostgreSQL에서 선정·공개 철회·커서·동일 스냅샷·앱 역할 및 기존 조회·공개 회귀를 검증한다. 새 테이블·마이그레이션은 없고 실제 프론트 브라우저 인수는 별도다.

171 리뷰 보완: 댓글 수는 선정 SQL에서 함께 조회하며 항목별 추가 왕복을 하지 않는다. 선정과 커서의 임계값은 `HotTopicsQuery.HOT_TOPIC_MIN_PARTICIPANTS`를 공유한다. 합성 스레드 100개 테스트의 실행 계획 출력은 측정 자료이며 특정 인덱스 사용을 보장하는 검사가 아니다. 해당 SQL 측정 시간은 항목별 판단 요약을 포함한 전체 API 응답 시간이 아니다.

현재 챌린지 조회(168)는 인증된 `GET /api/v1/challenges/current`로 운영 active 회차·튜토리얼 완료 자격·별 단위 참여자 수를 반환한다. 기존 퀘스트 집계를 재사용하고 GET에서 발견·안내 확인을 저장하지 않는다. 상세 계약은 [서비스 API 11장](docs/service-api-spec.md#11-주간-챌린지첫-접속-안내--f17)을 따른다. `./gradlew -PskipLocalDb test --tests '*QuestPanelTest'`로 일회용 PostgreSQL에서 HTTP·자격·참여 수·데이터 불변·앱 역할 조회를 검증한다.

개인 통계(177)는 인증된 `GET /api/v1/me/statistics`로 현재 개인 지표·KST 기준 8주·비교 기준선을 제공한다. 첫 매칭·공개 대표·인정 근거를 구분하며 과거 원천이 없으면 본인 비교값은 당시 자료 부족이다. [서비스 API 12.2.1](docs/service-api-spec.md#1221-본인-상세-통계--177)을 따른다. `./gradlew -PskipLocalDb test --tests '*SubmissionTest' --tests '*QuestPanelTest' --tests '*PublicAnalysisTest' --tests '*StarResultTest'`로 일회용 PostgreSQL에서 검증한다. Snapshot 읽기·마이그레이션은 178과 함께 통합해야 하며 프론트 상세 통계 연결은 별도 인수다.


팔로우(173)는 회원·별 관계, 본인 명단/공개 수치, 팔로잉 피드와 비공개 별 관리 해제를 제공한다. [서비스 API 12.1](docs/service-api-spec.md#follow-policy)·[V20 권한](docs/development-setup.md#v20-팔로우-권한)을 따른다. `./gradlew -PskipLocalDb test --tests '*FollowTest' --tests '*MemberCommunityPermissionTest' --tests '*CommunityReadTest' --tests '*HotTopicsTest'`는 실제 앱 역할과 일회용 PostgreSQL에서 관계/경합/페이지/기존 조회 회귀를 검사한다. FE219 관리 UI·첫 페이지 복귀와 실제 배포 인수는 별도다.

공개 은하(251)는 인증된 `GET /api/v1/members/{memberId}/sky`, `/sky/tiles`, `/stars/{ticId}`로 소유자의 전체 보유 별과 성과 조건을 충족한 공개 행성을 조회한다. 저장 좌표를 재사용하며 공개 전용 DTO·커서·버전과 반환 직전 최신 공개 권한 검사를 적용한다. 구현·격리 DB 검증 완료이며 상세 정책과 검증 범위는 [공개 은하 계약](docs/public-sky-contract.md)을 따른다. 새 마이그레이션은 없고, 250 프론트와의 실제 로그인·공개 설정 변경·배포 인수는 244에 남는다.

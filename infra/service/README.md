# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A 수동 배포 job이 이 Compose를 사용해 선택한 서비스만 갱신한다. EC2-B에는 서비스 역할이 없으므로(시스템 아키텍처 8장 D4) `ec2-b/`에는 서비스 설정을 두지 않고 CI·외부 관찰 설정만 둔다([ec2-b/README.md](ec2-b/README.md)). 노드별 서비스 차이가 필요하면 `ec2-a/`에 둔다.

## Backend 비밀 값 추가

Backend가 새 비밀 값을 읽을 때는 두 곳을 함께 바꾼다. compose는 `environment:`에 적힌 변수만 컨테이너에 넘기므로 서버 `.env`에만 넣으면 Backend가 보지 못한다.

1. `compose.yaml` backend `environment:`에 `NAME: ${NAME:-}`로 적는다. `:?`로 적으면 값이 없는 노드에서 `config -q`와 기동이 깨진다.
2. 서버 `.env`에 값을 직접 넣고 Backend를 다시 배포한다. 배포 job은 `compose.yaml`만 올리고 `.env`는 이미지 줄 외에 바꾸지 않는다. 값은 MR·메신저에 붙여 넣지 않는다.

`apps/backend/.env.oauth.properties`는 로컬 PC 전용이다(`spring.config.import`, Git 제외). 운영에는 전달되지 않는다.

| 변수 | 용도 | 상태 |
|---|---|---|
| `GMS_KEY` | GMS 행성 설명 API 키 | compose가 전달하고 267 Backend가 설명 기능 활성화 시 읽음. 비어 있으면 기본 비활성 기동 |

NASA 원천 조회의 `NASA_PLANET_INFO_*` 7개 설정도 Compose가 Backend에 전달한다. 서버 `.env`에서 값을 바꾼 뒤 Backend를 다시 배포하면 적용된다. 기본값·단위·중지와 복구 절차는 [NASA 행성 정보·설명 운영 가이드](../../docs/operations/nasa-planet-info-runbook.md)를 따른다.
설명 생성의 사용자별·전체 일일 한도(`NASA_EXPLANATION_DAILY_PER_MEMBER`, `NASA_EXPLANATION_DAILY_GLOBAL`)도 같은 방식으로 전달한다. 한도값은 미정이라 기본 0이며, 새 모델 호출을 활성화하기 전에 두 값을 결정해 주입해야 한다.

## service-db

PostgreSQL 18.6을 같은 Compose 안에서 `service-db`로 띄운다. Backend는 `service` 네트워크로 `service-db:5432`에 붙는다. 호스트에는 `127.0.0.1:5432`만 연다. 이 포트는 GCP Node 1 Publisher 전용이고 아래 「Publisher 운영 적재 경로」의 `tailscale serve`만 이 포트로 넘긴다. 외부 인바운드는 0개다.

`.env`에 `POSTGRES_PASSWORD`가 없으면 기동이 실패한다. `POSTGRES_DB`, `POSTGRES_USER`와 Backend의 `DATABASE_*`는 기본값을 쓰면 서로 맞는다.

데이터는 named volume `planetory-service-db-data`에 있다. 이 볼륨이 회원·제출·히스토리의 유일한 사본이다(복제·백업 없음, ADR D6·D7). `docker compose down -v`와 볼륨 이름 변경은 곧 데이터 상실이다. 재배포·이미지 교체는 볼륨을 지우지 않는다.

마운트 경로 `/var/lib/postgresql`은 postgres:18에서 바뀐 규약이다. 17 이하의 `/var/lib/postgresql/data`로 되돌리면 깨진다.

## 세션·캐시 Redis

Backend는 Redis 인스턴스 **두 개**를 요구한다. `session-redis`는 로그인 세션 저장소이고 `cache-redis`는 지정한 별의 Gold 곡선·원본 주기도와 잔차 계산 캐시용이다(SRS DAT-14). 둘 다 호스트 포트를 열지 않고 `service` 네트워크 안에서만 붙으며 외부 인바운드는 0개다.

`RedisSessionConfig`가 기동 시 두 주소를 비교해 **host와 port가 모두 같으면 예외를 던지고 앱을 띄우지 않는다.** 캐시 eviction이 로그인 세션을 지우는 것을 막는 경계이므로, 한 인스턴스를 DB 인덱스로 나눠 쓰는 우회는 통하지 않는다.

주소는 `.env`가 아니라 `compose.yaml`이 서비스 이름으로 직접 준다(`session-redis:6379`, `cache-redis:6379`). `.env`에 없는 변수 하나가 기동을 막는 실패를 되풀이하지 않기 위해서다.

| | 저장 | maxmemory | 축출 | 잃으면 |
| --- | --- | --- | --- | --- |
| `session-redis` | 볼륨 `planetory-session-redis-data`, 기본 RDB 저장점 | 64mb | `noeviction` | 전원 로그아웃. 데이터 손실은 아니다 |
| `cache-redis` | 없음(`--save ""`) | 128mb(임시) | `volatile-lru` | Gold 읽기 캐시는 DB에서 다시 읽고 계산 결과는 재계산한다 |

두 인스턴스의 상한은 따로다. 한쪽의 여유가 다른 쪽을 돕지 못하므로 합계(192mb)가 같은 호스트의 PostgreSQL을 밀어내지 않는지가 기준이다([EC2 서비스 진입·장애 대응](../../docs/architecture/ec2-service-entry-failover.md) D1). 컨테이너 `mem_limit`은 걸지 않는다. 넘는 순간 OOM으로 컨테이너가 죽는데, 세션 쪽이면 전원 로그아웃이다. `maxmemory`는 쓰기만 실패시킨다.

**`maxmemory`는 프로세스 메모리의 상한이 아니다.** Redis가 세는 데이터 메모리(`used_memory`)의 상한이다. 조각화, 클라이언트 버퍼, RDB 저장 중 fork의 copy-on-write 때문에 실제 점유(RSS)는 이보다 커진다. 192mb 합계는 초기 예산이고, 호스트 메모리를 따질 때는 `used_memory_rss`를 본다.

### 세션 상한에 닿으면

세션은 지우지 않으므로 상한에 닿으면 **새 로그인과 세션 연장이 쓰기 실패로 막힌다.** 이미 맺은 세션의 읽기는 계속된다. Redis의 OOM 오류는 `RedisSessions`가 `StoreUnavailableException`으로 감싸고 `SessionDependencyFilter`가 503(`DEPENDENCY_UNAVAILABLE`)으로 응답한다. 이 경로는 코드로 확인했고 실제로 상한까지 채워 보지는 않았다.

64mb는 세션 1개 실측(약 2.4KB, 2026-09-23)으로 2만 개 남짓이다. 동시 접속 목표([DEC-16](../../docs/requirements/planetory-decision-register.md))가 정해지면 다시 잡는다. 관측은 두 값으로 한다.

```sh
docker compose exec session-redis redis-cli info memory | grep -E '^(used_memory_human|used_memory_rss_human|maxmemory_human):'
docker compose exec session-redis redis-cli info errorstats | grep OOM
```

`errorstat_OOM`이 0이 아니면 이미 로그인 실패가 난 것이다. `used_memory`가 상한의 80%를 넘으면 늘릴 때다. `used_memory_rss`는 호스트 예산을 볼 때 쓴다.

### 캐시 축출은 만료가 걸린 키만

`cache-redis`에는 결과만이 아니라 진행 상태와 중복 계산 잠금이 함께 들어온다(SRS DAT-14). `volatile-lru`는 만료가 걸린 키만 축출한다. 결과 키에 TTL을 주면 결과만 축출 후보가 되고 TTL이 없는 키는 축출되지 않는다. `allkeys-lru`는 잠금을 결과와 같은 확률로 지워 DAT-14가 막은 중복 계산을 허용하므로 택하지 않았다. TTL 없는 키만으로 상한에 닿으면 캐시 쓰기가 실패하고 온라인 계산만 멈춘다.

**이것은 축출 정책이지 잠금 정책이 아니다.** TTL 없는 잠금은 소유 프로세스가 중단되면 남아 해당 키의 계산을 영구히 막는다. 반대로 잠금에 TTL을 붙이면 같은 `volatile-lru` 인스턴스에서 축출 후보가 된다. 계산 상태·잠금 소비처는 아직 없다. Gold 읽기 캐시 키는 1일 TTL로 축출 대상이다. 계산 결과 키의 TTL·축출 정책과 별개로, **상태·잠금의 만료·소유권·장애 회수와 축출 보호 방식은 소비 코드를 연결하기 전에 확정한다.** TTL 없는 잠금만으로 안전성을 보장하지 않는다([Redis 분산 잠금](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)). 크기는 `S15P21C206-104` 실측 뒤 확정한다([DEC-35](../../docs/requirements/planetory-decision-register.md)).

Backend는 `cache-redis`에 기동을 의존하지 않는다(`depends_on`에 없다). 캐시는 선택 의존성이라 health도 세션만 본다. 캐시가 unhealthy여도 Backend는 뜨고 온라인 계산만 멈춘다. 연결은 처음 쓸 때 맺는다.

### 비밀번호

`requirepass`를 걸지 않는다. 호스트 포트가 없어 외부에서 닿지 않는다. 위험은 외부가 아니라 같은 `service` 네트워크에 붙는 다른 컨테이너다. **우리가 만들지 않은 컨테이너를 `service` 네트워크에 붙이면** 그때 `SESSION_REDIS_PASSWORD`·`CACHE_REDIS_PASSWORD`를 `.env`로 넣는다. 두 변수는 Backend가 이미 읽는다.

### 최초 기동은 수동이다

`deploy.sh`는 `docker compose up -d --no-deps <service>`로 교체하므로 **의존 서비스를 만들지 않는다.** `service-db`와 마찬가지로 두 Redis도 배포 노드에서 한 번 직접 띄운다. 이후 배포는 이미 도는 컨테이너를 그대로 쓴다.

```sh
cd "$DEPLOY_PATH" && docker compose up -d session-redis cache-redis
```

설정(`command`)을 바꿨을 때도 같은 명령을 쓴다. compose가 바뀐 컨테이너만 다시 만든다. 세션은 볼륨에 남으므로 로그인이 유지되고, 캐시는 비워진다.

Gold 읽기 캐시는 기본 비활성이다. 운영자가 `.env`에 `GOLD_CACHE_ENABLED=true`와 쉼표로 구분한 `GOLD_CACHE_TIC_IDS=<TIC_ID_1>,<TIC_ID_2>`를 지정하고 Backend를 재시작하면 해당 별의 현재 판 곡선·원본 주기도를 시작 시 적재한다. 캐시는 서블릿 웹 서버와 세션 Redis가 활성화된 경우에만 생성되며, 같은 환경변수를 받는 비웹 운영 명령은 DB에서 읽는다. 후보 모델과 공개·권한 판단은 DB에서 읽는다. 새 판 알림이 오면 다시 적재하고, 알림이 없어도 다음 곡선·주기도 조회에서 DB를 읽어 채운다. 지정하지 않은 별도 DB에서 분석할 수 있다. Redis가 비거나 장애가 나면 DB에서 읽는다. 초기 운영 예상은 별 5개 또는 10개이며 실제 TIC 목록은 미정이다. `cache-redis`의 기본 128mb가 선택한 별 전체와 향후 계산 캐시를 수용하는지 `redis-cli info memory`의 `used_memory`·`used_memory_rss`와 축출 수를 측정한 뒤 별 수 또는 용량을 정한다. 앱 전체 health는 세션 쪽만 검사한다(`RedisSessionConfig`의 `redisHealthIndicator`).

주간 챌린지 별 등록부터 캐시 대상 지정·회차 전환·검증까지는 [챌린지 별 등록·회차 전환 런북](../../docs/operations/challenge-round-runbook.md)을 따른다.

## 계정 분리

접속 계정은 둘이다. 소유자는 GRANT/REVOKE의 영향을 받지 않으므로 나누지 않으면 권한 분리가 성립하지 않는다(`V2__gold_roles.sql` 주석).

| 계정 | 하는 일 | 주입 |
|---|---|---|
| `planetory` | 테이블 소유자. Flyway 마이그레이션을 실행한다 | `POSTGRES_USER`·`POSTGRES_PASSWORD` |
| `planetory_service` | 앱 런타임. `planetory_app` 역할만 가진다 | `DATABASE_USER`·`DATABASE_PASSWORD` |

두 비밀번호는 **서로 다른 값**이어야 한다. 같으면 계정은 나뉘어도 앱 비밀이 유출될 때 소유자 계정까지 열린다.

`service-db-init/10-app-account.sh`가 `planetory_service`를 만들고 역할을 부여한다. postgres 이미지의 initdb 훅은 **빈 데이터 디렉터리를 처음 초기화할 때만** 실행되므로, 이미 데이터가 있는 볼륨에는 소유자로 접속해 아래를 한 번 실행한다.

```sql
CREATE USER planetory_service PASSWORD '<DATABASE_PASSWORD와 같은 값>';
GRANT planetory_app TO planetory_service;
REVOKE CREATE ON SCHEMA public FROM planetory_service;
```

`application.properties`는 Flyway에 계정만 지정한다. `spring.flyway.user`가 설정되면 Boot가 런타임 연결 주소를 가져다 별도 연결을 만들므로 `spring.flyway.url`은 두지 않는다. 주소를 설정 문자열로 박아두면 Testcontainers의 `@ServiceConnection`처럼 문자열 없이 연결을 바꾸는 테스트에서 앱과 Flyway가 서로 다른 DB를 보게 된다.

```properties
spring.flyway.user=${DATABASE_MIGRATION_USER:${spring.datasource.username}}
spring.flyway.password=${DATABASE_MIGRATION_PASSWORD:${spring.datasource.password}}
```

대체값이 런타임 연결 설정을 따라가므로, `DATABASE_MIGRATION_*`를 주지 않는 환경(로컬 개발·테스트)은 마이그레이션과 런타임이 같은 계정을 쓰고 동작이 바뀌지 않는다. 계정 분리는 `DATABASE_MIGRATION_*`를 줄 때만 성립한다.

### V21 통계 역할 사전 생성

`service-db-init/10-app-account.sh`는 빈 볼륨 초기화 때 `planetory_stats_job NOLOGIN`도 만든다. 기존 볼륨의 initdb 훅은 재실행되지 않는다. CREATEROLE이 없는 마이그레이션 계정으로 V21을 적용하기 전, 운영 담당이 역할 존재를 확인하고 없으면 역할 생성 권한이 있는 계정으로 `CREATE ROLE planetory_stats_job NOLOGIN;`을 실행한다. 누락되면 V21은 원인과 사전 생성 명령을 안내하고 실패한다. 앱 런타임에 CREATEROLE이나 이 그룹을 부여하지 않는다.

통계 전용 로그인 공급·권한 부여·외부 스케줄은 [통계 실행 런북](../../docs/operations/statistics-runbook.md)을 따른다. 이 변경은 운영 DB 실행이나 계정 공급 완료를 뜻하지 않는다.

## 최초 가입에 필요한 초기 데이터

빈 DB에서는 **아무도 가입할 수 없다.** 가입 트랜잭션이 튜토리얼 1번 별을 지급하는데, 마이그레이션의 시드가 `operation_settings` 한 건뿐이라 `tutorial_stars`가 비어 있기 때문이다. 이때 콜백은 `503 DEPENDENCY_UNAVAILABLE`이 되고 회원 생성까지 롤백된다(자세한 조건은 [OAuth 설정](../../apps/backend/docs/oauth-setup.md)).

화면에는 이 503이 `/oauth/callback?error=authentication_failed`로 보인다. `apps/frontend/nginx.conf`가 `/login/oauth2/`의 401·403·503을 같은 경로로 모으기 때문이며, 인증 정보 문제로 오인하기 쉽다.

넣는 순서가 정해져 있다. `tutorial_stars.tic_id`는 `stars`를 참조하고(`fk_tutorial_stars_tic_id`), `trg_tutorial_stars_published` 트리거가 `service_status='published'`를 요구한다. 순서를 뒤집으면 거절된다.

```sql
BEGIN;
INSERT INTO stars (tic_id, confirmed_count, service_status)
VALUES (<운영 TIC>, 1, 'published')
ON CONFLICT (tic_id) DO UPDATE SET service_status = 'published';

INSERT INTO tutorial_stars (seq, tic_id, intent, active)
VALUES (1, <운영 TIC>, 'deep_confirmed', true)
ON CONFLICT (seq) DO NOTHING;
COMMIT;
```

로그인에는 `seq=1` 하나면 된다. 2~5번은 튜토리얼 완료·챌린지 자격 판정에 쓰인다. 어떤 TIC을 쓸지는 운영이 정하며 이 저장소는 값을 정하지 않는다.

## Gold 목업

서비스 DB에 실제 Gold가 오기 전까지 분석 화면을 열어 보기 위한 목업 판이다 [S15P21C206-262]. Gold가 없으면 `GET /api/v1/stars/{tic}/analysis-context`가 503(`DEPENDENCY_UNAVAILABLE`)이다. 현재 판이 없다는 뜻이며 일시 장애가 아니다.

적재 단계는 실제 Publisher 코드(`distributed-system/publisher`)이고 **입력만** 계약 예시 payload다. 정본 절차를 그대로 밟는다. `gold_writer` 계정, TIC 잠금, staging → current 전환을 한 트랜잭션으로, 커밋 뒤 Backend 알림. 실제 Gold로 바꿀 때는 입력 어댑터만 바뀐다. 구조는 [Publisher](../../distributed-system/publisher/README.md).

목업 행은 판 `bundle_version`과 세그먼트 `binning_revision`의 `mock-` 표식으로 알아본다. 삭제는 이 표식으로만 한다.

### 한계

- 열리는 것은 분석 진입, 원본 곡선, 원본 주기도, 후보 목록까지다. 후보를 빼는 잔차 단계는 Worker(`apps/derived-compute`, `S15P21C206-88`)를 EC2-A에 올리고 Backend에 `DERIVED_COMPUTE_URL`을 넣어야 열린다(아래 「온라인 계산 Worker」의 첫 배포 절차).
- 등록된 별(`stars`)에만 싣고 별 속성은 바꾸지 않는다. 같은 별에 새 판을 올리면 이전 후보는 은퇴한다.
- 판이 current가 될 때 V23 트리거가 후보 변경을 기록한다. 재개 알림은 **그 별을 팔로우한 회원에게만** 간다.

### 준비 (한 번)

`planetory_gold_writer`는 로그인할 수 없는 그룹 역할이다. 로그인 계정을 소유자로 만든다. 비밀번호는 명령줄에 두지 않는다. `flyway_schema_history`·`operation_settings`는 `gold_writer` 권한 밖이라 preflight용 SELECT를 따로 준다. 없으면 적재가 `MIGRATION_UNREADABLE`로 멈춘다.

```sh
cd "$DEPLOY_PATH"
docker compose exec service-db psql -U planetory -d planetory_poc \
  -c "CREATE USER planetory_publisher IN ROLE planetory_gold_writer" \
  -c "GRANT SELECT ON flyway_schema_history, operation_settings TO planetory_publisher" \
  -c "REVOKE CREATE ON SCHEMA public FROM planetory_publisher"
docker compose exec service-db psql -U planetory -d planetory_poc -c "\password planetory_publisher"
```

같은 비밀번호를 `.env`의 `PUBLISHER_DB_PASSWORD`에 넣는다. 판 전환 알림을 보내려면 `INTERNAL_SERVICE_TOKEN`도 넣고 Backend를 다시 배포한다. 토큰이 없으면 알림만 생략되고 판은 current가 된다.

### 적재

이미지는 CI `build:publisher`가 커밋 SHA로 만든다. 이미지의 시작 명령은 `CMD ["python", "-m", "publisher"]`인데 `docker compose run <서비스> <인자>`는 `CMD`를 인자로 통째로 대체한다. `run gold-mock mock-load`는 명령이 `["mock-load"]`가 되어 `executable file not found`로 실패하므로 `python -m publisher <명령>`까지 적는다.

```sh
cd "$DEPLOY_PATH"
export PUBLISHER_IMAGE=<registry>/planetory/publisher:<sha>
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher mock-load --tic <TIC 목록>
```

**`--no-deps`를 빼지 않는다.** 배포 job은 늘 `--no-deps`로 대상 서비스만 바꾸므로 `service-db` 설정 변경이 적용되지 않은 채 쌓여 있을 수 있다. `--no-deps` 없는 `run`은 의존 서비스를 맞추면서 `service-db` 컨테이너를 재생성한다. 2026-09-25 운영 적재에서 실제로 일어났다. 데이터는 볼륨이라 남았지만 몇 초 동안 DB 연결이 끊겼다.

분석은 회원이 발견한 별만 열린다(`STAR_LOCKED`). 화면을 열어 볼 목적이면 회원 대부분이 가진 튜토리얼 별을 넣는다. 운영에 올린 대상은 [서비스 배포 현재 상태](../../docs/project/service-deploy-status.md) 「손으로 넣은 데이터」에 적는다.

같은 명령을 다시 돌리면 `ALREADY_PUBLISHED`로 끝나고 DB는 바뀌지 않는다. 같은 TIC이면 판 버전이 같기 때문이다. 알림은 이미 current인 판에도 다시 보낸다(`load.notify_targets`, 2026-09-27 재실행에서 HTTP 200 확인). 토큰 없이 적재했거나 알림이 실패한 판은 토큰을 넣고 Backend를 배포한 뒤 같은 명령을 다시 돌리거나 알림만 따로 보낸다. 판 id는 적재 출력의 `b-<id>`다.

```sh
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher notify --bundle b-<id>
```

알림은 후처리를 앞당기는 신호다. 보내지 않아도 DB의 current가 정본이라 분석 화면은 열린다.

### 삭제

소유자로 `service-db` 안에서 돈다. 판 전환 때 V23 트리거가 쓴 알림 행을 `gold_writer`가 지울 수 없어서다. 소유자 비밀번호를 Publisher 컨테이너에 주지 않도록 SQL만 받아 넘긴다. 기본은 모의 실행이다.

```sh
cd "$DEPLOY_PATH"
export PUBLISHER_IMAGE=<registry>/planetory/publisher:<sha>
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher mock-purge-sql \
  | docker compose exec -T service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA'
# 개수를 확인한 뒤 실제로 지운다
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher mock-purge-sql \
  | docker compose exec -T service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v apply=1'
```

회원이 목업 판·후보를 참조하면(제출·게시글·공개 분석·성과) 지우지 않고 멈춘다. 그 기록을 지울지는 사람이 정한다.

## 튜토리얼 5종

109가 확정한 튜토리얼 5종의 실제 Gold를 싣고 `tutorial_stars` 1~5로 전환한다 [S15P21C206-272]. 대상·payload 생성·판정 규칙은 [Publisher](../../distributed-system/publisher/README.md#튜토리얼-5종-s15p21c206-272) 「튜토리얼 5종」을 따른다. 계정은 위 「Gold 목업」의 `planetory_publisher`를 쓴다.

1. **이미지.** 272 변경이 develop에 병합된 뒤 `build:publisher`가 만든 SHA를 쓴다. 이전 이미지에는 `load-payload`·`tutorial-switch-sql`이 없다.
2. **payload.** 로컬에서 `tutorial-build`로 만든 JSON 다섯 개를 서비스 노드의 한 폴더로 옮긴다. 컨테이너 사용자(uid 10001)가 읽을 수 있어야 한다.
3. **백업.** 전환 SQL은 되돌리는 SQL이 없다. 적용 전에 서비스 DB를 `pg_dump -Fc`로 받는다. 회원 정보가 들어 있으므로 권한 600으로 두고 서버 밖으로 옮기지 않는다. 적재 뒤 재실행 확인까지 끝나면 지운다(삭제는 실행 직전 승인).

```sh
cd "$DEPLOY_PATH" && mkdir -p ~/backups && umask 077
docker compose exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/backups/planetory-pre272-$(date -u +%Y%m%dT%H%M%SZ).dump
```

```sh
cd "$DEPLOY_PATH"
export PUBLISHER_IMAGE=<registry>/planetory/publisher:<sha>
docker compose --profile gold-mock run --rm --no-deps -T -v <payload 폴더>:/payloads:ro gold-mock \
  python -m publisher load-payload /payloads
# 전환: 모의 실행으로 옮길 회원·지울 기록 개수를 본 뒤 적용한다
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher tutorial-switch-sql \
  | docker compose exec -T service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X'
docker compose --profile gold-mock run --rm --no-deps -T gold-mock python -m publisher tutorial-switch-sql \
  | docker compose exec -T service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v apply=1'
```

적재 결과는 별마다 `PUBLISHED b-<id>`이고, 다시 돌리면 `ALREADY_PUBLISHED`다. 전환 SQL이 멈추는 조건과 지우는 대상은 [Publisher](../../distributed-system/publisher/README.md#튜토리얼-5종-s15p21c206-272) 「튜토리얼 5종」에 있다. 멈추면 아무것도 바뀌지 않는다. 적용 뒤 확인할 것은 세 가지다: 별지도의 튜토리얼 경고가 사라지는지, `/api/v1/me/quests`가 5칸인지, 신규·기존 계정 모두 1번 별의 분석 화면이 열리는지.

## Publisher 운영 적재 경로 (S15P21C206-85)

GCP Node 1의 Publisher가 tailnet으로 이 노드의 서비스 DB에 적재하고 Backend에 판 전환을 알리는 경로다. 결정은 다음과 같다.

| 항목 | 결정 |
| --- | --- |
| DB 접속 | Node 1 → tailnet → `ec2-a:5432`(`tailscale serve --tcp`) → `127.0.0.1:5432` → `service-db` |
| 알림 | 같은 방식으로 `ec2-a:8080` → `127.0.0.1:8080` → Backend `POST /internal/bundles/b-<id>/activated` |
| 허용 출발지 | Node 1만. Tailscale ACL로 강제한다 |
| 인증 | DB는 `planetory_publisher`(scram-sha-256), 알림은 `X-Planetory-Service-Token` |
| 비밀 값 | Node 1의 root 전용 `/etc/planetory/publisher/env`. 저장소·이미지·GitLab 변수에 두지 않는다 |
| 알림 실패 | DB 전환은 그대로 두고 `notify --bundle b-<id>`로 다시 보낸다 |

인터넷 쪽은 바뀌지 않는다. DB와 Backend는 loopback에만 바인드하고, tailnet 쪽 리스너는 tailscaled가 연다.

**tailnet IP에 직접 바인드하지 않는다.** 부팅 때 Docker가 Tailscale보다 먼저 뜨면 `100.x` 주소가 아직 없어서 `service-db` 컨테이너가 포트를 잡지 못하고 뜨지 않는다. `tailscale serve`는 loopback으로 넘기기만 하므로 이런 경합이 없다. Node 1 Spark History Server(`tailscale serve --http=18080`)와 같은 방식이다.

**출발지 통제는 ACL 하나뿐이다.** serve가 중계하면 PostgreSQL이 보는 출발지는 Docker 게이트웨이다. 그래서 `pg_hba`로 Node 1을 가려낼 수 없고 기본 `host all all all scram-sha-256`을 그대로 둔다. ACL에서 Node 1 외 출발지를 허용하면 그 장비는 비밀번호만 있으면 어느 계정으로든 붙을 수 있다. Node 1에는 `planetory_publisher` 비밀번호만 둔다. **Node 1 비밀번호가 새어도 피해는 Gold 훼손까지다.** `planetory_publisher`는 `planetory_gold_writer` 멤버라 V2(`V2__gold_roles.sql`)의 Gold 12개 테이블 읽기·쓰기와 preflight용 `flyway_schema_history`·`operation_settings` 읽기만 가진다. `users`·`submissions`·`posts` 같은 회원 테이블은 읽을 수 없고, 최악은 후보를 지우거나 가짜 후보를 넣는 것이다(`!228` 강재민 리뷰).

### EC2-A 적용 (한 번)

`service-db`를 재생성하므로 몇 초 동안 DB 연결이 끊긴다. 데이터는 볼륨에 남는다.

```sh
cd "$DEPLOY_PATH"
docker compose up -d --no-deps service-db     # 127.0.0.1:5432 포트 반영
sudo tailscale serve --bg --tcp 5432 tcp://127.0.0.1:5432
sudo tailscale serve --bg --tcp 8080 tcp://127.0.0.1:8080
tailscale serve status
```

`--bg` 설정은 tailscaled 상태에 저장돼 재부팅 뒤에도 남는다. 경로를 닫을 때는 `sudo tailscale serve --tcp 5432 off`, `--tcp 8080 off`를 실행한다. loopback 포트는 남아도 외부에서 닿지 않는다.

### Tailscale ACL

정책의 정본은 Admin Console이다. 필요한 결과는 두 가지다.

1. Node 1 → `ec2-a:5432,8080` 허용
2. 그 밖의 모든 출발지(팀원 장비 `autogroup:member`, 다른 `tag:hadoop` 서버)는 `ec2-a:5432,8080`에 닿지 않는다

ACL은 허용만 있고 차단 규칙이 없다. `[tag:hadoop, autogroup:member] → tag:hadoop:*`가 `ec2-a`의 모든 포트를 허용했으므로 `ec2-a`를 `tag:hadoop`에서 떼어 새 태그로 옮겼다(2026-09-27 적용).

| 장비 | 태그 |
| --- | --- |
| `ec2-a` | `tag:service`만(`tag:hadoop` 제거) |
| `node-1` | `tag:hadoop`, `tag:publisher` |

| 규칙 | 목적 |
| --- | --- |
| `tag:publisher → tag:service:5432,8080` | 적재와 판 전환 알림 |
| 멤버·`tag:hadoop`·`tag:registry` → `tag:service:22`, owner도 `tag:service:22`만 | 사람과 CI Runner의 SSH. 그 밖의 포트는 닫힌다 |
| `tag:service → tag:registry:5000` | `ec2-a`의 이미지 pull. 예전에는 `tag:hadoop` 규칙으로 받았다 |
| `ssh` 규칙 세 곳의 `dst`에 `tag:service` 추가 | 멤버 `check`, owner `check`, CI Runner의 `deploy` 계정 |

정책 `tests`에 `tag:publisher`의 5432·8080 허용과 `tag:hadoop`·owner 계정의 거절을 넣었다. 정책을 고칠 때 이 검사가 깨지면 저장되지 않는다. 태그를 다시 합치거나 `ec2-a`에 `tag:hadoop`을 붙이면 5432·8080이 tailnet 전체에 열린다.

### 적재 계정

위 「Gold 목업」 「준비」의 `planetory_publisher`를 그대로 쓴다. 이미 있으면 새로 만들지 않는다. 비밀번호를 바꿨으면 EC2-A `.env`의 `PUBLISHER_DB_PASSWORD`와 Node 1 env 파일을 함께 바꾼다.

### Node 1 실행

env 파일은 root 소유 `0600`이다. 키 이름만 적는다.

```text
PGHOST=ec2-a
PGPORT=5432
PGDATABASE=planetory_poc
PGUSER=planetory_publisher
PGPASSWORD=<비밀번호>
BACKEND_URL=http://ec2-a:8080
INTERNAL_SERVICE_TOKEN=<EC2-A .env와 같은 값>
```

`ec2-a`는 MagicDNS 이름이다. 컨테이너를 host 네트워크로 띄워 Node 1의 이름 해석과 tailnet 경로를 그대로 쓴다. 비밀 값은 `--env-file`로만 넘기고 명령줄에 두지 않는다.

```sh
sudo docker run --rm --network host --env-file /etc/planetory/publisher/env \
  <registry>/planetory/publisher:<sha> python -m publisher mock-load --tic <TIC 목록>
# 알림만 다시 보낼 때
sudo docker run --rm --network host --env-file /etc/planetory/publisher/env \
  <registry>/planetory/publisher:<sha> python -m publisher notify --bundle b-<id>
```

Airflow가 이 실행을 부르는 것은 게시 gate(`S15P21C206-80`), 이미지 배포 job은 `S15P21C206-94` 범위다.

### 연결이 끊기면

적재부터 current 전환까지 한 트랜잭션이다. 커밋 전에 연결이 끊기면 PostgreSQL이 트랜잭션을 롤백하고 기존 current가 남는다. 같은 명령을 다시 돌리면 새로 게시하거나, 이미 커밋됐으면 `ALREADY_PUBLISHED`로 끝난다([Publisher](../../distributed-system/publisher/README.md) 「적재 절차」).

### 검증 (2026-09-27)

운영에 목업 별이 없어 임시 `hidden` 별 `900000099`를 만들어 시험하고, 끝난 뒤 위 「Gold 목업」 「삭제」 SQL과 별 `DELETE`로 모두 지웠다. 실제 `pv1-` 판 5개는 건드리지 않았다.

| 항목 | 결과 |
| --- | --- |
| 적재·알림 | Node 1에서 `PUBLISHED b-11`, 재실행 `ALREADY_PUBLISHED b-11`. 두 번 모두 알림 HTTP 200, Backend 로그에 `판 11(TIC 900000099) 후처리` |
| 허용되지 않은 출발지 | 작업 PC(멤버), EC2-B, node-2에서 `ec2-a:5432`·`8080` 시간 초과(ACL이 버림). node-1만 연결 |
| 인터넷 | EC2-A 공인 주소로 5432·8080·3000 시간 초과. 새 리스너는 tailnet 주소에만 있다 |
| 연결 끊김 | 소유자 세션이 `publication_bundles`를 `SHARE`로 잠가 Publisher를 판 INSERT에서 세웠다. 이때 관측 원천·세그먼트는 이미 쓴 상태였다. 컨테이너를 강제 종료하고 잠금을 풀자 세션이 사라지고 관측·세그먼트·판 모두 0행, 전체 current 5개가 그대로였다. 이어진 재실행이 위 `PUBLISHED`다 |
| 비밀 값 | Backend·DB 로그, 이미지 `Config.Env`, 남은 컨테이너 어디에도 토큰·비밀번호가 없다. env 파일은 EC2-A `.env`에서 서버 사이 파이프로만 옮겼다 |

**공인 주소의 22번은 열려 있다.** 작업 PC에서 공인 주소로 22에 연결됐다. 85 이전부터의 상태(`ufw` 22 허용, OpenSSH 별칭 `ec2-a-ssh` 경로)이고 이번 변경과 무관하다. 보안그룹이 출발지를 제한하는지는 확인하지 않았다.

## ERD

Liam ERD 한 벌을 낸다. 호스트 포트를 열지 않고 `service` 네트워크 안에만 뜨며
Tunnel이 `erd.planetory.space` -> `http://erd:80`으로 잡는다. 외부 인바운드는 0개다.

SchemaSpy는 2026-09-18에 내렸다. 정적 SVG 한 장이라 35개 규모에서 관계를 읽기
어려웠고, UI 라벨을 한국어로 바꿀 수단이 없었다(7.0.2에 `-lang` 옵션도 번역 번들도
없다). Liam이 같은 정보를 더 낫게 준다.

### 한국어 설명은 DB가 갖는다

설명은 도구가 아니라 `pg_description`에 있다. `COMMENT ON TABLE`·`COMMENT ON COLUMN`을
한 번 쓰면 도구를 바꿔도 설명이 따라가므로 ERD 도구에 직접 적어 넣지 않는다. 테이블
설명은 `R__table_comments.sql`에 있다. 버전 번호 선점을 피하려고 반복 마이그레이션으로 둔다.

화면에서는 테이블을 고르면 오른쪽 상세 패널에 테이블 설명과 컬럼별 설명이 나온다.
캔버스 노드에는 이름과 타입만 그린다. 노드 위에 설명을 얹는 설정은 없다.

### 생성

생성기는 `erd-refresh` profile에 묶여 평시 `docker compose up -d` 대상이 아니다.
스키마나 코멘트가 바뀌었을 때만 수동으로 돌린다.

```
docker compose --profile erd-refresh run --rm erd-generator
```

`erd-generator`는 `erd-dump`를 먼저 끝내고 시작한다(`service_completed_successfully`).
`erd-dump`는 서버와 같은 `postgres:18.6-alpine`으로 뜬다. 하위 버전 클라이언트는 상위
서버를 덤프하지 못하고 거부하므로 이미지 버전을 서버와 따로 올리지 않는다.

### 후처리

빌드 산출물에 세 가지를 덧댄다. `erd-generator`의 `postprocess.js`가 한다.

Liam v0.7.24의 postgres 파서는 `COMMENT ON TABLE` 일부를 흘린다. 34개 중 9개
(`users`, `posts`, `comments`, `submissions` 등)가 누락되는 것을 실측했다. 원인은 SQL
형태가 아니다. 같은 구조의 테이블이 붙기도 하고 빠지기도 한다. 그래서 `erd-dump`가
`pg_description`을 `comments.json`으로 따로 뜨고 빌드 뒤 `schema.json`에 덮어쓴다.
파서 결과가 아니라 DB가 정본이다. 생성 로그의
`postprocess: comments tables=34 columns=264, dropped=1`이 이 단계가 돈 증거다.
Liam을 올릴 때 이 보정이 불필요해졌는지 확인하고, 그래도 두는 편이 안전하다.

`flyway_schema_history`는 Flyway 내부 테이블이라 도메인 ERD가 아니다. 테이블과 이를
가리키는 제약을 지운다.

쿼리 없이 들어오면 `?showMode=ALL_FIELDS`로 연다. `index.html` `</head>` 앞에 인라인
스크립트를 넣는다. 앱 번들은 `type="module"`이라 defer로 동작하므로 이 인라인이 먼저
돈다. 사용자가 붙인 쿼리는 건드리지 않고 `data-liam-default-showmode` 표식으로 중복
주입을 막는다.

### 산출물

`planetory-erd-output`에 있다. 재생성 가능한 파생물이라 지워져도 데이터 손실이 아니다.
`service-db-data`와 혼동하지 않는다. `erd-scratch`·`erd-work`·`erd-npm-cache`는 빌드
중간물이다.

DB 비밀번호는 명령줄 인자에 두지 않고 `PGPASSWORD` 환경변수로만 넘긴다.
`docker inspect`와 `ps`에 노출되지 않는다.

읽기 계정은 분리하지 않았다. 소유자 `planetory`로 접속한다. `planetory_app`·
`planetory_gold_writer` 역할 분리가 들어오면 ERD 생성기를 읽기 전용 역할로 옮긴다.

## API 문서 (Swagger UI)

`api-docs.planetory.space` -> `http://api-docs:80`. 호스트 포트를 열지 않고 `service`
네트워크 안에만 뜬다. 외부 인바운드는 0개다.

### 운영 백엔드는 건드리지 않는다

springdoc은 이미 의존성에 있지만 운영에서는 두 겹으로 잠겨 있다.

- `application.properties`의 `springdoc.*.enabled=${SWAGGER_ENABLED:false}` — 기본 꺼짐
- `SecurityConfig`의 swagger `permitAll`이 `local` 프로필 안에만 있다

배포 백엔드는 `prod`·`oauth-google`로 뜨므로 `/swagger-ui/**`와 `/v3/api-docs/**`는 401이다.
이 게이트는 팀이 의도해서 건 것이라 풀지 않는다. 대신 같은 이미지를 일회용으로 띄워
스펙만 받아 오고, 결과는 정적으로 서빙한다. 운영 백엔드의 설정과 보안은 그대로다.

### 생성

```
docker compose --profile api-docs-refresh run --rm api-docs-generator
docker compose --profile api-docs-refresh rm -sf api-docs-app api-docs-db
```

첫 명령이 `api-docs-db`(스크래치) -> `api-docs-app`(local 프로필) 순으로 띄우고
`/v3/api-docs`를 받아 Swagger UI와 함께 `planetory-api-docs-output`에 쓴다. 둘째 명령이
일회용 컨테이너 둘만 정지·제거한다. `api-docs-generator`는 `run --rm`이 이미 지웠다.
백엔드 이미지가 바뀌면 다시 돌린다.

**`down`을 쓰지 않는다.** `down`은 프로필 지정과 무관하게 프로젝트 전체를 내린다.
문서를 새로 뽑을 때마다 `frontend`·`backend`·`service-db`·`cloudflared`까지 함께
멈춰 서비스가 중단된다. 정리 대상은 이름으로 지정한다.

`api-docs-db`는 스펙 추출 전용이다. 운영 DB는 복제·백업이 없으므로(ADR D6·D7) 읽기라도
붙이지 않는다. tmpfs라 컨테이너가 사라지면 데이터도 같이 사라지며, Flyway가 매번 V1부터
새로 깐다.

### 스펙 손질

springdoc이 내는 스펙에는 `servers`가 없다. 그대로 두면 Swagger UI가 페이지 주소
(`api-docs.planetory.space`)를 API 주소로 읽는다. 생성 시 `API_SERVER_URL`
(기본 `https://planetory.space`)을 `servers`에 박는다.

Try it out은 문서 호스트에서 운영 API로 나가는 교차 출처 요청이라 CORS와 세션 쿠키가
걸린다. 이 사이트는 열람용으로 본다.

`/api/v1/hello`는 개발용 엔드포인트인데 스펙에 그대로 올라온다. 공개 문서에서 빼려면
`HelloController`에 `@Hidden`을 단다.

## 와이어프레임

`wireframe.planetory.space` -> `http://wireframe:80`. 호스트 포트를 열지 않고 `service`
네트워크 안에만 뜬다. 외부 인바운드는 0개다.

저장소의 `docs/requirements/planetory-wireframe.html`을 그대로 낸다. 이 HTML은
`../images/sky-reference-20260915/01-galaxy.png`를 참조하므로 `docs/images`도 함께 올린다.
문서를 루트의 `index.html`로 두면 브라우저가 `../images`를 `/images`로 정규화하므로 경로가
맞는다.

### 동기화

```
docker compose --profile wireframe-refresh run --rm wireframe-sync
```

`wireframe-sync`가 저장소 체크아웃(`../../docs`)을 읽어 `planetory-wireframe-output`
볼륨에 복사한다. 문서가 바뀌면 다시 돌린다. ERD·API 문서와 달리 생성이 아니라 복사다.

체크아웃이 없으면 이 동기화만 실패하고 `wireframe`은 마지막 사본을 계속 서빙한다. CI
배포 job은 `compose.yaml`만 scp하므로 저장소가 없는 서버에서는 동기화를 돌릴 수 없다.
그런 경우 파일을 직접 볼륨에 넣는다.

문서는 요구사항 산출물이라 이 저장소가 내용을 정하지 않는다. 화면 제목의 버전(`v1.3.1`)이
곧 서빙되는 판이다.

## 온라인 계산 Worker (S15P21C206-88)

`derived-compute`는 잔차·주기도를 계산한다. Backend만 `http://derived-compute:8090/internal/v1/derived-compute`로 부르며 호스트 포트를 열지 않는다. DB·Redis 자격 증명을 넘기지 않는다. 구현과 환경 변수는 [apps/derived-compute](../../apps/derived-compute/README.md)에 있다.

**디버깅용으로도 `ports:`를 열지 않는다.** Backend의 `/internal/**`는 서비스 토큰을 요구하지만 Worker의 계산 경로에는 인증이 없고, `service` 네트워크 격리가 유일한 통제다. 자격 증명이 없고 동시 실행 1·본문 64MiB 상한이 있어 같은 네트워크에서 할 수 있는 최대치가 잔차 계산의 CPU 점유라 이 선택을 받아들였다. 포트를 열면 그 전제가 깨진다. 들여다볼 때는 `docker compose exec derived-compute …`나 Backend 컨테이너에서 서비스 이름으로 부른다(「첫 배포 절차」 2단계).

| `.env` 변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `DERIVED_COMPUTE_IMAGE` | 없음 | 배포 job이 채운다. 응답의 `runtime.worker_image`로도 나간다 |
| `DERIVED_COMPUTE_CPUS` | `1` | 컨테이너 CPU 상한(계약 `cpu_per_job`) |
| `DERIVED_COMPUTE_MEMORY` | `2048m` | 컨테이너 메모리 상한(계약 `memory_mib_per_job`) |
| `DERIVED_COMPUTE_MEMORY_LIMIT_MIB` | `1900` | 프로세스 상한. 컨테이너 상한보다 낮아야 OOM kill 대신 `memory_exhausted`로 답한다 |
| `PLANETORY_RESIDUAL_MAXRUNNING` | `1` | **Backend** 동시 계산 수. Worker 대수 × 동시 실행 수(지금 1 × 1)와 같아야 한다. 크면 넘친 작업이 기다리지 않고 Worker 503으로 실패한다 |
| `DERIVED_COMPUTE_URL` | 없음 | **Backend** 변수. `http://derived-compute:8090`을 넣어야 Backend 실행기가 뜬다. 비어 있으면 잔차 요청은 503 「준비되지 않았습니다」 |

값은 실측 전 시작값이며 `S15P21C206-104`에서 조정한다. Backend의 `depends_on`에 넣지 않았다. Worker가 없어도 잔차 요청만 503이 되고 나머지 API는 돈다. 배포는 `deploy:derived-compute:ec2-a`다. HTTP 확인 경로가 없어 교체만 하고 자동 롤백은 하지 않는다.

### 첫 배포 절차

**켜는 순서는 Worker → 확인 → `DERIVED_COMPUTE_URL` → Backend다.** 거꾸로 하면 잔차 요청마다 재시도 가능한 실패 작업이 생긴다. 노드 접속 계정은 [CI/CD](../../docs/operations/cicd.md) 「배포 접속」과 [Tailscale 팀 서버 접근](../../docs/operations/tailscale-team-access.md)을 따르고, 명령은 배포 경로(`/home/deploy/planetory`)에서 실행한다.

0. **전제.** 88 MR이 develop에 병합됐고, 그 병합 파이프라인의 `build:derived-compute`·`build:backend`가 성공했다. **같은 최신 파이프라인의 버튼만 쓴다**(옛 버튼은 막힌다). 첫 배포 전에는 노드에서 인자 없는 `docker compose up -d`를 치지 않는다. `DERIVED_COMPUTE_IMAGE`가 아직 없어 `derived-compute`가 없는 이미지를 찾는다.
1. **Worker 배포.** `deploy:derived-compute:ec2-a`를 실행한다. job이 새 `compose.yaml`을 올리고 Worker만 만든다. Backend 컨테이너는 그대로다. 로그 끝이 `직전 이미지가 없습니다(첫 배포)`·`배포 완료`이고 `.env`에 `DERIVED_COMPUTE_IMAGE`가 기록된다.
2. **Worker 확인.** HEALTHCHECK는 15초 간격이라 30초쯤 뒤에 본다.

   ```sh
   docker compose ps derived-compute                      # STATUS가 healthy
   docker compose exec backend wget -qO- http://derived-compute:8090/healthz   # Backend에서 이름으로 닿는지, runtime.worker_image의 태그가 병합 commit인지
   docker compose logs --tail 20 derived-compute
   ```

   `unhealthy`이거나 Backend에서 닿지 않으면 멈추고 `docker compose stop derived-compute`로 재시작 루프를 끊는다. 3단계로 가지 않는다.
3. **Backend 켜기.** `.env`에 `DERIVED_COMPUTE_URL=http://derived-compute:8090` 한 줄을 더한다(`.env`는 비밀 값을 담으므로 이 한 줄만 추가하고 내용을 출력하지 않는다). 그다음 같은 파이프라인의 `deploy:backend:ec2-a`를 실행한다. 환경 변수가 바뀌어 Backend 컨테이너가 다시 만들어지며, DB 덤프·헬스 확인·자동 롤백은 기존과 같다. 동시 계산 수는 compose 기본값 `PLANETORY_RESIDUAL_MAXRUNNING=1`이다.
4. **동작 확인.** 판이 있는 별(!206 목업 적재 뒤)에서 잔차 1단계를 요청한다. 화면의 봉우리 제출은 V4 제약으로 500이라(262 인계) 그 전에는 로그인 세션으로 원본 곡선 후보 제출 → `POST /api/v1/stars/{tic}/residual-jobs` 순서로 부른다(`LocalSeedSmokeTest`와 같은 순서). 작업이 `COMPLETED`가 되고 Backend 로그에 두 줄이 남으면 연결된 것이다.

   ```sh
   docker compose logs backend | grep WorkerResidualComputeRunner   # "잔차 작업 rj-N RESIDUAL 완료", "… PERIODOGRAM 완료"
   ```

   실패하면 같은 로그의 `멈췄습니다: <원인>` 줄이 Worker 오류 코드나 연결 실패를 보여 준다.
5. **131 인계(선택).** [apps/derived-compute](../../apps/derived-compute/README.md) 「131 인계」대로 캡처를 켜고 같은 요청을 한 번 더 보낸 뒤 캡처·digest를 넘기고 캡처를 끈다.

**되돌리기.**

| 상황 | 조치 |
| --- | --- |
| 잔차 계산만 끄기 | `.env`에서 `DERIVED_COMPUTE_URL` 줄을 지우고 `deploy:backend:ec2-a`. 잔차 요청이 503 「준비되지 않았습니다」로 돌아간다 |
| Worker 이상 | `docker compose stop derived-compute`. Backend가 켜져 있으면 잔차 작업은 재시도 가능한 실패로 끝난다 |
| Worker 이미지 되돌리기 | 자동 롤백이 없다. `.env`의 `DERIVED_COMPUTE_IMAGE`를 직전 태그로 고치고 `docker compose up -d --no-deps derived-compute` |

배포 뒤 결과(병합 commit, Worker 이미지 태그·digest, 확인한 작업 ID)는 [서비스 배포 현황](../../docs/project/service-deploy-status.md)과 Jira 88에 남긴다.

## 배포와 롤백

`deploy.sh`가 배포 노드에서 서비스 한 개를 교체한다. CI가 `compose.yaml`과 함께 이 파일을 `$DEPLOY_PATH`에 올리고 호출한다. 교체 후 공개 경로를 직접 두드려 판정하며, 살아나지 않으면 **직전 이미지로 되돌린다.** compose의 `healthcheck`를 쓰지 않는 이유는 `up -d`가 끝난 시점에 아직 `starting`이고 서비스에 따라 정의도 없기 때문이다.

| 서비스 | 확인 경로 | 교체 전 DB 덤프 | 대기 한계 |
| --- | --- | --- | --- |
| `frontend` | `/health/renderer-enabled` | 없음 | 90초 |
| `backend` | `/actuator/health` | 남긴다 | 180초 |
| `derived-compute` | 없음(호스트 포트 없음, 이미지 `HEALTHCHECK`만) | 없음 | — |

프론트는 `/`를 보지 않는다. `/`는 렌더러가 빠진 빌드에서도 200이라 회귀를 못 잡는다. `/health/renderer-enabled`는 `VITE_SKY_RENDERER_ENABLED=true`로 빌드한 이미지에만 있는 정적 표식이다(`apps/frontend/Dockerfile`). nginx는 `/health/`를 SPA로 폴백하지 않고 없으면 404를 낸다. MR의 `web:image`도 이미지 안에 표식이 있는지 먼저 본다.

표식이 들어가기 전 이미지(`frontend:80a860fa…-sky` 이전)에는 이 경로가 없어 그 이미지로 되돌리는 롤백은 헬스가 실패한다. 2026-09-23 CI가 표식 있는 `a9e567db`를 배포해 과도기는 끝났다. 그보다 옛 이미지로 손으로 되돌릴 때만 해당한다.

확인 주소는 `docker compose port`로 읽는다. `.env`의 `FRONTEND_PORT`·`BACKEND_PORT`를 바꿔도 따라간다. `DEPLOY_HEALTH_PATH`가 빈 job(GCP 노드)은 확인과 롤백을 건너뛰고 교체만 한다.

**롤백은 이미지만 되돌린다. 스키마는 되돌리지 않는다.** Flyway는 앞으로만 가고 `clean`이 막혀 있다. 지금까지의 마이그레이션은 열·테이블 추가뿐이라 구 앱이 새 스키마에서도 `validate`를 통과하지만, 열을 지우거나 이름을 바꾸는 마이그레이션이 들어오면 그 가정이 깨진다. 그때는 덤프에서 복원해야 한다.

덤프는 `$DEPLOY_PATH/backups/service-db-<YYYYMMDD-HHMMSS>.sql`에 쌓이며 최근 10개만 남는다. 복원은 이미 마이그레이션된 DB에 데이터만 넣는 경우 트리거와 `rule-0` 충돌을 먼저 처리해야 한다. 절차는 [운영 규칙 런북](../../docs/operations/operation-rule-runbook.md)을 따른다.

`compose.yaml`은 되돌리지 않는다. 포트·환경변수·볼륨 정의를 바꾸는 변경은 이미지 배포와 같은 파이프라인에 싣지 않는다. 실패하면 "구 이미지 + 신 정의"라는 검증되지 않은 조합이 된다.

덤프는 DB와 같은 호스트·같은 디스크에 있다. 인스턴스를 잃으면 볼륨과 함께 사라진다. 배포 실패 복구용이지 재해 복구용이 아니다.

### 어느 버튼을 누르나

**최신 develop 파이프라인의 버튼을 누른다.** 기준 브랜치에서는 Frontend·Backend를 매번 빌드하므로 최신 파이프라인에 두 버튼이 늘 있다. 더 새 배포가 있는 상태에서 옛 파이프라인 버튼을 누르면 GitLab이 job을 실패시킨다(`environment: ec2-a`, [CI/CD](../../docs/operations/cicd.md) 「배포 버튼 유지」). 2026-09-23 이전 파이프라인의 job과 예전에 성공한 job의 재실행은 막히지 않는다.

배포 job이 실패로 끝나면 되돌리기까지는 끝난 상태다. 로그의 마지막 줄로 구분한다.

- `되돌렸습니다` — 서비스는 직전 이미지로 살아 있다. 원인을 고쳐 다시 배포한다.
- `되돌릴 이미지가 없습니다` — 첫 배포였다. 서비스가 떠 있지 않다.
- `되돌린 뒤에도 헬스가 통과하지 않습니다` — 사람이 봐야 한다. `restart: unless-stopped`가 계속 재시작시키므로 조사 전에 `docker compose stop <service>`로 루프를 멈춘다.
- `DB 덤프에 실패했습니다` — 교체하지 않았다. `service-db`를 먼저 확인한다.
- `교체가 반영되지 않았습니다` — compose가 읽는 이미지 변수 이름이 배포 job의 `DEPLOY_IMAGE_VARIABLE`과 다르다.

## Cloudflare Tunnel 진입 (S15P21C206-84, 부분)

`cloudflared`는 외부 인바운드 포트를 열지 않고 edge에서만 트래픽을 받는다. 서비스 컨테이너는 같은 `service` 네트워크에 있으므로 Tunnel의 public hostname은 `http://frontend:8080`을 origin으로 지정한다.

도메인은 `planetory.space`이며 Cloudflare zone에 등록되어 있다. Tunnel 이름은 `planetory-service`다.

1. Cloudflare Zero Trust에서 Tunnel을 만들고 connector 토큰을 발급한다.
2. 서버의 `$DEPLOY_PATH/.env`에 `CLOUDFLARE_TUNNEL_TOKEN=<토큰>`을 추가한다. 토큰은 Git·이미지·명령줄 인자에 두지 않는다.
3. `docker compose up -d cloudflared`로 기동한다. GitLab 배포 job은 `frontend`·`backend`만 갱신하므로 `cloudflared`를 내리지 않는다.
4. Tunnel의 public hostname → service `http://frontend:8080`을 연결하고 도메인으로 접속을 확인한다.

connector는 EC2-A에만 둔다. 같은 Tunnel에 커넥터를 여럿 붙여도 Cloudflare는 가장 가까운 하나로만 보내고 분산하지 않으므로(2026-09-16 실측 10/10), EC2-B가 선택되면 전면 장애가 된다.

2026-09-17 확인: EC2-A에서 Cloudflare edge(`icn06`)로 QUIC egress가 열려 있고, 보안그룹 인바운드 개방 없이 `planetory.space` 응답까지 확인했다.

Backend가 아직 배포되지 않은 단계에서도 frontend는 기동한다. `apps/frontend/nginx.conf`가 backend를 요청 시점에 해석하기 때문이다. **API 응답은 모두 원래 상태 코드를 그대로 전달한다.** 한때 세션 조회(`/api/v1/me`)의 502·504만 401로 낮췄으나, 프론트의 공통 인증 만료 처리가 그 401을 받아 세션을 비우고 보관 중인 분석 초안까지 지워 걷어냈다.

Tunnel → nginx 구간은 평문이므로 외부 HTTPS 출처를 별도로 전달해야 한다. Backend 공통값은 240과 같은 `server.forward-headers-strategy=framework`로 통일한다. 공통 설정으로 활성화되므로 별도 환경변수 주입은 필요하지 않다. 현재 nginx는 외부 `Forwarded`와 일부 `X-Forwarded-*`를 제거하지 않고 Proto도 임의 값을 전달하므로, 공개 진입 계층에서 외부 전달 헤더를 제거하고 허용한 Proto/Host만 다시 설정하며 backend 직결 제한을 배포 전에 검증한다. 설정 변경만으로 실제 운영 HTTPS 로그인 복귀 인수가 완료된 것은 아니다. nginx의 `absolute_redirect off`는 nginx 자체 리다이렉트 설정이며 이 신뢰 경계를 대신하지 않는다.

미완료: Redis runtime, 메모리 상한·eviction 정책, health/readiness, 남용 제어 위치, connector 지속 처리량 실측은 이 변경에 포함되지 않았다.

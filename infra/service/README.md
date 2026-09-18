# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A 수동 배포 job이 이 Compose를 사용해 선택한 서비스만 갱신한다. EC2-B는 사용하지 않으므로 `ec2-b/`에는 설정을 두지 않는다(시스템 아키텍처 8장 D4). 노드별 차이가 필요하면 `ec2-a/`에 둔다.

## service-db

PostgreSQL 18.6을 같은 Compose 안에서 `service-db`로 띄운다. Backend는 `service` 네트워크로 `service-db:5432`에 붙으며 호스트 포트를 열지 않는다. 외부 인바운드는 0개다.

`.env`에 `POSTGRES_PASSWORD`가 없으면 기동이 실패한다. `POSTGRES_DB`, `POSTGRES_USER`와 Backend의 `DATABASE_*`는 기본값을 쓰면 서로 맞는다.

데이터는 named volume `planetory-service-db-data`에 있다. 이 볼륨이 회원·제출·히스토리의 유일한 사본이다(복제·백업 없음, ADR D6·D7). `docker compose down -v`와 볼륨 이름 변경은 곧 데이터 상실이다. 재배포·이미지 교체는 볼륨을 지우지 않는다.

마운트 경로 `/var/lib/postgresql`은 postgres:18에서 바뀐 규약이다. 17 이하의 `/var/lib/postgresql/data`로 되돌리면 깨진다.

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

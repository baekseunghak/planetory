# 3. DB 덤프

| 파일 | 내용 |
| --- | --- |
| `planetory-schema-v30-20260928.sql` | PostgreSQL 18.6 평문 SQL 덤프. Flyway V1~V30 + `R__table_comments` 적용 직후 상태 |

## 포함 범위

- 테이블 48개, 함수·트리거·제약·인덱스, 한국어 테이블·컬럼 설명(`COMMENT`), 역할별 권한(`GRANT` 134건)
- 데이터가 있는 테이블은 셋뿐이다.

| 테이블 | 행 | 내용 |
| --- | ---: | --- |
| `flyway_schema_history` | 31 | 적용된 마이그레이션 기록. 복원한 DB에서 백엔드가 Flyway 검증을 통과하는 근거 |
| `operation_settings` | 1 | 판정 규칙 초기값 `rule-0` |
| `users` | 1 | V24가 넣는 시스템 자리표시 계정(`id=-1`, "탈퇴한 회원"). 실제 회원이 아니다 |

**운영 데이터(회원·제출·게시글·Gold 곡선)는 넣지 않았다.** 회원 데이터는 개인정보라 저장소에 둘 수 없고(`AGENTS.md` 안전 가드레일), Gold 배열은 대용량 원천 파생물이라 Publisher로 다시 적재한다(포팅 매뉴얼 4.6).

## 만든 방법

`develop` `e2c7c19b`로 빌드한 이미지를 `infra/service/compose.yaml`로 빈 볼륨에 띄우고(포팅 매뉴얼 4장), 백엔드가 Flyway를 적용한 뒤 뜬 덤프다.

```sh
docker compose exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > planetory-schema-v30-20260928.sql
```

## 복원

역할(`planetory_app`, `planetory_gold_writer`, `planetory_stats_job`)이 먼저 있어야 `GRANT`가 성공한다. `infra/service/compose.yaml`의 `service-db`를 **빈 볼륨으로 처음 띄우면** `service-db-init/10-app-account.sh`가 역할과 런타임 계정을 만들어 준다. 덤프 첫머리의 `\restrict`는 psql 17.6·18 이상이 필요하므로 같은 이미지의 psql을 쓴다.

```powershell
cd infra/service
docker compose up -d --wait service-db
docker compose cp ../../exec/3-db-dump/planetory-schema-v30-20260928.sql service-db:/tmp/planetory-dump.sql
docker compose exec service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -f /tmp/planetory-dump.sql'
```

파일을 컨테이너에 복사해 넣으므로 셸 파이프의 문자 인코딩과 무관하게 한국어 설명이 보존된다.

이미 스키마가 있는 DB에는 복원하지 않는다. 새 DB에 넣거나, 빈 DB라면 백엔드를 그냥 띄워도 Flyway가 같은 스키마를 만든다.

## 검증 (2026-09-28)

- 새 DB `restore_check`에 `ON_ERROR_STOP=1`로 복원: 종료 코드 0, 테이블 48개, Flyway 기록 31행
- 위 `docker compose cp` 명령으로 새 DB에 다시 복원: 종료 코드 0, `stars` 테이블 한국어 설명 보존
- 같은 백엔드 이미지를 복원 DB에 연결: `Successfully validated 31 migrations`, `Schema "public" is up to date`, `Started PlanetoryApplication`(`ddl-auto=validate` 통과)

스키마를 바꾸는 마이그레이션이 추가되면 위 방법으로 다시 떠서 파일 이름의 버전·날짜를 바꾼다.

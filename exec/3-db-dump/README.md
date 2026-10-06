# 3. DB 덤프

| 파일 | 내용 | 크기 |
| --- | --- | ---: |
| `planetory-schema-v30-20260928.sql` | 스키마 덤프. Flyway V1~V30 + `R__table_comments` 적용 직후 상태 | 239KB |
| `planetory-demo-stars-20260929.sql` | 데이터 덤프. 운영 DB의 튜토리얼 5종·챌린지 1회차 별 10개와 그 Gold | 909KB |

두 파일 모두 PostgreSQL 18.6 평문 SQL이다. **스키마 → 데이터 순서로 복원하면** 가입(튜토리얼 1번 별 지급)과 튜토리얼·챌린지 별 분석이 되는 DB가 된다.

## 스키마 덤프

- 테이블 48개, 함수·트리거·제약·인덱스, 한국어 테이블·컬럼 설명(`COMMENT`), 역할별 권한(`GRANT` 134건)
- 데이터가 있는 테이블은 셋뿐이다.

| 테이블 | 행 | 내용 |
| --- | ---: | --- |
| `flyway_schema_history` | 31 | 적용된 마이그레이션 기록. 복원한 DB에서 백엔드가 Flyway 검증을 통과하는 근거 |
| `operation_settings` | 1 | 판정 규칙 초기값 `rule-0` |
| `users` | 1 | V24가 넣는 시스템 자리표시 계정(`id=-1`, "탈퇴한 회원"). 실제 회원이 아니다 |

만든 방법: `develop` `e2c7c19b`로 빌드한 이미지를 `infra/service/compose.yaml`로 빈 볼륨에 띄우고(포팅 매뉴얼 4장), 백엔드가 Flyway를 적용한 뒤 떴다.

```sh
docker compose exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > planetory-schema-v30-20260928.sql
```

## 데이터 덤프 (튜토리얼·챌린지 별)

| 구분 | TIC |
| --- | --- |
| 튜토리얼 1~5 | 149603524(WASP-62), 307210830(L 98-59), 279569718, 300871545(TOI-184), 278956474 |
| 챌린지 1회차 대표 | 190990336 |
| 챌린지 1회차 추가 대상 | 12423815, 61988212, 88977253, 220475245 |

| 테이블 | 행 | 내용 |
| --- | ---: | --- |
| `stars` | 10 | 별 제원, 모두 `published` |
| `publication_bundles` | 10 | 별마다 현재 판 1개(`current`). 튜토리얼은 b-5~b-9 |
| `observation_datasets` | 11 | 관측 섹터 |
| `light_curve_segments` | 11 | 광도곡선 배열 |
| `periodograms` | 10 | 원본 주기도 배열 |
| `candidates` | 13 | 후보 신호(L 98-59 3개, TIC 278956474 2개, 나머지 1개씩) |
| `candidate_dispositions` | 13 | 후보 판정·정답 분류 |
| `external_signal_references` | 19 | 외부 목록(NEA·ExoFOP·TCE) 대조 결과 |
| `tutorial_stars` | 5 | 튜토리얼 1~5 배치 |
| `challenge_rounds` | 1 | 챌린지 1회차(2026-09-27~10-03) |
| `challenge_round_extra_targets` | 4 | 1회차 추가 대상 |

시퀀스 6개(`publication_bundles_id_seq` 등)도 들어간 최대값으로 맞춰 둬서, 복원 뒤 Publisher가 새 판을 올려도 ID가 겹치지 않는다(다음 판 ID 1742).

**넣지 않은 것:** 회원·제출·성과·게시글·알림·통계(개인정보 또는 회원 파생), NASA 조회·AI 설명 캐시(요청하면 다시 만든다), 위 10개 밖의 별과 Gold(첫 운영 배치로 게시된 약 4,900개. 크기 때문에 제외). 판 `manifest`의 게시 근거(승인자·승인 시각, 승인 run)는 운영 원본 그대로다.

### 만든 방법 (2026-09-29)

1. 운영 DB(EC2-A `service-db`)에서 `SET default_transaction_read_only = on` 세션으로 위 10개 TIC의 행만 `\copy (SELECT …) TO STDOUT`로 읽었다. 운영 스키마가 V30이고 컬럼 구성 해시가 스키마 덤프와 같은지 먼저 확인했다.
2. 로컬 임시 PostgreSQL 18.6에 스키마 덤프를 복원하고, 읽은 행을 **트리거를 켠 채** 한 트랜잭션으로 넣어 업무 규칙 트리거와 외래 키를 통과하는지 확인했다.
3. 시퀀스를 최대값으로 맞추고 대상 테이블만 떴다.

```sh
pg_dump -U planetory -d planetory_poc --data-only --disable-triggers \
  -t public.stars -t public.observation_datasets -t public.light_curve_segments \
  -t public.publication_bundles -t public.periodograms -t public.candidates \
  -t public.candidate_dispositions -t public.external_signal_references \
  -t public.tutorial_stars -t public.challenge_rounds -t public.challenge_round_extra_targets \
  -t public.candidates_id_seq -t public.challenge_rounds_id_seq -t public.external_signal_references_id_seq \
  -t public.light_curve_segments_id_seq -t public.observation_datasets_id_seq -t public.publication_bundles_id_seq
```

`--disable-triggers`를 쓴 이유: `pg_dump` 출력은 첫머리에서 `search_path`를 비우는데, 챌린지 회차 트리거 함수(`capture_challenge_notification`)가 테이블 이름을 스키마 없이 쓴다. 트리거를 켠 채 덤프 파일로 복원하면 `relation "notification_outbox" does not exist`로 실패한다. 트리거를 끄면 운영 행이 그대로 들어가고 알림 부수 효과도 생기지 않는다. 테이블마다 적재 뒤 트리거를 다시 켠다.

## 복원

역할(`planetory_app`, `planetory_gold_writer`, `planetory_stats_job`)이 먼저 있어야 `GRANT`가 성공한다. `infra/service/compose.yaml`의 `service-db`를 **빈 볼륨으로 처음 띄우면** `service-db-init/10-app-account.sh`가 역할과 런타임 계정을 만들어 준다. 데이터 덤프의 트리거 끄기는 superuser가 필요한데, `service-db` 이미지의 `POSTGRES_USER`(`planetory`)가 superuser다. 덤프 첫머리의 `\restrict`는 psql 17.6·18 이상이 필요하므로 같은 이미지의 psql을 쓴다.

```powershell
cd infra/service
docker compose up -d --wait service-db
docker compose cp ../../exec/3-db-dump/planetory-schema-v30-20260928.sql service-db:/tmp/1-schema.sql
docker compose cp ../../exec/3-db-dump/planetory-demo-stars-20260929.sql service-db:/tmp/2-demo-stars.sql
docker compose exec service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -f /tmp/1-schema.sql'
docker compose exec service-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -1 -f /tmp/2-demo-stars.sql'
```

- 파일을 컨테이너에 복사해 넣으므로 셸 파이프의 문자 인코딩과 무관하게 한국어가 보존된다.
- 이미 스키마가 있는 DB에는 스키마 덤프를 복원하지 않는다. 빈 DB라면 백엔드를 먼저 띄워 Flyway로 스키마를 만든 뒤 데이터 덤프만 넣어도 된다.
- 데이터 덤프는 같은 TIC이 이미 있는 DB(예: 운영)에 넣지 않는다. 기본 키 충돌로 멈춘다.

## 검증

| 날짜 | 대상 | 결과 |
| --- | --- | --- |
| 2026-09-28 | 스키마 덤프 | 새 DB에 `ON_ERROR_STOP=1` 복원 종료 코드 0, 테이블 48개, Flyway 기록 31행, 한국어 설명 보존. 같은 백엔드 이미지를 연결해 `Successfully validated 31 migrations`, `Schema "public" is up to date`, `Started PlanetoryApplication` |
| 2026-09-29 | 스키마 + 데이터 덤프 | 새 DB에 위 순서로 복원 종료 코드 0. 튜토리얼 1~5와 챌린지 대상 5개 모두 `published`·현재 판 있음, 광도곡선·주기도 1개씩. 외래 키 위반 0, 복원 뒤 꺼진 트리거 0, 알림 부수 효과 0행 |

데이터 덤프로 복원한 DB에서 백엔드 기동·로그인·분석 화면은 확인하지 않았다(OAuth 자격 증명 필요). 스키마를 바꾸는 마이그레이션이 추가되면 두 파일을 위 방법으로 다시 떠서 파일 이름의 버전·날짜를 바꾼다.

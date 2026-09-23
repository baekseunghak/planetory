# local-seed: 통합 테스트용 로컬 Gold 시드

Jira `S15P21C206-256` / 담당: 강재민 / 상태: 구현·일회용 DB 검증 완료, 팀 리뷰 중

Gold 실데이터 적재가 끝나기 전에도 로컬 DB에서 가입부터 분석·제출·챌린지까지 프론트·백엔드 통합 테스트를 하기 위한 데이터다. 합성 별 14개와 저장소에 있는 실제 TESS 곡선 예제 1개(TOI-270)를 넣는다. 실데이터 적재는 Gold staging 적재(`S15P21C206-86`), current 전환(`S15P21C206-87`), Gold 직렬화(`S15P21C206-125`)가 맡는다. 가입 처리는 튜토리얼 1번 별이 없으면 회원을 만들지 않으므로, Gold가 비어 있는 DB에서는 로그인부터 막힌다.

덤프 파일이 아니라 이 스크립트가 정본이다. 마이그레이션이 바뀌면 DB를 새로 만들고 다시 실행한다. 덤프가 필요하면 아래 [덤프가 필요할 때](#덤프가-필요할-때)처럼 이 결과에서 그때 뜬다. 숫자는 과학 기준값·운영 Gold가 아니다. 이 시드로 통과한 결과를 운영 Gold 계약 정합성, discoverability 정확도, 후보 ID 유지의 검증으로 보지 않는다.

## 넣는 것과 넣지 않는 것

| 넣는 것 | 방식 |
| --- | --- |
| Gold: `stars`, `observation_datasets`, `light_curve_segments`, `publication_bundles`, `periodograms`, `candidates`, `candidate_dispositions`, `external_signal_references`, `ai_executions`·`ai_evaluations` | 별마다 한 트랜잭션에서 staging 적재 → 같은 트랜잭션 조회 검사 → current 전환([Gold 계약](../../../contracts/gold/README.md) 5·6절). `planetory_gold_writer` 역할로 넣어 Publisher 권한 밖을 건드리지 않는다 |
| 운영 설정: `tutorial_stars` 1~5, 진행 중(`active`) 챌린지 회차 1개 | 운영자가 SQL로 넣는 테이블([운영 규칙 런북](../../../docs/operations/operation-rule-runbook.md) 5절). 이미 다른 값이 있으면 바꾸지 않고 알린다 |

넣지 않는 것:

- 회원·제출·게시글·공개 분석 같은 회원 데이터. 실제 OAuth 로그인과 화면·API로 만든다. SQL로 넣으면 성과·별 열림 규칙을 거치지 않은, 앱이 만들 수 없는 상태가 생긴다.
- `operation_settings`. V9가 넣은 `rule-0`을 쓴다(local 프로필은 튜토리얼 건너뛰기 3회).
- 공식 신호 스레드. 첫 공개 때 백엔드가 만든다.

## 팀원에게 전달하는 방법

따로 넘길 파일은 없다. 로컬 DB는 팀원마다 자기 PC의 Docker 볼륨이라, 각자 이 브랜치(병합 뒤에는 develop)를 받아 아래 [실행](#실행)을 한 번 하면 된다. 합성 곡선은 코드가 매번 같은 값으로 다시 만들고, 실제 곡선 예제는 이미 저장소에 있다([gold-toi270-s3.json](../../gold-roundtrip/fixtures/gold-toi270-s3.json)). 그래서 누가 돌려도 같은 TIC·같은 판 내용이 들어간다.

- uv를 설치하기 어려운 팀원에게만 [덤프](#덤프가-필요할-때)를 떠서 넘긴다. 덤프는 뜬 시점의 마이그레이션 버전에 고정된다.
- 공유 개발 서버(`app.planetory.space`)의 DB는 별개다. 이 시드는 URL과 libpq 환경변수가 이 PC 밖을 가리키면 접속하지 않고, 접속한 뒤에도 실제로 붙은 주소가 이 PC가 아니면 아무것도 읽거나 쓰기 전에 멈춘다([옵션](#실행)의 `--allow-non-local`). 다만 127.0.0.1로 연 SSH 터널이나 포트 포워딩은 로컬로 판정되므로, 공유 DB로 포워딩한 포트에는 실행하지 않는다. 공유 DB에 넣는 것은 인프라 담당과 정할 일이다. 그 DB에는 로그인용으로 손으로 넣은 튜토리얼 1번 별과 더미 별이 이미 있다([서비스 배포 현재 상태](../../../docs/project/service-deploy-status.md)).

## 실행

준비물은 Docker Desktop과 [uv](https://docs.astral.sh/uv/)다. 시드는 백엔드 Flyway가 만든 DB에만 넣는다.

```powershell
# 1) 저장소 루트: 로컬 DB와 백엔드를 한 번 띄워 마이그레이션을 적용한다
cd apps/backend
.\gradlew.bat bootRun

# 2) 다른 터미널, 저장소 루트에서
cd experiments/distributed-pipeline/local-seed
uv sync
uv run python -m local_seed seed
```

출력의 `대상:` 줄에 실제로 접속한 주소가 나오고, 끝에 별마다 `PUBLISHED b-<id>`, 튜토리얼 1~5와 챌린지 회차의 `SET`이 보이면 된다. 이후 프론트를 실제 백엔드에 붙여(`API_PROXY_TARGET`, [프론트 README](../../../apps/frontend/README.md)) OAuth로 가입하면 튜토리얼 1번 별이 열린다. DB 마이그레이션이 저장소 최신보다 뒤처져 있으면 `MIGRATION_BEHIND`로 멈추므로 1)을 먼저 한다.

| 옵션 | 뜻 |
| --- | --- |
| `--database-url` | `postgresql://…` 형식. 기본은 `SEED_DATABASE_URL`, 없으면 루트 Compose `service-db` 로컬 기본값. 백엔드의 JDBC 형식 `DATABASE_URL`은 읽지 않는다 |
| `--schema` | 대상 스키마. 기본 `public` |
| `--allow-non-local` | 이 PC 밖의 DB도 허용한다. 공유·운영 DB에는 쓰지 않는다. 기본 판정은 두 번이다. 접속 전에는 URL과 `PGHOST`·`PGHOSTADDR`·`PGSERVICE`를 libpq처럼 읽어 `hostaddr`는 루프백 주소만, host는 `localhost`·루프백 주소·Unix 소켓만 받고 `service`는 받지 않는다. 접속 뒤에는 libpq가 알려 주는 실제 접속 주소(`PQhostaddr`)가 루프백이거나 Unix 소켓이어야 한다 |
| `--no-settings` | 튜토리얼·챌린지 설정을 넣지 않는다 |
| `--notify-backend URL` | 적재 뒤 current 판마다(이번에 게시한 판과 이미 current인 판) `POST /internal/bundles/{bundleId}/activated`를 부른다. 토큰은 `INTERNAL_SERVICE_TOKEN`([백엔드 README](../../../apps/backend/README.md))이며 없으면 적재 전에 멈춘다. 한 건이라도 실패하면 종료 코드 1이다 |
| `--skip-migration-check` | Flyway 이력 없이 마이그레이션 SQL을 직접 적용한 검증용 스키마에만 쓴다 |

## 정답표

`uv run python -m local_seed plan`이 정본이며 DB 없이 출력한다. 합성 별 TIC은 실제 TIC과 겹치지 않게 99억 대를 쓴다. 모양은 곡선에 넣은 통과 모양이고 Gold 후보 모델은 모두 box다.

| 별 | TIC | 역할 | 섹터 | 모양 | 신호: 주기 d / 깊이 ppm / 판정 |
| --- | --- | --- | --- | --- | --- |
| SYN-01 | 9900000001 | 튜토리얼 1 deep_confirmed | 14 | box | b 3.2474 / 11,500 / confirmed |
| SYN-02 | 9900000002 | 튜토리얼 2 shallow_confirmed | 15, 16 | box | b 5.8126 / 1,150 / confirmed |
| SYN-03 | 9900000003 | 튜토리얼 3 fp | 17 | box | b 4.4117 / 6,400 / fp. 홀짝 통과 깊이 6,700·6,100 |
| SYN-04 | 9900000004 | 튜토리얼 4 deep_fp | 18 | box | b 1.8791 / 180,000 / fp |
| SYN-05 | 9900000005 | 튜토리얼 5 multi_fp | 19, 20 | box | b 2.7336 / 9,000 / fp(1차 식), c 2.7336 / 3,200 / fp(2차 식, 위상 0.5) |
| SYN-06 | 9900000006 | 챌린지 | 21, 22 | box | b 9.8716 / 2,100 / pc, AI approved |
| SYN-07 | 9900000007 | 일반 | 23 | U자 | b 2.1543 / 3,000 / confirmed, c 7.3302 / 1,800 / confirmed |
| SYN-08 | 9900000008 | 일반 | 24, 25 | U자 | b 5.5021 / 1,200 / pc, AI hold |
| SYN-09 | 9900000009 | 일반 | 26 | V자 | b 1.2268 / 25,000 / fp(스치는 식쌍성) |
| SYN-10 | 9900000010 | 일반 | 27 | U자 | b 3.8810 / 4,500 / confirmed, c 11.917 / 180 / confirmed·**발견 불가** |
| SYN-11 | 9900000011 | 일반 | 28, 29 | U자 | b 1.6302 / 2,400 / confirmed, d 12.3301 / 1,900 / pc·AI approved, c 5.2179 / 1,500 / confirmed |
| SYN-12 | 9900000012 | 일반 | 30 | U자 | b 6.7820 / 1,700 / none(외부 라벨·AI 없음) |
| SYN-13 | 9900000013 | 일반 | 31, 32 | U자 | b 16.441 / 2,600 / pc, AI approved |
| SYN-14 | 9900000014 | 일반 | 40, 43 | U자 | b 4.1011 / 5,000 / confirmed |
| TOI-270 | 259377017 | 일반 | 3 | 실제 | b 3.35992 / 977, c 5.66051 / 3,452, d 11.38194 / 2,645 / 모두 confirmed(NASA Exoplanet Archive) |

- 성과를 인정받으면 일반 별 중 하나가 새로 열린다(성과 발견은 튜토리얼·진행 회차 대상이 아닌 공개 별에서 고른다).
- 잔차 계산 Worker(`S15P21C206-88`)가 연결되기 전에는 `curveStep` 1 이상 요청이 503이다. 발견 가능한 신호는 모두 원본 곡선(`curveStep=0`)에서 고를 수 있다. SYN-05의 2차 식은 1차 식과 같은 주기에서 위상 0.5 쪽을 고른다. TOI-270 b는 얕아서 추천 봉우리 상위 10개에 없으므로 주기도에서 직접 고른다.
- SYN-10 c는 너무 얕아 찾을 수 없는 신호(`discoverable=false`)다. b만 찾으면 `undiscoverable_only`로 완료된다.
- U자·V자 신호는 box 모델로 빼도 가장자리가 남아 같은 주기·배수에 잔차 봉우리가 생긴다(SYN-09 1.2269 d SNR 80 등, SYN-14 4.1022 d SNR 7.5). `plan`이 목록을 보여 준다. 잔차 Worker가 연결되면 신호를 뺀 뒤에도 봉우리가 남는 실제와 같은 상황을 볼 수 있다.
- TOI-270의 첫 통과 시각은 Archive 기준 시각이라 관측 범위(BTJD 1385.9~1406.2) 밖이다. 주기로 접으면 같은 위상이다.

## 실제 데이터와 다른 점

저장소의 실제 TESS 곡선(TOI-270 Sector 3)과 합성 곡선을 같은 기준으로 비교했다. β는 잡음을 묶었을 때 줄어드는 정도의 비로, 1이면 완전 무작위다.

| 항목 | 실제 TOI-270 | 합성 |
| --- | --- | --- |
| 10분 bin 잡음 | 582 ppm | 379~524 ppm |
| β(1시간·6시간) | 1.06·1.10 | 0.88~1.03 |
| 빈 bin 비율 | 10.0% | 5.2% |
| 통과 가장자리/중심 깊이 비 | 0.60 | box 약 1.0, U자 0.64~0.91 |

- 형식과 계산 함수는 실제 배치와 같다. Gold는 추세 제거를 거친 곡선이라 실제 잡음도 몇 시간 규모에서는 거의 무작위였다.
- 튜토리얼·챌린지는 풀이가 확실하도록 box 통과이고 후보표가 참값 그대로다. 실제 파이프라인 결과처럼 고조파 후보나 잘못 잡힌 신호가 섞이지 않는다.
- 합성 별의 TIC·물리량·외부 라벨(`synthetic`)·AI 점수는 만든 값이다. 별이 15개뿐이라 별 지도 밀도·검색·통계는 실제 규모와 다르게 보인다.

## 다시 실행·초기화

- 같은 내용이면 다시 실행해도 바뀌지 않는다(`ALREADY_PUBLISHED`, `KEPT`).
- 시드 규칙(`catalog.py`의 `GENERATOR_VERSION`)이 바뀌면 새 판을 게시한다. 이전 판은 archived, 그 판의 후보는 retired가 되고 `candidate_status_history`에 남는다. 실제 Publisher의 후보 동일성 판단(id 유지)은 하지 않는다. 이미 가입한 회원이 있으면 `--notify-backend http://127.0.0.1:8080`으로 판 전환 후처리를 부른다. 백엔드가 꺼져 있는 등으로 알림이 실패하면 종료 코드 1로 끝난다. 백엔드를 띄우고 같은 명령을 다시 실행하면 적재는 `ALREADY_PUBLISHED`로 넘어가고 current 판 전체에 다시 알린다(후처리는 같은 판을 여러 번 받아도 결과가 같다).
- `IDEMPOTENCY_CONFLICT`는 같은 판 이름이나 같은 세그먼트 자연 키에 다른 내용이 들어 있다는 뜻이다. TOI-270 예제를 다시 만든 경우(`gold-roundtrip build`)에도 난다. 로컬 DB를 초기화한다.
- 튜토리얼·챌린지 `CONFLICT`는 다른 별이 이미 설정돼 있다는 뜻이다. 그대로 두며, 시드 별로 바꾸려면 로컬 DB를 초기화한다.
- 새 마이그레이션이 기존 행 때문에 멈추면(V4·V7처럼 데이터가 있으면 실패하는 방식) 백엔드 README의 "로컬 DB 초기화" → `bootRun` → 시드 순서로 다시 만든다.

## 덤프가 필요할 때

uv가 없는 팀원에게 같은 상태를 넘기거나 시연 리허설마다 되돌릴 때만 뜬다. 덤프는 뜬 시점의 마이그레이션 버전에 고정되므로 오래 두지 않고 필요할 때 이 시드로 다시 만든다. `*.dump`는 Git에 넣지 않는다. 스키마와 데이터를 함께 빈 DB에 복원하며, 복원 전에 백엔드(Flyway)를 먼저 띄우지 않는다([운영 규칙 런북](../../../docs/operations/operation-rule-runbook.md) 7절).

```powershell
# 뜨기: 시드를 넣은 DB, 저장소 루트
docker compose exec service-db pg_dump -U planetory -d planetory_poc -Fc -f /tmp/planetory-seed.dump
docker compose cp service-db:/tmp/planetory-seed.dump ./planetory-seed.dump

# 복원: 로컬 DB 데이터가 모두 지워진다
docker compose --profile service down -v service-db
docker compose --profile service up -d --wait service-db
docker compose cp ./planetory-seed.dump service-db:/tmp/planetory-seed.dump
docker compose exec service-db psql -U planetory -d planetory_poc -c "CREATE ROLE planetory_gold_writer NOLOGIN; CREATE ROLE planetory_app NOLOGIN; CREATE ROLE planetory_stats_job NOLOGIN;"
docker compose exec service-db pg_restore -U planetory -d planetory_poc --no-owner /tmp/planetory-seed.dump
```

역할은 DB 클러스터 전역이라 덤프에 들어가지 않는다. 새 볼륨에는 역할이 없으므로 복원 전에 마이그레이션이 만드는 역할(V2의 두 역할, V21의 `planetory_stats_job`)을 먼저 만든다. 역할이 없으면 `pg_restore`가 `role "…" does not exist` 오류와 함께 종료 코드 1로 끝나고 그 권한이 빠진다. 이후 마이그레이션이 역할을 더 만들어 같은 오류가 나오면 그 역할도 `NOLOGIN`으로 만들고 빈 DB부터 다시 복원한다. 복원 뒤 백엔드를 띄우면 Flyway가 기존 이력을 검증하고 덤프 이후의 마이그레이션만 이어서 적용한다.

## 검증

```powershell
uv run pytest -q
```

- `test_canonical.py`: [Gold 계약 벡터](../../../contracts/gold/examples/)(배열·레코드 checksum, bundle_version)를 재현한다.
- `test_payload.py`: 튜토리얼 의도·정답, manifest 필수 키, transit_model 계약 1.0, checksum, U자 가장자리 비, TOI-270이 원본 예제와 checksum까지 같은지를 DB 없이 본다.
- `test_local_guard.py`: 로컬 판정을 DB 없이 본다. `hostaddr`·`service`·빈 host와 `PGHOST`·`PGHOSTADDR`·`PGSERVICE` 환경변수로 원격을 가리키면 접속하지 않고 `NOT_LOCAL`로 멈춘다. 접속 뒤 실제 주소가 원격이면 아무 쿼리 전에 연결을 닫는다.
- `test_notify.py`: 판 전환 후처리 알림을 로컬 HTTP 서버로 본다. 판마다 성공·실패를 따로 알리고, 백엔드에 연결하지 못하면 실패로 센다. 시스템 프록시가 잡혀 있어도 서비스 토큰을 프록시로 보내지 않는다. 토큰이 없으면 DB에 붙기 전에 멈춘다.
- `test_load.py`: `LOCAL_SEED_TEST_DATABASE_URL`이 있을 때만 돈다. 새 스키마에 저장소 마이그레이션 전체를 적용하고 적재·재적재·내용 충돌·새 판 교체·운영 설정 보존·마이그레이션 뒤처짐 거절을 검사한 뒤 스키마를 지운다. 실제 연결에서 host 이름이 아니라 접속 주소로 판정하는지, 거절할 때 연결을 닫고 `NOT_LOCAL`로 멈추는지도 본다. 첫 실행에서 알림을 생략했거나 후처리가 HTTP 503·연결 실패로 끝난 뒤 같은 명령을 다시 실행하면 current 판 전체에 다시 알리는지도 본다. 개발 DB가 아닌 일회용 PostgreSQL을 가리킨다.

백엔드 경로 확인은 `LOCAL_SEED_SMOKE=1`로 켜는 `LocalSeedSmokeTest`다. Flyway가 만든 격리 스키마에 시드를 넣고, 운영과 같은 가입 경로로 회원을 만든다. 튜토리얼 다섯 별의 정답을 원본 곡선에서 제출해 챌린지 별이 열리는지 본 뒤, 모든 공개 별의 분석 조회와 TOI-270의 정답 제출까지 확인하고 별마다 원본 봉우리 목록을 출력한다. uv가 필요해 기본 빌드에서는 건너뛴다.

```powershell
cd apps/backend
$env:LOCAL_SEED_SMOKE = "1"; .\gradlew.bat test --tests '*LocalSeedSmokeTest' --rerun
```

시드 코드와 환경 변수는 Gradle 입력이 아니라서 `--rerun` 없이는 이전 결과를 재사용(`UP-TO-DATE`)한다. 다른 백엔드 테스트처럼 격리 스키마를 만들었다 지우며, `DATABASE_URL`·`DATABASE_PASSWORD`로 일회용 PostgreSQL을 가리키면 개발 DB를 쓰지 않는다.

## 만드는 방법

- 곡선: 2분 간격 원본 시각(품질 플래그 1.5%, 산란광 구간 두 곳, 궤도 사이 1일 전송 공백)에 잡음을 만들고 `astro_kernel.segmentation.bin_sector`(114 비닝 규칙)로 10분 세그먼트를 만든 뒤 bin 중심에서 통과 모양을 곱한다. box는 같은 모델로 나누면 잡음만 남는다. U자는 가장자리가 선형으로 들어가고 바닥이 둥근 모양, V자는 삼각형이며, 둘 다 box 창 안의 평균 깊이가 후보 깊이와 같게 맞춘다.
- 주기도·discoverable: `astro_kernel`의 BLS와 `discoverability.classify`로 계산한다. 반복 탐색처럼 단계마다 잔차 주기도에서 가장 센 발견 가능 신호를 `removal_step` 순서로 둔다. 판정이 정답표의 기대값과 다르면 적재하지 않고 실패한다. 후보를 모두 뺀 잔차에 기준을 넘는 봉우리가 남으면, U자·V자 신호의 주기 배수인 것만 허용해 manifest `qa.residual_peaks`에 남기고 나머지는 실패한다.
- 실제 곡선: TOI-270은 [gold-roundtrip](../../gold-roundtrip/README.md) 예제(`S15P21C206-117`)의 곡선·주기도·후보·외부 참조를 그대로 쓴다. 예제의 `discoverable`은 셋 다 true인데, 현재 `discoverability` 규칙(123, 승인 전)으로 다시 계산하면 셋 다 false가 나온다. c·d는 SNR이 20을 넘지만 한 섹터에 통과가 몇 번뿐이라 SDE가 4.3으로 기준 6에 못 미친다(b는 앞 신호를 빼지 않은 원본에서 판정돼 false). 이 차이로 적재를 막지 않고 예제 값을 따른다. 예제 주기도도 커널 계산과 설정이 달라 값이 다르다.
- 식별자: 합성 별의 `binning_revision`은 모든 세그먼트가 같은 `10m-syn-v1`이다(TOI-270은 예제의 `10m-v1`). 탐사 API 명세와 백엔드는 한 판의 세그먼트 revision이 하나여야 한다고 보고, 섹터마다 다른 해시를 만드는 Gold 4.1 채택안·`astro_kernel.segment_revision`은 이와 맞지 않아 쓰지 않았다. `bundle_version`은 계약의 `pv1` 규칙이다. 합성 입력 snapshot은 곡선 checksum과 정답표 해시를 쓰며 `lc:synthetic:`·`catalog:synthetic:`으로 표시한다. 실데이터용 `lc:spoc:` 형식 검사는 일부러 통과하지 않는다. manifest의 `local_seed` 키에 출처와 재실행 비교용 요약을 적는다.

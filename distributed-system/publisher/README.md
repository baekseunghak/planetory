# Publisher

완료된 Silver를 검사하고 EC2용 Gold 묶음으로 포장해 서비스 PostgreSQL에 게시한다.

경로, 버전과 checksum을 검증한 뒤 전달한다. 전송이나 검증에 실패하면 기존 Gold를 바꾸지 않는다.

## 현재 상태 (S15P21C206-262, S15P21C206-272)

**적재 단계는 구현했고, 입력은 목업과 튜토리얼 5종 두 가지다.** 적재 단계는 로컬 시드(`S15P21C206-256`, MR `!201`)의 `local_seed/load.py`에서 옮겼다. 일반 탐사용 실제 Gold 입력(HDFS reader), 후보 동일성 대조, GCP→EC2-A 접속 경로는 없다. 튜토리얼 5종은 고정 FITS에 공용 커널을 돌려 만든 실제 Gold다(아래 「튜토리얼 5종」).

현재 목업은 TOI-270의 TESS 곡선과 별도 Archive `pscomppars` 참고값으로 만든 계약 예시를 다른 더미 TIC에 옮긴다. `external_statuses.source='nasa_exoplanet_archive'`와 행성명도 함께 복사되므로 그 값은 더미 TIC에 실제로 대응하는 행성의 검증 결과가 아니다. 266 NASA 설명 경로의 원천·식별 조건은 [266 계약 2절](../../docs/development/nasa-planet-info-266.md#2-식별자와-요청-흐름)을 따른다.

| 파일 | 역할 | 교체 시 |
| --- | --- | --- |
| `publisher/load.py` | preflight, 적재, 같은 트랜잭션 안 조회 검사, current 전환 | 그대로 쓴다 |
| `publisher/notify.py` | 판 전환 알림(표준 라이브러리만) | 그대로 쓴다 |
| `publisher/mock_source.py` | 계약 예시 payload를 운영 더미 별 TIC에 옮겨 싣는다 | **HDFS Gold reader로 바꾼다** |
| `publisher/tutorial_source.py`, `publisher/tutorial.json` | 튜토리얼 5종 입력 어댑터와 대상·checksum·라벨 정의 | 튜토리얼 재선정 때 `tutorial.json`을 바꾼다 |
| `publisher/tutorial_switch.sql` | 튜토리얼 1~5 등록, 기존 회원 이전, 옛 임시 1번 정리 | 그대로 쓴다(재실행 안전) |
| `publisher/__main__.py` | 명령(`mock-load`·`mock-purge-sql`·`notify`·`tutorial-build`·`load-payload`·`tutorial-switch-sql`) | 명령만 추가한다 |
| `publisher/mock_purge.sql` | `mock-` 표식 행을 지운다 | 목업을 걷을 때 함께 지운다 |
| `publisher/fixtures/gold-toi270-s3.json` | 목업 입력 원천 | 목업을 걷을 때 함께 지운다 |

checksum은 공용 `astro_kernel.gold_canonical`로 계산한다. 이미지에 astro-kernel(numpy)을 설치하고, preflight가 비교할 Backend 마이그레이션 목록을 `/app/migrations`에 둔다.

## payload 모양

로컬 시드와 같은 모양이다. 입력 어댑터가 이 모양을 내면 `load.publish_star`는 원천을 구분하지 않는다.

- `tic_id`, `label`
- `star`: 별 속성. **없으면(`None`) 별 행을 덮어쓰지 않고 존재만 확인한다.** 목업이 이렇게 한다.
- `bundle`: `bundle_version`, `payload_digest`(선택), `manifest`(`record_checksums` 포함), `fold_reference_time_btjd`, `base_days`(둘 다 float)
- `segments[]`: `sector`, `binning_revision`, `start_btjd`, `bin_minutes`, `n_points`, `flux`, `flux_scatter`, `gaps`, `checksum`, `observation{start_btjd, end_btjd, cadence, source_version}`
- `periodogram`: `period_min_days`, `period_max_days`, `n_periods`, `power`, `checksum`
- `candidates[]`: `record`(후보 수치·`transit_model`), `disposition`, `external`, `ai`

재시도 판정 요약의 규칙은 적재가 가진다(`load.payload_digest`, `S15P21C206-86`). 판 버전, `fold_reference_time_btjd`·`base_days`, 세그먼트 자연 키와 flux checksum, 주기도·레코드 checksum으로 만들고 DB가 만드는 id는 넣지 않는다(I02-2 인계 규칙). 입력 어댑터는 값을 주지 않아도 된다. 주면 적재가 계산한 값과 같아야 하고, 다르면 쓰기 전에 `PUBLISH_REJECTED`로 멈춘다. 적재는 자기가 계산한 값을 `manifest.publish.payload_digest`에 둔다. 시드가 먼저 넣은 행의 `manifest.local_seed.payload_digest`도 함께 읽으며, 시드·목업이 먼저 적재한 행과 같은 값이 나오도록 식을 바꾸지 않는다.

**새로 만드는 입력 어댑터(HDFS Gold reader 등)는 `payload_digest`를 주지 않는다.** 주면 적재 식과 계속 함께 맞춰야 하는데 얻는 것은 자기 점검뿐이다. 이미 계산하는 시드·목업은 그대로 둔다(`!223` 리뷰).

## 로컬 시드(!201)와의 관계

시드는 팀원 로컬 DB의 통합 테스트용이고 localhost만 받는다. 이 디렉터리는 운영 서비스 DB 적재의 정본 위치다(`S15P21C206-86`·`87`). 로컬 전용 접속 제한과 튜토리얼·챌린지 설정은 시드에만 둔다.

**시드는 아직 자기 `load.py`를 쓴다.** 적재 단계를 한 벌로 모으려면 시드가 `publisher.load.publish_star`를 부르도록 바꿔야 한다(`!201` 리뷰에서 강재민과 조율). 두 쪽의 checksum은 2026-09-24 fixture로 대조해 같았다.

## 적재 절차

정본은 [시스템 아키텍처](../../docs/architecture/system-architecture.md) 「공개」와 [ERD](../../docs/architecture/database-erd.md) 결정 12다. `load.publish`가 그대로 밟는다.

1. **preflight.** Gold 테이블, Flyway 실패 이력, DB 버전(이미지의 마이그레이션 목록 이상), `operation_settings`의 규칙을 본다. 운영 적재 계정은 `flyway_schema_history`·`operation_settings`의 SELECT가 따로 필요하다(서비스 README).
2. `planetory_gold_writer` 멤버 계정으로 붙고 트랜잭션 안에서 `SET LOCAL ROLE planetory_gold_writer`로 쓴다. 소유자로 붙으면 권한 분리가 무력화된다.
3. `pg_advisory_xact_lock(tic_id)`으로 같은 TIC 게시를 줄 세운다.
4. `(tic_id, bundle_version)`이 이미 있으면 적재가 계산한 `payload_digest`와 대조한다. 같으면 `ALREADY_PUBLISHED`, archived면 `BUNDLE_SUPERSEDED`로 아무것도 바꾸지 않는다. 다르면 `IDEMPOTENCY_CONFLICT`. 같은 키의 중복 행은 적재 코드를 거치지 않는 쓰기도 DB의 `UNIQUE(tic_id, bundle_version)`(V8)이 막는다.
5. 관측 원천 → 세그먼트(자연 키로 공유, 재사용 시 flux checksum 대조) → 판 `staging` → 주기도 → 이전 후보 `retired`와 `candidate_status_history` → 새 후보·처분·외부 라벨·AI 평가를 넣는다.
6. 같은 트랜잭션에서 다시 읽어 배열·레코드 checksum, 결측 구간, `transit_model.candidate_id`, 처분 수를 대조한다.
7. 기존 `current`를 `archived`로 바꾸고, archived 판의 주기도를 지우고, 새 판을 `current`로 올린다.
8. 커밋 뒤 `POST /internal/bundles/b-<id>/activated`로 Backend에 알린다. 헤더는 `X-Planetory-Service-Token: <INTERNAL_SERVICE_TOKEN>`이다. 실패해도 DB 전환은 되돌리지 않는다. 토큰이 없으면 보내지 않는다. `mock-load`는 이미 current인 판에도 다시 알리므로 같은 명령을 다시 돌리면 복구된다. 판 하나만 보내려면 `notify --bundle b-<id>`.

2~7은 한 트랜잭션이다. 격리 수준은 바꾸지 않고 서버 기본 `READ COMMITTED`로 연다. 공식 스레드 요약을 동기화하는 V19가 있어 후보 네 수치 변경 트랜잭션은 `READ COMMITTED`여야 한다. 적용 전 확인·오류 처리·공개 요청 잠금 대기 조건은 [공식 검색 본문 계약](../../docs/api/community/README.md#공식-제목본문의-구현-차이)을 따른다.

V23 이후 후보 변경·current 전환은 [알림 DB 생산 계약](../../docs/development/service-backend/community.md#notification-producer-contract)을 따른다. 지연 트리거가 최종 current 상태에서만 원천 사건·당시 수신 의도를 기록한다. Gold 계정의 회원 직접 권한은 추가하지 않는다. 사건을 별도 INSERT하거나 제약 트리거를 중간에 강제 실행하지 않는다.

## 적재가 다루지 않는 것

- **별 등록 판단.** `star`가 있으면 upsert하고, 없으면 존재만 본다. 운영 Publisher가 어떤 별을 등록할지는 정하지 않았다.
- **후보 동일성 대조.** 새 판을 올리면 이전 후보를 전부 은퇴시킨다. 운영 Publisher는 [후보 정정 계약](../../docs/architecture/candidate-correction-contract.md)으로 갱신·은퇴를 대조해야 한다.

## 튜토리얼 5종 (S15P21C206-272)

109(MR !104)가 확정한 튜토리얼 5종을 실제 TESS 곡선으로 게시한다. 대상·입력 checksum·외부 라벨의 정본은 [`publisher/tutorial.json`](publisher/tutorial.json)이다.

| 순서 | intent | TIC / Sector | 후보 | 외부 행(source) |
| --- | --- | --- | --- | --- |
| 1 | deep_confirmed | 149603524 WASP-62 / S2 | 1 | WASP-62 b (`archive`, pscomppars BJD-TDB) |
| 2 | shallow_confirmed | 307210830 L 98-59 / S2 | 3 | L 98-59 c·d·b (`archive`, Demangeon 2021 Table 3) |
| 3 | fp | 279569718 / S3 | 1 | SPOC DV S1-13 planet 1 (`tutorial_label`) |
| 4 | deep_fp | 300871545 TOI-184 / S3 | 1 | TESS Data Alerts TOI-184.01 (`tutorial_label`) |
| 5 | multi_fp | 278956474 / S3 | 2 | SPOC DV planet 1(A), planet 2 짝수 식·2배 주기(B) (`tutorial_label`) |

- **계산.** `tutorial_source`가 공용 `astro_kernel`만 부른다. 119 전처리 → 122 반복 BLS(기본 v0 품질, 109 실측과 같다)·후보표 → 123 세그먼트·제공 해상도 → 124 외부 조인 → 125 `assemble`. 결과는 `mock_source`와 같은 payload이고 적재는 같은 `publish_star`다.
- **임시 ID.** 커널은 DB 예약 ID를 받는다. 이전 판이 없는 최초 게시라 판·후보·세그먼트에 1부터 고정 임시 ID를 주고, DB가 적재 때 실제 ID를 붙인다. 레코드 checksum은 ID와 `transit_model.candidate_id`를 빼고 계산해 그대로 맞는다. 튜토리얼 별에 새 판을 다시 올리려면 DB 예약 ID와 `previous_bundle`을 넘기도록 바꿔야 한다.
- **판정 규칙 `tutorial-label-v1`.** 116/124 규칙은 ExoFOP TFOPWG 라벨만 판정으로 바꾸므로, 3·5번(EB 카탈로그·문헌 근거)과 확정 행성 표에만 있는 1·2번은 그대로는 hold다. 109의 선정 근거(서비스 범위 9.9~9.13절)를 튜토리얼 전용 외부 행으로 싣고 raw 라벨을 확정 행성 `CP`, 행성 아님 `FP`로 적는다. 후보와의 연결은 124 직접 대응 규칙(identity ≤ 0.5, duration 비 ≤ 2, 관측 Jaccard ≥ 0.5)을 그대로 통과해야 한다. **모든 활성 후보가 직접 대응하고 판정이 intent와 맞을 때만** payload를 낸다. 일반 탐사 공급에는 쓰지 않는다. 승인 근거는 실행 때 `--label-approval`로 받아 manifest `publish.label_approval`에 남긴다.
- **source.** 확정 행성은 266 NASA 설명이 읽는 `source='archive'`와 정확한 `pl_name`으로 싣는다. L 98-59는 Archive 행이 `systemref=BJD`(TDB 미확인)라 수치는 Demangeon 값이고 행성 식별자만 Archive 이름이다. 이후 79의 외부 시간 규칙 v2가 이 Archive 행을 출처 논문(Cadieux 2025, TESS TBJD)에 근거해 BJD-TDB로 받게 됐다. 그래도 게시된 튜토리얼 판은 109 선정 근거인 Demangeon 값을 그대로 쓴다([116 계약 v2](../../docs/data/tess-external-catalog-contract.md)). 행성 아님 신호는 `tutorial_label`이다.
- **AI.** 264 운영 채택 전이라 싣지 않는다(`policy_not_executed`). 262 목업과 같다.
- **알려진 점.** 별 완료는 탐색 가능한 활성 후보를 모두 매칭해야 한다. 2번은 c 외에 d(7.45일)·b(2.25일, 원본 곡선에서 제출 가능)까지 찾아야 끝난다. b·d 라벨은 272에서 Demangeon Table 3로 추가했다.

### 입력 받기

FITS와 외부 원천은 저장소에 두지 않는다. `experiments/tess-bench/results/tutorial-inputs/`(Git 제외)처럼 한 폴더에 `tutorial.json`의 `file`·`filename` 이름으로 받는다. MAST는 S3로 리디렉션하므로 `-L`이 필요하다. checksum이 다르면 빌드가 멈춘다.

- 곡선 5개: `https://mast.stsci.edu/api/v0.1/Download/file/?uri=mast:TESS/product/<filename>`
- 외부 원천: `tutorial.json`의 각 `external.uri`(DV XML 2개, TESS Data Alerts CSV, Archive TAP CSV, Demangeon 논문 PDF)

### 로컬 빌드

BLS 의존성(astropy·scipy)이 있는 astro-kernel 개발 환경에서 돌린다. DB에 붙지 않는다.

```sh
cd libs/astro-kernel
PYTHONPATH=".;../../distributed-system/publisher" uv run --locked python -m publisher tutorial-build \
  --inputs ../../experiments/tess-bench/results/tutorial-inputs --out <payload 폴더> --label-approval "<승인 근거>"
```

별당 150~180 KB JSON 다섯 개가 나온다. 같은 입력이면 같은 판 버전이라 다시 적재해도 `ALREADY_PUBLISHED`로 끝난다.

### 운영 순서

1. 이 변경이 develop에 병합돼 `build:publisher`가 새 이미지를 만든다(이미지는 develop에서만 빌드된다).
2. payload 폴더를 EC2-A로 옮기고 `load-payload`로 싣는다. 명령은 [EC2 서비스 배포](../../infra/service/README.md) 「튜토리얼 5종」.
3. `tutorial-switch-sql`을 소유자 psql로 먼저 모의 실행해 개수를 보고, 확인 뒤 `-v apply=1`로 적용한다.

`tutorial_switch.sql`은 5개 별이 튜토리얼로 쓸 수 있는지(공개, current 판·주기도, 활성 후보, 후보마다 처분) 먼저 검사한다. 이어서 옛 1번 별 위의 회원 기록(그 성과·옛 1번을 가리키는 알림, 제출·분석 기록·성과와 그 성과로 열린 별의 접근 권한·진행도)을 지우고, 회원을 새 1번으로 옮긴다. 성과로 열린 별에 회원이 제출·분석 기록·성과를 남겼으면 지우지 않고 멈춘다. 그 기록은 `star_unlocks`·`user_star_progress`를 참조하지 않아 외래 키가 막지 않으므로, 지울지는 사람이 정한다. 배치 좌표는 발견 순번으로만 정해져서 `star_unlocks`의 tic만 바꾼다. 옛 1번의 목업 판을 지우고 별을 숨긴 뒤 `tutorial_stars` 1~5를 채운다. 다시 돌리면 대상 0건으로 끝난다.

### 되돌리기

- `load-payload`는 별마다 한 트랜잭션이다. 커밋 전 실패는 전부 rollback된다. 커밋된 튜토리얼 판을 지우는 명령은 없다. 판이 잘못됐으면 고친 입력으로 새 판을 올린다.
- `tutorial_switch.sql`은 모의 실행이 기본이다. 적용 뒤에는 되돌리는 SQL이 없으므로 **적용 전에 `pg_dump`로 서비스 DB 백업을 받는다**. 지운 회원 기록은 목업 곡선에서 나온 것이라 복원 대상이 아니다(2026-09-26 사용자 승인).

## DEC-01 공급 집계 (S15P21C206-79)

`python -m publisher supply-report --manifest <79 후보 집계 출력>`은 게시 뒤 서비스 DB와 같은 run의 79 manifest를 대사해 DEC-01 운영 집계 기록(JSON)을 표준 출력에 낸다. 정책은 [서비스 범위 7.1절](../../docs/data/tess-service-scope-v1.md#71-dec-01-초기-공개-결정-2026-09-24-정책-승인), 판정 조건은 [Gold 계약 4.3절](../../contracts/gold/README.md#43-s15p21c206-79-게시-후보-집계)이 정본이다.

- **읽기만 한다.** `REPEATABLE READ READ ONLY` 트랜잭션 하나에서 `tutorial_stars`·`stars`·`publication_bundles`·`candidates`(`supply.REPORT_TABLES`)를 읽는다. 두 조회가 같은 스냅샷을 보므로 그 사이 튜토리얼 전환이 커밋돼도 한 기록에 두 시점이 섞이지 않는다.
- **보고 로그인.** 네 테이블의 SELECT만 가진 `planetory_reporter`로 붙는다(준비 절차는 [EC2 서비스 배포](../../infra/service/README.md#dec-01-공급-집계-보고-s15p21c206-79)). Gold 쓰기 계정은 `tutorial_stars` 권한이 없고, 앱 로그인(`planetory_service`)은 사람이 손으로 쓰지 않는다. `planetory_app` 역할에는 회원 기록 쓰기 권한까지 있어 보고용으로 물려받지 않는다.
- **공급 TIC:** 이 run의 `ready`, DB current 판 = 이 run의 판, `published`, active·discoverable 후보 1개 이상, 사용 중(`active`) 튜토리얼 별 아님. 이 run 대상이 아닌 별(목업 등)은 세지 않는다.
- **판정:** manifest가 미완료이거나 게시 누락(`publish_missing_tic_ids`)이 있으면 `undetermined`다. 공급 100개 이상이고 튜토리얼 1~5번이 모두 제공 가능해야 `pass`, 아니면 `short`다. 명령은 기록을 내면 0으로 끝나며 판정은 `verdict`로 본다. `ready`인데 번들이 없는 manifest처럼 집계할 수 없는 입력은 사유를 표준 오류로 내고 1로 끝난다. `--manifest -`이면 표준 입력에서 읽는다.

## 실행

서비스 노드에서 돌리는 방법과 계정 준비·삭제 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「Gold 목업」·「튜토리얼 5종」에 있다.

```sh
python -m publisher mock-load --tic 900000008,900000027   # libpq 환경변수(PGHOST 등)로 접속
python -m publisher mock-purge-sql                        # 삭제 SQL 출력. 소유자 psql로 넘긴다
python -m publisher notify --bundle b-12                  # 이미 current인 판에 알림만 다시 보낸다
python -m publisher tutorial-build --inputs <폴더> --out <폴더> --label-approval <근거>   # 로컬, DB 없음
python -m publisher load-payload <payload 폴더>           # payload JSON을 게시한다
python -m publisher tutorial-switch-sql                   # 튜토리얼 전환 SQL 출력. 소유자 psql로 넘긴다
python -m publisher supply-report --manifest candidates.json  # planetory_reporter로 DEC-01 집계 기록을 읽기만 한다
PYTHONPATH=../../libs/astro-kernel python -m unittest test_mock_source test_tutorial_source test_notify test_supply   # DB 없이 도는 검사
PUBLISHER_TEST_DATABASE_URL=postgresql://<소유자>:<비밀번호>@127.0.0.1:<포트>/<DB> \
  PYTHONPATH=../../libs/astro-kernel python -m unittest test_load                   # 일회용 PostgreSQL에서 도는 적재 검사
```

`test_tutorial_source`는 `TUTORIAL_INPUTS`에 입력 폴더를 주면 실제 FITS로 5종 payload까지 만든다. CI에는 FITS가 없어 이 검사는 건너뛴다. 대신 `SyntheticBuildTest`가 합성 SPOC FITS 한 개로 119→125와 `to_payload`를 끝까지 돌려 커널 호출이 깨지지 않았는지 본다(수치 정답은 보지 않는다).

2026-09-26 로컬 검증(develop `f0c3b4ca` 기준 V29 빈 DB, 운영과 같은 `tutorial.skip_after=0`)에서 운영 상태를 재현했다. 옛 1번 `261136679`에 목업 b-1을 올리고, 두 회원이 그 별을 받게 했다. 한 회원은 목업 후보에 정답을 내 성과 1건과 그 성과로 열린 별 1개를 얻었다. 그 위에서 확인한 결과는 다음과 같다.

- `load-payload`: 5종 모두 `PUBLISHED`(트랜잭션 안 조회 검사 통과)였고, 재실행은 `ALREADY_PUBLISHED`였다.
- 전환 SQL 모의 실행: 회원 2·제출 1·분석 기록 1·성과 1·성과로 연 별 1·목업 판 1·목업 후보 3을 보고했고, 모두 rollback됐다.
- 전환 SQL 적용: 두 회원의 1번이 `149603524`로 바뀌었다. 순번 0·좌표 (760, 430)는 그대로였고 진행도는 `unexplored`였다. 옛 기록과 b-1은 0이 됐고 더미 별 목업은 남았다. `261136679`는 `hidden`이 됐다. 재적용은 대상 0건이었다.
- 앱 경로(Spring 테스트, MockMvc): 옮긴 회원의 `/api/v1/me/quests`가 5칸이었고 1번은 `149603524`였다. 신규 회원은 5개 별 모두 분석 진입·곡선·주기도(5000점)·봉우리가 200이었다. 정답 제출 9건이 모두 `matched`였고 1→5 순서로 열려 `completedCount=5`까지 갔다. 잔차 단계는 Worker 없이 원본 곡선에서만 확인했다.

`test_load`(`S15P21C206-86`)는 `PUBLISHER_TEST_DATABASE_URL`이 있을 때만 돈다. 새 스키마에 저장소 마이그레이션 전체를 파일 순서대로 적용하고 끝나면 지운다. 마이그레이션이 역할을 만들어 소유자(superuser)로 붙으므로 **개발·운영 DB가 아니라 일회용 PostgreSQL**을 가리킨다(예: `docker run --rm -e POSTGRES_PASSWORD=… -p 127.0.0.1:<포트>:5432 postgres:18.6-alpine`). 검사하는 것은 `planetory_gold_writer`로의 첫 적재, 같은 payload 재실행 무변경, 같은 판 버전의 다른 내용 `IDEMPOTENCY_CONFLICT`, 어댑터 요약 불일치 `PUBLISH_REJECTED`, DB의 재시도 키 강제, 다음 판의 세그먼트 재사용과 이전 판 archived, 같은 자연 키의 세그먼트 내용 변경 충돌, staging 뒤 실패 시 행 무변경과 current 유지, 배열 길이·단위 범위 위반의 전체 rollback, 같은 payload 동시 게시의 직렬화(판 하나), 20개 별 적재다. `TutorialSwitchTest`(`S15P21C206-272`)는 `tutorial_switch.sql` 본문을 한 트랜잭션에서 돌리고 rollback한다. 옛 1번 성과로 열린 별에 회원 기록이 없으면 정리하고 회원을 옮기는지, 있으면 예외로 멈추는지 본다. 배열 길이(`n_points`·`n_periods`)와 단위 범위(`bin_minutes > 0`, `0 < period_min_days < period_max_days`)는 DB CHECK(V1)가 강제한다. manifest에는 단위 메타데이터가 없어 적재가 단위를 따로 대조하지 않는다. 그 밖의 값 범위(`base_days`, 후보 수치)는 위 「게시 전 QA」 범위다.

CI는 테스트 파일을 이름으로 적어 돌린다. 테스트 파일을 추가하면 표준 라이브러리만 쓰는 것은 `validate:data-platform`에, `astro_kernel`을 쓰는 것은 `validate:astro-kernel`에(둘 다 `.gitlab/ci/common.yml`), PostgreSQL이 필요한 것은 일회용 postgres 서비스가 붙은 `validate:publisher`(`.gitlab/ci/distributed-system/publisher.yml`)에 넣는다. 지금 `validate:publisher`는 `test_load`만 돈다([CI/CD 「data-platform 테스트」](../../docs/operations/cicd.md#data-platform-테스트-s15p21c206-91)).

2026-09-24 EC2-A 격리 환경(develop `e9835da5` Backend로 V24를 적용한 빈 DB, 운영과 같은 역할 구성)에서 옮긴 적재 단계를 검증했다. 읽기 권한이 없으면 `MIGRATION_UNREADABLE`로 멈추고, 권한을 준 뒤 두 별 `PUBLISHED`·알림 200, 재실행 `ALREADY_PUBLISHED`·알림 재전송, 없는 별 `STAR_MISSING`, 기존 별 속성 불변, 삭제 모의 실행 뒤 그대로, 실제 삭제 뒤 목업 행 0(관측 원천·처분·외부 라벨 포함), 삭제 뒤 재적재를 확인했다. 회원 제출이 목업 판을 참조하면 모의·실제 삭제 모두 `submissions=1`로 멈추고 행이 그대로 남으며, 그 제출을 지운 뒤에는 삭제가 끝나는 것도 확인했다. 같은 격리 환경에서 실제 Google 로그인 세션으로 튜토리얼 1번 별(목업 적재)의 분석 API도 확인했다. 별 요약 `analysisAvailable=true`·`currentBundleId=b-1`, `analysis-context` 200, 원본 곡선(`curveStep=0`) 200·세그먼트 1개 2919점, 주기도 200·power 5000점, 봉우리 200·10개이며 상위 봉우리 5.66일·11.55일·11.38일이다(TOI-270 c·d 주기와 맞는다). 잔차 단계(`curveStep≥1`)는 Python Worker가 없어 확인하지 않았다. OAuth 되돌림 주소는 `localhost:8080`만 등록돼 있어 `127.0.0.1:8080`은 `redirect_uri_mismatch`다.

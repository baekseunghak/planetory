# Publisher

검증된 Gold를 GCP Node 1에서 EC2-A 서비스 PostgreSQL에 직접 적재하고, 같은 트랜잭션에서 current를 전환한 뒤 Backend에 알린다. 파일을 EC2로 전송하지 않는다. 적재나 검증에 실패하면 트랜잭션을 롤백해 기존 current를 바꾸지 않는다.

## 현재 상태 (S15P21C206-262, S15P21C206-272, S15P21C206-276)

**적재 단계는 구현했고, 입력 어댑터는 목업·튜토리얼 5종·배치 run 세 가지다.** 적재 단계는 로컬 시드(`S15P21C206-256`, MR `!201`)의 `local_seed/load.py`에서 옮겼다. 튜토리얼 5종은 고정 FITS에 공용 커널을 돌려 만든 실제 Gold다(아래 「튜토리얼 5종」). 배치 run은 80 게시 준비 폴더의 게시 전 검사·변환과 run 단위 게시 명령 `publish-run`까지 구현했다(아래 「배치 run」). 명령은 publish-ready를 Node 1 로컬로 받은 폴더를 읽는다. 폴더를 HDFS에서 받는 단계와 Airflow task는 80 DAG 작업에서 붙인다. 후보 동일성 대조는 없으므로 배치 run은 첫 게시만 한다. 처음 보는 사람은 [Gold 배치 게시 경로의 코드 구조](../../docs/architecture/gold-batch-publish.md)에서 파일 역할과 흐름을 먼저 본다. Node 1 → EC2-A 접속 경로와 Node 1 실행 방법은 [EC2 서비스 배포](../../infra/service/README.md) 「Publisher 운영 적재 경로」(`S15P21C206-85`)다.

현재 목업은 TOI-270의 TESS 곡선과 별도 Archive `pscomppars` 참고값으로 만든 계약 예시를 다른 더미 TIC에 옮긴다. `external_statuses.source='nasa_exoplanet_archive'`와 행성명도 함께 복사되므로 그 값은 더미 TIC에 실제로 대응하는 행성의 검증 결과가 아니다. 266 NASA 설명 경로의 원천·식별 조건은 [266 계약 2절](../../docs/development/nasa-planet-info-266.md#2-식별자와-요청-흐름)을 따른다.

| 파일 | 역할 | 교체 시 |
| --- | --- | --- |
| `publisher/load.py` | preflight, 적재, 같은 트랜잭션 안 조회 검사, current 전환 | 그대로 쓴다 |
| `publisher/notify.py` | 판 전환 알림(표준 라이브러리만) | 그대로 쓴다 |
| `publisher/mock_source.py` | 계약 예시 payload를 운영 더미 별 TIC에 옮겨 싣는다 | 운영 입력은 `run_source`가 맡는다. 목업을 걷을 때 함께 지운다 |
| `publisher/run_source.py` | 배치 run 입력 어댑터. 80 게시 준비 폴더를 게시 전 검사하고 payload로 바꾼다. 판 본문 변환(`gold_body`)은 튜토리얼도 같이 쓴다 | 80 publish-ready 형식이 바뀌면 함께 바꾼다 |
| `publisher/tutorial_source.py`, `publisher/tutorial.json` | 튜토리얼 5종 입력 어댑터와 대상·checksum·라벨 정의 | 튜토리얼 재선정 때 `tutorial.json`을 바꾼다 |
| `publisher/tutorial_switch.sql` | 튜토리얼 1~5 등록, 기존 회원 이전, 옛 임시 1번 정리 | 그대로 쓴다(재실행 안전) |
| `publisher/__main__.py` | 명령(`mock-load`·`mock-purge-sql`·`notify`·`tutorial-build`·`load-payload`·`tutorial-switch-sql`·`publish-run`) | 명령만 추가한다 |
| `publisher/mock_purge.sql` | `mock-` 표식 행을 지운다 | 목업을 걷을 때 함께 지운다 |
| `publisher/fixtures/gold-toi270-s3.json` | 목업 입력 원천 | 목업을 걷을 때 함께 지운다 |

checksum은 공용 `astro_kernel.gold_canonical`로 계산한다. 이미지에 astro-kernel(numpy)을 설치하고, preflight가 비교할 Backend 마이그레이션 목록을 `/app/migrations`에 둔다.

## payload 모양

로컬 시드와 같은 모양이다. 입력 어댑터가 이 모양을 내면 `load.publish_star`는 원천을 구분하지 않는다.

- `tic_id`, `label`
- `star`: 별 속성. **없으면(`None`) 별 행을 덮어쓰지 않고 존재만 확인한다.** 목업이 이렇게 한다. `service_status`가 `None`이면 새 별은 `hidden`으로 등록하고 기존 별의 공개 상태는 바꾸지 않는다. 배치 run이 이렇게 한다.
- `bundle`: `bundle_version`, `payload_digest`(선택), `manifest`(`record_checksums` 포함), `fold_reference_time_btjd`, `base_days`(둘 다 float)
- `segments[]`: `sector`, `binning_revision`, `start_btjd`, `bin_minutes`, `n_points`, `flux`, `flux_scatter`, `gaps`, `checksum`, `observation{start_btjd, end_btjd, cadence, source_version}`
- `periodogram`: `period_min_days`, `period_max_days`, `n_periods`, `power`, `checksum`
- `candidates[]`: `record`(후보 수치·`transit_model`), `disposition`, `external`, `ai`. `external`은 외부 참조 **목록**이다. 124는 원천마다 직접 대응을 하나씩 내므로 후보 하나에 여러 행이 붙을 수 있다(`S15P21C206-276`).
- `external_only`: 우리 후보와 직접 대응하지 않은 외부 신호(124 `external_only`) 목록. `candidate_id` 없이 싣는다. 없으면 빈 목록이다.

외부 참조 한 행은 `source`, `external_id`, `disposition`, `period_days`, `epoch_btjd`, `fetched_on`(YYYY-MM-DD)이다. 125 번들의 `record_checksums.external_statuses`는 후보 없는 행까지 포함해 계산하므로 두 목록을 빠짐없이 실어야 적재 검사가 맞는다.

재시도 판정 요약의 규칙은 적재가 가진다(`load.payload_digest`, `S15P21C206-86`). 판 버전, `fold_reference_time_btjd`·`base_days`, 세그먼트 자연 키와 flux checksum, 주기도·레코드 checksum으로 만들고 DB가 만드는 id는 넣지 않는다(I02-2 인계 규칙). 입력 어댑터는 값을 주지 않아도 된다. 주면 적재가 계산한 값과 같아야 하고, 다르면 쓰기 전에 `PUBLISH_REJECTED`로 멈춘다. 적재는 자기가 계산한 값을 `manifest.publish.payload_digest`에 둔다. 시드가 먼저 넣은 행의 `manifest.local_seed.payload_digest`도 함께 읽으며, 시드·목업이 먼저 적재한 행과 같은 값이 나오도록 식을 바꾸지 않는다.

**새로 만드는 입력 어댑터(배치 run `run_source` 등)는 `payload_digest`를 주지 않는다.** 주면 적재 식과 계속 함께 맞춰야 하는데 얻는 것은 자기 점검뿐이다. 이미 계산하는 시드·목업은 그대로 둔다(`!223` 리뷰).

## 로컬 시드(!201)와의 관계

시드는 팀원 로컬 DB의 통합 테스트용이고 localhost만 받는다. 이 디렉터리는 운영 서비스 DB 적재의 정본 위치다(`S15P21C206-86`·`87`). 로컬 전용 접속 제한과 튜토리얼·챌린지 설정은 시드에만 둔다.

**시드는 아직 자기 `load.py`를 쓴다.** 적재 단계를 한 벌로 모으려면 시드가 `publisher.load.publish_star`를 부르도록 바꿔야 한다(`!201` 리뷰에서 강재민과 조율). 두 쪽의 checksum은 2026-09-24 fixture로 대조해 같았다.

## 적재 절차

정본은 [시스템 아키텍처](../../docs/architecture/system-architecture.md) 「공개」와 [ERD](../../docs/architecture/database-erd.md) 결정 12다. `load.publish`가 그대로 밟는다.

1. **preflight.** Gold 테이블, Flyway 실패 이력, DB 버전(이미지의 마이그레이션 목록 이상), `operation_settings`의 규칙을 본다. 운영 적재 계정은 `flyway_schema_history`·`operation_settings`의 SELECT가 따로 필요하다(서비스 README).
2. `planetory_gold_writer` 멤버 계정으로 붙고 트랜잭션 안에서 `SET LOCAL ROLE planetory_gold_writer`로 쓴다. 소유자로 붙으면 권한 분리가 무력화된다.
3. `pg_advisory_xact_lock(tic_id)`으로 같은 TIC 게시를 줄 세운다.
4. `(tic_id, bundle_version)`이 이미 있으면 적재가 계산한 `payload_digest`와 대조한다. 같으면 `ALREADY_PUBLISHED`, archived면 `BUNDLE_SUPERSEDED`로 아무것도 바꾸지 않는다. 다르면 `IDEMPOTENCY_CONFLICT`. 같은 키의 중복 행은 적재 코드를 거치지 않는 쓰기도 DB의 `UNIQUE(tic_id, bundle_version)`(V8)이 막는다. `first_publish_only`(배치 run)이면 다른 판이 current인 별은 여기서 `PUBLISH_REJECTED`로 멈춘다.
5. 관측 원천 → 세그먼트(자연 키로 공유, 재사용 시 flux checksum 대조) → 판 `staging` → 주기도 → 이전 후보 `retired`와 `candidate_status_history` → 새 후보·처분·외부 참조·AI 평가 → 후보와 대응하지 않은 외부 참조(`external_only`)를 넣는다.
6. 같은 트랜잭션에서 다시 읽어 배열·레코드 checksum, 결측 구간, `transit_model.candidate_id`, 처분 수를 대조한다. `external_only` 행은 판 열이 없어 이번에 넣은 id로 다시 읽는다.
7. 기존 `current`를 `archived`로 바꾸고, archived 판의 주기도를 지우고, 새 판을 `current`로 올린다.
8. 커밋 뒤 `POST /internal/bundles/b-<id>/activated`로 Backend에 알린다. 헤더는 `X-Planetory-Service-Token: <INTERNAL_SERVICE_TOKEN>`이다. 실패해도 DB 전환은 되돌리지 않는다. 토큰이 없으면 보내지 않는다. `mock-load`는 이미 current인 판에도 다시 알리므로 같은 명령을 다시 돌리면 복구된다. 판 하나만 보내려면 `notify --bundle b-<id>`.

2~7은 한 트랜잭션이다. 격리 수준은 바꾸지 않고 서버 기본 `READ COMMITTED`로 연다. 공식 스레드 요약을 동기화하는 V19가 있어 후보 네 수치 변경 트랜잭션은 `READ COMMITTED`여야 한다. 적용 전 확인·오류 처리·공개 요청 잠금 대기 조건은 [공식 검색 본문 계약](../../docs/api/community/README.md#공식-제목본문의-구현-차이)을 따른다.

V23 이후 후보 변경·current 전환은 [알림 DB 생산 계약](../../docs/development/service-backend/community.md#notification-producer-contract)을 따른다. 지연 트리거가 최종 current 상태에서만 원천 사건·당시 수신 의도를 기록한다. Gold 계정의 회원 직접 권한은 추가하지 않는다. 사건을 별도 INSERT하거나 제약 트리거를 중간에 강제 실행하지 않는다.

## 적재가 다루지 않는 것

- **별 공개 판단.** `star`가 있으면 upsert하고, 없으면 존재만 본다. 배치 run은 새 별을 `hidden`으로 등록하고 기존 별의 공개 상태를 바꾸지 않는다(`S15P21C206-276` 착수 결정 1의 기본값). 배치로 올린 별을 `published`로 바꾸는 절차는 정하지 않았다.
- **후보 동일성 대조.** 새 판을 올리면 이전 후보를 전부 은퇴시킨다. 그래서 배치 run은 첫 게시만 한다. 갱신 게시는 [후보 정정 계약](../../docs/architecture/candidate-correction-contract.md)으로 갱신·은퇴를 대조할 수 있게 된 뒤 연다.
- **125 이력 제안과 별칭.** 번들의 `history_proposals`와 `candidate_aliases`는 적재하지 않는다. 첫 게시에서는 잃는 것이 없다. `candidate_status_history`는 [ERD](../../docs/architecture/database-erd.md)상 판이 바뀌며 **달라진 값**의 기록인데, 첫 게시의 제안은 이전 값이 없는 첫 판정뿐이다. 이 이력을 읽는 Backend 코드와 DB 트리거도 아직 없다. 첫 게시 번들의 별칭은 125 규칙상 늘 비어 있다. 값이 바뀌는 이력의 적재는 갱신 게시를 열 때 함께 넣는다. Backend 판 전환 후처리는 이 적재를 87의 Publisher 몫으로 본다(`BundleActivationRepository`).

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
- 276에서 payload의 `external`이 목록으로 바뀌었다. 그 전에 만든 payload JSON(작업자 로컬 인계본만 남아 있다)은 운영 DB에 다시 실으면 판 대조에서 `ALREADY_PUBLISHED`로 끝나 후보까지 가지 않는다. 빈 DB에 새로 실으면 모양이 달라 rollback되므로 `tutorial-build`로 다시 만든다. 같은 입력이면 같은 판이다.
- `tutorial_switch.sql`은 모의 실행이 기본이다. 적용 뒤에는 되돌리는 SQL이 없으므로 **적용 전에 `pg_dump`로 서비스 DB 백업을 받는다**. 지운 회원 기록은 목업 곡선에서 나온 것이라 복원 대상이 아니다(2026-09-26 사용자 승인).

## 배치 run (S15P21C206-276)

`run_source`는 80 gate가 통과시킨 게시 준비 산출물(publish-ready)을 Node 1 로컬 폴더로 받아 게시 전 검사하고 payload로 바꾼다. DB에 붙지 않는다. `publish-run`이 그 payload를 별마다 첫 게시하고 run 기록을 낸다. **구현·합성 검증까지다.** 폴더 배치와 줄 형식은 80 세션과 합의했다(2026-09-27). 80 쪽 구현은 병합 전이다. HDFS에서 폴더로 받는 단계, Airflow 게시 task와 Node 1 운영 게시는 80 DAG 작업에서 붙인다.

- **입력 폴더.** 파일 네 가지로 이뤄진다.
  - `_READY.json`: publish-ready marker(schema `planetory.tess-publish-ready.v1`, HDFS `/lake/gold/tess/publish-ready/run_id=<run>/_READY.json`)
  - `manifest/part-*`: 한 줄 = 79 run manifest
  - `candidates/part-*`: 한 줄 = 79 후보 행
  - `bundles/part-*`: 한 줄 = `{"tic_id", "payload": 125 번들, "metadata": {"star": {teff_k, radius_rsun, tmag}, "observations": {"<Sector>": {cadence, source_version}}}}`

  marker의 `files` 키가 폴더 기준 상대 경로이고 part마다 `sha256`·`bytes`·`lines`를 담는다. `files`에 없는 파일(`_SUCCESS` 등)은 읽지 않는다. 메타데이터의 `source_version`은 Bronze PROCVER, cadence는 `"120s"` 형식이다. 별 속성은 원천이 없어 NULL이다.
- **검사 분담.** 후보 표 재해시(`candidates_sha256`), 79 schema, payload 배열·레코드 checksum과 `bundle_version` 재계산은 80 gate가 한다. 통과해야만 publish-ready가 생긴다.
- **run 검사.** 여기서는 marker 형식과 `run_id`, `files`의 sha256·bytes·lines(전송 무결성, 폴더 밖 경로 거절), manifest 한 줄과 집계 형식 버전, marker `counts`와 manifest `counts`의 일치, 번들 줄 수가 manifest의 ready 수와 같은지를 본다. Spark가 빈 파티션도 part 파일로 쓰므로 `lines=0` 파일이 섞일 수 있고, 번들 수는 줄 수 합으로 판단한다. 하나라도 어긋나면 별을 하나도 내지 않는다. 번들은 줄 단위로 읽어 메모리가 별 하나 크기로 묶인다. 줄마다 run manifest 항목(TIC·판 ID·판 버전·레코드 checksum)에 한 번씩만 대응해야 하며, 어긋나면 그 별만 거절한다.
- **별 검사.** 번들의 flux·주기도 배열 checksum과 레코드 checksum을 번들 manifest와 대조한다. [Gold 계약 4장](../../contracts/gold/README.md#4-필드와-단위) 가운데 DB CHECK가 막지 않는 값(`fold_reference_time_btjd` 유한, `base_days` 양수, 후보 주기·지속시간 양수, 기준 시각·BLS power 유한, 깊이 0 초과 1,000,000 미만)을 본다. 걸린 별만 `PUBLISH_REJECTED`로 두고 DB에 쓰지 않는다. **계약 밖의 QA 기준값은 없다.** 데이터 담당(125·117)과 합의한 뒤 더한다.
- **첫 게시만.** 은퇴 후보, 이전 값이 있는 이력 제안, `keep`·`retire` 수명 조치가 있는 번들은 갱신 판으로 보고 거절한다. 적재는 `first_publish_only=True`로 불러 이미 current가 있는 별을 거절한다. 80은 대상 선택에서 튜토리얼 5종을 뺀다(`--exclude-tic`, publish-ready `excluded_tics`). 튜토리얼 별은 늘 current가 있어 이 규칙이 방어선이 된다. 갱신 게시를 열 때는 튜토리얼 제외를 따로 넣어야 한다(Gold 쓰기 계정은 `tutorial_stars`를 읽지 못한다).
- **외부 참조.** 후보마다 모든 원천의 직접 대응을 싣고 대응 없는 행은 `external_only`로 싣는다. 125가 PSCompPars 행을 `source='archive'`, `external_id`=정확한 `pl_name`으로 싣는다([Gold 계약 4.3절](../../contracts/gold/README.md#43-s15p21c206-79-게시-후보-집계)). 266 NASA 설명은 이 참조로만 원천을 찾는다.
- **AI.** 79 정책대로 싣지 않는다(`ai=None`, `ai_executions` 없음).
- **게시 명령.** `python -m publisher publish-run --run-id <id> --ready <게시 준비 폴더> --approval <게시 승인 근거>`. `--run-id`가 marker나 run manifest의 `run_id`와 다르면 아무것도 싣지 않는다. 승인 근거는 80 DAG의 수동 게시 승인 task가 넘기고, 번들 `manifest.publish.approval`에 남는다. 별마다 한 트랜잭션이고, 한 별의 실패가 다음 별을 막지 않는다.
- **run 기록.** 표준 출력의 JSON 하나다(진행 메시지는 표준 오류). `run_id`, `silver_attempt`, `aggregator_version`, `approval`, `flyway_version`, `status`(`published`·`rejected`, 거절이면 `reason`), `counts`, `stars[]`(`tic_id`, `code`, `bundle_id`, `detail`, `current_kept`, 게시한 별의 `confirmed_without_archive`), `notify`(`status` `sent`·`partial`·`skipped_no_token`·`none`과 판별 `results`), `started_at`·`finished_at`(UTC)을 담는다. `confirmed_without_archive`는 `archive` 참조가 없어 266 설명이 열리지 않을 확정 후보 수다. 거절 사유가 아니다.
- **결과 코드와 종료 코드.** DB 제약 위반은 `PUBLISH_REJECTED`, 연결이 끊긴 일시 장애는 `PUBLISH_ROLLED_BACK`이다(Gold 계약 6절, 새 코드를 만들지 않는다). 모든 별이 `PUBLISHED`·`ALREADY_PUBLISHED`·`BUNDLE_SUPERSEDED`면 0이다. `PUBLISH_ROLLED_BACK`이 있으면 1이다. 같은 명령을 다시 돌리면 끝난 별은 `ALREADY_PUBLISHED`이고 알림도 다시 간다. 알림 일부 실패는 0이다. DB의 current가 정본이라 게시를 다시 돌리지 않는다. 실패한 판은 run 기록 `notify.results`를 보고 `notify --bundle b-<id>`로 다시 보낸다. 응답 대기 시간 초과나 연결 끊김도 그 판의 실패로만 남는다. 한 별의 예상 밖 오류는 그 별의 `PUBLISH_REJECTED`로 기록하고 다음 별로 간다. 그 밖의 거절만 남았으면 65다. Silver 제어기처럼 재시도해도 같은 결과인 데이터 실패를 뜻하므로 Airflow가 재시도하지 않게 한다. 알림 토큰이 없어 보내지 않은 것은 실패가 아니다. `current_kept=true`인 별도 실패로 세지 않는다. 튜토리얼 별처럼 이미 current가 있어 첫 게시 한정 정책대로 기존 판을 둔 별이다. 결과 코드는 계약대로 `PUBLISH_REJECTED`이고 run 기록에 그대로 남는다. 1~13 run에는 튜토리얼 5종 TIC이 들어 있어, 이 규칙이 없으면 매번 65로 끝난다.
- **Airflow 게시 단계(Node 1 제어기).** `tess_publication_run`의 `approve_publication` 뒤에 `start_publish` → `wait_publish`가 돈다. 호출하는 것은 `distributed-system/spark/tess_publish_ctl.py`(pipeline release의 `spark/`)다. Gold 제어기처럼 systemd unit(`planetory-tess-publish-<run>.service`, oneshot, 실패하면 5분 뒤 재시작, 65면 멈춤)으로 돌아 Airflow 재시작과 무관하다. 절차는 다음과 같다.
  1. HDFS publish-ready marker의 schema·run·attempt·`files` 모양을 확인한다.
  2. `files` bytes 합에 여유 2 GiB를 더한 만큼 디스크가 있는지 본다.
  3. part마다 `hdfs dfs -cat`으로 `/var/lib/planetory-publish/run=<run>/ready`에 받으며 sha256·bytes·lines를 대조한다.
  4. `docker run --network host --env-file /etc/planetory/publisher/env -v <폴더>:/ready:ro <이미지> python -m publisher publish-run`을 돌린다.
  5. 표준 출력의 run 기록을 상태 파일(`/var/lib/planetory-publish/run=<run>/publish=<UTC>.json`)에 남기고, 성공하면 로컬 사본을 지운다.

  publish-run 종료 0은 `complete`, 1은 `failed`(unit 재시작, 끝난 별은 `ALREADY_PUBLISHED`)다. 65와 그 밖의 종료는 `rejected`이고 unit도 65로 멈춘다. 그 밖의 종료란 이미지에 `publish-run`이 없을 때의 2, docker 오류 125처럼 다시 돌려도 같은 결과인 경우다. 상태 파일은 marker·이미지 검사보다 먼저 `prepared`로 쓰고, 실패하면 이유를 `failure_detail`에 남겨 Airflow `wait_publish`가 그 이유로 실패하게 한다. 받는 도중의 일시 장애(`failed`)도 같다. unit은 Gold와 같이 하루 7번까지만 시작한다(`StartLimitBurst=7`, DAG의 재시작 한도 6보다 하나 많음). **이미지는 인자로 받지 않는다.** sudo 아래 임의 이미지가 host 네트워크와 DB env 파일을 쓰면 root와 같아서다. 그래서 root 전용 `/etc/planetory/publisher/image` 한 줄(`<registry>/planetory/publisher:<40자 sha>` 또는 `@sha256:`)로 고정한다. 승인 근거는 `airflow/tess-publication-run/<run>/approved`다. sudo 허용은 `infra/distributed-system/scripts/configure-tess-publish-airflow-node1.sh <release>`가 만든다. 이미 적용한 release의 sudoers는 바꿀 수 없으므로 게시 단계는 새 release ID로 배포한다. 1~13 run의 ready는 많아야 5,156개(80 확인)라 run 전체를 받는다. 80 Gold Canary(2026-09-27, release `20260927T052453Z`, TIC 5개)에서 번들 줄은 ready 별 하나에 약 430 KB였다(Sector·후보 수에 따라 다름). 그래서 1~13 번들은 2.2 GB 안팎으로 추정되고, 여유 2 GiB를 더해도 Node 1 여유 디스크 13 GB 안이다. 실제 run에서 다시 잰다. ponytail: 디스크가 모자라면 멈추고, 더 큰 run은 part 단위로 흘려 보내도록 바꾼다.
- **운영 서비스 DB 시험(2026-09-27, 사용자 승인).** Node 1에서 운영 Publisher 이미지(`50e13981`)에 이 브랜치의 `publisher`·`astro_kernel` 패키지를 읽기 전용으로 덮고 `publish-run --ready`를 돌렸다. 입력은 80 샘플 publish-ready(합성 TIC 999999101, run `20260927T010000Z`)다.
  - 결과: EC2-A `planetory_poc`(V29)에 `PUBLISHED b-12`·알림 HTTP 200, 재실행 `ALREADY_PUBLISHED b-12`·알림 200이었다.
  - DB와 로그: 별은 `hidden`, 판 manifest에 run ID·승인 근거, 관측 원천은 Sector 3·4 `120s`·`spoc-5.0.0`이었다. Backend 로그에 "판 12(TIC 999999101) 후처리"가 두 번 찍혔고 재개·라벨은 0이었다.
  - 정리: 소유자 psql로 일회성 삭제 SQL을 모의 실행해 개수(판 1·후보 1·세그먼트 2·관측 2·별 1, 알림 흔적 2)를 본 뒤 적용했다. 별 6·current 판 5·튜토리얼 1~5(b-5~b-9)로 돌아왔고, Node 1 작업 폴더도 지웠다. 게시 제어기(`tess_publish_ctl.py`)와 Airflow 게시 단계는 Node 1에 배포했지만, 첫 run이 승인 대기라 게시는 아직 돌지 않았다.

## DEC-01 공급 집계 (S15P21C206-79)

`python -m publisher supply-report --manifest <79 후보 집계 출력>`은 게시 뒤 서비스 DB와 같은 run의 79 manifest를 대사해 DEC-01 운영 집계 기록(JSON)을 표준 출력에 낸다. 정책은 [서비스 범위 7.1절](../../docs/data/tess-service-scope-v1.md#71-dec-01-초기-공개-결정-2026-09-24-정책-승인), 판정 조건은 [Gold 계약 4.3절](../../contracts/gold/README.md#43-s15p21c206-79-게시-후보-집계)이 정본이다.

- **읽기만 한다.** `REPEATABLE READ READ ONLY` 트랜잭션 하나에서 `tutorial_stars`·`stars`·`publication_bundles`·`candidates`(`supply.REPORT_TABLES`)를 읽는다. 두 조회가 같은 스냅샷을 보므로 그 사이 튜토리얼 전환이 커밋돼도 한 기록에 두 시점이 섞이지 않는다.
- **보고 로그인.** 네 테이블의 SELECT만 가진 `planetory_reporter`로 붙는다(준비 절차는 [EC2 서비스 배포](../../infra/service/README.md#dec-01-공급-집계-보고-s15p21c206-79)). Gold 쓰기 계정은 `tutorial_stars` 권한이 없고, 앱 로그인(`planetory_service`)은 사람이 손으로 쓰지 않는다. `planetory_app` 역할에는 회원 기록 쓰기 권한까지 있어 보고용으로 물려받지 않는다.
- **공급 TIC:** 이 run의 `ready`, DB current 판 = 이 run의 판, `published`, active·discoverable 후보 1개 이상, 사용 중(`active`) 튜토리얼 별 아님. 이 run 대상이 아닌 별(목업 등)은 세지 않는다.
- **판정:** manifest가 미완료이거나 게시 누락(`publish_missing_tic_ids`)이 있으면 `undetermined`다. 공급 100개 이상이고 튜토리얼 1~5번이 모두 제공 가능해야 `pass`, 아니면 `short`다. 명령은 기록을 내면 0으로 끝나며 판정은 `verdict`로 본다. `ready`인데 번들이 없는 manifest처럼 집계할 수 없는 입력은 사유를 표준 오류로 내고 1로 끝난다. `--manifest -`이면 표준 입력에서 읽는다.

## 실행

서비스 노드에서 돌리는 방법과 계정 준비·삭제 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「Gold 목업」·「튜토리얼 5종」, Node 1에서 돌리는 방법은 같은 문서 「Publisher 운영 적재 경로」에 있다.

```sh
python -m publisher mock-load --tic 900000008,900000027   # libpq 환경변수(PGHOST 등)로 접속
python -m publisher mock-purge-sql                        # 삭제 SQL 출력. 소유자 psql로 넘긴다
python -m publisher notify --bundle b-12                  # 이미 current인 판에 알림만 다시 보낸다
python -m publisher tutorial-build --inputs <폴더> --out <폴더> --label-approval <근거>   # 로컬, DB 없음
python -m publisher load-payload <payload 폴더>           # payload JSON을 게시한다
python -m publisher tutorial-switch-sql                   # 튜토리얼 전환 SQL 출력. 소유자 psql로 넘긴다
python -m publisher supply-report --manifest candidates.json  # planetory_reporter로 DEC-01 집계 기록을 읽기만 한다
python -m publisher publish-run --run-id <id> --ready <게시 준비 폴더> --approval <근거>  # 배치 run 첫 게시
PYTHONPATH=../../libs/astro-kernel python -m unittest test_mock_source test_tutorial_source test_run_source test_notify test_supply   # DB 없이 도는 검사
PUBLISHER_TEST_DATABASE_URL=postgresql://<소유자>:<비밀번호>@127.0.0.1:<포트>/<DB> \
  PYTHONPATH=../../libs/astro-kernel python -m unittest test_load                   # 일회용 PostgreSQL에서 도는 적재 검사
```

`test_tutorial_source`는 `TUTORIAL_INPUTS`에 입력 폴더를 주면 실제 FITS로 5종 payload까지 만든다. CI에는 FITS가 없어 이 검사는 건너뛴다. 대신 `SyntheticBuildTest`가 합성 SPOC FITS 한 개로 119→125와 `to_payload`를 끝까지 돌려 커널 호출이 깨지지 않았는지 본다(수치 정답은 보지 않는다).

2026-09-26 로컬 검증(develop `f0c3b4ca` 기준 V29 빈 DB, 운영과 같은 `tutorial.skip_after=0`)에서 운영 상태를 재현했다. 옛 1번 `261136679`에 목업 b-1을 올리고, 두 회원이 그 별을 받게 했다. 한 회원은 목업 후보에 정답을 내 성과 1건과 그 성과로 열린 별 1개를 얻었다. 그 위에서 확인한 결과는 다음과 같다.

- `load-payload`: 5종 모두 `PUBLISHED`(트랜잭션 안 조회 검사 통과)였고, 재실행은 `ALREADY_PUBLISHED`였다.
- 전환 SQL 모의 실행: 회원 2·제출 1·분석 기록 1·성과 1·성과로 연 별 1·목업 판 1·목업 후보 3을 보고했고, 모두 rollback됐다.
- 전환 SQL 적용: 두 회원의 1번이 `149603524`로 바뀌었다. 순번 0·좌표 (760, 430)는 그대로였고 진행도는 `unexplored`였다. 옛 기록과 b-1은 0이 됐고 더미 별 목업은 남았다. `261136679`는 `hidden`이 됐다. 재적용은 대상 0건이었다.
- 앱 경로(Spring 테스트, MockMvc): 옮긴 회원의 `/api/v1/me/quests`가 5칸이었고 1번은 `149603524`였다. 신규 회원은 5개 별 모두 분석 진입·곡선·주기도(5000점)·봉우리가 200이었다. 정답 제출 9건이 모두 `matched`였고 1→5 순서로 열려 `completedCount=5`까지 갔다. 잔차 단계는 Worker 없이 원본 곡선에서만 확인했다.

`test_load`(`S15P21C206-86`)는 `PUBLISHER_TEST_DATABASE_URL`이 있을 때만 돈다. 새 스키마에 저장소 마이그레이션 전체를 파일 순서대로 적용하고 끝나면 지운다. 마이그레이션이 역할을 만들어 소유자(superuser)로 붙으므로 **개발·운영 DB가 아니라 일회용 PostgreSQL**을 가리킨다(예: `docker run --rm -e POSTGRES_PASSWORD=… -p 127.0.0.1:<포트>:5432 postgres:18.6-alpine`). 검사하는 것은 `planetory_gold_writer`로의 첫 적재, 같은 payload 재실행 무변경, 같은 판 버전의 다른 내용 `IDEMPOTENCY_CONFLICT`, 어댑터 요약 불일치 `PUBLISH_REJECTED`, DB의 재시도 키 강제, 다음 판의 세그먼트 재사용과 이전 판 archived, 같은 자연 키의 세그먼트 내용 변경 충돌, staging 뒤 실패 시 행 무변경과 current 유지, 배열 길이·단위 범위 위반의 전체 rollback, 같은 payload 동시 게시의 직렬화(판 하나), 20개 별 적재다. 배치 run payload(`test_run_source`의 합성 run)로는 새 별의 `hidden` 등록, 후보 하나의 두 원천 참조(`archive`·TOI)와 후보 없는 참조 적재, 재실행 `ALREADY_PUBLISHED`, 기존 별의 공개 상태 유지, current가 있는 별의 `first_publish_only` 거절을 본다. `publish-run`의 run 기록은 별 셋(새 별, current가 있는 별, 배열 checksum이 깨진 별)으로 별별 결과, 거절 별의 무기록, 승인 근거, 재실행 `ALREADY_PUBLISHED`, run ID 불일치 거절을 본다(`S15P21C206-276`). `TutorialSwitchTest`(`S15P21C206-272`)는 `tutorial_switch.sql` 본문을 한 트랜잭션에서 돌리고 rollback한다. 옛 1번 성과로 열린 별에 회원 기록이 없으면 정리하고 회원을 옮기는지, 있으면 예외로 멈추는지 본다. 배열 길이(`n_points`·`n_periods`)와 단위 범위(`bin_minutes > 0`, `0 < period_min_days < period_max_days`)는 DB CHECK(V1)가 강제한다. manifest에는 단위 메타데이터가 없어 적재가 단위를 따로 대조하지 않는다. 그 밖의 값 범위(`base_days`, 후보 수치)는 위 「게시 전 QA」 범위다.

CI는 테스트 파일을 이름으로 적어 돌린다. 테스트 파일을 추가하면 표준 라이브러리만 쓰는 것은 `validate:data-platform`에, `astro_kernel`을 쓰는 것은 `validate:astro-kernel`에(둘 다 `.gitlab/ci/common.yml`), PostgreSQL이 필요한 것은 일회용 postgres 서비스가 붙은 `validate:publisher`(`.gitlab/ci/distributed-system/publisher.yml`)에 넣는다. 지금 `validate:publisher`는 `test_load`만 돈다([CI/CD 「data-platform 테스트」](../../docs/operations/cicd.md#data-platform-테스트-s15p21c206-91)).

2026-09-24 EC2-A 격리 환경(develop `e9835da5` Backend로 V24를 적용한 빈 DB, 운영과 같은 역할 구성)에서 옮긴 적재 단계를 검증했다. 읽기 권한이 없으면 `MIGRATION_UNREADABLE`로 멈추고, 권한을 준 뒤 두 별 `PUBLISHED`·알림 200, 재실행 `ALREADY_PUBLISHED`·알림 재전송, 없는 별 `STAR_MISSING`, 기존 별 속성 불변, 삭제 모의 실행 뒤 그대로, 실제 삭제 뒤 목업 행 0(관측 원천·처분·외부 라벨 포함), 삭제 뒤 재적재를 확인했다. 회원 제출이 목업 판을 참조하면 모의·실제 삭제 모두 `submissions=1`로 멈추고 행이 그대로 남으며, 그 제출을 지운 뒤에는 삭제가 끝나는 것도 확인했다. 같은 격리 환경에서 실제 Google 로그인 세션으로 튜토리얼 1번 별(목업 적재)의 분석 API도 확인했다. 별 요약 `analysisAvailable=true`·`currentBundleId=b-1`, `analysis-context` 200, 원본 곡선(`curveStep=0`) 200·세그먼트 1개 2919점, 주기도 200·power 5000점, 봉우리 200·10개이며 상위 봉우리 5.66일·11.55일·11.38일이다(TOI-270 c·d 주기와 맞는다). 잔차 단계(`curveStep≥1`)는 Python Worker가 없어 확인하지 않았다. OAuth 되돌림 주소는 `localhost:8080`만 등록돼 있어 `127.0.0.1:8080`은 `redirect_uri_mismatch`다.

# Publisher

완료된 Silver를 검사하고 EC2용 Gold 묶음으로 포장해 서비스 PostgreSQL에 게시한다.

경로, 버전과 checksum을 검증한 뒤 전달한다. 전송이나 검증에 실패하면 기존 Gold를 바꾸지 않는다.

## 현재 상태 (S15P21C206-262)

**적재 단계는 구현했고 입력은 목업이다.** 적재 단계는 로컬 시드(`S15P21C206-256`, MR `!201`)의 `local_seed/load.py`에서 옮겼다. 실제 Gold 입력(HDFS reader), 게시 전 QA, 후보 동일성 대조, GCP→EC2-A 접속 경로는 없다.

현재 목업은 TOI-270의 TESS 곡선과 별도 Archive `pscomppars` 참고값으로 만든 계약 예시를 다른 더미 TIC에 옮긴다. `external_statuses.source='nasa_exoplanet_archive'`와 행성명도 함께 복사되므로 그 값은 더미 TIC에 실제로 대응하는 행성의 검증 결과가 아니다. 266 NASA 설명 경로의 원천·식별 조건은 [266 계약 2절](../../docs/development/nasa-planet-info-266.md#2-식별자와-요청-흐름)을 따른다.

| 파일 | 역할 | 교체 시 |
| --- | --- | --- |
| `publisher/load.py` | preflight, 적재, 같은 트랜잭션 안 조회 검사, current 전환 | 그대로 쓴다 |
| `publisher/notify.py` | 판 전환 알림(표준 라이브러리만) | 그대로 쓴다 |
| `publisher/mock_source.py` | 계약 예시 payload를 운영 더미 별 TIC에 옮겨 싣는다 | **HDFS Gold reader로 바꾼다** |
| `publisher/__main__.py` | 명령(`mock-load`·`mock-purge-sql`·`notify`) | 명령만 추가한다 |
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

## 실행

서비스 노드에서 돌리는 방법과 계정 준비·삭제 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「Gold 목업」에 있다.

```sh
python -m publisher mock-load --tic 900000008,900000027   # libpq 환경변수(PGHOST 등)로 접속
python -m publisher mock-purge-sql                        # 삭제 SQL 출력. 소유자 psql로 넘긴다
python -m publisher notify --bundle b-12                  # 이미 current인 판에 알림만 다시 보낸다
PYTHONPATH=../../libs/astro-kernel python -m unittest test_mock_source test_notify   # DB 없이 도는 검사
PUBLISHER_TEST_DATABASE_URL=postgresql://<소유자>:<비밀번호>@127.0.0.1:<포트>/<DB> \
  PYTHONPATH=../../libs/astro-kernel python -m unittest test_load                   # 일회용 PostgreSQL에서 도는 적재 검사
```

`test_load`(`S15P21C206-86`)는 `PUBLISHER_TEST_DATABASE_URL`이 있을 때만 돈다. 새 스키마에 저장소 마이그레이션 전체를 파일 순서대로 적용하고 끝나면 지운다. 마이그레이션이 역할을 만들어 소유자(superuser)로 붙으므로 **개발·운영 DB가 아니라 일회용 PostgreSQL**을 가리킨다(예: `docker run --rm -e POSTGRES_PASSWORD=… -p 127.0.0.1:<포트>:5432 postgres:18.6-alpine`). 검사하는 것은 `planetory_gold_writer`로의 첫 적재, 같은 payload 재실행 무변경, 같은 판 버전의 다른 내용 `IDEMPOTENCY_CONFLICT`, 어댑터 요약 불일치 `PUBLISH_REJECTED`, DB의 재시도 키 강제, 다음 판의 세그먼트 재사용과 이전 판 archived, 같은 자연 키의 세그먼트 내용 변경 충돌, staging 뒤 실패 시 행 무변경과 current 유지, 배열 길이·단위 범위 위반의 전체 rollback, 같은 payload 동시 게시의 직렬화(판 하나), 20개 별 적재다. 배열 길이(`n_points`·`n_periods`)와 단위 범위(`bin_minutes > 0`, `0 < period_min_days < period_max_days`)는 DB CHECK(V1)가 강제한다. manifest에는 단위 메타데이터가 없어 적재가 단위를 따로 대조하지 않는다. 그 밖의 값 범위(`base_days`, 후보 수치)는 위 「게시 전 QA」 범위다. CI는 `validate:publisher`가 Publisher·astro-kernel·마이그레이션이 바뀔 때 일회용 postgres 서비스로 세 테스트를 모두 돈다([CI/CD](../../docs/operations/cicd.md) 「설정·계약 검사」).

2026-09-24 EC2-A 격리 환경(develop `e9835da5` Backend로 V24를 적용한 빈 DB, 운영과 같은 역할 구성)에서 옮긴 적재 단계를 검증했다. 읽기 권한이 없으면 `MIGRATION_UNREADABLE`로 멈추고, 권한을 준 뒤 두 별 `PUBLISHED`·알림 200, 재실행 `ALREADY_PUBLISHED`·알림 재전송, 없는 별 `STAR_MISSING`, 기존 별 속성 불변, 삭제 모의 실행 뒤 그대로, 실제 삭제 뒤 목업 행 0(관측 원천·처분·외부 라벨 포함), 삭제 뒤 재적재를 확인했다. 회원 제출이 목업 판을 참조하면 모의·실제 삭제 모두 `submissions=1`로 멈추고 행이 그대로 남으며, 그 제출을 지운 뒤에는 삭제가 끝나는 것도 확인했다. 같은 격리 환경에서 실제 Google 로그인 세션으로 튜토리얼 1번 별(목업 적재)의 분석 API도 확인했다. 별 요약 `analysisAvailable=true`·`currentBundleId=b-1`, `analysis-context` 200, 원본 곡선(`curveStep=0`) 200·세그먼트 1개 2919점, 주기도 200·power 5000점, 봉우리 200·10개이며 상위 봉우리 5.66일·11.55일·11.38일이다(TOI-270 c·d 주기와 맞는다). 잔차 단계(`curveStep≥1`)는 Python Worker가 없어 확인하지 않았다. OAuth 되돌림 주소는 `localhost:8080`만 등록돼 있어 `127.0.0.1:8080`은 `redirect_uri_mismatch`다.

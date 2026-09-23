# gold-roundtrip: Gold 적재 예제·PostgreSQL round-trip·공개 QA fixture

## 125 연결 검증 개발 상태 (2026-09-24)

`astro_kernel.gold_serialization.assemble`은 122 후보·123 세그먼트/discoverability·124 외부 조인을 받는 공용 직렬화 커널이다. `gold_roundtrip.serialization`은 호환 import이며, 이 실험 패키지는 저장 결과 연결 및 DB 검증을 담당한다. 아래 117의 과거 왕복 검증을 125 완료 근거로 재사용하지 않는다.

- 상위 결과가 모두 ready일 때만 후보 ID와 모델, 외부 판정의 일관성을 확인하고 여러 세그먼트의 float32 배열·NULL/gaps·레코드 checksum·manifest를 구성한다. 한 결과라도 보류이면 payload 없이 `PUBLISH_REJECTED`를 반환한다.
- 입력은 `catalog`, `segmented`, `discovery`, `external`, 제거 전 `periodogram`(candidate_id=null, periods/power), 호출자 예약 `segment_ids`(Sector 문자열→BIGINT), `input_snapshot_ids`, `calculation_versions`, `fold_reference_time_btjd`, `base_days`, `fine_tune`, `ai_policy`다. 123의 런타임 Periodogram 객체는 연결 실행기에서 배열로 투영한다.
- DB ID 할당·적재·current 전환·`applied_at` 생성은 하지 않는다. 결과의 `validated`는 커널 검사만 의미하며 항상 `publishable=false`다. 공용 구현 배치가 운영 Publisher 연결·배포를 뜻하지 않는다.
- AI는 `policy_not_executed` 입력만 받으며 결정 참조와 두 버전 문자열을 호출자가 명시한다. 테스트 문자열은 운영 채택값이 아니다. 126 내부 점수는 입력으로 받지 않으며 `ai_results=[]`만 구성한다.
- `previous_bundle`을 받으면 기존 퇴역 후보의 모델·판정 표시와 별칭을 보존하고 누락·임의 변경·재활성화를 거절한다. 기존 판정 유지 대상 ID, lifecycle action, 검증된 변경 이력 제안을 별도로 내보낸다. 적용 시각·원자적 적용은 Publisher 책임이다. 빈 후보의 상위 보류를 해제하지 않으며 무신호 게시 정책을 변경하지 않는다.
- 원본 FITS checksum·원본 품질 필터 시각 기준 fold/기간·저장 주기도 연결과 실제 외부 보류를 검산했다. 이전 11개 DB 검증 이후 추가된 이력 투영은 새 결과로 DB 재확인이 필요하다. 퇴역 후보·별칭 보존은 단위 검증이며 운영 DB 생명주기 검증과 구분한다.

```powershell
uv run --locked python -m pytest tests/test_serialization.py tests/test_canonical.py tests/test_qa.py -q
```

실행 결과: 신규 직렬화 및 기존 checksum·QA **39 passed**. PostgreSQL 및 실제 FITS/BLS 재실행은 이 결과에 포함하지 않는다. 117 lockfile은 최신 로컬 패키지 메타데이터에 맞춰 갱신했다.

### 125 저장 결과 연결 검산

123 `run-20260923T155440Z-e010c680`은 16곡선 parity 통과(ready 11, held 5), 실제 실행 160.031초다. plan·출력 47개 해시를 확인했다. 124 `run-20260922T141154Z-696cda44` 출력 3개 해시와 함께 대조한 연결 결과는 `results/connection-125/run-20260923T164518Z-3e244b94`에 저장했다.

- 실제 외부 조인 11개는 hold이므로 Gold payload 생성 거절 11개. 실제 외부 라벨 게시 성공을 주장하지 않는다.
- 124의 저장된 `controlled_external.direct` 11개로 별도 성공 경로를 확인했다. 후보 ID 18개를 보존하며 원본 FITS의 품질 필터 후 시각으로 fold 기준을 계산했다. 신규 detrending·BLS는 실행하지 않았다.
- 숫자 ID, AI 미실행 버전 문자열, 외부 라벨은 통제 fixture다. 운영 ID 예약·정책 문자열 확정·과학 QA 전체 충족의 증거가 아니다.
- 최초 연결 실행기 및 기존 검증은 42개 통과했고 DB 실행 결과는 아래에 기록했다.

```powershell
uv run --locked python -m gold_roundtrip.connection_replay --segmentation ../tess-bench/results/segmentation-regression/run-20260923T155440Z-e010c680 --external ../tess-bench/results/external-catalog-candidate-regression/run-20260922T141154Z-696cda44
uv run --locked python -m gold_roundtrip.connection_db --connection-run results/connection-125/run-20260923T164518Z-3e244b94 --report results/connection-125/db-roundtrip-3e244b94.json
```

DB 명령은 loopback 개발 PostgreSQL만 허용하며 기존 117의 로컬 연결 기본값 또는 `DATABASE_URL`을 사용한다. V1~V24(실행 시 현재 migration 목록)를 새 `gold125_*` 스키마에 적용하고, 각 통제 payload의 여러 세그먼트·후보·외부 참조·판정을 적재·조회한다. 이 실행기가 검증용 `applied_at`을 공급한다. 모든 변경은 같은 트랜잭션에서 실행한 뒤 rollback하여 스키마까지 제거한다. current 전환·운영 Publisher·DB ID 할당은 검증하지 않는다. 기존 역할·테이블은 삭제하지 않으며 migration 파일은 수정하지 않는다.

### 125 독립 PostgreSQL 실행 확인

사용자가 `connection_db`를 실행한 결과 통제 payload 11개, 필드 비교 989개가 통과했다. 보고서 `results/connection-125/db-roundtrip-3e244b94.json`의 SHA-256은 `7c0de39b191d8e983a4fd8dd6c459af88b17509dd5223cf3e747419b20ee06c9`다. 입력 13개와 V1~V24 migration 24개의 해시 총 37개를 저장 파일에서 다시 확인해 모두 일치했다. 각 실행은 rollback되었으며 운영 공개·current 전환은 수행하지 않았다.

실제 수치 배열·후보 모델에 통제 라벨과 fixture ID를 연결한 저장 정합성 검증이며, 외부 hold 11개를 해소했다는 뜻은 아니다.

### 공용 커널·이력 보완 후 검증

공용 checksum·직렬화 구현으로 이동한 뒤 astro-kernel 전체와 직렬화·checksum·QA·연결 테스트를 합쳐 **355 passed**를 확인했다. 기존 산출물만 재연결한 최신 실행은 `results/connection-125/run-20260923T170809Z-07646dd4`이며, 실제 외부 보류 11개 거절·통제 성공 11개·후보 18개·상위 보류 5개는 동일하다. 이전 DB 보고서는 이전 출력에 대한 근거로 보존한다. 새 이력 투영을 포함한 다음 DB 검증은 아직 실행 전이다.

```powershell
uv run --locked python -m gold_roundtrip.connection_db --connection-run results/connection-125/run-20260923T170809Z-07646dd4 --report results/connection-125/db-roundtrip-07646dd4.json
```

위 명령의 사용자 실행과 저장 보고서 검산을 완료했다. 11개 payload·1,277개 필드 비교가 통과했고 모든 트랜잭션은 rollback되었다. 보고서 SHA-256은 `b1997360bfd44e683fd8e08ea03042710e63ce5f64aef06dec9804d1a5e5014c`다. 연결 실행 및 DB 보고서에 기록된 입력·출력·코드·migration의 고유 106개 경로를 재검산해 불일치 0건을 확인했다. 앞의 실행 대기 설명은 이 확인 이전 상태다.

리뷰 자료는 Git 제외 경로 `results/review-125-07646dd4.zip`에 만들었으며 MR 첨부로 전달한다. 연결 JSON·DB 보고서·내부 checksum 목록 총 15항목(원본 FITS 없음), SHA-256은 `2ee5e0b89ce558a612bfea50db95def3810532086158be9db21700a0fa840f28`이다. ZIP 내부 파일 해시도 전수 일치한다. 106개 원본 경로 전체가 ZIP에 포함되는 것은 아니다. 실제 외부 라벨 보류·fixture ID·current 미전환·운영 미검증 한계는 그대로다.

Jira `S15P21C206-117` (계획 ID D09) / 담당: 윤성용 / 상태: TOI-270 Sector 3 예제로 로컬 PostgreSQL 18.6 QA+왕복 62항목 통과, MR !64 1차 리뷰 반영, 재검토 대기

실제 TESS 곡선 하나로 Gold 판(세그먼트·주기도·후보·manifest) payload 를 만들고, 저장소의 Flyway SQL(V1~V8)을 그대로 적용한 격리
스키마에 넣었다가 다시 읽어 **계약대로 보존되는지**를 검사한다. 계약 규칙은 [Gold 공개 QA](../../contracts/gold/publication-qa.md),
배열 checksum 규칙과 언어 간 벡터는 [`contracts/gold/`](../../contracts/gold/README.md) 에 있다. 하둡·Spark·운영 Publisher 는 쓰지 않는다.

## 준비

로컬 PostgreSQL 컨테이너(개발 셋업 문서의 공용 DB, 포트 15432)와 fixture FITS(`../tess-fixture/sample_raw/toi270/`)가 필요하다.

```powershell
# 저장소 루트
docker compose --profile service up -d --wait service-db
cd experiments/gold-roundtrip
uv sync --python 3.11
```

접속 기본값은 `postgresql://planetory:ssafy@127.0.0.1:15432/planetory_poc` 이고 `DATABASE_URL` 로 바꿀 수 있다.
`localhost` 를 쓰면 Windows 에서 IPv6 를 먼저 시도해 접속당 약 2분 지연되니 `127.0.0.1` 을 쓴다.

## 실행

```powershell
uv run python -m gold_roundtrip build        # fixtures/gold-toi270-s3.json (약 96 KB) 재생성. 실행 시각을 넣지 않으므로 diff 가 없어야 한다
uv run python -m gold_roundtrip vectors      # contracts/gold/examples/array-checksum-vectors.v0.json + record-checksum-vectors.v0.json 재생성
uv run python -m gold_roundtrip roundtrip    # 공개 전 QA → 격리 스키마 gold_rt_<hex> 생성 → V1~V8 → 적재(미commit) → 같은 트랜잭션에서 조회 비교 → 통과 시 전환 → 전환 뒤 검사 → 단일 commit → 스키마 삭제. results/roundtrip-report.json
uv run pytest -q                             # DB 없으면 round-trip 테스트는 skip
node ../../contracts/gold/array-checksum.cjs # Node 로 배열 checksum 벡터 재현
node ../../contracts/gold/record-checksum.cjs # Node 로 레코드 checksum 벡터 재현
```

`--keep-schema` 를 주면 스키마를 남겨 psql 로 들여다볼 수 있다. 다 본 뒤 `DROP SCHEMA gold_rt_... CASCADE` 로 지운다.

## payload 예제가 담는 것 (`fixtures/gold-toi270-s3.json`)

| 항목 | 값 | 어떻게 만들었나 |
|---|---|---|
| 세그먼트 | Sector 3, 10분 비닝 2,919 bin(NULL 293, gaps 4), `start_btjd`, `flux_scatter` | QUALITY==0·정규화 → 42 잠정 전처리 `biweight_1.0d` → 첫 유효 점부터 10분 격자 평균, 빈 bin NULL. flux 는 적재 전 float32 정규화 |
| 기준 시각 | `fold_reference_time_btjd` = DAT-02 품질 필터·유한성 통과 원본 관측 시각에서 중복 제거 뒤 중앙값(DAT-11·ERD), float64 | `build_baseline` 의 `base.time` 을 `np.unique` 뒤 중앙값. 전처리(clipping) 결과에 의존하지 않음, 중복 제거 효과는 합성 사례 테스트 |
| 주기도 | 로그 5,000점, 0.5–40 d, likelihood, PoC 지속시간 4점 | 비닝 곡선(bin 중심)에 astropy BLS |
| 후보 | TOI-270 b·c·d (Archive), `transit_model` 계약 1.0 | `references.csv` → `known_signal_models`. `candidate_id` 는 적재 시 DB id 로 `c-<id>` |
| 외부 상태·AI 결과 | `external_statuses` 3행(Archive confirmed, 후보 자연 키로 연결), `ai_results` 빈 목록(118 전) | 레코드 checksum(`record-canonical-v0`) 대상 |
| manifest | 8개 필수 키 + `checksum_version`·`record_checksum_version` + `record_checksums` + 계산 버전 + `excluded_sectors` + `qa` | `segment_ids`·`array_checksums` 는 적재 시 채움 |
| `bundle_version` | 69 규칙(`pv1-sha256`) | 입력 snapshot id 는 **내용 기반**(FITS sha256 + PROCVER, Archive 행 내용 해시)·세그먼트 자연 키·계산 버전 |
| 잔차 기대값 | 빈/단일/복수/순서 반전/전체 제거의 Silver 기준 잔차 — float64 checksum·표본 8점·통계, 깊이 0 모델의 기대 실패 코드 | astro-kernel, **bin 중심 평가**(113 결정) |

배열 숫자는 float32 값을 유일하게 되살리는 최단 십진 표기다. 파싱한 float64 를 float32 로 반올림하면 같은 비트가 된다(정규화는 멱등).
숫자는 실제 관측에서 나왔지만 이 파일은 **계약 예제**이며 과학 기준값(D23)·운영 출력이 아니다.

## round-trip 이 검사하는 것 (62항목)

**0단계 QA(24)**: `qa.validate_payload` — manifest 키, flux 값 규칙·길이·checksum, **gaps ⇔ NULL 구간 양방향 일치**, **power NULL 금지**·길이·checksum, 격자 규칙, transit_model Schema, removal_step 연속, 레코드 checksum 3종, `bundle_version`, 내용 기반 snapshot id, 잔차 기대값 존재·순서 불변. 하나라도 실패하면 DB 에 넣지 않고 `PUBLISH_REJECTED`.

정합(26)+전환(2)+결정(1): 마이그레이션 적용, `bundle_version` 규칙 일치, transit_model Schema(후보 3), staging 적재(미commit)·검사 뒤 current 전환·current 유일·두 번째 current 거절까지 같은 트랜잭션·그 뒤 단일 commit(`publish_decision` 이 마지막 검사), 기준 시각·`start_btjd` float64 정확 일치,
`base_days`·격자 범위 NUMERIC 왕복, status, manifest JSONB 왕복, flux·power 길이 = n, NULL 위치, float32 값 비트 동일, DB 조회값으로 checksum 재계산 일치,
gaps = DB flux 의 NULL 구간(양방향), DB 조회 배열에 NaN·Inf 없음(NULL 해시값이 NaN 비트와 같아 위장 방지), power NULL 없음, 후보 수·`candidate_id`·파라미터 JSONB 보존, **NUMERIC 열 float64 왕복**(최단 표기 Decimal 로 적재), 후보·외부 상태 레코드 checksum 을 DB 행으로 재계산 일치.
거절: 같은 `(tic_id, bundle_version)` 재삽입(V8), 두 번째 current(부분 유일 인덱스), manifest 키 누락(V3), flux 길이 불일치(V1 CHECK), 주기도 범위 역전.
역할: `planetory_app` 쓰기 거절, `planetory_gold_writer` 쓰기 허용(V2).

검사하지 않는 것: Silver 계산값과의 수치 허용 오차 비교(D23, [등록표](../../contracts/gold/qa-tolerances.v0.json) 값 미등록), 운영 Publisher·Airflow·Backend(Java) 경로.

## 한계

- 별 하나·Sector 하나의 예제다. 다중 세그먼트·다중 판 전환(archived 정리)·손상 Sector 시나리오는 정책이 미결이라 적재 예제를 만들지 않았다.
- 마이그레이션은 Flyway 없이 SQL 파일을 순서대로 실행한다. Flyway 이력 테이블·checksum 검증은 Backend 테스트(`gold.*` 20건)가 맡는다.
- float64 를 float8 로 바인딩해 NUMERIC 열에 넣으면 PostgreSQL 서버의 float8→numeric 변환이 15 유효숫자로 반올림해 `period_days` 등이 왕복에서 깨진다(드라이버 문제 아님). `num()` 이 최단 왕복 표기(`Decimal(repr(x))`)로 바인딩한다. Java 는 `BigDecimal.valueOf(x)`, Spark JDBC 도 double 바인딩을 피해야 한다(공개 QA 3.1절 9항).
- 전처리는 42 잠정값이라 42 확정 뒤 payload 를 재생성한다(값은 바뀌어도 검사 항목은 같다).

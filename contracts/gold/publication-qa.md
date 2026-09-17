# Gold 공개 QA·실패 계약 (v0)

> Jira: `S15P21C206-117` (D09)<br>
> 상태: 검증 항목·배열/레코드 checksum 규칙·허용 오차 등록 절차는 **제안 v0(팀 확정 전)**, 손상 Sector·AI 실패의 공개 정책은 **미결(팀 합의 항목)**. MR !64 1차 리뷰(김동혁) 반영<br>
> 범위: Publisher 가 한 TIC 의 새 판(PublicationBundle)을 PostgreSQL 에 적재해 `current` 로 올리기 전에 검사할 것과, 검사에 실패했을 때의 상태

이 문서는 [Gold 게시 계약](README.md)의 게시·멱등 규칙(69) 위에 **무엇을 검사하고 무엇을 공개하지 않는가**를 얹는다. 과학 규칙(transit_model·격자·잔차 수식)은 [`transit-model.schema.json`](transit-model.schema.json)·[astro-kernel](../../libs/astro-kernel/README.md)이, 운영 Publisher·Worker 구현은 D17/I08/I10 이 맡는다. 검증에 쓴 예제와 스크립트는 [`experiments/gold-roundtrip`](../../experiments/gold-roundtrip/README.md)에 있다.

## 1. 용어

- **새 판 공개**: staging 으로 적재한 Bundle 을 검증 뒤 `current` 로 전환하는 것. 실패하면 새 판은 공개되지 않는다.
- **기존 current 유지**: 새 판 공개가 실패·보류돼도 이미 `current` 인 판은 그대로 서비스된다. 두 개념을 섞지 않는다. 새 판의 실패가 기존 판을 내리지 않는다.
- **공개 차단 단위**: Bundle(TIC 한 판). 후보·세그먼트 단위로 부분 공개하지 않는다.
- 실패 상태는 **69 계약의 결과 코드만** 쓴다(새 코드를 만들지 않는다): `PUBLISH_REJECTED` — 같은 입력으로 다시 시도해도 같은 결과인 실패(검증 실패, 입력 부족, 손상 입력). 게시 트랜잭션은 rollback 되고 재시도하지 않는다. 입력 snapshot 이 바뀌면 새 `bundle_version` 으로 새 게시다. `PUBLISH_ROLLED_BACK` — 일시 장애(DB·네트워크·일시적 AI 실행 실패). 게시 트랜잭션을 남기지 않고 **같은 `bundle_version`** 으로 재시도한다. `IDEMPOTENCY_CONFLICT`·`ALREADY_PUBLISHED`·`BUNDLE_SUPERSEDED` 는 69 그대로.

## 2. 새 판 공개 전 검사 (v0)

모두 통과해야 `current` 전환. 하나라도 실패하면 `PUBLISH_REJECTED` 이고 기존 current 유지.

| 검사 | 규칙 | 근거·검증 |
|---|---|---|
| manifest 필수 키 | 8개 키 존재·자료형 (`segment_ids`, `array_checksums`, `residual_model_version`, `periodogram_config_version`, `binning`, `period_grid`, `fine_tune`, `curve_steps`) | DB CHECK `ck_publication_bundles_manifest_shape`(V3). round-trip 에서 누락 시 거절 확인 |
| manifest 추가 키 | 이 계약이 쓰는 추가 키: `checksum_version`, `record_checksum_version`, `record_checksums`, `input_snapshot_ids`, `calculation_versions`, `excluded_sectors`, `qa`. V3 CHECK 는 추가 키를 허용한다. Backend 읽기 모델은 모르는 키를 무시해야 한다(현재 `GoldManifest` 가 거절 → Backend 140 에서 수정 예정) | 2026-09-17 강재민 확인 |
| 배열 길이 | `cardinality(flux) = n_points`, `cardinality(power) = n_periods`, 1차원 | DB CHECK(V1). 거절 확인 |
| 참조 무결성 | `manifest.segment_ids` 가 실제 `light_curve_segments.id`, 후보 `updated_bundle_id` = 이 판, `periodograms.bundle_id` = 이 판 | FK(V1) + Publisher 검사 |
| 배열 checksum | `manifest.array_checksums` 의 값 = 적재한 배열을 3절 규칙으로 다시 계산한 값. 키는 `segment:<id>:flux`, `periodogram:<bundle_id>:power` | round-trip 에서 DB 조회값으로 재계산 일치 확인 |
| 레코드 checksum | `manifest.record_checksums.{candidates, ai_results, external_statuses}` = 3.2절 규칙으로 계산한 값(DB 생성 id 제외, 정렬). 69 의미 payload 의 `candidates_checksum` 등이 이 값이다 | round-trip 에서 DB 행으로 재계산 일치 확인(후보·외부 상태) |
| 배열 값 규칙 | flux 는 NULL 허용, NaN·±Infinity·float32 overflow 거절. **power 는 NULL 도 거절**(`null_not_allowed`) | 3절 정규화가 거절. QA 테스트 `test_qa.py` 가 `power[0]=NULL` 을 거절함을 확인 |
| gaps 정합 | `gaps` 와 flux 의 NULL 연속 구간 목록이 **양방향으로 완전히 같아야** 한다(선언 누락도, 과다 선언도 거절), `0 ≤ start ≤ end < n_points` | QA + round-trip(DB 조회 flux 로 재계산). `gaps=[]` 손상 payload 가 거절됨을 테스트로 확인. ERD 의 "빈 칸 NaN" 문구는 DB 표현이 NULL 이므로 정정 대상(6절) |
| `transit_model` | 후보마다 계약 1.0 Schema 통과, `candidate_id = c-<candidates.id>` | Schema + astro-kernel 파서. round-trip 확인 |
| 잔차 기대값 존재 | 빈 제거·단일·복수·순서 반전 조합의 Silver 기준 잔차(bin 중심 평가) 가 참조 파일에 있고 순서 반전이 같은 checksum | `gold-roundtrip` fixture `expected_residuals` |
| 기준 시각 | `fold_reference_time_btjd` = DAT-02 품질 필터(QUALITY==0)와 time·flux 유한성을 통과한 원본 관측 시각에서 **중복 시각을 제거한 뒤** 의 중앙값(DAT-11·ERD). detrending·sigma clipping 결과에 의존하지 않는다. float64 그대로 저장·조회 | `fold_reference_time()` 이 `np.unique` 뒤 중앙값. 전처리 설정을 바꿔도 값이 같음, 중복 시각 합성 사례에서 중복 미제거 값과 다름을 테스트로 확인. round-trip 정확 일치 |
| 격자 규칙 | `period_min_days = 0.5`, `period_max_days = max(40, 1.15 × 최장 후보 주기)`, `n_periods = 5000`, log 간격 | 탐사 API 5.3절·113 대조표 |
| 입력 snapshot id (내용 기반 **형식** 검사) | 원천 FITS 는 `lc:spoc:s<4자리 sector>:sha256:<64 hex>:procver:<비어 있지 않음>`, 외부 참조는 `archive:<target>:sha256:<64 hex>`. LC 와 Archive 가 각각 하나 이상 있어야 한다. 파일명·조회 날짜만으로는 원천 내용이 바뀌어도 `bundle_version` 이 유지되므로 금지. 이 검사는 형식만 보며 해시가 실제 원천 내용과 맞는지는 증명하지 않는다(원천을 다시 읽어야 알 수 있다) | QA `input_snapshot_ids_content_based_format`(정규식). fixture 는 tess-fixture `checksums.json` 의 sha256 과 FITS `PROCVER` 사용 |
| NUMERIC 열 정밀도 | float64 값을 NUMERIC 열(`period_days`, `epoch_btjd`, `duration_hours`, `depth_ppm`, `bls_power`, `base_days`, `flux_scatter`)에 넣을 때 **float8 로 바인딩하지 않고 최단 왕복 십진 표기(최대 17 유효숫자)로 바인딩**한다. float8 로 바인딩하면 PostgreSQL 서버의 float8→numeric 변환이 15 유효숫자로 반올림해 왕복이 깨진다(드라이버가 아닌 서버 변환. `1385.1234567890123::float8::numeric = 1385.12345678901`). Python `Decimal(repr(x))`, Java `BigDecimal.valueOf(x)`, Spark JDBC 도 double 바인딩 금지 | round-trip `numeric_columns_float64_roundtrip`. Java 대조(강재민): double 바인딩 1000개 중 915개 변화, BigDecimal 0개. D17 인계. ERD 열 타입 변경 제안은 아님 |
| 멱등·전환 | `(tic_id, bundle_version)` 유일(V8), current 는 TIC 당 하나(부분 유일 인덱스), 전환은 기존 current → archived 를 먼저 | 69 계약. round-trip 에서 두 제약 거절 확인 |
| 역할 | 적재는 `planetory_gold_writer`, 서비스 `planetory_app` 은 읽기만 | V2. round-trip 에서 확인 |

Silver–EC2 **수치 일치**(잔차·주기도 값의 허용 오차 비교)는 이 표에 없다. 허용 오차가 아직 등록되지 않았기 때문이며 4절 절차로 D23 이 채운다.

이 표는 `experiments/gold-roundtrip/gold_roundtrip/qa.py` 의 `validate_payload` 가 그대로 구현하며, round-trip 은 QA 를 먼저 돌려 하나라도 실패하면 **DB 에 넣지 않고** `PUBLISH_REJECTED` 로 끝낸다. 적재 뒤 검사(조회값·checksum·gaps·NUMERIC·레코드 재계산)는 **같은 트랜잭션 안에서** 수행하고, 모두 통과한 뒤에만 기존 current → archived, 신규 → current 전환을 한다. 전환 뒤 검사(current 가 정확히 하나, 두 번째 current 거절)도 같은 트랜잭션에서 하고, 그것까지 통과해야 **한 번 commit** 한다(69: staging 독립 commit 없음). 게시 결과를 정하는 검사가 하나라도 실패하면 전부 rollback 되어 staging·전환 모두 남지 않는다. commit 뒤에는 결과를 바꾸는 검사를 두지 않는다. 손상 payload(`gaps=[]`, `power[0]=NULL`, flux 변조, 후보 값 변조, 내용 기반이 아닌 snapshot id) 가 거절되는 것을 `tests/test_qa.py` 가 확인한다.

## 3. checksum 직렬화 규칙 (제안)

### 3.1 배열 `array-f32le-null7fc00000-v0`

Publisher 가 적재 **전에** 정규화하고, 같은 배열을 checksum 과 DB 적재에 쓴다.

1. NULL 마스크를 먼저 보존한다(빈 bin).
2. 값이 있는 원소는 float64 에서 유한해야 한다. 실제 NaN·±Infinity 는 NULL 로 바꾸지 않고 **거절**(`non_finite_input`).
3. float32 로 반올림(round-to-nearest-even). 반올림 뒤에도 유한해야 한다(`float32_overflow` 거절). subnormal 은 보존하고, float32 최소 subnormal 미만은 0 으로 underflow 하며 오류가 아니다.
4. `-0.0` → `+0.0`.
5. 해시 입력 = 원소당 float32 little-endian 4바이트. NULL 은 **해시 입력에서만** `0x7FC00000`(바이트 `00 00 C0 7F`). DB 에는 SQL NULL 을 저장하고 NaN 을 저장하지 않는다.
6. 결과 `sha256:` + 소문자 hex 64자. manifest 에 `checksum_version` 을 함께 기록한다.
7. DB 왕복: REAL 은 float32 를 정확히 저장한다. 조회는 바이너리 프로토콜 또는 텍스트일 때 `extra_float_digits ≥ 1`(PostgreSQL 12+ 기본)이어야 한다. Backend 는 조회한 REAL 을 float32 로 받아 같은 바이트로 재계산한다. **조회한 배열에 NaN·±Infinity 가 있으면 checksum 을 비교하기 전에 실패**시킨다 — NULL 의 해시값 `0x7FC00000` 이 NaN 비트와 같아서, NULL 자리에 NaN 이 저장돼도 checksum 만으로는 구별되지 않는다(REAL[] 은 NaN 을 받아들인다. DB CHECK 추가는 Backend 후속).
8. 배열 길이·참조·격자·gaps 는 checksum 과 별개로 검사한다(2절). `fold_reference_time_btjd` 는 해시 대상이 아니고 의미 payload 의 float64 정확 비교 대상이다(69).
9. NUMERIC 열의 float64 값은 float8 로 바인딩하지 않고 최단 왕복 십진 표기(17 유효숫자)로 바인딩한다(2절 표. 서버 float8→numeric 변환이 15자리로 반올림). 그래야 DB → float64 → 레코드 checksum 재계산이 Publisher 계산과 같다.

언어 간 대조 벡터: [`examples/array-checksum-vectors.v0.json`](examples/array-checksum-vectors.v0.json) — NULL 위치, ±0, 0.1, float32 반올림 중간값(tie-to-even 양쪽), 최소 subnormal·최소 normal·최대 유한값, underflow, NaN·Infinity·overflow 거절. Python([`canonical.py`](../../experiments/gold-roundtrip/gold_roundtrip/canonical.py))과 Node([`array-checksum.cjs`](array-checksum.cjs))가 같은 hex·SHA-256 을 재현했고, PostgreSQL 18.6 REAL[] 왕복 뒤 재계산도 일치했다. **Java(강재민, 2026-09-17)**: `(float)` 캐스트 + `ByteBuffer` LE + `floatToRawIntBits` 로 벡터 15개·거절 6개(overflow 경계 포함) 전부 일치, `GoldCatalogRepository` 의 REAL[] 조회 경로에서 재계산한 sha256 도 일치. 세 언어와 DB 경로가 맞았으므로 팀 승인만 남았다.

### 3.2 레코드(후보·AI·외부 상태) `record-canonical-v0`

69 의미 payload 의 `candidates_checksum`·`ai_results_checksum`·`external_statuses_checksum` 용이다. 언어별 숫자 텍스트 표기(`1.0` vs `1`, 지수 표기) 차이를 피하기 위해 JSON 이 아니라 **태그 바이트 열**로 직렬화한다.

| 값 | 인코딩 |
|---|---|
| null | `0x00` |
| bool | `0x01` + 1바이트 |
| number | `0x02` + float64 little-endian 8바이트. 유한값만, `-0 → +0`, 정수도 float64 |
| string | `0x03` + u32 LE 바이트 길이 + UTF-8 |
| list | `0x04` + u32 LE 개수 + 원소들 |
| object | `0x05` + u32 LE 개수 + (키 string, 값) 을 키의 UTF-8 바이트 오름차순으로 |

컬렉션 checksum = `sha256:` + SHA-256( 준비된 레코드 목록의 list 인코딩 ). 준비 = **DB 생성 값 제외** → **정렬**:

| 컬렉션 | 제외 필드 | 정렬 키 |
|---|---|---|
| `candidates` | `id`, `updated_bundle_id`, `tic_id`, `transit_model.candidate_id`, (fixture 전용 `local_key`) | `removal_step`, `period_days`, `epoch_btjd` |
| `ai_results` | `id`, `candidate_id`, `execution_id` — 후보는 `candidate_key{period_days, epoch_btjd}` 로 가리킴 | `candidate_key.period_days`, `candidate_key.epoch_btjd`, `model_version` |
| `external_statuses` | `id`, `candidate_id`, `tic_id` — 후보는 `candidate_key` 또는 null | `source`, `external_id` |

**정렬 규칙**: 정렬 키 값은 **숫자·문자열·null 만** 허용한다(bool 은 언어별 분류가 갈려 거절). 키마다 숫자(float64 비교) < 문자열(**UTF-8 바이트 순** — Java 는 `String.compareTo`(UTF-16 순, BMP 밖 문자에서 다름)가 아니라 `Arrays.compareUnsigned` 로 UTF-8 바이트를 비교해야 한다; D17 인계) < null. 정렬 키가 모두 같은 레코드(V1 에 이 키들의 UNIQUE 가 없어 가능)는 **준비된 레코드의 인코딩 바이트를 마지막 비교**로 써 총순서를 만든다. 그래서 Spark 파티션·DB 조회 순서가 달라도 같은 checksum 이 나오고, 같은 입력의 재시도가 `IDEMPOTENCY_CONFLICT` 를 내지 않는다.

빈 컬렉션도 checksum 이 정의된다(fixture 의 `ai_results` 는 118 전이라 비어 있다). 벡터: [`examples/record-checksum-vectors.v0.json`](examples/record-checksum-vectors.v0.json)(빈 목록, 후보 2건, 입력 순서 반전 = 같은 값, DB id 가 달라도 같은 값, **정렬 키 동률 2건·그 입력 반전 = 같은 값**, AI 실패 `score=null`, 외부 상태 UTF-8·null 필드). Python·Node([`record-checksum.cjs`](record-checksum.cjs)) 재현, PostgreSQL 행에서 후보·외부 상태를 다시 읽어 재계산 일치. **Java(강재민)**: 벡터 10개(동률 4 포함) 전부 인코딩·길이·앞 64바이트·sha256 일치. 세 언어와 DB 경로가 맞았으므로 팀 승인만 남았다.

## 4. 허용 오차 사전 등록 절차

[`qa-tolerances.v0.json`](qa-tolerances.v0.json) 이 등록표다. 비교를 실행하기 전에 등록된 값만 쓰고, 값이 `null` 인 항목의 불일치는 실패가 아니라 "미등록" 으로 보고한다. 값을 채우거나 바꾸면 새 version 과 근거·담당·티켓을 적는다. 지금 확정된 것은 저장 정합 항목(기준 시각·start 정확 일치, 배열 float32 비트 동일)뿐이고, Silver–EC2 잔차·주기도·비닝 비교값은 D23(131)·D07-1(114) 이 채운다.

## 5. 공개 정책 — 미결 항목 (v0 기본값: 부분 공개 없음, Bundle 전체 보류)

아래 상황의 최종 정책은 확정하지 않았다. **v0 기본값**은 69 리뷰 의견(2026-09-17 김동혁)을 따른다: 부분 공개는 채택하지 않고, 같은 입력으로 계속 실패하는 경우는 `PUBLISH_REJECTED`, 일시 실패는 `PUBLISH_ROLLED_BACK` 로 같은 `bundle_version` 재시도. 어느 경우에도 기존 current 는 유지된다.

| 상황 | v0 기본값 | 열린 선택지 | 결정 전에 확인할 것 | 담당 |
|---|---|---|---|---|
| 손상 Sector(파일 checksum 불일치·읽기 실패) | 같은 입력 snapshot 으로는 계속 실패 → `PUBLISH_REJECTED`. 원천을 다시 받아 snapshot 이 바뀌면 새 `bundle_version` 으로 새 게시 | Sector 를 제외하고 공개하는 안 | 제외 시 남은 입력만으로 `fold_reference_time_btjd`·`base_days`·후보·주기도·AI 를 **재계산·재검증**해야 하고 manifest 에 `excluded_sectors` 를 기록해야 한다. 남은 유효 관측 하한은 D02-2 | 윤성용·김동혁(I08) |
| 입력 부족(유효 관측점 하한 미달, 세그먼트 0개) | `PUBLISH_REJECTED` | 없음 | 하한 수치는 D02-2/D07-1 | 윤성용 |
| AI 실행 실패(일시적: 타임아웃·프로세스 오류) | 게시 트랜잭션을 남기지 않고 `PUBLISH_ROLLED_BACK`, 같은 `bundle_version` 으로 재시도. `ai_model`·`ai_threshold` 버전을 재시도 때문에 올리지 않는다 | 없음(v0) | 재시도 횟수·간격은 Airflow 쪽(89/90 계열) | 김동혁 |
| AI 실패가 반복되거나 후보 일부만 실패 | `PUBLISH_REJECTED`(commit 없음, Bundle 전체 비공개). 실패한 후보만 `ai_evaluations.score = NULL` + `ai_executions.status` 실패값으로 남기고 나머지만 공개하는 **부분 공개는 v0 에서 채택하지 않음**. 아무것도 commit 되지 않았으므로 재추론이 성공하면 **같은 `bundle_version` 으로 처음 게시**되어 69 계약을 바꿀 필요가 없다 | 부분 공개 | 부분 공개 뒤 재추론 성공을 새 판으로 게시하면 입력·계산 버전이 같아 `bundle_version` 이 같은 값이 되어 69 멱등 계약(`ALREADY_PUBLISHED`)과 충돌한다. 실패 표식을 의미 payload 에 넣을지 등은 69 담당과 합의. SRS AI-01~04 의 P0 전체 후보 추론 요건 확인 | 윤성용·김동혁(69)·강재민 |
| 후보 0개(무신호) | 공개하되 서비스 제외 상태 전달 | — | DEC-01 | 기존 결정 |
| Silver–EC2 잔차 불일치(허용 오차 등록 뒤) | `PUBLISH_REJECTED` | — | 4절 값 등록 전에는 판정 안 함 | D23 |

## 6. 정합화가 필요한 기존 문서

- ERD `light_curve_segments.gaps` 설명의 "빈 칸은 NaN 으로 채운다" 는 DB 표현이 REAL[] **NULL** 이므로 "NULL" 로 정정 요청(ERD 소유자). Gold 계약 4절·이 문서는 NULL 이다.
- ERD `ai_executions.status` 값 목록이 문서에 없다. 5절의 일시 실패/반복 실패 구분을 값으로 적을 때 함께 정한다.
- DB CHECK(flux NaN·±Inf 거절, power NULL·NaN·±Inf 거절)는 Backend 140 브랜치에 V9 로 추가됨(강재민, MR 전). 병합되면 2절 표의 근거를 V9 로 갱신한다.
- NUMERIC 열의 float64 적재 표기(2절·3.1절 9항)는 Publisher 구현 규칙으로 D17 에 인계한다. 열 타입을 DOUBLE PRECISION 으로 바꾸는 안은 이 문서가 제안하지 않는다(ERD 소유자 판단).
- 게시 재시도 예제(`publication-load-scenarios.json`)의 `array_checksums` 는 아직 합성 문자열이다. 3절 규칙이 확정되면 실제 값으로 바꾼다.

## 7. 검증 상태 (2026-09-17, 1차 리뷰 반영 후)

- 실행함: `experiments/gold-roundtrip` — TOI-270 Sector 3 실제 곡선 payload 를 PostgreSQL 18.6 컨테이너의 격리 스키마에 V1~V8 적용 후 QA(2절) → 적재(미commit) → 같은 트랜잭션에서 조회·검사 → 통과 시 전환 → 전환 뒤 검사(current 유일·두 번째 current 거절)까지 같은 트랜잭션 → 단일 commit, **62개 검사 통과**(QA 24, 정합 26, 제약 위반 거절 5, 역할 경계 2, 레코드 checksum DB 재계산 2, 전환·current 유일 2, 게시 결정 1). 게시 결과를 정하는 검사는 모두 commit 전에 끝난다(테스트로 고정). 손상 payload(`gaps=[]`, `power[0]=NULL`)는 QA 단계에서 `PUBLISH_REJECTED` 로 거절되어 DB 에 들어가지 않음을 테스트로 확인. Python·Node 배열 벡터 15+6, 레코드 벡터 10(동률 4 포함) 일치. **Java(강재민, 2026-09-17)**: 배열 벡터 15+6(overflow 경계 포함)·레코드 벡터 6·`GoldCatalogRepository` REAL[] 경로·140 수정본 `GoldManifest` 로 15키 manifest 읽기 일치. 기준 시각이 전처리 설정과 무관하고 중복 시각을 제거함을 테스트로 확인. pytest 21 passed.
- 실행하지 않음: 운영 Publisher(Spark)·Airflow, 실제 Silver 계산과의 수치 비교(D23), 손상 Sector·AI 실패 시나리오의 실제 적재(5절 정책 미결). Java 는 배열 15+6·레코드 10(동률 4 포함)·DB 경로·15키 manifest 모두 대조 완료(강재민).

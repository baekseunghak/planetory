# gold-roundtrip: Gold 적재 예제·PostgreSQL round-trip·공개 QA fixture

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

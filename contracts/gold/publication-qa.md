# Gold 공개 QA·실패 계약 (v0)

> Jira: `S15P21C206-117` (D09)<br>
> 상태: 검증 항목·배열 checksum 규칙·허용 오차 등록 절차는 **제안 v0(팀 확정 전)**, 손상 Sector·AI 실패의 공개 정책은 **미결(팀 합의 항목)**<br>
> 범위: Publisher 가 한 TIC 의 새 판(PublicationBundle)을 PostgreSQL 에 적재해 `current` 로 올리기 전에 검사할 것과, 검사에 실패했을 때의 상태

이 문서는 [Gold 게시 계약](README.md)의 게시·멱등 규칙(69) 위에 **무엇을 검사하고 무엇을 공개하지 않는가**를 얹는다. 과학 규칙(transit_model·격자·잔차 수식)은 [`transit-model.schema.json`](transit-model.schema.json)·[astro-kernel](../../libs/astro-kernel/README.md)이, 운영 Publisher·Worker 구현은 D17/I08/I10 이 맡는다. 검증에 쓴 예제와 스크립트는 [`experiments/gold-roundtrip`](../../experiments/gold-roundtrip/README.md)에 있다.

## 1. 용어

- **새 판 공개**: staging 으로 적재한 Bundle 을 검증 뒤 `current` 로 전환하는 것. 실패하면 새 판은 공개되지 않는다.
- **기존 current 유지**: 새 판 공개가 실패·보류돼도 이미 `current` 인 판은 그대로 서비스된다. 두 개념을 섞지 않는다. 새 판의 실패가 기존 판을 내리지 않는다.
- **공개 차단 단위**: Bundle(TIC 한 판). 후보·세그먼트 단위로 부분 공개하지 않는다.
- 실패 상태(69 계약과 같은 어휘): `PUBLISH_REJECTED`(검증 실패, 같은 입력으로 재시도해도 같으므로 재시도 안 함), `PUBLISH_HELD`(입력 조건 미달·부분 실패로 보류, 다음 입력 snapshot 또는 재계산 뒤 새 `bundle_version` 으로 다시 시도), `PUBLISH_ROLLED_BACK`(일시 장애, 같은 키 재시도).

## 2. 새 판 공개 전 검사 (v0)

모두 통과해야 `current` 전환. 하나라도 실패하면 `PUBLISH_REJECTED` 이고 기존 current 유지.

| 검사 | 규칙 | 근거·검증 |
|---|---|---|
| manifest 필수 키 | 8개 키 존재·자료형 (`segment_ids`, `array_checksums`, `residual_model_version`, `periodogram_config_version`, `binning`, `period_grid`, `fine_tune`, `curve_steps`) | DB CHECK `ck_publication_bundles_manifest_shape`(V3). round-trip 에서 누락 시 거절 확인 |
| 배열 길이 | `cardinality(flux) = n_points`, `cardinality(power) = n_periods`, 1차원 | DB CHECK(V1). 거절 확인 |
| 참조 무결성 | `manifest.segment_ids` 가 실제 `light_curve_segments.id`, 후보 `updated_bundle_id` = 이 판, `periodograms.bundle_id` = 이 판 | FK(V1) + Publisher 검사 |
| 배열 checksum | `manifest.array_checksums` 의 값 = 적재한 배열을 3절 규칙으로 다시 계산한 값. 키는 `segment:<id>:flux`, `periodogram:<bundle_id>:power` | round-trip 에서 DB 조회값으로 재계산 일치 확인 |
| 배열 값 규칙 | flux·power 에 NaN·±Infinity 없음(NULL 만 허용, power 는 NULL 도 없음), float32 범위 안 | 3절 정규화가 거절 |
| gaps 정합 | `gaps` 의 각 `[start, end]` 구간이 flux NULL 과 일치, `0 ≤ start ≤ end < n_points` | round-trip 확인. ERD 의 "빈 칸 NaN" 문구는 DB 표현이 NULL 이므로 정정 대상(6절) |
| `transit_model` | 후보마다 계약 1.0 Schema 통과, `candidate_id = c-<candidates.id>` | Schema + astro-kernel 파서. round-trip 확인 |
| 잔차 기대값 존재 | 빈 제거·단일·복수·순서 반전 조합의 Silver 기준 잔차(bin 중심 평가) 가 참조 파일에 있고 순서 반전이 같은 checksum | `gold-roundtrip` fixture `expected_residuals` |
| 기준 시각 | `fold_reference_time_btjd` 가 유효 원본 관측 시각 중앙값(DAT-11), float64 그대로 저장·조회 | round-trip 정확 일치 확인 |
| 격자 규칙 | `period_min_days = 0.5`, `period_max_days = max(40, 1.15 × 최장 후보 주기)`, `n_periods = 5000`, log 간격 | 탐사 API 5.3절·113 대조표 |
| 멱등·전환 | `(tic_id, bundle_version)` 유일(V8), current 는 TIC 당 하나(부분 유일 인덱스), 전환은 기존 current → archived 를 먼저 | 69 계약. round-trip 에서 두 제약 거절 확인 |
| 역할 | 적재는 `planetory_gold_writer`, 서비스 `planetory_app` 은 읽기만 | V2. round-trip 에서 확인 |

Silver–EC2 **수치 일치**(잔차·주기도 값의 허용 오차 비교)는 이 표에 없다. 허용 오차가 아직 등록되지 않았기 때문이며 4절 절차로 D23 이 채운다.

## 3. 배열 checksum 직렬화 규칙 `array-f32le-null7fc00000-v0` (제안)

Publisher 가 적재 **전에** 정규화하고, 같은 배열을 checksum 과 DB 적재에 쓴다.

1. NULL 마스크를 먼저 보존한다(빈 bin).
2. 값이 있는 원소는 float64 에서 유한해야 한다. 실제 NaN·±Infinity 는 NULL 로 바꾸지 않고 **거절**(`non_finite_input`).
3. float32 로 반올림(round-to-nearest-even). 반올림 뒤에도 유한해야 한다(`float32_overflow` 거절). subnormal 은 보존하고, float32 최소 subnormal 미만은 0 으로 underflow 하며 오류가 아니다.
4. `-0.0` → `+0.0`.
5. 해시 입력 = 원소당 float32 little-endian 4바이트. NULL 은 **해시 입력에서만** `0x7FC00000`(바이트 `00 00 C0 7F`). DB 에는 SQL NULL 을 저장하고 NaN 을 저장하지 않는다.
6. 결과 `sha256:` + 소문자 hex 64자. manifest 에 `checksum_version` 을 함께 기록한다.
7. DB 왕복: REAL 은 float32 를 정확히 저장한다. 조회는 바이너리 프로토콜 또는 텍스트일 때 `extra_float_digits ≥ 1`(PostgreSQL 12+ 기본)이어야 한다. Backend 는 조회한 REAL 을 float32 로 받아 같은 바이트로 재계산한다.
8. 배열 길이·참조·격자·gaps 는 checksum 과 별개로 검사한다(2절). `fold_reference_time_btjd` 는 해시 대상이 아니고 의미 payload 의 float64 정확 비교 대상이다(69).

언어 간 대조 벡터: [`examples/array-checksum-vectors.v0.json`](examples/array-checksum-vectors.v0.json) — NULL 위치, ±0, 0.1, float32 반올림 중간값(tie-to-even 양쪽), 최소 subnormal·최소 normal·최대 유한값, underflow, NaN·Infinity·overflow 거절. Python([`canonical.py`](../../experiments/gold-roundtrip/gold_roundtrip/canonical.py))과 Node([`array-checksum.cjs`](array-checksum.cjs))가 같은 hex·SHA-256 을 재현했고, PostgreSQL 18.6 REAL[] 왕복 뒤 재계산도 일치했다. **Java 경로는 이 저장소에서 실행하지 않았다.** Backend 구현(C04-1)이 같은 벡터로 대조한 뒤 이 규칙을 확정한다.

## 4. 허용 오차 사전 등록 절차

[`qa-tolerances.v0.json`](qa-tolerances.v0.json) 이 등록표다. 비교를 실행하기 전에 등록된 값만 쓰고, 값이 `null` 인 항목의 불일치는 실패가 아니라 "미등록" 으로 보고한다. 값을 채우거나 바꾸면 새 version 과 근거·담당·티켓을 적는다. 지금 확정된 것은 저장 정합 항목(기준 시각·start 정확 일치, 배열 float32 비트 동일)뿐이고, Silver–EC2 잔차·주기도·비닝 비교값은 D23(131)·D07-1(114) 이 채운다.

## 5. 공개 정책 — 미결 항목 (팀 합의 전에는 보류가 기본)

아래 상황의 "새 판 공개 여부" 는 확정하지 않았다. 합의 전 운영 기본값은 **새 판 보류(`PUBLISH_HELD`) + 기존 current 유지** 다. 부분 공개를 기본값으로 확정하지 않는다.

| 상황 | 선택지 | 결정 전에 확인할 것 | 담당 |
|---|---|---|---|
| 손상 Sector(파일 checksum 불일치·읽기 실패) | (A) TIC 전체 보류 (B) 그 Sector 세그먼트만 제외하고 공개 | (B) 는 남은 입력만으로 `fold_reference_time_btjd`·`base_days`·후보·주기도·AI 를 **재계산·재검증**해야 하고, 입력 snapshot 이 달라져 새 `bundle_version` 이 된다. manifest 에 `excluded_sectors` 기록. 남은 유효 관측이 하한(미정, D02-2) 미달이면 (A) | 윤성용·김동혁(I08) |
| 입력 부족(유효 관측점 하한 미달, 세그먼트 0개) | 보류 | 하한 수치는 D02-2/D07-1 | 윤성용 |
| AI 추론 실패 후보 있음 | (A) Bundle 보류 (B) 후보 `ai_evaluations.score = NULL` + `ai_executions.status` 에 실패 상태를 남기고 공개 | (B) 뒤 재추론 성공을 새 판으로 게시하면 입력·계산 버전이 같아 `bundle_version` 이 같은 값이 되어 69 멱등 계약(`ALREADY_PUBLISHED`)과 충돌한다. `ai_model`/`ai_threshold` 계산 버전을 올릴지, 실패 표식을 의미 payload 에 넣을지 69 담당과 먼저 합의. SRS AI-01~04 의 P0 전체 후보 추론 요건도 확인 | 윤성용·김동혁(69)·강재민 |
| 후보 0개(무신호) | 공개하되 서비스 제외 상태 전달 | DEC-01 | 기존 결정 |
| Silver–EC2 잔차 불일치(허용 오차 등록 뒤) | `PUBLISH_REJECTED` | 4절 값 등록 전에는 판정 안 함 | D23 |

## 6. 정합화가 필요한 기존 문서

- ERD `light_curve_segments.gaps` 설명의 "빈 칸은 NaN 으로 채운다" 는 DB 표현이 REAL[] **NULL** 이므로 "NULL" 로 정정 요청(ERD 소유자). Gold 계약 4절·이 문서는 NULL 이다.
- ERD `ai_executions.status` 값 목록이 문서에 없다. AI 실패 표현(5절)을 정하면 함께 적는다.
- 게시 재시도 예제(`publication-load-scenarios.json`)의 `array_checksums` 는 아직 합성 문자열이다. 3절 규칙이 확정되면 실제 값으로 바꾼다.

## 7. 검증 상태 (2026-09-17)

- 실행함: `experiments/gold-roundtrip` — TOI-270 Sector 3 실제 곡선으로 만든 payload 를 PostgreSQL 18.6 컨테이너의 격리 스키마에 V1~V8 적용 후 적재·조회, 30개 검사 통과(정합 검사 + 제약 위반 거절 5건 + 역할 경계 2건). Python·Node checksum 벡터 일치.
- 실행하지 않음: Java(Backend) checksum 경로, 운영 Publisher(Spark)·Airflow, 실제 Silver 계산과의 수치 비교(D23), 손상 Sector·AI 실패 시나리오의 실제 적재(5절이 미결이라 fixture 로만 남김).

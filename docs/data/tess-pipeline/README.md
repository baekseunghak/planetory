# S15P21C206-29 천문 데이터 처리·AI 기획 초안

작성일: 2026-09-06 / 최신 명세 대조: 2026-09-10 (v1.0) / 담당: 윤성용 / 상태: Draft MR 리뷰 중

초안 기준 커밋: `8c9d93db737eab373758541c3b64998dcb4a8dce`, 보완 커밋: `41173768d8fb9b14a0ce3c7a2e201bdf8967cd4d`, v1.0 반영: `develop@132cdc77` 병합 이후

이 문서는 기존 PoC의 구현 사실과 서비스 요구사항의 차이를 정리한다. 제안한 스키마·작업 분할·검증 기준은 팀 승인 전이다. 2026-09-07 Jira 29번의 실제 설명·완료 조건·댓글·첨부 없음과 대조했으며 상세 결과는 [리뷰 체크리스트](../../project/tess-pipeline-review-checklist.md)에 기록했다. 담당 범위와 앞으로의 실행 순서는 [윤성용 천문 데이터 처리·AI 역할 명세](../../project/tess-processing-ai-role-spec.md)에서 한눈에 볼 수 있다. 문서 작성만으로 29번이 완료되는 것은 아니다.

기준: `develop` 커밋 `132cdc77`의 [요구사항 명세서 v1.0](../../requirements/planetory-requirements-spec.md), [서비스 DB ERD v1.0](../../architecture/database-erd.md), [역할 분배](../../project/team-role-allocation.md), 상태표·용어 사전·와이어프레임 v1.0, [데이터 규칙](../data-guidelines.md), [Spark 규칙](../spark-hadoop-guidelines.md). 서로 다르면 요구사항 명세서 v1.0을 현재 작업 기준으로 사용한다. v1.0은 "구조와 규칙은 확정, 임계값·대상 데이터 등 수치는 DEC 항목에서 실측 후 채운다"는 기준선이므로 TBD 수치는 팀 승인 전 확정으로 취급하지 않는다.

> **기준 변경 기록:** 2026-09-07에는 배치 자동 반복 제거를 하지 않는다는 구두 전달을 기준으로 초안을 보완했다. 2026-09-09부터 팀이 갱신한 요구사항 명세서 v0.12를 기준으로 전환했다. 따라서 현행 기획은 DAT-05~07의 **Silver 내부 반복 BLS**와 DAT-14의 **사용자 선택 EC2 온라인 잔차 계산**을 서로 다른 목적으로 모두 적용한다. 이전 단일 패스안은 현행 기준이 아니다.
>
> **v1.0 반영 (2026-09-10):** 명세서 v0.13~v1.0과 ERD v1.0이 develop에 병합되어 다음이 확정됐다. Gold 본문은 EC2 파일이 아니라 **PostgreSQL 배열**이다. 원본 정제곡선은 **별·섹터 세그먼트, 섹터 안 10분 고정 비닝, 밝기 오차는 세그먼트당 산포 스칼라**로 저장하고 품질 마스크·시각 배열·주기 격자 배열은 저장하지 않는다. transit model은 파일 참조가 아니라 candidates의 **`transit_model` JSONB 파라미터**다. `discoverable`은 **사용자 제공 조건(비닝 간격·모델·격자)** 으로 계산한 발견 단계 잔차 주기도에서 판정한다(DAT-07). 분석 세션의 Bundle 고정은 폐기되어 새 판이 `current`가 되면 진행 중 세션을 최신 판으로 올리고 이전 판은 `archived`가 된다. 잔차·주기도 캐시는 **Redis**다. Bundle manifest에 주기 격자 간격·미세 조정 허용 폭 규칙을 넣는다(EXP-05). DEC-01에 무신호 별 비율 실측이 추가됐다. 이 문서에서 v0.12 표현이 남은 부분은 이력 설명이며, 확정 규칙은 v1.0을 따른다.

## 상세 문서 라우팅

| 확인할 내용 | 문서 |
| --- | --- |
| 원천 FITS 구조, 품질 필터, 정규화, 구간 분리와 디트렌딩 | [원천 데이터와 전처리](preprocessing.md) |
| BLS 탐색 공간, 평가 데이터와 벤치마크 | [후보 검출](candidate-detection.md) |
| 외부 카탈로그 연동과 AI 입력·추론 제안 | [외부 원천과 AI](external-sources-and-ai.md) |
| 재현 결과, 검증 계획, Silver·Gold 계약과 후속 작업 | [검증과 재처리](validation-and-reprocessing.md) |

## 1. 담당 역할과 목표

기존 실험을 처음부터 다시 만드는 것이 아니라, 재사용 가능한 계산 커널을 검증하고 자동 후보 처리와 서비스 산출물로 확장한다.

- 윤성용: 전처리, 세그먼트 분할·비닝 규칙, 원본·Silver 내부 반복 BLS, 후보 검증·병합, `transit_model` 파라미터 스키마, 제공 해상도 기준 `discoverable` 판정, 사용자 주기도 격자·미세 조정 허용 폭 규칙, 외부 참조, AI 입력·추론, Gold 과학 계약과 Silver–EC2 계산 일치 기준.
- 김동혁: 수집·저장·Spark/Airflow 실행 환경, 공개 묶음 전달·전환·복구, 온라인 계산 인프라.
- 강재민: 후보 조회·사용자 제출 매칭·성과 API, 온라인 잔차 요청·캐시·상태. 윤성용은 계산 의미와 검증 자료 제공.
- 백지웅: 분석 그래프와 상호작용. 데이터 전달은 백엔드 API를 거치며 축·단위·축약 조건은 함께 합의.

29번 산출물은 설계·계약·검증 계획·후속 작업안이다. 실제 전체 구현은 후속 Task에서 수행한다. 신규 LLM 근거 설명·행성 소개는 이번 기획의 필수 구현 범위로 추가하지 않는다. 기존 AI-01~04는 P0이며 제외하지 않는다. AI 재평가(AI-05)는 P1, 통계 집계(DAT-13)는 서비스 담당과의 협업 범위다.

## 2. 기존 코드에서 확인한 사실

분석 범위는 `experiments/tess-bls`와 위 기준 문서다. 아래의 '없음'은 해당 PoC에서 확인되지 않았다는 뜻이며 다른 팀원의 미병합 작업까지 부재하다는 뜻이 아니다.

| 위치 | 현재 구현 | 재사용·보완 판단 |
|---|---|---|
| [download_toi270.py](../../../experiments/tess-bls/download_toi270.py) `PRODUCTS`, `download_product` | 고정 MAST URL 3개, 크기·FITS 블록·TIC·Sector 검증, 임시 파일 후 교체, 재시도, 정상 캐시 재사용 | 소규모 재현에 재사용. 일반 대상 목록·원천 스냅샷·checksum manifest·분산 수집은 별도 |
| [semi_auto_bls.py](../../../experiments/tess-bls/semi_auto_bls.py) `load_tess_light_curves` | TIME·PDCSAP_FLUX·QUALITY 로드, 동일 TIC·Sector 중복 검사, DataFrame 구성 | FITS 어댑터를 UI 밖으로 분리. 시간계·단위·제품·cadence 메타데이터 보존 필요 |
| [pipeline.py](../../../experiments/tess-bls/pipeline.py) `clean` | quality=0, 결측 제거, Sector별 중앙값 정규화, 시간 공백별 Savitzky–Golay, 상방 clipping | 기본 커널 재사용. 추가 마스크와 행별 제외 사유·원본 인덱스 필요 |
| `bls_periodogram` | 모든 격자의 power·P·t0·duration·depth 생성 | 원본 주기도 및 자동 후보 추출의 기반 |
| `bls_period_candidates` | 최대 10개 대표 피크, 인접 주파수 병합, P1/P2 순위 ID, 조화 주기는 유지 | 사람의 선택 보조. 영구 Candidate ID·고조파 별칭 병합으로 사용할 수 없음 |
| `bls_features` / `analyze_target` | 최강 후보 1개, SNR·odd/even 차이·secondary depth·관측 통과 수 등 | 특징 계산 재사용 검토. 여러 원본 피크의 자동 후보화·AI 모델 추론은 아님 |
| `geometry_from_phase_interval`, `candidate_from_geometry` | 사람이 선택한 P·구간을 t0·duration·depth로 환산 | 사용자 입력 검증 참고. 자동 배치의 승인 판단을 대신하지 않음 |
| `joint_refit_candidates` | P·t0·duration 고정, 원본에서 모든 depth·baseline 공동 적합 | 주기나 지속시간까지 자동 개선하는 기능으로 설명하면 안 됨 |
| `residual_after_candidates` | 원본 flux / (baseline × 후보 상자 모델들의 곱), 입력 관측점 보존 | 온라인 잔차 커널 후보. 모델·baseline·정렬·수치 규약 합의 필요 |
| `fit_box_near_period` | 주기 주변 국소 BLS 함수 | 정의는 있으나 현재 UI 호출 경로에서 사용되지 않음. 자동 정밀화에 쓰려면 검증 필요 |
| UI 상태·JSON 다운로드 | session_state에 후보 저장, TIC·Sector·baseline·candidates JSON 내보내기 | 출력이 전혀 없는 것은 아님. 다만 버전·마스크·출처·AI·공개 manifest가 없는 실험 출력 |

### 주의 깊게 보완할 부분

1. `clean`은 Sector별 정규화 후 전체를 합쳐 시간 간격 0.5일 초과로 구간을 나눈다. 따라서 Sector 경계 자체를 항상 detrending 경계로 보장하지 않는다. Sector 안에서 연속 구간을 나눈 후 결합하도록 검토한다.
2. `clean`의 `dropna`는 무한대를 제외하지 않는다. 중복 시각, cadence가 0인 경우, 0 이하 trend 등도 명시적인 입력·결과 검증이 필요하다. 실제 샘플에서 오류가 발생했다는 의미는 아니다.
3. 품질 필터와 clipping 이후 배열만 반환하므로 제외 행의 마스크·이유를 결과에서 복원할 수 없다. v1.0에서 품질 마스크는 배치 전처리에서만 소비하고 Gold·화면에 전달하지 않으므로(POL-13), Silver 진단용 제외 사유 보존과 Gold 세그먼트의 빈 bin(NaN)·`gaps` 표현을 분리해 설계한다.
4. 기본 탐색 설정이 두 경로에서 다르다. `bls_features`: 20,000개 격자, 최대 min(baseline/3,100일), 지속시간 4개. `bls_periodogram`: 8,000개 격자, 최대 min(baseline/2.5,30일), 0.5~8시간 12개. 공통 설정과 버전으로 통합할지 결정한다.
5. `_joint_depth_fit`은 baseline 0.97~1.03, depth 0~0.25 범위와 최대 100회 평가를 사용한다. 최적화 성공 여부를 호출자에게 전달하지 않는다. 깊은 식쌍성과 부적절한 사용자 선택의 실패 처리 검증이 필요하다.
6. 겹친 관측점 보존은 합성 상자 모델 테스트로 검증되어 있다. 실제 transit 모양에서 경계 돌출·다른 후보 훼손·자동 탐색 정확성까지 보장하지 않는다.
7. `fold_for_service`의 '프론트에는 이것뿐'이라는 주석은 v1.0의 비닝된 전 구간 세그먼트 제공 요구(EXP-01·DAT-11)를 대신할 수 없다. Silver 2분 원본(탐색·AI 입력용), Gold 10분 비닝 세그먼트(사용자 분석·온라인 잔차용), 화면 축약값을 서로 다른 산출물로 분리한다.

## 3. 요구사항 대비 차이

| 요구사항 | 현 상태 | 후속 작업과 검수 |
|---|---|---|
| DAT-01 원천 | 고정 예제 다운로드 일부 구현 | 입력 manifest에 실제 사용한 URL·조회 시각·제품·해시 기록, 손상·중복 복구 검증 |
| DAT-02 전처리 | 기본 처리 있음 | Sector 경계·추가 마스크·예상 최대 duration 대비 평활 창 검증, 행별 사유 보존 |
| DAT-03 화면 자산 | 곡선·주기도 계산 가능 | 단위·공백·버전·화면 축약 출력 계약 및 파일화 |
| DAT-04 BLS | 격자와 일부 특징 있음 | 후보별 SDE 정의, SNR·관측 통과 수·Sector 일관성·마스크 편중 평가 통합 |
| DAT-05~07 내부 반복 BLS | PoC는 사람 승인 뒤 잔차 BLS 반복 가능 | 원본 BLS 후보를 모델링·제거하고 Silver 내부 잔차에서 후속 BLS를 반복하도록 자동화. 제거 QA, 종료 사유, 원본 재검증 필요. `discoverable`은 2분 원본이 아니라 사용자 제공 비닝·격자 조건으로 재계산한 발견 단계 잔차 주기도에서 판정(DAT-07 v1.0) |
| 온라인 잔차 모델 검증 | 합성 모델 테스트, UI 마지막 후보 취소 | 후보 모델 적용 후 관측점 보존·겹친 신호·경계 왜곡·순서 독립성을 Silver–EC2 일치 검증에서 확인 |
| 원본 재검증 | 원본에서 깊이 공동 적합 | 후보 승인용 원본 재검증과 원본 주기도의 discoverable 판단·근거 별도 구현 |
| DAT-08 병합 | 피크 인접 병합만 있음 | 고유 후보 ID, 주기·위상·지속시간·실제 구간 기반 별칭·중복 관리 |
| DAT-09 외부 상태 | 참고 주기 상수만 있음 | 후보별 원천 연결, 상태·조회일 보존, 자체 대표값·AI와 분리 |
| DAT-10 후보표 | 수동 승인 후보 JSON | 후보·단계·품질·원본 검증·외부 참조·AI 연결. transit model은 파일 참조가 아닌 `transit_model` JSONB 파라미터로 후보표에 인라인(v0.14) |
| DAT-11~12 공개·복구 | 공식 공개 묶음 없음 | 별·섹터 세그먼트(10분 비닝, `binning_revision`), 판별 주기도, 후보표, manifest(세그먼트 id 집합·checksum·계산 버전·격자 규칙)를 EC2 PostgreSQL 배열로 적재하는 계약. 적재 경로(배치 INSERT vs API)·검증·멱등 재처리·기존 `current` 유지는 김동혁·강재민과 연동 |
| DAT-14 온라인 잔차 | 로컬 계산 커널 있음 | 비닝 세그먼트와 `transit_model` 파라미터로 EC2가 잔차·주기도 계산, Redis 캐시, 현재 판 기준. 같은 입력의 Silver–EC2 수치 일치 검증 |
| DAT-15 갱신 | PoC 범위에 없음 | 번들 간 후보 추가·discoverable 변경·외부 상태 변경 차이 산출, 백엔드 이벤트 연동 |
| AI-01~04 | 모델 추론 없음 | 모델 적합성 실험, 입력 생성, 추론·실패 상태·버전, 검증 세트와 임계값 |
| AI-05 (P1) | 없음 | 재평가 결과 이력 보존, 후속 우선순위 |

사용자 화면에서 직접 주기를 찾는 흐름은 유지한다. 자동 배치는 매칭 기준 후보와 모델을 준비하는 것이며, 사용자에게 배치 정답을 미리 보여주는 기능이 아니다.

## 4. 목표 처리 흐름과 실패 경계 제안

```text
고정 입력 manifest (TIC·Sector·제품·버전)
  → FITS 검증 / Bronze 변환
  → Sector별 품질 마스크·정규화·연속 구간 detrending
  → TIC별 정제곡선 결합
  → 원본 주기도 / 최강 피크 품질 평가 / transit model
  → 품질 통과 모델 제거 / Silver 내부 잔차 BLS 반복 / 제거 QA·종료 사유
  → 각 단계 후보의 원본 재검증 / 후보·고조파·별칭 병합 / 판 사이 후보 동일성
  → 별·섹터 세그먼트 분할 / 10분 비닝 (binning_revision)
  → 제공 해상도·격자로 재계산한 발견 단계 잔차 주기도에서 discoverable 판정
  → 외부 참조·상태 연결 / AI 입력·배치 추론
  → 후보표(transit_model 파라미터)·세그먼트·판별 주기도·fold 기준 시각·manifest 검증
  → PublicationBundle → EC2 PostgreSQL 배열 적재 → staging → current (이전 판 archived)

사용자 후보 매칭 후 별도 온라인 경로:
current 판의 비닝 세그먼트 + 사용자가 제거한 후보의 transit_model 파라미터 집합
  → QUEUED → RESIDUAL_CALCULATING → RESIDUAL_READY
  → PERIODOGRAM_CALCULATING → COMPLETED/FAILED → 화면 제공·Redis cache
```

- 재처리 단위 제안: 원천 검증·전처리는 TIC/Sector/제품, 후보 탐색 이후는 TIC/입력 스냅샷/계산 버전. 경로와 실행 인자는 동혁님과 합의한다.
- 입력 손상은 해당 입력 실패로 기록한다. 불완전한 Sector로 진행할지 TIC 전체를 보류할지는 결정 필요.
- 유효 관측점 부족은 처리 실패·탐색 불가 사유로 기록한다. 단순히 '행성 후보 0개'와 합치지 않는다.
- 정상 처리 후 후보표가 빈 무신호 결과는 실패와 구분해 기록하되, v1.0의 탐색 완료 정책에 따라 공개·발견·튜토리얼 대상에서는 제외할 수 있도록 서비스에 명시적인 상태를 전달한다. 무신호 별의 비율은 DEC-01 실측 항목이며 비율이 높으면 DEC-03의 BLS 채택 임계값을 함께 조정한다.
- transit model이 유효하지 않거나 EC2 잔차 일치 검증에 실패하면 해당 bundle을 공개하지 않는다.
- AI 실패는 점수 0이 아니라 실패 상태로 남긴다. P0 전체 후보 추론 요건을 충족하지 못한 번들의 공개 처리는 팀 합의가 필요하다.
- 동일 입력·설정의 재실행은 중복 후보와 이벤트를 만들지 않게 한다. 새 번들의 공개 실패 시 기존 공개본을 유지한다.
- 배치 잔차·주기도는 후보 탐색과 제거 QA를 위해 Silver 내부에서 계산한다. 사용자 제공용 단계별 잔차·주기도는 Gold에 넣지 않고 EC2가 현재 판의 비닝 세그먼트와 제거 조합의 `transit_model` 파라미터로 요청 시 다시 계산한다. 세션을 특정 판에 고정하지 않으며, 새 판이 공개되면 진행 중 회원에게 알리고 최신 판으로 다시 불러온다(EXP-01).
- Silver의 단계별 잔차곡선·주기도 배열은 반복 계산 중에만 사용하고 지속 저장하지 않는다. 제거 QA·종료 근거는 후보·모델·설정 버전에 연결한 요약 지표와 사유로 남긴다.
- 사용자는 현재 곡선의 전체 유효 관측점을 브라우저에서 선택 주기로 접고, 접힌 곡선에서만 `phase_start`·`phase_end`를 정한다. `epoch`와 `duration`은 `fold_reference_time_btjd`를 기준으로 브라우저가 미리보기하고 서버가 같은 공식으로 다시 계산한다. 시간 영역 곡선 선택, epoch·duration 숫자 직접 입력, `selection_space`는 사용하지 않는다.

## 5. 입출력 계약 초안

아래는 합의할 최소 필드안이다. 실제 파일 형식·파티션·최종 이름·enum은 미확정이며 기존 서버 스키마와 대조해야 한다. 타입의 `?`는 nullable 제안이다.

| 산출물 | 필드·타입·의미 (예시) | 소비자 |
|---|---|---|
| 입력 manifest | `tic_id:string` 식별자 (`259377017`), `sector:int` (`3`), `product_id:string`, `source_uri:string`, `retrieved_at:UTC timestamp`, `sha256:string`, `cadence_seconds:float` | 데이터·인프라 |
| Silver 정제곡선 (2분 원본) | `point_id:int64`, `time_days:float64`, `normalized_flux:float64?`, `sector:int`, `original_quality:int64`, `valid:bool`, `exclusion_reasons:list<string>` | 배치 탐색·AI 입력·discoverable 재계산. Gold에는 넣지 않음 |
| Gold 곡선 세그먼트 (ERD `light_curve_segments`) | `tic_id`, `sector:smallint`, `binning_revision:string`, `start_btjd:float64`, `bin_minutes:numeric`(기본 10, 세그먼트 20,000점 초과 시 확대), `n_points:int`, `flux:real[]`(빈 bin NaN), `flux_scatter:numeric`, `gaps:jsonb`. 시각은 `start_btjd + (bin_minutes/1440) × i` | 백엔드·프론트·EC2 온라인 계산 |
| 곡선 메타 | `time_system:string`, `time_reference_offset_days:float64`, `fold_reference_time_btjd:float64`(판 공통값, 5.1절), `flux_unit:string`, `preprocessing_version:string`, `input_snapshot_id:string` | 백엔드·프론트·AI |
| 주기도 (ERD `periodograms`, 판 단위) | `period_min_days`, `period_max_days`, `n_periods:int`(5,000), `power:real[]`. 주기 격자 배열은 저장하지 않고 manifest 격자 규칙(로그 등간격)으로 계산 | 백엔드·프론트 |
| 후보 (ERD `candidates`) | `id` 판 간 유지, `tic_id`, `status`(active/retired), `updated_bundle_id`, `removal_step`, `period_days/epoch_btjd/duration_hours/depth_ppm/bls_power`, `transit_model:jsonb`, `discoverable:bool`, `is_confirmed`. Silver 진단용 `source_curve_stage`, `source_peak_rank`, `snr/sde`, `observed_transit_count`, `qa_status/qa_reasons`는 Gold 열이 아니라 Silver 보존 | 백엔드·AI. 사용자용 잔차 참조 없음. 미세 조정 범위(period_min/max/step)는 열이 아니라 manifest 규칙으로 API가 계산 |
| `transit_model` JSONB | **확정(113, 계약 1.0)**: [`contracts/gold/transit-model.schema.json`](../../../contracts/gold/transit-model.schema.json). `shape=box`, `parameters{period_days, epoch_btjd, duration_hours, depth_ppm}`, `baseline.kind=unity`, `residual_model_version=box-divide-v0`. 수식·실패 코드는 [`libs/astro-kernel`](../../../libs/astro-kernel/README.md) | 배치·EC2 |
| 외부 참조 | `candidate_id:string`, `source:string`, `external_id:string`, `raw_disposition:string?`, `retrieved_at:UTC timestamp`, `snapshot_id:string`, `match_status:string` | 백엔드 |
| AI 결과 | `candidate_id:string`, `score:float64?`, `execution_status:string`, `decision_band:string?`, `model_version/checkpoint_hash/input_version/threshold_version:string`, `curve_ref:string` | 백엔드 |
| 공개 manifest (ERD `publication_bundles.manifest`) | 참조할 `light_curve_segments` id 집합, 배열 checksum, `residual_model_version`, `periodogram_config_version`, 곡선 비닝 규칙, 주기 격자 범위·간격 규칙, 미세 조정 허용 폭, 곡선 단계 규칙, 곡선 원천·외부 참조 snapshot과 파이프라인 버전, 검증 결과. 판 열에 `fold_reference_time_btjd`, `base_days`, `status`(staging/current/archived) | 인프라·백엔드 |

필수 결정:

- FITS 헤더의 시간계·기준 오프셋을 보존하고 t0와 동일 기준을 사용한다. day/hour가 혼재한 현재 반환값은 경계에서 명시적으로 변환한다.
- v1.0에서 사용자 분석의 '모든 점'은 **비닝된 세그먼트 배열 전체**를 뜻한다(EXP-01). 2분 원본은 Silver 탐색·AI 입력용이고 Gold에 두지 않는다. 제외 관측점은 Gold에서 빈 bin의 NaN과 `gaps` 인덱스로 표현하며, 원본 행 대응과 제외 사유는 Silver에서만 보존한다. 비닝 간격 10분은 ERD 기본값이고 대상 별의 가장 짧은 통과 지속시간을 실측해 조정한다(ERD 미결 10).
- depth는 정규화 상대 밝기 감소량이며 화면 ppt/ppm 변환과 구분한다. 후보 상태의 미확정과 처리 실패도 별도이다.
- `P1` 같은 화면 순위 ID는 재실행·번들 간 영구 식별자로 쓰지 않는다. ERD의 `candidates.id`는 판이 바뀌어도 유지되므로 새 판 적재 시 기존 후보와 같은 신호인지 판단하는 주기·중심 시각 허용 오차가 필요하다(ERD 미결 2). 이 기준은 재민님과 합의한다.
- PoC의 baseline은 모든 승인 후보 공동 적합(`joint_refit`) 결과다. v1.0의 잔차 계약은 "Gold의 **고정** `transit_model` 파라미터로 모델을 생성해 나눈다"이므로 온라인에서 재적합하지 않는다. `residual_model_version`의 의미(고정 모델 제거)와 임의 제거 부분집합에서의 baseline 규칙을 먼저 정하고, 빈 제거 집합은 원본과 일치하는지 검증한다.
- 화면 축약·AI 입력·계산 전 점은 서로 다른 산출물이다. 축약 시 좁은 감광이 유실되는지 검증한다.
- `fold_reference_time_btjd`는 DAT-02 필터 후 time·flux가 유한한 원본 정제곡선 시각의 중앙값으로 한 번 계산해 float64로 저장한다. 브라우저·서버·Silver 잔차·EC2 잔차가 같은 값을 상속하고 다시 산정하지 않는다. 위치·산정 입력은 5.1절에서 대조해 해소했다.

### 5.1 113(D06) 결정 기록 — 기준 시각·제공 격자 대조 (2026-09-17)

`transit_model` 계약은 위 표와 [`contracts/gold/transit-model.schema.json`](../../../contracts/gold/transit-model.schema.json)으로 확정했다. Jira 113의 나머지 두 항목은 새로 정하지 않고 세 정본을 필드별로 대조한 결과만 남긴다.

| 항목 | SRS | ERD | 탐사 API | 결과 |
|---|---|---|---|---|
| `fold_reference_time_btjd` 위치 | DAT-11 v1.2: Bundle 공통, 세그먼트는 별도 값 없음 | `publication_bundles` 열, `light_curve_segments`에 없음 | C02-R2: Bundle 공통 `foldReferenceTimeBtjd` | **일치.** 121 착수 때의 "SRS 세그먼트별" 충돌은 SRS v1.2에서 이미 해소됨 |
| 산정 입력 | 모든 세그먼트의 DAT-02 필터 후 중복 제거한 유한 **원본 관측 시각**(비닝 전) 정렬 중앙값, 짝수면 가운데 두 값 평균, 없으면 공개 실패 | 같음 | 같음 | **일치.** 비닝 후 bin 시각이 아니다 |
| 제공 주기도 격자 | DAT-11·EXP-05: 격자 간격·미세 조정 허용 폭 규칙을 manifest에 | `periodograms` 5,000점, 로그 등간격, `period_min_days`=0.5, `period_max_days`는 별마다 | 5.3절: i번째 주기 `min × (max/min)^(i/(n−1))`, `periodMaxDays` = 최장 후보 주기 × 1.15, 최소 40일 | **일치.** 격자 배열은 저장·전송하지 않고 규칙으로 복원 |
| 후보별 `period_min/max/step` | EXP-05: 후보마다 서버가 풀어 제공, 프론트 하드코딩 금지 | 열이 아니라 manifest 규칙으로 API가 계산 | 5.4절 봉우리 API `fineTune`, POL-05 때문에 후보표가 아닌 현재 주기도에서 뽑음 | **일치.** 허용 폭 숫자는 111 실측 뒤(`peakRuleVersion`) |
| `periodogram_config_version` 문자열 | manifest 필수 | manifest·`submissions` 열 | `periodogramConfigVersion` | 형식 미정 → **제안** `pg-log5000-v1`(간격 규칙·점 수·정수 버전). BLS 탐색용 `bls_config_version`(110 제안 `bls_grid_v1/linear50k`)과 별개 |

격자 생성·봉우리 추출 구현은 120, 허용 폭 수치는 111 실측 뒤 128과 함께 정한다. `transit_model`의 bin 중심 평가·호출자 시각 이동 결정은 [astro-kernel README](../../../libs/astro-kernel/README.md) "D06(113) 결정 사항"에 있다.

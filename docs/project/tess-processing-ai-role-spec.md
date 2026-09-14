# 윤성용 천문 데이터 처리·AI 역할 명세

작성일: 2026-09-09 · v1.0 반영 수정: 2026-09-10  
담당: 윤성용  
연결 Jira: S15P21C206-29 (기획), S15P21C206-40 (AI 실행 가능성 조사, 완료)  
상태: `develop@132cdc77`의 [요구사항 명세서 v1.0](../requirements/planetory-requirements-spec.md)과 [서비스 DB ERD v1.0](../architecture/database-erd.md) 기반 작업 안내서, 팀 리뷰 전

이 문서는 팀 요구사항을 바꾸지 않는다. 요구사항 명세서 v1.0과 [팀 역할 분배](team-role-allocation.md)에서 윤성용에게 배정된 일을 실제 작업 순서로 풀어 쓴다. 상세한 근거·스키마·실험안은 [TESS 파이프라인 분석](../data/tess-pipeline/README.md), Jira 완료 조건과 리뷰 질문은 [TESS 파이프라인 리뷰 체크리스트](tess-pipeline-review-checklist.md), AI 모델 조사 결과는 [TESS 후보 판별 모델 실행 가능성 조사](../data/tess-ai-model-feasibility.md)에서 관리한다.

명세서 v1.0은 "구조와 규칙은 확정, 임계값·대상 데이터 등 수치는 DEC 항목에서 실측 후 채운다"는 기준선이다. 이 문서도 같은 구분을 따른다.

## 1. 역할을 한 문장으로 설명

TESS Light Curve를 재현 가능한 방식으로 정제하고, Silver 내부 반복 BLS로 후보와 transit model 파라미터를 만들며, 외부 카탈로그와 AI 결과를 연결해 검증된 Gold 배열·후보표·manifest를 서비스 팀에 전달하는 책임을 맡는다.

윤성용이 과학적 계산 의미와 검증 기준을 책임지고, 저장·분산 실행·온라인 API·화면 구현은 각 담당자와 데이터 계약으로 연결한다.

## 2. v1.0 기준에서 확정된 흐름

### 배치

```text
MAST FITS·외부 원천
→ Raw/Bronze 등록·파싱
→ Sector별 품질 필터·정규화·연속 구간 detrending      (2분 원본 해상도)
→ TIC별 정제곡선 결합
→ 원본 BLS (후보 탐색용)
→ transit model 적합·제거 QA
→ Silver 내부 잔차 BLS 반복 (배열 비저장)
→ 모든 단계 후보의 원본 재검증
→ 고조파·중복 병합, 후보 ID 부여(판이 바뀌어도 유지)
→ 사용자 제공 해상도로 재계산한 발견 단계 잔차 주기도에서 discoverable 판정
→ TCE·TOI·Archive·ExoFOP 연결
→ 후보별 AI 입력·추론
→ Gold 산출: 별·섹터 세그먼트(10분 비닝) + 판별 원본 주기도 + 후보표(transit_model 파라미터) + manifest
→ PublicationBundle 검증 → EC2 PostgreSQL 배열 적재 → staging → current 전환(이전 판은 archived)
```

Silver 내부 BLS는 후보를 **찾는** 계산이고 2분 원본 해상도에서 수행한다. `discoverable`은 사용자가 **찾을 수 있는지**의 판정이며, 명세서 DAT-07에 따라 사용자에게 제공되는 것과 같은 비닝 간격·모델·주기 격자 설정으로 계산한 발견 단계 잔차 주기도에서 봉우리가 잡히는지로 정한다. 2분 원본 해상도로 판정하지 않는다. 두 계산은 목적과 해상도가 다르므로 설정 버전을 따로 둔다.

### 사용자 분석(온라인)

```text
current PublicationBundle (세션 고정 없음)
+ 사용자가 매칭한 후보의 transit_model 파라미터 조합
→ EC2가 비닝된 원본 세그먼트에서 모델을 생성해 제거 → 잔차곡선
→ 잔차 주기도 (manifest 격자 규칙)
→ Redis 캐시 (키: tic_id, publication_bundle_id, 정렬한 제거 후보 id, residual_model_version, periodogram_config_version)
```

사용자는 현재 곡선의 전체 유효 관측점을 브라우저에서 선택 주기로 접고, 접힌 곡선에서만 `phase_start`·`phase_end`를 선택한다. 브라우저는 Bundle의 `fold_reference_time_btjd`로 epoch·duration을 미리보기하고 서버가 같은 공식으로 최종값을 다시 계산한다. 시간 영역 곡선에서 transit 구간을 고르거나 epoch·duration을 숫자로 직접 입력하지 않는다.

EC2 온라인 계산은 새 Candidate를 만들거나 AI를 다시 실행하지 않는다. 분석 세션은 특정 Bundle에 고정하지 않으며, 새 판이 `current`가 되면 진행 중 회원에게 알리고 최신 판으로 다시 불러온다(EXP-01). 이전 판은 곧바로 `archived`가 되어 그 판의 주기도 행과 Redis 캐시를 정리한다. 과거 제출은 절대값(epoch·duration·period·제출 당시 fold 기준 시각·계산 버전)으로 현재 판에서 재현한다(SUB-10, HIS-02).

## 3. 단계별 담당 업무와 산출물

| 단계 | 윤성용이 할 일 | 만들어야 할 산출물 | 함께 확인할 사람 |
|---|---|---|---|
| 원천 계약 | TESS 제품·cadence·Sector 범위, FITS HDU·헤더·필수 컬럼·단위 확인 | 입력 manifest·FITS 파싱 계약 | 김동혁 |
| 외부 원천 | TIC·TCE·TOI·Archive·ExoFOP 식별자와 갱신·매칭 규칙 정의 | 외부 snapshot·후보 연결 계약 | 강재민 |
| 전처리 | 품질·결측·이상치·추가 마스크·정규화·구간 분리·detrending 검증 | 정제곡선 schema, 제외 사유, 전처리 버전, 벤치마크 | 김동혁·백지웅 |
| 비닝 | 세그먼트 분할, 비닝 간격(기본 10분, 세그먼트 20,000점 초과 시 확대)과 `binning_revision` 규칙, 빈 칸 NaN·gaps, 산포 스칼라 정의 | 비닝 규칙, 가장 짧은 통과 지속시간 실측 근거 | 강재민·백지웅 |
| BLS | 주기·지속시간 격자, SDE·SNR·transit 수·Sector 일관성 계산 | 탐색용 periodogram 설정 버전, 품질 결과 | 김동혁 |
| 반복 제거 | 후보 transit model 적합, 제거 전후 QA, 종료 사유 기록 | 실행 중 Silver residual·periodogram, 지속 저장할 removal QA 요약·반복 이력 | 김동혁·강재민 |
| 후보 통합 | 원본 재검증, 고조파·중복 병합, 판 사이 후보 동일성 판단, 안정 ID | Candidate·CandidateAlias, 후보 동일성 허용 오차 제안 | 강재민 |
| transit model | 후보별 `transit_model` JSONB의 필드·모양(shape)·모델 버전 정의, 잔차 = 원본에서 고정 모델 제거 규칙 | transit_model 스키마, `residual_model_version` 정의 | 강재민·김동혁 |
| discoverable | 사용자 제공 해상도·격자로 재계산한 발견 단계 잔차 주기도의 봉우리 판정 규칙 | 판정 알고리즘, `periodogram_config_version`, 재계산 조건 | 강재민 |
| 사용자 주기도 | 판별 원본 주기도 격자(범위·로그 등간격·5,000점)와 미세 조정 허용 폭 규칙 | manifest 격자 규칙, 후보별 period_min/max/step 산출식 | 강재민·백지웅 |
| AI | 적용 가능한 모델·체크포인트·라이선스 확인, 입력 생성·추론·평가 | AI 입력 버전, 점수·판정·모델 버전, 검증 보고서 | 김동혁·강재민 |
| Gold 계약 | 세그먼트·주기도·후보표·manifest의 과학 schema와 QA | PublicationBundle 과학 schema·QA 결과 | 김동혁·강재민·백지웅 |
| 온라인 일치 | 같은 모델·설정에서 Silver와 EC2 잔차·주기도 비교 | fixture, 허용 오차 근거, 회귀 결과 | 김동혁·강재민 |
| 갱신 | 새 Sector·원천·설정·모델·비닝 revision 변경의 재처리 범위 산정 | 변경 영향표, 후보 추가·discoverable 변경 목록, 재개 이벤트 조건 | 강재민·백승학·하서진 |

## 4. Silver와 Gold에서 책임질 범위

### Silver 내부 (GCP HDFS, 서비스가 읽지 않음)

윤성용은 다음 계산의 의미·버전·검증 기준을 정의한다.

- Sector별 정제곡선과 행 대응(2분 원본 해상도)
- trend·정규화 통계·품질 마스크·제외 사유. 품질 플래그는 여기서만 소비하고 화면에 전달하지 않는다(POL-13)
- 탐색용 원본 BLS periodogram과 반복 단계의 실행 중 periodogram
- 단계별 transit model과 실행 중 residual
- 제거 전후 power·경계 돌출·다른 후보 훼손·겹침 왜곡 QA
- 품질 실패 후보와 반복 종료 사유
- 원본 재검증·고조파·중복 병합 근거
- 사용자 제공 조건으로 재계산한 discoverable 판정 근거
- AI 입력·결과와 실행 실패 상태

DAT-05에 따라 단계별 residual·periodogram 배열은 지속 저장하지 않는다. 윤성용은 Spark 실행 중 필요한 계산 흐름과 지속 저장할 제거 QA 요약·종료 사유·후보·모델·설정 버전을 정의하고, 김동혁은 이를 만족하는 실행·저장 구조를 설계한다. 배치 실행 기록(PipelineRun)은 서비스 DB에 두지 않고 Airflow가 보관한다(OPS-05).

### Gold (EC2 PostgreSQL 배열, ERD 묶음 B)

ERD v1.0은 Gold 본문을 파일이 아니라 PostgreSQL 배열 열에 둔다. 윤성용이 과학적 의미를 책임지는 Gold 항목은 다음과 같다.

| 대상 | 내용 | 비고 |
|---|---|---|
| light_curve_segments | 별·섹터·`binning_revision` 단위 불변 곡선. `start_btjd`, `bin_minutes`, `n_points`, `flux real[]`(빈 칸 NaN), `flux_scatter` 스칼라, `gaps` | 시각 배열 저장 안 함: `start_btjd + (bin_minutes/1440) × i`. 판에 묶이지 않고 manifest가 세그먼트 id 집합을 참조 |
| periodograms | 판 단위 원본 주기도. `period_min_days`, `period_max_days`, `n_periods`(5,000), `power real[]` | 주기 격자 배열 저장 안 함: manifest 격자 규칙(로그 등간격)으로 계산. 사용자용 잔차 주기도는 없음 |
| candidates | 대표값(period·epoch·duration·depth·bls_power), `removal_step`, `transit_model` JSONB, `discoverable`, `status`(active/retired), `updated_bundle_id` | 후보 id는 판이 바뀌어도 유지. 미세 조정 범위는 열이 아니라 manifest 규칙 + API 계산 |
| candidate_aliases | 고조파 배율·별칭 주기 | |
| external_signal_references, candidate_dispositions, candidate_status_history | 외부 원천·통합 disposition·변경 이력 | DAT-09 규칙, AI는 통합 상태에 쓰지 않음 |
| ai_executions, ai_evaluations | 모델·체크포인트·상태, 후보별 점수·verdict·임계값 버전 | |
| publication_bundles | `manifest` JSONB(세그먼트 id 집합, 배열 checksum, `residual_model_version`, `periodogram_config_version`, 비닝 규칙, 격자 범위·간격 규칙, 미세 조정 허용 폭, 곡선 단계 규칙), `fold_reference_time_btjd`, `base_days`, `status`(staging/current/archived) | |

Gold에 **없는** 것: 품질 마스크 배열, 시각 배열, 주기 격자 배열, 밝기 오차 배열, 사용자용 단계별 잔차곡선·주기도, transit model 파일. 검증된 판만 원자적으로 `current`가 되고 실패 시 기존 판을 유지한다.

`fold_reference_time_btjd`는 DAT-02 품질 필터 후 time·flux가 유한한 원본 정제곡선 시각을 정렬한 중앙값으로 한 번 계산해 float64 정밀도로 저장한다. 브라우저·서버·모든 잔차 단계는 이 값을 상속하고 다시 산정하지 않는다. **확인 필요:** 명세서 DAT-11은 "각 LightCurveSegment의" 기준 시각이라 쓰고, ERD는 publication_bundles에 판 단위 값 하나를 둔다. 또 산정 대상이 비닝 전 관측 시각인지 비닝 후 bin 시각인지 명시가 없다. 두 문서의 정본 위치와 산정 입력을 강재민과 확정한다.

여기까지는 명세서 v1.0과 ERD v1.0의 확정 범위다. 배열 적재 경로(배치 직접 INSERT vs API, ERD 미결 7), 계산 위치, 동시 상한, 용량 실측은 DEC-35의 별도 아키텍처 Task에서 김동혁·강재민과 확정한다. 아키텍처 문서의 불변 규칙 5(곡선 본문은 EC2 Gold 파일)와 데이터 소유권 표는 ERD 결정에 맞춰 수정이 필요하다고 ERD가 명시하고 있다.

## 5. 비닝 해상도와 discoverable — 과학적 주의점

10분 비닝은 ERD가 기본값으로 잡았고 "대상 별의 가장 짧은 통과 지속시간을 실측해 조정한다"(ERD 미결 10)는 조건이 붙어 있다. 이 실측과 판단은 윤성용의 책임이다.

- 2분 cadence를 10분으로 묶으면 점 수는 1/5, 점당 잡음은 1/√5가 되어 통과의 신호 대 잡음비는 유지되지만, 3시간 통과는 약 18점, 1시간 통과는 약 6점으로 표현된다. 근거 체크(V/U형, 홀짝 깊이)와 사용자의 위상 구간 선택이 이 점 수에서 가능한지 확인해야 한다.
- 사용자 주기도는 비닝된 곡선에서 계산되므로, Silver가 2분 원본에서 찾은 후보라도 비닝된 곡선의 주기도에서 봉우리가 잡히지 않으면 `discoverable=false`여야 한다. 그렇지 않으면 화면에 봉우리가 없는 신호가 미매칭으로 남아 탐색 완료(SUB-11)를 막는다.
- 비닝 간격이나 격자 규칙을 바꾸면 새 `binning_revision`의 세그먼트, 주기도, 후보표를 함께 만들어 원자적으로 전환하고 discoverable을 다시 계산한다. 값이 바뀐 후보는 DAT-15의 재개 이벤트로 처리한다.
- 자체 BLS 채택 신호가 0개인 별(무신호 별)의 비율을 함께 실측한다(DEC-01, 10.1 안건 12). 비율이 높으면 DEC-03의 BLS 채택 임계값을 같이 조정하고, 튜토리얼 5번 TIC(복수 FP 반복 탐색)은 이 검증 후 선정한다.

## 6. 명세서가 미결정 또는 후속 Task로 남긴 항목

윤성용이 실험 근거와 권장안을 제시해야 하는 항목:

- 전체 TESS 제품·cadence·Sector·대상 수, 무신호 별 비율(DEC-01)
- 품질 bit 정책과 Sector 시작·궤도 근점 마스크 범위
- 최종 detrending 방법·창 길이·fallback
- 비닝 간격 실측과 가장 짧은 통과 지속시간(ERD 미결 10)
- 탐색용 BLS 격자, SDE·SNR·transit 수, 반복 상한과 종료 기준(DEC-03·06)
- 제거 QA 수치와 Silver–EC2 수치 허용 오차(김동혁 문서의 rtol 1e-8·atol 1e-10 시작값 검토)
- 고조파 추가 배율과 후보 매칭 허용 오차(DEC-05, DEC-03)
- 새 판 적재 시 후보 동일성 판단 기준(ERD 미결 2)
- `transit_model` JSONB 필드·shape·모델 버전 정의와 잔차 모델 규칙. 기존 PoC의 공동 재적합은 "고정 모델 제거" 계약과 다르므로 `residual_model_version`의 의미를 먼저 정한다
- discoverable의 봉우리 판정 규칙과 사용자 제공 주기도 격자 규칙(`periodogram_config_version`)
- 미세 조정 허용 폭 규칙(period_min/max/step 산출식)
- 확정 후보의 대표 주기·epoch를 외부값으로 정렬할지(DEC-20)
- AI 모델·체크포인트·입력 곡선 단계·승인 구간(DEC-02·04). AstroNet-Triage는 PC/EB 대 junk 1차 선별 모델이므로 행성 최종 판별 모델로 단독 채택하지 않는다는 조사 결론 유지

다른 담당자의 Task이지만 윤성용이 입력을 제공해야 하는 항목:

- Silver 단계별 배열을 저장하지 않는 조건을 만족할 Spark 실행 방식(김동혁)
- Gold 배열 적재 경로와 용량 실측(김동혁·강재민, DEC-35)
- 온라인 계산 위치, 큐·동시 실행 상한과 시간 목표(김동혁, DEC-35)

**v1.0에서 종결되어 더 이상 미결이 아닌 것:** 캐시 저장소(Redis), 이전 판 보존기간(폐기, 세션은 최신 판으로), AnalysisSnapshot 저장소(서비스 DB), Gold 본문 저장 방식(DB 배열), 비닝 단위(별·섹터 세그먼트, 기본 10분), 밝기 오차 표현(스칼라). 윤성용은 위 열거한 미결정 항목에만 실험 근거와 권장안을 제시하고, 관련 담당자 리뷰 결과를 문서와 Jira에 남긴다.

## 7. 지금까지 완료한 일

| 작업 | 상태 | 현재 근거와 한계 |
|---|---|---|
| Jira 29 완료 조건·첨부·댓글 확인 | 완료 | 실제 Jira 기준을 리뷰 체크리스트에 기록. Jira 설명은 아직 v0.9 문구 |
| TOI-270 Sector 3·4·5 FITS 구조 확인 | 완료 | TIC 259377017 샘플 한 개 기준 |
| 품질·결측 필터와 정규화 확인 | 완료 | 서비스 정책의 최종 수치는 미확정 |
| Sector·공백 구간 처리 설계 | 초안 완료 | 추가 마스크 범위 실험 필요. 세그먼트 분할 규칙과 연결해야 함 |
| detrending 설계·주입 비교안 | 초안 완료 | 최종 방법·창·통과 수치 미확정 |
| 최초 원본 BLS 재현 | 완료 | 약 5.6593일, 반복 후보 회수 검증은 아님 |
| BLS 품질·고조파·벤치마크 설계 | 초안 완료 | 실제 고정 평가 세트 실행 필요 |
| Silver 내부 반복 BLS 설계 | v0.12 반영 | 자동 반복 구현·제거 QA 실험 미완료 |
| 외부 원천 연결 설계 | 초안 완료 | 실제 export 컬럼·매칭 실측 필요 |
| AI 모델 실행 가능성 조사 (Jira 40) | 완료·develop 병합 | AstroNet-Triage checkpoint로 TOI-270 c 0.258, L 98-59 c 0.816, CM Draconis 0.998. PC/EB 대 junk 점수이며 임계값 아님. ExoNet은 공개 checkpoint 없음, ExoMiner++는 입력 결손·컨테이너 미실행 |
| Silver·Gold·EC2 논리 경계 | v1.0 반영 | 이 문서에서 v0.12의 "전 점·마스크·세션 고정" 표현을 세그먼트·비닝·최신 판 재로드로 갱신. 갭 분석·체크리스트도 2026-09-10에 같은 기준으로 갱신 |
| 노트북 환경 재현 | 29번 완료 필수에서 제외 | 다른 환경 반복 실행은 구현·회귀 검증 Task에서 필요할 때 수행 |
| Draft MR !10 | 생성 완료 | v1.0 반영 커밋과 팀 리뷰 필요 |

## 8. Jira 29번을 마치는 순서

### 1단계 — 기획 문서 v1.0 정합화

- 요구사항 명세서 v1.0의 DAT-01~15, AI-01~05를 상세 기획에 연결한다.
- 확인한 사실, 현재 요구사항, 윤성용 제안, TBD를 구분한다.
- Silver 반복 BLS(탐색, 2분 해상도)와 discoverable 판정(제공 해상도)과 EC2 온라인 잔차(사용자 조합)의 목적을 분리한다.
- Gold 산출물을 ERD 묶음 B(세그먼트·주기도·후보표·manifest)에 맞추고, "전 점·품질 마스크·transit_model_ref" 표현을 제거한다.
- 세션 Bundle 고정·보존기간·DerivedCurveCache 표현을 최신 판 재로드·archived 정리·Redis로 바꾼다.
- 접힌 곡선의 위상 구간 선택과 `fold_reference_time_btjd` 기반 epoch·duration 계산 계약을 확인하고, 기준 시각의 정본 위치(세그먼트 vs 판)를 리뷰 질문으로 남긴다.

### 2단계 — 수치가 필요한 실험을 후속 Task로 분리

> 실험·구현 Task 의 전체 목록, 착수 순서, 선행 관계(착수 조건과 완료 검증 조건), Epic 묶음 제안은 [천문 데이터 처리·AI 후속 Task 계획](tess-processing-ai-task-plan.md)(`S15P21C206-46`)에서 관리한다. 아래 목록은 2026-09-10 이 문서 작성 시점의 요약이며, 두 문서가 다르면 계획 문서를 따른다.

- 고정 fixture·합성 주입 세트·실행 manifest 구성 (`S15P21C206-41` 등록)
- 전처리·detrending 벤치마크 (`S15P21C206-42` 등록)
- 비닝 간격 실측(가장 짧은 통과 지속시간, 비닝 후 근거 체크 가능성)
- 탐색용 BLS 격자·품질·반복 종료·제거 QA 벤치마크
- 무신호 별 비율 실측과 BLS 채택 임계값 조정(DEC-01·03)
- 고조파·후보 병합·판 사이 후보 동일성·discoverable 판정 검증
- 외부 원천 schema·매칭 검증
- transit_model 스키마와 잔차 모델 정의(고정 모델 제거), Silver–EC2 잔차·주기도 일치 검증
- AI: AstroNet-Triage 성능 평가 및 후보 선별 기준 검증(`S15P21C206-43` 등록, 별도 브랜치. TIC 단위 분리 PC/EB/junk 평가 세트, 단일 vs 10개 ensemble, 재현율·정밀도·PR-AUC, PC/EB 구분은 Vetting 또는 별도 규칙, 임계값은 결과 이후)

각 Task에는 입력 fixture, 설정 버전, 실행 명령, 통과 기준과 작은 리뷰 산출물을 적는다. 기존 Jira(40번 등)와 중복되지 않게 확인한다.

### 3단계 — 인터페이스 리뷰

- 김동혁: 단계별 배열 비저장 조건을 만족하는 Spark 실행, Gold 배열 적재 경로, 아키텍처 불변 규칙 5·데이터 소유권 표 수정, 온라인 계산 문서(PostgreSQL+파일 캐시 전제)와 ERD(Redis·DB 배열)의 불일치 해소
- 강재민: `transit_model` JSONB 스키마, 주기도 격자 규칙과 `periodogram_config_version`, 미세 조정 허용 폭 산출, `fold_reference_time_btjd` 정본 위치, 새 판 적재 시 후보 동일성, discoverable 재계산과 재개 이벤트 연결
- 백지웅: 세그먼트·NaN 빈 칸·gaps·10분 비닝의 화면 표현, 단위, fold 기준 시각, 판 교체 시 재로드 동작
- 백승학·하서진: 후보 추가·discoverable 변경 이후 알림·퀘스트·발견 영향(DAT-15)

### 4단계 — MR과 Jira 완료

- 리뷰 결정을 상세 기획과 체크리스트에 반영한다.
- 결정하지 못한 수치는 담당·후속 Task·검증 방법·결정 시점을 남긴다.
- Jira 29 설명의 v0.9 문구를 v1.0 기준으로 갱신한다.
- Draft MR !10을 Ready로 전환하고 작성자 외 최소 1명 승인을 받는다.
- MR 병합, 완료 조건 확인, 최종 문서·검증 링크 Jira 등록 뒤 완료 처리한다.

## 9. 기획 이후 구현 권장 순서

1. 고정 FITS·합성 주입 fixture와 실행 manifest를 만든다.
2. 전처리·detrending 후보를 같은 fixture에서 비교한다.
3. 세그먼트 분할·비닝 규칙을 구현하고 가장 짧은 통과 지속시간 대비 간격을 실측한다.
4. 탐색용 BLS 격자·품질 게이트·반복 종료·제거 QA를 벤치마크한다.
5. transit_model 스키마·잔차 모델 규칙을 확정하고 Candidate ID·고조파·원본 재검증을 구현한다.
6. 제공 해상도·격자로 discoverable 판정을 구현하고 무신호 별 비율을 실측한다.
7. TCE·TOI·Archive·ExoFOP snapshot과 후보 연결을 구현한다.
8. 선택 모델의 AI 입력·추론·평가를 구현한다.
9. Silver 결과를 Gold 세그먼트·주기도·후보표·manifest로 검증·직렬화하고 적재 경로에 연결한다.
10. 같은 transit_model로 Silver–EC2 잔차와 periodogram 일치를 검증한다.
11. 검증된 커널을 Spark/Airflow 배치에 연결하고 실패 단계 재처리와 판 전환을 확인한다.

## 10. 매 작업에서 남길 증거

- 사용한 Git commit과 의존성 lock
- 입력 URI·snapshot·checksum과 대상 TIC·Sector
- 전처리·비닝(`binning_revision`)·BLS·후보·transit model·AI 설정 버전과 `bundle_version`
- 실행 명령과 환경 CPU·아키텍처·Python/Java 버전
- 행 수·마스크 수·세그먼트 수·후보 수·반복 수·종료 사유
- 성공·실패 사례와 허용 오차 판정
- 대용량 원본이 아닌 작은 표·요약·그림과 실제 결과 위치. 원본 FITS·추론 결과·NPZ·TFRecord는 Git에 넣지 않는다

PoC 한 번의 성공이나 알려진 행성 한 개의 회수만으로 전체 정확도·성능·서비스 준비 완료를 주장하지 않는다.

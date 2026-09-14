# 외부 원천과 AI 설계

> 상위 문서: [TESS 파이프라인 분석](README.md)

## 5.8 외부 TCE·TOI·Archive·ExoFOP 연결 설계 v0.1

작성일: 2026-09-07. 상태: **윤성용 검토 전 제안, 팀 미승인**. 외부 자료는 자체 BLS 후보를 설명하고 비교하는 참조다. 외부 주기·상태가 자체 BLS 결과를 덮어쓰거나, 외부 목록에 있다는 이유만으로 Planetory 후보를 새로 만들지 않는다(POL-10, AT-18·19).

### 원천별 역할과 식별자

| 원천 | 별을 찾는 키 | 신호 식별자·범위 | Planetory에서 사용할 역할 |
|---|---|---|---|
| TESS LC / TIC | FITS `TICID`, 서비스 `tic_id` | Sector·제품별 광도곡선 | 자체 전처리·BLS의 기준 입력. 다른 원천을 연결하는 별 단위 루트 |
| MAST TCE | TCE 통계의 TIC ID | TIC, TCE 번호, 검색 Sector 시작·끝, SPOC pipeline run의 조합 | SPOC가 찾은 threshold crossing event의 외부 비교값. 같은 물리 신호가 다른 검색 범위·run에서 반복될 수 있음 |
| NASA Exoplanet Archive TOI | `tid`가 TIC ID | `toi`가 프로젝트 후보 ID, `tfopwg_disp`가 TFOPWG 상태 | TOI 주기·epoch·duration·depth와 사람 disposition의 정본 스냅샷 후보 |
| ExoFOP TESS | TIC·TOI | 갱신되는 TOI/CTOI와 follow-up 기록 | TOI의 최신 상태·근거 확인 원천. 사용한 export/API 범위와 조회 시각 보존 |
| NASA Exoplanet Archive PS/PSCompPars | `tic_id` 또는 별 이름 | `pl_name`, 행성별 문헌 파라미터와 출처 | 문헌상 확정 행성 이름·대표/복수 파라미터의 독립 참조. TOI disposition과 별도 원천으로 보존 |

NASA Exoplanet Archive TOI 문서에 따르면 `tid`는 TIC ID이며 `toi`는 별과 그 별의 개별 천체 후보를 식별하는 TOI 번호다. `tfopwg_disp` 값은 APC·CP·FA·FP·KP·PC다. Archive TOI 목록은 ExoFOP 목록을 바탕으로 주기적으로 갱신되므로 둘이 잠시 다를 수 있다. [TOI 컬럼 정의](https://exoplanetarchive.ipac.caltech.edu/docs/API_TOI_columns.html), [TESS Project Candidates 설명](https://exoplanetarchive.ipac.caltech.edu/docs/TESSMission.html)

MAST는 단일 Sector와 여러 Sector 검색별 TCE 통계 CSV를 별도로 제공한다. TCE 제품명에는 검색 시작·끝 Sector, 16자리 TIC ID, TCE 번호와 pipeline run이 포함된다. 따라서 `TIC ID + TCE 번호`만 영구 전역 ID로 사용하지 않는다. [MAST TCE 다운로드](https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_tce.html), [TESS 제품명 규칙](https://archive.stsci.edu/missions-and-data/tess/data-products.html)

Archive의 현재 확정 행성 자료는 TAP의 `ps` 또는 `pscomppars`에서 조회하며 두 표 모두 `tic_id`와 `pl_name`을 제공한다. PS는 문헌별 여러 해가 있을 수 있으므로 대표행을 사용할 때 선택 규칙과 원본 출처를 기록한다. [PS/PSCompPars 컬럼 정의](https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html), [TAP 사용법](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html)

### 두 단계 조인 제안

외부 후보 연결은 다음 두 단계를 분리한다.

```text
1. 별 단위 조인
   LC TICID = 정규화한 tic_id = TOI.tid = TCE TIC ID = PS/PSCompPars tic_id

2. 같은 별 안의 신호 단위 매칭
   자체 BLS candidate ↔ 외부 signal
   period + 순환 epoch 차이 + duration 비율 + 실제 관측 transit 창 겹침
   + 필요할 때 P/2·2P 고조파 관계
```

`tic_id`는 내부에서 숫자 문자열 하나로 정규화하고 원문의 `TIC ` 접두사·선행 0 표기는 raw 값으로도 보존한다. TIC가 같다는 사실은 같은 별이라는 근거일 뿐, 같은 별의 여러 행성·TCE·TOI 중 어떤 신호인지는 확정하지 않는다. TOI 번호의 정수부를 TIC ID로 해석하지 않고 반드시 공식 `tid`를 사용한다. CTOI alias도 별도 외부 ID로 보존한다.

시간 비교 전 모든 epoch에 원천 시간계·기준점을 붙인다. 현재 LC의 TIME은 BTJD(`BJD - 2457000`)이며 TOI의 `pl_tranmid`는 BJD다. 계산용 공통 시간으로 바꿀 때 변환식과 원래 값을 함께 저장하고, 시간계가 불명확하면 강제 매칭하지 않고 `invalid_external_time` 또는 review로 둔다.

### 신호 매칭 상태 제안

| 상태 | 의미 | 후속 처리 |
|---|---|---|
| `direct_match` | 같은 TIC에서 대표 주기·epoch·duration·관측 창이 직접 일치 | 외부 참조 연결. 자체 대표값 유지 |
| `harmonic_match` | P/2 또는 2P 관계와 위상·관측 창이 함께 일치 | alias 관계와 배율 보존, 자동 대표값 교체 금지 |
| `ambiguous_match` | 하나의 자체 후보가 여러 외부 신호와 비슷하거나 반대 경우 | 모든 후보 근거를 보존하고 운영/분석 review |
| `external_only` | 외부 TCE·TOI는 있으나 자체 BLS 품질 통과 후보가 없음 | 운영 비교 자료에만 보존, 사용자 매칭 후보에서 제외 |
| `internal_only` | 자체 BLS 후보는 있으나 연결되는 외부 신호가 없음 | 신규·미등록 가능성을 포함한 분석형 후보. AI와 외부 없음 상태를 분리 |
| `invalid_external` | 필수 키·주기·epoch가 누락 또는 비유효 | 자동 매칭 금지, 원천 오류·누락 사유 기록 |

허용 period 오차, 순환 epoch 오차, duration 비율, 최소 transit 창 중첩 수·비율은 SUB-03과 DEC-03의 벤치마크 대상이다. 매칭 결과에는 최종 상태만 저장하지 않고 각 원시 차이와 사용한 `matching_rule_version`을 저장한다.

### 외부 raw 상태와 통합 disposition 분리

각 원천의 행과 상태는 그대로 보존하고 하나의 문자열로 미리 덮어쓰지 않는다. 자체 BLS 품질, 외부 사람 disposition과 AI 결과도 서로 다른 필드다.

SRS DAT-09·DEC-29를 적용한 통합 상태 제안은 다음과 같다.

| TOI `tfopwg_disp` | `planet_truth` | `answer_class` | 해석 |
|---|---|---|---|
| `KP`, `CP` | `planet` | `graded` | 알려진/확정 행성으로 채점 가능한 외부 라벨 |
| `FP`, `FA` | `not_planet` | `graded` | 위양성/거짓 경보로 채점 가능한 외부 라벨 |
| `PC`, `APC` | `null` | `analysis` | 승인된 분석형 후보이지만 확정 정답은 아님 |
| 없음·미매칭 | `null` | `analysis` | 외부 정답 라벨 없음 |

TCE 존재 여부는 위 표의 사람 라벨이 아니며 AI 점수도 `planet_truth`를 바꾸지 않는다. PS/PSCompPars에 확정 행성이 있으나 현재 TOI 매칭이나 TFOPWG 상태가 없거나 충돌하면, SRS가 정한 TFOPWG 기반 통합 규칙을 임의로 확장하지 않고 `source_conflict=true`와 원천별 값을 보존해 팀 review 대상으로 둔다. 확정 후보의 자체 period·epoch를 외부값으로 정렬할지는 DEC-20이므로 현재는 자체값과 외부값을 나란히 둔다.

### 외부 참조·스냅샷 필드 제안

| 필드 | 의미 |
|---|---|
| `external_signal_ref_id` | 원천 행의 내부 안정 참조 ID. raw 행을 Candidate와 분리 |
| `source` / `source_table` | `mast_tce`, `nea_toi`, `exofop_toi`, `nea_ps` 등과 실제 표·release |
| `external_id` | TOI, TCE delivery ID, planet name 등 원천 고유 표현 |
| `tic_id` / `raw_tic_id` | 정규화 조인 키와 원문 값 |
| `period_days`, `epoch_value`, `epoch_system`, `duration_hours`, `depth_ppm` | 외부 파라미터. 원천 단위와 변환값 구분 |
| `raw_disposition` | 원천 문자열 그대로. null 허용 |
| `source_row_updated_at` | 원천이 제공하는 행 갱신 시각. 없으면 null |
| `retrieved_at`, `source_uri`, `query`, `snapshot_id`, `content_hash` | 언제 무엇을 어떻게 가져왔는지 재현하는 정보 |
| `match_status`, `matched_candidate_id`, `match_metrics`, `matching_rule_version` | 자체 후보와의 연결 결과·근거 |
| `is_current`, `valid_from`, `valid_to` | 스냅샷 간 현재값과 변경 이력. 삭제도 물리 삭제 대신 종료 시각 기록 제안 |

원천별 전체 raw snapshot과 정규화 참조를 분리한다. 조회 실패나 부분 응답을 새 빈 snapshot으로 간주하지 않는다. 동일한 content hash 재수집은 새 후보·상태 변경 이벤트를 만들지 않으며, 원천에서 사라진 행은 즉시 삭제하지 않고 이전 snapshot과의 차이로 기록한다.

### 갱신과 재처리 경계

| 변경 | 다시 수행할 단계 | 수행하지 않는 단계 |
|---|---|---|
| TCE·TOI·ExoFOP 파라미터 변경 | 해당 TIC의 외부 정규화·신호 매칭·통합 상태·후보표 검증 | LC 전처리·BLS·AI 재추론은 입력/모델 변화가 없으면 재실행하지 않음 |
| TOI disposition 변경 | CandidateDisposition·상태 이력·표시용 파생 필드 갱신 | v1 성과·등급·통계 과거 snapshot 자동 변경 금지 |
| PS/PSCompPars 문헌 행 추가·대표값 변경 | Archive 외부 참조와 충돌 상태 갱신 | 자체 BLS 대표 파라미터 자동 교체 금지 |
| 외부 행 삭제·매칭 해제 | 이력 종료, 새 snapshot에서 `external_only/internal_only/ambiguous` 재평가 | 과거 raw 참조 물리 삭제 금지 |
| 외부 수집 실패 | snapshot 실패 상태와 재시도 기록 | 기존 성공 snapshot을 빈 값으로 덮어쓰기 금지 |

SRS DAT-15에는 외부 갱신 때 `ai_status`도 갱신한다는 문구가 있으나 DAT-09는 AI를 별도 값으로 기록하도록 한다. 외부 라벨만 바뀌었을 때 AI 추론 결과 자체를 바꾸지 않고 표시/파생 상태만 다시 계산하는지 강재민과 확인한다.

### 검증 사례와 팀 결정 안건

최소 고정 사례는 같은 TIC의 다중 TOI, 동일 신호의 단일/다중 Sector TCE 중복, TCE-only, TOI-only, 자체 BLS-only, P/2·2P, epoch 기준 변환, 외부 파라미터 누락, TOI–Archive 충돌과 snapshot 행 삭제다. 각 사례에서 원천 행 수, 매칭 수, 미매칭·충돌 사유, 자체 후보값 불변과 멱등 재실행을 확인한다.

팀 결정이 필요한 항목은 매칭 허용 오차, 추가 고조파, ambiguous 자동 해소 여부, ExoFOP 직접 수집 범위·인증/사용 조건, Archive TOI와 ExoFOP가 다를 때 표시 우선순위, PS/PSCompPars 대표행 선택, snapshot 주기·보존 기간, 외부 갱신 시 `ai_status` 재계산 범위와 DEC-20 대표값 정렬이다.

## 5.9 AI 모델·입력·추론 설계 v0.2

작성일: 2026-09-07, Jira 40 결과 반영: 2026-09-10. 상태: **1차 실행 가능성 조사 완료(S15P21C206-40, develop 병합), 모델 선정·임계값은 팀 미확정**. 실행 결과·환경·라이선스 상세는 [TESS 후보 판별 모델 실행 가능성 조사](../tess-ai-model-feasibility.md)가 정본이며 이 절은 요약과 설계 원칙만 둔다. `bls_features`의 수치 출력은 모델 입력 후보일 뿐 AI 점수가 아니다. AI는 원본 BLS 품질을 통과한 모든 후보에 별도로 실행하며, 점수가 낮아도 후보표에서 자동 제거하지 않는다(POL-11·12).

### 공개 모델 1차 조사 결과 (Jira 40)

| 후보 | 확인 결과 | 1차 판정 |
|---|---|---|
| AstroNet-Triage | 공식 checkpoint `model.ckpt-14000`(약 2,026,721개 가중치)을 WSL Python 3.7.12 + TensorFlow 1.15.5 격리 환경에서 복원. 공식 test TFRecord 1,635건 CPU 7.84초·약 272.5MiB. Planetory SPOC 후보를 `global_view 201`·`local_view 61` adapter로 변환해 TOI-270 c 0.258, L 98-59 c 0.816, CM Draconis 0.998 출력. README의 local 81은 실제 checkpoint(61)와 다름 | **1차 후보 선별 연결 성공, 행성 판별 채택 보류.** 학습 라벨이 `PC/EB` 대 `junk`이므로 행성과 식쌍성을 구분하지 않는다 |
| AstroNet-Vetting | 같은 실행 환경 재사용 가능. `model_plain/dc/se/dc_se` 각 10개 checkpoint | 2순위 보류. Triage 평가 뒤 PC/EB 구분 용도로 비교 |
| ExoNet-Pytorch | 학습 코드만 공개, 사전 학습 checkpoint·추론 스크립트·라이선스 파일 없음 | 추론 보류. 새 학습은 Jira 40 범위 밖 |
| NASA ExoMiner++ | TESS 2분 파이프라인·`single`/ensemble 모델 있음. DV XML·centroid·674-bin periodogram·55×55×5 차영상 등 Planetory에 없는 입력 필요. Docker engine 미실행으로 컨테이너 시도 실패. NOSA와 metadata의 Apache 표기 불일치 | 3단계 보류 |

**점수 해석 주의.** AstroNet-Triage 점수는 행성일 확률이 아니다. 양성 라벨이 `PC/EB`(활동이 심하지 않은 식쌍성 포함), 음성이 `junk`이므로 CM Draconis 0.998은 식쌍성을 행성으로 오인한 오류가 아니라 식 현상을 강하게 포착한 정상 결과다. 확인된 행성 TOI-270 c의 0.258은 QLP 학습 전처리와 SPOC `PDCSAP_FLUX` 자체 detrending의 차이, 단일 checkpoint(공식 10개 ensemble 미적용)가 원인 후보다. 세 점수 어느 것도 서비스 임계값이 아니다.

두 AstroNet 저장소는 GPL-3.0이다. [AstroNet-Triage 저장소](https://github.com/yuliang419/Astronet-Triage), [AstroNet-Vetting 저장소](https://github.com/yuliang419/Astronet-Vetting)

NASA ExoMiner 공식 파이프라인은 TESS 2분/FFI 모드와 사전 학습 single·ensemble 모델을 제공하지만, 입력 TIC의 SPOC TCE와 DV 제품을 찾아 전처리하는 흐름이다. Planetory 자체 BLS 후보가 SPOC TCE가 아니어도 동일 feature를 생성해 추론할 수 있는지는 별도 adapter 실험이 필요하다. 저장소는 NOSA를 명시한다. [NASA ExoMiner 저장소](https://github.com/nasa/Exominer), [공식 실행 문서](https://github.com/nasa/Exominer/blob/main/docs/running-exominer-pipeline.md)

논문 정확도나 upstream 예시 결과를 Planetory 정확도로 복사하지 않는다. 데이터 분포, 전처리, 후보 생성기와 label 정의가 다르며 공개 모델의 학습 TIC가 Planetory 검증 세트와 겹칠 수 있기 때문이다.

### 모델 선정 전 필수 통과 단계

| 단계 | 확인할 내용 | 실패 시 처리 |
|---|---|---|
| 1. 자산 확인 | 코드 commit/tag, checkpoint 파일·hash, 모델 구조, 입력 이름·shape·dtype, 출력 의미 | 파일·버전이 고정되지 않으면 후보 제외 |
| 2. 권리 확인 | 코드·checkpoint·컨테이너·학습자료 각각의 라이선스, 수정·서버 사용·재배포·고지 조건 | 팀/프로젝트 사용 가능 여부가 명확하지 않으면 배포 후보 제외 |
| 3. 최소 실행 | 고정 예제 1건을 CPU에서 로드해 같은 입력의 같은 점수 재현, 의존성·메모리·시간 기록 | 로드·추론 실패 원인을 기록하고 adapter/환경 비용 평가 |
| 4. 입력 확보율 | Planetory 자체 후보마다 필수 global/local·scalar·DV·centroid·difference image를 만들 수 있는 비율 | 필수 입력이 자주 없으면 경량 후보 또는 공식 missing 처리 검토 |
| 5. 자체 후보 적용 | 외부 SPOC TCE ID 없이 자체 BLS period·epoch·duration으로 입력 생성·추론 | TCE 전용 결합이 제거 불가능하면 Planetory P0 모델 후보에서 제외 |
| 6. 라벨 검증 | TIC 단위로 분리한 CP/KP 대 FP/FA에서 정밀도·재현율·PR-AUC·추론 성공률·시간 측정 | 공개 논문 수치 대신 자체 결과로 비교 |

1~5단계가 끝나기 전에는 모델 후보를 `selected`로 표시하지 않는다. AstroNet-Triage는 1~5단계를 통과했고 6단계(라벨 검증)가 후속 Task다. ExoMiner++ catalog의 공개 점수는 POL-11에 따라 서비스 점수로 복사하지 않는다. 직접 운영한 고정 checkpoint의 결과만 `AIEvaluation`(ERD `ai_evaluations`: score·verdict·threshold_version, `ai_executions`: model_version·checkpoint·status)으로 저장한다.

### 후보별 입력 생성 계약 제안

AI 입력의 단위는 `candidate_id + publication/input snapshot + ai_input_version`이다. 같은 TIC에 후보가 여러 개면 후보마다 별도 phase-folded view를 만든다.

1. 사용할 곡선 단계와 후보의 period·epoch·duration을 명시한다.
2. period와 epoch로 곡선을 접고 transit 중심을 맞춘다.
3. 선택 모델의 정확한 bin 규격으로 전체 주기의 `global_view`와 transit 주변의 `local_view`를 만든다.
4. 빈 bin, 품질 마스크와 불확실도를 모델의 공식 학습 전처리와 같은 규칙으로 처리한다.
5. 실제 확보한 scalar·centroid·difference-image Feature만 원천·단위와 함께 연결한다.
6. 배열 shape·dtype·유한값·정규화·최소 유효 bin을 검사한 후 추론 큐에 넣는다.

화면 표시용 축약 배열과 Gold의 10분 비닝 세그먼트를 AI 입력으로 사용하지 않는다. AI 입력은 Silver 2분 원본 정제곡선에서 모델별 공식 binning 규칙으로 만든다. 모델이 기대하는 201/61 등 고정 길이는 프론트 그래프 점 수가 아니라 AI 전처리 버전의 계약이며, README 숫자가 아니라 고정 checkpoint의 실제 graph shape로 잠근다. 외부 disposition과 AI 학습 정답은 입력 Feature에 넣지 않아 label 누수를 막는다.

AI 입력 곡선 단계는 아직 확정하지 않는다. 후보가 발견된 Silver 반복 단계의 곡선과 원본 재검증 곡선 중 무엇이 선택 모델의 공식 학습 전처리와 맞는지 실행 가능성 실험에서 비교한다. 어느 쪽을 선택하든 `curve_stage`, 제거 후보 조합, `preprocessing_version`, 원본 curve hash와 입력 배열 hash를 저장한다. 사용자가 만든 EC2 온라인 잔차는 화면 탐색용이며 AI 입력을 다시 생성하거나 재추론하는 trigger가 아니다.

### 입력 스키마 제안

| 묶음 | 필드 예시 | 검증 |
|---|---|---|
| 식별·계보 | `candidate_id`, `tic_id`, `input_snapshot_id`, `curve_stage`, `iteration`, `removed_candidate_ids` | Candidate·곡선 단계·외부/라벨 snapshot이 서로 다른 버전으로 섞이지 않음 |
| 후보 기하 | `period_days`, `epoch_btjd`, `duration_hours`, `depth`, `snr`, `sde` | 단위·유한값·양수 범위, 사용한 BLS 버전 |
| 시계열 view | `global_view`, `local_view`, 선택 모델이 요구하는 odd/even·secondary view | 이름·길이·dtype·정규화와 빈 bin mask가 모델 명세와 일치 |
| 추가 Feature | transit/stellar 수치, centroid·difference image, 각 feature의 source·missing flag | 실제 값과 대체값 구분. 임의 0 채움 금지 |
| 입력 버전 | `ai_input_version`, 생성 코드 commit, 설정 hash, 각 배열 hash | 같은 입력의 재현과 변경 감지 |

필수 입력 누락은 점수 0으로 채우지 않는다. 모델이 학습 때 사용한 공식 대체 규칙이 있으면 그 규칙과 missing flag를 함께 적용하고, 그렇지 않으면 `input_incomplete`로 추론하지 않는다.

### 추론 결과와 실패 상태

| 필드 | 의미 |
|---|---|
| `ai_evaluation_id`, `candidate_id` | 결과 이력과 대상 후보 |
| `raw_output` / `score` / `score_semantics` | 모델 원출력과 어느 class의 확률·logit인지 |
| `decision_band` | `below`, `review`, `approved`; 임계값 버전 없이는 null |
| `execution_status` | `queued`, `running`, `succeeded`, `input_incomplete`, `load_failed`, `inference_failed`, `non_finite_output` |
| `model_name`, `model_version`, `checkpoint_hash`, `runtime_version` | 모델·weight·실행 환경 |
| `ai_input_version`, `threshold_version`, `run_id` | 입력·판정 기준·실행 연결 |
| `started_at`, `finished_at`, `runtime_ms`, `error_code` | 운영·재현·성능 정보 |

추론 실패, 입력 부족과 미평가는 `score=null`로 두고 서로 다른 상태를 남긴다. `0.0`은 모델이 실제로 계산한 유효한 원점수일 때만 저장한다. 동일 입력·checkpoint 재실행은 새 현재 결과를 중복 생성하지 않되 실패 뒤 성공이나 버전 변경은 별도 이력으로 보존한다.

### 검증·임계값 결정 계획

모델 선정용 조정 세트와 최종 평가 세트를 TIC 단위로 분리한다. 같은 별의 후보·Sector가 양쪽에 섞이지 않게 하고, 공개 사전 학습 모델의 알려진 학습 대상과 겹치는 TIC는 별도 `training_overlap`으로 표시한다. 평가 라벨은 모델의 학습 목표에 맞춘다. AstroNet-Triage는 `PC/EB` 대 `junk`이므로 확인 행성 후보(PC)·식쌍성(EB)·잡음(junk) 세 묶음으로 세트를 만들고 PC/EB 대 junk의 재현율·정밀도·PR-AUC를 측정한다. PC와 EB의 구분은 이 checkpoint 범위 밖이므로 AstroNet-Vetting 또는 별도 규칙으로 따로 평가한다. Planetory 서비스 판정(CP/KP를 planet, FP/FA를 not-planet)과 모델 라벨을 같은 축으로 섞지 않고, label snapshot 날짜와 매칭 근거를 고정한다. PC/APC·라벨 없음은 임계값 정답에서 제외하고 분석용 분포만 보고한다.

모델 비교 시 다음을 함께 보고한다.

- 입력 생성 성공률과 실패 사유별 건수
- 후보 전체 및 period·depth·SNR·Sector·관측 transit 수 구간별 정밀도·재현율·PR-AUC
- CP/KP와 FP/FA 각각의 혼동 행렬, calibration과 점수 분포
- 단일 CPU/GPU 기준 후보당 입력 생성·추론 시간, peak memory와 batch 크기
- 같은 입력 재실행의 점수 오차, 원본 곡선의 다중 신호·고조파가 점수에 주는 영향
- checkpoint·라이선스·운영 의존성, Spark/별도 추론 worker 연결 비용

`below/review/approved`의 하한·상한은 조정 세트의 점수 분포와 서비스가 허용할 FP/FN 비용을 팀이 정한 뒤 선택한다. 선택값을 `threshold_version`으로 잠그고 고정 평가 세트에서 1회 평가한다. upstream 논문·카탈로그의 임계값을 그대로 쓰지 않는다. AI 상태는 사용자 성과 판정이나 외부 `planet_truth`를 변경하지 않는다.

### 현재 제안과 TBD

- **완료(Jira 40):** AstroNet-Triage checkpoint 실행과 Planetory SPOC 후보 adapter(201/61) 연결. 조사 순서는 AstroNet → ExoNet → ExoMiner++로 고정했고 ExoMiner++ 우선안은 적용하지 않는다.
- **제안:** 후속은 별도 Jira·별도 브랜치 "[AI] AstroNet-Triage 성능 평가 및 후보 선별 기준 검증"으로 진행한다. TIC 단위 분리 PC/EB/junk 평가 세트, 단일 checkpoint 대 공식 10개 ensemble 비교, PC/EB 대 junk 재현율·정밀도·PR-AUC·입력/추론 성공률, QLP 대 SPOC 전처리 동등성 대조, PC/EB 구분용 Vetting 또는 규칙 비교. 임계값(`below/review/approved`)은 이 결과 이후에만 논의한다.
- **제안:** AstroNet-Triage의 서비스 내 역할을 "BLS 후보 중 잡음성 후보 1차 선별"로 둘지 팀이 결정한다. 행성 최종 판별 모델로 단독 채택하지 않는다.
- **TBD:** 최종 모델, checkpoint(단일/ensemble), GPL-3.0 코드와 checkpoint의 서버 사용·수정·재배포 조건, ExoNet 공개 checkpoint 존재 여부 확정, ExoMiner++ 재시도 필요성, missing 처리, batch/runtime, 평가 TIC 목록, 하한·상한 임계값.
- **확인 필요:** 공개 checkpoint의 학습 대상(QLP TCE)과 평가 대상 TIC 중복, AI 입력 곡선 단계(발견 단계 잔차 vs 원본), ExoMiner++의 NOSA와 Apache 표기 불일치.

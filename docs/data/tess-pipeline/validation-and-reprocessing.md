# 검증, 계약과 재처리 계획

> 상위 문서: [TESS 파이프라인 분석](README.md)

## 6. 실제 재현 결과와 한계

2026-09-06 이 작업에서 확인한 결과. 사용자 브라우저의 수동 승인 내용은 수집하지 않았으며 사용자 탐색 결과로 간주하지 않는다.

| 항목 | 결과 |
|---|---|
| 환경 | Windows, Python 3.11.4, 프로젝트 `.venv`, `uv sync --locked`, 저장소 uv.lock |
| 입력 | TOI-270 / TIC 259377017 / Sector 3·4·5 / 저장소 다운로더의 고정 SPOC LC 제품 |
| 파일 크기 | 1,998,720 + 1,897,920 + 1,923,840 = 5,820,480 bytes |
| 관측점 | 원본 57,320 → 정제 44,551 |
| 설정 | `clean` 기본값과 `bls_periodogram` 기본값, 원본 정제곡선에서 최초 BLS |
| 최상위 주기 | 5.659457432179022일 |
| 다음 두 피크 | 11.320477559694963일, 2.830791348918615일 |
| 기존 테스트 | `pytest -q`: 20 passed in 8.60s |
| 앱 초기 검증 | Streamlit AppTest 초기 실행 예외 없음, 로컬 서버 health 응답 ok |

11.3205일과 2.8308일 피크를 각각 별개의 행성 발견으로 해석하지 않는다. 첫 주기의 약 2배·1/2배에 해당하며, 고조파/별칭 검증이 필요함을 보여준다. 세 행성 복구 성공, 반복 BLS 정확도·대규모 처리 성능을 이번 결과로 주장할 수 없다. 기존 테스트는 합성 모델·기하·프리셋 등을 검증하며 실제 샘플의 전체 과학적 정확성이나 DAT-05~07 자동 반복 처리를 증명하지 않는다.

### 재현 명령

Git Bash에서 저장소 최상위 기준. 설치된 `.venv`가 있는 환경에서는 Python 실행기의 PATH 문제를 피하기 위해 가상환경 실행 파일을 직접 사용할 수 있다.

```bash
cd experiments/tess-bls
# 새 환경은 먼저 Python 3.11+ / uv 준비 후 uv sync --locked
./.venv/Scripts/python.exe download_toi270.py
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m streamlit run semi_auto_bls.py
```

앱에서 TOI-270을 선택하고 BLS 계산을 누른다. 위 실제 수치와 같은 기본 함수 경로를 재현하려면 다음을 실행한다. 앱 설정을 변경한 결과와는 다를 수 있다.

```bash
./.venv/Scripts/python.exe - <<'PY'
from pathlib import Path
from semi_auto_bls import load_tess_light_curves
from pipeline import bls_periodogram, bls_period_candidates
paths = sorted(Path('sample_raw/tess/toi270').glob('*.fits'))
signatures = tuple((str(p.resolve()), p.stat().st_mtime_ns, p.stat().st_size) for p in paths)
t, f, stats, sectors, ids = load_tess_light_curves(signatures)
print(stats, sectors, ids)
print(bls_period_candidates(bls_periodogram(t, f), count=3))
PY
```

이미 8501 포트에서 서버가 실행 중이라면 중복 실행할 필요 없다. 원본·가상환경·캐시는 Git 제외 대상이다. 이번에는 과학 처리 코드와 의존성 잠금 파일을 변경하지 않았다.

## 7. 검증 계획 제안

| 검증 | 방법 | 통과 기준·미결정 |
|---|---|---|
| 전처리 | 결측·무한대·중복 시각·Sector 경계·짧은 구간·알려진 주입 신호 | 유효성 검사·제외 사유 재현, 신호 보존 수치는 실측 후 결정 |
| 자동 후보 | 단일/다중 신호·식쌍성·무신호·관측 공백 사례 | 외부 기준/합성 정답 대비 회수·오검출·고조파율 보고, 임계값 DEC-03/05 |
| 온라인 잔차 | 빈/단일/복수·겹친 모델·잘못된 기하·버전 오류 | 시간·점·마스크 보존, 순서 독립성·왜곡·명시적 실패와 Silver–EC2 일치 검증 |
| 온라인 일치 | 빈 집합·단일·복수·선택 순서 변경, 같은 Gold와 설정 | 마스크·시간축 일치, 최대절대오차/RMSE·주기도·피크 비교; 허용 오차 합의 |
| AI | 라벨 있는 TIC 단위 분리 검증, 입력 누락·실패 포함 | 모델 적용성·입력 확보율·정밀도·재현율·추론 시간, 검증 데이터로 임계값 결정 |
| 갱신·복구 | 중복 실행·중간 실패·새 Sector·외부 라벨 변경 | 후보 ID/이벤트 중복 방지, 기존 공개본·성과 유지, 재개 조건 구분 |
| Spark | 같은 작은 고정 입력을 로컬과 Worker에서 실행 | 산출물 동등성, 실패 TIC 재처리, 메모리·처리 시간 측정; 전체 collect 금지 |

AI 임계값 결정용 데이터와 최종 평가 데이터를 구분하고 동일 TIC의 후보가 양쪽에 섞이는 누수를 방지하는 안을 검토한다. 아직 모델이나 정확도 목표를 확정하지 않는다.

### 7.1 전처리 설계안 v0.1 — 담당자 검토용

작성일: 2026-09-07. 상태: **윤성용 검토 전 제안, 팀 미승인**. [5.1~5.3절](preprocessing.md)은 실제 파일·기존 코드 확인 기록이고, 이 절은 서비스 전처리의 선택 기준과 후속 실험을 제안한다. 여기의 방법·수치·일정은 승인된 서비스 정책이 아니다.

#### 목표와 범위

전처리의 목표는 관측 잡음과 완만한 밝기 변화를 줄이면서 후보 탐색에 필요한 짧은 감광의 깊이·지속시간·시각을 보존하는 것이다. 어떤 점을 왜 제외했고 어떤 설정으로 처리했는지 재현할 수 있어야 한다. 전처리 결과만으로 행성 여부를 판정하지 않는다.

입력은 원천 제품과 checksum이 고정된 TESS SPOC LC, 출력은 TIC별 정제곡선과 관측점 마스크·품질 보고서다. 이번 기획에서는 처리 단계·실패 경계·비교 실험·출력 계약을 작성한다. 방법 비교 구현, 전체 배치 실행과 운영 임계값 확정은 후속 Task에서 수행한다.

#### 처리 단계와 선택안

| 단계 | 기존 PoC에서 확인한 사실 | 서비스 설계 제안 | 검증·결정할 것 |
|---|---|---|---|
| 입력 확인 | TIC·Sector 확인, 같은 TIC 여부와 Sector 중복 검사 | 제품·시간계·단위·필수 컬럼을 확인하고 누락을 명시적 실패로 기록 | 누락 시 복구 가능 범위, 다른 제품이 중복될 때 선택 정책 |
| 관측점 선택 | QUALITY=0, 시간·flux dropna | 이 규칙을 비교 기준으로 고정. NaN·Inf 검사와 Sector 시작·궤도 근점 추가 마스크를 별도 사유로 기록하고 원본 행 대응 보존 | 품질 비트별 허용 범위, Sector 시작·근점 마스크의 실제 폭과 근거. 무조건 더 많은 점을 남기는 것을 개선으로 보지 않음 |
| 시간·중복 처리 | Sector 내 시간 정렬, 중복 시각 처리는 명시되지 않음 | 시간 정렬 후 중복을 탐지해 기록. 임의 평균이나 삭제 없이 처리 정책 검토 | 같은 시각의 제품·cadence 차이, 대표 관측점 선택 또는 보류 조건 |
| 정규화 | Sector별 유한한 양수 중앙값으로 나눔 | 우선 비교 기준으로 유지하고 중앙값을 함께 저장 | 비정상 중앙값은 실패 보고. 실제 관측·감광 범위에서 기준이 적절한지 비교 |
| 구간 분리 | Sector 결합 뒤 시간 공백 0.5일 초과에서 분리 | Sector 경계에서도 반드시 분리하고 Sector 내부 시간 공백을 추가로 구분하는 안 비교 | 공백 기준값, 짧은 구간 처리, 경계 부근 신호 왜곡 |
| 디트렌딩 | 기본 2일 Savitzky–Golay 창, 짧은 구간은 중앙값. 추정 trend로 flux를 나눔 | DAT-02의 예상 최대 감광 길이 3배 이상 하한을 지키며 구간 분리와 창 길이를 비교. trend가 비유한·0 이하인 경우 실패/마스크 기록 | 예상 최대 감광 지속시간, 실제 창, 짧은 구간 최소 길이·대체 처리 |
| 이상치 처리 | 위쪽만 기본 5-sigma clipping | 기존 처리를 비교 기준으로 두고 제거점 위치·개수 기록. 밝기가 낮다는 이유만으로 하방 clipping을 추가하지 않음 | 실제 잡음 감소, 경계 부작용, 임계값과 제외 사유 |
| 결합·검수 | 정제 배열과 전체 요약 반환 | Sector별 처리가 검증된 곡선을 같은 TIC·시간 기준으로 결합. 부족/실패와 후보 0개를 분리 | 일부 Sector 실패 시 TIC 전체 보류 또는 부분 처리 정책 |

최소 관측점 500, 공백 0.5일, 창 2일, 상방 5-sigma는 모두 **기존 코드의 기본값**이다. 과학적 최적값이나 서비스 확정값으로 제시하지 않는다.

#### 비교 실험 계획

초기 재현 입력은 checksum을 확인한 TOI-270 Sector 3·4·5로 제안한다. 이 별 하나의 결과를 모든 별에 일반화하지 않으며, 후속 평가에는 다양한 감광 지속시간·관측 공백·식쌍성·무신호 사례가 필요하다. 추가 대상과 실제 무신호 여부의 검증 방법은 실험 착수 전에 정한다.

| 실험 | 고정할 것 | 바꿔볼 것 | 확인할 결과 |
|---|---|---|---|
| A. 기준 결과 확보 | 입력 제품, 기존 코드·설정, 품질·결측 처리 | 없음 | 전 단계 실행 기록, 단계별 행 수·trend·정제곡선·시간·버전 |
| B. 품질 선택 비교 | 정규화·디트렌딩 등 나머지 설정 | QUALITY=0과 공식 플래그 의미를 검토해 정한 선택 마스크 | 남는 점, 결측, 잡음, 감광 회수 차이. 비교 마스크는 실행 전에 값과 근거 기록 |
| C. 구간 경계 비교 | 품질 선택·정규화·평활 설정 | 기존 공백 기준만 적용 / Sector 경계도 추가 적용 | 경계 주변의 가짜 변화, 감광 깊이·지속시간 왜곡 |
| D. 평활 창 비교 | 입력·품질·구간 경계·측정 방법 | 기존 2일 창과 감광 지속시간에 근거해 선정한 창 후보 | 잡음 감소와 감광 보존의 균형. 후보 창 수치는 실험 착수 전 기록 |
| E. 실패·경계 사례 | 비교 설정·재현 입력 | 짧은 구간, 중복 시각, NaN·Inf, 비정상 trend 등 고정 사례 | 누락 없는 실패 사유, 원본 인덱스 대응, 결과에 잘못된 수치가 섞이지 않는지 |

한 번에 한 요인을 바꾸며 품질 필터와 디트렌딩을 동시에 바꿔 효과를 혼동하지 않는다. 선택한 조합은 별도 검증 입력에서도 확인한다. 설정을 고르는 데이터와 최종 평가 데이터를 구분하고, 실제 감광 구간은 출처·기준값과 함께 고정한다. 정답이 불명확한 원본 곡선의 전후 모양만으로 신호 보존을 판정하지 않는다.

#### 평가 기준 제안

| 평가 항목 | 측정 방법 제안 | 주의할 해석 |
|---|---|---|
| 감광 보존 | 알려진 깊이·지속시간·epoch를 가진 합성 신호를 전처리 전에 주입하고 같은 측정법으로 회수값 비교. 주입하지 않은 대응 입력도 처리 | 실제 제품으로 들어오기 전 SPOC 처리 손실까지 검증하는 실험은 아님. 실제 샘플 관찰과 주입 실험 결과를 구분 |
| 잡음 감소 | 미리 고정한 감광 바깥 구간에서 같은 시간 표본의 robust scatter(MAD 기반 흔들림 크기) 비교 | 감광을 지우거나 점을 많이 버려 얻은 낮은 잡음만으로 우수 판정하지 않음 |
| 관측점 유지 | 원본 대비 단계별 사용·제외 행 수와 이유, 감광 구간의 남은 점 수 | 전체 유지율이 높아도 감광 구간만 손실될 수 있음 |
| 경계 왜곡 | 같은 공백·Sector 경계 주변 구간의 원본/정규화/trend/정제 그래프와 합성 신호 회수값 비교 | 경계를 연결한 가짜 선이나 처리로 새로 생긴 급변을 구분 |
| 후속 탐색 영향 | 같은 BLS 설정으로 주입 신호 회수율·주기 오차·별칭 선택·무신호 입력의 오검출 비교 | 전처리 비교 뒤 후속 실험으로 수행. 최초 BLS 최고 피크 하나만으로 판정하지 않음 |

허용 깊이·지속시간 오차, 최소 유지점, 허용 오검출 등 통과 수치는 **TBD**다. 실험 전에 평가할 신호 범위와 잠정 통과 기준을 리뷰하고, 설정 선택용 결과로 보정한 뒤 별도 평가 세트로 확인하는 안을 제안한다. 결과를 본 뒤 유리한 지표만 골라 채택하지 않는다.

#### 출력 및 실패 계약 제안

[5절](README.md)의 스키마를 보완하는 최소 필드안이다. Gold 제공 범위는 요구사항 명세서 v1.0 EXP-01·DAT-11과 ERD v1.0 묶음 B를 그대로 적용한다. 아래 객체는 Silver 전처리 산출물이며, Gold로 가는 것은 이를 비닝한 `light_curve_segments`다. 배열은 Publisher가 PostgreSQL에 직접 적재하며 shape별 파라미터·호환 방식은 후속 계약에서 김동혁·강재민과 검토한다. 내부 디버깅용 trend와 품질 마스크는 v1.0의 Gold 자산이 아니다.

| 대상 | 필드·타입·nullable 제안 | 의미 |
|---|---|---|
| 관측점 식별 | `product_id:string`, `source_row_index:int64`, `tic_id:string`, `sector:int` — 모두 필수 | 다른 Sector의 같은 행 번호와 혼동하지 않고 원본까지 추적 |
| 원천 수치 | `time_days:float64?`, `source_flux:float64?`, `original_quality:int64` | 결측 행도 식별·사유를 보존. flux 단위 e-/s, 시간 메타는 제품 단위 연결 |
| 사용 여부 | `valid:bool`, `exclusion_reasons:list<string>` — 필수 | 품질·결측·무한대·이상치 등 사유. 유효 행은 빈 목록, 사유명은 미확정 |
| 처리 수치 | `normalized_flux:float64?`, `cleaned_flux:float64?` | 단위 없는 상대 밝기. 해당 단계에서 처리할 수 없는 행은 null과 사유 기록 |
| 내부 계산 근거 | `segment_id:string?`, `trend:float64?`, Sector별 `normalization_median:float64?` | 구간·추세·정규화 기준 재현용. 검증 실패 시 상태와 연결 |
| 실행 메타 | `input_snapshot_id:string`, `preprocessing_version:string`, `run_id:string` — 필수 | 입력 해시 목록·품질 마스크 값·공백 기준·창·clipping 설정·코드/의존성 버전을 참조 |
| 처리 결과 | `processing_status:string`, `failure_reasons:list<string>` — 필수 | 성공·입력 부족·처리 실패를 구분하는 enum 제안. 후보 탐색 결과와 별개 |

전체 관측점과 마스크를 유지하는 표현을 제안하되 [5절](README.md)의 별도 마스크 표/동일 행 표현 선택은 아직 미결정이다. 원본 FITS는 불변으로 보존한다. 새 산출물이 검증에 실패하면 기존 공개본을 교체하지 않는다.

#### 담당·일정·리뷰 요청안

- 윤성용: 전처리 설계 검토, 비교 실험 입력·방법·평가표 작성, 후속 실험 수행과 선택 근거 보고.
- 김동혁: 원천·정제·마스크 저장 계약과 실행/재처리 단위 검토.
- 강재민·백지웅: 비닝 세그먼트(`start_btjd`·`bin_minutes`·NaN·`gaps`)·시간·flux 단위가 온라인 계산과 화면에서 일관되게 사용되는지, 10분 비닝에서 짧은 통과의 위상 구간 선택과 근거 체크가 가능한지 검토.
- 일정 제안: 29번 리뷰 전에 처리 흐름·출력 계약·실험 계획을 검토하고, 구현 착수 전 품질 마스크·평가 입력·잠정 판정 기준을 기록한다. **실제 달력 날짜·후속 Task 담당 확약은 아직 미합의**이며 29번 완료 전 기한 표에 채운다.
- 리뷰 질문: 이 목표·단계 구분으로 진행할지, 부분 Sector 실패를 어떻게 처리할지, 관측점/마스크 표현을 무엇으로 할지, TBD를 어느 후속 Task에서 언제 결정할지 확인한다.

이 설계안 작성만으로 품질 정책이나 최적 전처리 방법을 확정하지 않는다. 29번 완료 판단은 실제 Jira 조건과 교차 리뷰·문서 MR·결과물 등록을 함께 확인한다.

### 7.2 Silver 내부와 Gold 제공 경계 v0.3 — 명세서 v1.0·ERD v1.0 반영

작성일: 2026-09-07, v0.12 대조: 2026-09-09, v1.0 반영: 2026-09-10. Silver는 GCP HDFS의 배치 계산·진단·재처리용이고 온라인 API가 직접 읽지 않는다. Gold는 EC2 PostgreSQL의 ERD 묶음 B 테이블(`publication_bundles`, `light_curve_segments`, `periodograms`, `candidates`, `candidate_aliases`, `external_signal_references`, `candidate_dispositions`, `candidate_status_history`, `ai_executions`, `ai_evaluations`)이며 배치가 적재하고 서비스는 읽기만 한다. DAT-05에 따라 단계별 잔차곡선·주기도 배열은 지속 저장하지 않는다. 캐시는 Redis로 확정됐고(DAT-14), 배열 적재 경로·동시 상한·용량 실측은 DEC-35의 별도 아키텍처 Task에서 정한다.

| 자료 | Silver 계산·진단 | Gold 제공 | 이유 |
|---|---:|---:|---|
| 원천 행 대응·Sector별 trend·정규화 통계·품질 마스크·제외 상세 | O | X | 전처리 진단과 재현용. 품질 플래그는 배치에서만 소비하고 화면에 전달하지 않음(POL-13) |
| 2분 원본 정제곡선(전 관측점) | O | X | 탐색 BLS·AI 입력·discoverable 재계산의 Silver 입력. Gold에는 비닝본만 |
| 별·섹터 세그먼트로 10분 비닝한 곡선(`flux real[]`, NaN 빈 bin, `gaps`, `flux_scatter` 스칼라, `binning_revision`) | O | O | 화면 접기와 EC2 잔차 계산의 canonical 입력(EXP-01). 판에 묶이지 않고 manifest가 세그먼트 id 집합을 참조. 별도 200-bin 배열을 분석 원본으로 사용하지 않음 |
| `fold_reference_time_btjd` | O | O | 브라우저·서버·잔차 공통 기준 시각. 위치(판 vs 세그먼트)는 확인 필요 |
| 원본 정제곡선의 BLS periodogram(판 단위, `n_periods` 5,000·`power real[]`) | O | O | 최초 사용자 탐색 제공. 주기 격자 배열은 저장하지 않고 manifest 규칙으로 계산 |
| 배치 단계별 잔차곡선·잔차 periodogram 배열 | 실행 중 O, 지속 저장 X | X | DAT-05~07 후보 탐색·제거 QA용 내부 계산. 단계별 배열은 저장하지 않고 Gold에도 넣지 않음 |
| raw peak·품질 실패 후보·반복 종료 진단 | O | X | 임계값 검증과 운영 진단용 |
| 품질·transit model·원본 재검증을 통과한 후보 | O | O | 사용자 매칭 후보표의 기준 |
| 후보별 `transit_model` JSONB 파라미터·`residual_model_version` | O | O | 파일 참조가 아닌 후보표 인라인 파라미터(DAT-10 v0.14). EC2가 임의 제거 조합을 같은 수식으로 재생성 |
| `discoverable` (제공 해상도·격자 기준) | O | O | SUB-11 탐색 완료·재개 판정 입력. 비닝 revision·격자 변경 시 재계산 |
| 주기 격자 간격·미세 조정 허용 폭 규칙 | O | manifest | EXP-05의 후보별 period_min/max/step을 서버가 계산하는 근거 |
| transit model 검증 배열·중간 최적화 로그 | O | X | 온라인 잔차 수식 검증용. Gold에는 상태·요약·버전만 |
| 외부 raw snapshot·미매칭 전체 행 | O/Raw | X | 원천 재현·운영 review용 |
| 후보에 연결된 외부 참조·통합 disposition | O | O | 자체 BLS·AI와 구분해 사용자 결과에 제공 |
| AI 입력 tensor·중간 activation | O | X | 모델 검증·재추론용 내부 자료 |
| 후보별 AI 원점수·상태·모델/입력/임계값 버전 | O | O | 제출 후 참고 결과 제공 |
| bundle manifest·배열 checksum·모든 계약 버전·격자 규칙 | O | O | 원자적 공개와 혼합 버전 방지 |

Silver 내부 잔차는 반복 후보 탐색과 제거 QA를 위해 실행 중 계산하며 단계별 곡선·주기도 배열을 지속 저장하지 않는다. 제거 QA 요약·종료 사유·후보 반복 단계·모델과 설정 버전은 재현 근거로 남긴다. Gold에는 **비닝 세그먼트·`fold_reference_time_btjd`·판별 원본 주기도·후보표(`transit_model` 파라미터·`discoverable` 포함)·AI 결과·외부 상태·manifest(계산 버전·격자 규칙)** 를 넣고, 사용자용 단계별 잔차·주기도, 품질 마스크, 시각·격자 배열, 오차 배열은 넣지 않는다. EC2는 현재 판의 세그먼트와 사용자가 고른 제거 조합으로 온라인 잔차를 계산하고 Redis에 캐시한다. 새 판이 `current`가 되면 이전 판은 곧바로 `archived`가 되어 그 판의 주기도 행과 캐시를 정리하며, 세그먼트는 revision이 같으면 판 사이에 공유한다. 데이터 가이드의 `lightcurve-ui`·`periodogram-ui`는 실제 계약을 확정하기 전 예시이므로, 분석 canonical 세그먼트와 화면 최적화 파생물을 혼동하지 않는다.

#### Gold 계약 — ERD v1.0 테이블 기준

| ERD 테이블 | 윤성용이 채워야 하는 과학 필드·규칙 | 남은 결정 |
|---|---|---|
| `light_curve_segments` | `tic_id`, `sector`, `binning_revision`(원천·전처리·비닝 설정 버전), `start_btjd`(첫 bin 시작), `bin_minutes`(기본 10, 세그먼트 20,000점 초과 시 확대·실제 간격 기록), `n_points`, `flux real[]`(빈 bin NaN, 균등 격자 유지), `flux_scatter`(세그먼트당 산포 스칼라), `gaps`(빈 구간 인덱스). `UNIQUE(tic_id, sector, binning_revision)`, 행 불변 | 비닝 간격 실측, 산포 정의(MAD 등), bin 대표값(중앙값/평균), 부분 bin 처리 |
| `periodograms` | 판 단위. `period_min_days`, `period_max_days`, `n_periods`(5,000), `power real[]`. 격자는 manifest의 로그 등간격 규칙으로 계산 | 격자 범위·간격 규칙, 목적함수, `periodogram_config_version` 정의. 탐색용 BLS 격자와 분리 |
| `candidates` | `id`(판 간 유지), `status`(active/retired), `updated_bundle_id`, `removal_step`, `period_days`, `epoch_btjd`, `duration_hours`, `depth_ppm`, `bls_power`, `transit_model` JSONB, `discoverable`, `is_confirmed`. 단위는 열 이름으로 고정(일·BTJD·시간·ppm) | `transit_model` 필드·shape·`residual_model_version` 정의, 판 사이 후보 동일성 허용 오차, 미세 조정 허용 폭 규칙 |
| `candidate_aliases` | `multiplier`, `alias_period_days` | 추가 고조파(DEC-05) |
| `external_signal_references`, `candidate_dispositions`, `candidate_status_history` | [5.8절](external-sources-and-ai.md)의 원천·외부값·disposition·조회일, DAT-09 통합 규칙·`rule_version`, 변경 이력 | DEC-20 대표값 정렬 |
| `ai_executions`, `ai_evaluations` | [5.9절](external-sources-and-ai.md)의 `model_version`·`checkpoint`·`status`, 후보별 `score`·`verdict`(rejected/hold/approved)·`threshold_version`. 실패는 score null + 상태 | 모델·임계값(DEC-02·04) |
| `publication_bundles` | `bundle_version`, `status`(staging/current/archived), `manifest` JSONB(세그먼트 id 집합, 배열 checksum, `residual_model_version`, `periodogram_config_version`, 비닝 규칙, 격자 규칙, 미세 조정 허용 폭, 곡선 단계 규칙), `fold_reference_time_btjd`, `base_days` | fold 기준 시각 위치(판 vs 세그먼트)와 산정 입력. Publisher가 직접 적재하고 같은 트랜잭션에서 current 전환 |

nullable 값은 의미가 명확해야 한다. AI `score=null`은 `ai_executions.status`로 미평가·입력 부족·실패를 구분하고, 세그먼트의 NaN은 빈 bin이며 `gaps`가 그 위치를 설명한다. 단위는 ERD 열 이름에 고정되어 있으므로 period/day와 duration/hour를 수식에서 암묵적으로 섞지 않는다.

스키마 변경은 ERD와 manifest의 버전을 올리고 소비자 호환성, 기존 판 읽기 가능 여부, 재처리 범위를 MR에 기록한다. 비닝·격자 규칙 변경은 새 `binning_revision`과 새 판으로만 반영하고 기존 세그먼트 행을 덮어쓰지 않는다.

### 7.3 재처리·갱신·재개 조건 v0.1

재처리는 계산을 다시 하는 일이고 재개는 완료했던 사용자의 별을 다시 분석 가능 상태로 여는 사건이다. 외부 상태 갱신은 후보 설명이 바뀌는 일이며 세 가지를 같은 이벤트로 합치지 않는다.

| 변화 | 재사용 가능 범위 | 다시 계산·검증할 범위 | 재개 판단 |
|---|---|---|---|
| 새 Sector LC 추가 | 기존 Sector 세그먼트 행은 revision이 같으면 재사용(판 사이 공유) | 새 Sector 처리·세그먼트 INSERT 후 TIC 결합, 원본 periodogram부터 내부 반복 BLS·후보 병합·discoverable·외부 매칭·AI·새 판. `base_days`·fold 기준 시각 갱신 | 새 고유 후보 추가 또는 기존 후보 `discoverable false→true`일 때만 재개 이벤트 |
| 비닝 간격·주기 격자 규칙 변경 | 2분 원본 정제곡선·탐색 BLS 후보는 재사용 | 새 `binning_revision` 세그먼트, 판별 주기도, discoverable 재계산을 함께 만들어 원자적으로 새 판 전환(DAT-07) | discoverable이 바뀐 후보는 재개 이벤트. 규칙 변경 자체로는 재개하지 않음 |
| 같은 Sector 제품/Data Release 교체 | checksum이 같은 입력은 재사용 | 바뀐 제품의 원천 검증부터 TIC 하위 전 단계와 새 bundle | 이전/새 후보 차이로 위 조건 평가 |
| 품질·전처리 설정 변경 | Raw/Bronze와 무관한 외부 snapshot | 영향 TIC의 전처리부터 BLS·AI·bundle | 새 후보/새 discoverable이 있을 때 평가. 설정 변경 자체로 재개하지 않음 |
| BLS·품질·고조파 규칙 변경 | 정제곡선 재사용 | periodogram/후보 탐색부터 외부 매칭·AI·bundle | 후보 차이와 discoverable 차이로 평가 |
| transit/residual 모델 변경 | 원본 정제곡선은 재사용 가능. periodogram·후보·AI 재사용 범위는 모델이 반복 제거와 AI 입력에 미치는 영향에 따라 결정 | 영향 반복 단계부터 제거·후속 BLS·후보·AI·Gold 모델·bundle, Bundle별 cache 격리와 Silver–EC2 재검증 | 모델 변경만으로 재개하지 않음 |
| AI checkpoint·입력·임계값 변경 | LC·BLS·후보·외부 연결 재사용 | AI 입력/추론 또는 판정부터 bundle | AI 변화만으로 완료 별을 재개하지 않음. 상태 이력 생성 |
| TIC 별 파라미터 변경 | 광도곡선 전처리는 값 사용 여부에 따라 재사용 | 해당 Feature를 쓰는 BLS/AI 단계와 표시 메타·bundle | 후보/discoverable 변화가 있을 때만 |
| TCE/TOI/Archive/ExoFOP 갱신 | LC·BLS·모델·기존 AI 원점수 | 외부 정규화·매칭·통합 상태·bundle 검증 | 외부 라벨만으로 재개하지 않음. v1 성과·등급·통계 과거값 유지 |
| Gold 전송·검증 실패 | 성공한 Silver와 기존 EC2 current | 실패 전달/검증 단계만 재시도 | 공개 전이므로 재개 이벤트 없음 |

각 실행은 `run_id`, 원인(`trigger_type`), 영향 TIC·Sector, 시작 단계, 입력/설정 버전, 재사용한 산출물, 성공·실패 단계와 이전/새 bundle을 기록한다. 같은 trigger ID와 결과 차이를 다시 처리해 후보·재개 알림을 중복 생성하지 않는다.

부분 실패한 새 bundle은 공개하지 않고 기존 `current`를 유지한다. 실패 TIC만 재처리할 수 있어도 전체 bundle manifest의 파일·행 수·참조 무결성을 다시 검증한 뒤 전환한다. 완료 별의 재개 이벤트에는 원인이 된 `candidate_id`, 이전/새 bundle, `candidate_added` 또는 `discoverable_changed`, 발생 시각을 포함하는 안을 제안한다.

### 7.4 Silver–EC2 잔차·주기도 일치 검증 v0.1

목표는 같은 Gold 입력과 버전에서 Silver 기준 계산과 EC2 온라인 계산이 허용 오차 안에서 같은 잔차와 periodogram을 내는지 확인하는 것이다. 단순히 그래프가 비슷해 보이는지는 통과 근거가 아니다.

EC2 상태는 `QUEUED → RESIDUAL_CALCULATING → RESIDUAL_READY → PERIODOGRAM_CALCULATING → COMPLETED/FAILED`를 사용한다. 잔차 주기도가 잔차곡선보다 먼저 준비될 수 없으며, `RESIDUAL_READY`에서 곡선을 먼저 노출할지는 벤치마크로 정한다. 캐시 키는 `(tic_id, publication_bundle_id, 정렬한 제거 후보 ID 목록, residual_model_version, periodogram_config_version)`이고 상태와 결과를 Redis에 둔다. 세션은 항상 `current` 판을 쓰며 새 판이 공개되면 최신 판으로 다시 불러온다. 새 판은 새 키를 사용하고, 판이 `archived`가 되면 그 판의 캐시를 정리한다. 같은 키를 여러 서버가 동시에 요청하면 한 서버만 계산하도록 잠근다.

#### 고정 입력과 비교 사례

- 실제 다중 후보 사례 후보: TOI-270 TIC `259377017`, Sector 3·4·5. 현재는 최초 BLS만 확인했으므로 검증용 후보 집합은 원본 periodogram 상위 피크의 품질·고조파 검증 뒤 고정한다.
- 단일 후보·겹친 후보·깊은 식쌍성·빈 후보 집합을 작은 합성 fixture로 추가한다.
- 동일한 판의 비닝 세그먼트(`start_btjd`·`bin_minutes`·`flux`·NaN 위치), 정렬한 후보 ID와 `transit_model` 파라미터, `residual_model_version`, `periodogram_config_version`, manifest 격자 규칙을 양쪽에 전달한다.
- Silver 기준 결과도 같은 비닝 세그먼트에서 계산한다. 2분 원본에서 계산한 잔차와 비교하지 않는다.
- PostgreSQL `real[]` 적재·조회를 실제로 거친 뒤 계산해 float32 저장·정렬·NaN 변환 문제까지 포함한다.

| 사례 | 제거 후보 입력 | 기대 사항 |
|---|---|---|
| 원본 | 빈 집합 | valid flux가 Gold 원본과 같고 원본 periodogram 재현 |
| 단일 | 후보 A만, 후보 B만 | 선택한 모델만 적용, 점·시간·마스크 수 불변 |
| 복수 | A+B, 가능한 모든 작은 조합 | 곱셈 모델과 baseline 규칙 동일 |
| 순서 | A+B와 B+A | 정렬 cache key와 수치 결과 동일 |
| 겹침 | 같은 시각에 두 모델이 적용되는 후보 | 관측점 삭제 없이 모델 곱으로 나눔 |
| 오류 | 알 수 없는 model version/shape, 0 이하 모델, 누락 candidate | 잘못된 곡선 대신 명시적 실패 상태 |

#### 비교 순서와 판정

1. 세그먼트 집합, `start_btjd`, `bin_minutes`, `n_points`, NaN 위치와 배열 길이는 **정확히 일치**해야 한다.
2. 같은 후보 ID 집합·정렬·모델 파라미터·baseline·dtype·수식이 사용됐는지 manifest를 비교한다.
3. valid 점 잔차 flux의 `max_abs_error`, `RMSE`, 상대오차 분포와 비유한값 수를 계산한다.
4. 같은 period grid에서 power 배열의 최대절대오차·RMSE를 계산하고 상위 피크의 grid index·period·순위가 유지되는지 확인한다.
5. 같은 요청 재실행과 Redis cache hit가 같은 hash/수치를 반환하는지 확인한다. 새 판은 새 cache key를 사용하고 다른 판·계산 버전 사이에 cache를 재사용하지 않아야 한다. 판이 `archived`가 되면 그 판의 cache가 정리되고, Redis가 비면 같은 결과를 다시 계산하는지 확인한다.
6. 하나라도 구조 불일치, 새 NaN/Inf, 허용 오차 초과, 의미 있는 상위 피크 변경이 있으면 실패로 기록한다.

flux와 power의 허용 오차는 **TBD**다. 김동혁의 온라인 계산 문서는 잔차 float64 유효점 `rtol=1e-8`, `atol=1e-10`을 시작값으로 두고 과학 담당 검토 후 확정하도록 했다. 먼저 같은 Python 커널·같은 CPU에서 반복해 `real[]`(float32) 저장·조회 전후의 수치 바닥을 측정하고, GCP amd64 배치와 EC2 x86_64 Python Worker의 차이를 측정한다. 그 분포보다 여유가 있으면서 과학적 후보 순위를 바꾸지 않는 잠정값을 등록한 뒤 별도 fixture에 적용한다. 결과를 본 뒤 각 사례마다 다른 허용치를 임의로 쓰지 않는다.

검증 보고서는 bundle/config/model hash, 실행 환경·dtype, 사례별 배열 크기, 오차 지표, 상위 피크 비교, cache 결과와 pass/fail 사유를 포함한다. canonical Silver 결과 생성과 과학적 수식은 윤성용, Gold 직렬화·전송은 김동혁, EC2 계산·cache와 API 상태는 강재민이 함께 검토하는 안을 제안한다.

## 8. 명세서 미결정·후속 Task 안건과 기한 제안

| 안건 | 제안·준비물 | 결정 담당 / 기한 제안 |
|---|---|---|
| DEC-01 데이터 범위 | 이번 TOI-270은 재현 샘플일 뿐 서비스 범위 아님. 제품·cadence·Sector·대상 수 확정 | 윤성용·김동혁 / 후속 Task 등록 때 실제 기한 확정 |
| DEC-02/04 AI | 체크포인트·입력·라이선스 실행 가능성부터 확인, 점수 기준은 검증 후 | 윤성용·팀 / 모델 검증 Task와 실제 기한 확정 필요 |
| DEC-03/05/06 분석 | BLS 설정·반복 제거·제거 QA·종료·고조파·후보 병합과 Silver–EC2 잔차 모델 검증 | 윤성용, 매칭·온라인 잔차는 강재민 / 벤치마크 Task와 실제 결정일 팀 확인 필요 |
| DEC-20 외부 대표값 | 자체 BLS값을 기본으로 두고 외부값 덮어쓰기 여부 임의 확정 금지 | 윤성용·강재민 / 외부 구현 착수 전 결정, 날짜 팀 확인 필요 |
| DEC-35 온라인 계산 | Python Worker·Redis·Publisher 직접 적재는 종결. 남은 것은 동시 상한·시간 목표·용량·허용 오차. `joint_refit`이 아닌 `libs/astro-kernel`의 고정 모델 제거 규약 사용 | 김동혁·윤성용·강재민 / 후속 실측 Task에서 기한 확정 |
| 비닝 간격·discoverable 해상도 | 대상 별의 가장 짧은 통과 지속시간 실측, 10분 bin에서 위상 구간 선택·근거 체크·봉우리 판정 가능성(ERD 미결 10, DAT-07) | 윤성용, 화면은 백지웅 / DEC-01 데이터 범위 결정과 같은 Task |
| 무신호 별 비율 | 자체 BLS 채택 신호 0개 별의 비율 실측, DEC-16 시나리오 충족 여부, 높으면 DEC-03 임계값 조정(10.1 안건 12) | 윤성용·김동혁 / DEC-01 작업에 포함 |
| `transit_model` 스키마·격자 규칙 | JSONB 필드·shape·`residual_model_version`, 판별 주기도 격자(로그 등간격·5,000점)·`periodogram_config_version`, 미세 조정 허용 폭 산출식 | 윤성용·강재민 / Gold 적재 계약 MR 전 |
| 후보 동일성 | 새 판 적재 시 기존 `candidates.id`를 유지할 주기·중심 시각 허용 오차(ERD 미결 2) | 윤성용·강재민 / 후보 병합 벤치마크와 함께 |
| 스키마·갱신 | [5절](README.md)·7.2·7.3절 필드·후보 ID·빈 결과/실패·재개 변경 목록, fold 기준 시각 위치(판 vs 세그먼트) | 윤성용·강재민, 이벤트 소비자 / 인터페이스 Task 등록 때 기한 확정 |
| 그래프 단위 | 시간계·day/hour·ppt/ppm·비닝 세그먼트와 NaN·`gaps`·화면 축약 | 윤성용·강재민·백지웅 / 첫 샘플 전달 전, 날짜 팀 확인 필요 |

문서 적용·인터페이스 확인 요청:

- 요구사항 명세서 v1.0의 DAT-05~07 내부 반복 BLS·제공 해상도 discoverable, DAT-10·11의 세그먼트·비닝·`transit_model` 파라미터, DAT-14의 Redis 캐시·현재 판 재로드는 확정 요구사항으로 적용하며 다시 합의하지 않는다. Silver 반복 중간 배열은 저장하지 않으며, 명세서가 수치를 정하지 않은 종료·제거 QA·비닝 간격·격자 규칙만 후속 벤치마크에서 정한다.
- ERD v1.0의 PostgreSQL Gold 배열 결정과 2026-09-15의 Publisher 직접 적재·Python Worker 결정을 아키텍처·온라인 계산·데이터 관리 문서에 반영했다.
- 명세서 DAT-11(세그먼트별 `fold_reference_time_btjd`)과 ERD(`publication_bundles` 판 단위 값)의 불일치, 산정 입력(비닝 전/후 시각)을 강재민과 확정한다.
- DAT-15의 외부 갱신에 `ai_status`가 포함된 문구와 DAT-09의 외부 상태/AI 분리 원칙에 대해, 재추론 없는 외부 라벨 변경 시 갱신 필드 범위를 확인한다.

## 9. 후속 구현 Task 분할안

> 후속 Task 의 최신 정리(실험·구현 두 층, 착수 순서 P1~P3 와 명세 필수 여부, 착수 조건·완료 검증 조건, Epic 묶음 제안, Task 별 목적)는 [천문 데이터 처리·AI 후속 Task 계획](../../project/tess-processing-ai-task-plan.md)(`S15P21C206-46`)에서 관리한다. 아래 표는 29번 작성 시점의 초안이며, 두 문서가 다르면 계획 문서를 따른다.

아래는 미등록 제안이며 29번 아래 Sub-task를 만들지 않고 적절한 Epic 아래 Task로 연결한다. Task별 브랜치·MR 1개, 일반 MR 승인 1명 이상을 따른다.

**중복 확인(2026-09-10):** Jira 프로젝트 전체 35건과 대조한 결과 아래 제안과 같은 범위의 Task는 없다. 완료된 `S15P21C206-18`(반자동 BLS PoC 구현)·`S15P21C206-40`(AI 모델 실행 가능성 검증)은 선행 결과로 참조한다. 강재민의 `S15P21C206-31`(탐사 제출·후보 매칭·성과 도메인 분석)·`S15P21C206-36`(API 명세서)과 백지웅의 `S15P21C206-32`(광도곡선 분석·제출·결과 화면 요구사항 분석)는 후보 동일성·`transit_model`·세그먼트 화면 계약의 인터페이스 상대 Task로 연결한다. 구현 Task를 담을 Epic은 아직 없다(진행 중 Epic은 `S15P21C206-1`·`S15P21C206-26` 기획 Epic만). 등록 시 Epic 신설 여부를 팀과 정한다.

| 제안 Task | 선행 | 산출물·완료 조건 |
|---|---|---|
| [데이터] TESS 고정 fixture·합성 주입 세트·실행 manifest 구성 | **등록 `S15P21C206-41`** | 표본 TIC 목록, 합성 주입 격자·코드, manifest 스키마, 재현 명령 |
| [분석] 전처리·detrending 벤치마크 | **등록 `S15P21C206-42`**, 선행 41 | 방법·창별 신호 보존율·잡음 표, 기본값 제안과 TBD |
| [데이터] FITS 어댑터·전처리·스키마 | 입력/마스크 계약, 42 결과 | UI 밖 로더, Sector 처리, 단위·마스크·버전, 샘플 및 경계 검증 |
| [분석] BLS 기준 벤치마크 | 전처리 실험 입력·평가 정의 | 전체/사전 선별/coarse-to-fine, 합성·고정 평가 세트, 시간·회수·오검출 보고와 설정 선택 근거 |
| [분석] BLS 후보·특징 생성 | 전처리 | 공통 설정, 후보별 지표, 원본 주기도, 알려진 신호 검증 |
| [분석] 반복 후보·고조파·모델 검증 | 후보 생성 | 단계별 최강 피크 품질, 제거 QA·종료, 고조파·ID·판 사이 후보 동일성·원본 재검증, `transit_model` 스키마와 고정 모델 제거 규약 |
| [분석] 비닝·discoverable 해상도 검증 | 전처리, 후보 생성 | 세그먼트 분할·10분 비닝 구현, 가장 짧은 통과 지속시간 실측, 제공 격자로 재계산한 발견 단계 잔차 주기도의 봉우리 판정, 무신호 별 비율 실측(DEC-01·03, ERD 미결 10) |
| [데이터] 외부 참조·갱신 차이 | 후보 ID 계약 | 후보별 상태·출처·조회일, 충돌·미매칭·새 Sector 차이 검증 |
| [데이터] Gold 적재·온라인 계산 계약 | 스키마, 모델 계약 | 세그먼트·판별 주기도·후보표·manifest의 PostgreSQL 배열 적재 예제와 임의 제거 조합 Silver–EC2 일치 자료 |
| [ML] 모델 실행 가능성 검증 | **완료 (S15P21C206-40)** | AstroNet-Triage checkpoint 실행·SPOC 후보 adapter·라이선스 조사. 결과는 `tess-ai-model-feasibility.md` |
| [ML] AstroNet-Triage 성능 평가·후보 선별 기준 | **등록 `S15P21C206-43`**, 선행 40·41 | TIC 단위 분리 PC/EB/junk 세트, 단일 vs 10개 ensemble, 재현율·정밀도·PR-AUC·성공률, PC/EB 구분용 Vetting 비교, 임계값은 결과 이후 |
| [Spark] 계산 커널 분산 연결 | 전처리/후보 단위 확정 | 김동혁과 작은 Worker 실행을 수요일부터 검증, 이후 전체 단계 연결·재처리 |

Gold 배열의 과학적 내용·데이터 QA는 윤성용, 적재 경로·판 전환·운영 복구는 김동혁·강재민 책임으로 연결한다. 온라인 요청 API·캐시 구현과 성과/알림 처리는 각 백엔드 담당 작업에 연결한다. 규모가 크면 팀 리뷰에서 독립 검수 가능한 Task로 추가 분할한다.

## 10. 29번 완료 체크

- [x] 기존 코드 근거와 요구사항 차이 초안 작성
- [x] 실제 샘플 최초 BLS·기존 테스트 결과 기록
- [x] 처리 흐름·입출력·실패·검증·후속 작업안 작성
- [x] 실제 Jira 29번 완료 조건·댓글·첨부와 대조
- [x] 실제 Jira 목록(2026-09-10, 35건)과 후속 Task 제안의 중복 확인 — 중복 없음, 9절에 기록
- [x] v0.12의 반복 BLS·Silver–Gold·온라인 잔차 계산 경계 적용
- [x] v1.0·ERD v1.0의 세그먼트·10분 비닝·`transit_model` 파라미터·제공 해상도 discoverable·Redis 캐시·현재 판 재로드 반영
- [x] AI 모델 실행 가능성 조사(Jira 40) 결과 반영
- [ ] 데이터 범위·비닝 간격·무신호 비율·BLS 임계값·`transit_model` 스키마·격자 규칙과 DEC-35 적재 경로·온라인 계산 구현의 담당·후속 Task 확정 (2026-09-10 선행 Task 3건 등록: `S15P21C206-41`·`42`·`43`, 나머지는 리뷰 후)
- [ ] 미결정 수치마다 담당·검증 방법·결정 기한 확정
- [ ] 교차 리뷰 의견 반영 및 후속 Jira 연결
- [ ] 문서 MR 승인·병합, 결과물·검증 자료 Jira 등록

리뷰 요청 문안: “기존 BLS PoC를 재현하고 요구사항 명세서 v1.0과 ERD v1.0의 Silver 내부 반복 BLS, 단계별 배열 비저장, 별·섹터 세그먼트 10분 비닝, `transit_model` 파라미터, 제공 해상도 기준 discoverable, Redis 캐시와 현재 판 재로드를 확정 요구사항으로 적용했습니다. AI는 Jira 40에서 AstroNet-Triage 실행을 확인했고 PC/EB 대 junk 1차 선별 모델로만 다룹니다. 리뷰에서는 비닝 간격 실측, 무신호 별 비율, 반복 종료·제거 QA 수치, `transit_model` 스키마와 격자 규칙, fold 기준 시각의 정본 위치, DEC-35 적재 경로·계산 위치와 Silver–EC2 허용 오차처럼 명세서가 남긴 항목을 우선 확인 부탁드립니다. 미확정 수치는 제안 또는 TBD로 표시했습니다.”

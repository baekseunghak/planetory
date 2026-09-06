# S15P21C206-29 천문 데이터 처리·AI 기획 초안

작성일: 2026-09-06 / 담당: 윤성용 / 상태: 팀 리뷰 전 초안

분석 기준 커밋: `4b8240cb46e693bb20a566318d6f0eb2c15ee0ec`

이 문서는 기존 PoC의 구현 사실과 서비스 요구사항의 차이를 정리한다. 제안한 스키마·작업 분할·검증 기준은 팀 승인 전이며, Jira 29번의 실제 설명·댓글·첨부와 대조하지 않았다. 문서 작성만으로 29번이 완료되는 것은 아니다.

기준: [역할 분배](../team-role-allocation.md), [SRS v0.9](../requirements/planetory-requirements-spec.md), [데이터 규칙](data-guidelines.md), [Spark 규칙](spark-hadoop-guidelines.md). 상태표의 이전 규칙 대신 SRS v0.9의 변경 규칙을 우선한다.

## 1. 담당 역할과 목표

기존 실험을 처음부터 다시 만드는 것이 아니라, 재사용 가능한 계산 커널을 검증하고 자동 후보 처리와 서비스 산출물로 확장한다.

- 윤성용: 전처리, 후보 탐색·검증·병합, 통과 모델, 외부 참조, AI 입력·추론, 배치·온라인 계산의 일치 기준.
- 김동혁: 수집·저장·Spark/Airflow 실행 환경, 공개 묶음 전달·전환·복구, 온라인 계산 인프라.
- 강재민: 후보 조회·사용자 제출 매칭·성과 API, 온라인 잔차 요청·캐시·상태. 윤성용은 계산 의미와 검증 자료 제공.
- 백지웅: 분석 그래프와 상호작용. 데이터 전달은 백엔드 API를 거치며 축·단위·축약 조건은 함께 합의.

29번 산출물은 설계·계약·검증 계획·후속 작업안이다. 실제 전체 구현은 후속 Task에서 수행한다. 신규 LLM 근거 설명·행성 소개는 이번 기획의 필수 구현 범위로 추가하지 않는다. 기존 AI-01~04는 P0이며 제외하지 않는다. AI 재평가(AI-05)는 P1, 통계 집계(DAT-13)는 서비스 담당과의 협업 범위다.

## 2. 기존 코드에서 확인한 사실

분석 범위는 `experiments/tess-bls`와 위 기준 문서다. 아래의 '없음'은 해당 PoC에서 확인되지 않았다는 뜻이며 다른 팀원의 미병합 작업까지 부재하다는 뜻이 아니다.

| 위치 | 현재 구현 | 재사용·보완 판단 |
|---|---|---|
| [download_toi270.py](../../experiments/tess-bls/download_toi270.py) `PRODUCTS`, `download_product` | 고정 MAST URL 3개, 크기·FITS 블록·TIC·Sector 검증, 임시 파일 후 교체, 재시도, 정상 캐시 재사용 | 소규모 재현에 재사용. 일반 대상 목록·원천 스냅샷·checksum manifest·분산 수집은 별도 |
| [semi_auto_bls.py](../../experiments/tess-bls/semi_auto_bls.py) `load_tess_light_curves` | TIME·PDCSAP_FLUX·QUALITY 로드, 동일 TIC·Sector 중복 검사, DataFrame 구성 | FITS 어댑터를 UI 밖으로 분리. 시간계·단위·제품·cadence 메타데이터 보존 필요 |
| [pipeline.py](../../experiments/tess-bls/pipeline.py) `clean` | quality=0, 결측 제거, Sector별 중앙값 정규화, 시간 공백별 Savitzky–Golay, 상방 clipping | 기본 커널 재사용. 추가 마스크와 행별 제외 사유·원본 인덱스 필요 |
| `bls_periodogram` | 모든 격자의 power·P·t0·duration·depth 생성 | 원본 주기도 및 자동 후보 추출의 기반 |
| `bls_period_candidates` | 최대 10개 대표 피크, 인접 주파수 병합, P1/P2 순위 ID, 조화 주기는 유지 | 사람의 선택 보조. 영구 Candidate ID·고조파 별칭 병합으로 사용할 수 없음 |
| `bls_features` / `analyze_target` | 최강 후보 1개, SNR·odd/even 차이·secondary depth·관측 통과 수 등 | 특징 계산 재사용 검토. 전체 반복 탐색·AI 모델 추론은 아님 |
| `geometry_from_phase_interval`, `candidate_from_geometry` | 사람이 선택한 P·구간을 t0·duration·depth로 환산 | 사용자 입력 검증 참고. 자동 배치의 승인 판단을 대신하지 않음 |
| `joint_refit_candidates` | P·t0·duration 고정, 원본에서 모든 depth·baseline 공동 적합 | 주기나 지속시간까지 자동 개선하는 기능으로 설명하면 안 됨 |
| `residual_after_candidates` | 원본 flux / (baseline × 후보 상자 모델들의 곱), 입력 관측점 보존 | 온라인 잔차 커널 후보. 모델·baseline·정렬·수치 규약 합의 필요 |
| `fit_box_near_period` | 주기 주변 국소 BLS 함수 | 정의는 있으나 현재 UI 호출 경로에서 사용되지 않음. 자동 정밀화에 쓰려면 검증 필요 |
| UI 상태·JSON 다운로드 | session_state에 후보 저장, TIC·Sector·baseline·candidates JSON 내보내기 | 출력이 전혀 없는 것은 아님. 다만 버전·마스크·출처·AI·공개 manifest가 없는 실험 출력 |

### 주의 깊게 보완할 부분

1. `clean`은 Sector별 정규화 후 전체를 합쳐 시간 간격 0.5일 초과로 구간을 나눈다. 따라서 Sector 경계 자체를 항상 detrending 경계로 보장하지 않는다. Sector 안에서 연속 구간을 나눈 후 결합하도록 검토한다.
2. `clean`의 `dropna`는 무한대를 제외하지 않는다. 중복 시각, cadence가 0인 경우, 0 이하 trend 등도 명시적인 입력·결과 검증이 필요하다. 실제 샘플에서 오류가 발생했다는 의미는 아니다.
3. 품질 필터와 clipping 이후 배열만 반환하므로 제외 행의 마스크·이유를 결과에서 복원할 수 없다. DAT-14용 품질 마스크와 인덱스 대응 계약이 필요하다.
4. 기본 탐색 설정이 두 경로에서 다르다. `bls_features`: 20,000개 격자, 최대 min(baseline/3,100일), 지속시간 4개. `bls_periodogram`: 8,000개 격자, 최대 min(baseline/2.5,30일), 0.5~8시간 12개. 공통 설정과 버전으로 통합할지 결정한다.
5. `_joint_depth_fit`은 baseline 0.97~1.03, depth 0~0.25 범위와 최대 100회 평가를 사용한다. 최적화 성공 여부를 호출자에게 전달하지 않는다. 깊은 식쌍성과 부적절한 사용자 선택의 실패 처리 검증이 필요하다.
6. 겹친 관측점 보존은 합성 상자 모델 테스트로 검증되어 있다. 실제 transit 모양에서 경계 돌출·다른 후보 훼손·자동 탐색 정확성까지 보장하지 않는다.
7. `fold_for_service`의 '프론트에는 이것뿐'이라는 주석은 최신 전 점·마스크 제공 요구를 대신할 수 없다. 계산용·AI용 데이터와 화면 축약값을 분리한다.

## 3. 요구사항 대비 차이

| 요구사항 | 현 상태 | 후속 작업과 검수 |
|---|---|---|
| DAT-01 원천 | 고정 예제 다운로드 일부 구현 | 입력 manifest에 실제 사용한 URL·조회 시각·제품·해시 기록, 손상·중복 복구 검증 |
| DAT-02 전처리 | 기본 처리 있음 | Sector 경계·추가 마스크·예상 최대 duration 대비 평활 창 검증, 행별 사유 보존 |
| DAT-03 화면 자산 | 곡선·주기도 계산 가능 | 단위·공백·버전·화면 축약 출력 계약 및 파일화 |
| DAT-04 BLS | 격자와 일부 특징 있음 | 후보별 SDE 정의, SNR·관측 통과 수·Sector 일관성·마스크 편중 평가 통합 |
| DAT-05 반복 탐색 | 사람 승인 후 반복 | 자동 후보 생성→검증→제거→재탐색, 종료 이유·단계 이력·모델 버전 |
| DAT-06 제거 검증 | 합성 모델 테스트, UI 마지막 후보 취소 | power 감소·경계 돌출·다른 신호 훼손 판정, 실패 단계 공개 차단·복구 |
| DAT-07 원본 재검증 | 원본에서 깊이 공동 적합 | 후보 승인용 원본 재검증과 discoverable 판단·근거 별도 구현 |
| DAT-08 병합 | 피크 인접 병합만 있음 | 고유 후보 ID, 주기·위상·지속시간·실제 구간 기반 별칭·중복 관리 |
| DAT-09 외부 상태 | 참고 주기 상수만 있음 | 후보별 원천 연결, 상태·조회일 보존, 자체 대표값·AI와 분리 |
| DAT-10 후보표 | 수동 승인 후보 JSON | 후보·단계·품질·원본 검증·외부 참조·AI 연결 |
| DAT-11~12 공개·복구 | 공식 공개 묶음 없음 | 동혁님과 manifest·검증·멱등 재처리·기존 공개본 유지 연동 |
| DAT-14 온라인 잔차 | 로컬 계산 커널 있음 | Gold 모델 전달, EC2 계산 계약, 같은 입력의 수치 일치 검증 |
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
  → 원본 주기도 / 자동 후보 탐색
  → 후보 검증 → 모델 적합·제거 QA → 잔차 재탐색
  → 원본 재검증 / 후보·별칭 병합 / discoverable 기록
  → 외부 참조·상태 연결 / AI 입력·배치 추론
  → 후보표·원본 전 점·마스크·모델·버전 검증
  → PublicationBundle → 인프라 검증·전송·공개
```

- 재처리 단위 제안: 원천 검증·전처리는 TIC/Sector/제품, 후보 탐색 이후는 TIC/입력 스냅샷/계산 버전. 경로와 실행 인자는 동혁님과 합의한다.
- 입력 손상은 해당 입력 실패로 기록한다. 불완전한 Sector로 진행할지 TIC 전체를 보류할지는 결정 필요.
- 유효 관측점 부족은 처리 실패·탐색 불가 사유로 기록한다. 단순히 '행성 후보 0개'와 합치지 않는다.
- 제거 QA 실패 시 마지막 검증 성공 상태로 복구하고 해당 단계 이후 후보를 공개하지 않는다(DAT-06).
- AI 실패는 점수 0이 아니라 실패 상태로 남긴다. P0 전체 후보 추론 요건을 충족하지 못한 번들의 공개 처리는 팀 합의가 필요하다.
- 동일 입력·설정의 재실행은 중복 후보와 이벤트를 만들지 않게 한다. 새 번들의 공개 실패 시 기존 공개본을 유지한다.
- Silver 내부 잔차는 검증·후속 탐색용이다. 사용자별 제거 조합의 잔차·주기도는 Gold에 사전 생성하지 않는다.

## 5. 입출력 계약 초안

아래는 합의할 최소 필드안이다. 실제 파일 형식·파티션·최종 이름·enum은 미확정이며 기존 서버 스키마와 대조해야 한다. 타입의 `?`는 nullable 제안이다.

| 산출물 | 필드·타입·의미 (예시) | 소비자 |
|---|---|---|
| 입력 manifest | `tic_id:string` 식별자 (`259377017`), `sector:int` (`3`), `product_id:string`, `source_uri:string`, `retrieved_at:UTC timestamp`, `sha256:string`, `cadence_seconds:float` | 데이터·인프라 |
| 정제곡선 | `point_id:int64`, `time_days:float64`, `normalized_flux:float64?`, `sector:int`, `original_quality:int64`, `valid:bool`, `exclusion_reasons:list<string>` | 배치·온라인 계산 |
| 곡선 메타 | `time_system:string`, `time_reference_offset_days:float64`, `flux_unit:string`, `preprocessing_version:string`, `input_snapshot_id:string` | 백엔드·프론트·AI |
| 주기도 | `period_days:float64[]`, `power:float64[]`, `periodogram_config_version:string`, `curve_ref:string` | 백엔드·프론트 |
| 후보 | `candidate_id:string` 안정 ID, `tic_id:string`, `period_days/t0_days/duration_days/depth:float64`, `iteration:int`, `snr/sde:float64?`, `observed_transit_count:int`, `discoverable:bool`, `qa_status:string`, `qa_reasons:list<string>` | 백엔드·AI |
| 모델 | `candidate_id:string`, `shape:string` (PoC는 box), `parameters:object`, `residual_model_version:string`, `baseline:float64`의 저장 범위 결정 | 배치·EC2 |
| 외부 참조 | `candidate_id:string`, `source:string`, `external_id:string`, `raw_disposition:string?`, `retrieved_at:UTC timestamp`, `snapshot_id:string`, `match_status:string` | 백엔드 |
| AI 결과 | `candidate_id:string`, `score:float64?`, `execution_status:string`, `decision_band:string?`, `model_version/checkpoint_hash/input_version/threshold_version:string`, `curve_ref:string`, `iteration:int` | 백엔드 |
| 공개 manifest | `bundle_id:string`, 입력·파이프라인·계산 버전, 파일 목록·해시·행 수, 검증 결과 | 인프라·백엔드 |

필수 결정:

- FITS 헤더의 시간계·기준 오프셋을 보존하고 t0와 동일 기준을 사용한다. day/hour가 혼재한 현재 반환값은 경계에서 명시적으로 변환한다.
- 정제곡선의 '전 점'은 다운샘플하지 않은 계산 자산을 의미한다. 제외 관측점을 별도 마스크 테이블로 보관할지 동일 행에서 nullable flux로 보관할지는 결정 필요. 어느 쪽이든 원본 인덱스 대응은 보존한다.
- depth는 정규화 상대 밝기 감소량이며 화면 ppt/ppm 변환과 구분한다. 후보 상태의 미확정과 처리 실패도 별도이다.
- `P1` 같은 화면 순위 ID는 재실행·번들 간 영구 식별자로 쓰지 않는다. 신규 Sector에서 후보 동일성을 유지하는 규칙은 재민님과 합의한다.
- PoC의 baseline은 모든 승인 후보 공동 적합 결과다. 온라인의 임의 제거 부분집합에 baseline을 어떻게 적용할지 합의하고 빈 제거 집합은 원본과 일치하는지 검증한다.
- 화면 축약·AI 입력·계산 전 점은 서로 다른 산출물이다. 축약 시 좁은 감광이 유실되는지 검증한다.

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

11.3205일과 2.8308일 피크를 각각 별개의 행성 발견으로 해석하지 않는다. 첫 주기의 약 2배·1/2배에 해당하며, 고조파/별칭 검증이 필요함을 보여준다. 세 행성 복구 성공, 자동 반복 탐색 성공, 정확도·대규모 처리 성능을 이번 결과로 주장할 수 없다. 기존 테스트는 합성 모델·기하·프리셋 등을 검증하며 실제 샘플의 전체 과학적 정확성을 증명하지 않는다.

### 재현 명령

Git Bash에서 저장소 최상위 기준. 설치된 `.venv`가 있는 현재 PC는 Python 실행기의 PATH 문제를 피하기 위해 가상환경 실행 파일을 직접 사용할 수 있다.

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

현재 서버가 8501에서 실행 중이라면 중복 실행할 필요 없다. 원본·가상환경·캐시는 Git 제외 대상이다. 이번에는 과학 처리 코드와 의존성 잠금 파일을 변경하지 않았다.

## 7. 검증 계획 제안

| 검증 | 방법 | 통과 기준·미결정 |
|---|---|---|
| 전처리 | 결측·무한대·중복 시각·Sector 경계·짧은 구간·알려진 주입 신호 | 유효성 검사·제외 사유 재현, 신호 보존 수치는 실측 후 결정 |
| 자동 후보 | 단일/다중 신호·식쌍성·무신호·관측 공백 사례 | 외부 기준/합성 정답 대비 회수·오검출·고조파율 보고, 임계값 DEC-03/05 |
| 반복 제거 | 겹친 신호·잘못된 기하·최적화 실패 주입 | 잔차 왜곡·타 후보 훼손 검출, 실패 시 후속 공개 차단; 수치 DEC-06 |
| 온라인 일치 | 빈 집합·단일·복수·선택 순서 변경, 같은 Gold와 설정 | 마스크·시간축 일치, 최대절대오차/RMSE·주기도·피크 비교; 허용 오차 합의 |
| AI | 라벨 있는 TIC 단위 분리 검증, 입력 누락·실패 포함 | 모델 적용성·입력 확보율·정밀도·재현율·추론 시간, 검증 데이터로 임계값 결정 |
| 갱신·복구 | 중복 실행·중간 실패·새 Sector·외부 라벨 변경 | 후보 ID/이벤트 중복 방지, 기존 공개본·성과 유지, 재개 조건 구분 |
| Spark | 같은 작은 고정 입력을 로컬과 Worker에서 실행 | 산출물 동등성, 실패 TIC 재처리, 메모리·처리 시간 측정; 전체 collect 금지 |

AI 임계값 결정용 데이터와 최종 평가 데이터를 구분하고 동일 TIC의 후보가 양쪽에 섞이는 누수를 방지하는 안을 검토한다. 아직 모델이나 정확도 목표를 확정하지 않는다.

## 8. 월요일 합의 안건

| 안건 | 제안·준비물 | 결정 담당 / 기한 제안 |
|---|---|---|
| DEC-01 데이터 범위 | 이번 TOI-270은 재현 샘플일 뿐 서비스 범위 아님. 제품·cadence·Sector·대상 수 확정 | 윤성용·김동혁 / 월요일 |
| DEC-02/04 AI | 체크포인트·입력·라이선스 실행 가능성부터 확인, 점수 기준은 검증 후 | 윤성용·팀 / 모델 월요일, 수치 금요일 |
| DEC-03/05/06 분석 | BLS 공통 설정·고조파·자동 반복 종료·모델·QA 실험 설계 | 윤성용, 매칭은 강재민 / 계획 월요일, 수치 수~목요일 |
| DEC-20 외부 대표값 | 자체 BLS값을 기본으로 두고 외부값 덮어쓰기 여부 임의 확정 금지 | 윤성용·강재민 / 외부 연결 착수 전 |
| DEC-35 온라인 계산 | Python 커널 재사용 가능성 비교, baseline·마스크·모델 계약 | 김동혁·윤성용·강재민 / 월요일 |
| 스키마·갱신 | 5절 필드·후보 ID·빈 결과/실패·재개 변경 목록 | 윤성용·강재민, 이벤트 소비자 / 월요일 |
| 그래프 단위 | 시간계·day/hour·ppt/ppm·다운샘플·공백 | 윤성용·강재민·백지웅 / 첫 샘플 전달 전 |

문서 정합성 확인 요청:

- SRS DAT-11에는 '단계별 잔차'가 남아 있지만 v0.9 POL-03/DAT-05/DAT-14는 사용자용 사전 저장을 금지한다. 본 초안은 후자를 따르며 정본 문구 보완을 요청한다.
- 데이터 관리 문서의 Gold 예시 트리에 전 점·품질 마스크·통과 모델이 빠져 있다. DEC-35와 함께 갱신해야 하며 임의의 staging 경로를 확정하지 않는다.
- DAT-15의 외부 갱신에 `ai_status`가 포함된 문구와 DAT-09의 외부 상태/AI 분리 원칙에 대해, 재추론 없는 외부 라벨 변경 시 갱신 필드 범위를 확인한다.

## 9. 후속 구현 Task 분할안

실제 Jira 목록과 중복 확인 후 등록한다. 아래는 미등록 제안이며 29번 아래 Sub-task를 만들지 않고 적절한 Epic 아래 Task로 연결한다. Task별 브랜치·MR 1개, 일반 MR 승인 1명 이상을 따른다.

| 제안 Task | 선행 | 산출물·완료 조건 |
|---|---|---|
| [데이터] FITS 어댑터·전처리·스키마 | 입력/마스크 계약 | UI 밖 로더, Sector 처리, 단위·마스크·버전, 샘플 및 경계 검증 |
| [분석] BLS 후보·특징 생성 | 전처리 | 공통 설정, 후보별 지표, 원본 주기도, 알려진 신호 검증 |
| [분석] 반복 제거·QA·병합 | 후보 생성 | 종료·실패 복구, 고조파·ID·원본 재검증·discoverable |
| [데이터] 외부 참조·갱신 차이 | 후보 ID 계약 | 후보별 상태·출처·조회일, 충돌·미매칭·새 Sector 차이 검증 |
| [데이터] 공개 묶음·온라인 계산 계약 | 스키마, 모델 계약 | 전 점·마스크·모델·manifest와 임의 제거 조합 일치 자료 |
| [ML] 모델 실행 가능성 검증 | 첫날 독립 착수 가능 | 체크포인트·라이선스·입력·실제 추론 검증, 선택 근거 |
| [ML] 후보 입력·추론·평가 | 모델 검증, 후보 | 결과·실패·버전, 평가 데이터와 임계값 결정 자료 |
| [Spark] 계산 커널 분산 연결 | 전처리/후보 단위 확정 | 김동혁과 작은 Worker 실행을 수요일부터 검증, 이후 전체 단계 연결·재처리 |

공개 묶음의 파일 생성·데이터 QA는 윤성용, 전송·원자적 전환·운영 복구는 김동혁 책임으로 연결한다. 온라인 요청 API·캐시 구현과 성과/알림 처리는 각 백엔드 담당 작업에 연결한다. 규모가 크면 팀 리뷰에서 독립 검수 가능한 Task로 추가 분할한다.

## 10. 29번 완료 체크

- [x] 기존 코드 근거와 요구사항 차이 초안 작성
- [x] 실제 샘플 최초 BLS·기존 테스트 결과 기록
- [x] 처리 흐름·입출력·실패·검증·후속 작업안 작성
- [ ] 실제 Jira 29번 완료 조건·기존 첨부와 대조
- [ ] 팀원 미병합 작업과 중복 확인
- [ ] 데이터 범위·모델 실행 계획·스키마·계산 경계 합의
- [ ] 미결정 수치마다 담당·검증 방법·결정 기한 확정
- [ ] 교차 리뷰 의견 반영 및 후속 Jira 연결
- [ ] 문서 MR 승인·병합, 결과물·검증 자료 Jira 등록

리뷰 요청 문안: “기존 BLS PoC를 재현하고 자동 배치로 전환할 때 필요한 차이를 정리했습니다. 입력·출력 스키마, 온라인 잔차의 baseline/마스크 계약, 후보 ID와 갱신 경계, 데이터 범위를 우선 검토 부탁드립니다. 미확정 항목은 제안으로 표시했습니다.”

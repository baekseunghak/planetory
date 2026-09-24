# AstroNet-Triage 평가 세트 구성·입력 변환

Jira `S15P21C206-43` (계획 ID D10) / 담당: 윤성용 / 상태: 9별 1차 세트 생성·변환 완료(문서 5절), 팀 리뷰 전

118(성능 평가)이 바로 돌릴 수 있는 입력 묶음을 만든다: (1) PC/EB/junk 라벨 목록과 TIC 단위 분리, (2) 후보별
AstroNet-Triage 입력 `global_view`(201)·`local_view`(61) NPZ, (3) 실행 manifest. 모델 실행·지표·임계값은 하지 않는다(118).
계획과 결정 근거는 [docs/data/tess-astronet-eval-set.md](../../docs/data/tess-astronet-eval-set.md).

## 실행

118을 다른 PC에서 시작할 때도 아래 `build-set`과 `convert`로 입력을 생성한다. FITS는 공용 fixture를 재사용하지만
다른 PC의 `results/`는 Git으로 전달되지 않는다. 기존 가상환경을 활성화했다면 먼저 해제하고
`uv sync --locked --python 3.11`로 이 디렉터리의 환경을 준비한다. 모델 추론용 TensorFlow 1 환경은 별도다.

118의 실행 순서는 입력 생성·변환 → calibration 점수로 하한·상한 결정 및 잠금 → evaluation 검증이다.
입력 생성은 양쪽 split을 포함해도 되지만 evaluation 점수를 보고 임계값을 조정하지 않는다.
`build-set`·`convert`는 입력 준비만 수행한다. 118의 조정용 추론은 아래 별도 실행기를 사용한다.
지표 계산·실험안 잠금·사용자 독립 평가(35/35)는 완료했다. 2026-09-21 팀은 현재 checkpoint·임계값의
운영 채택을 보류하고 실험 결과만 내부 검토 자료로 보존하기로 최종 결정했다. 사용자 화면·자동 승인·기각에는 연결하지 않는다.
서비스 FP/FN 허용 기준과 평가 범위의 한계를 보류 근거로 남기고, 재채택 전 코드·checkpoint의 서비스 사용·재배포 조건을 다시 검토한다.
AI-01~04와 126·130은 유지하며 대안 모델·AI 출시 범위는 별도 결정이다.
118의 완료 경계는 [최종 보류 결정](../../docs/data/tess-astronet-benchmark.md#6-최종-운영-채택-보류-결정과-완료-경계)을 따른다.

Windows(uv) 에서 세트·변환, WSL TensorFlow 1 환경에서 TFRecord 순서다. 원본 FITS 는 tess-fixture 의 `sample_raw/` 를 그대로 읽는다.

```powershell
cd experiments/astronet-eval
uv sync --python 3.11
uv run pytest -q

uv run python -m astronet_eval build-set                       # 9별 전체. --target toi270 cm_dra 로 일부만
uv run python -m astronet_eval convert --labels results/eval/astronet_eval_set_v1-1.0.0/set-<UTC>-<id>/labels.csv
```

```bash
# WSL, 40번과 같은 Python 3.7 + TensorFlow 1.15 환경
<py37-env>/bin/python scripts/write_tfrecords.py \
  --run-dir results/eval/astronet_eval_set_v1-1.0.0/convert-<UTC>-<id> \
  --output <tfrecord-dir>/test-00000-of-00001
```

`build-set` 은 fixture 곡선을 읽어 EB 기하와 junk 후보를 BLS 로 만들기 때문에 FITS 가 필요하다(별 하나 수십 초).
`convert` 는 라벨 목록의 후보마다 view 를 만든다(별 하나 수 초). 산출물은 `results/` 아래 실행별 디렉터리에 남고 Git 에 넣지 않는다.

## 라벨 정의 (`configs/eval_set_v1.json`)

| label | in_truth | 출처·snapshot | 기하 |
|---|---|---|---|
| `PC` | true | NASA Exoplanet Archive `pscomppars` (tess-fixture `references.csv`, `fetched_at`). `tran_flag=1`, 주기·통과 중심·지속시간이 있는 확인 행성 | Archive 값. `epoch_btjd = pl_tranmid − 2457000`, `depth_ppm = pl_trandep(%) × 1e4` |
| `EB` | true | tess-fixture `targets.py` role=eclipsing_binary, 문헌 주기 | 알려진 주기에서 BLS 로 epoch·duration·depth |
| `junk` | true | 합성 잡음 곡선(`synthetic_noise_baseline`, seed 3개). 신호 없음을 구성으로 보장 | 잡음 곡선의 BLS 최강 피크 |
| `junk_unverified` | **false** | 실제 곡선에서 PC/EB 를 `libs/astro-kernel` 로 나눠 제거한 잔차의 BLS 최강 피크 | 미확인 신호일 수 있어 정답 제외, 분포만 보고 |

TOI PC/APC·무라벨 신호는 양성 정답에 넣지 않는다. AstroNet-Triage 점수는 PC/EB 대 junk 판별이며 행성 확률이 아니다.

**분리**: `sha256(str(tic_id))` 첫 바이트 홀짝 → `calibration` / `evaluation`. 같은 별의 후보는 전부 한쪽. `check_split_integrity` 가 위반을 실패로 만든다.
**학습 중복**: AstroNet-Triage 학습 TCE(QLP) TIC 목록이 공개돼 있지 않아 모든 별 `training_overlap=unknown`. 118 에서 확인되면 갱신.

## 변환 규칙 (고정)

40번 `prepare_toi270_probe.py` 의 view 수식을 그대로 쓴다. checkpoint 가 학습한 입력 규칙이라 바꾸지 않는다.

- 곡선: tess-fixture 바탕곡선(QUALITY==0, Sector 중앙값 정규화) → tess-bench `preprocess` **42 채택 설정 `biweight_1.0d`** → `kept` 점만.
  40번은 PoC `clean`(SG 2일)을 썼으므로 같은 후보의 점수가 달라질 수 있고, 그 차이는 118 의 관찰 항목이다.
- 접기: `(t + P/2 − t0) mod P − P/2`, 오름차순.
- `global_view`: 201 bin, bin 폭 `P × 1.2 / 201`, 범위 ±P/2. `local_view`: 61 bin, bin 폭 `D × 0.16`, 범위 ±min(P/2, 2D).
- 각 bin 중앙값 → 빈 bin 선형 보간 → 전체 중앙값 빼기 → |최솟값| 으로 나눔 → float32.
- 실패는 후보별 `status=input_incomplete` 와 `reason` 으로 기록하고 점수 0 으로 대체하지 않는다.

| reason | 뜻 |
|---|---|
| `missing_geometry` | epoch 또는 duration 없음 |
| `invalid_geometry` | period ≤ 0 이거나 duration ≥ period |
| `no_valid_points` | 유효 관측점 없음 |
| `too_few_transit_points` | 접은 뒤 통과 안 점 < `min_in_transit_points`(3) |
| `empty_view` / `flat_view` | 모든 bin 이 비었음 / 최솟값 0 이라 정규화 불가 |
| `non_finite_view` / `bad_shape` | 안전장치 |

## 산출물

| 파일 | 내용 |
|---|---|
| `set-*/labels.csv` | 후보 목록. 열: candidate_id, label, in_truth, label_source, label_snapshot, tic_id, target_key, baseline_id, split, training_overlap, source_name, period_days, epoch_btjd, duration_hours, depth_ppm, geometry_source, notes |
| `set-*/skipped_references.csv`, `summary.json` | 제외한 Archive 행과 사유, 라벨·split 집계, 곡선별 전처리 점 수 |
| `convert-*/conversions.csv` | 후보별 status·reason·점 수·통과 점 수·빈 bin 수·배열 sha256·NPZ 경로 |
| `convert-*/npz/<candidate_id>.npz` | `global_view`, `local_view`(float32), `tic_id`, `sectors`, `period`, `duration`(일), `t0`, `candidate_id`, `label` |
| `convert-*/tfrecord_index.csv` | TFRecord 기록 순서 ↔ candidate_id (같은 TIC 후보가 여럿이라 필요) |
| `results/manifests/*.json` | tess-fixture 스키마 실행 manifest |

2026-09-19 정정: convert manifest의 NPZ `sha256`은 NPZ 파일 전체의 SHA-256이다.
이전 구현은 `global_view` 배열 해시를 이 필드에 잘못 기록했다. 배열 해시는 계속 `conversions.csv`에 별도로 남긴다.
과거 manifest를 새 파일 해시가 검증된 기록으로 취급하지 않는다. 기존 입력 생성 도구의 manifest task는 43이며,
118에서 재사용할 때도 세트·변환 run ID와 실제 코드 버전으로 연결한다.

## 한계

- fixture 9별 기준이라 EB 가 CM Dra 1개, PC 18개다. 118 의 지표는 지시적 수준이고, 별 추가는 108(범위·표본)과 함께 별도 세트 버전으로 한다.
- junk BLS 격자는 PoC 기본값(선형 20,000점)이며 110 벤치마크 전 잠정값이다. junk 라벨의 정당성은 격자가 아니라 "잡음 곡선"이라는 구성에서 나온다.
- `write_tfrecords.py` 는 TensorFlow 1 이 있는 WSL 환경에서만 실행한다. 이 저장소의 uv 환경에는 TensorFlow 를 넣지 않는다.

## 118 조정용 추론

상태: 실행 도구 구현·합성 입력 검증 완료, 사용자 calibration 20/20 추론 성공.
[조정 결과와 남은 조건](../../docs/data/tess-astronet-benchmark.md)에 수치·재집계 명령을 기록한다.
입력은 43의 동일한 201/61 float32 NPZ다.
공식 `batch_predict.py`는 같은 TIC의 점수를 평균 내고 소수 셋째 자리로 출력하므로 후보별 평가에 사용하지 않는다.
`scripts/predict_candidates.py`는 공식 `AstroCNNModel/local_global`의 PREDICT 구조와 고정 checkpoint를 사용하되,
NPZ 배열을 배치 크기 1 placeholder로 직접 전달하고 `candidate_id`별 float32 점수를 Python float의 round-trip 문자열로 보존한다.
TFRecord 직렬화나 별별 평균은 하지 않는다. 전처리·모델 가중치·분류 목표는 바꾸지 않는다.

- 공식 소스: [고정 commit](https://github.com/yuliang419/Astronet-Triage/tree/5675a57dd41dd0321df480453451096dc5a4a6b0).
- checkpoint: `astronet/models_final/model_1/model.ckpt-14000` 하나만 사용한다.
- CPU 환경: Docker `tensorflow/tensorflow:1.15.5-py3`의 아래 digest. 확인된 Python 3.6.9·TensorFlow 1.15.5·NumPy 1.18.5, intra/inter-op 각 2 threads다. 과거 WSL Python 3.7 환경과 구분한다.
- 소스·checkpoint는 `prepare_model.py`가 Git 명령 없이 고정 commit에서 내려받고 공식 blob SHA-1 및 로컬 SHA-256을 기록한다. 모델·소스·결과는 ignored `results/`에만 둔다.
- 실행기는 Docker 네트워크를 끄고 프로젝트를 읽기 전용으로 마운트한다. 이번 결과 폴더만 쓰기 허용한다. Docker Desktop은 먼저 실행해 둔다.

```powershell
cd experiments/astronet-eval
uv sync --locked --python 3.11
uv run --locked python scripts/prepare_model.py
docker pull tensorflow/tensorflow@sha256:181ff142e73ed8efe350f49288c7b0f5681fde66534a76d8de4fc75d4e30d571
uv run --locked python scripts/run_calibration.py --conversion-manifest results/manifests/convert-4b5a3d6d.json
```

위 manifest는 2026-09-19 집 PC에서 사용자가 생성한 입력이다. 다른 실행에는 해당 manifest 경로를 넣는다.
PC를 옮겨 manifest에 적힌 절대 경로가 달라졌다면 `--run-dir <현재 convert 디렉터리>`를 함께 준다.
55/55 변환 성공, 입력·출력 checksum 일치를 확인했으며 이것은 모델 성능 검증이 아니다.

조정용 20개(정답 PC 8·junk 9, 정답 제외 미확인 3)만 읽어 점수를 계산한다. 평가용 35개는 추론하지 않는다.
CSV·NPZ 파일과 배열 hash, 후보·TIC·라벨 일치, TIC 분리를 검사하고 오류가 있으면 중단한다.
`input_incomplete`는 빈 점수와 사유로 보존하며 0으로 대체하지 않는다. 실행 오류는 정상 완료 manifest를 남기지 않는다.

산출물은 `results/predictions/calibration-<UTC>-<id>/run/predictions.csv`와 `manifest.json`이다.
manifest에는 환경·checkpoint·공식 자산 목록 hash·입력 manifest/CSV hash·실행기 hash·출력 hash·처리 수·시간을 기록한다.
시간은 컨테이너 안의 검증·모델 준비·추론·CSV 저장을 포함하며 Docker 기동 시간은 제외한다.
라이선스는 공식 LICENSE와 상속 파일 헤더를 보존한다. 운영 배포 가능 여부는 [기존 조사](../../docs/data/tess-ai-model-feasibility.md#6-라이선스-확인-결과)의 미확정 사항으로 남긴다.

## 118 고정 실험안 독립 평가

사용자가 팀 리뷰 전 실험 수치 선택을 위임하여 `configs/triage_thresholds_v1.json`을 evaluation 전에 고정한다.
하한 0은 자동 기각을 하지 않는 보수적 가정이고 상한 0.00349776993971318은 조정 세트의 최대 junk와
바로 위 PC 점수 사이 중간값이다. 선택 근거·한계는 [성능 평가 문서](../../docs/data/tess-astronet-benchmark.md#4-사용자-위임에-따른-고정-실험안)를 따른다.
실험용 `approved`는 PC/EB triage 통과이며 행성 확정·운영 승인과 다르다.

```powershell
uv run --locked python scripts/run_calibration.py --split evaluation --conversion-manifest results/manifests/convert-4b5a3d6d.json --threshold-plan configs/triage_thresholds_v1.json --calibration-manifest results/predictions/calibration-20260919T130911Z-bb71f278/run/manifest.json
```

파일명은 기존 진입점 호환을 위해 유지한다. 기본 split은 calibration이다. evaluation에는 threshold plan이 필수이며,
실행 전 입력 manifest와 모델 자산 hash 결합을 검사한다. `--calibration-manifest`도 필수다.
그 파일은 completed/calibration이어야 하며, 같은 디렉터리의 predictions.csv 실제 hash가 고정안과 calibration
manifest 양쪽의 hash와 일치해야 한다. calibration과 evaluation의 conversion/model 연결도 같아야 한다.
호스트에서 Docker 시작 전에 검사하고 컨테이너에서 추론 전에 다시 검사한다. 완료 manifest 기록 전 연결 변경도 거부한다.
새 evaluation manifest에는 `calibration_manifest_sha256`을 기록한다. 결과에 실험안 사본·hash·버전과 후보별 구간을 기록한다.
평가 결과를 보고 같은 v1 수치를 바꾸지 않는다. 새 수치가 필요하면 새 버전과 새 미사용 평가 세트로 검증한다.

2026-09-19 사용자 evaluation `183da766` 완료: PC/EB TP 10·FN 1, junk FP 2·TN 16,
정밀도 10/12(83.33%)·재현율 10/11(90.91%), 전체 review 20/35(57.14%)다.
FP 2/18(11.11%)은 합성 백색 잡음에 대한 값이며 실제 계통 오차의 오탐률로 일반화하지 않는다. 아래 명령은 저장 결과만 집계한다.
전체 수치·checksum·최종 보류 결정은 [성능 평가 5·6절](../../docs/data/tess-astronet-benchmark.md#5-독립-평가-결과)에 기록한다.

```powershell
uv run --locked python -m astronet_eval.metrics --run-dir results/predictions/evaluation-20260919T131808Z-183da766/run
```

## !102 재현성 리뷰 보완 (2026-09-20)

calibration 연결 정상·누락·hash·split·status·conversion/model 불일치 테스트를 포함해 `uv run --locked python -m pytest -q`
57개가 통과했다. 기존 평가 run의 파일은 바꾸지 않았다. 새 검증을 수행한 추론 결과처럼 과거 manifest를 수정하지 않는다.
새 실행기의 실제 Docker 추론은 이번 보완에서 재실행하지 않았으며, 검증은 테스트와 저장 결과 사후 대조다.

MR 첨부용 `results/review-118-183da766.zip`에는 원본 소형 파일 7개와 사후 검산 `verification.json`만 포함한다.
FITS·checkpoint·NPZ는 포함하지 않고 ZIP도 커밋하지 않는다. 상세 해시·재집계 절차는
[벤치마크 8절](../../docs/data/tess-astronet-benchmark.md#8-mr-102-재현성-보완과-리뷰-첨부)을 따른다.
ZIP 생성 도구는 기존 출력 덮어쓰기를 거부하며 다음처럼 사용한다(같은 이름 파일이 있으면 새 이름을 사용한다).

```powershell
uv run --locked python scripts/package_review.py --calibration-run results/predictions/calibration-20260919T130911Z-bb71f278/run --evaluation-run results/predictions/evaluation-20260919T131808Z-183da766/run --conversion-manifest results/manifests/convert-4b5a3d6d.json --assets results/runtime/astronet-5675a57dd41dd0321df480453451096dc5a4a6b0/assets.json --output results/review-118-183da766.zip
```

## 126 내부 실험 배치

126은 [내부 배치 계약](../../docs/data/tess-astronet-internal-batch.md)에 따라 118의 고정 단일 checkpoint와 변환 입력을 재사용한다. 사용자 화면·서비스 DB·Gold·판정 밴드는 생성하지 않는다. 아래는 기존 55개 입력의 재현성 회귀이며 새 독립 성능 평가가 아니다.

```bash
uv run --locked python -m pytest -q
uv run --locked python scripts/run_internal_batch.py --conversion-manifest results/manifests/convert-4b5a3d6d.json
```

Docker Desktop과 기존 118 고정 이미지·모델·변환 NPZ가 필요하다. 다른 PC에서는 Git 외의 입력도 별도로 확보해야 하며, 변환 폴더만 이동했다면 `--run-dir`로 프로젝트 내부의 변환 폴더를 지정한다. 모델을 자동 다운로드하거나 이미지를 자동 갱신하지 않는다.

서로 다른 두 CPU TensorFlow 세션에서 실행하고 후보별 점수·상태를 정확히 비교한다. 정상 0점과 실패 null을 구분하며 같은 실패 두 번만으로 추론 재현성을 통과시키지 않는다. 결과는 `results/internal-126/<실행 ID>/`에 새로 저장한다. 기존 118 파일은 읽기 전용으로 사용한다. `verification_passed=true`는 해당 입력·환경의 내부 회귀 통과이며 운영 채택이 아니다.

단위 검증: 2026-09-23 전체 67개 통과. 저장 입력 사전검사: 후보 55개·유효 view 55개·파일 hash 100개 확인. 실제 모델 배치는 55개 전부 성공했고 두 세션 결과가 정확히 일치했다. 실행·검산·리뷰 ZIP hash는 [126 실측 기록](../../docs/data/tess-astronet-internal-batch.md#실제-실행과-저장-결과-검산-2026-09-23)을 따른다.

## 130 저장 점수 재평가 검증

[130 계약·검증 결과](../../docs/data/tess-ai-reevaluation-history.md). 기존 126 결과를 읽어 검증용 임계값·ID·모델 변경 콜백으로 이력을 대조한다. TensorFlow를 실행하거나 운영 Gold를 생성하지 않는다.

```powershell
uv run --locked python -m pytest -q
uv run --locked python -m astronet_eval.reevaluation_replay --source-run results/internal-126/20260923T112206Z-ba539ace/run
```

새 결과는 `results/reevaluation-130/`에 저장한다. 기존 출력은 덮어쓰지 않는다.

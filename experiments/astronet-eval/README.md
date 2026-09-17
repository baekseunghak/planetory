# AstroNet-Triage 평가 세트 구성·입력 변환

Jira `S15P21C206-43` (계획 ID D10) / 담당: 윤성용 / 상태: 9별 1차 세트 생성·변환 완료(문서 5절), 팀 리뷰 전

118(성능 평가)이 바로 돌릴 수 있는 입력 묶음을 만든다: (1) PC/EB/junk 라벨 목록과 TIC 단위 분리, (2) 후보별
AstroNet-Triage 입력 `global_view`(201)·`local_view`(61) NPZ, (3) 실행 manifest. 모델 실행·지표·임계값은 하지 않는다(118).
계획과 결정 근거는 [docs/data/tess-astronet-eval-set.md](../../docs/data/tess-astronet-eval-set.md).

## 실행

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

## 한계

- fixture 9별 기준이라 EB 가 CM Dra 1개, PC 18개다. 118 의 지표는 지시적 수준이고, 별 추가는 108(범위·표본)과 함께 별도 세트 버전으로 한다.
- junk BLS 격자는 PoC 기본값(선형 20,000점)이며 110 벤치마크 전 잠정값이다. junk 라벨의 정당성은 격자가 아니라 "잡음 곡선"이라는 구성에서 나온다.
- `write_tfrecords.py` 는 TensorFlow 1 이 있는 WSL 환경에서만 실행한다. 이 저장소의 uv 환경에는 TensorFlow 를 넣지 않는다.

# TESS 후보 판별 모델 실행 가능성 조사

작성일: 2026-09-09  
담당: 윤성용  
연결 Jira: S15P21C206-40  
상태: 1차 조사 및 AstroNet-Triage 공식 예제·TOI-270 후보 추론 완료, 팀 검토 전

조사·실행 우선순위는 윤성용의 작업 계획에 따라 **AstroNet → ExoNet → ExoMiner++**로 둔다. ExoMiner++를 먼저 검증한다는 기존 기획 초안의 순서는 팀 확정 사항이 아니므로 적용하지 않는다.

## 1. 목적과 판단 범위

이 문서는 Planetory가 직접 운영할 공개 사전 학습 모델 후보의 체크포인트, 라이선스, 입력 구조와 최소 추론 가능성을 확인한다. 최종 모델 선정, 정확도·재현율 평가, 판정 임계값 확정, 전체 TESS 실행과 운영 배포는 이 작업에서 결정하지 않는다.

판단 기준은 [요구사항 명세서 v0.12](../requirements/planetory-requirements-spec.md)의 AI-01~05다. 공개 카탈로그의 점수나 논문의 정확도를 Planetory 점수로 복사하지 않으며, 아래 판정은 팀 확정 사항이 아닌 후속 검증 우선순위 제안이다.

## 2. 조사 대상을 고정한 근거

| 후보 | 공식 자료 | 확인한 버전 |
|---|---|---|
| NASA ExoMiner++ | [NASA ExoMiner 저장소](https://github.com/nasa/ExoMiner), [공식 실행 문서](https://github.com/nasa/ExoMiner/blob/main/docs/running-exominer-pipeline.md), [모델 명세](https://github.com/nasa/ExoMiner/blob/main/docs/models_specs.md), [논문](https://arxiv.org/abs/2502.09790) | 저장소 commit `3881fdbb4ea4e8f822cecbd49c01aaccab1b1181` (2026-09-03), pipeline v2.1 |
| AstroNet-Triage | [공식 저자 저장소](https://github.com/yuliang419/Astronet-Triage), [논문](https://arxiv.org/abs/1904.02726) | commit `5675a57dd41dd0321df480453451096dc5a4a6b0` (2019-09-25) |
| AstroNet-Vetting | [공식 저자 저장소](https://github.com/yuliang419/Astronet-Vetting), [논문](https://arxiv.org/abs/1904.02726) | commit `4675987ae9c347fcd2ad2376703b9cb2314f0c0d` (2019-09-25) |
| ExoNet-Pytorch | [NASA FDL GitLab 저장소](https://gitlab.com/frontierdevelopmentlab/exoplanets/exonet-pytorch), [논문](https://arxiv.org/abs/1810.13434) | commit `a94f8399986ed97d5be8c884a0771d741e55e9c5` (2021-05-14) |

## 3. 모델 자산과 실행 방식

| 항목 | ExoMiner++ | AstroNet-Triage | AstroNet-Vetting |
|---|---|---|---|
| 용도 | TESS SPOC TCE의 2분/FFI photometric vetting 또는 planet validation | PC 또는 활동이 심하지 않은 EB 형태 후보를 junk와 분리하는 1차 triage | TESS TCE vetting |
| 체크포인트 | 컨테이너에 `single`, `cv_ensemble`, `full_cv_ensemble` 포함 | `astronet/models_final`에 10개 TF checkpoint 포함 | `models_final`에 `model_plain`, `model_dc`, `model_se`, `model_dc_se` 각각 10개 TF checkpoint 포함 |
| 자산 식별 근거 | DVC `models.tar` md5 `65cb5fcff5a13bdefb29fade74c80f1c`, 3,725,828,096 bytes | 대표 data blob `ad635fcc4482add463d846cbcf1ff7c86e82bc3b` | 대표 `model_dc_se` data blob `feac6bbf7e530917c75211653bb07898cbca7d81` |
| 실행 기술 | Python 3.11, TensorFlow/Keras 2.13.1, 권장 Podman 이미지 | TensorFlow 1 계열 graph/Estimator API와 TFRecord | TensorFlow 1 계열 graph/Estimator API와 TFRecord |
| 공식 입력 시작점 | `tic_id,sector_run` CSV에서 SPOC LC와 DV XML을 수집·전처리 | QLP HDF5 LC와 TCE 표를 TFRecord로 변환 | QLP HDF5 LC와 TCE 표를 TFRecord로 변환 |
| 모델 출력 | binary planet validation 또는 PC/AFP/NTP | `PC/EB` 대 `junk`의 triage 점수 | planet candidate 가능성 점수 |

AstroNet 코드에서 `tf.logging`, `tf.app`, `tf.placeholder`, `tf.parse_single_example`, `tf.python_io`를 직접 사용한다. 현재 TensorFlow 2 환경으로 단순 설치해 실행할 수 있다고 간주하지 않으며, 구버전 격리 환경이나 호환 코드 포팅이 필요하다.

Triage README는 `local_view` 길이를 81로 설명하지만, 확인한 commit의 `local_global` 설정과 실제 checkpoint·TFRecord 추론 경로는 61을 사용한다. Planetory adapter는 README 숫자를 그대로 구현하지 않고 고정 checkpoint가 요구하는 실제 graph와 공식 예제 shape를 검사해 버전으로 잠가야 한다.

AstroNet의 추론 스크립트는 매 실행마다 모델 graph를 다시 정의한 뒤 `tf.train.latest_checkpoint()`와 `tf.train.Saver().restore()`로 저장된 값을 graph에 복원한다. 이는 TensorFlow 1 계열의 일반적인 추론 방식이며, 새 모델을 학습하는 동작이 아니다. 확인한 `model.ckpt-14000`은 data 파일 24,320,668 bytes, index 4,216 bytes, meta 545,308 bytes로 구성되어 있다. checkpoint에는 실제 convolution·dense 가중치 약 2,026,721개와 과거 학습 과정에서 함께 저장된 Adam optimizer 상태가 포함되어 있지만, `batch_predict.py`는 `PREDICT` mode에서 `model.predictions`만 실행하고 optimizer나 학습 연산을 호출하지 않는다.

### ExoNet-Pytorch 자산 확인

ExoNet은 AstroNet을 PyTorch로 옮기고 광도곡선 외에 centroid 곡선과 항성 파라미터를 추가한 모델이다. 공식 저장소에는 `README.md`와 학습 스크립트 `exonet.py`만 있고 사전 학습 checkpoint, 별도 추론 스크립트, 의존성 lock과 라이선스 파일이 없다. README가 연결한 입력 자료도 Kepler 학습용 배열이다.

| 항목 | 확인 결과 |
|---|---|
| 모델 | `ExtranetModel`, 경량 `ExtranetXSModel` 구조가 코드에 정의됨 |
| 입력 | local/global flux, local/global centroid, stellar parameters |
| 데이터 형식 | `*local.npy`, `*global.npy`, `*local_cen_w.npy`, `*global_cen_w.npy`, `*info.npy` |
| 실행 방식 | PyTorch 학습 스크립트이며 모든 tensor와 모델에 `.cuda()`를 직접 적용 |
| checkpoint | 저장소에서 제공하지 않음. 스크립트 실행 후 새 `.pth`를 저장하는 코드만 있음 |
| 추론 경로 | 별도 제공하지 않음 |
| Planetory 적용 위험 | Jira 40은 새 모델 학습을 제외하므로 공개 checkpoint를 확보하지 못하면 사전 학습 모델 후보로 실행할 수 없음 |

## 4. Planetory Silver 후보와 입력 차이

Planetory의 현재 입력은 SPOC 2분 cadence LC FITS의 `TIME`, `PDCSAP_FLUX`, `QUALITY`와 자체 BLS가 만든 후보 기하값을 중심으로 한다. AI-02에 따라 후보마다 입력을 만들고 `candidate_id`, 곡선 단계, 반복 단계, 전처리 버전을 함께 기록해야 한다.

| 입력 묶음 | Planetory에서 현재 확보 가능 | 모델 요구와 차이 |
|---|---|---|
| 후보 식별·기하 | TIC, Sector, 자체 BLS period·epoch·duration·depth·SNR 일부 | 생성 경로와 단위·버전을 고정하면 공통 scalar로 사용 가능 |
| 정제 광도곡선 | 품질 필터·Sector 정규화·detrending 결과 | 모델 공식 binning·빈 bin·정규화 규칙과 아직 같지 않음 |
| global/local view | TOI-270 검증용 Triage 201/61 adapter 구현·실행 완료 | Triage README는 201/81이나 실행 설정은 201/61, Vetting은 201/61, ExoNet local/global, ExoMiner++ global 301/local 31 규격의 별도 adapter 필요 |
| odd/even·secondary view | 기존 PoC의 일부 진단값만 존재 | ExoMiner++가 요구하는 전체 tensor와 variance를 공식 방식으로 생성해야 함 |
| periodogram | 자체 BLS periodogram 존재 | ExoMiner++의 674-bin flux/TPM periodogram 정의와 동일하지 않음 |
| centroid·momentum dump | 원 FITS 컬럼을 아직 AI 계약으로 보존하지 않음 | ExoMiner++ local centroid와 momentum-dump 입력 생성 경로 필요 |
| 차영상 | 현재 Silver 후보에 없음 | ExoMiner++ 55×55×5 difference/OOT/SNR image가 가장 큰 결손 |
| DV/TCE scalar | 자체 BLS 후보는 SPOC TCE ID가 아닐 수 있음 | ExoMiner++ 공식 파이프라인의 DV XML·SPOC TCE 결합을 자체 후보용으로 분리 가능한지 확인 필요 |
| 항성·Gaia 정보 | 외부 원천 연결 설계만 존재 | 값의 원천·snapshot·missing 처리를 모델 공식 규칙과 맞춰야 함 |

화면 표시용 축약 배열은 AI 입력으로 사용하지 않는다. 모델 입력은 Silver 내부 산출물로 만들고, 점수와 실행 상태·모델·체크포인트·입력 버전만 Gold 공개 묶음에 연결한다.

## 5. 이번 PC 실행 환경과 최소 추론 시도

확인 시각은 2026-09-09이며 저장소 기준 commit은 `352290f5b269f5a21127e3583b0ad4f618cd118e`다.

| 항목 | 결과 |
|---|---|
| OS/아키텍처 | Windows x86_64 |
| Python | 3.11.9 |
| uv | 0.11.27 |
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU, 6,141 MiB, driver 591.44 |
| TensorFlow | 미설치, import 실패: `ModuleNotFoundError` (214 ms) |
| Podman | 명령 미설치 |
| Docker | CLI 29.7.2 설치, engine 미실행 |
| ExoMiner 컨테이너 시도 | `docker run --rm ghcr.io/nasa/exominer:latest --help`가 engine 연결 단계에서 exit 1 (215 ms) |
| AstroNet 격리 환경 | WSL Ubuntu 24.04 안의 Python 3.7.12, TensorFlow 1.15.5, protobuf 3.20.3, matplotlib 3.3.4 |
| AstroNet 공식 추론 | Triage `model_1/model.ckpt-14000` 복원 성공, 공식 test TFRecord 1,635건 처리, exit 0 |
| AstroNet 실행 자원 | CPU, wall time 7.84초, 최대 RSS 279,080KiB(약 272.5MiB), swap 0 |
| AstroNet 출력 | `prediction_official.txt` 1,635행 생성, SHA-256 `d966db6c55cfd2b701ab9eab7c6d5ce3860ee039793393a1f30c831fadf1a089`. 예: TIC 332518086 → 0.002 |
| TOI-270 입력 변환 | Sector 3·4·5, TIC 259377017. 원천 57,320점 중 44,551점 사용. BLS period 5.659330303일, t0 1389.509827328 BTJD, duration 1.200시간, depth 0.00344829, SNR 54.483 |
| TOI-270 AstroNet 추론 | `global_view` 201개와 `local_view` 61개를 TFRecord로 변환해 같은 `model_1/model.ckpt-14000`에서 exit 0, 점수 **0.258** 출력 |
| TOI-270 실행 자원 | CPU, wall time 3.52초, 최대 RSS 277,044KiB(약 270.6MiB), swap 0. 모델 로딩 시간이 포함된 단일 후보 실행 |
| TOI-270 출력 | `prediction_toi270.txt` 1행 생성, SHA-256 `2e84dba5ca020b4cb59e7583f2ad4504035d5a34e1ef912920de233a1af1ab0d` |
| L 98-59 비교 실행 | TIC 307210830, Sector 2·5·8. BLS period 3.690591840일은 확인된 L 98-59 c의 3.6906764일과 대응하며, 같은 단일 checkpoint 점수는 **0.816** |
| CM Draconis 비교 실행 | TIC 199574208, Sector 16. BLS period 0.633504862일은 식쌍성 공전주기의 반 주기와 대응하며, 같은 단일 checkpoint 점수는 **0.998** |
| ExoNet 실행 준비 | 공식 저장소에 checkpoint와 추론 스크립트가 없어 새 학습을 하지 않는 Jira 40 범위에서 추론 시작 불가 |

재현 명령:

```powershell
podman --version
docker info
docker run --rm ghcr.io/nasa/exominer:latest --help
python -c "import tensorflow as tf; print(tf.__version__)"

# WSL의 AstroNet Python 3.7 격리 환경
micromamba create -y -p <python-3.7-env> -c conda-forge python=3.7 pip
<python-3.7-env>/bin/python -m pip install \
  tensorflow==1.15.5 matplotlib==3.3.4 protobuf==3.20.3

PYTHONPATH=<astronet-triage-clone> /usr/bin/time -v \
  <python-3.7-env>/bin/python \
  <astronet-triage-clone>/astronet/batch_predict.py \
  --model_dir=<astronet-triage-clone>/astronet/models_final/model_1 \
  --tfrecord_dir=<astronet-triage-clone>/astronet/tfrecords \
  --suffix=official

# Planetory TOI-270 후보 입력 생성. 원본 FITS와 NPZ는 Git에 포함하지 않는다.
uv run --python 3.11 --project experiments/tess-bls \
  python experiments/astronet-feasibility/prepare_toi270_probe.py \
  --output=<temporary-dir>/toi270_probe.npz

# TensorFlow 1 격리 환경에서 TFRecord 생성 후 위 batch_predict.py를 같은 checkpoint로 실행한다.
<python-3.7-env>/bin/python \
  experiments/astronet-feasibility/write_probe_tfrecord.py \
  --input=<temporary-dir>/toi270_probe.npz \
  --output=<tfrecord-dir>/test-00000-of-00001
```

AstroNet 공식 예제와 Planetory 자체 BLS 후보 추론이 모두 성공했으므로 checkpoint와 코드를 CPU에서 실행하고 후보를 기술적으로 연결할 수 있다는 점은 확인됐다. TOI-270 c는 NASA Exoplanet Archive에 확인된 행성으로 등록되어 있으며, BLS period 5.659330303일은 공전주기 약 5.66일과 대응한다. 이 후보의 0.258은 공식 스크립트의 임시 0.4 분기에서 `junk`에 해당한다. 반면 확인된 L 98-59 c 대응 후보는 0.816이었다. 단, 두 건으로 재현율이나 정확도를 계산할 수 없다. 입력은 QLP의 `KSPMagnitude`가 아니라 SPOC `PDCSAP_FLUX`를 Planetory 방식으로 detrending했고 단일 checkpoint만 사용했으며 공식 10개 모델 ensemble도 적용하지 않았다.

특히 이 checkpoint의 양성 라벨은 `PC/EB`이고 음성 라벨은 `junk`다. 공식 README와 `batch_predict.py`는 점수 0.4 이상을 `PC/EB`로 표기하며, “plausible planet candidate”에는 활동이 심하지 않은 eclipsing binary도 포함된다고 명시한다. 따라서 CM Draconis의 0.998은 행성을 식별한 결과나 행성에 대한 false positive가 아니라, 이 1차 triage가 식 현상을 강하게 포착했다는 결과다. AstroNet-Triage 단독으로 PC와 EB를 분리하거나 행성을 확정하는 용도로 사용할 수 없다.

## 6. 라이선스 확인 결과

| 후보 | 확인 결과 | 남은 확인 |
|---|---|---|
| ExoMiner++ | README는 NASA Open Source Agreement(NOSA)를 소프트웨어 릴리스 조건으로 연결한다. 모델 명세의 metadata에는 `apache-2.0`이 적혀 있고 저장소 루트에는 일반적인 `LICENSE` 파일이 없다. | 코드·체크포인트·컨테이너 각각에 적용되는 조건이 서로 같은지 공식 배포자 또는 팀 라이선스 담당 확인 필요 |
| AstroNet-Triage/Vetting | 두 저장소 루트 `LICENSE`는 GPL-3.0이다. 일부 상속 코드 파일에는 Apache-2.0 헤더가 있다. 체크포인트에 별도 라이선스 파일은 확인되지 않았다. | 코드를 제품에 포함·수정·배포할 때의 GPL 영향과 체크포인트 적용 조건을 팀에서 확인해야 함 |
| ExoNet-Pytorch | 확인한 저장소 루트에 라이선스 파일이나 README의 라이선스 선언이 없다. 논문과 NASA FDL 출처 표기만 있다. | 코드와 외부 입력 자료의 사용·수정·배포 가능 범위를 저자 또는 저장소 관리자에게 확인해야 함 |

라이선스 확인이 끝나기 전에는 어떤 후보도 배포 가능 모델로 확정하지 않는다.

## 7. 1차 판정 제안

| 후보 | 제안 상태 | 근거와 다음 조건 |
|---|---|---|
| AstroNet-Triage | **1차 후보 선별 연결 성공, 행성 판별 채택 보류** | 공개 checkpoint와 공식 예제 추론에 이어 TOI-270·L 98-59·CM Draconis 후보를 201/61 adapter로 실행했다. checkpoint의 학습 목표가 `PC/EB` 대 `junk`이므로, Planetory의 행성 판별 모델로 단독 채택할 수 없다. 전처리 동등성·ensemble·라벨별 평가와 EB vetting 경로가 필요하다. |
| AstroNet-Vetting | **AstroNet 2순위 보류** | Triage 실행 환경을 재사용할 수 있지만 여러 평균 모델과 추가 feature가 필요하다. Triage 재현 뒤 실제 이점과 추가 비용을 비교한다. |
| ExoNet-Pytorch | **2단계 조사, 현재 추론 보류** | PyTorch라 TensorFlow 1보다 현대화 여지는 있지만 공식 checkpoint와 추론 경로가 없다. checkpoint의 공식 제공 위치를 먼저 확인하며, Jira 40에서 새 학습으로 대체하지 않는다. |
| ExoMiner++ `single` | **3단계 보류** | 최신 TESS 2분 공식 파이프라인과 사전 학습 모델이 있다. 앞선 두 계열을 확인한 뒤 자체 BLS 후보용 입력 adapter, 필수 입력 확보율, 라이선스와 container inference를 검증한다. |

어떤 모델도 `selected` 또는 `adopted`로 표시하지 않는다. 팀은 이 표를 리뷰한 뒤 후속 실험 범위를 확정한다.

## 8. 후속 Task 제안

1. **AstroNet 기준 실행 — 완료**: 재현 가능한 격리 환경에서 Triage checkpoint 1개와 공식 TFRecord를 실행하고 CPU, peak memory와 시간을 기록했다.
2. **AstroNet SPOC adapter — 1차 완료**: TOI-270, L 98-59, CM Draconis 자체 BLS 후보를 checkpoint 기준 201/61 global/local view로 변환해 점수 출력을 확인했다. 후속 평가는 QLP 학습 전처리와 SPOC·Planetory 전처리 차이를 대조하고 공식 10개 checkpoint ensemble을 비교한다.
3. **Triage 성능 평가 설계**: TIC 단위 분리의 확인 행성 후보(PC), 식쌍성(EB), 기기·변동 잡음(junk) 세트를 만들고 PC/EB 대 junk의 재현율·정밀도·PR-AUC와 입력·추론 성공률을 측정한다. PC와 EB의 구분 평가는 이 checkpoint의 범위 밖이므로 별도 vetting 모델 또는 규칙을 비교한다.
4. **ExoNet checkpoint 확인**: NASA FDL 저장소와 연결 자료에서 논문에 사용된 사전 학습 checkpoint의 공개 위치·hash·라이선스를 확인한다. 찾지 못하면 사전 학습 모델 후보에서 제외 근거를 확정한다.
5. **ExoNet 입력 차이 확인**: flux 외 centroid view와 항성 파라미터의 Planetory 확보 가능성을 조사한다. 새 학습은 별도 Jira가 승인된 경우에만 진행한다.
6. **ExoMiner++ 후순위 검증**: 앞선 후보 결과를 본 뒤 공식 `single` container 추론과 자체 BLS 후보 입력 adapter 필요성을 다시 판단한다.
7. **라이선스 결정**: 세 모델 계열의 코드·checkpoint·입력 자료에 대한 서버 사용·수정·재배포 조건을 기록한다.
8. **모델 평가·임계값 결정**: 실행 가능한 후보만 TIC 단위로 분리한 조정/평가 세트에서 정밀도·재현율·PR-AUC와 입력·추론 성공률을 비교한다. `below/review/approved` 임계값은 이 결과로 별도 확정한다.

## 9. Jira 40 완료 조건 대조

| 완료 조건 | 현재 상태 | 근거 또는 남은 일 |
|---|---|---|
| 모델 후보와 공식 출처 | 완료 | 2절 |
| checkpoint 제공 여부 | 완료 | 3절의 경로·자산 식별값 |
| 라이선스 | 조사 완료, 결정 보류 | 6절의 불일치·추가 확인 사항 |
| 입력·전처리 비교 | 1차 완료 | 4·5절. TOI-270 adapter 실행 완료, QLP와 Planetory 전처리 동등성 평가는 후속 작업 |
| Planetory 입력 결손 | 완료 | 4절 |
| 최소 추론 성공 또는 재현 가능한 불가 사유 | 완료 | AstroNet-Triage 공식 TFRecord와 Planetory TOI-270 후보 모두 checkpoint 추론 성공 |
| 환경·버전·시간·오류 | 완료 | 5절. 공식 1,635건 7.84초·약 272.5MiB, TOI-270 1건 3.52초·약 270.6MiB |
| 채택·보류·제외와 근거 | 1차 제안 완료 | 7절, 팀 미확정 |
| 후속 adapter·평가·배포 Task 제안 | 완료 | 8절 |
| 문서/MR 링크 Jira 등록 | 미완료 | 사용자 commit·push 및 MR 생성 뒤 등록 |

현재 문서만으로 모델 선정이나 Jira 완료를 선언하지 않는다. 다음 단계는 TOI-270의 0.258 점수 원인을 전처리·ensemble 관점에서 확인하고, ExoNet의 공식 checkpoint 부재 근거를 확정한 뒤 팀 리뷰에서 AstroNet을 Planetory 평가 후보로 유지할지 결정하는 것이다.

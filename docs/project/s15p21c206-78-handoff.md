# S15P21C206-78 Silver 처리·Airflow 인계

> 상태: 구현·252 통합·로컬 검증 완료, 실클러스터 Canary 합격(2026-09-23 2회, 2026-09-24 보강 release 1회), 전체 run 시작 조건 충족·시작 전, Airflow 배포 전<br>
> 기준 브랜치: `feature/S15P21C206-78-spark-silver-distributed-processing`<br>
> 기준일: 2026-09-23<br>
> Jira: [S15P21C206-78](https://ssafy.atlassian.net/browse/S15P21C206-78)

이 문서는 현재 작업을 다른 담당자가 안전하게 이어가기 위한 **일회성 인계 기록**이다. 정본은 Spark·Airflow·운영 README와 변경 이력이며, 아래 완료 조건을 충족하고 인계가 끝나면 이 파일과 [프로젝트 문서 인덱스](README.md)의 링크를 반드시 삭제한다. 완료된 작업의 영구 상태 문서로 남기지 않는다.

## 이번 세션에서 구현한 범위

### Silver 실행·재처리 계약

- `libs/astro-kernel/astro_kernel/bls.py`, `iteration.py`에서 최초 `search_bls` 결과를 동일 입력 검증 뒤 첫 반복에만 메모리로 재사용한다. 배열·Sector·baseline·입력 버전·입력 개수 digest가 다르면 `invalid_input`으로 거절하며, 제거 후 탐색은 다시 계산한다.
- `distributed-system/spark/tess_silver.py`는 최초 BLS와 반복 탐색을 `initial_bls`·`iteration` stage로 분리하고, v3 manifest/attempt READY에서 정상 완료·미완료·실패를 구분한다. 반복 결과는 후보 ID·Gold 공개를 만들지 않는다.
- Canary 또는 retry는 TIC 필터와 이전 manifest join을 Bronze 행 전체 스캔보다 먼저 적용한다. 전체 run만 전체 TIC 집합을 확정한다.
- `distributed-system/spark/tess_silver_ctl.py`는 Bronze coverage를 정확히 `/lake/bronze/tess/coverage=<64자리 소문자 SHA-256>` 형식으로 제한한다. retry는 같은 Bronze coverage lineage의 완료된 v3 attempt만 사용한다.

### Airflow → Node 1 → Spark on YARN 경로

- `distributed-system/airflow/dags/tess_silver_dag.py`에 `tess_bronze_to_silver` DAG를 추가한다. `schedule=None`, 생성 시 pause, `max_active_runs=1`이며 자동 실행하지 않는다.
- `distributed-system/airflow/dags/tess_silver_contract.py`는 Trigger conf를 allow-list로 검증하고 shell-safe 명령을 만든다. 필수값은 `operation`, immutable Silver release, 1~13 Bronze coverage, UTC run ID, pipeline version이다. Canary는 양의 중복 없는 TIC 1~5개, retry는 immutable attempt 경로만 받는다.
- DAG는 `planetory_node_1` SSH connection으로 Silver controller를 호출한다. 2026-09-23부터 `tess_pipeline_enabled=false`·Raw/Bronze run 부재라는 시작 조건을 제거했다. 2026-09-24부터 `validate_request` → `start_unit`(systemd unit 설치·시작 후 즉시 종료) → `wait_silver`(Triggerer 5분 간격 `status` 확인, 최대 14일)의 비동기 구조이며, Silver task는 `tess_yarn` Pool을 쓰지 않는다. YARN 상한은 unit 안의 제어기 슬롯 파일과 사전 점검이 지킨다. 252 `commit_bronze`는 계속 Pool을 쓴다.
- `distributed-system/spark/tess_bronze_ctl.py`와 `tess_silver_ctl.py`는 Node 1의 `/run/planetory-tess-yarn-<N>.lock` 슬롯 파일을 공유하는 카운팅 세마포어(`yarn_slot`)로 YARN 제출 **동시 실행 수에 상한**을 둔다. 슬롯 수는 `PLANETORY_YARN_SLOTS`(기본 2, 1~8)이며 Airflow Pool 슬롯과 같아야 한다. 제한 sudo는 환경 변수를 전달하지 않으므로 Airflow 경로는 항상 기본값을 쓴다. 기본 2는 용량 실측 없이 고른 보수값이며, 올리려면 실제 YARN 메모리·시간 측정 근거가 필요하다.
- `infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh <release-id> [slots]`는 지정 release 경로와 상위 디렉터리의 root 소유·비쓰기 권한을 검사한 뒤, 해당 release controller의 `start-unit`·`status`만 허용하는 sudoers 두 줄과 `tess_yarn` Pool(기본 2 슬롯)을 만든다. 기존 sudoers 내용이 다르면 덮어쓰지 않고 실패한다.
- `distributed-system/airflow/requirements.txt`는 252가 전환한 `apache-airflow==3.2.2`와 FAB·SSH `5.0.2`·Standard provider 고정을 따른다. 78이 Airflow 2.10.5 기준으로 넣었던 `apache-airflow-providers-ssh==4.1.6` 핀은 통합 시 제거했다.
- Airflow 3에서는 DAG 코드가 metadata DB에 접근할 수 없으므로 Silver 사전 게이트의 Raw/Bronze 실행 확인은 Task SDK `ti.get_dr_count(dag_id=..., states=[...])`를 사용한다. 252가 제거한 레거시 `tess_sector_download_raw_bronze`는 검사 대상이 아니다.

## 문서·테스트 변경

다음 정본에 계약·운영 경계·검증 상태를 반영했다.

- [Spark Silver 계약](../../distributed-system/spark/README.md#tess-bronze--silver-최초-탐색-s15p21c206-78)
- [Airflow DAG 실행 계약](../../distributed-system/airflow/dags/README.md)
- [분산 시스템 운영 절차](../../infra/distributed-system/README.md)
- [데이터 처리 기준](../data/data-guidelines.md)
- [커널 BLS/반복 계약](../../libs/astro-kernel/README.md)
- [2026-09-22 변경 이력](../changes/2026-09-W4/2026-09-22.md)

추가·수정한 회귀 검사는 `libs/astro-kernel/tests/test_iteration.py`, `distributed-system/spark/test_tess_silver.py`, `distributed-system/spark/test_tess_bronze.py`, `distributed-system/airflow/tests/test_tess_silver_dag.py`, `infra/distributed-system/scripts/test-tess-silver.ps1`이다.

## 검증 결과

| 구분 | 실행·확인 | 결과 |
| --- | --- | --- |
| 커널·Spark·Airflow 계약 | `libs/astro-kernel/.venv/Scripts/python.exe -m pytest -q libs/astro-kernel/tests distributed-system/spark/test_tess_silver.py distributed-system/spark/test_tess_bronze.py distributed-system/airflow/tests/test_tess_silver_dag.py` | 246 passed, 12 subtests passed |
| 변경 핵심 회귀 | `pytest -q -p no:cacheprovider distributed-system/airflow/tests/test_tess_silver_dag.py distributed-system/spark/test_tess_silver.py distributed-system/spark/test_tess_bronze.py` | 40 passed, 14 subtests passed |
| PowerShell 통합 검사 | `infra/distributed-system/scripts/test-tess-silver.ps1` | 20 passed, 1 skipped(Astropy가 system Python에 없음), Airflow 계약 4건 통과 |
| 서버 정적 점검(2026-09-22, Airflow 2.10.5 시점) | 당시 scheduler container에 새 DAG/계약을 메모리 import, Node 1에서 Bash·생성 sudoers 문법 검사 | 통과. **3.2.2 전환 후 재확인 필요** |
| 252 통합(2026-09-23) | `unittest discover distributed-system/airflow/tests` 20 passed, `pytest libs/astro-kernel/tests distributed-system/spark/test_tess_silver.py test_tess_bronze.py` 245 passed·3 subtests | 통과 |
| Airflow 3.2.2 DAG import(2026-09-23) | WSL `~/.venvs/airflow322`(airflow 3.2.2·fab 3.6.4·ssh 5.0.2·standard 1.13.1·task-sdk 1.2.2, 공식 `constraints-3.2.2/constraints-3.12.txt`)에서 `DagBag(distributed-system/airflow/dags)` 적재 | import 오류 0건. `tess_bronze_to_silver`와 252의 `tess_sector_discovery`·`download`·`raw`·`cleanup`·`bronze` 6개 DAG가 함께 등록됨 |
| Task SDK 계약(2026-09-23) | 같은 환경에서 `RuntimeTaskInstance.get_dr_count` 시그니처 확인 | `(dag_id, logical_dates=None, run_ids=None, states: list[str] \| None = None) -> int`. Silver 게이트의 `states=["queued", "running"]` 호출과 일치 |
| 문서·diff | 상대 링크 검사, `git diff --check` | 통과 |

위 DAG import 검증은 로컬 WSL DagBag 적재이며 운영 이미지 배포가 아니다. 실제 Spark/PySpark·YARN Canary, Airflow DAG 배포·trigger, sudoers/Pool 변경은 실행하지 않았다. 따라서 위 결과를 운영 배포 또는 전체 Silver 생성 완료로 해석하지 않는다.

## 운영 배포 적합성 검토(2026-09-23)

로컬 코드·설정 검토와 합성 곡선 측정 결과다. 서버 상태는 조회하지 않았다.

**수정 완료** — Pool 동시성(`a624710d`) 뒤에도 두 제어기의 사전 점검이 "RUNNING YARN 앱이 하나라도 있으면 실패"를 유지해, Silver가 도는 동안 252 `commit_bronze`가 12회 재시도 후 실패하는 결함이 있었다. `require_yarn_headroom`으로 바꿔 외부 앱은 거부하고 파이프라인 앱은 슬롯 수 미만일 때만 허용한다. 이름 열을 못 읽는 행은 외부 앱으로 간주한다.

**확인 통과** — Airflow가 만드는 canary·run·retry 명령이 setup script의 sudoers 인자 정규식과 모두 일치한다(회귀 검사 추가). 저장소 YARN 설정 기준 NodeManager 메모리 합계는 112 GiB(24 GiB×4 + 16 GiB)이고 기본 `DefaultResourceCalculator`라 메모리만 배정한다. Spark 작업 하나가 약 43 GiB(executor 8 GiB×5 + driver 3 GiB)이므로 2개 동시 배정이 가능하다. vcore는 강제되지 않아 두 작업이 겹치면 CPU를 나눠 쓴다.

**처리 시간 추정** — 합성 2분 cadence 곡선으로 `process_tic`(전처리+최초 BLS+반복 탐색)을 이 PC에서 측정했다: 1 Sector 6.3초, 3 Sector 17.9초, 13 Sector 44.4초. Sector 1~13 제품 247,824개를 executor core 10개로 나누면 약 1.5일이며, 서버 CPU·실데이터 후보 수를 고려한 **추정 범위는 2~5일**이다. 14일 timeout 안에 들지만 실측이 아니다.

**반복 탐색 QA 판정 분리 — 해결(2026-09-23)**
13 Sector 합성 행성에서 반복 탐색이 `removal_qa_failed`로 끝났다. 실제 행성(P=3.69998일)은 step 0에서 수락됐으나, 박스 모델 제거 잔차의 5배 alias(18.5일)가 `alias_multipliers=(0.5, 1, 2)` 밖이라 새 후보로 잡힌 뒤 QA에 실패했다. 고SNR·장기관측 TIC에서 재현될 가능성이 높다. 이 결과가 `failed_tics`에 합산되어 Canary가 실패하고 retry도 같은 결과를 반복하는 문제가 있었다. 이제 커널 품질 판정 종료(`removal_qa_failed`, `candidate_validation_failed`)는 manifest `status=qa_stopped`(retryable 아님)로 기록하고 `iteration_qa_stopped_tics`에만 센다. `failed_tics`·Canary 판정·retry 선택에서는 빠지며, 멈추기 전 수락 후보와 반복 출력은 보존한다. 같은 합성 사례를 실제 커널로 다시 돌려 `qa_stopped`를 확인했다. `numerical_failure`와 `incomplete`는 그대로 실패 집계에 남는다. 판정 기준(배수 alias 목록 등) 자체의 조정은 122 커널 범위이며 여기서 바꾸지 않았다. 스키마는 stage·summary·attempt 모두 v4다.

**실클러스터 Canary 1 (2026-09-23) — 불합격, 원인 수정**
release `20260923T080904Z`(HEAD `4af1943d`), TIC `259377017`, `application_1790067725443_0030`은 SUCCEEDED했으나 TIC가 `invalid_bronze_row`(`Out of range float values are not JSON compliant: nan`)로 실패해 exit 65로 끝났다. 245(`9f62bb0f`)가 준비 단계 제외 목록에 `original_time`을 추가했고, 78의 `_target_row`는 그 목록을 엄격 JSON으로 그대로 직렬화했다. 실제 SPOC 곡선의 관측 공백 NaN 시각에서 실패하므로 전체 run의 거의 모든 TIC가 실패했을 결함이다. 로컬 합성 곡선에는 NaN 시각이 없어 잡지 못했다. `_strict_exclusions`로 `exclusion_ledger`와 같은 인코딩(null + `original_time_nonfinite`)을 적용하고 NaN·Inf 시각 회귀 검사를 추가했다. 사전 점검 시점에 252 Bronze Sector 42(`_0029`)가 실행 중이었고 새 헤드룸 검사가 동시 실행을 허용했으며, 두 앱 모두 SUCCEEDED해 병렬 실행이 실운영에서 처음 동작했다. 실패 attempt(20.6 KB)는 `/validation/S15P21C206-78/run=20260923T081349Z/attempt=20260923T081629Z`에 남아 있다. HDFS 휴지통이 꺼져 있어(`fs.trash.interval=0`) 삭제는 되돌릴 수 없으므로 정리 여부는 운영자가 결정한다.

**실클러스터 Canary 재실행·Canary 2 (2026-09-23) — 합격**

release `20260923T083458Z`(HEAD `994f5a5d`)로 두 번 실행했다. 두 번 모두 YARN 실행 앱 0개에서 시작했고, 종료 0, 검증 출력·Spark staging 정리, 상태 파일 `complete`를 확인했다.

| 실행 | YARN 앱 | 결과 | 소요(제어기) |
| --- | --- | --- | --- |
| Canary 1 재실행, TIC `259377017` | `application_1790067725443_0031` | `SILVER_CANARY_OK tics=1`, `failed_tics=0` | 10분 22초 |
| Canary 2, TIC 4개 | `application_1790067725443_0032` | `SILVER_CANARY_OK tics=4`, `failed_tics=0`, `qa_stopped=2` | 11분 40초 |

Canary 1 재실행은 9월 21일 기준값과 전처리·최초 BLS가 정확히 같았다: Raw 57,320 → 준비 44,553 → BLS 입력 44,550, 1위 주기 5.6593303027일, SNR 52.8359, SDE 22.5652. `raw = kept + excluded`(44,550 + 12,770)도 맞았다. 반복 탐색은 실클러스터에서 처음 실행되어 `succeeded`·`no_quality_peak`·수락 3개로 끝났다.

Canary 2는 111·122 벤치마크 별로 Sector 수와 신호 성격을 나눠 골랐다.

| TIC | 별 | 결합 Sector | Raw → 준비 | 최초 1위 주기 | 참고 주기 | 반복 탐색 |
| --- | --- | --- | --- | --- | --- | --- |
| 149603524 | WASP-62 | 12 (1~4, 6~13) | 226,446 → 179,810 | 4.4105일, SNR 824 | b 4.412일 | `qa_stopped`(`removal_qa_failed`), 수락 1 |
| 150428135 | TOI-700 | 11 | 205,534 → 164,757 | 16.0526일 | c 16.051일 | `succeeded`, 수락 3 |
| 307210830 | L 98-59 | 7 | 133,169 → 105,020 | 3.6910일 | c 3.691일 | `qa_stopped`(`removal_qa_failed`), 수락 2 |
| 279741379 | HD 21749 | 4 | 78,189 → 64,118 | 게이트 통과 peak 없음 | 35.61일(통과 1~2회) | `succeeded`, 수락 0 |

- 세 별에서 가장 강한 행성의 주기를 0.03% 이내로 회수했다. 최초 BLS 상위 5개는 대부분 그 행성의 배수·약수 alias였으므로 최초 `accepted_peaks`를 후보로 쓰지 않는 122 규칙이 실데이터에서도 필요하다.
- QA 판정 2건은 깊은 신호·다중 Sector 별에서 첫 행성을 수락한 뒤 제거 잔차 alias로 멈춘 경우로, 13 Sector 합성 사례와 같은 양상이다. `qa_stopped` 분리 전이었다면 Canary 2는 `failed_tics=2`로 불합격했다.
- 반복 탐색 수락 후보의 주기는 audit에 개수만 남아 TOI-700의 수락 3개가 어느 행성인지는 이 결과로 확인하지 못했다.

**실측 기반 재추정** — Canary 2 관측점 643,338개의 출력은 `target_combined` 31.1 MB, `periodogram` 3.6 MB(논리)였다. 관측점당 약 48 B이므로 Sector 1~13의 46.7억 점은 약 225 GB, periodogram은 TIC당 약 0.91 MB로 TIC 10~15만 가정 시 90~140 GB다. 합계는 논리 약 0.32~0.37 TB, **RF2 약 0.63~0.73 TB**(이전 추정 0.8~0.9 TB). 두 Canary 모두 Bronze 83 GB 선택 스캔의 고정 비용이 약 5분이었다. TIC 수가 적어 TIC당 비용은 분리하지 못했으며 전체 run 추정 **2~5일**을 유지한다.

**보강 release Canary (2026-09-24) — 합격**

재기동 전 staging 정리와 예외 분류(`65368d6e`)를 반영한 release `20260924T063740Z`로 TIC 5개(`259377017`과 위 4개)를 한 번에 실행했다. TIC별로 따로 처리하고 audit도 TIC별로 남으므로 결과는 Canary 1·2를 나눠 실행한 것과 같다. `application_1790067725443_0061` SUCCEEDED(Spark 7분 18초, 제어기 12분 20초), `SILVER_CANARY_OK tics=5`, `failed_tics=0`, `qa_stopped=2`, 검증 출력·Spark staging 정리, 상태 파일 `complete`를 확인했다. 5개 TIC 모두 2026-09-23 결과와 같았고 TIC `259377017`은 9월 21일 기준값과 정확히 일치했다. 보강은 정상 경로의 과학 결과를 바꾸지 않았다. 실패 시 staging 정리는 성공 실행에서 동작하지 않으므로 실클러스터에서는 아직 검증되지 않았고 로컬 회귀 검사로만 확인했다. 이후 처리량 보강 release로 대체됐다(아래).

**Bronze TIC 수 집계 (2026-09-24, 읽기 전용)** — Node 1 Spark local 모드로 Bronze Sector 1~70의 `tic_id`·`sector`·`product_id`만 읽었다(8분, HDFS 쓰기 없음). 70개 Sector 모두 `_READY` 있음·파싱 오류 0, 제품 1,270,733개. 중복을 뺀 TIC는 **Sector 1~70 489,374개, 1~13 128,258개, 14~70 415,830개, 두 범위 모두 54,714개**다. 잘못된 식별자·중복 `product_id`·같은 TIC의 한 Sector 복수 제품은 모두 0건이다. 1~13 TIC의 72%(92,443개)는 Sector 1개, 13개 모두는 1,828개다. 1~13 TIC의 43%가 14~70에도 관측이 있어, 이후 단계는 1~70을 TIC별로 합쳐 다시 처리하는 방안을 80 계약에서 정한다. 1~70을 한 번에 처리하면 출력이 RF2 약 3.5 TB로 HDFS 75% 기준을 넘는다(추정).

**전체 run 처리량 보강 (2026-09-24)** — Worker 5대는 각각 vCPU 6개(AMD EPYC 7B12 또는 Xeon 2.2 GHz)·메모리 35 GB이고 YARN은 비어 있는데, 기존 제출은 executor 5개 × core 2개로 동시 10작업이었다. executor 10개 × core 2개로 늘려 동시 20작업으로 바꿨다. 처음 시도한 executor 5개 × core 4개는 YARN이 `maximum-allocation-vcores=3`을 넘는다며 거부했다(`application_1790067725443_0062`, 2026-09-24). YARN이 메모리만으로 배치하더라도 컨테이너당 vcore 상한은 따로 검사한다. 이 실패에서 재기동 전 staging 정리가 실클러스터에서 처음 동작해 `SILVER_FAILED_ATTEMPT_DISCARDED`, 상태 `failed`·`staging_discarded=true`, 남은 staging 0개를 확인했다. 또 `results`를 게으르게 캐시만 한 채 첫 `coalesce(80)` 쓰기에서 계산해, BLS 전체가 80작업으로 묶이고 긴 꼬리가 생기는 구조를 찾아 `results.count()`로 미리 계산하게 했다. 전체 run은 `-ShufflePartitions 500`으로 시작한다. TIC 128,258개 기준 추정은 **약 1~2.5일**(기존 2~5일)이며 실측이 아니다. BLS 격자·반복 탐색은 110·111·120·122 검증 설정이라 바꾸지 않았다. worker-4는 SSH 연결 실패로 사양을 확인하지 못해 같은 사양으로 가정했다.

**처리량 보강 release Canary (2026-09-24) — 합격, 전체 run용**

release `20260924T093328Z`(HEAD `a21bb2d8`, executor 10개 × core 2개, `results.count()` 선계산)로 같은 TIC 5개를 실행했다. `application_1790067725443_0063`이 컨테이너 11개(executor 10 + driver 1)로 떠 동시 20작업을 확인했고 SUCCEEDED(Spark 5분 31초, 이전 7분 18초), `SILVER_CANARY_OK tics=5`, `failed_tics=0`, `qa_stopped=2`, 검증 출력·Spark staging 정리, 상태 `complete`였다. 5개 TIC의 과학 값은 이전 결과와 모두 같다. TIC 5개로는 20작업을 채우지 못하므로 단축분은 주로 Bronze 선택 스캔이며, 전체 run 처리 시간은 시작 후 완료 작업 수로 다시 계산한다. **전체 run에는 이 release를 쓴다.**

**Canary TIC 선택 시 주의** — 최초 전처리 결과가 `insufficient_observations`(유효 관측 500점 미만) 같은 결정적 데이터 판정인 TIC도 여전히 `failed_tics`에 들어가 Canary를 실패시킨다. 첫 Canary는 이전 실클러스터 기준 TIC `259377017`처럼 관측이 충분한 TIC로 고른다.

**전체 `run` 전에 해결할 것**
1. Spark 작업이 전체를 한 번에 확정하며 `spark.yarn.maxAppAttempts=1`이다. 중간 실패 시 처음부터 다시 도는 것은 **감수하기로 했다**(2026-09-24). 재기동 때 실패한 attempt의 staging이 쌓여 75% 점검에서 멈추던 문제는 **보강했다**: 제어기가 YARN 앱 종료를 확인한 뒤 자기 attempt staging만 지우고, 앱 상태가 불확실하면 남긴다. TIC 묶음별 확정은 결과가 여러 attempt로 나뉘어 후속 소비 계약이 바뀌므로 하지 않았다.
2. **HDFS 여유가 빠듯하다.** 2026-09-23 기준 10.03 TB 중 3.81 TB(38%)를 쓰며, 252가 Sector당 복제 포함 약 90 GB(Raw 약 38 GB + Bronze 약 6.8 GB, 논리)를 계속 적재한다. Sector 70까지 끝나면 약 6.3 TB(63%), Silver 전체 run(RF2 약 0.63~0.73 TB)을 더하면 **약 70%**로 사전 점검 기준 75%에 가깝다. 252 완료 뒤 시작하므로 252 적재와 겹치지는 않지만, 75%를 넘으면 이후 Bronze·Silver 사전 점검이 모두 거부한다. 실행 중 shuffle·`DISK_ONLY` 결과가 HDFS와 같은 `/mnt/data`를 추가로 쓰고, `excluded_json`이 `exclusion_ledger_json`에 중복 포함된다.
3. **252 Bronze release는 교체하지 않고, 252가 Sector 70을 끝낸 뒤 전체 run을 시작한다(2026-09-23 결정 A).** 서버의 252 Bronze(`20260922T021406Z`)는 RUNNING YARN 앱이 하나라도 있으면 사전 점검에서 실패하므로, 252가 적재하는 동안 며칠짜리 Silver run을 돌리면 252 Bronze가 계속 실패한다. 교체는 비용이 크다. Airflow 계정 sudoers는 파일 하나가 HDFS 적재·Bronze release를 **같은 ID 하나로** 허용하고, 설정 스크립트는 기존 파일과 다르면 덮어쓰지 않고 실패한다(`AIRFLOW_SUDOERS_CONFLICT`). 이미 허가된 Sector는 이전 release 경로에 고정돼 있어 sudoers를 바꾸는 순간 sudo에서 거부된다. 따라서 교체에는 drain, Node 1~6 HDFS release와 Node 1 Bronze release 설치, sudoers 수동 재생성이 모두 필요하다. 반면 상한 `tess_pipeline_max_sector=70`에 도달하면 새로 허가할 Sector가 없어 `commit_bronze`가 더 실행되지 않는다. 14:12 UTC 기준 Sector 52까지 완료, 시간당 약 1.9개로 완료 예상은 23:30~24:00 UTC(추정)다.
   - 시작 조건: `tess_pipeline_completed_through=70`, 단계 DAG 실행 중 run 0건, YARN 실행 앱 0개, HDFS 사용률 재확인(예상 약 63%).
   - 선택: Silver run 동안 `tess_pipeline_enabled=false`로 실패 Sector 재시도가 겹치지 않게 한다. 운영 Variable 변경이므로 승인 후 적용하고 끝나면 되돌린다.
   - 남는 위험: Silver 실행 중 실패 Sector가 재시도되면 그 Bronze는 사전 점검에서 계속 실패하지만, Silver 종료 후 조정 DAG가 다시 시작하며 데이터 손상은 없다.
   - 252 적재 중 Silver가 꼭 필요할 때만 대안 B(drain → 같은 새 ID의 HDFS·Bronze release 설치 → sudoers 수동 재생성 → `tess_pipeline_settings` 갱신)를 검토한다.
4. **`tess_yarn` Pool을 Airflow 이미지보다 먼저 만든다.** 서버에는 `default_pool`만 있다. `pool="tess_yarn"`이 붙은 이 브랜치의 `commit_bronze`가 담긴 이미지를 Pool보다 먼저 배포하면 Airflow가 그 Task를 스케줄하지 않는다. 78이 develop에 병합된 뒤 252가 develop 기준으로 재배포할 때도 같다.
5. **보강했다(2026-09-24)** — `process_tic`의 넓은 예외 처리가 코드 결함을 `invalid_bronze_row`(retryable 아님)로 기록하던 것을, Bronze 행 읽기 중 오류만 `invalid_bronze_row`로 두고 그 뒤 코드 결함은 `unexpected_processing_error`(retryable, 예외 형식과 메시지 포함)로 나눴다.

## 서버에서 확인한 기준 상태

2026-09-24 06:17 UTC 읽기 전용 확인: 252가 `tess_pipeline_completed_through=70`(상한 70)에 도달했고 다운로드·Raw·cleanup·Bronze 단계 run은 실행·대기 모두 0건, YARN 실행 앱 0개, HDFS 58%(9.1 TB 중 5.2 TB)다. 전날 추정 63%보다 낮아 Silver 전체 run 뒤 약 65%로 예상한다. `tess_pipeline_enabled`는 `true`로 두었다(새 허가 대상 없음). 전체 run 시작 조건(결정 A)을 충족했다.

2026-09-23 07:10·08:10 UTC 읽기 전용 확인: `master-1`, NameNode active/standby·Safe mode OFF, DataNode·NodeManager 각 5대, HDFS 10.03 TB 중 38% 사용(DataNode당 약 1.1 TB 여유), Node 1 루트 디스크 14 GB 여유, Python 3.12.3, Docker 29.1.3, PyPI 접근 가능. Bronze 1~13 coverage는 13 Sector·제품 247,824개·관측점 4,666,320,826개로 기록과 일치한다. 252는 `tess_pipeline_enabled=true`, 상한 Sector 70으로 운영 중이며 Airflow Pool은 `default_pool`뿐이다. 이전 Bronze release는 YARN 잠금 파일을 쓰지 않는다. 설치된 Silver release는 `20260923T080904Z`(NaN 결함 포함, 사용 금지), `20260923T083458Z`(Canary 합격, 보강 전), `20260924T063740Z`(staging 정리·예외 분류, Canary 합격), `20260924T091614Z`(core 4 요청으로 YARN 거부, 사용 금지), `20260924T093328Z`(처리량 보강, Canary 합격, **전체 run용**)이며, 이전 Canary용 release 3개가 남아 있다.

2026-09-23 기준 Node 1은 252가 전환한 Airflow 3.2.2(API Server·Scheduler·별도 DAG Processor·Triggerer)와 `LocalExecutor`를 사용한다. 통합 소스의 `compose.control-plane.yaml`은 `AIRFLOW__CORE__PARALLELISM=8`이지만 252 변경 이력 기준 이 값의 운영 배포·회귀는 아직 미검증이므로, 배포 전 서버 실제 값을 확인한다. 이전 2.10.5 DB·release는 롤백용으로 보존한다. 아래 서술은 2026-09-22 Airflow 2.10.5·`parallelism=2` 시점의 읽기 전용 확인이다. 당시 252의 Sector 14 수집→Raw→Bronze 4단계는 성공했으나 서버에는 Silver DAG가 없었다. 단계형 DAG는 자체 schedule이 없고, legacy 1~13 결합 DAG와 discovery DAG는 pause 상태였다. `tess_pipeline_enabled=false`, Sector 상한은 14였다.

서버에 배포된 252 DAG 파일 6개는 당시 `origin/feature/S15P21C206-252-pipeline-sector-ingestion-bronze-dag`의 배포 기준 commit과 SHA-256이 일치했다. 2026-09-23 병합 `0e50e3b4`로 252 소스를 이 브랜치에 통합했으므로 이 경고는 해소됐다. 다만 **배포 전 252 DAG 5개와 `tess_bronze_to_silver`가 같은 이미지에서 함께 import되는지 반드시 확인한다.**

## 반드시 지켜야 할 입력·범위 경계

1. 78 Silver controller는 Sector 1~13 전체 Bronze coverage와 TIC별 다중 Sector 결합만 승인한다. Sector 14의 `_READY` 하나는 이 coverage가 아니며 Silver 입력으로 사용하면 안 된다.
2. Sector 14+의 누적 snapshot, 변경 TIC 재처리, 혼합 Bronze pipeline version 및 기존 Silver 결과 조합은 아직 계약되지 않았다. 이는 252/80의 별도 범위이며, 이 DAG의 입력 검사나 우회 conf로 해결하지 않는다.
3. 새 슬롯·헤드룸 검사는 이번 브랜치의 Bronze controller에 들어 있고 운영 중인 252 Bronze release에는 없다. 새 Silver는 파이프라인 앱이 슬롯보다 적으면 이전 Bronze와 동시 제출하며, 2026-09-23 Canary 1 첫 실행에서 Bronze Sector 42와 동시에 돌아 둘 다 SUCCEEDED했다. 이전 Bronze는 Silver가 도는 동안 사전 점검에 실패하고 5분 간격으로 재시도하므로, drain 없이 실행해도 되는 것은 수 분 단위 Canary뿐이다. 전체 run은 252가 Sector 70을 끝낸 뒤 시작한다(아래 "전체 `run` 전에 해결할 것" 3번).
4. `tess_yarn` Pool은 setup script를 실제 실행하기 전에는 존재·설정되었다고 가정하지 않는다. Pool 슬롯 수와 Node 1 `PLANETORY_YARN_SLOTS` 기본값이 어긋나면 상한이 깨지므로 배포 시 두 값을 함께 확인한다. Silver DAG는 pause 상태로 배포하고, Pool·sudo 권한·release를 확인한 뒤에만 명시적으로 unpause/trigger한다.
5. **현재 전체 `run`(`20260924T133559Z`)은 Airflow DAG가 아니라 systemd 경로(`run-tess-silver.ps1`)로 실행 중이다.** 비동기 DAG(2026-09-24, 로컬 구현·검증만, 미배포)는 같은 unit 구조를 쓰지만 새 release의 `start-unit`을 요구하므로 이미 시작한 이 run을 이어받지 않는다. 아래는 동기 SSHOperator 시점의 판단이다. `-Step Canary`는 운영자 PC의 Tailscale SSH 세션에서 제어기를 직접 실행하므로 PC가 꺼지거나 네트워크가 끊기면 실패한다(2026-09-24 한 차례 연결 점검 단계에서 실패, 서버 영향 없음). `-Step Start`는 서버 systemd unit에 인계하므로 PC 상태와 무관하다. Airflow SSH Task는 며칠짜리 Silver 제어기와 수명이 묶여 있어, 252의 잦은 Airflow release 교체나 재시작 때 PTY hangup으로 제어기가 죽는다. cluster-mode 앱은 YARN에 남지만 finalize·`_READY` 확정이 사라지고, 새 사전 점검은 이 고아 앱이 슬롯을 채우는 동안 새 제출을 거부한다. 동기 DAG는 수 분 단위의 1~5 TIC Canary에만 썼다. 비동기 DAG는 SSH 세션을 unit 시작·상태 확인 때만 열어 이 문제를 없앤다.
6. (비동기 DAG로 해소, 배포 후 확인 필요) 이전 SSHOperator는 Spark 종료까지 Airflow worker slot 하나를 점유했다. 252가 `parallelism=8`로 올렸어도 Silver는 며칠 단위로 한 슬롯을 잡으므로 252의 단계 DAG 5개와 합쳐 슬롯이 모자라지 않는지 확인한다. Airflow 3는 queue 투입 시점에 실행 토큰을 발급하고 기본 600초에 만료하므로, 슬롯 부족으로 대기가 길어지면 252가 겪은 `Invalid auth token: Signature has expired`가 Silver에서도 발생할 수 있다. 비동기 DAG에서는 `wait_silver`가 defer 중 슬롯과 토큰을 잡지 않고, 깨어날 때마다 새 실행으로 짧게 확인한다.

## 다음 담당자의 실행 순서

운영 변경은 대상 Node 1, release ID, 영향 범위를 확인하고 별도 승인을 받은 뒤 아래 순서를 지킨다.

1. **완료(2026-09-23, 병합 `0e50e3b4`)** — 252의 Airflow 3.2.2 전환·단계 DAG와 78 변경을 충돌 검토해 통합하고 Silver DAG를 Task SDK로 이식했다. 이후 252가 더 진행되면 같은 방식으로 다시 통합한다.
2. 통합 소스에서 Airflow 3.2.2 이미지를 빌드하고, 252 DAG 5개와 `tess_bronze_to_silver`가 함께 import 오류 0건으로 올라오는지 **운영 이미지에서** 확인한다. 로컬 3.2.2 DagBag 적재와 `get_dr_count` 시그니처는 위 표대로 통과했으나, 이는 정적 계약 검증이며 게이트의 실제 런타임 동작은 API Server에 연결된 Task 실행에서만 확인된다. 기존 활성 DAG·connection을 삭제하거나 재생성하지 않는다.
3. **완료(2026-09-23)** — `run-tess-silver.ps1 -Step Install`로 release `20260923T083458Z`를 설치했다. controller·상위 디렉터리 root 소유, 그룹·기타 쓰기 0개를 확인했다.
4. Node 1 root 권한으로 `configure-tess-silver-airflow-node1.sh <release-id> [slots]`를 한 번 실행한다. 이 단계는 `/etc/sudoers.d`와 Airflow metadata DB의 Pool을 변경하므로 실행 전 승인과 사후 `visudo -c`, Pool slot 수 확인이 필요하다. **2번의 이미지 배포보다 먼저** 실행한다.
5. **완료(2026-09-23)** — 1~5 TIC Canary를 Airflow 대신 `run-tess-silver.ps1 -Step Canary`로 실행했다. 이 경로는 Airflow 이미지·sudoers·Pool 없이 운영자 PC에서 제어기를 직접 실행한다. 252는 drain하지 않고 YARN 실행 앱 0개인 시점에 시작했다.
6. **완료(2026-09-23)** — Canary 1 재실행·Canary 2의 manifest/READY 재감사, `failed_tics=0`, 행 보존, YARN 종료 상태, 검증 출력 삭제와 science audit 상태 파일을 확인했다(위 절).
7. 위 증거를 변경 이력과 Jira에 기록하고 "전체 `run` 전에 해결할 것"을 처리한 뒤에만 전체 `run` 또는 실패 TIC `retry`의 운영 실행 여부를 결정한다. 전체 run은 systemd 경로(`run-tess-silver.ps1 -Step Start -CodeReleaseId 20260924T093328Z -ShufflePartitions 500`)로 실행한다.

Canary Trigger conf 형식은 다음과 같다. 실제 SHA·release ID·TIC은 검증된 값으로만 치환한다.

```json
{
  "operation": "canary",
  "silver_release": "/opt/planetory-silver/releases/<UTC-release-id>",
  "bronze_coverage": "/lake/bronze/tess/coverage=<64자리-소문자-SHA-256>",
  "run_id": "<yyyyMMddTHHmmssZ>",
  "pipeline_version": "S15P21C206-78-<release-id>",
  "tic_ids": [123456789]
}
```

### 비동기 DAG 결함 수정과 처리량 설정 (2026-09-25, 로컬 구현, 미배포)

코드 검토에서 찾은 비동기 DAG 결함 5개를 고쳤다.

1. 재부팅하면 systemd의 시작 시각이 0이 되어 `start-unit`이 끝난 run을 다시 시작하고 같은 run ID에 두 번째 final attempt가 생길 수 있었다. attempt 상태에 unit 이름을 기록하고 `start-unit`·`status`·`canary/run/retry`가 그 unit의 최신 attempt `complete`를 기준으로 판단한다.
2. `wait_silver`가 시작 시각 0을 모두 대기로 봐서 재부팅 뒤 끝난 run과 실행 전에 실패한 unit을 14일 동안 기다렸다. 완료·실패를 먼저 판정한다.
3. 무제한 재시작이 보이지 않았다. `status`에 `NRestarts`를 넣고 6회를 넘으면 DAG를 실패시킨다.
4. SSH 일시 오류가 재시도 3회를 소모했다. 연속 6회까지는 defer `kwargs`로 횟수를 넘기며 다시 기다린다.
5. 공용 `remote()`에 시간 제한과 연결 닫기가 없었다. 선택 `timeout`을 추가하고 `status`는 120초로 제한한다. 단계 DAG 호출은 그대로다.

처리량 설정(P1·P2)도 바꿨다. 2026-09-24 전체 run 실측(17:13 UTC, BLS 작업 97개)에서 작업당 시간이 worker-2 24분, worker-3·4 약 30분, worker-6 50분, worker-5 64분이었다. 모든 worker가 `e2-custom-6-36864`(물리 코어 3 × 하이퍼스레딩 2)지만 worker-2·3과 master-1은 AMD Rome, worker-5·6은 Intel Broadwell이다. YARN이 메모리만으로 배치해 worker-5에 executor 3개가, worker-2에 1개가 들어갔고, executor당 실제 메모리는 약 2.2 GiB였다.

- P1: executor 14개 × core 2개, `5g` + overhead 2048(7 GiB). 24 GiB NodeManager에 정확히 3개, worker-2(16 GiB)에 2개가 들어가 동시 작업이 28개가 된다. driver(3 GiB)가 worker-2에 배치되면 13개만 뜬다. 예상 처리량 +15~20%는 추정이며, AMD worker에 6작업을 올린 시간은 아직 측정하지 않았다.
- Silver 제출은 dynamic allocation을 켠다(`initialExecutors`·`maxExecutors`=14, `minExecutors`=2, `executorIdleTimeout`=300s, 외부 셔플 서비스 대신 `shuffleTracking`). 시작할 때 YARN 메모리가 모자라 덜 받은 executor는 메모리가 비면 다시 늘어난다. 셔플 파일이나 `DISK_ONLY` 결과를 가진 executor는 반납하지 않으므로(`cachedExecutorIdleTimeout` 기본 무한), 계산 단계 이후에는 executor가 거의 줄지 않고 Bronze에 자리를 돌려주는 효과도 작다. 슬롯·사전 점검은 앱 수만 센다.
- P2: `shuffle_partitions` 상한을 2000으로 올렸다(DAG 계약·`run-tess-silver.ps1`). 다음 전체 run은 2000으로 시작해 작업당 TIC를 약 64개로 줄이고 느린 worker의 마지막 회차 대기를 줄인다(추정 30~45분).
- Silver가 YARN 112 GiB 중 약 101 GiB를 쓰므로 동시에 도는 Bronze는 executor 1개 정도만 받는다. Silver 전체 run 중에는 Bronze 단계를 쉬게 할지 운영에서 정한다.
- 진행 중인 전체 run `20260924T133559Z`는 이전 release·설정 그대로 둔다.

코드 최적화(A·B)도 적용했다. Spark는 Bronze 28개 열 중 `process_tic`이 읽는 10개만 Python으로 넘기고, 전처리 biweight는 같은 길이의 창을 행으로 쌓아 한 번에 계산한다. 기존 구현과 비트 단위로 같은 결과를 검증했으므로 전처리 버전 `silver-biweight-1.0.0`은 그대로다. 추세 계산은 약 2.9배, TIC 처리 전체는 약 13% 빨라졌다(로컬 측정). TIC 시간의 약 87%는 전체 격자 BLS이며, BLS 입력 bin·주기 격자 변경(C·D)은 과학 결과가 바뀌어 120/122 승인 범위다. 새 release Canary에서 TIC `259377017`과 이전 Canary 5개 TIC의 과학 값이 그대로인지 실데이터로 확인한다.

### 운영 상태 주의: 자동 업데이트 타이머 정지 (2026-09-25)

06:12·06:15 UTC 자동 보안 업데이트 뒤 needrestart가 worker-5·worker-3 NodeManager를 재시작해 전체 run `20260924T133559Z`의 executor 6개와 로컬 결과를 잃었다. Spark가 셔플 입력을 다시 계산했고, 잃은 TIC 결과는 쓰기 단계에서 다시 계산되어 완료가 약 6시간 늦어질 것으로 본다(추정). 확산을 막으려고 노드 6대의 자동 업데이트 타이머를 멈췄고, run 종료 뒤 2026-09-26에 6대에 [needrestart 예외](../../infra/distributed-system/README.md#needrestart-자동-재시작-예외-s15p21c206-78)를 설치하고 타이머를 다시 켰다(Hadoop 서비스 재시작 0건). 전체 run은 2026-09-25 19:34 UTC에 확정됐고(선택 128,258, 실패 104, `qa_stopped` 17,553, RF2 636 GB), 제어기 재감사·Parquet 불변식·같은 release Canary 5개 TIC 값이 모두 일치했다. 같은 날 worker-5·6을 VM 정지·시작으로 AMD Rome에 다시 배치해 6대 모두 AMD Rome이다. 결과를 executor 로컬 디스크에 한 벌만 두는 `DISK_ONLY` 구조라 노드 하나만 재시작돼도 몇 시간 분량을 다시 계산한다는 점도 확인했다(`DISK_ONLY_2`는 별도 검토).

### Spark History Server (2026-09-25, Node 1 설치 완료)

Bronze·Silver 제출에 조건부 이벤트 로그를 넣고 [Node 1 설치 스크립트](../../infra/distributed-system/scripts/install-spark-history-node1.sh)를 추가했다. 남은 순서는 3번이다.

1. **완료(2026-09-25, `d1800d0a`)** — Node 1 root로 `install-spark-history-node1.sh`를 실행했다. HDFS `/spark-history`(`planetory-admin`, `drwxr-x---`), `planetory-spark-history.service`(enabled·active), `tailscale serve --http=18080`을 설정했다. 기존 serve `https://node-1.tail97e363.ts.net` → `127.0.0.1:8081`은 그대로다. 첫 실행은 Java가 loopback bind를 `[::ffff:127.0.0.1]:18080`으로 보고해 안전장치가 서비스를 끄고 serve 전에 멈췄고, 이 표기를 허용하도록 고친 뒤 재실행했다.
2. **완료(2026-09-25)** — Java listener는 `[::ffff:127.0.0.1]:18080` 하나이고 테일넷 주소의 18080은 `tailscaled`만 받는다. PC에서 `http://node-1:18080` 200, 기존 443 200. History Server 컨테이너 메모리 약 337 MiB.
3. 새 release로 Canary 1회를 실행해 실행 중 `.inprogress` 앱과 종료 후 앱이 보이는지 확인한다. 비동기 DAG의 첫 서버 검증과 함께 할 수 있다.

진행 중인 전체 run `20260924T133559Z`(`application_1790067725443_0064`)은 이벤트 로그 없이 시작했으므로 History Server에 나타나지 않는다. Tailscale ACL로 18080 접근을 사용자 기기로 좁히는 것은 테일넷 관리자 결정으로 남긴다.

## 완료·삭제 조건

다음이 모두 충족되면 담당자는 이 문서가 더는 필요 없는지 확인하고 **이 파일과 `docs/project/README.md`의 링크를 같은 커밋에서 삭제한다.**

- 통합 Airflow release가 기존 252 DAG를 보존한 채 배포되고 import되었다.
- 제한 sudo와 `tess_yarn` Pool(슬롯 수가 Node 1 `PLANETORY_YARN_SLOTS`와 일치)이 승인된 방식으로 적용·검증되었다.
- 검증된 1~5 TIC Canary가 실제 YARN에서 성공하고 Silver manifest/READY를 재감사했다. **(2026-09-23 충족)**
- 14+ 처리 책임이 별도 252/80 계약으로 명시되었거나, 이 78 DAG가 1~13 전용이라는 경계가 Jira/MR 리뷰에서 승인되었다.
- 해당 운영 증거와 남은 후속 작업이 Jira·변경 이력의 정본에 기록되었다.

삭제 전에는 이 문서의 내용을 새 문서로 복제하지 않는다. 실행 사실은 해당 운영 README·변경 이력·Jira에만 짧게 남긴다.

# S15P21C206-78 Silver 처리·Airflow 인계

> 상태: 구현·252 통합·로컬 검증 완료, 운영 배포·실제 YARN Canary 전<br>
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
- DAG는 `planetory_node_1` SSH connection으로 Silver controller를 실행한다. 2026-09-23부터 `tess_pipeline_enabled=false`·Raw/Bronze run 부재라는 시작 조건을 제거하고, 대신 `run_silver`와 252 `commit_bronze`가 같은 `tess_yarn` Pool(기본 2 슬롯)을 요구해 동시성에 상한을 둔다.
- `distributed-system/spark/tess_bronze_ctl.py`와 `tess_silver_ctl.py`는 Node 1의 `/run/planetory-tess-yarn-<N>.lock` 슬롯 파일을 공유하는 카운팅 세마포어(`yarn_slot`)로 YARN 제출 **동시 실행 수에 상한**을 둔다. 슬롯 수는 `PLANETORY_YARN_SLOTS`(기본 2, 1~8)이며 Airflow Pool 슬롯과 같아야 한다. 제한 sudo는 환경 변수를 전달하지 않으므로 Airflow 경로는 항상 기본값을 쓴다. 기본 2는 용량 실측 없이 고른 보수값이며, 올리려면 실제 YARN 메모리·시간 측정 근거가 필요하다.
- `infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh <release-id> [slots]`는 지정 release 경로와 상위 디렉터리의 root 소유·비쓰기 권한을 검사한 뒤, 해당 release controller만 허용하는 sudoers와 `tess_yarn` Pool(기본 2 슬롯)을 만든다. 기존 sudoers 내용이 다르면 덮어쓰지 않고 실패한다.
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
release `20260923T080904Z`(HEAD `4af1943d`), TIC `259377017`, `application_1790067725443_0030`은 SUCCEEDED했으나 TIC가 `invalid_bronze_row`(`Out of range float values are not JSON compliant: nan`)로 실패해 exit 65로 끝났다. 245(`9f62bb0f`)가 준비 단계 제외 목록에 `original_time`을 추가했고, 78의 `_target_row`는 그 목록을 엄격 JSON으로 그대로 직렬화했다. 실제 SPOC 곡선의 관측 공백 NaN 시각에서 실패하므로 전체 run의 거의 모든 TIC가 실패했을 결함이다. 로컬 합성 곡선에는 NaN 시각이 없어 잡지 못했다. `_strict_exclusions`로 `exclusion_ledger`와 같은 인코딩(null + `original_time_nonfinite`)을 적용하고 NaN·Inf 시각 회귀 검사를 추가했다. 사전 점검 시점에 252 Bronze Sector 42(`_0029`)가 실행 중이었고 새 헤드룸 검사가 동시 실행을 허용했으며, 두 앱 모두 SUCCEEDED해 병렬 실행이 실운영에서 처음 동작했다. 실패 attempt는 `/validation/S15P21C206-78/run=20260923T081349Z/attempt=20260923T081629Z`에 남아 있다. 수정 release로 Canary 1을 다시 실행해야 한다.

**Canary TIC 선택 시 주의** — 최초 전처리 결과가 `insufficient_observations`(유효 관측 500점 미만) 같은 결정적 데이터 판정인 TIC도 여전히 `failed_tics`에 들어가 Canary를 실패시킨다. 첫 Canary는 이전 실클러스터 기준 TIC `259377017`처럼 관측이 충분한 TIC로 고른다.

**전체 `run` 전에 해결할 것**
1. Spark 작업이 전체를 한 번에 확정하며 `spark.yarn.maxAppAttempts=1`이다. 중간 실패 시 처음부터 다시 돌고, 실패한 attempt의 `/lake/silver/.staging` 부분 출력은 정리되지 않는다. systemd는 5분마다 새 attempt로 재시작하므로 실패가 반복되면 staging이 누적되고, 75% HDFS 사용량 점검에서 멈춘다.
2. Silver 출력 용량은 **추정** 논리 400~450 GB, RF2 기준 800~900 GB로 Bronze(RF2 166 GB)의 약 5배다. `excluded_json`이 `exclusion_ledger_json`에 그대로 포함돼 중복 저장된다. 실행 중에는 shuffle·`DISK_ONLY` 결과가 HDFS와 같은 `/mnt/data`를 추가로 쓴다. 서버 HDFS 여유 공간을 먼저 확인한다.

## 서버에서 확인한 기준 상태

2026-09-23 기준 Node 1은 252가 전환한 Airflow 3.2.2(API Server·Scheduler·별도 DAG Processor·Triggerer)와 `LocalExecutor`를 사용한다. 통합 소스의 `compose.control-plane.yaml`은 `AIRFLOW__CORE__PARALLELISM=8`이지만 252 변경 이력 기준 이 값의 운영 배포·회귀는 아직 미검증이므로, 배포 전 서버 실제 값을 확인한다. 이전 2.10.5 DB·release는 롤백용으로 보존한다. 아래 서술은 2026-09-22 Airflow 2.10.5·`parallelism=2` 시점의 읽기 전용 확인이다. 당시 252의 Sector 14 수집→Raw→Bronze 4단계는 성공했으나 서버에는 Silver DAG가 없었다. 단계형 DAG는 자체 schedule이 없고, legacy 1~13 결합 DAG와 discovery DAG는 pause 상태였다. `tess_pipeline_enabled=false`, Sector 상한은 14였다.

서버에 배포된 252 DAG 파일 6개는 당시 `origin/feature/S15P21C206-252-pipeline-sector-ingestion-bronze-dag`의 배포 기준 commit과 SHA-256이 일치했다. 2026-09-23 병합 `0e50e3b4`로 252 소스를 이 브랜치에 통합했으므로 이 경고는 해소됐다. 다만 **배포 전 252 DAG 5개와 `tess_bronze_to_silver`가 같은 이미지에서 함께 import되는지 반드시 확인한다.**

## 반드시 지켜야 할 입력·범위 경계

1. 78 Silver controller는 Sector 1~13 전체 Bronze coverage와 TIC별 다중 Sector 결합만 승인한다. Sector 14의 `_READY` 하나는 이 coverage가 아니며 Silver 입력으로 사용하면 안 된다.
2. Sector 14+의 누적 snapshot, 변경 TIC 재처리, 혼합 Bronze pipeline version 및 기존 Silver 결과 조합은 아직 계약되지 않았다. 이는 252/80의 별도 범위이며, 이 DAG의 입력 검사나 우회 conf로 해결하지 않는다.
3. 새 공통 잠금은 이번 브랜치의 Bronze controller에 들어 있다. 운영 중인 기존 252 Bronze release에는 아직 없으므로, 새 Bronze release가 적용되기 전에는 discovery/Raw/Bronze를 drain한 상태에서만 Silver DAG를 실행한다.
4. `tess_yarn` Pool은 setup script를 실제 실행하기 전에는 존재·설정되었다고 가정하지 않는다. Pool 슬롯 수와 Node 1 `PLANETORY_YARN_SLOTS` 기본값이 어긋나면 상한이 깨지므로 배포 시 두 값을 함께 확인한다. Silver DAG는 pause 상태로 배포하고, Pool·sudo 권한·release를 확인한 뒤에만 명시적으로 unpause/trigger한다.
5. **전체 `run`은 Airflow DAG가 아니라 systemd 경로(`run-tess-silver.ps1`)로 실행한다.** Airflow SSH Task는 며칠짜리 Silver 제어기와 수명이 묶여 있어, 252의 잦은 Airflow release 교체나 재시작 때 PTY hangup으로 제어기가 죽는다. cluster-mode 앱은 YARN에 남지만 finalize·`_READY` 확정이 사라지고, 새 사전 점검은 이 고아 앱이 슬롯을 채우는 동안 새 제출을 거부한다. Airflow DAG는 수 분 단위의 1~5 TIC Canary에만 쓴다.
6. SSHOperator는 Spark 종료까지 Airflow worker slot 하나를 점유한다. 252가 `parallelism=8`로 올렸어도 Silver는 며칠 단위로 한 슬롯을 잡으므로 252의 단계 DAG 5개와 합쳐 슬롯이 모자라지 않는지 확인한다. Airflow 3는 queue 투입 시점에 실행 토큰을 발급하고 기본 600초에 만료하므로, 슬롯 부족으로 대기가 길어지면 252가 겪은 `Invalid auth token: Signature has expired`가 Silver에서도 발생할 수 있다. 비동기 상태 감시 전환은 실제 실행 시간·부하 근거가 생긴 뒤 검토한다.

## 다음 담당자의 실행 순서

운영 변경은 대상 Node 1, release ID, 영향 범위를 확인하고 별도 승인을 받은 뒤 아래 순서를 지킨다.

1. **완료(2026-09-23, 병합 `0e50e3b4`)** — 252의 Airflow 3.2.2 전환·단계 DAG와 78 변경을 충돌 검토해 통합하고 Silver DAG를 Task SDK로 이식했다. 이후 252가 더 진행되면 같은 방식으로 다시 통합한다.
2. 통합 소스에서 Airflow 3.2.2 이미지를 빌드하고, 252 DAG 5개와 `tess_bronze_to_silver`가 함께 import 오류 0건으로 올라오는지 **운영 이미지에서** 확인한다. 로컬 3.2.2 DagBag 적재와 `get_dr_count` 시그니처는 위 표대로 통과했으나, 이는 정적 계약 검증이며 게이트의 실제 런타임 동작은 API Server에 연결된 Task 실행에서만 확인된다. 기존 활성 DAG·connection을 삭제하거나 재생성하지 않는다.
3. `run-tess-silver.ps1 -Step Install`로 immutable Silver release를 설치하고 controller·상위 디렉터리가 root 소유·비쓰기를 만족하는지 확인한다.
4. Node 1 root 권한으로 `configure-tess-silver-airflow-node1.sh <release-id>`를 한 번 실행한다. 이 단계는 `/etc/sudoers.d`와 Airflow metadata DB의 Pool을 변경하므로 실행 전 승인과 사후 `visudo -c`, Pool slot=1 확인이 필요하다.
5. discovery와 Raw/Bronze 실행이 완전히 끝난 상태, `tess_pipeline_enabled=false`, 정확한 1~13 Bronze coverage marker를 확인한다. 처음에는 1~5개의 명시 TIC Canary만 trigger한다.
6. Canary가 종료 0이더라도 Silver attempt의 manifest/READY 재감사, `failed_tics=0`, stage 별 row/lineage, YARN application 종료 상태를 확인한다. Canary 상세 출력 삭제 정책과 science audit 상태 파일도 확인한다.
7. 위 증거를 변경 이력과 Jira에 기록한 뒤에만 전체 `run` 또는 실패 TIC `retry`의 운영 실행 여부를 결정한다.

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

## 완료·삭제 조건

다음이 모두 충족되면 담당자는 이 문서가 더는 필요 없는지 확인하고 **이 파일과 `docs/project/README.md`의 링크를 같은 커밋에서 삭제한다.**

- 통합 Airflow release가 기존 252 DAG를 보존한 채 배포되고 import되었다.
- 제한 sudo와 `tess_yarn` Pool(슬롯 수가 Node 1 `PLANETORY_YARN_SLOTS`와 일치)이 승인된 방식으로 적용·검증되었다.
- 검증된 1~5 TIC Canary가 실제 YARN에서 성공하고 Silver manifest/READY를 재감사했다.
- 14+ 처리 책임이 별도 252/80 계약으로 명시되었거나, 이 78 DAG가 1~13 전용이라는 경계가 Jira/MR 리뷰에서 승인되었다.
- 해당 운영 증거와 남은 후속 작업이 Jira·변경 이력의 정본에 기록되었다.

삭제 전에는 이 문서의 내용을 새 문서로 복제하지 않는다. 실행 사실은 해당 운영 README·변경 이력·Jira에만 짧게 남긴다.

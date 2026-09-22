# S15P21C206-78 Silver 처리·Airflow 인계

> 상태: 구현·로컬 검증 완료, 운영 배포·실제 YARN Canary 전<br>
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
- DAG는 `tess_pipeline_enabled=false`와 실행 중인 252 Raw/Bronze DAG 부재를 확인한 뒤 `planetory_node_1` SSH connection으로 Silver controller를 실행한다. task는 `tess_yarn` Pool을 요구한다.
- `distributed-system/spark/tess_bronze_ctl.py`와 `tess_silver_ctl.py`는 Node 1의 `/run/planetory-tess-yarn.lock`을 공유해 YARN 제출을 직렬화한다. 이는 현재 단일 클러스터 여유를 보수적으로 보호하는 전역 잠금이며, 실제 용량 검증으로 동시 실행이 안전하다고 확인될 때에만 분리한다.
- `infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh`는 지정 release 경로와 상위 디렉터리의 root 소유·비쓰기 권한을 검사한 뒤, 해당 release controller만 허용하는 sudoers와 `tess_yarn` 1-slot Pool을 만든다. 기존 sudoers 내용이 다르면 덮어쓰지 않고 실패한다.
- `distributed-system/airflow/requirements.txt`에 현재 서버 Airflow와 호환되는 `apache-airflow-providers-ssh==4.1.6`을 명시한다.

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
| 서버 정적 점검 | Airflow 2.10.5 scheduler container에 새 DAG/계약을 메모리 import, Node 1에서 Bash·생성 sudoers 문법 검사 | 통과 |
| 문서·diff | 상대 링크 검사, `git diff --check` | 통과 |

실제 Spark/PySpark·YARN Canary, Airflow DAG 배포·trigger, sudoers/Pool 변경은 실행하지 않았다. 따라서 위 결과를 운영 배포 또는 전체 Silver 생성 완료로 해석하지 않는다.

## 서버에서 확인한 기준 상태

2026-09-22 읽기 전용 확인 기준으로 Node 1은 Airflow 2.10.5, `LocalExecutor`, `parallelism=2`를 사용한다. 252의 Sector 14 수집→Raw→Bronze 4단계는 성공했으나 서버에는 Silver DAG가 없었다. 단계형 DAG는 자체 schedule이 없고, legacy 1~13 결합 DAG와 discovery DAG는 pause 상태였다. `tess_pipeline_enabled=false`, Sector 상한은 14였다.

서버에 배포된 252 DAG 파일 6개는 당시 `origin/feature/S15P21C206-252-pipeline-sector-ingestion-bronze-dag`의 배포 기준 commit과 SHA-256이 일치했다. 이 78 브랜치에는 252 DAG 소스가 포함되어 있지 않으므로, 이 브랜치만으로 Airflow 이미지를 재배포하면 기존 단계형 DAG가 빠질 수 있다. **252 소스와 78 변경을 의도적으로 통합한 release에서만 Airflow 이미지를 빌드·배포한다.**

## 반드시 지켜야 할 입력·범위 경계

1. 78 Silver controller는 Sector 1~13 전체 Bronze coverage와 TIC별 다중 Sector 결합만 승인한다. Sector 14의 `_READY` 하나는 이 coverage가 아니며 Silver 입력으로 사용하면 안 된다.
2. Sector 14+의 누적 snapshot, 변경 TIC 재처리, 혼합 Bronze pipeline version 및 기존 Silver 결과 조합은 아직 계약되지 않았다. 이는 252/80의 별도 범위이며, 이 DAG의 입력 검사나 우회 conf로 해결하지 않는다.
3. 새 공통 잠금은 이번 브랜치의 Bronze controller에 들어 있다. 운영 중인 기존 252 Bronze release에는 아직 없으므로, 새 Bronze release가 적용되기 전에는 discovery/Raw/Bronze를 drain한 상태에서만 Silver DAG를 실행한다.
4. `tess_yarn` Pool은 setup script를 실제 실행하기 전에는 존재·설정되었다고 가정하지 않는다. Silver DAG는 pause 상태로 배포하고, Pool·sudo 권한·release를 확인한 뒤에만 명시적으로 unpause/trigger한다.
5. SSHOperator는 Spark 종료까지 Airflow worker slot 하나를 점유한다. 현재 `parallelism=2` 환경에서 이 보수적 선택은 실행 충돌을 줄이지만, 장기적으로 비동기 상태 감시로 바꾸는 일은 실제 실행 시간·부하 근거가 생긴 뒤 검토한다.

## 다음 담당자의 실행 순서

운영 변경은 대상 Node 1, release ID, 영향 범위를 확인하고 별도 승인을 받은 뒤 아래 순서를 지킨다.

1. 252의 현재 DAG·Bronze controller 변경과 이번 78 변경을 충돌 검토하여 하나의 배포 release로 통합한다. 252 브랜치를 통째로 이 브랜치에 무검토 병합하지 않는다.
2. 통합 소스에서 Airflow 이미지를 빌드하고, 기존 252 DAG와 `tess_bronze_to_silver`가 함께 import되는지 확인한다. 기존 활성 DAG·connection을 삭제하거나 재생성하지 않는다.
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
- 제한 sudo와 1-slot `tess_yarn` Pool이 승인된 방식으로 적용·검증되었다.
- 검증된 1~5 TIC Canary가 실제 YARN에서 성공하고 Silver manifest/READY를 재감사했다.
- 14+ 처리 책임이 별도 252/80 계약으로 명시되었거나, 이 78 DAG가 1~13 전용이라는 경계가 Jira/MR 리뷰에서 승인되었다.
- 해당 운영 증거와 남은 후속 작업이 Jira·변경 이력의 정본에 기록되었다.

삭제 전에는 이 문서의 내용을 새 문서로 복제하지 않는다. 실행 사실은 해당 운영 README·변경 이력·Jira에만 짧게 남긴다.

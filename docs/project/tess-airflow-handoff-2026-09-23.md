# TESS Airflow Sector 파이프라인 임시 핸드오프 (2026-09-23)

> **임시 문서 — 이 작업을 종료할 때 반드시 삭제한다.** 다음 담당자가 토큰 만료 장애를 해결하고 운영 회귀를 확인한 뒤, 유지할 결론을 담당 정본·변경 이력·Jira에 옮긴다. 그다음 이 파일을 삭제하고 [프로젝트 문서 인덱스](README.md)의 링크를 제거해 별도 커밋한다. 문서 삭제 전에는 아래 미해결 항목을 완료 또는 명시적 이관 상태로 정리한다.

- 목적: 현재 세션의 요청·결정·실행 결과와 장애 증거를 다음 작업에 전달한다.
- 범위: Jira [S15P21C206-252](https://ssafy.atlassian.net/browse/S15P21C206-252), `feature/S15P21C206-252-pipeline-sector-ingestion-bronze-dag`, Node 1 Airflow 3.2.2와 Node 1~6의 TESS 수집·HDFS·YARN·Bronze.
- 상태: Sector 파이프라인 운영 중, `Invalid auth token: Signature has expired` 재발 원인 **미해결**. 이 문서는 일시적인 작업 메모이며 운영 정본을 대신하지 않는다.
- 상태 기준 시각: 2026-09-22 19:22 UTC / 2026-09-23 04:22 KST. 실행 상태·용량은 이후 바뀔 수 있으므로 조치 전에 다시 조회한다.
- 정본: [DAG 계약](../../distributed-system/airflow/dags/README.md), [Node 1 Airflow 운영 절차](../../infra/distributed-system/README.md#airflow-db), [HDFS Raw](../../distributed-system/ingestion/hdfs/README.md), [변경 이력](../changes/2026-09-W4/README.md).

## 이번 대화에서 확정한 요구와 경과

| 순서 | 사용자 요청·결정 | 실행·검증 상태 |
| --- | --- | --- |
| 1 | 분리된 TESS 다운로드·HDFS Raw 적재·Bronze 변환을 Sector 단위 선후관계로 연결하고 브랜치·Jira를 마련한다. | 현 브랜치와 Jira `S15P21C206-252`에서 작업한다. Sector별 코드 복제를 피하고 같은 DAG 정의에 Sector 계보를 인자로 전달한다. |
| 2 | `다운로드·검증 → Raw 적재·검증 → 로컬 삭제 → Bronze 변환·검증`을 각 DAG로 나누고, 새 Sector 발견·재개 DAG를 둔다. Sector N의 후속 단계와 N+1 다운로드는 겹치게 한다. | 현행 DAG는 `tess_sector_discovery`, `tess_sector_download`, `tess_sector_raw`, `tess_sector_cleanup`, `tess_sector_bronze` 다섯 개다. Raw final 감사가 통과한 뒤에만 Worker별 지정 FITS를 삭제한다. |
| 3 | 1~13 하드코딩을 없애고 진행 증거에서 중단 지점을 찾으며, 상한을 설정 가능하게 하고 기본 목표를 Sector 70으로 둔다. 중지·재부팅 후 안전하게 잇는다. | 발견 DAG가 5분 주기로 게시 목록과 Worker marker·Raw/Bronze `_READY`·cleanup 기록을 대조한다. `tess_pipeline_enabled`와 `tess_pipeline_max_sector`를 사용한다. 실패한 단계의 복구는 실제 완료 증거를 먼저 확인한다. |
| 4 | Raw 검증을 빠르게 하고, Spark/YARN 병렬 사용 및 남는 RAM 활용을 검토한다. | Raw 이후 cleanup은 manifest/HDFS checksum을 이용한 빠른 감사가 구현됐다. Sector 14 cleanup도 약 13분 30초가 걸려 추가 성능 개선은 미완료다. RAM·Executor 병렬도 튜닝은 요청·논의됐지만 채택·실측하지 않았다. |
| 5 | Airflow UI를 Node 1에 설치하고 Tailnet 전용으로 공개하며, 불필요한 과거 DAG를 제거하고 한국어 표시 이름을 적용한다. | Tailnet UI와 현행 DAG 5개가 배포됐다. 과거 1~13 단일 DAG `tess_sector_download_raw_bronze`는 정의와 사용 이력 0건의 metadata 행을 제거했다. |
| 6 | Airflow 2.10.5에서 3.2.2로 이관하고, Sector 70까지 실행·감시한다. | 원본 DB를 보존한 복제 DB를 마이그레이션해 Node 1에 API Server·Scheduler·DAG Processor를 배포했다. 발견 DAG와 수집 플래그를 켜고 상한 70을 확인했다. 반복 감시 자동화 `tess-sector-15-70-pipeline-monitor`는 장애·완료 등 의미 있는 변화만 알린다. |
| 7 | 다운로드 대기 중 토큰 만료 실패를 고쳐 운영 반영한다. | `reschedule` 센서를 5분 Temporal Trigger·전용 Triggerer로 바꿔 release `20260922T170848Z`를 배포했다. Sector 20의 첫 `deferred → deferred` 재개만 성공했으며, 이후 Sector 21·22에서 같은 토큰 만료가 재발했다. **장애 해결로 판정하지 않는다.** |

대화에서 추가로 확인·보류한 경계는 다음과 같다.

- 사용자는 5분마다 실행되는 `reconcile`, `trigger_stage`의 `skipped`, 한 번에 Sector 70까지 작업 큐에 넣는 방식도 질문했다. 현행 `reconcile`은 목표 상한까지 모든 Sector를 일괄 제출하는 큐가 아니라 새 데이터·완료 증거·미완료 단계를 주기적으로 확인한다. 다음 단계가 필요 없으면 `trigger_stage`가 건너뛰는 것이 정상이다. 대량 선제 큐잉은 구현하지 않았다.
- `tess_pipeline_enabled=false` 또는 발견 DAG pause는 신규 admission을 막는 drain이다. 이미 시작한 Worker systemd·HDFS·Spark 작업의 즉시 중단을 의미하지 않는다. 재부팅 뒤에는 영속 플래그와 완료 증거를 다시 읽는다.
- Raw는 기존 Worker uploader와 HDFS 감사가 처리하고, Bronze는 Spark on YARN이 처리한다. 모든 단계를 Spark로 옮기거나 서버 RAM을 더 쓰기 위한 병렬도 변경은 결정·실행하지 않았다.
- 사용자는 기존 Sector 1~13 로컬 다운로드 데이터의 삭제 완료를 알렸다. 이 문서 작업에서 그 데이터를 다시 검사하거나 삭제하지 않았다. Sector 14의 안전 삭제 검증은 아래 변경 이력에 별도로 남아 있다.

Hadoop 6대 부팅 복구 구성과 순차 재부팅 검증도 같은 Jira의 앞선 작업에서 완료했다. 당시 `nn1=active`, `nn2=standby`, DataNode·NodeManager 각 5대 복귀를 확인했다. 응답 없는 Active의 자동 장애 전환은 fencing이 없어 지원하지 않는다. 자세한 근거는 [2026-09-22 변경 이력](../changes/2026-09-W4/2026-09-22.md)에 있다.

## 현재 운영 구성과 확인된 상태

- Node 1 Airflow 3.2.2 활성 DB는 `airflow3_20260922t143000z`, 활성 이미지는 `local/planetory-airflow:20260922T170848Z`다. 기존 2.10.5 DB·release는 보존 중이다. Scheduler·DAG Processor·API Server·Triggerer는 모두 같은 새 이미지로 기동했다.
- 2026-09-22 19:22 UTC 조회에서 Airflow metadata DB·Scheduler·Triggerer·DAG Processor health는 모두 `healthy`였다. 현행 DAG 5개 모두 pause=false, `tess_pipeline_enabled=true`, `tess_pipeline_max_sector=70`이었다.
- 같은 시각 HDFS는 `nn1=active`, `nn2=standby`, Live DataNode 5대, DFS 잔여 약 7.46 TB·사용률 18.19%였다. YARN NodeManager 5대가 `RUNNING`이었다. 이는 당시 용량·서비스 관찰이며 다음 Sector의 무결성을 대신 보증하지 않는다.
- Sector 14의 다운로드·Raw·안전 삭제·Bronze 전체 성공과 Worker 4·Node 1 및 후속 6대 순차 재부팅 복구는 별도 운영 검증이 있다. Sector 19는 다운로드 DAG 실패 이력이 있지만 Worker 완료 증거를 재확인한 뒤 Raw·cleanup·Bronze가 성공했다. Sector 20은 19:22 UTC에 Bronze 진행 중, Sector 21은 Raw 진행 중이었다. Sector 22 다운로드 DAG는 19:16 UTC에 실패했다.
- 발견 DAG는 실패한 다운로드 DAG를 맹목적으로 성공 처리하지 않는다. 완료 marker를 검증해 다음 단계가 이미 가능한 Sector는 진행한다. 따라서 Sector 21 Raw 실행은 다운로드 DAG 실패 기록의 삭제나 토큰 오류 해결을 뜻하지 않는다.

## 가장 최근 코드·배포 작업

| 항목 | 구현 또는 운영 결과 | 한계 |
| --- | --- | --- |
| [다운로드 대기 Operator](../../distributed-system/airflow/dags/tess_stage_dags.py) | `DownloadMarkerWaitOperator`가 Worker marker를 검사하고, 미완료면 `TimeDeltaTrigger`로 5분 대기한다. LocalExecutor 프로세스를 대기 동안 붙잡지 않는다. | Airflow 실행 토큰 만료가 다른 실행 경로에서 재발했다. |
| [대기 계약](../../distributed-system/airflow/dags/tess_pipeline_contract.py) | 최초 Task 시작 기준 14일 제한 시간을 wake-up마다 다시 계산한다. | 원래 deadline을 보존하는 단위 검사만 통과했다. |
| [Compose](../../infra/distributed-system/compose.control-plane.yaml)·[배포 스크립트](../../infra/distributed-system/scripts/deploy-tess-airflow-node1.sh) | Triggerer를 같은 DB·비밀 설정으로 실행한다. `--update`는 현재 Airflow 3 환경 파일을 선택하고 활성 DagRun 0건·DAG import·API health·서비스 이미지를 확인한다. | 실행 중인 DagRun을 중단해 업데이트할 수 없다. Drain 뒤 배포해야 한다. |
| 검증 | 로컬 Airflow 테스트 16건, shell 문법, Node 1 이미지 DAG import 오류 0건, 새 4개 Airflow 서비스 health, Sector 20의 약 5분 첫 재개를 확인했다. | **15~20분 이상 실행·대기와 여러 Task의 동시성은 실패했다.** 첫 재개 성공만으로 회귀 통과를 선언한 보고는 정정해야 한다. |

배포 직전 `tess_pipeline_enabled=false`와 발견 DAG pause로 새 입장을 막고 Sector 18 cleanup·Bronze가 끝나 활성 DagRun 0건이 될 때까지 기다렸다. 2026-09-22 18:00 UTC 무렵 release를 배포하고 서비스 health를 확인한 후, 18:02 UTC 무렵 파이프라인과 발견 DAG를 다시 켰다. Worker·HDFS·Spark 코드 및 데이터를 이 변경에서 교체하거나 삭제하지 않았다.

## 미해결 장애: Airflow 내부 실행 토큰 만료

1. Airflow 3.2.2 전환 뒤 Sector 17·18의 기존 `reschedule` 다운로드 센서에서 `Invalid auth token: Signature has expired`가 발생했다. 처음에는 센서 대기 재개 경로로 판단했다.
2. Triggerer release 배포 후 Sector 20 `check_download`는 18:04:22 UTC `deferred`가 되고 18:09:25 UTC 다시 `deferred`가 되어 첫 5분 재개가 확인됐다.
3. Sector 21 `check_download`는 18:24 UTC 시작, 18:34 UTC 무렵 `queued`, 18:45 UTC 실패했다. 같은 시점 `tess_sector_discovery.reconcile`도 `queued → up_for_retry`가 됐다. Scheduler에는 `airflow.sdk.api.client.ServerResponseError: Invalid auth token: Signature has expired`와 LocalExecutor task 실패가 기록됐다.
4. Sector 22 `check_download`도 19:05 UTC 무렵 `queued`, 19:16 UTC 같은 오류로 실패했다. 두 다운로드 DAG의 `trigger_next_stage`는 `upstream_failed`였다. Airflow UI에서는 빨간 실패 이력이 남는다.
5. 따라서 `reschedule`만의 문제가 아니라 Scheduler·LocalExecutor·Task Execution API 사이의 더 넓은 토큰/대기열 문제다. 정확히 어느 토큰의 발급·만료 시점이 잘못됐는지는 아직 확인하지 않았다. `LocalExecutor(parallelism=2)`와 오래 실행되는 Raw/Bronze 원격 호출이 대기열 지연에 영향을 줄 수 있지만, **인과관계는 미검증**이다. HDFS 용량 부족·Worker marker 무결성 오류라는 증거는 없다.

## 다음 작업 순서

1. Sector 21·22 실패 시각의 Scheduler·API Server·LocalExecutor trace, Task가 `queued`에 머문 시간, Airflow의 실행 API용 JWT 설정과 노드 시각을 비밀값 없이 대조해 만료 경로를 특정한다. `api_auth.jwt_expiration_time` 설정값만 보고 결론 내리지 않는다.
2. 공통 실행 경로에서 최소 수정한다. 다운로드 Task만 자동 재시도하도록 바꿔 오류를 숨기지 말고, 발견 DAG에도 재발한 이유를 설명할 수 있어야 한다. Worker 완료 marker·Raw final·Bronze final은 현재 증거 기반 재개 규칙을 유지한다.
3. 기존 DagRun과 Worker/HDFS 작업을 관찰해 drain 시점을 정하고 불변 release로 운영 반영한다. 다음 Sector에서 여러 번의 5분 wake-up과 **이전 실패가 나타난 15~20분 구간**을 지나도 다운로드·발견 Task가 실패하지 않는지 확인한다. Sector별 네 단계와 무결성 게이트를 확인한다.
4. 반복 감시 자동화는 읽기 전용으로 둔다. Sector 완료·실패·용량/정합성 게이트를 계속 관찰하고, RAM·병렬도 튜닝은 토큰 오류 해결 뒤 별도 실측으로 판단한다.
5. 해결 결과와 롤백·운영 절차를 DAG·인프라 정본 및 Jira에 기록하고, 이 임시 핸드오프를 삭제한다. 삭제 시 프로젝트 인덱스 링크를 제거하고 [문서 삭제·대체 상태](README.md#삭제대체-상태)를 갱신한다.

## 저장소 인계 주의

- 이 문서 작성 시작 시 원격 추적 브랜치와 로컬 `HEAD`는 `de910e53`이었다. Triggerer 구현·운영 문서 변경은 당시 미커밋 상태였으며, 이번 핸드오프 요청의 커밋·푸시 대상은 변경 파일을 명시해 별도로 확인한다. 실제 새 커밋 ID는 Git 이력을 확인한다.
- 테스트 과정에서 추적 중인 `__pycache__/*.pyc` 파일 4개가 변경 상태로 남았다. 생성물은 커밋 대상에서 제외하고, 사용자 기존 변경 여부를 확인하지 않은 채 삭제·복원하지 않는다.
- 비밀번호·SSH 개인 키·JWT·Fernet 값, Airflow Variable 암호문, 원본 FITS는 이 문서·커밋에 포함하지 않는다. Tailnet UI 접속과 안전한 운영 명령은 [Node 1 운영 절차](../../infra/distributed-system/README.md#airflow-db)를 따른다.

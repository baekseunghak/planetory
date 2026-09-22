# DAG

Sector 단위 수집·검증·HDFS 적재·Spark 제출·PublicationBundle 공개 DAG를 둔다.

## `tess_bronze_to_silver` (78의 1~13 입력, 수동 실행)

이 DAG는 일시정지·무스케줄로 생성된다. 252의 수집 DAG를 수정하거나 자동 trigger하지 않는다. Airflow는 SSH로 Node 1의 불변 Silver 제어기를 실행하고 실제 전처리·BLS는 Spark on YARN에서 수행한다. `tess_pipeline_enabled=false`이고 Bronze DAG에 실행 중인 run이 없어야 시작한다. `tess_yarn` Pool 한 슬롯과 Bronze/Silver 제어기의 Node 1 공통 잠금을 사용한다. **현재 서버의 기존 Bronze release에는 이 잠금이 없으므로**, 새 Bronze release가 적용되기 전까지는 수집을 drain한 뒤에만 이 DAG를 실행한다.

Trigger conf의 필수 키는 `operation`(`canary`·`run`·`retry`), `silver_release`(`/opt/planetory-silver/releases/<UTC-release>`), `bronze_coverage`(`/lake/bronze/tess/coverage=<SHA-256>`), `run_id`(UTC), `pipeline_version`이다. 선택 키는 `shuffle_partitions`(1~500, 기본 200), `output_partitions`(1~200, 기본 80)이다. `canary`는 중복 없는 양의 `tic_ids` 1~5개를, `retry`는 완료된 불변 Silver attempt의 `retry_from`을 추가로 요구한다. 알 수 없는 Sector 경로나 임의 셸 인자는 허용하지 않는다. 예시는 다음과 같다.

```json
{
  "operation": "canary",
  "silver_release": "/opt/planetory-silver/releases/20260922T000000Z",
  "bronze_coverage": "/lake/bronze/tess/coverage=<64자리-소문자-SHA-256>",
  "run_id": "20260922T010000Z",
  "pipeline_version": "S15P21C206-78-20260922T000000Z",
  "tic_ids": [123456789]
}
```

실행 전 불변 Silver release와 252의 `tess-airflow` SSH Connection을 준비하고, [Node 1 제한 sudo·Pool 설정 스크립트](../../../infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh)를 해당 release ID로 실행한다. 이 스크립트는 운영 sudoers·Airflow metadata DB를 바꾸므로 대상과 복구 방법을 확인한 뒤 별도 승인이 필요하다. DAG import·계약 검사는 `python -m unittest discover -s distributed-system/airflow/tests -p "test_*.py"`로 실행한다. DAG 성공은 Silver 제어기의 `_READY` 재감사와 명령 종료 0을 뜻하며, `failed_tics=0`이나 Gold 게시 준비를 뜻하지 않는다. 실패 TIC는 `retry`를 별도 DAG run으로 지정한다.

Sector 14+는 252가 Sector별 Bronze `_READY`만 만들고, 78의 Silver 제어기는 **Sector 1~13 전체 coverage와 TIC별 다중 Sector 결합**만 승인하므로 이 DAG가 받지 않는다. Sector 14 성공을 1~13 coverage의 확장이나 완전한 TIC Silver로 오인하지 않는다. 14+ 연속 처리에는 혼합 Bronze 버전·누적 Sector snapshot·변경 TIC 재처리·이전 Silver 결과 조합 계약이 필요하며, 전체 DAG·publish-ready 책임인 80에서 252/78 정본과 별도로 승인해야 한다.

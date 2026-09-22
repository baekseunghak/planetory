# Airflow

수집, Spark 처리, 검증과 Gold 전달의 실행 순서·재시도를 정의하는 DAG를 둘 위치다.

Airflow는 작업을 조정하며 대용량 데이터를 직접 처리하지 않는다. 현재 Node 1 운영은 Airflow 3.2.2 API Server·Scheduler·별도 DAG Processor이며, 이전 2.10.5 DB와 release는 롤백용으로 보존한다. 실제 Sector 단계의 3.2.2 실행은 아직 검증하지 않았다.

TESS Sector 파이프라인은 [DAG 계약](dags/README.md)을 따른다. 운영 이미지에는 `apache-airflow==3.2.2`, FAB·SSH·Standard provider를 고정한다. 원격 systemd·HDFS·Spark/YARN 제어에는 복제 metadata DB로 보존한 내부망 SSH Connection을 사용한다. 전환·롤백 게이트는 [Node 1 운영 절차](../../infra/distributed-system/README.md#airflow-322-전환)를 따른다.

# Airflow

수집, Spark 처리, 검증과 Gold 전달의 실행 순서·재시도를 정의하는 DAG를 둘 위치다.

Airflow는 작업을 조정하며 대용량 데이터를 직접 처리하지 않는다. 운영 Scheduler와 Webserver는 GCP Node 1에 배포하고 같은 PostgreSQL metadata DB를 사용한다.

TESS Sector 파이프라인은 [DAG 계약](dags/README.md)을 따른다. 원격 systemd·HDFS·Spark/YARN 제어에는 `apache-airflow-providers-ssh==4.1.6`과 Airflow metadata DB의 내부망 SSH Connection을 사용한다.

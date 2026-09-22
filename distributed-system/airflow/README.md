# Airflow

수집, Spark 처리, 검증과 Gold 전달의 실행 순서·재시도를 정의하는 DAG를 둘 위치다.

Airflow는 작업을 조정하며 대용량 데이터를 직접 처리하지 않는다. 운영 Scheduler와 Webserver는 GCP Node 1에 배포하고 같은 PostgreSQL metadata DB를 사용한다.

Sector 수집 DAG와 별도 Silver 실행 DAG의 입력·안전 게이트는 [DAG 안내](dags/README.md)를 따른다.

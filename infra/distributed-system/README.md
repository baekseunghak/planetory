# OCI 분산 시스템 배포

Hadoop, YARN, Spark와 Airflow의 공통 실행 설정과 OCI 노드별 역할을 둔다.

네 VM을 하나의 로컬 Docker 네트워크로 가정하지 않는다. 실제 노드 간 주소와 암호화된 통신 경로를 사용한다.

`compose.yaml`은 Registry의 Airflow·수집·Spark·Publisher 이미지를 사용한다. Airflow는 상시 서비스이고 나머지는 Airflow가 필요할 때 실행하는 작업 이미지다. 서버별 경로와 연결 정보는 각 노드의 `.env`에 둔다.

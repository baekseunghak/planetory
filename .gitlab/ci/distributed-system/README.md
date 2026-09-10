# 분산 시스템 CI/CD

Hadoop/YARN 환경, 수집기, Spark 작업, Airflow와 Publisher의 검사·OCI 배포 설정을 둘 위치다.

노드별 작업은 같은 이미지에 `infra/distributed-system/`의 역할 설정만 적용한다. HDFS 삭제와 NameNode 초기화는 일반 배포에 포함하지 않는다.

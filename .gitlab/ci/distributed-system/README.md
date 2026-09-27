# 분산 시스템 CI/CD

Publisher 이미지 빌드(`publisher.yml`)만 둔다. 이 이미지는 EC2-A Gold 목업(`gold-mock` profile)이 쓴다.

GCP 노드에는 CI 배포 job을 두지 않는다(`S15P21C206-94`). 수집·HDFS 적재·Spark Bronze·Airflow 코드는 불변 release 디렉터리로 묶어 [운영자 스크립트](../../../infra/distributed-system/scripts/)가 설치한다. Airflow 교체는 Node 1 스크립트(`deploy-tess-airflow-node1.sh --update`)만 하며, 이 스크립트가 활성 DagRun 0·DAG import·Triggerer 상태를 확인한다. HDFS 삭제와 NameNode 초기화는 어떤 배포 경로에도 넣지 않는다.

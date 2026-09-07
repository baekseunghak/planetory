# 분산 파이프라인 PoC

합성 Sector 데이터를 HDFS, Spark on YARN, Gold 전달과 모의 서비스 DB까지 통과시키는 실험 위치다.

구현 범위와 합격 조건은 [분산 파이프라인 Docker PoC](../../docs/experiments/distributed-pipeline-poc.md)를 따른다. 이 디렉터리의 성공은 실제 OCI 처리량이나 장애 내성을 증명하지 않는다.

## 현재 상태

`compose.yaml`은 NameNode, DataNode 2개, ResourceManager, NodeManager 2개와 모의 PostgreSQL의 배치만 정의한 뼈대다. Spark 작업, Publisher와 Gold 수신기는 아직 구현되지 않았다.

```powershell
$env:POSTGRES_PASSWORD = "local-poc-only"
docker-compose -f compose.yaml config -q
docker-compose -f compose.yaml --profile distributed up -d
```

기본 Hadoop 이미지는 로컬 x86_64 검사용이다. OCI ARM64 검증에서는 ARM64 지원을 확인한 이미지와 `TARGET_PLATFORM=linux/arm64`를 명시해야 한다.

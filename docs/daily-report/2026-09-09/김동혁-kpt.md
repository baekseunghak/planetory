# 2026-09-09 KPT

### Keep

- GCP 분산 처리와 EC2 서비스 영역의 책임을 명확히 분리했다.
  - GCP: 수집, HDFS 저장, Spark 배치
  - EC2: 검증된 Gold 데이터와 사용자 서비스
- 최신 요구사항 v0.12를 기준으로 기존 문서와 설정을 동기화했다.
- HDFS 용량에 맞춰 복제 계수를 RF2로 조정하고 데이터 디스크를 노드당 2,000GiB로 통일했다.
- 변경사항을 인프라 설정과 아키텍처 문서로 나눠 커밋했다.

### Problem 

- 설계 범위가 넓어지면서 같은 내용이 여러 문서에 중복되거나 표현이 달라졌다.


### Try

- 한 개 Sector로 최소 파이프라인 PoC를 먼저 실행한다.

```text
수집 → Raw HDFS → Spark on YARN → Silver
→ PublicationBundle 검증·백업 → EC2 Gold 공개
```

- PoC 결과를 바탕으로 Gold 파일 스키마와 실제 용량을 결정한다.
- 실제 GCP 환경에서 다음 항목을 순서대로 검증한다.
  1. 프로젝트 간 사설 IP와 FQDN 통신
  2. HDFS RF2 저장과 Worker 장애 복구
  3. Spark on YARN 실행
  4. Active NameNode 수동 전환
  5. Gold 검증 실패 시 기존 `current` 유지
- 비용과 할당량은 VM 생성 직전에 각 계정의 실제 Billing 및 Quota로 다시 확인한다.
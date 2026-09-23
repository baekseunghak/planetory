# 아키텍처 문서 안내

시스템 경계, 데이터 소유권, 서비스 DB, 인프라 역할과 저장소 배치를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| AWS·GCP 경계와 불변 규칙 | [시스템 아키텍처](system-architecture.md) | 시스템 경계 정본, 목표 설계 |
| PostgreSQL 테이블·관계·제약 | [서비스 DB ERD](database-erd.md) | 백엔드 데이터 모델 기준선 |
| 후보 병합·분리 시 기록·성과·공개 관계 정정 | [후보 병합·분리 정정 계약](candidate-correction-contract.md) | C18 결정 요청 초안. 확정 범위와 미확정 항목을 가르고 C19 수행 범위를 고정. 데이터·탐사·서비스 교차 검토 대기 |
| GCP 노드·디스크·네트워크 | [GCP 분산 인프라](gcp-distributed-infrastructure.md) | 인프라 상세·PoC 계획 |
| EC2 잔차·주기도 계산 | [온라인 파생 계산](online-derived-compute.md) | 계산 경계 상세 |
| EC2 진입·장애 전환 | [EC2 서비스 진입·장애 전환 경계](ec2-service-entry-failover.md) | 진입·포트·신뢰 경계·장애 시나리오·데이터 손실 경계 상세, 채택 |
| 디렉터리와 배포 단위 | [저장소 구조](repository-structure.md) | 저장소 배치 정본 |

## 자주 쓰는 약어

| 약어 | 뜻 |
| --- | --- |
| RF2 | HDFS 복제 계수 2. 같은 데이터를 서로 다른 노드에 두 벌 저장한다 |
| p95 | 요청 100개 중 느린 다섯 개를 제외한 최대 응답시간 |
| checksum | 전송 전후 파일이 같은지 확인하는 무결성 값 |

시스템 아키텍처는 구축 완료를 뜻하지 않는다. Gold 저장, Redis와 분석 세션 전환처럼 문서 간 결정이 다른 항목은 [문서 정합화 상태](../project/planetory-doc-sync-requests.md)를 확인하고 임의로 구현하지 않는다.

구조나 소유권이 바뀌면 이 README와 담당 정본을 함께 갱신한다. 실행·배포 방법은 [운영 문서](../operations/README.md), 데이터 처리 상세는 [데이터 문서](../data/README.md)에서 관리한다.

# 아키텍처 문서 안내

시스템 경계, 데이터 소유권, 서비스 DB, 인프라 역할과 저장소 배치를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| AWS·GCP 경계와 불변 규칙 | [시스템 아키텍처](system-architecture.md) | 시스템 경계 정본, 목표 설계 |
| PostgreSQL 테이블·관계·제약 | [서비스 DB ERD](database-erd.md) | 백엔드 데이터 모델 기준선 |
| GCP 노드·디스크·네트워크 | [GCP 분산 인프라](gcp-distributed-infrastructure.md) | 인프라 상세·PoC 계획 |
| EC2 잔차·주기도 계산 | [온라인 파생 계산](online-derived-compute.md) | 계산 경계 상세 |
| 디렉터리와 배포 단위 | [저장소 구조](repository-structure.md) | 저장소 배치 정본 |

시스템 아키텍처는 구축 완료를 뜻하지 않는다. Gold 저장, Redis와 분석 세션 전환처럼 문서 간 결정이 다른 항목은 [문서 정합화 상태](../project/planetory-doc-sync-requests.md)를 확인하고 임의로 구현하지 않는다.

구조나 소유권이 바뀌면 이 README와 담당 정본을 함께 갱신한다. 실행·배포 방법은 [운영 문서](../operations/README.md), 데이터 처리 상세는 [데이터 문서](../data/README.md)에서 관리한다.

# 분산 PoC·CI/CD 문서 안내

> 대표 Task: S15P21C206-28 · 상태: 인프라·CI/CD 뼈대 작성 완료, PoC·실제 배포 검증 미완료

이 문서는 분산 처리 PoC와 배포 준비 문서의 시작점이다. PoC는 본 개발 전에 핵심 흐름이 실제로 동작하는지 작게 검증하는 **개념 증명(Proof of Concept)** 이다.

## 문서 지도

| 궁금한 내용 | 문서 |
| --- | --- |
| 코드를 어느 디렉터리에 둘지 | [저장소 구조](../development/repository-structure.md) |
| Docker PoC에서 무엇을 검증할지 | [분산 파이프라인 PoC](distributed-pipeline-poc.md) |
| 잔차 곡선·주기도를 EC2에서 계산하는 방법 | [온라인 파생 계산](../development/online-derived-compute.md) |
| 서비스와 분산 시스템의 독립 CI/CD | [CI/CD 운영안](../operations/cicd.md) |
| Dockerfile과 Compose 배치 기준 | [Docker 구성](../operations/docker.md) |
| GCP·EC2 역할과 서버 자원 | [시스템 아키텍처](../development/system-architecture.md) |
| Raw·Bronze·Silver·Gold 규칙 | [데이터 규칙](../development/data-guidelines.md) |
| Airflow·Spark·YARN 처리 규칙 | [Spark/Hadoop 지침](../development/spark-hadoop-guidelines.md) |

같은 설명을 여러 문서에 복사하지 않는다. 위 정본이 바뀌면 해당 문서만 수정한다.

## 공통 용어

- **Raw/Bronze/Silver/Gold**: 원본부터 서비스 공개 데이터까지의 처리 단계다.
- **Worker**: Spark 작업이나 HDFS 저장을 실제로 수행하는 노드다.
- **PublicationBundle**: GCP가 검증해 EC2로 전달하는 한 버전의 Gold 파일 묶음이다.
- **manifest**: 묶음에 포함된 파일·버전·크기·무결성 값을 적은 목록 파일이다.
- **checksum**: 전송 전후 파일이 같은지 확인하는 무결성 값이다.
- **p95**: 요청 100개 중 느린 쪽 다섯 개를 제외한 최대 응답시간이다.
- **RF3**: HDFS가 같은 데이터를 서로 다른 노드에 세 벌 저장한다는 뜻이다.

## 이번 설계의 결론

- 기존 모노레포를 유지한다.
- EC2 서비스 코드는 `apps/`, GCP 처리 코드는 `distributed-system/`, 서버 배치 설정은 `infra/`에 둔다.
- 첫 PoC는 `experiments/distributed-pipeline/`에서 합성 데이터로 실행한다.
- GCP는 Raw·Bronze·Silver를 만들고 검증된 Gold만 EC2로 보낸다. EC2 서비스는 HDFS를 실시간 조회하지 않는다.
- 서비스 앱과 분산 시스템은 서로 독립적으로 검사·배포한다.
- 구현이 생기기 전에는 빈 디렉터리나 빈 CI 파일을 미리 만들지 않는다.

## 명세 기준과 보류 범위

저장소의 [요구사항 명세서 v0.12](../requirements/planetory-requirements-spec.md)를 정본으로 사용한다. DAT-05·DAT-11·DAT-14는 사용자용 단계별 잔차 곡선·주기도를 Bundle에 저장하지 않고 EC2에서 온라인 계산하는 것으로 정합화됐다.

PublicationBundle에는 `fold_reference_time_btjd`를 포함하고 분석 세션은 시작 시점 Bundle에 고정한다. 구버전 Bundle과 캐시는 보존기간 동안 함께 유지하지만, Gold 전체 파일 스키마·용량·보존기간은 팀 합의가 필요하므로 미니 파이프라인 PoC 후 별도 Task에서 확정한다.

## 후속 작업 순서

| 순서 | 작업 | 완료 증거 |
| --- | --- | --- |
| 1 | 최소 manifest와 합성 데이터로 Docker 분산 파이프라인 PoC | YARN 작업 ID, HDFS 결과, 모의 DB 조회 |
| 2 | PoC 결과로 Gold 입력·출력 계약 확정 | 담당자 합의, 예제 데이터와 스키마 검사 통과 |
| 3 | Gold 전송·검증·전환 PoC | 실패 시 이전 릴리스 유지 |
| 4 | 배치와 온라인 계산의 수치 일치 검증 | 운영 amd64의 배치·온라인 결과 비교; ARM64는 지원 필요 시 추가 |
| 5 | 온라인 계산 API·대기열·캐시 PoC | 중복 요청·실패·부하 측정 |
| 6 | Gold 용량과 GCP 처리시간 측정 | 표본 기반 용량·시간 보고서 |
| 7 | GitLab CI 검사 분리 | 변경 경로별 필요한 작업만 실행 |
| 8 | GCP·EC2 배포 자동화 | 노드별 배포·상태 확인·되돌리기 |

## 아직 완료되지 않은 것

CI/CD 뼈대와 노드별 Compose·XML 설정은 작성했다. 로컬 구성 검사와 GitLab 파이프라인 `#184815`의 정적 검사는 통과했으며, 아래 실제 실행 검증은 별도 작업이다.

- 데이터·백엔드·프론트 담당자의 계약 검토
- GCP/EC2 실제 자원, GitLab Runner, Registry와 GitLab 버전 확인
- PoC 코드 작성과 Docker 실행
- 실제 이미지 빌드·Registry push, 변경 경로별 job 선택 및 서버 배포·롤백 검증
- Jira 결과 링크 등록

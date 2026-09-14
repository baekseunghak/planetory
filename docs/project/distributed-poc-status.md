# 분산 PoC 진행 상태

> 대표 Task: S15P21C206-28 · 확인 기준: 2026-09-11

이 문서는 분산 처리 PoC(Proof of Concept, 개념 증명)의 현재 검증 상태와 후속 작업만 관리한다. 설계·용어·운영 규칙을 복제하지 않는다.

## 현재 기준

- 실험 범위와 합격 조건: [분산 파이프라인 Docker PoC](../experiments/distributed-pipeline-poc.md)
- 현행 기술 기준: [아키텍처](../architecture/README.md), [데이터](../data/README.md), [운영](../operations/README.md)
- Gold·Redis·Bundle 전환 충돌: [문서 정합화 요청 R3~R5](planetory-doc-sync-requests.md). 이 항목이 해결되기 전에는 과거 `current/previous` 설명을 구현 기준으로 사용하지 않는다.
- 상태: 인프라·CI/CD 뼈대와 정적 검사는 완료했으며 PoC·실제 이미지·배포·롤백 검증은 미완료다.

## 후속 작업 순서

| 순서 | 작업 | 완료 증거 |
| --- | --- | --- |
| 1 | 최소 manifest와 합성 데이터로 Docker 분산 파이프라인 PoC | YARN 작업 ID, HDFS 결과, 모의 DB 조회 |
| 2 | PoC 결과로 Gold 입력·출력 계약 확정 | 담당자 합의, 예제 데이터와 스키마 검사 통과 |
| 3 | HDFS Bundle 백업과 Gold 전송·검증·전환 PoC | 실패 시 이전 릴리스 유지, 백업 checksum 일치 |
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

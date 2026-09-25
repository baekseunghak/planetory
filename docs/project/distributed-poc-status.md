# 분산 PoC 진행 상태

> 대표 Task: S15P21C206-28 · 확인 기준: 2026-09-18

이 문서는 분산 처리 PoC(Proof of Concept, 개념 증명)의 현재 검증 상태와 후속 작업만 관리한다. 설계·용어·운영 규칙을 복제하지 않는다.

## 현재 기준

- 실험 범위와 합격 조건: [분산 파이프라인 Docker PoC](../experiments/distributed-pipeline-poc.md)
- 현행 기술 기준: [아키텍처](../architecture/README.md), [데이터](../data/README.md), [운영](../operations/README.md)
- Gold·Redis·Bundle 전환 기준: [문서 정합화 요청 R3~R5](planetory-doc-sync-requests.md) 반영 완료. PostgreSQL 직접 적재·current 트랜잭션 전환·Redis 캐시·최신 판 재로드를 구현 기준으로 사용한다.
- 상태: `S15P21C206-72`의 Hadoop 3.5.0·OpenJDK 17 HDFS HA·RF2, `S15P21C206-73`의 YARN·Spark 3.5.5 sample, `S15P21C206-74`의 Node 1·Worker 4 실제 장애와 수동 복구 검증을 완료했다. 73번 Application `application_1789675115055_0005`는 Worker 5대에 executor를 배치해 HDFS 결과와 checksum을 남기고 `SUCCEEDED`로 끝났으며, Node 2는 16GiB/2 vCore 한도에서 swap 0과 관리자 권한 커널 저널 기준 OOM 없음이었다. 74번은 Node 1 종료 뒤 Node 2의 기존 파일 읽기·신규 쓰기, Worker 4 중단 중 RF2 읽기와 복귀 뒤 복제 2·checksum 회복을 확인했다. ResourceManager는 Node 1 복구가 필요했고 Airflow·Publisher는 아직 배포되지 않아 비-HA 경계만 확정했다. 다음 단계는 최소 manifest와 합성 데이터의 분산 파이프라인 PoC이며 Node 2~6 Docker 설치는 수집 컨테이너 배포 작업에 남아 있다.

## 후속 작업 순서

| 순서 | 작업 | 완료 증거 |
| --- | --- | --- |
| 1 | `S15P21C206-72` HDFS 설치·초기화 (완료) | Hadoop 3.5.0·OpenJDK 17, QJM 3개, Active/Standby, DataNode 5개, RF2 쓰기·읽기·checksum |
| 2 | `S15P21C206-73` YARN·Spark sample application (완료) | ResourceManager·NodeManager, Spark 3.5.5 Application ID, 성공 상태와 HDFS 결과 |
| 3 | `S15P21C206-74` 수동 HA·Worker 장애 복구 (완료) | Node 2 승격 I/O, RF2 장애 중 읽기, 재복제·checksum·로그 감사 |
| 4 | 최소 manifest와 합성 데이터로 Docker 분산 파이프라인 PoC | YARN 작업 ID, HDFS 결과, 모의 DB 조회 |
| 5 | PoC 결과로 Gold 입력·출력 계약 확정 | 담당자 합의, 예제 데이터와 스키마 검사 통과 |
| 6 | HDFS Bundle 백업과 PostgreSQL Gold 적재·검증·전환 PoC | 실패 시 기존 current 유지, 백업 checksum 일치, 커밋 후 알림 재시도 |
| 7 | 배치와 온라인 계산의 수치 일치 검증 | 운영 amd64의 배치·온라인 결과 비교; ARM64는 지원 필요 시 추가 |
| 8 | 온라인 계산 API·대기열·캐시 PoC | 중복 요청·실패·부하 측정 |
| 9 | Gold 용량과 GCP 처리시간 측정 | 표본 기반 용량·시간 보고서 |
| 10 | `S15P21C206-91` GitLab CI 검사 분리·Runner 검증 | YARN XML·스크립트 경로별 job 선택, Linux Runner 성공·실패 Pipeline 증거 |
| 11 | GCP·EC2 배포 자동화 | 노드별 배포·상태 확인·되돌리기 |

## 아직 완료되지 않은 것

CI/CD 뼈대와 노드별 Compose·XML 설정은 작성했다. 로컬 구성 검사와 GitLab 파이프라인 `#184815`의 정적 검사는 통과했으며, 아래 실제 실행 검증은 별도 작업이다.

- 데이터·백엔드·프론트 담당자의 계약 검토
- 실제 Sector 입력을 사용한 Spark 메모리·처리시간 상한과 재시도 검증
- GCP/EC2 실제 자원, Registry와 GitLab 버전 확인
- ~~`S15P21C206-91`에서 YARN XML·스크립트의 `validate:hadoop-config` 경로 선택, Linux Runner 실행과 성공·실패 Pipeline 증거 확인.~~ 2026-09-25 확인: 파이프라인 `#222677`·`#222681`·`#222683`([CI/CD 「설정·계약 검사」](../operations/cicd.md#설정계약-검사-s15p21c206-91)). `S15P21C206-73`은 로컬·실환경 검증까지만 완료했으며 CI 통과를 완료 증거로 주장하지 않는다.
- PoC 코드 작성과 Docker 실행
- 실제 이미지 빌드·Registry push와 서버 배포·롤백 검증
- Jira 결과 링크와 MR 등록

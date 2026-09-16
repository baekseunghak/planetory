# 운영 문서 안내

로컬 실행, 이미지, CI/CD와 배포 경계를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| Dockerfile·Compose·로컬 실행 | [Docker 개발·배포 기준](docker.md) | 실행 방식 정본 |
| GitLab 파이프라인·배포 경계 | [GitLab CI/CD](cicd.md) | CI/CD 기준과 미검증 항목 |
| 팀원 Tailscale 등록·프로젝트 서버 접속 | [Tailscale 팀 서버 접근](tailscale-team-access.md) | 승인 절차와 팀원 접근 범위 |
| GCP 노드 점검·종료 | [GCP 노드 운영 런북](gcp-node-runbook.md) | 사설망·FQDN·방화벽·비용 점검 절차 |

서버 역할은 [아키텍처](../architecture/README.md)를 따른다. 정적 검사 통과, 이미지 빌드, Registry push와 실제 서버 배포 검증을 구분한다.

운영 배포, 영속 데이터 초기화, DB 변경과 Gold 공개 전환은 정확한 대상과 롤백 방법을 확인하고 승인받은 뒤 수행한다.

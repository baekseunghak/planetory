# 운영 문서 안내

로컬 실행, 이미지, CI/CD와 배포 경계를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| Dockerfile·Compose·로컬 실행 | [Docker 개발·배포 기준](docker.md) | 실행 방식 정본 |
| GitLab 파이프라인·배포 경계 | [GitLab CI/CD](cicd.md) | CI/CD 기준과 미검증 항목 |
| prod 쿠키·인증 DB 중단 응답 | [인증 런타임 실측(235)](auth-runtime-verification-235.md) | 격리 검증 기록·운영 인수 경계 |
| 팀원 Tailscale 등록·프로젝트 서버 접속 | [Tailscale 팀 서버 접근](tailscale-team-access.md) | 승인 절차와 팀원 접근 범위 |
| GCP 노드 점검·종료 | [GCP 노드 운영 런북](gcp-node-runbook.md) | 사설망·FQDN·방화벽·비용 점검 절차 |
| 주간 챌린지 대상 등록·Redis 사전 적재·회차 전환·회차 별 일괄 발견 | [챌린지 별 등록·회차 전환 런북](challenge-round-runbook.md) | 초안. 명령·Gold 캐시 구현 완료, 서버 실행 미검증 |
| 판정 규칙 새 버전·튜토리얼 별·챌린지 대상 입력 | [운영 규칙 변경 런북](operation-rule-runbook.md) | 초안. DB 검증·초기 규칙 구현 완료, 운영 DB 적용 미검증 |
| 후보 병합·분리가 회원 성과·공개에 주는 영향 확인 | [후보 정정 사전검사 런북](candidate-correction-runbook.md) | 초안. 읽기 전용 사전검사 명령 구현 완료. 적용·복구 절차는 계약 승인 전까지 없음 |
| 전체 MV·일별 비교 기준선·최소 잡 역할 | [통계 실행 런북](statistics-runbook.md) | 178 구현·격리 검증, 운영 스케줄 활성화는 별도 |

서버 역할은 [아키텍처](../architecture/README.md)를 따른다. 정적 검사 통과, 이미지 빌드, Registry push와 실제 서버 배포 검증을 구분한다.

운영 배포, 영속 데이터 초기화, DB 변경과 Gold 공개 전환은 정확한 대상과 롤백 방법을 확인하고 승인받은 뒤 수행한다.

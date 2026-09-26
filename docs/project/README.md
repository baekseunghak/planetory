# 프로젝트 운영 문서 안내

팀 소유권과 현재 문서 정합화 상태를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 담당 영역·협업 경계 | [팀 역할 분배](team-role-allocation.md) | 기획 단계 역할 지도 |
| TESS 처리·AI 담당 범위와 실행 순서 | [TESS 처리·AI 역할 명세](tess-processing-ai-role-spec.md) | 담당자 작업 계획 |
| TESS 처리·AI 후속 Task와 Epic 구조 | [TESS 처리·AI 후속 Task 계획](tess-processing-ai-task-plan.md) | Epic·티켓 생성 완료, MR 리뷰 대기 |
| TESS 파이프라인 Jira·MR 검토 | [파이프라인 리뷰 체크리스트](tess-pipeline-review-checklist.md) | 검토 기록 |
| 분산 PoC 완료·미검증 상태 | [분산 PoC 진행 상태](distributed-poc-status.md) | 현재 검증 상태와 후속 작업 |
| 서비스 배포·CI/CD 상태 | [서비스 배포 현재 상태](service-deploy-status.md) | 현재 배포 상태·검증 경계·남은 결정 |
| 문서 충돌·반영 대기 | [문서 정합화 요청](planetory-doc-sync-requests.md) | 현재 상태·차단 항목 |

역할 문서는 기술 정본을 대신하지 않는다. 문서 정합화 요청은 해결된 항목을 표시하되 과거 결정 전체를 복제하지 않고 관련 Jira·정본에 연결한다.

구조와 담당이 바뀌면 역할 지도를, 현재 충돌이나 차단 상태가 바뀌면 정합화 상태만 갱신한다. 해결된 중요한 판단 근거는 [변경 이력](../changes/README.md)에 남긴다.

## 삭제·대체 상태

의도적으로 없앤 문서만 기록한다. 같은 경로를 다시 만들지 말고 대체 문서의 해당 범위에 내용을 추가한다.

| 제거한 경로 | 이유 | 대체 문서 | 재도입 조건 |
| --- | --- | --- | --- |
| `docs/development/tess-pipeline-gap-analysis.md` | 처리 단계별 문서로 분할 | [TESS 파이프라인 분석](../data/tess-pipeline/README.md) | 단일 파일로 합쳐야 할 검증된 필요가 생긴 경우 |
| `docs/development/planetory-service-backend-feature-analysis.md` | 기능 영역별 문서로 분할 | [서비스 백엔드 기능 분석](../development/service-backend/README.md) | 단일 파일로 합쳐야 할 검증된 필요가 생긴 경우 |
| `docs/git-jira-convention.md` | 요청 유형별 워크플로 가이드로 분할 | [워크플로 문서 안내](../workflows/README.md) | 단일 컨벤션 문서로 합쳐야 할 검증된 필요가 생긴 경우 |
| `apps/backend/docs/api-spec-ownership.md` | 실제 API 문서 디렉터리의 인덱스로 승격 | [백엔드 API 문서](../../apps/backend/docs/README.md) | 별도 분담 문서가 다시 필요해진 경우 |
| `docs/experiments/distributed-poc-cicd-plan.md` | 중복 문서 지도와 폐기된 계약을 제거하고 상태만 분리 | [분산 PoC 진행 상태](distributed-poc-status.md) | 실험별 별도 계획 문서가 다시 필요해진 경우 |
| `docs/workflows/mattermost-message.md` | 외부 메신저 직접 전송을 저장소 워크플로 범위에서 제거 | 없음 | 별도 Jira 범위와 비밀정보 관리 방식이 합의된 경우 |
| `docs/project/tess-airflow-handoff-2026-09-23.md` | 토큰 만료 장애 해결·운영 회귀 완료로 임시 인계 종료 | [2026-09-23 변경 이력](../changes/2026-09-W4/2026-09-23.md), [DAG 계약](../../distributed-system/airflow/dags/README.md) | 없음. 새 인계가 필요하면 새 날짜의 임시 문서로 만든다 |
| `docs/project/s15p21c206-78-handoff.md` | 78 브랜치 종료(Sector 1~13 전체 Silver run 확정·새 release Canary 합격). 남은 서버 DAG 배포·sudo·Pool 적용은 80으로 이관 | [Silver 계약](../../distributed-system/spark/README.md#tess-bronze--silver-최초-탐색-s15p21c206-78), [DAG 계약의 배포 순서](../../distributed-system/airflow/dags/README.md), [2026-09-26 변경 이력](../changes/2026-09-W4/2026-09-26.md) | 없음. 새 인계가 필요하면 새 날짜의 임시 문서로 만든다 |

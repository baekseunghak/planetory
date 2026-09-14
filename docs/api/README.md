# API 문서 안내

서비스 간 요청·응답 계약, Mock과 검증 예제를 찾는 진입점이다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| API 담당 경계·공통 약속 | [백엔드 API 문서](../../apps/backend/docs/README.md) | 담당 영역 인덱스·분담 제안 |
| 서비스 백엔드 주요 API | [서비스 API 명세](../../apps/backend/docs/service-api-spec.md) | 팀 협의용 초안 |
| 별 지도·탐사 코어 API | [탐사 코어 API 명세](../../apps/backend/docs/exploration-api-spec.md) | 팀 협의용 초안 Draft 0.2 |
| 분석 API·Mock | [분석 API 기록](analysis/README.md) | v0.12 실험 기록 |
| 구판 분석 fixture의 v1 전환 | [v1.0 전환 기준](analysis/v1-migration.md) | 작성 당시 교체 지침 |
| 분석 화면 상태 | [상태 모델](analysis/state-model.md) | v0.12 실험 기록 |
| JSON 시나리오 | [예제 안내](analysis/examples/README.md) | 합성 fixture |

API 정책은 [요구사항](../requirements/README.md), DB 제약은 [아키텍처](../architecture/README.md)가 우선한다. Mock 검증 통과는 실제 서버 구현이나 v1.0 계약 검증을 뜻하지 않는다.

새 API를 확정할 때는 명세, 소비자·생산자 구현과 계약 검증을 같은 변경에서 갱신한다.

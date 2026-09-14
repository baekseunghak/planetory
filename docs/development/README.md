# 개발 명세 안내

서비스 프론트엔드·백엔드 구현 전에 합의할 기능별 상세 명세를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 분석 화면·상태·API 요구 | [분석 프론트엔드 상세 명세](analysis-frontend-spec.md) | 팀 검토용 초안 |
| 백엔드 기능별 범위·결정 | [서비스 백엔드 기능 분석](service-backend/README.md) | 팀 검토용 초안과 기능별 문서 지도 |
| 별 지도 배치·좌표·표현 계약 | [별지도 표현 계약](sky-presentation-contract.md) | v1.2 변경안, 담당자 교차 리뷰 대기 |

기능 정책은 [요구사항](../requirements/README.md), DB 구조는 [아키텍처](../architecture/README.md), 전송 형식은 [API](../api/README.md)를 먼저 확인한다. 이 디렉터리의 초안만으로 API나 구현 완료를 확정하지 않는다.

실제 구현을 시작할 때는 `apps/frontend/README.md` 또는 `apps/backend/README.md`와 현재 코드·테스트를 함께 확인한다.

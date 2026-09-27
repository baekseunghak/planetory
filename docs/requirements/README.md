# 요구사항 문서 안내

서비스 정책, 기능, 상태, 화면 용어와 프로토타입을 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 기능·비기능 요구 | [요구사항 명세서](planetory-requirements-spec.md) | 서비스 요구사항 정본 |
| 통합 검수 시나리오와 요구 추적 | [인수 조건](planetory-acceptance-criteria.md) | 정본의 검증·추적 상세 |
| 미결정 정책과 팀 회의 안건 | [결정 등록부](planetory-decision-register.md) | 확정·미정 상태 추적 |
| 알림 수신자·채널·읽음·보관·중복·175 인계 | [알림 정책 F15](../development/service-backend/community.md#notification-policy) | Q1~Q5·기존 사건 비소급 채택. 175 구현과 남은 생산자 계약 구분 |
| P1 통계 산식·시간 경계·검산·177/178 인계 | [통계 지표 사전](planetory-statistics-policy.md) | 2026-09-22 개인·공통 기준 사용자 승인, 현재값·과거 원천 재현 한계·실제 인수 구분 |
| 과거 요구사항 판의 변경 | [요구사항 개정 이력](planetory-requirements-history.md) | v1.3.2 변경안까지의 누적 기록 |
| 후보·별 상태 전이 | [후보·별 상태표](planetory-status-table.md) | 요구사항 상세화 |
| 사용자 화면 문구 | [용어 사전](planetory-glossary.md) | 화면 표기 기준 |
| 화면 구성과 흐름 | [와이어프레임](planetory-wireframe.html) | 화면 설계 자료 |
| 클릭 가능한 과거 시안 | [프로토타입](prototype/README.md) | 검증용 산출물 |

내용이 다르면 요구사항 명세서가 상태표·용어 사전·와이어프레임·프로토타입보다 우선한다. `TBD`, DEC 항목과 팀 검토용 초안을 확정된 정책으로 구현하지 않는다.

요구사항 변경 시 관련 상태·용어·화면·API·DB 문서의 동기화 여부를 함께 확인한다.

별지도의 외형 기준은 [개인 시제품 화면·배치/표현 검증 자료](../development/sky-reference/README.md)다. 과거 prototype과 204 비교 장면은 현행 외형 기준을 대신하지 않는다.

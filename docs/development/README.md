# 개발 명세 안내

서비스 프론트엔드·백엔드 구현 전에 합의할 기능별 상세 명세를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 분석 화면·상태·API 요구 | [분석 프론트엔드 상세 명세](analysis-frontend-spec.md) | 팀 검토용 초안 |
| 백엔드 기능별 범위·결정 | [서비스 백엔드 기능 분석](service-backend/README.md) | 팀 검토용 초안과 기능별 문서 지도 |
| 별 지도 배치·좌표·표현 계약 | [별지도 표현 계약](sky-presentation-contract.md) | v1.3 개인 시제품 외형·연출·선택 근접 뷰 변경안, 담당자 교차 리뷰 대기 |
| 군집 제거의 근거·후속 티켓·검증 경계 | [개별 별 변경 검토 기록](sky-individual-stars-review.md) | 227번 변경안, [기준 화면·재현 예제](sky-reference/README.md) 포함. 구현·성능 인수는 별도 |
| 타일 조회의 실측 비용·인덱스·캐시 판단 | [별 지도 타일 조회 비용 측정](sky-tile-performance.md) | 137번 측정 기록. 서버 조회에 한하며 클라이언트 인수는 215번 |
| 요청된 확정 후보의 NASA PS 식별·정규화·저장 경계 | [NASA 행성 정보 저장 계약](nasa-planet-info-266.md) | 266 내부 구현·격리 검증. 268의 현재 조회·요청·화면 연결은 별도 |
| 검증된 NASA 자료의 한국어 설명·저장·별 단위 전달 경계 | [NASA 한국어 설명·전달 계약](nasa-planet-explanation-267.md) | 267 v4 표적 회귀와 가상 후보 4개의 NASA·GMS 인증 생성형 GET·V25·V26 저장 통과. 첫 14,554ms·캐시 82ms는 변경 전 격리 1회 표본, 실제 회원·운영·268 화면 인수 별도 |
| NASA 설명의 조회·한 후보 요청·기존 별 상세 패널 연결 | [NASA 설명 요청·재사용 계약](nasa-planet-request-268.md) | 268 백엔드 표적 36건·269 V27 포함 통합 73/73, 프론트 단위 452건/빌드·Chrome 상세 fixture 6건 통과. 실제 회원·Gold·배포 인수는 별도, 270·271의 결과 화면용 NASA 전체 목록과 구분 |

기능 정책은 [요구사항](../requirements/README.md), DB 구조는 [아키텍처](../architecture/README.md), 전송 형식은 [API](../api/README.md)를 먼저 확인한다. 이 디렉터리의 초안만으로 API나 구현 완료를 확정하지 않는다.

실제 구현을 시작할 때는 `apps/frontend/README.md` 또는 `apps/backend/README.md`와 현재 코드·테스트를 함께 확인한다.

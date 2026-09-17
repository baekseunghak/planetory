# 203 검증용 고정 계약 자료

출처: [문서 MR !41의 7f67c568](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/tree/7f67c5683f79e541da556ef4e6aed966ff317c11/docs/development/sky-reference). SRS v1.3·탐사 API Draft 0.4, 사용자 채택·팀원 리뷰 대기 상태다.

- `reference.mjs`, `vectors.json`, `contracts.json`은 원본을 그대로 고정한다. 원본과 별도로 규칙을 수정하지 않는다.
- 서버 역할의 Vite fixture와 테스트만 배치 예제를 사용한다. 운영 src가 이 디렉터리를 import하지 않는다.
- `reference.d.mts`는 검증에 필요한 함수의 타입 선언이다.
- 203은 메타/페이지/버전/좌표 투영 및 상세 최소 DTO만 검증한다. 공통 19개 사례 중 실제 서버의 매칭/권한, 204 시각 비교, 206 화면 흐름까지 검증했다고 주장하지 않는다.

원본 문서 승인 뒤 계약 변경이 있으면 출처 커밋과 비교 자료를 함께 갱신한다. 세 파일의 해시는 203 검증 기록에 남긴다.

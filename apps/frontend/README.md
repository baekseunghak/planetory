# Frontend

React, TypeScript와 Vite 기반 웹 화면을 둘 위치다.

EC2-A/B에 같은 이미지를 독립 배포하며, HDFS를 직접 조회하지 않고 Backend API만 사용한다. 이 경로의 운영 애플리케이션 코드는 아직 구현되지 않았다.

백지웅 담당의 화면 요소·조작·상태 전환·API 요구사항·검증 기준은 [분석 프론트엔드 상세 명세](../../docs/development/analysis-frontend-spec.md)를 따른다. 요구사항 v1.0을 구체화한 검토용 초안이며, 화면 배치와 미합의 API 형식을 확정한 문서는 아니다.

문서·계약 정리는 [S15P21C206-49](https://ssafy.atlassian.net/browse/S15P21C206-49), `experiments/analysis-ui`·`experiments/analysis-lab`의 독립 실험은 [S15P21C206-50](https://ssafy.atlassian.net/browse/S15P21C206-50)에서 관리한다. 보존된 API JSON은 v0.12 실험용이며 최신 구현에는 [v1.0 전환표](../../docs/api/analysis/v1-migration.md)를 적용한다.

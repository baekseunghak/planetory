# GitLab CI/CD 구성

최상위 `.gitlab-ci.yml`에서 불러올 배포 단위별 설정을 둘 위치다.

`common.yml`은 Compose 검사, 이미지 빌드와 SSH 배포 공통 작업을 제공한다. `apps/`와 `distributed-system/`의 파일은 프로그램별 build·deploy job을 정의한다.

소스 manifest가 없는 프로그램은 빌드하지 않는다. 배포는 기준 브랜치에서 노드별 수동 승인으로 실행하며 필요한 변수는 [CI/CD 문서](../../docs/operations/cicd.md)를 따른다.

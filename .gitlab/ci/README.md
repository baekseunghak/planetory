# GitLab CI/CD 구성

최상위 `.gitlab-ci.yml`에서 불러올 배포 단위별 설정을 둘 위치다.

`common.yml`은 Compose·배포 회귀 검사, 이미지 빌드와 SSH 배포 공통 작업을 제공한다. `apps/`는 ARM64 서비스 앱의 build·donh-vnic 수동 deploy job을, `distributed-system/`은 기존 amd64 Publisher 이미지 빌드만 정의한다. GCP 노드 배포 job은 없다([distributed-system/README.md](distributed-system/README.md)).

소스 manifest가 없는 프로그램은 빌드하지 않는다. 배포는 기준 브랜치에서 수동 승인으로 실행하며 필요한 변수와 운영 Compose 보존 방식은 [CI/CD 문서](../../docs/operations/cicd.md)를 따른다.

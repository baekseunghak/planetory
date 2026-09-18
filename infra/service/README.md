# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A 수동 배포 job이 이 Compose를 사용해 선택한 서비스만 갱신한다. EC2-B는 사용하지 않으므로 `ec2-b/`에는 설정을 두지 않는다(시스템 아키텍처 8장 D4). 노드별 차이가 필요하면 `ec2-a/`에 둔다.

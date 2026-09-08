# 실행 환경

프로그램을 어느 서버에서 어떻게 실행할지 정의한다.

- `service/`: EC2-A/B 배포 설정
- `distributed-system/`: GCP Node 1~6의 Hadoop/YARN 설정과 작업 컨테이너 실행
- `provisioning/gcp/`: GCP VM·디스크·VPC·피어링 생성 및 확인

실제 IP, 비밀번호, 토큰과 개인 키는 저장하지 않는다.

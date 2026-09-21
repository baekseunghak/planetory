# 실행 환경

프로그램을 어느 서버에서 어떻게 실행할지 정의한다.

- `service/`: EC2-A 배포 설정. 서비스 인스턴스는 EC2-A 1개이며 EC2-B 배포 job은 사용하지 않는다(정리는 `S15P21C206-84`·`S15P21C206-93`). `service/ec2-b/`에는 서비스 설정이 아니라 CI·외부 관찰 등 사용자 요청 경로 밖 역할의 설정만 둔다
- `distributed-system/`: GCP Node 1~6의 Hadoop/YARN 설정과 작업 컨테이너 실행
- `provisioning/gcp/`: GCP VM·디스크·VPC·피어링 생성 및 확인

실제 IP, 비밀번호, 토큰과 개인 키는 저장하지 않는다.

# 2026년 10월 1주차 주요 변경

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-02 | ec2-a 초기화 전 긴급 보존과 donh-vnic 격리 DB 복원 검증 | 미지정 | donh-vnic, ARM64, pg_dumpall, GRANTED BY, bootstrap superuser | 격리 DB 검증 완료·앱 전환 미실행 | [기록](2026-10-02.md) |
| 2026-10-02 | donh-vnic 배포 설정 준비와 8080 충돌 회피 | 미지정 | compose.json, ARM64, 18080, bind, 복원 볼륨 | 정적 검증 완료·앱 기동 미실행 | [기록](2026-10-02.md) |
| 2026-10-02 | donh-vnic ARM64 앱·세션·문서 내부 기동 검증 | 미지정 | ARM64, JAR, renderer-enabled, Worker 20 tests, 단일 Tunnel, Publisher | 9개 내부 기동·검증 완료·공개 전환 미실행 | [기록](2026-10-02.md) |
| 2026-10-02 | donh-vnic 최신 데이터·Cloudflare·Publisher 최종 전환 | 미지정 | final DB, Redis SAVE, Cloudflare, hostname 5개, Publisher, Node 1 ACL | 공개·데이터·Publisher 검증 완료·CI 설정 전환 미실행 | [기록](2026-10-02.md) |
| 2026-10-02 | ec2-b 회수 전 보존과 donh-orc2 CI·Registry 이관 | 미지정 | donh-orc2, rsync, 전체 SHA-256, Runner 2146, QEMU, job 665128, Publisher digest, DEPLOY_USER | 전체 보존·이관·실제 CI 검증 완료 | [기록](2026-10-02.md) |
| 2026-10-02 | 서비스 앱 CI ARM64·donh-vnic 배포 대응 | 사용자 긴급 예외 | arm64-docker, SHA-arm64, Compose --wait, external volume, SERVICE_DEPLOY_HOST | 코드·운영 기반·빌드·기동·롤백 검증 완료·Git 게시 승인 | [기록](2026-10-02.md) |

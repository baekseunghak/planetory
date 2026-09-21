# 2026년 9월 4주차 변경 이력

기간: 2026-09-21 ~ 2026-09-27

| 날짜 | 주요 변경 | Jira | 검색 키워드 | 상태 | 일별 기록 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-21 | 114 최신 develop 통합·Gold QA 상태 정정 | S15P21C206-114 | 2c1c857, 119 보존, NULL, e8f62ea | 문서·검증 완료, MR 승인 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | CI 레지스트리 자체 호스팅·amd64 빌드 노드 분리 | S15P21C206-226 | registry, tailscale cert, REGISTRY_IMAGE_PREFIX, amd64-docker, privileged, extra_hosts, binfmt 제거, D4 충돌 | 레지스트리 검증 완료, Runner 등록 대기 | [기록](2026-09-21.md) |
| 2026-09-21 | D4 범위 한정과 외부 관찰 EC2-B 이관 | S15P21C206-226 | D4, EC2-B, CI 빌드 노드, 외부 관찰 이관, 인계 100, 같은 AZ 한계, ap-northeast-2a | 채택, 관찰 구현 미완 | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 노드 Docker 준비와 이미지 위생 도구 | S15P21C206-226 | install-docker-host.sh, docker-compose-v2, image-secret-scan, registry-prune, digest 공유 삭제, 가비지 수집 | 검증 완료(실측) | [기록](2026-09-21.md) |
| 2026-09-21 | 배포 접속을 SSH 키 없이 tailnet 신원으로 전환 | S15P21C206-226 | Tailscale SSH, 22번 가로챔, ACL ssh 규칙, deploy 계정, sudo 없음, DEPLOY_SSH_KEY 폐기 | 검증 완료(실측) | [기록](2026-09-21.md) |

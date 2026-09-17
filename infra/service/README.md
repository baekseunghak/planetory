# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A/B 수동 배포 job은 같은 Compose를 사용해 선택한 서비스만 갱신한다. 노드별 차이가 생길 때만 `ec2-a/`, `ec2-b/`에 추가 설정을 둔다.

## Cloudflare Tunnel 진입 (S15P21C206-84, 부분)

`cloudflared`는 외부 인바운드 포트를 열지 않고 edge에서만 트래픽을 받는다. 서비스 컨테이너는 같은 `service` 네트워크에 있으므로 Tunnel의 public hostname은 `http://frontend:8080`을 origin으로 지정한다.

도메인은 `planetory.space`이며 Cloudflare zone에 등록되어 있다. Tunnel 이름은 `planetory-service`다.

1. Cloudflare Zero Trust에서 Tunnel을 만들고 connector 토큰을 발급한다.
2. 서버의 `$DEPLOY_PATH/.env`에 `CLOUDFLARE_TUNNEL_TOKEN=<토큰>`을 추가한다. 토큰은 Git·이미지·명령줄 인자에 두지 않는다.
3. `docker compose up -d cloudflared`로 기동한다. GitLab 배포 job은 `frontend`·`backend`만 갱신하므로 `cloudflared`를 내리지 않는다.
4. Tunnel의 public hostname → service `http://frontend:8080`을 연결하고 도메인으로 접속을 확인한다.

connector는 EC2-A에만 둔다. 같은 Tunnel에 커넥터를 여럿 붙여도 Cloudflare는 가장 가까운 하나로만 보내고 분산하지 않으므로(2026-09-16 실측 10/10), 프론트가 없는 EC2-B가 선택되면 전면 장애가 된다.

2026-09-17 확인: EC2-A에서 Cloudflare edge(`icn06`)로 QUIC egress가 열려 있고, 보안그룹 인바운드 개방 없이 `planetory.space` 응답까지 확인했다.

Backend가 아직 배포되지 않은 단계에서도 frontend는 기동한다. `apps/frontend/nginx.conf`가 backend를 요청 시점에 해석하고, 세션 조회(`/api/v1/me`)가 502·504면 401로 낮춰 SPA가 로그인 화면을 보여준다. 다른 `/api/*`는 502를 그대로 전달한다.

미완료: Redis runtime, 메모리 상한·eviction 정책, health/readiness, 남용 제어 위치, connector 지속 처리량 실측은 이 변경에 포함되지 않았다.

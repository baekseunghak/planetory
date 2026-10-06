# 2. 외부 서비스 정보

> 기준: `develop` `e2c7c19b`(2026-09-28). 비밀 값(키·토큰·비밀번호)은 적지 않는다. 값을 넣는 위치만 적는다.

## 요약

| # | 서비스 | 용도 | 가입·발급 | 설정 위치 | 없으면 |
| --- | --- | --- | --- | --- | --- |
| 1 | SSAFY 로그인(OAuth 2.0) | 회원 로그인 | SSAFY 개발자센터 앱 등록 | `.env` `SSAFY_*` | SSAFY 로그인 불가 |
| 2 | Google OAuth 2.0 / OIDC | 회원 로그인 | Google Cloud Console | `.env` `GOOGLE_*` | Google 로그인 불가 |
| 3 | SSAFY GMS(OpenAI 호환) | 행성 한국어 AI 설명 | SSAFY GMS 키 발급 | `.env` `GMS_KEY`, `NASA_EXPLANATION_*` | 설명만 비활성, 나머지 정상 |
| 4 | NASA Exoplanet Archive TAP | 확정 행성 정보 조회, 배치 외부 원천 | 불필요(공개 API) | `NASA_PLANET_INFO_*` | NASA 자료 카드만 실패 |
| 5 | MAST(STScI) | TESS 광도곡선 원천 | 불필요(공개) | 배치 코드 고정 | 원천 수집 불가 |
| 6 | ExoFOP-TESS | TOI 목록(배치 외부 원천) | 불필요(공개) | 배치 코드 고정 | 해당 원천만 누락 |
| 7 | Cloudflare | 도메인 DNS·TLS, Tunnel 진입 | Cloudflare 계정, Zero Trust | `.env` `CLOUDFLARE_TUNNEL_TOKEN` | 외부 공개 불가 |
| 8 | Tailscale | 서버 접속, CI 배포 SSH, 레지스트리 TLS, Publisher→DB 경로 | Tailscale tailnet | 각 서버 `tailscale up --ssh` | 배포·적재 경로 불가 |
| 9 | AWS EC2 | 서비스·CI 서버 2대 | SSAFY 제공 | — | — |
| 10 | Google Cloud Compute Engine | 분산 처리 VM 6대 | 팀원 GCP 계정 6개 | `infra/provisioning/gcp/` | 배치 처리 불가 |
| 11 | GitLab (lab.ssafy.com) | 저장소, CI/CD | SSAFY 제공 | GitLab CI 변수 | 자동 빌드·배포 불가 |
| 12 | Mattermost Incoming Webhook | 서버 감시 알림 | Mattermost 통합 기능 | EC2-B `/etc/planetory/mattermost-webhook` | 알림만 누락 |
| 13 | Docker Hub | 공개 베이스 이미지 | 불필요 | Dockerfile·Compose | 이미지 빌드 불가 |

## 1. SSAFY 로그인

| 항목 | 값 |
| --- | --- |
| 가입 | SSAFY 개발자센터에서 앱 등록 → Client ID·Secret 발급 |
| Redirect URI 등록 | 운영 `https://app.planetory.space/login/oauth2/code/ssafy`, 로컬 `http://localhost:3000/login/oauth2/code/ssafy`(포팅 매뉴얼 4장) 또는 `http://localhost:8080/login/oauth2/code/ssafy`(백엔드 직접 실행) |
| 제공 정보 항목 | **최소 1개는 선택한다.** 하나도 선택하지 않으면 `sso-check`가 "예상치 못한 에러(ERROR ID)" 화면을 띄운다. 서비스는 `userId`만 쓰고 이메일·이름은 저장하지 않는다 |
| 인가 URL | `https://project.ssafy.com/oauth/sso-check` |
| 토큰 URL | `https://project.ssafy.com/ssafy/oauth2/token` |
| 사용자 정보 URL | `https://project.ssafy.com/ssafy/resources/userInfo` |
| 클라이언트 인증 | `client_secret_post`, scope 없음, 회원 식별 `userId` |
| 환경 변수 | `SSAFY_CLIENT_ID`, `SSAFY_CLIENT_SECRET`, `SSAFY_REDIRECT_URI`, `OAUTH_PROFILES`에 `oauth-ssafy` 포함 |
| 코드 | `apps/backend/src/main/resources/application-oauth-ssafy.properties` |

## 2. Google OAuth

| 항목 | 값 |
| --- | --- |
| 가입 | Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID(**웹 애플리케이션**). 팀 프로젝트 이름 `planetory-oauth` |
| 승인된 리디렉션 URI | `https://app.planetory.space/login/oauth2/code/google`, 로컬 `http://localhost:3000/login/oauth2/code/google` 또는 `http://localhost:8080/login/oauth2/code/google` |
| scope | `openid`, `profile` |
| 환경 변수 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `OAUTH_PROFILES`에 `oauth-google` 포함 |
| 주의 | 다운로드한 JSON은 `web.client_id`·`web.client_secret`만 환경 변수로 옮기고 저장소에 두지 않는다. `installed`(데스크톱) 유형은 쓸 수 없다 |
| 코드 | `apps/backend/src/main/resources/application-oauth-google.properties` |

## 3. SSAFY GMS (행성 AI 설명)

| 항목 | 값 |
| --- | --- |
| 용도 | 확정 행성의 NASA 수치를 한국어 설명으로 만든다(결과 화면 「NASA 행성 자료 보기」) |
| 엔드포인트 | `https://gms.ssafy.io/gmsapi/api.openai.com/v1` (Spring AI OpenAI 클라이언트, 재시도 0) |
| 모델 | `gpt-5.4-mini`, 출력 최대 320토큰, 타임아웃 8초 |
| 발급 | SSAFY GMS에서 키 발급 → 서버 `.env` `GMS_KEY` |
| 켜기 | `NASA_EXPLANATION_ENABLED=true`, `NASA_EXPLANATION_CHAT_MODEL=openai` |
| 비용 통제 | `NASA_EXPLANATION_DAILY_PER_MEMBER`, `NASA_EXPLANATION_DAILY_GLOBAL`(기본 0 = 호출 안 함). 운영은 회원별 20·전체 300회/일로 두고 GMS 대시보드 크레딧을 매일 확인한다 |
| 끄기 | `NASA_EXPLANATION_ENABLED=false` 후 백엔드 재배포. 이미 만든 설명은 보존되고 새 호출만 막힌다 |

## 4. NASA Exoplanet Archive

| 항목 | 값 |
| --- | --- |
| 용도 | 백엔드: 요청된 확정 후보의 행성 기본 해(주기·반지름·질량·발견 정보) 조회. 배치: `nea_toi`, `nea_pscomppars` 외부 원천 |
| 엔드포인트 | `https://exoplanetarchive.ipac.caltech.edu/TAP/sync` (키 없음) |
| 백엔드 상한 | 응답 256KiB, 최대 64행(코드 고정). 캐시 TTL `NASA_PLANET_INFO_READY_TTL=7d`, 빈 결과 `1d`, 동시 요청 2 |
| 끄기 | `NASA_PLANET_INFO_ENABLED=false` |
| 코드 | `apps/backend/src/main/java/com/planetory/backend/domain/exploration/service/NasaTapClient.java`, `distributed-system/spark/tess_external_ctl.py` |

## 5. MAST (Mikulski Archive for Space Telescopes, STScI)

| 항목 | 값 |
| --- | --- |
| 용도 | TESS 섹터별 광도곡선(FITS) 원천 수집, TCE 목록(`mast_tce_s1_s13`) |
| 주소 | `https://archive.stsci.edu/tess/bulk_downloads/…`, `https://mast.stsci.edu` (키 없음) |
| 사용처 | GCP Airflow 섹터 탐색 DAG, 수집기(`distributed-system/ingestion`), 시연용 실제 별 10개 준비 도구(`tools/real-sample`) |
| 주의 | 대용량 다운로드다. 원본 데이터는 Git에 넣지 않고 HDFS에만 둔다 |

## 6. ExoFOP-TESS

| 항목 | 값 |
| --- | --- |
| 용도 | TOI(TESS Objects of Interest) 목록 CSV. 후보 판정의 외부 참고값 |
| 주소 | `https://exofop.ipac.caltech.edu/tess/download_toi.php?sort=toi&output=csv` (키 없음) |
| 사용처 | `distributed-system/spark/tess_external_ctl.py` |

## 7. Cloudflare

| 항목 | 값 |
| --- | --- |
| 도메인 | `planetory.space` (Cloudflare zone, 프록시 사용) |
| Tunnel | Zero Trust → Networks → Tunnels에서 `planetory-service` 생성 → connector 토큰 발급 |
| 토큰 위치 | EC2-A `/home/deploy/planetory/.env`의 `CLOUDFLARE_TUNNEL_TOKEN`. Git·이미지·명령줄에 두지 않는다 |
| 기동 | `docker compose up -d cloudflared` (배포 job은 cloudflared를 건드리지 않는다) |
| Public hostname | `app.planetory.space`·`planetory.space` → `http://frontend:8080`, `erd.` → `http://erd:80`, `api-docs.` → `http://api-docs:80`, `wireframe.` → `http://wireframe:80` |
| 주의 | connector는 EC2-A 한 곳에만 둔다. 같은 Tunnel에 여러 connector를 붙여도 분산되지 않고 가장 가까운 하나로만 간다(2026-09-16 실측) |

## 8. Tailscale

| 항목 | 값 |
| --- | --- |
| 용도 | 팀원·CI의 서버 SSH(`tailscale up --ssh`), 자체 레지스트리 HTTPS 인증서(`tailscale cert`), GCP Node 1 Publisher → EC2-A DB·백엔드 경로(`tailscale serve --tcp 5432/8080`) |
| 가입 | 팀 tailnet 관리자가 팀원 계정을 초대하고 장비를 승인한다 |
| 서버 태그 | `ec2-a`=`tag:service`, `node-1`=`tag:hadoop`+`tag:publisher`, `node-2~6`=`tag:hadoop`, 레지스트리 노드=`tag:registry` |
| 핵심 ACL | `tag:publisher → tag:service:5432,8080`, 멤버·Runner → `tag:service:22`, `tag:service → tag:registry:5000`, `ssh` 규칙에 CI `deploy` 계정 허용 |
| 접속 | `tailscale ssh ubuntu@ec2-a`(사람), `tailscale ssh deploy@ec2-a`(배포). 실패 시 개인 PC `~/.ssh/config` 별칭 |
| 주의 | GitLab CI 변수 `EC2_A_HOST`에는 MagicDNS 이름 대신 Tailscale IP를 넣는다(컨테이너 안에서 MagicDNS가 풀리지 않음). 정책의 정본은 Tailscale Admin Console |

## 9. AWS EC2 (SSAFY 제공)

| 서버 | 사양 | 역할 |
| --- | --- | --- |
| EC2-A | 4 vCPU·16GB·320GB, Ubuntu 24.04.4 LTS | 서비스 노드(포팅 매뉴얼 1장) |
| EC2-B | 4 vCPU·16GB·320GB | GitLab Runner `planetory-docker-runner`(동시 3), 레지스트리 `registry:3`, Mattermost 감시 알림, 레지스트리 매일 정리 |

서비스 공개는 Cloudflare Tunnel, 서버 간 통신은 Tailscale을 쓰므로 서비스용 인바운드 포트를 열지 않는다.

## 10. Google Cloud Compute Engine

| 항목 | 값 |
| --- | --- |
| 구성 | 팀원 계정 6개의 프로젝트에 VM 1대씩, 존 `asia-east1-b`, 프로젝트 간 full-mesh VPC Peering |
| 사양 | 각 6 vCPU·36GiB. Node 1 제어 디스크 200GiB, Node 2~6 HDFS 데이터 각 2,000GiB |
| 생성 | `infra/provisioning/gcp/scripts/`(CI에서 실행하지 않음) |
| 주의 | 결제·할당량(지역 `pd-standard` 2,048GiB 포함)을 생성 전에 확인한다. 쓰지 않는 기간에는 `docs/operations/gcp-node-runbook.md`의 비용 점검·종료 절차를 따른다 |

## 11. GitLab (lab.ssafy.com)

| 항목 | 값 |
| --- | --- |
| 저장소 | `https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206` |
| 기본 브랜치 | `develop` (`main`·`develop` 직접 push 금지, MR 병합) |
| Runner | EC2-B 자체 호스팅 1대, Docker executor, 태그 `amd64-docker`, `privileged`(dind), 레지스트리 이름 `extra_hosts` |
| 레지스트리 | `lab.ssafy.com`의 Container Registry가 비활성이라 EC2-B에 `registry:3`를 자체 운영(tailnet 내부 전용, 인증 없음) |
| CI 변수 | `REGISTRY_IMAGE_PREFIX`, `DEPLOY_USER`, `EC2_A_HOST`, `EC2_A_DEPLOY_PATH` (Protected·Masked) |

## 12. Mattermost

| 항목 | 값 |
| --- | --- |
| 용도 | EC2-B의 레지스트리·가동 감시 스크립트(`registry-watch.sh`, `uptime-watch.sh`) 알림 |
| 발급 | Mattermost 채널 → 통합 → Incoming Webhook 생성 |
| 위치 | EC2-B `/etc/planetory/mattermost-webhook` 파일(Git에 두지 않음) |
| 코드 | `infra/service/ec2-b/notify.sh` |

## 13. Docker Hub 공개 이미지

`eclipse-temurin:21-jdk-alpine`, `eclipse-temurin:21-jre-alpine`, `node:22-alpine`, `nginxinc/nginx-unprivileged:1.27-alpine`, `python:3.12-slim`, `postgres:18.6-alpine`, `redis:7.4-alpine`, `nginx:1.29-alpine`, `cloudflare/cloudflared`, `registry:3`, `apache/spark:3.5.5-python3`, `apache/airflow:2.10.5-python3.12`. 가입 없이 받는다.

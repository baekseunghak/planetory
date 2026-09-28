# 1. 포팅 매뉴얼 — 빌드·배포

> 기준: `develop` `e2c7c19b`(2026-09-28). 운영 서버 값은 2026-09-28 EC2-A에서 읽기 전용으로 확인했다.<br>
> 이 문서는 제출용 요약본이다. 절차가 바뀌면 10장의 담당 문서가 정본이다.

## 목차

1. [서비스와 구성](#1-서비스와-구성)
2. [사용 제품과 버전](#2-사용-제품과-버전)
3. [컨테이너·포트 구성](#3-컨테이너포트-구성)
4. [소스 클론 후 빌드·실행](#4-소스-클론-후-빌드실행)
5. [빌드·실행 환경 변수](#5-빌드실행-환경-변수)
6. [운영 배포(EC2-A)](#6-운영-배포ec2-a)
7. [배포 시 특이사항](#7-배포-시-특이사항)
8. [DB 접속 정보·계정·프로퍼티 파일 목록](#8-db-접속-정보계정프로퍼티-파일-목록)
9. [분산 처리 영역(GCP) 참고](#9-분산-처리-영역gcp-참고)
10. [담당 정본 문서](#10-담당-정본-문서)

## 1. 서비스와 구성

Planetory는 NASA TESS 관측 광도곡선을 사용자가 직접 분석해 외계행성 신호를 찾는 웹 서비스다.

- 운영 주소: `https://app.planetory.space` (`https://planetory.space`도 같은 화면)
- 저장소: `https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206.git`

```text
사용자 브라우저
  → Cloudflare DNS·TLS → Cloudflare Tunnel (외부 인바운드 포트 0개)
  → EC2-A  cloudflared → frontend(Nginx, 8080)
                           ├─ 정적 파일(React SPA)
                           └─ /api/, /oauth2/, /login/oauth2/ → backend(Spring Boot, 8080)
                                                                 ├─ service-db (PostgreSQL 18.6)
                                                                 ├─ session-redis (로그인 세션)
                                                                 ├─ cache-redis (Gold·계산 캐시)
                                                                 └─ derived-compute (Python 잔차·주기도 Worker, 8090)

배치(GCP Node 1~6): 외부 원천 → Airflow → YARN/Spark → HDFS → Gold 후보
공개: GCP Node 1 Publisher → (Tailscale) → EC2-A service-db 적재·current 전환 → backend 알림
```

| 서버 | 역할 |
| --- | --- |
| EC2-A | 서비스 노드 1대. 위 컨테이너 전부와 보조 문서 사이트(ERD·API 문서·와이어프레임) |
| EC2-B | 사용자 요청 경로 밖. GitLab Runner(이미지 빌드), 자체 이미지 레지스트리, 감시 알림 |
| GCP Node 1~6 | Hadoop HDFS·YARN·Spark·Airflow·Publisher. 9장 참고 |

## 2. 사용 제품과 버전

### 2.1 서비스(EC2-A)

| 구분 | 제품 | 버전 | 설정 요점 |
| --- | --- | --- | --- |
| OS | Ubuntu | 24.04.4 LTS, x86_64 | AWS EC2 4 vCPU·16GB·320GB |
| 컨테이너 | Docker Engine / Compose | 29.8.1 / v5.5.1 | 모든 서비스가 컨테이너. 호스트 Nginx 없음 |
| 이미지 플랫폼 | `linux/amd64` | — | 빌드·실행 모두 amd64 고정 |
| 진입 | Cloudflare Tunnel `cloudflared` | `cloudflare/cloudflared:latest` | 인바운드 없이 edge로 나가는 연결만 사용 |
| 웹 서버 | Nginx (unprivileged) | 1.27 (`nginxinc/nginx-unprivileged:1.27-alpine`) | `listen 8080`, SPA 폴백, `/api/`·OAuth 경로를 `backend:8080`으로 프록시 |
| JVM | Eclipse Temurin | 21 (빌드 `21-jdk-alpine`, 실행 `21-jre-alpine`) | Java toolchain 21, 이미지 실행 계정 `planetory` |
| WAS | Spring Boot 내장 Tomcat | Boot 4.1.1 / Tomcat 11.0.24 | `SPRING_PROFILES_ACTIVE=prod`, 포트 8080 |
| 빌드 도구 | Gradle Wrapper | 9.7.1 | 별도 설치 불필요 |
| 백엔드 주요 라이브러리 | Spring Security OAuth2 Client, Spring Session Data Redis, Spring Data JPA+JdbcClient, Flyway, PostgreSQL JDBC, springdoc-openapi, Spring AI(OpenAI 호환) | Hibernate 7.4.5, Flyway 12.4.0, JDBC 42.7.13, springdoc 3.1.1, Spring AI 2.0.1 | 스키마는 Flyway만 변경(`ddl-auto=validate`) |
| DB | PostgreSQL | 18.6 (`postgres:18.6-alpine`) | 데이터 마운트 `/var/lib/postgresql`(18 규약) |
| 세션·캐시 | Redis | 7.4 (`redis:7.4-alpine`) × 2 | 세션 64mb `noeviction`+RDB, 캐시 128mb `volatile-lru`·저장 끔 |
| 프론트엔드 | Node.js / npm | Node 22 (`node:22-alpine`, `engines >=22.12.0`) | `npm ci` 후 `npm run build` |
| 프론트 주요 라이브러리 | React, React Router, Vite, TypeScript, three.js | 19.2.8 / 7.18.3 / 8.2.2 / 7.0.2 / 0.186.1 | 운영 번들은 `VITE_CINEMA=true`(5.1) |
| 계산 Worker | Python | 3.12 (`python:3.12-slim`) | numpy·scipy·astropy 7.2.2를 `requirements.txt` 해시로 고정, `libs/astro-kernel` 설치 |
| CI/CD | GitLab CI (lab.ssafy.com) + GitLab Runner(Docker executor) + `registry:3` | — | Runner·레지스트리는 EC2-B |

라이브러리 버전은 빌드한 백엔드 이미지의 `app.jar` 안에서 확인한 값이다.

### 2.2 개발 PC

| 항목 | 버전 | 비고 |
| --- | --- | --- |
| IntelliJ IDEA | 2026.2.1 | 백엔드. Gradle JVM·Project SDK 21, Annotation Processing 켬(Lombok) |
| Visual Studio Code | 1.138.0 | 프론트엔드·문서. 백엔드는 Extension Pack for Java |
| Docker Desktop | Engine 29.6.2 / Compose v5.3.1 | Linux 엔진. Compose는 `include`를 지원하는 v2.20 이상 필요 |
| JDK | Temurin 21.0.11 | Gradle toolchain이 없으면 자동 다운로드. Wrapper 실행에는 Java 17 이상 |
| Node.js | 22.12 이상 | |

IDE 버전은 작성자 PC 기준이며 팀원마다 다를 수 있다. 빌드는 IDE와 무관하게 Gradle Wrapper·npm·Docker로 재현된다.

## 3. 컨테이너·포트 구성

`infra/service/compose.yaml` 기준이다. 호스트 포트는 모두 `127.0.0.1`에만 열고 외부 인바운드는 0개다.

| 서비스 | 이미지 | 컨테이너 포트 | 호스트 바인드 | 역할 |
| --- | --- | --- | --- | --- |
| `frontend` | `${FRONTEND_IMAGE}` | 8080 | `127.0.0.1:${FRONTEND_PORT:-3000}` | Nginx 정적 파일·리버스 프록시 |
| `backend` | `${BACKEND_IMAGE}` | 8080 | `127.0.0.1:${BACKEND_PORT:-8080}` | REST API, OAuth, Flyway |
| `service-db` | `postgres:18.6-alpine` | 5432 | `127.0.0.1:5432` | 서비스 DB. 호스트 포트는 GCP Publisher 전용(Tailscale 경유) |
| `session-redis` | `redis:7.4-alpine` | 6379 | 없음 | 로그인 세션 |
| `cache-redis` | `redis:7.4-alpine` | 6379 | 없음 | Gold 곡선·계산 캐시 |
| `derived-compute` | `${DERIVED_COMPUTE_IMAGE}` | 8090 | 없음(열지 말 것) | 잔차·주기도 계산 |
| `cloudflared` | `cloudflare/cloudflared` | — | 없음 | Tunnel connector |
| `erd`·`api-docs`·`wireframe` | `nginx:1.29-alpine` | 80 | 없음 | 보조 문서 사이트(6.4) |

| 공개 호스트 (Cloudflare Tunnel) | 연결 대상 |
| --- | --- |
| `app.planetory.space`, `planetory.space` | `http://frontend:8080` |
| `erd.planetory.space` | `http://erd:80` |
| `api-docs.planetory.space` | `http://api-docs:80` |
| `wireframe.planetory.space` | `http://wireframe:80` |

## 4. 소스 클론 후 빌드·실행

운영과 같은 방식(이미지 빌드 → `infra/service/compose.yaml` 실행)으로 한 대의 PC나 서버에서 서비스 전체를 띄우는 절차다. 명령은 저장소 루트 기준이다.

2026-09-28 Windows 11·Docker Desktop(Engine 29.6.2)에서 이 절차로 이미지 3개 빌드(백엔드 Gradle 2분 13초), 기동, 4.5 확인 명령, 4.6 SQL 실행까지 통과했다. OAuth 로그인은 자격 증명이 필요해 이 검증에 넣지 않았다.

### 4.1 준비물

- Git, Docker(Linux 엔진, Compose v2.20 이상), 인터넷 연결(베이스 이미지·의존성 다운로드)
- 로그인까지 확인하려면 OAuth 자격 증명([외부 서비스](2-external-services.md) 1·2절)

### 4.2 클론과 이미지 빌드

CI의 `build:*` job과 같은 인자다. 프론트엔드는 두 빌드 인자를 반드시 준다(5.1).

```powershell
git clone https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206.git
cd S15P21C206

docker build --platform linux/amd64 -f apps/backend/Dockerfile -t planetory/backend:local .
docker build --platform linux/amd64 -f apps/frontend/Dockerfile -t planetory/frontend:local `
  --build-arg VITE_SKY_RENDERER_ENABLED=true --build-arg VITE_CINEMA=true .
docker build --platform linux/amd64 -f apps/derived-compute/Dockerfile -t planetory/derived-compute:local .
```

| 이미지 | Dockerfile 단계 | 결과물 |
| --- | --- | --- |
| backend | `eclipse-temurin:21-jdk-alpine`에서 `./gradlew bootJar` → `21-jre-alpine`에 `app.jar` | `java -jar /app/app.jar`, 프로필 `prod` |
| frontend | `node:22-alpine`에서 `npm ci`·`npm run build` → Nginx에 `dist/` | `VITE_SKY_RENDERER_ENABLED=true`일 때 헬스 표식 `/health/renderer-enabled` 생성 |
| derived-compute | `python:3.12-slim`에 `pip install --require-hashes` | `python -m derived_compute.server`, HEALTHCHECK `/healthz` |

### 4.3 `.env` 작성

`infra/service/.env`를 만든다. Git에 포함되지 않는 파일이며 값은 각자 생성한다. 전체 목록은 5.2절이다.

```dotenv
FRONTEND_IMAGE=planetory/frontend:local
BACKEND_IMAGE=planetory/backend:local
DERIVED_COMPUTE_IMAGE=planetory/derived-compute:local

# DB 소유자(Flyway)와 앱 런타임 계정 비밀번호. 서로 다른 값으로 둔다.
POSTGRES_PASSWORD=<소유자 비밀번호>
DATABASE_PASSWORD=<런타임 비밀번호>

# Gold 파일 경로(읽기 전용 마운트). 빈 폴더여도 된다. Windows 예: C:/planetory/gold
GOLD_PATH=<빈 폴더 경로>

# 잔차 계산 Worker 연결
DERIVED_COMPUTE_URL=http://derived-compute:8090

# 로그인 사용 시 (외부 서비스 문서 1·2절)
OAUTH_PROFILES=oauth-google,oauth-ssafy
AUTH_SUCCESS_URL=/sky
GOOGLE_CLIENT_ID=<발급값>
GOOGLE_CLIENT_SECRET=<발급값>
GOOGLE_REDIRECT_URI=http://localhost:3000/login/oauth2/code/google
SSAFY_CLIENT_ID=<발급값>
SSAFY_CLIENT_SECRET=<발급값>
SSAFY_REDIRECT_URI=http://localhost:3000/login/oauth2/code/ssafy
```

### 4.4 기동

`deploy.sh`와 CI는 `--no-deps`로 한 서비스씩 바꾸므로 DB·Redis는 처음 한 번 직접 띄운다.

```powershell
cd infra/service
docker compose up -d service-db session-redis cache-redis
docker compose up -d derived-compute backend frontend
docker compose ps
```

`backend`는 첫 기동 때 Flyway로 V1~V30과 `R__table_comments`(31개)를 적용한다. 로그에 `Successfully applied 31 migrations`와 `Started PlanetoryApplication`이 남는다.

호스트 포트가 겹치면 기동이 실패한다. `frontend`·`backend`는 `.env`의 `FRONTEND_PORT`·`BACKEND_PORT`로 바꾸고, `service-db`의 `127.0.0.1:5432`는 고정값이므로 PC에 PostgreSQL이 5432로 떠 있으면 먼저 멈춘다.

### 4.5 확인

```powershell
curl.exe -s http://127.0.0.1:8080/actuator/health          # {"status":"UP"}
curl.exe -s http://127.0.0.1:3000/health/renderer-enabled   # ok
curl.exe -s http://127.0.0.1:3000/api/v1/auth/csrf          # 프론트 → 백엔드 프록시
docker compose exec backend wget -qO- http://derived-compute:8090/healthz
```

브라우저에서 `http://localhost:3000`을 연다.

### 4.6 가입·분석에 필요한 초기 데이터

빈 DB에서는 **가입이 되지 않는다.** 가입 트랜잭션이 튜토리얼 1번 별을 지급하는데 Flyway 시드는 `operation_settings` 한 건뿐이다. 이때 OAuth 콜백은 `503 DEPENDENCY_UNAVAILABLE`이고 화면에는 `/oauth/callback?error=authentication_failed`로 보인다. 다음 중 하나로 채운다.

1. 운영과 같은 튜토리얼 5종: Publisher로 실제 Gold를 싣는다. 절차는 `infra/service/README.md` 「튜토리얼 5종」.
2. 로그인만 확인: `stars`와 `tutorial_stars`에 1번 별 한 건을 넣는다. 순서를 지켜야 트리거가 거절하지 않는다.

```sql
BEGIN;
INSERT INTO stars (tic_id, confirmed_count, service_status)
VALUES (149603524, 1, 'published')
ON CONFLICT (tic_id) DO UPDATE SET service_status = 'published';
INSERT INTO tutorial_stars (seq, tic_id, intent, active)
VALUES (1, 149603524, 'deep_confirmed', true)
ON CONFLICT (seq) DO NOTHING;
COMMIT;
```

`149603524`는 운영 튜토리얼 1번(WASP-62)이다. 2번만으로는 분석 화면이 열리지 않는다(Gold 판이 없어 `analysis-context`가 503).

### 4.7 개발 모드 실행(선택)

| 대상 | 명령 | 필요 조건 |
| --- | --- | --- |
| DB만 | `docker compose --profile service up -d --wait service-db` (루트) | `localhost:15432`, 로컬 공용 기본값 |
| 백엔드 | `cd apps/backend; ./gradlew bootRun` | 프로필 `local`. Redis 두 개를 `localhost:16379`(세션)·`16380`(캐시)에 띄움 |
| 프론트엔드 | `cd apps/frontend; npm ci; npm run dev` | `apps/frontend/.env.example` 참고 |
| 시연용 단독 서버 | `cd apps/frontend; npm ci; npm run dev:cinema` | 백엔드·DB 없이 합성 자료로 동작. [시연 시나리오](4-demo-scenario.md) |

```powershell
docker run -d --name planetory-local-session -p 127.0.0.1:16379:6379 redis:7.4-alpine
docker run -d --name planetory-local-cache   -p 127.0.0.1:16380:6379 redis:7.4-alpine
```

## 5. 빌드·실행 환경 변수

### 5.1 프론트엔드 빌드 인자 (`docker build --build-arg`)

Vite가 빌드 시점에 번들에 넣는다. 실행 중에는 바꿀 수 없다.

| 인자 | 운영 값 | Dockerfile 기본값 | 설명 |
| --- | --- | --- | --- |
| `VITE_SKY_RENDERER_ENABLED` | `true` | `false` | 3D 별지도 렌더러. `true`여야 배포 헬스 경로가 생긴다 |
| `VITE_CINEMA` | `true` | 빈 값 | 은하 한 장면 위에서 전 화면이 동작하는 운영 UI만 번들에 넣는다. 비우면 기존 화면(`src/legacy`) |
| `VITE_API_BASE` | `/api` | `/api` | API 경로 접두어 |
| `VITE_OAUTH_SSAFY_URL` | `/oauth2/authorization/ssafy` | 동일 | SSAFY 로그인 시작 경로 |
| `VITE_OAUTH_GOOGLE_URL` | `/oauth2/authorization/google` | 동일 | Google 로그인 시작 경로 |
| `VITE_CSRF_HEADER`, `VITE_CSRF_COOKIE`, `VITE_REQUEST_ID_HEADER`, `VITE_NICKNAME_REQUIRED_CODE`, `VITE_INITIAL_NICKNAME_PATH` | 빈 값 | 빈 값 | 선택 설정. 비우면 서버 기본 동작 |

개발 서버 전용 `API_PROXY_TARGET`, `VITE_P1_ENABLED`는 `apps/frontend/.env.example`에 있다.

### 5.2 운영 `.env` (`infra/service/.env`, 서버 `/home/deploy/planetory/.env`)

Compose는 `environment:`에 적힌 변수만 컨테이너에 넘긴다. 새 비밀 값을 추가하면 `compose.yaml`과 서버 `.env`를 함께 바꾼다. ●는 2026-09-28 운영 `.env`에 설정된 키다(값은 기록하지 않는다).

| 변수 | 운영 | 필수 | 기본값 | 용도 |
| --- | :---: | :---: | --- | --- |
| `FRONTEND_IMAGE`, `BACKEND_IMAGE`, `DERIVED_COMPUTE_IMAGE` | ● | ○ | `local/...:not-configured` | 실행할 이미지. 배포 job이 커밋 SHA 태그로 기록 |
| `POSTGRES_PASSWORD` | ● | ○ | 없음(없으면 기동 실패) | DB 소유자 `planetory` 비밀번호. Flyway가 사용 |
| `DATABASE_PASSWORD` | ● | ○ | 없음(없으면 기동 실패) | 앱 런타임 `planetory_service` 비밀번호. 소유자와 다른 값 |
| `POSTGRES_DB`, `POSTGRES_USER`, `DATABASE_USER`, `DATABASE_URL` | | | `planetory_poc`, `planetory`, `planetory_service`, `jdbc:postgresql://service-db:5432/planetory_poc` | 기본값끼리 서로 맞는다 |
| `OAUTH_PROFILES` | ● | 로그인 시 | 빈 값 | `oauth-google,oauth-ssafy`. 백엔드 `SPRING_PROFILES_INCLUDE`로 전달 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | ● | 로그인 시 | 빈 값 | Google OAuth |
| `SSAFY_CLIENT_ID`, `SSAFY_CLIENT_SECRET`, `SSAFY_REDIRECT_URI` | ● | 로그인 시 | 빈 값 | SSAFY OAuth |
| `AUTH_SUCCESS_URL` | ● (`/sky`) | | `/api/v1/me` | 로그인 성공 후 이동할 같은 출처 경로 |
| `CLOUDFLARE_TUNNEL_TOKEN` | ● | 공개 시 | 없음 | Tunnel connector 토큰 |
| `DERIVED_COMPUTE_URL` | ● | | 빈 값 | `http://derived-compute:8090`. 비우면 잔차 요청이 503 |
| `INTERNAL_SERVICE_TOKEN` | ● | | 빈 값 | `/internal/**`(Publisher 판 전환 알림) 서비스 토큰. 비우면 경로 차단 |
| `PUBLISHER_DB_PASSWORD` | ● | | 없음 | Gold 적재 계정 `planetory_publisher` 비밀번호(Gold 목업·튜토리얼 적재) |
| `GMS_KEY` | ● | | 빈 값 | SSAFY GMS(OpenAI 호환) 키. 행성 AI 설명 |
| `NASA_EXPLANATION_ENABLED`, `NASA_EXPLANATION_CHAT_MODEL` | ● | | `false`, `none` | AI 설명 켜기(`true`, `openai`) |
| `NASA_EXPLANATION_DAILY_PER_MEMBER`, `NASA_EXPLANATION_DAILY_GLOBAL` | ● | | `0`, `0` | AI 설명 일일 한도(회원별·전체) |
| `NASA_EXPLANATION_MODEL`, `NASA_EXPLANATION_MAX_OUTPUT_TOKENS`, `NASA_EXPLANATION_TIMEOUT`, `NASA_EXPLANATION_RETRY_DELAY`, `NASA_EXPLANATION_MAX_CONCURRENT` | | | `gpt-5.4-mini`, `320`, `8s`, `1h`, `1` | AI 설명 호출 설정 |
| `NASA_PLANET_INFO_ENABLED` 외 `NASA_PLANET_INFO_*` 6개 | | | `true`, TTL `7d`/`1d`, 재시도 `5m`, 타임아웃 `3s`/`6s`, 동시 `2` | NASA Exoplanet Archive 조회 정책 |
| `PLANETORY_WITHDRAWAL_ENABLED` | ● | | `false` | 회원 탈퇴 실행 스위치 |
| `NOTIFICATION_SIGNING_KEY` | | | 빈 값 | 알림 목록 커서 서명(32바이트 이상). 비우면 알림 목록·모두 읽음만 503 |
| `GOLD_PATH` | | | `/srv/planetory/gold` | 백엔드 `/gold` 읽기 전용 마운트 |
| `GOLD_CACHE_ENABLED`, `GOLD_CACHE_TIC_IDS` | | | `false`, 빈 값 | 지정 별 Gold를 기동 시 Redis에 적재 |
| `PLANETORY_RESIDUAL_MAXRUNNING` | | | `1` | 백엔드 동시 잔차 계산 수. Worker 수×동시 실행 수와 같게 |
| `DERIVED_COMPUTE_CPUS`, `DERIVED_COMPUTE_MEMORY`, `DERIVED_COMPUTE_MEMORY_LIMIT_MIB` | | | `1`, `2048m`, `1900` | Worker 자원 상한 |
| `FRONTEND_PORT`, `BACKEND_PORT` | | | `3000`, `8080` | loopback 호스트 포트 |
| `SESSION_REDIS_PASSWORD`, `CACHE_REDIS_PASSWORD` | | | 빈 값 | 외부 컨테이너를 `service` 네트워크에 붙일 때만 |

Redis 주소(`session-redis:6379`, `cache-redis:6379`)와 `GOLD_ROOT=/gold`는 `compose.yaml`이 직접 넣는다.

### 5.3 백엔드 프로필

| 프로필 | 켜는 방법 | 내용 |
| --- | --- | --- |
| `local` | 프로필 미지정 시 기본 | 로컬 DB `localhost:15432`, Redis `16379`/`16380`, Swagger 켬, 쿠키 `secure=false` |
| `prod` | 이미지 `ENV SPRING_PROFILES_ACTIVE=prod` | DB 비밀번호 기본값 없음, Swagger 꺼짐, 쿠키 `secure=true` |
| `oauth-google`, `oauth-ssafy` | `SPRING_PROFILES_INCLUDE`(`OAUTH_PROFILES`) | 켜면 해당 `*_CLIENT_*` 변수가 없을 때 기동 실패 |

### 5.4 GitLab CI/CD 변수

| 변수 | 용도 |
| --- | --- |
| `REGISTRY_IMAGE_PREFIX` | `<레지스트리 호스트>:<포트>/<네임스페이스>`. 이미지 태그는 커밋 SHA |
| `DEPLOY_USER` | 배포 계정 이름(`deploy`). SSH 키 변수는 두지 않는다(Tailscale SSH) |
| `EC2_A_HOST`, `EC2_A_DEPLOY_PATH` | 배포 대상 Tailscale IP, 배포 경로 `/home/deploy/planetory` |

Protected·Masked로 둔다. `lab.ssafy.com`은 Container Registry가 비활성이라 `CI_REGISTRY*` 대신 EC2-B의 자체 레지스트리를 쓴다.

## 6. 운영 배포(EC2-A)

### 6.1 서버 준비(최초 한 번)

1. Docker Engine과 Compose 플러그인을 설치한다.
2. Tailscale에 가입시키고 `tailscale up --ssh`로 SSH를 tailnet 신원으로 받는다. ACL은 [외부 서비스](2-external-services.md) 8절.
3. `infra/provisioning/provision-deploy-user.sh`로 CI 전용 `deploy` 계정을 만든다. `docker` 그룹만 주고 `sudo`는 주지 않는다.
4. `/home/deploy/planetory`에 `compose.yaml`, `deploy.sh`, `service-db-init/`, `.env`를 둔다. `compose.yaml`·`deploy.sh`는 배포 job이 매번 덮어쓰고 `.env`는 사람이 관리한다.
5. DB·Redis를 띄운다: `docker compose up -d service-db session-redis cache-redis`
6. Cloudflare Tunnel 토큰을 `.env`에 넣고 `docker compose up -d cloudflared`.
7. Worker → Backend → Frontend 순서로 첫 배포(6.2). Worker를 먼저 확인한 뒤 `.env`에 `DERIVED_COMPUTE_URL`을 넣는다.
8. 초기 데이터(4.6)를 넣는다.

### 6.2 CI/CD 흐름

```text
MR               → validate:* (Compose·Hadoop XML·계약 검사), backend:build, web:build, *:image(푸시 없는 확인 빌드)
develop 병합      → build:frontend·build:backend·build:derived-compute (linux/amd64, 커밋 SHA 태그, 레지스트리 push)
                   backend:test(전체 약 8분), web:e2e:smoke 자동
배포(수동 버튼)   → deploy:frontend:ec2-a / deploy:backend:ec2-a / deploy:derived-compute:ec2-a
                   compose.yaml·deploy.sh scp → deploy.sh가 pull·교체·헬스 확인·실패 시 직전 이미지로 롤백
```

| 서비스 | 헬스 경로 | 교체 전 DB 덤프 | 대기 한계 |
| --- | --- | --- | --- |
| `frontend` | `/health/renderer-enabled` | 없음 | 90초 |
| `backend` | `/actuator/health` | `backups/service-db-<시각>.sql`, 최근 10개 | 180초 |
| `derived-compute` | 없음(이미지 HEALTHCHECK만) | 없음 | — |

### 6.3 수동 배포·되돌리기

CI를 쓸 수 없을 때는 배포 경로에서 `deploy.sh`를 직접 부른다.

```sh
tailscale ssh deploy@ec2-a
cd /home/deploy/planetory
SERVICE=backend IMAGE_VAR=BACKEND_IMAGE IMAGE=<레지스트리>/planetory/backend:<sha> \
  HEALTH_PATH=/actuator/health HEALTH_TIMEOUT=180 DB_BACKUP=true sh deploy.sh
```

실패 시 마지막 줄로 상태를 구분한다: `되돌렸습니다`(직전 이미지로 동작 중), `되돌릴 이미지가 없습니다`(첫 배포), `되돌린 뒤에도 헬스가 통과하지 않습니다`(`docker compose stop <서비스>` 후 조사), `DB 덤프에 실패했습니다`(교체하지 않음).

### 6.4 보조 사이트 갱신(필요할 때만)

```sh
docker compose --profile erd-refresh run --rm erd-generator                 # ERD(Liam)
docker compose --profile api-docs-refresh run --rm api-docs-generator       # Swagger UI 정적 생성
docker compose --profile api-docs-refresh rm -sf api-docs-app api-docs-db
docker compose --profile wireframe-refresh run --rm wireframe-sync          # 와이어프레임 복사
```

## 7. 배포 시 특이사항

1. **외부 인바운드 포트는 0개다.** 공개는 Cloudflare Tunnel만 쓴다. 보안그룹에 80·443을 열지 않으며 컨테이너 포트는 `127.0.0.1`에만 바인드한다.
2. **Redis는 두 인스턴스가 필수다.** 백엔드는 세션·캐시 주소의 host와 port가 같으면 기동을 거부한다(캐시 축출이 세션을 지우지 않게 하는 경계).
3. **DB·Redis·cloudflared는 처음 한 번 수동으로 띄운다.** 배포 job은 `up -d --no-deps <서비스>`라 의존 서비스를 만들지 않는다.
4. **DB 계정은 소유자와 런타임을 나눈다.** 두 비밀번호는 달라야 한다. `service-db-init/10-app-account.sh`는 빈 볼륨 첫 초기화 때만 돌므로 기존 볼륨에는 `infra/service/README.md` 「계정 분리」 SQL을 한 번 실행한다.
5. **빈 DB는 가입이 안 된다.** 튜토리얼 1번 별이 필요하다(4.6).
6. **롤백은 이미지만 되돌린다.** Flyway는 앞으로만 가고 `clean`이 막혀 있다. 스키마 복구는 배포 전 덤프로 한다.
7. **`docker compose down -v`를 쓰지 않는다.** `planetory-service-db-data` 볼륨이 회원·제출 데이터의 유일한 사본이다(복제·백업 없음). 보조 문서 갱신 뒤 정리도 `down` 대신 이름을 지정한 `rm -sf`를 쓴다.
8. **배포는 최신 develop 파이프라인의 버튼으로 한다.** 옛 파이프라인의 배포 버튼 Play는 GitLab이 막지만, 옛 job의 Retry는 되돌리기로 허용되고 서버 `compose.yaml`까지 그 커밋 판으로 덮는다. 의도한 되돌리기에만 Retry를 누른다.
9. **Worker를 켜는 순서는 Worker 배포 → healthy 확인 → `.env`에 `DERIVED_COMPUTE_URL` → Backend 배포다.** Worker에는 `ports:`를 열지 않는다(인증 없는 계산 경로, 네트워크 격리가 유일한 통제).
10. **프론트엔드는 `VITE_SKY_RENDERER_ENABLED=true`, `VITE_CINEMA=true`로 빌드한다.** 앞의 값이 없으면 헬스 표식이 없어 배포가 롤백된다.
11. **OAuth 리디렉션 주소는 `https://app.planetory.space/login/oauth2/code/{google|ssafy}`다.** 도메인을 바꾸면 각 제공자 콘솔과 `.env`의 `*_REDIRECT_URI`를 함께 바꾼다.
12. **Swagger는 운영 백엔드에서 꺼져 있다**(`SWAGGER_ENABLED` 기본 `false`, 허용 규칙은 `local` 프로필에만). API 문서는 일회용 컨테이너로 생성한 정적 사이트(`api-docs.planetory.space`)로 본다.
13. **이미지는 `linux/amd64`로만 빌드한다.** 빌드는 `docker build`로 하고 buildx를 쓰지 않는다(Runner의 `extra_hosts`가 buildkit 컨테이너에 닿지 않아 push가 실패한다).
14. **레지스트리 TLS 인증서는 `tailscale cert`로 발급했다.** 만료 전에 다시 발급하고 레지스트리 컨테이너를 재시작하지 않으면 빌드와 배포가 함께 멈춘다.
15. **백엔드 재시작은 전면 중단이다**(인스턴스 1개). `session-redis`를 함께 재시작하지 않으면 로그인은 유지된다.

## 8. DB 접속 정보·계정·프로퍼티 파일 목록

### 8.1 DB 접속 정보

| 항목 | 운영(EC2-A) | 로컬 개발(루트 Compose) |
| --- | --- | --- |
| DBMS | PostgreSQL 18.6 | PostgreSQL 18.6 |
| 컨테이너 안 주소 | `service-db:5432` | `service-db:5432` |
| 호스트에서 | `127.0.0.1:5432`(서버 안에서만) | `localhost:15432` |
| DB 이름 | `planetory_poc` | `planetory_poc` |
| 볼륨 | `planetory-service-db-data` | `planetory-local_service-db-pg18-data` |
| 접속 명령 | `docker compose exec service-db psql -U planetory -d planetory_poc` | 동일(루트에서) |

비밀번호는 문서에 적지 않는다. 운영은 서버 `.env`, 로컬은 `.env.example`의 로컬 공용 기본값을 쓴다.

### 8.2 계정과 역할

| 이름 | 종류 | 권한·용도 | 비밀번호 주입 |
| --- | --- | --- | --- |
| `planetory` | 로그인, 소유자 | 테이블 소유, Flyway 마이그레이션 | `POSTGRES_PASSWORD` |
| `planetory_service` | 로그인 | 백엔드 런타임. `planetory_app`만 부여, 스키마 CREATE 회수 | `DATABASE_PASSWORD` |
| `planetory_publisher` | 로그인 | Gold 적재. `planetory_gold_writer` 멤버, Gold 12개 테이블만 읽기·쓰기 | `PUBLISHER_DB_PASSWORD`, GCP Node 1 env 파일 |
| `planetory_app` | 역할(NOLOGIN) | 앱 런타임 권한 묶음 | — |
| `planetory_gold_writer` | 역할(NOLOGIN) | Gold 적재 권한 묶음 | — |
| `planetory_stats_job` | 역할(NOLOGIN) | 통계 집계 권한 묶음 | — |

### 8.3 계정·프로퍼티가 정의된 파일

| 파일 | 내용 | Git |
| --- | --- | :---: |
| `infra/service/compose.yaml` | 운영 서비스 정의, 백엔드에 넘기는 환경 변수 전체 | 포함 |
| `infra/service/.env` (서버 `/home/deploy/planetory/.env`) | 운영 비밀 값·이미지 태그(5.2) | 제외 |
| `infra/service/service-db-init/10-app-account.sh` | 빈 볼륨 초기화 시 역할 3개·런타임 계정 생성 | 포함 |
| `infra/service/deploy.sh` | 서비스 교체·헬스 확인·롤백·DB 덤프 | 포함 |
| `apps/backend/src/main/resources/application.properties` | 공통 설정(DB·Flyway·세션·Redis·NASA·AI) | 포함 |
| `apps/backend/src/main/resources/application-local.properties` | 로컬 DB·Redis 기본값, Swagger | 포함 |
| `apps/backend/src/main/resources/application-oauth-google.properties` | Google OAuth 등록 | 포함 |
| `apps/backend/src/main/resources/application-oauth-ssafy.properties` | SSAFY OAuth 등록·엔드포인트 | 포함 |
| `apps/backend/.env.oauth.properties` | 개인 PC의 OAuth 키(`spring.config.import`) | 제외 |
| `apps/backend/src/main/resources/db/migration/` | Flyway V1~V30, `R__table_comments.sql`, 역할·권한(V2 등) | 포함 |
| `.env.example` → `.env` | 로컬 Compose(DB 포트·비밀번호, 이미지 오버라이드) | 예시만 포함 |
| `apps/frontend/.env.example` → `.env` | 프론트 개발 서버 설정 | 예시만 포함 |
| `apps/frontend/nginx.conf` | 운영 Nginx(프록시·OAuth 오류 복귀·캐시 헤더) | 포함 |
| `.gitlab-ci.yml`, `.gitlab/ci/**` | CI/CD job | 포함 |

ERD는 `https://erd.planetory.space`(Liam ERD)에서 보고, 표 설명은 DB의 `COMMENT`(`R__table_comments.sql`)가 정본이다.

## 9. 분산 처리 영역(GCP) 참고

TESS 원천 수집·가공은 GCP 6대 VM에서 돌고 서비스 배포와 분리돼 있다. CI 배포 job이 없고 운영자 스크립트로 설치한다.

| 항목 | 값 |
| --- | --- |
| 노드 | GCP `asia-east1-b`, 6개 프로젝트를 VPC Peering, 각 6 vCPU·36GiB |
| 저장·자원 | Hadoop 3.5.0(HDFS HA, QJM)·YARN, OpenJDK 17, 호스트 systemd 데몬 |
| 연산 | Spark 3.5.5(`apache/spark:3.5.5-python3`, digest 고정) YARN cluster mode |
| 제어 | Airflow 2.10.5(Node 1, release에서 로컬 이미지 빌드) |
| 공개 | Publisher → Tailscale → EC2-A `service-db` 적재 → 백엔드 `/internal` 알림 |

설치·검증 절차는 `infra/distributed-system/README.md`, `docs/workflows/hadoop-operations.md`, `infra/provisioning/gcp/README.md`를 따른다.

## 10. 담당 정본 문서

| 주제 | 문서 |
| --- | --- |
| Docker·로컬 실행 | [docs/operations/docker.md](../docs/operations/docker.md) |
| CI/CD | [docs/operations/cicd.md](../docs/operations/cicd.md) |
| EC2 서비스 배포·계정·초기 데이터 | [infra/service/README.md](../infra/service/README.md) |
| 배포 현재 상태 | [docs/project/service-deploy-status.md](../docs/project/service-deploy-status.md) |
| 백엔드 개발 환경 | [apps/backend/docs/development-setup.md](../apps/backend/docs/development-setup.md) |
| OAuth 설정 | [apps/backend/docs/oauth-setup.md](../apps/backend/docs/oauth-setup.md) |
| 시스템 아키텍처 | [docs/architecture/system-architecture.md](../docs/architecture/system-architecture.md) |
| 서버 접속 | [docs/operations/tailscale-team-access.md](../docs/operations/tailscale-team-access.md) |

# 서비스 배포·CI/CD 현재 상태

`S15P21C206-84` 작업의 인계 문서다. 절차와 근거는 담당 정본에 있고 여기에는 **현재 상태, 검증 경계, 남은 결정**만 둔다.

- 배포·롤백 절차와 초기 데이터: [EC2 서비스 배포](../../infra/service/README.md)
- CI/CD 정본: [CI/CD](../operations/cicd.md)
- 결정 근거와 날짜별 기록: [2026-09-18](../changes/2026-09-W3/2026-09-18.md), [2026-09-21](../changes/2026-09-W4/2026-09-21.md)

## 한 줄 요약

실제 앱은 `app.planetory.space`다. `planetory.space`는 목업 컨테이너로 연결되어 있어 그 주소에서는 로그인이 성립하지 않는다.

**프론트엔드와 백엔드 모두 CI 이미지로 돌고 있다(2026-09-21·22).** 두 컨테이너 다 커밋 SHA 태그를 달아 어느 커밋인지 추적된다. 손으로 빌드한 `:local` 이미지는 더 이상 쓰이지 않는다. Google·SSAFY 로그인 진입과 API 응답을 실환경에서 확인했다.

아래 본문에서 **「develop의 배포 job」이라고 적은 것은 MR `!161` 병합 전의 동작**이다. 병합되면 헬스 확인·롤백·`.env` 기록이 배포 경로에 들어온다.

## 실환경에서 확인된 것 (2026-09-18)

| 항목 | 상태 |
| --- | --- |
| 도메인 진입 | `planetory.space` → Cloudflare Tunnel → EC2-A. 외부 인바운드 개방 0개 |
| Tunnel connector | EC2-A 한 곳. 여러 곳에 붙여도 분산되지 않으므로 EC2-B에는 두지 않는다(D4) |
| 로그인 | Google·SSAFY 둘 다 성공. 회원 생성·튜토리얼 별 지급까지 동작 |
| DB | `service-db`(PostgreSQL 18.6), Flyway 마이그레이션 적용, 영속 볼륨 `planetory-service-db-data` |
| 별지도 | 렌더러를 켠 이미지로 교체(2026-09-23, `S15P21C206-254`). 아래 「수동 배포한 렌더러 이미지」 참고 |

**프론트엔드와 백엔드 모두 CI 이미지로 교체됐다(2026-09-21·22).** 두 컨테이너 다 커밋 SHA 태그를 달고 있어 어느 커밋인지 추적된다. 손으로 빌드한 `:local` 이미지는 더 이상 쓰이지 않는다.

## 터널 호스트 배치

한 인스턴스에서 여러 호스트를 서빙한다. **실제 앱과 목업이 다른 호스트라 확인할 때 주소를 혼동하기 쉽다.** 배포 검증을 목업 주소로 하면 늘 200이 나와 아무것도 증명하지 못한다.

| 호스트 | 연결 대상 |
| --- | --- |
| `app.planetory.space` | 실제 앱(프론트 컨테이너) |
| `planetory.space` | 목업 |
| `erd.planetory.space` | ERD |
| `api-docs.planetory.space` | API 문서 |
| `wireframe.planetory.space` | 와이어프레임 |

백엔드가 발급하는 OAuth 리다이렉트 주소도 `app.planetory.space`다. 목업 호스트에서는 로그인 흐름이 성립하지 않는다.

## develop 배포가 요구하는 설정 둘 (S15P21C206-254)

MR `!161` 병합 뒤 develop 배포에서 두 가지가 깨졌다. 코드가 먼저 들어오고 배포 설정이 따라오지 않은 경우다. 브랜치 `fix/S15P21C206-254-infra-deploy-config-gaps`에 구현했고, **병합 전에 EC2-A에 수동으로 반영했다(2026-09-23).**

### 백엔드: Redis가 없어 기동 실패 → 롤백

`RedisSessionConfig`가 세션·캐시 Redis 주소 넷을 필수로 읽는데 `compose.yaml`에 Redis도 주소도 없었다. `deploy.sh`의 헬스 확인이 실패를 잡아 직전 이미지로 되돌렸고(실환경 첫 롤백), 서비스는 유지됐다.

- `session-redis`·`cache-redis` 두 서비스를 compose에 넣었다. 두 인스턴스는 host+port가 달라야 하며, 같으면 앱이 기동을 거부한다.
- 주소는 **`.env`가 아니라 compose가 서비스 이름으로 직접 준다.** 티켓은 `.env`에 넣도록 적었지만, 그러면 `.env`에서 하나만 빠져도 같은 기동 실패가 되풀이된다.
- 세션은 볼륨·RDB 저장, 64mb 상한에 `noeviction`(상한에 닿으면 새 로그인이 503). 캐시는 저장 없음, 128mb(임시) `volatile-lru`. 캐시는 Backend의 기동 의존성이 아니다(리뷰 반영, 아래).
- 캐시 소비처는 아직 없다. 지금은 기동 요건만 채운다.

EC2-A에서 서비스와 분리된 임시 프로젝트로 검증했다(2026-09-23). 두 컨테이너 healthy, 설정값이 위와 일치, 재시작 후 세션 키 유지·캐시 키 소실, 호스트 포트 게시 없음. 백엔드 앱과 붙인 검증은 배포 때 한다.

**최초 기동은 수동이다.** `deploy.sh`는 `--no-deps`로 교체하므로 의존 서비스를 만들지 않는다. 절차는 [EC2 서비스 배포](../../infra/service/README.md#세션캐시-redis).

**배포 결과(2026-09-23).** 브랜치의 `compose.yaml`로 교체하고(직전 파일은 `compose.yaml.bak-before-254`) 두 Redis를 띄운 뒤 `deploy.sh`로 Backend `e510d1da`를 올렸다. 헬스 200, 기동 로그 예외 0건, Backend 환경변수가 두 인스턴스를 따로 가리킨다. V20·V21·V22·R__이 적용돼 V22다. `planetory_stats_job`은 마이그레이션 계정이 슈퍼유저라 V21이 직접 만들었다. `cache-redis`에는 연결이 없다. 소비처가 없어 팩토리가 연결하지 않는다. 로그인 뒤 Backend만 재시작해도 세션이 유지됐고, 세션 키는 `session-redis`에만 있다(`cache-redis` 0개).

첫 시도는 compose 교체 없이 배포만 돌려 같은 `SESSION_REDIS_HOST` 오류로 롤백됐다. Redis 설정 단계에서 죽어 마이그레이션 전이었고 DB는 V19 그대로였다. 롤백 로그의 "스키마는 그대로" 문구는 롤백마다 붙는 일반 경고다.

**리뷰 반영(2026-09-23).** 백승학·하서진 P2 두 건과 강재민 제안 둘을 받았다. 세션에 64mb 상한(`noeviction` 유지), Backend `depends_on`에서 `cache-redis` 제거, 캐시 정책 `allkeys-lru`→`volatile-lru`, `requirepass` 재검토 조건을 "우리가 만들지 않은 컨테이너가 네트워크에 붙을 때"로 좁혔다. EC2-A에 재반영했고(직전 compose는 `compose.yaml.bak-before-254-review`) 두 Redis 재생성 뒤에도 세션 키가 남았다. 근거와 관측 명령은 [EC2 서비스 배포](../../infra/service/README.md#세션캐시-redis).

**병합 전에 develop Backend를 CI로 배포하면 `compose.yaml`이 Redis 없는 판으로 덮여 다시 롤백된다.** 컨테이너는 남지만 주소가 사라진다. 이 브랜치를 먼저 병합한다.

### 프론트: 별지도 렌더러가 꺼진 채 빌드

`Dockerfile`의 `VITE_SKY_RENDERER_ENABLED` 기본값이 `false`이고 CI의 `BUILD_ARGS`가 비어 있었다. 별지도 자리에 "지도 시각화 연결을 준비하고 있습니다" 문구만 나온다.

- `build:frontend`·`web:image`가 `--build-arg VITE_SKY_RENDERER_ENABLED=true`로 빌드한다. MR의 `web:build`도 같은 값으로 번들링한다.
- `build:frontend`·`deploy:frontend:ec2-a` 규칙에 `.gitlab/ci/apps/frontend.yml`을 넣었다. 빌드 인자가 이 파일에 있어 이 파일만 바뀌어도 이미지가 달라진다.
- 빌드 시점 값이다. 서버 환경변수나 재시작으로는 적용되지 않는다.

**판별 기준을 바꿨다.** 티켓을 쓸 때의 근거였던 WebGL 호출(`createShader` 등) 개수는 이제 쓸 수 없다. 로그인 화면과 미리보기가 렌더러 모델을 가져오면서 플래그와 무관하게 번들에 들어가기 때문이다. 대신 **메인 청크가 `GalaxyPage`와 `GalaxyScene` 청크를 참조하는지** 본다. 로컬 빌드에서 켜면 3회·1개, 끄면 0·0이다.

**배포 헬스가 렌더러를 본다(리뷰 반영).** `/`는 렌더러가 빠져도 200이라 회귀를 못 잡았다. 켠 빌드에만 생기는 `/health/renderer-enabled`를 헬스 경로로 바꿨다. EC2-A에서 ON/OFF 이미지를 비교해 200/404, SPA 경로는 둘 다 200임을 확인했다. 과도기 롤백 주의는 [EC2 서비스 배포](../../infra/service/README.md#배포와-롤백).

켜더라도 계정이 가진 별만 보인다. 시제품처럼 수천 개가 나타나지 않는다.

### 수동 배포한 렌더러 이미지 (2026-09-23)

브랜치 병합을 기다리지 않고 프론트만 먼저 켰다. **운영 중이던 커밋 `80a860fa` 그대로에 플래그만 더해** EC2-A에서 빌드했다. 코드 차이는 렌더러 하나다.

- 이미지: `frontend:80a860fa…-sky`. CI가 같은 SHA로 만든 이미지를 덮어쓰지 않도록 접미사를 붙였다.
- `deploy.sh`로 교체했다. 헬스 통과, `.env`에 기록됐다.
- 공개 주소 확인: 메인 청크가 `GalaxyPage`를 3회 참조하고 렌더러 청크가 200으로 내려온다. 교체 전 이미지는 0회였다.

**이 브랜치가 병합되기 전에 develop 프론트를 CI로 배포하면 렌더러가 다시 꺼진다.** 병합 뒤부터는 CI가 항상 켜서 빌드한다.

레지스트리의 `frontend:ed7d72d2…-sky`는 잘못 고른 기준으로 만든 이미지다. 쓰이지 않는다.

### 배포 경로를 혼동하지 않는다

CI가 배포하는 곳은 **`/home/deploy/planetory`**(`deploy` 계정)다. `deploy.sh`, 실제 `.env`, `backups/`가 여기 있다. `~ubuntu/planetory/infra/service`는 09-21 이전 수동 기동 때의 사본이라 `.env`의 이미지 선언이 낡았다. 같은 compose 프로젝트 이름을 쓰므로 거기서 `docker compose ps`를 쳐도 컨테이너가 보여 오인하기 쉽다. 도는 버전은 컨테이너 라벨 `com.docker.compose.project.working_dir`과 이미지로 확인한다.

## 손으로 넣은 데이터 (운영 값 아님)

로그인을 뚫기 위해 EC2-A DB에 직접 넣었다. **운영이 정한 값이 아니다.**

| 대상 | 내용 |
| --- | --- |
| 튜토리얼 1번 별 | TIC `261136679`. 임의로 고른 값 |
| 더미 별 | TIC `900000002`~`900000041` 40개와 그 발견 기록 |

더미 별은 `DELETE FROM star_unlocks WHERE tic_id >= 900000002;`로 지운다. 튜토리얼 별은 운영 TIC이 정해지면 교체한다. 빈 DB에서 가입이 막히는 조건과 시드 순서는 [EC2 서비스 배포](../../infra/service/README.md)에 있다.

## 계정 분리 적용 — 소유자·런타임 (2026-09-21)

develop의 계정 분리(`S15P21C206-238`)가 들어오면서 배포 계약이 바뀌었고, EC2-A에 적용을 마쳤다. 절차는 [EC2 서비스 배포](../../infra/service/README.md)의 「계정 분리」 절을 따랐다.

| 항목 | 상태 |
| --- | --- |
| `planetory_service` 계정 | 기존 볼륨에 수동 생성. `planetory_app` 부여, `public` 스키마 `CREATE` 회수 |
| `.env`의 `DATABASE_PASSWORD` | 추가. `POSTGRES_PASSWORD`와 다른 값 |
| CI 배포 경로 `/home/deploy/planetory` | `.env`와 `service-db-init/`를 배치. `deploy` 계정 소유 |
| `docker compose config -q` | `deploy` 계정으로 통과 |

**계정 전환이 2026-09-22 백엔드 배포로 완료됐다.** Flyway가 소유자로 V10~V19를 적용하며 `planetory_app` GRANT를 채웠고, 앱은 `planetory_service`로 붙는다. 한 번의 기동 안에서 처리됐고 실패한 마이그레이션은 없다.

| 확인 | 결과 |
| --- | --- |
| 앱 접속 계정 | `planetory_service` |
| 마이그레이션 계정 | `planetory` (소유자) |
| 적용 버전 | V9 → V19, 10건 적용, 실패 0 |
| 런타임 계정 조회 | 회원·별 테이블 정상 조회 |
| 런타임 계정 `CREATE` | 거부 유지 |

**배치 적재 계정은 아직 갈리지 않았다.** 접속 계정은 셋이 아니라 둘이다.

| 역할 | 상태 |
| --- | --- |
| 소유자·마이그레이션 `planetory` | 적용 |
| 런타임 `planetory_service` (`planetory_app` 보유) | 적용 |
| 배치 적재 `planetory_gold_writer` | **역할만 생성, 부여받은 계정 없음** |

`service-db-init/10-app-account.sh`가 `planetory_gold_writer` 역할을 만들기는 하지만 그 역할을 부여받은 계정이 어디에도 없다. 후보 정정 계약의 「배치 역할은 회원 데이터를 고칠 수도 셀 수도 없다」는 권한 경계는 배치가 그 역할을 가진 계정으로 붙어야 성립한다. 지금은 Publisher가 소유자로 붙으면 경계가 무력화된다. 부여 대상 계정을 만드는 일은 남은 항목이다.

## CI push 차단과 해소 (2026-09-21)

`build:frontend`는 이미지 빌드까지 성공하고 **레지스트리 push에서 실패했다.** 아래 조치로 해소했고 지금은 통과한다.

```text
Get "https://<레지스트리 호스트>:<포트>/v2/": net/http: request canceled
while waiting for connection (Client.Timeout exceeded while awaiting headers)
```

원인은 **EC2-B의 컨테이너가 자기 호스트에 닿지 못하는 것**이다. 호스트에서는 레지스트리가 정상 응답하지만(`200`), 같은 호스트의 컨테이너가 호스트 주소로 접근하면 막힌다. 인터넷과 tailnet 피어로는 나간다.

| 경로 | 결과 |
| --- | --- |
| EC2-B 호스트 → 레지스트리 | 200 |
| EC2-A → 레지스트리 | 200. 인증서 유효, `docker pull` 경로 정상 |
| EC2-B 컨테이너 → 호스트 주소의 레지스트리 포트 | 차단 |
| EC2-B 컨테이너 → 레지스트리 컨테이너 주소 | 200 |
| EC2-B 컨테이너 → EC2-A의 `deploy` 계정 SSH | 정상. 배포 경로에서 `config -q`까지 통과 |
| EC2-B 컨테이너 → 인터넷 | 200 |

측정 주의. `curl telnet://`은 연결에 성공해도 세션을 닫지 않아 `--max-time`에 걸린다. 연결 여부 판정에 쓰면 정상 경로를 차단으로 오판한다. 포트 도달만 볼 때는 `tcpdump`로 핸드셰이크를 보거나 실제 프로토콜로 확인한다.

차단 주체는 UFW다. 커널이 직접 남긴 기록이 있다.

```text
[UFW BLOCK] IN=docker0 SRC=<컨테이너> DST=<EC2-B tailnet 주소> DPT=<레지스트리 포트>
[UFW BLOCK] IN=docker0 SRC=<컨테이너> DST=<docker0 게이트웨이> DPT=<레지스트리 포트>
```

Tailscale 문제가 아니다. 호스트의 어느 주소로 가든 똑같이 막히며, tailnet과 무관한 도커 게이트웨이도 마찬가지다. 반대로 tailnet 피어로 나가는 경로는 정상이다.

### 적용한 해법: 방화벽을 건드리지 않는다

컨테이너에서 **레지스트리 컨테이너로 직접 가면 통한다.** 같은 브리지 위라 호스트 `INPUT`을 거치지 않는다. Runner 설정의 호스트 매핑을 레지스트리 컨테이너 주소로 바꿨다.

```toml
# /srv/gitlab-runner/config/config.toml
extra_hosts = ["<레지스트리 호스트>:<레지스트리 컨테이너 주소>"]
```

인증서는 이름으로 검증하므로 그대로 유효하고, push가 호스트 밖으로 나가지 않아 「이미지 레지스트리」가 적어둔 의도에 더 맞는다.

적용 후 `build:frontend`를 재실행해 **push 성공과 레지스트리 태그 등록을 확인했다.** EC2-A에서도 같은 태그가 조회된다. 되돌리려면 EC2-B의 `config.toml.bak-20260921`을 복원하고 Runner를 재시작한다.

**한계.** 레지스트리 컨테이너 주소는 기본 브리지가 순서대로 준 값이라 레지스트리 컨테이너를 다시 만들면 바뀔 수 있다. 바뀌면 push가 같은 방식으로 다시 깨진다. 고정이 필요해지면 사용자 정의 네트워크에 네트워크 별칭으로 붙여 Docker DNS가 이름을 풀게 한다.

### 배포 경로에서 확인한 것

컨테이너에서 EC2-A로 나가는 경로는 막혀 있지 않다. `tcpdump`로 보면 출발지가 EC2-B의 tailnet 주소로 masquerade되어 나가고 handshake가 완료된다. 컨테이너에서 `deploy` 계정으로 실제 SSH가 붙고, 배포 경로에서 `docker compose config -q`까지 통과한다.

따라서 `.remote-compose-deploy`의 "job 컨테이너의 연결은 Runner 호스트의 tailnet 신원으로 나간다"는 주석은 **맞다.** masquerade로 성립한다.

Runner 자체는 문제가 없다. `planetory-docker-runner`는 online이고 `amd64-docker` 태그와 `run_untagged=true`를 갖는다. CI 변수 `DEPLOY_USER`·`EC2_A_HOST`·`EC2_A_DEPLOY_PATH`·`REGISTRY_IMAGE_PREFIX`도 실제 서버 구성과 일치한다.

## CI/CD 구성

| job | 언제 | 무엇 |
| --- | --- | --- |
| `web:build` | 프론트 변경 | `npm run build` |
| `web:image` | `Dockerfile`·`nginx.conf` 변경 | 이미지 빌드 + 이미지 안에서 `nginx -t` |
| `backend:schema` | 마이그레이션 변경 | 버전 선점·중복, 되돌릴 수 없는 변경 |
| `backend:build` | 백엔드 소스·테스트 변경 | `./gradlew bootJar test -PmrTests` (DB 없는 테스트 + `PlanetoryApplicationTests`, PostgreSQL 서비스) |
| `backend:image` | `Dockerfile` 변경 | 이미지 빌드. `backend:build`가 실패하면 돌지 않는다 |
| `backend:test` | develop 병합 뒤 자동, MR에서는 수동 | 백엔드 테스트 전체(PostgreSQL 서비스 + dind). 이미지 빌드·배포를 막지 않는다 |
| `build:*` | 기본 브랜치 | 레지스트리 이미지 빌드·푸시 |
| `deploy:*:ec2-a` | 기본 브랜치, 수동 버튼 | 교체 → 헬스 확인 → 실패 시 롤백 |

검증 job은 전부 `needs: []`라 파이프라인 시작과 동시에 병렬로 뜨고, 각자 자기 경로가 바뀔 때만 돈다.

넣지 않은 것과 이유. **CI는 배포를 막을 수 있는 것만 본다.**

- 포맷 검사 — 빌드·배포·동작과 무관하다. LF 기준으로 이미 16개 파일이 실패하기도 한다.
- 프론트 단위 테스트 — 파일 50개가 기능 담당자 소유다. 관문으로 세우면 한 사람의 테스트가 다른 사람의 MR을 막는다. 팀 합의가 먼저다.
- Playwright — 설정 24개를 직렬로 돌아 머지를 막는다.

## 검증 경계

**실행해서 확인한 것.** 프론트 `npm test` 343개와 `npm run build` 통과. 배포 스크립트는 가짜 `docker`·`curl`로 정상 배포, `up -d` 실패 시 롤백, 복수 서비스 교체, `curl` 부재 시 교체 전 중단, 덤프 실패 시 중단, 이미지 변수 오타 검출을 확인했다. 스키마 검사는 **로컬에서** 실제 저장소로 선점 차단·통과·건너뛰기를 확인했고, 되돌릴 수 없는 구문 6종 차단과 한국어 주석 오탐 없음을 확인했다. 이미지 빌드 두 개는 로컬 Docker에서 실제로 실행했다. 수정 전 `nginx.conf`로 `nginx -t`가 `host not found in upstream`으로 실패하는 것도 확인했다.

**실환경에서 확인한 것(2026-09-21).** GitLab 파이프라인은 실행되고 있다. develop의 `build:frontend`는 Runner를 잡고 dind에서 이미지 빌드까지 마치며 커밋 SHA 태그도 정확히 붙는다. `rules: changes` 판정과 dind 기동도 동작한다. EC2-A의 배포 경로는 `deploy` 계정으로 `docker compose config -q`를 통과하고, 레지스트리 인증서는 EC2-A에서 유효하다.

**MR 단계 검증 job이 실제로 돌았다(2026-09-22).** MR 파이프라인에서 `backend:schema`, `backend:build`, `backend:image`, `web:build`, `web:image`가 모두 통과했다. 스키마 검사는 타깃 브랜치를 가져와 develop의 최대 버전 `V19`와 대조하고 선점 검사를 통과했다. 그 전까지 이 job은 **추가된 뒤 한 번도 실행되지 않았다.** 원인은 아래 「MR 단계 검사가 실행되지 않던 결함」에 있다.

**배포까지 확인한 것(2026-09-21).** `deploy:frontend:ec2-a`를 실행해 성공했다. 프론트엔드 컨테이너가 레지스트리의 커밋 SHA 이미지로 교체됐고 `planetory.space`와 로컬 오리진이 모두 200을 반환한다. 다른 컨테이너는 영향받지 않았다.

**롤백까지 확인한 것(2026-09-21).** 이 브랜치의 `deploy.sh`를 EC2-A의 격리 프로젝트에서 실제 docker·curl로 돌려 헬스 실패 시 되돌리기와 `.env` 기록을 확인했다. 자세한 결과는 위 표에 있다.

**백엔드 배포까지 확인한 것(2026-09-22).** `build:backend`와 `deploy:backend:ec2-a`를 실행해 성공했다. 백엔드가 커밋 SHA 이미지로 교체되고 V19까지 마이그레이션이 적용됐다. 헬스 200, OAuth 진입 302, 기동 로그 오류 0건이다. 배포 전에 DB를 덤프해 두었다. develop의 배포 job은 덤프를 뜨지 않으므로 손으로 받았다.

배포한 커밋은 develop 최신보다 5개 뒤지만 **그 사이에 `apps/backend` 변경이 없어** 백엔드 코드는 최신과 같다.

**확인하지 못한 것.** 운영 배포에서의 **롤백**은 여전히 관찰하지 않았다. 두 배포 모두 성공해 롤백 경로가 밟히지 않았고, develop의 배포 job에는 그 로직이 아예 없다. 캐시 적중도 관찰하지 않았다.

## 남은 결정 (MR에서 확인)

1. **프론트 단위 테스트를 CI 관문으로 세울지.** 세우면 한 사람의 테스트 실패가 다른 사람의 MR을 막는다.
2. **`-- IRREVERSIBLE:` 방식이 적절한지.** 되돌릴 수 없는 마이그레이션을 금지하지 않고 파일에 근거를 요구한다. 세 배포로 나눌 수 있는지 한 번 묻는 것이 목적이다.
3. **EC2-B 배포 job 제거.** [CI/CD](../operations/cicd.md)가 이 티켓에 지정했고 실제로 지웠다. 확인이 필요하다.

## 이관한 결함

배포 과정에서 찾은 프론트·백엔드 결함은 담당자 버그 티켓으로 넘겼다. 이 티켓에서 고치지 않는다.

| 티켓 | 내용 |
| --- | --- |
| `S15P21C206-239` | 401·403과 502·503·504를 분리하는 Nginx·로그인 화면 수정 및 로컬 프록시 검증 완료. [239 검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)을 따르며 리뷰·병합·실제 배포 반영은 별도다 |
| `S15P21C206-240` | OAuth `failureHandler`가 실패 원인을 기록하지 않는다. 초기 데이터가 없을 때 가입이 막히는 증상도 진단이 어렵다 |

## 84에 남은 범위

Tunnel 진입과 프론트·백엔드 기동만 구현했다. 티켓의 나머지는 손대지 않았다.

- ~~Redis runtime, 메모리 상한·eviction 정책~~ → `S15P21C206-254`로 옮겼다
- health/readiness 설계(`S15P21C206-93`)
- 애플리케이션 계층 남용 제어 위치
- 단일 connector 지속 처리량·재연결 실측

## MR 단계 검사가 실행되지 않던 결함 (2026-09-22 해소)

`backend:schema`가 `alpine/git` 이미지를 쓰는데 이 이미지의 `ENTRYPOINT`가 `["git"]`이다. Runner가 붙이는 셸이 `git sh -c ...`로 조립되고 git이 `sh`를 하위 명령으로 오인해 죽었다.

```text
git: 'sh' is not a git command. See 'git --help'.
```

**스크립트가 한 줄도 실행되지 않았다.** 검사 로직에는 문제가 없었고, 빨강이 떠서 MR이 막혀 있었다. `entrypoint: [""]`로 비워 해소했다.

같은 함정이 있는 이미지는 이것뿐이다. 나머지 job은 `docker:cli`, `alpine`, `node`, `eclipse-temurin`, `python`을 쓰며 모두 셸을 기본 진입점으로 삼는다.

**교훈.** 로컬에서 스크립트를 돌려 통과한 것은 CI에서 그 스크립트가 실행된다는 뜻이 아니다. 이미지의 진입점이 다르면 스크립트에 도달하지도 못한다. 검증을 적을 때 실행 위치를 함께 남긴다.

## develop의 배포 job은 구버전이다

지금 develop에 있는 `.remote-compose-deploy`는 `deploy.sh` 없이 ssh 한 줄로 교체만 한다. 헬스 확인, 실패 시 롤백, 배포한 이미지를 `.env`에 기록하는 일이 모두 빠져 있다. 이 브랜치가 그 셋을 넣는다.

기록이 빠진 결과가 실제로 나타났다. 2026-09-21 프론트 배포와 2026-09-22 백엔드 배포 **두 번 모두** 도는 이미지는 CI 이미지인데 `.env`의 선언은 `:local`로 남았다. 그 상태로 누가 인자 없이 `docker compose up -d`를 실행하면 추적되지 않는 옛 이미지로 조용히 되돌아간다. 두 번 다 값을 손으로 맞춰 해소했다. **병합 전까지는 배포할 때마다 반복되므로 배포 후 `.env`를 확인한다.**

### 이 브랜치의 deploy.sh를 실제 서버에서 검증했다 (2026-09-21)

운영 서비스를 건드리지 않도록 EC2-A에 격리된 compose 프로젝트를 띄워, 가짜 명령이 아닌 **실제 docker와 curl**로 돌렸다. 확인 후 프로젝트는 지웠다.

| 시나리오 | 결과 |
| --- | --- |
| 정상 배포 | 헬스 통과 후 `.env`에 배포한 이미지가 기록된다. 선언과 실행이 일치한다 |
| 헬스 실패 | 제한 시간 뒤 직전 이미지로 되돌리고 서비스가 200을 회복한다. 종료코드 `1`로 실패를 알린다 |
| 이미지 변수 불일치 | 교체가 일어나지 않은 것을 잡아내고 변수 이름을 지목하며 실패한다 |

세 번째는 의도한 시험이 아니라 하네스 실수로 드러났다. compose가 이미지 변수를 읽지 않는 상태였는데, 교체가 없었으므로 헬스는 통과했다. 그 가드가 없었다면 **배포하지 않고 성공을 보고했을 것이다.**

# 서비스 배포·CI/CD 현재 상태

`S15P21C206-84` 작업의 인계 문서다. 절차와 근거는 담당 정본에 있고 여기에는 **현재 상태, 검증 경계, 남은 결정**만 둔다.

- 배포·롤백 절차와 초기 데이터: [EC2 서비스 배포](../../infra/service/README.md)
- CI/CD 정본: [CI/CD](../operations/cicd.md)
- 결정 근거와 날짜별 기록: [2026-09-18](../changes/2026-09-W3/2026-09-18.md), [2026-09-21](../changes/2026-09-W4/2026-09-21.md)

## 한 줄 요약

`planetory.space`로 서비스가 뜨고 Google·SSAFY 로그인이 동작한다. 다만 **지금 떠 있는 것은 EC2-A에서 손으로 빌드한 이미지**다. CI 파이프라인은 실행되고 있으나 **`build:*`가 레지스트리 push에서 실패해 레지스트리에 쓸 수 있는 이미지가 없다.** 원인과 필요한 조치는 「CI가 막힌 지점」에 있다.

## 실환경에서 확인된 것 (2026-09-18)

| 항목 | 상태 |
| --- | --- |
| 도메인 진입 | `planetory.space` → Cloudflare Tunnel → EC2-A. 외부 인바운드 개방 0개 |
| Tunnel connector | EC2-A 한 곳. 여러 곳에 붙여도 분산되지 않으므로 EC2-B에는 두지 않는다(D4) |
| 로그인 | Google·SSAFY 둘 다 성공. 회원 생성·튜토리얼 별 지급까지 동작 |
| DB | `service-db`(PostgreSQL 18.6), Flyway 마이그레이션 적용, 영속 볼륨 `planetory-service-db-data` |
| 별지도 | 데이터 조회까지 동작. 렌더러는 Dockerfile 기본값이 꺼짐이라 화면은 데이터 상태만 표시한다 |

**떠 있는 이미지는 `:local` 태그의 수동 빌드본이다.** CI가 만든 것이 아니라 커밋과의 대응이 추적되지 않는다. 파이프라인이 돌기 시작하면 레지스트리 이미지로 교체해야 한다.

## 손으로 넣은 데이터 (운영 값 아님)

로그인을 뚫기 위해 EC2-A DB에 직접 넣었다. **운영이 정한 값이 아니다.**

| 대상 | 내용 |
| --- | --- |
| 튜토리얼 1번 별 | TIC `261136679`. 임의로 고른 값 |
| 더미 별 | TIC `900000002`~`900000041` 40개와 그 발견 기록 |

더미 별은 `DELETE FROM star_unlocks WHERE tic_id >= 900000002;`로 지운다. 튜토리얼 별은 운영 TIC이 정해지면 교체한다. 빈 DB에서 가입이 막히는 조건과 시드 순서는 [EC2 서비스 배포](../../infra/service/README.md)에 있다.

## 계정 분리 적용 (2026-09-21 완료)

develop의 계정 분리(`S15P21C206-238`)가 들어오면서 배포 계약이 바뀌었고, EC2-A에 적용을 마쳤다. 절차는 [EC2 서비스 배포](../../infra/service/README.md)의 「계정 분리」 절을 따랐다.

| 항목 | 상태 |
| --- | --- |
| `planetory_service` 계정 | 기존 볼륨에 수동 생성. `planetory_app` 부여, `public` 스키마 `CREATE` 회수 |
| `.env`의 `DATABASE_PASSWORD` | 추가. `POSTGRES_PASSWORD`와 다른 값 |
| CI 배포 경로 `/home/deploy/planetory` | `.env`와 `service-db-init/`를 배치. `deploy` 계정 소유 |
| `docker compose config -q` | `deploy` 계정으로 통과 |

런타임 계정은 아직 테이블 권한이 없다. `planetory_app` GRANT가 V10~V18에 나뉘어 있고 EC2-A의 DB는 V9에서 멈춰 있기 때문이다. 다음 백엔드 배포에서 Flyway가 소유자로 마이그레이션을 돌리면서 채운다. 기동과 같은 트랜잭션 흐름 안에서 처리되므로 별도 조치는 필요 없다.

## CI가 막힌 지점

`build:frontend`는 이미지 빌드까지 성공하고 **레지스트리 push에서 실패한다.**

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

### push는 방화벽을 건드리지 않고 풀 수 있다

컨테이너에서 **레지스트리 컨테이너로 직접 가면 이미 통한다.** 같은 브리지 위라 호스트 `INPUT`을 거치지 않는다. Runner 설정의 호스트 매핑을 바꾸면 끝난다.

```toml
# /srv/gitlab-runner/config/config.toml
extra_hosts = ["<레지스트리 호스트>:<레지스트리 컨테이너 주소>"]
```

인증서는 이름으로 검증하므로 그대로 유효하고, push가 호스트 밖으로 나가지 않아 「이미지 레지스트리」가 적어둔 의도에 더 맞는다.

**한계.** 레지스트리 컨테이너 주소는 기본 브리지가 순서대로 준 값이라 레지스트리 컨테이너를 다시 만들면 바뀔 수 있다. 바뀌면 push가 같은 방식으로 다시 깨진다. 고정이 필요해지면 사용자 정의 네트워크에 네트워크 별칭으로 붙여 Docker DNS가 이름을 풀게 한다.

### 배포 job의 SSH 경로는 정상이다

컨테이너에서 EC2-A로 나가는 경로는 막혀 있지 않다. `tcpdump`로 보면 출발지가 EC2-B의 tailnet 주소로 masquerade되어 나가고 handshake가 완료된다. 컨테이너에서 `deploy` 계정으로 실제 SSH가 붙고, 배포 경로에서 `docker compose config -q`까지 통과한다.

따라서 `.remote-compose-deploy`의 "job 컨테이너의 연결은 Runner 호스트의 tailnet 신원으로 나간다"는 주석은 **맞다.** masquerade로 성립한다.

남은 차단은 레지스트리 push 하나뿐이다.

Runner 자체는 문제가 없다. `planetory-docker-runner`는 online이고 `amd64-docker` 태그와 `run_untagged=true`를 갖는다. CI 변수 `DEPLOY_USER`·`EC2_A_HOST`·`EC2_A_DEPLOY_PATH`·`REGISTRY_IMAGE_PREFIX`도 실제 서버 구성과 일치한다.

## CI/CD 구성

| job | 언제 | 무엇 |
| --- | --- | --- |
| `web:build` | 프론트 변경 | `npm run build` |
| `web:image` | `Dockerfile`·`nginx.conf` 변경 | 이미지 빌드 + 이미지 안에서 `nginx -t` |
| `backend:schema` | 마이그레이션 변경 | 버전 선점·중복, 되돌릴 수 없는 변경 |
| `backend:build` | 백엔드 소스 변경 | `./gradlew bootJar` |
| `backend:image` | `Dockerfile` 변경 | 이미지 빌드 |
| `build:*` | 기본 브랜치 | 레지스트리 이미지 빌드·푸시 |
| `deploy:*:ec2-a` | 기본 브랜치, 수동 버튼 | 교체 → 헬스 확인 → 실패 시 롤백 |

검증 job은 전부 `needs: []`라 파이프라인 시작과 동시에 병렬로 뜨고, 각자 자기 경로가 바뀔 때만 돈다.

넣지 않은 것과 이유. **CI는 배포를 막을 수 있는 것만 본다.**

- 포맷 검사 — 빌드·배포·동작과 무관하다. LF 기준으로 이미 16개 파일이 실패하기도 한다.
- 프론트 단위 테스트 — 파일 50개가 기능 담당자 소유다. 관문으로 세우면 한 사람의 테스트가 다른 사람의 MR을 막는다. 팀 합의가 먼저다.
- 백엔드 테스트 — `build.gradle`의 `test`가 PostgreSQL을 요구하는데 CI에서는 `startLocalDb`가 건너뛰어져 DB 없이 41개 클래스가 돈다. CI에 Postgres 서비스를 붙이는 일은 별도로 정한다.
- Playwright — 설정 24개를 직렬로 돌아 머지를 막는다.

## 검증 경계

**실행해서 확인한 것.** 프론트 `npm test` 343개와 `npm run build` 통과. 배포 스크립트는 가짜 `docker`·`curl`로 정상 배포, `up -d` 실패 시 롤백, 복수 서비스 교체, `curl` 부재 시 교체 전 중단, 덤프 실패 시 중단, 이미지 변수 오타 검출을 확인했다. 스키마 검사는 실제 git 저장소로 선점 차단·통과·건너뛰기를 확인했고, 되돌릴 수 없는 구문 6종 차단과 한국어 주석 오탐 없음을 확인했다. 이미지 빌드 두 개는 로컬 Docker에서 실제로 실행했다. 수정 전 `nginx.conf`로 `nginx -t`가 `host not found in upstream`으로 실패하는 것도 확인했다.

**실환경에서 확인한 것(2026-09-21).** GitLab 파이프라인은 실행되고 있다. develop의 `build:frontend`는 Runner를 잡고 dind에서 이미지 빌드까지 마치며 커밋 SHA 태그도 정확히 붙는다. `rules: changes` 판정과 dind 기동도 동작한다. EC2-A의 배포 경로는 `deploy` 계정으로 `docker compose config -q`를 통과하고, 레지스트리 인증서는 EC2-A에서 유효하다.

**확인하지 못한 것.** 레지스트리 push가 막혀 있어 **끝까지 성공한 파이프라인이 없다.** 따라서 배포 job은 한 번도 실행되지 않았고, 롤백이 진짜 서버에서 동작하는지도 여전히 미검증이다. 캐시 적중도 push 성공 이후에야 의미 있게 관찰된다.

## 남은 결정 (MR에서 확인)

1. **프론트 단위 테스트를 CI 관문으로 세울지.** 세우면 한 사람의 테스트 실패가 다른 사람의 MR을 막는다.
2. **`-- IRREVERSIBLE:` 방식이 적절한지.** 되돌릴 수 없는 마이그레이션을 금지하지 않고 파일에 근거를 요구한다. 세 배포로 나눌 수 있는지 한 번 묻는 것이 목적이다.
3. **EC2-B 배포 job 제거.** [CI/CD](../operations/cicd.md)가 이 티켓에 지정했고 실제로 지웠다. 확인이 필요하다.

## 이관한 결함

배포 과정에서 찾은 프론트·백엔드 결함은 담당자 버그 티켓으로 넘겼다. 이 티켓에서 고치지 않는다.

| 티켓 | 내용 |
| --- | --- |
| `S15P21C206-239` | nginx가 `/login/oauth2/`의 401·403·503을 모두 `authentication_failed`로 뭉쳐 의존성 장애가 인증 실패로 보인다 |
| `S15P21C206-240` | OAuth `failureHandler`가 실패 원인을 기록하지 않는다. 초기 데이터가 없을 때 가입이 막히는 증상도 진단이 어렵다 |

## 84에 남은 범위

Tunnel 진입과 프론트·백엔드 기동만 구현했다. 티켓의 나머지는 손대지 않았다.

- Redis runtime, 메모리 상한·eviction 정책
- health/readiness 설계(`S15P21C206-93`)
- 애플리케이션 계층 남용 제어 위치
- 단일 connector 지속 처리량·재연결 실측

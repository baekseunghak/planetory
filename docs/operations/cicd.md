# GitLab CI/CD

> 현재 파일은 배포 경계와 job 뼈대다. GitLab 파이프라인 `#184815`에서 정적 검사는 통과했으며 이미지 빌드·Registry push·실제 서버 배포는 별도로 검증한다.

Docker 개발·배포 방식은 [Docker 개발·배포 기준](docker.md), 서버 역할은 [시스템 아키텍처](../architecture/system-architecture.md)를 따른다.

## 파일 구성

```text
.gitlab-ci.yml
.gitlab/ci/
├─ common.yml
├─ apps/
│  ├─ frontend.yml
│  └─ backend.yml
└─ distributed-system/
   ├─ ingestion.yml
   ├─ spark.yml
   ├─ airflow.yml
   └─ publisher.yml
```

최상위 파일은 공통 규칙과 각 배포 단위의 job을 불러온다. 한 프로그램의 변경은 다른 프로그램을 재시작하지 않는다. 이미지 빌드는 변경된 프로그램만 하되, EC2-A 서비스(Frontend·Backend·잔차 Worker `derived-compute`)는 기준 브랜치 병합마다 빌드한다(아래 「배포 버튼 유지」).

## 실행 흐름

| 시점 | 실행 |
| --- | --- |
| Merge Request | Compose와 Docker 구성 검사 |
| 기준 브랜치 | 변경된 프로그램의 이미지 빌드·Registry push. Frontend·Backend·`derived-compute`는 변경과 관계없이 매번 빌드 |
| 배포 승인 | 선택한 서버에서 해당 이미지만 pull·재시작 |

소스 manifest가 없는 구성은 `rules:exists`로 빌드를 건너뛴다. 현재 기준은 Frontend `package-lock.json`, Backend `gradlew`, Python 구성의 `requirements.txt`다.

### 백엔드 테스트: MR 관문과 전체 실행 (S15P21C206-91)

MR은 가볍게, 전체 테스트는 병합 뒤에 돈다. 백엔드 테스트 전체는 약 8분인데 65%가 Testcontainers 테스트이고 dind가 필요하다. 마이그레이션은 회당 약 0.5초라 DB를 미리 만들어 두는 것으로는 줄지 않는다.

| job | 언제 | 무엇 | 시간 |
| --- | --- | --- | --- |
| `backend:build` | MR·브랜치에서 백엔드 변경 시 | 컴파일·`bootJar`와 스프링 앱·컨테이너를 띄우지 않는 테스트, 예외로 `GoldCatalogSchemaTest`(실제 PostgreSQL에서 앱 기동·`ddl-auto=validate`, 빈 스키마 전체 마이그레이션·재실행 0건, V1 업그레이드). postgres 서비스만 쓴다 | 약 2분 |
| `backend:test` | develop 병합 뒤 백엔드 변경 시 자동. MR·브랜치에서는 수동 | 전체 테스트. postgres 서비스와 dind, `amd64-docker` Runner | 약 8분 |

- `backend:build`가 뺄 테스트는 `apps/backend/build.gradle`의 `-PmrTests`가 테스트 소스에서 `@SpringBootTest`·`@Testcontainers`·`SpringApplication` 등을 찾아 고른다. 새 테스트도 저절로 분류되며 job 로그에 뺀 소스 수가 찍힌다. 남기는 테스트가 컨테이너를 쓰게 되면 Gradle이 설정 단계에서 멈춘다. `PlanetoryApplicationTests`는 Redis를 Testcontainers로 띄워 MR 관문에서 돌 수 없다.
- 예외로 남기는 스프링 테스트는 `build.gradle`의 `kept` 목록에 완전한 클래스 이름으로 적는다. dind 없이 돌고(Testcontainers·`GenericContainer`·`PostgreSQLContainer` 금지) 그 영역의 핵심 회귀인 것만 넣는다. 하나 늘 때마다 모든 MR이 10~15초씩 더 기다리므로 영역마다 대표 하나로 좁게 둔다. 목록의 이름에 맞는 소스가 없으면 Gradle이 설정 단계에서 멈춘다.
- `backend:image`는 `backend:build` 뒤에만 돈다. `build:backend`와 배포는 `backend:test`를 기다리지 않는다. `backend:test`는 `needs: []`로 바로 시작하고 마지막 `verify` stage에 있어 `needs`가 없는 `build:backend`의 대기 대상이 아니다.
- `backend:test`는 `interruptible: false`다. 다음 develop 병합이 파이프라인을 자동 취소하면 새 파이프라인에는 백엔드 변경이 없어 전체 테스트가 끝내 돌지 않기 때문이다.
- MR 관문에서 빠진 결함은 병합 뒤 `backend:test`에서 드러난다. 스키마·동시성·권한처럼 위험한 변경은 병합 전에 MR에서 `backend:test`를 수동으로 돌린다.
- **수동으로 돌린 전체 테스트(`backend:test`·`web:e2e`)는 실패해도 MR 파이프라인이 초록이다.** 수동 job은 `allow_failure: true`가 기본이라 관문만 통과하면 병합 가능해 보인다. 돌렸으면 job 결과를 직접 확인하고, 리뷰어도 위험한 변경의 MR에서 그 결과를 확인한다. `allow_failure: false`로 바꾸지 않는다. 시작하지 않은 수동 job이 파이프라인을 미완료로 잡아 MR마다 전체 실행을 강제하게 된다.
- CI에서만 테스트별 기본 5분 제한을 두고, `backend:test`는 10분이 넘으면 테스트 JVM 스레드 덤프를 로그에 남긴다. 시간 초과로 끝난 job은 JUnit 보고서가 올라가지 않아 덤프가 멈춘 위치의 유일한 단서다.

#### 부분 실행

실패한 테스트만 다시 돌리거나 CI 설정을 고치며 확인할 때는 전체 job을 수동으로 누르면서 변수로 대상을 좁힌다. 변수가 없으면 늘 전체가 돈다.

| job | 변수 | 예 |
| --- | --- | --- |
| `backend:test` | `BACKEND_TESTS`: Gradle `--tests` 패턴, 쉼표로 여럿 | `*SourceCardTest,com.planetory.backend.domain.gold.*` |
| `web:e2e` | `E2E_SUITES`: `test:e2e`의 스위트 이름, 쉼표로 여럿(`test:` 생략 가능) | `detail,search` |

- 부분 실행은 로그 첫 줄에 `부분 실행(병합 판단 근거 아님)`을 찍는다. 병합 판단은 전체 실행 결과로 한다.
- 통과한 테스트의 결과를 캐싱해 건너뛰지 않는다. Gradle 결과 캐시는 코드만 입력으로 보고 DB 서비스·dind·이미지 같은 CI 환경 변화를 보지 못해, CI 설정을 고칠 때 실패를 가린다.
- 스테이징(develop → `main` MR)과 운영 배포 단계에서는 부분 실행도 쓰지 않고 항상 전체를 돌린다.

### 프론트 테스트: MR 관문과 브라우저 테스트 (S15P21C206-91)

| job | 언제 | 무엇 | 시간 |
| --- | --- | --- | --- |
| `web:build` | MR·브랜치에서 프론트 변경 시 | `npm run build`(타입 검사·번들·프로덕션 위생)와 단위 테스트 `npm test`(448개) | 약 35초 |
| `web:e2e:smoke` | develop 병합 뒤 프론트 변경 시 자동. MR·브랜치에서는 수동 | `test:e2e:smoke`: `test:production`·`test:docker-defaults`·`test:auth`. 배포 산출물 기동과 로그인 흐름 | 약 2분 + 준비 |
| `web:e2e` | 수동 | `test:e2e` 전체(스위트 21개, 505개) | 약 26분 |

- 브라우저 job은 Playwright 공식 이미지(`@playwright/test`와 같은 버전)를 쓰고 `verify` stage에서 `needs: []`로 돈다. 이미지 빌드·배포를 막지 않으며 `interruptible: false`다.
- 전체는 `apps/frontend/scripts/run-e2e-ci.mjs`가 병렬로 돌린다. `test:browser`(253개)는 fixture 서버가 상태를 갖지 않아 스위트 안에서 worker 2개로, 나머지는 서버 메모리 상태를 `/reset`으로 되돌리는 스위트가 있어 안에서는 순서대로 두고 스위트끼리 2개씩 동시에 돈다. 스위트 목록은 `package.json`의 `test:e2e` 한 곳에 있다.
- 실측(2026-09-25): 직렬 약 40분(추정), 동시 3 약 22분이지만 CPU 경합으로 WebGL·드래그 테스트가 흔들렸다. 동시 2는 약 26분이고 경합 실패가 사라졌다. 빌드 노드 vCPU 4개를 다른 job과 나눠 쓰므로 동시 2가 기본이다(`E2E_LANES`).
- 병렬 실행 중 나가는 연결이 Linux 임시 포트(32768~60999)에서 fixture 서버 포트를 먼저 잡을 수 있다. 로그에 `is already in use`가 있을 때만 그 스위트를 한 번 다시 돌린다. 테스트 실패는 재시도하지 않는다.
- 스위트 출력은 섞이지 않게 끝날 때 한 번에 찍는다. job이 시간 초과로 죽으면 돌던 스위트의 출력이 남지 않으므로, 실행기가 제한 시간(`CI_JOB_TIMEOUT`) 2분 전에 진행 중인 스위트마다 최근 출력 60줄을 찍는다. 백엔드 `backend:test`의 스레드 덤프에 해당한다.
- 수동 `web:e2e`도 실패해도 MR이 초록이다. 결과 확인 원칙은 백엔드 항목과 같다.
- **`@gpu` 태그:** 실제 WebGL 픽셀을 읽어 검증하는 테스트는 제목 끝에 `@gpu`를 붙여 표시한다(Playwright 제목 태그). 빌드 노드에는 GPU가 없어 SwiftShader가 다른 값을 내므로 CI 전체 실행(`run-e2e-ci.mjs`)에서만 `--grep-invert=@gpu`로 뺀다. 로컬 `npm run check`에서는 그대로 돈다. 현재 `galaxy.spec.ts`의 GPU 픽셀 투영 1건이다(CI에서 밝기 1, 기대 > 40). 렌더링 결과를 검증하지 않는 테스트에는 붙이지 않는다.
- **CI에서 늘 실패하는 8건(2026-09-25, 프론트 담당 확인 중):** 직렬·동시 2·동시 3 모두에서 실패했다. GPU 픽셀 문제가 아니어서 `@gpu`로 빼지 않는다.
  - `interaction.spec.ts` 5건: 휠·드래그·Home 키 뒤에도 카메라 값이 처음 값 그대로(줌 4, 이동 0.12)이고 툴팁·재시도 클릭이 반응하지 않는다. CI 헤드리스에서 캔버스 입력이 처리되지 않는 것으로 보인다.
  - `detail/viewport.spec.ts:8`: 30초 시간 초과.
  - `search.spec.ts:26`(빈 결과 안내가 뜨지 않음), `:124`(스크롤 대상 링크가 DOM에서 분리됨).
  - 정리 전까지 `web:e2e`는 빨갛게 끝나며, 스테이징 관문 편입은 이 정리 뒤에 S15P21C206-92에서 정한다.

## 독립 배포

- Frontend·Backend: 서비스 인스턴스는 EC2-A 1개다. EC2-A job만 수동 실행한다. EC2-B job은 `S15P21C206-84`에서 제거했다.
- 잔차 Worker(`derived-compute`, S15P21C206-88): EC2-A에 `deploy:derived-compute:ec2-a`로 배포한다. HTTP 헬스 경로가 없어 교체만 하고 자동 롤백은 하지 않는다. 첫 배포 순서는 [서비스 배포 안내](../../infra/service/README.md) 「첫 배포 절차」를 따른다.
- Ingestion: GCP Node 2~6에 같은 이미지를 각각 pull할 수 있다.
- Spark submit·Airflow·Publisher: GCP Node 1에 배포한다. YARN executor는 NodeManager가 실행하므로 Spark standalone Master/Worker 컨테이너를 추가하지 않는다. Publisher 이미지는 EC2-A의 Gold 목업 적재(`gold-mock` profile)에서도 같은 이미지로 돈다(`S15P21C206-262`).
- 이미지는 한 번 만들고 모든 대상 노드가 동일한 commit SHA 태그를 사용한다.
- 운영 Compose는 서버의 `.env`에서 다른 서비스의 현재 이미지와 실행 설정을 읽는다.

배포 job은 Compose 파일을 SSH로 복사한 뒤 `config`, `pull`, `up --no-deps` 순서로 실행한다. 수집·Spark·Publisher처럼 요청 시 실행하는 이미지는 `pull`까지만 수행한다.

서비스 인스턴스가 1개이므로 Backend 재시작은 전면 중단이다. 다만 세션은 EC2-A `redis-session`에 있으므로 그 컨테이너를 함께 재시작하지 않으면 로그인은 유지된다(구현 `S15P21C206-237` 전까지는 메모리 세션이라 전원 재로그인이 발생한다). 무중단 배포를 목표로 두지 않으며 진입·장애 경계는 [EC2 서비스 진입·장애 전환 경계](../architecture/ec2-service-entry-failover.md)를 따른다.

### 배포 버튼 유지 (S15P21C206-261)

기준 브랜치에서 Frontend·Backend는 `rules:changes` 없이 매번 빌드하고 두 배포 job을 띄운다. **배포할 때는 최신 develop 파이프라인의 버튼을 누른다.**

`changes`로 거르면 배포가 조용히 누락된다. 그 앱을 바꾸지 않은 병합의 파이프라인에는 배포 버튼이 없고, 그 앱을 바꾼 이전 파이프라인은 새 커밋에 자동 취소된다(`auto_cancel_pending_pipelines: enabled`). 기본 취소 방식은 `interruptible: false`인 job이 **이미 시작된** 파이프라인만 남기므로, 누르지 않은 수동 배포는 함께 취소된다. 2026-09-23 백엔드 병합 4건이 빌드만 되고 배포되지 못한 채 운영이 `e510d1da`에 머물렀다. 취소는 실패가 아니라 파이프라인이 빨갛게 뜨지 않는다.

옛 버튼은 GitLab이 막는다. 배포 job에 `environment: ec2-a`를 두면 프로젝트 설정 "옛 배포 job 막기"(`ci_forward_deployment_enabled`)가 걸려, 더 새 배포가 있는 상태에서 옛 파이프라인의 배포 job을 실패시킨다. environment는 **노드 하나**다. 배포 job이 노드 공용 `compose.yaml`을 함께 올리므로, 서비스별로 나누면 옛 백엔드 버튼이 옛 compose를 올려도 "백엔드로는 최신"이라 막히지 않는다. `resource_group`을 노드 단위로 두는 것과 같은 이유다.

**막히는 것은 한 번도 실행하지 않은 옛 manual job의 Play다.** 2026-09-26 파이프라인 `222890`의 `deploy:backend:ec2-a`(더 새 `222918`이 배포된 뒤)를 Play하자 403으로 거절됐고 job은 `manual`로 남았다(`S15P21C206-262`).

**Retry는 막히지 않는다.** `ci_forward_deployment_rollback_allowed: true`에서는 옛 배포 job의 Retry가 **예전에 성공했든 아니든** 롤백으로 허용된다. 2026-09-26 `220924`의 취소된 `deploy:frontend:ec2-a`를 Retry하자 정식 배포(21716)로 기록되며 옛 Frontend `e9835da5`가 운영에 올라갔다. `222444`의 성공 job을 Retry해 약 1분 뒤 되돌렸다. 따라서 취소·실패·성공한 옛 배포 job의 **Retry 버튼은 곧 되돌리기 버튼**이다. 의도한 되돌리기에만 누른다.

**Retry 되돌리기는 이미지만 되돌리지 않는다.** 같은 시험에서 두 가지 부작용이 났다(`S15P21C206-88` 세션 확인).

- **서버 `compose.yaml`이 그 커밋 판으로 덮인다.** 배포 job은 서비스와 상관없이 자기 커밋의 compose를 통째로 올린다. `222444` Retry가 `a8fb6667`의 compose를 올려, 앞서 `222918`로 배포한 `derived-compute` 서비스와 Backend의 `DERIVED_COMPUTE_URL` 전달 줄이 빠졌다(01:19~02:51 KST). 컨테이너는 다시 만들지 않아 동작했지만, 그 사이 Backend가 재생성됐다면 잔차 실행기가 꺼지고 Worker는 compose 밖 고아 컨테이너가 됐다. `222918`의 성공 job(`deploy:derived-compute:ec2-a`)을 Retry해 되살렸다.
- **최신 파이프라인의 버튼이 막힌다.** 모든 배포 job이 environment `ec2-a` 하나를 쓰므로 옛 job의 Retry가 더 새 deployment 기록이 된다. 그 뒤 실제로는 더 새 `222918`의 미실행 `deploy:frontend:ec2-a`가 옛 job으로 취급돼 `blocked`가 됐다. 옛 버튼은 Retry로 통과하고 최신 버튼은 막히는, 보호가 거꾸로 걸린 상태다. 이때 최신 판을 올리려면 새 파이프라인이 필요하다.

대책 후보(미결정): 서비스별 environment 분리, 서버에 올라간 것보다 옛 커밋의 compose를 올리지 않게 막기, 되돌리기는 이미지만 바꾸고 compose는 유지하기.

**첫 후보는 261 결정과 배치된다.** 단일 environment는 바로 compose 공유 때문에 261에서 고른 것이다(`.gitlab/ci/common.yml` `.deploy-ec2-a` 주석). 서비스별로 나누면 옛 백엔드 버튼이 옛 compose를 올려도 "백엔드로는 최신"이라 통과하는 길이 다시 열린다. compose 덮어쓰기는 Retry만이 아니라 옛 커밋을 어떤 경로로든 배포하면 생기는 일이므로(`scp "$DEPLOY_COMPOSE_SOURCE"`), 원인을 건드리는 것은 둘째·셋째 후보다. 최신 버튼이 막힌 부작용은 261이 얻은 보호의 대가로 같은 선택의 양면이다.

이 규칙 이전(2026-09-23 전) 파이프라인의 job은 environment가 없어 배포로 세지 않는다. 그 job을 Retry하면 보호 없이 옛 compose가 올라간다.

Retry까지 막으려면 `ci_forward_deployment_rollback_allowed`를 끈다. 그러면 GitLab 버튼으로 하는 되돌리기도 막히고 **의도한 되돌리기는 서버 수동 절차만 남는다.** `deploy.sh`의 자동 롤백은 새 이미지 교체가 실패했을 때만(`replace "$IMAGE" || rollback`) 불리므로 "잘 떴지만 되돌리고 싶다"에는 쓸 수 없다. Play는 이미 outdated 보호로 막혀 있다.

끌지는 정하지 않았다. **`S15P21C206-93`에서 함께 정한다.** 93이 `main` 병합 뒤 자동 CD와 실패 시 직전 SHA 롤백을 넣으면, 실패 경로는 `deploy.sh`와 93이 덮고 남는 것은 의도한 되돌리기 하나다. 그때 그 용도의 경로(위 대책 후보 포함)를 따로 두고 이 설정을 끄는 것이 순서다.

대가로 병합마다 빌드가 Backend 약 2분·Frontend 약 45초 늘고 레지스트리 태그가 쌓인다. 태그 정리는 EC2-B의 매일 cron이 배포 중인 이미지를 보호한 채 한다([EC2-B](../../infra/service/ec2-b/README.md) 「매일 정리」).

**GCP 노드(Ingestion·Spark·Airflow·Publisher)는 같은 결함이 남아 있다(S15P21C206-262에서 방식만 정함).** 파이프라인 `220048`에서 ingestion 배포 버튼 5개가 취소된 실례가 있다. EC2-A처럼 매 병합 빌드로 풀지 않는다. Airflow·Spark 이미지는 크고 빌드가 무거워 비용이 다르다. 대신 빌드를 취소되지 않게 하고(`interruptible: false`) 노드별 `environment`로 옛 버튼을 막는 쪽이 맞다. 다만 이 방식은 자동 취소 방식(`workflow:auto_cancel:on_new_commit: interruptible`)을 바꿔야 해서 파이프라인 전체와 EC2-A 동작에 걸린다. 별도 Task로 설계한다.

## 필요한 GitLab 변수

| 구분 | 변수 |
| --- | --- |
| 공통 SSH | `DEPLOY_USER`(전용 배포 계정 이름). SSH 키 변수는 두지 않는다 |
| EC2 | `EC2_A_HOST`(Tailscale IP), `EC2_A_DEPLOY_PATH`. `EC2_B_*`는 파일에 남아 있으나 사용하지 않는다 |
| GCP CI 연결 | `GCP_NODE_1_HOST`~`GCP_NODE_6_HOST`(Tailscale IP), `GCP_NODE_1_DEPLOY_PATH`~`GCP_NODE_6_DEPLOY_PATH` |
| GCP 서버 `.env` | `GCP_ZONE`, `GCP_NODE_1_PROJECT`~`GCP_NODE_6_PROJECT` |
| 분산 이미지 | `SPARK_BASE_IMAGE`, `AIRFLOW_BASE_IMAGE` |
| 레지스트리 | `REGISTRY_IMAGE_PREFIX` (`<레지스트리 호스트>:<포트>/<네임스페이스>`) |
| Node 1 Airflow | 서버 `.env`의 `AIRFLOW_DB_PASSWORD`, `AIRFLOW_DATABASE_URL`, `AIRFLOW_FERNET_KEY`, `AIRFLOW_WEBSERVER_SECRET_KEY`, `AIRFLOW_DB_PATH`, `AIRFLOW_LOGS_PATH` |

변수는 Protected·Masked 범위를 적용한다. 레지스트리는 tailnet 내부 전용이라 노드에 읽기 전용 자격 증명을 배포하지 않는다.

## 이미지 레지스트리

`lab.ssafy.com`은 Container Registry가 비활성이라 GitLab 내장 `CI_REGISTRY*` 변수가 주입되지 않는다. 대신 빌드 노드에서 자체 레지스트리(`registry:3`)를 운영한다. 근거와 경위는 [S15P21C206-226](https://ssafy.atlassian.net/browse/S15P21C206-226)을 따른다.

| 항목 | 값 |
| --- | --- |
| 호스트 | 빌드 노드. Tailscale IP에만 바인딩해 tailnet 외부로 열지 않는다 |
| 전송 | `tailscale cert`로 발급한 MagicDNS 이름의 정식 인증서로 HTTPS 서빙 |
| 인증 | 없음. tailnet 접근 자체가 경계다 |
| 저장 경로 | 빌드 노드의 별도 디렉터리 |
| 삭제 | `REGISTRY_STORAGE_DELETE_ENABLED=true`. 태그 정리는 `infra/service/ec2-b/registry-prune.sh`를 따른다 |

정식 인증서를 쓰므로 배포 노드에 `insecure-registries` 설정이 필요 없다. 인증서는 만료 전에 `tailscale cert`를 다시 실행하고 레지스트리 컨테이너를 재시작해 갱신한다. 갱신을 놓치면 빌드와 배포가 함께 멈춘다.

이미지 태그는 커밋 SHA다. 커밋마다 쌓이므로 저장소별로 최신 10개만 남기고 정리한다. 최신 판단은 이미지 config의 생성 시각으로 하며, 시각을 읽지 못하면 그 저장소는 건드리지 않는다. 배포 중인 SHA는 `--in-use`로 보호하고, 매니페스트 삭제만으로는 용량이 줄지 않으므로 빌드가 없는 시간에 가비지 수집을 함께 돌린다. 절차와 주의점은 [EC2-B 설정](../../infra/service/ec2-b/README.md)을 따른다.

빌드한 이미지에 비밀값이 섞였는지는 같은 문서의 `image-secret-scan.sh`로 검사한다. 레지스트리가 tailnet 내부 전용이라 외부 노출 위험은 낮지만, 이미지에 박힌 비밀은 레이어에 영구히 남으므로 공개 범위와 무관하게 점검한다.

레지스트리와 빌더를 같은 노드에 둬서 push가 tailnet을 타지 않는다. tailnet ACL이 태그 사이 통신을 전부 허용하지는 않으므로, 다른 노드를 빌더로 쓰려면 그 태그에서 레지스트리 포트가 열려 있는지 먼저 확인한다.

## Runner 구성

**현재 Runner는 한 대다(2026-09-22 확인).** 빌드 노드의 `planetory-docker-runner` 하나가 `amd64-docker` 태그를 갖고 `run_untagged=true`로 등록되어 태그 job과 무태그 job을 모두 처리한다. 아래 표는 목표 배치이며 aarch64 CI 노드는 아직 등록되지 않았다.

| Runner | 아키텍처 | 태그 | 맡는 job | 상태 |
| --- | --- | --- | --- | --- |
| 빌드 노드 | x86_64 | `amd64-docker` | `.docker-build`를 확장하는 `build:*`, Testcontainers에 dind가 필요한 `backend:test` | 등록됨. 현재 전체 job 처리 |
| CI 노드 | aarch64 | 없음(untagged 수행) | `validate:*`, `deploy:*` | 미등록 |

태그 분리는 CI 노드를 붙이는 시점에 의미를 갖는다. 지금은 한 대가 둘 다 받으므로 태그가 job을 가르지 않는다.

### 동시 실행

Runner의 `concurrent`가 job 동시 실행 수를 정한다. Runner 등록 수와 다른 값이며, **한 대가 여러 job을 동시에 처리한다.** Runner는 job을 실행하는 셸이 아니라 job마다 컨테이너를 새로 띄우는 관리 프로세스다. 컨테이너 이름의 `concurrent-<n>`이 그 슬롯 번호다.

현재 값은 `3`이다. 등록 기본값 `1`로는 같은 stage의 job이 전부 줄을 섰다. 실측 비교는 아래와 같다.

| | `concurrent = 1` | `concurrent = 3` |
| --- | --- | --- |
| 동시 실행 최대 | 1개 | 3개 |
| 벽시계 | 202초 | 126초 |
| job 소요 합계 | 201초 | 250초 |

같은 MR 파이프라인의 job 8개를 기준으로 쟀다. 벽시계는 38% 줄었고 job 하나하나는 느려졌다. 코어 4개를 세 job이 나눠 쓰기 때문이며, 전체 대기 시간이 목적이므로 감수한다.

`4`로 올리지 않는다. 빌드 노드는 vCPU 4개이고 dind와 레지스트리가 같은 노드에 있다. 꽉 채우면 경합이 커져 벽시계 이득이 줄고 레지스트리 응답도 밀린다.

벽시계의 하한은 가장 긴 job 하나다. 현재 `backend:image`가 약 106초이며 그보다 짧아지지 않는다. 더 줄이려면 병렬화가 아니라 이미지 레이어 캐시를 붙여야 한다.

배포 대상이 전부 `linux/amd64`라 이미지 빌드는 x86_64 Runner에서만 실행한다. `.docker-build`에 `tags: [amd64-docker]`를 둔 이유이며, 이 태그를 떼면 job이 aarch64 Runner로 가서 에뮬레이션 설정 없이 실패한다. 빌드 Runner는 dind를 쓰므로 `privileged`가 필요하고, 컨테이너 안에서는 MagicDNS가 해석되지 않으므로 Runner 설정에 레지스트리 이름의 `extra_hosts`를 둔다.

`deploy:*`는 대상 서버에 SSH로만 접속하고 이미지는 대상 서버가 직접 pull한다. 따라서 CI 노드에는 레지스트리 접근 권한이 필요 없다.

## 배포 접속

대상 노드는 `tailscale up --ssh` 상태라 **tailscaled가 22번을 직접 처리한다.** 그래서 `authorized_keys`가 아니라 tailnet 신원으로 인증하며, SSH 키를 배포해도 쓰이지 않는다. job 컨테이너에서 나가는 연결은 Runner 호스트의 tailnet 신원으로 보이고, tailnet ACL의 `ssh` 규칙이 배포 계정을 허용해야 통과한다. 규칙이 없으면 `tailnet policy does not permit you to SSH to this node`로 거부된다.

접속 계정은 CI 전용 `deploy` 하나다. 사람의 관리 계정을 쓰지 않으므로 키·권한을 회수할 때 사람 계정을 건드리지 않아도 되고 접속 주체가 로그에서 갈린다. 이 계정에 `sudo`를 주지 않는다. 배포에 필요한 권한은 `docker` 그룹뿐이다. 계정 생성은 [provision-deploy-user.sh](../../infra/provisioning/provision-deploy-user.sh)가 맡는다.

**사람의 수동 배포도 `deploy`로 한다(2026-09-23 ACL 변경).** 사람 PC의 tailnet 신원에도 `deploy` SSH를 허용했다. 전에는 `ubuntu`로 들어가 `sudo -u deploy`로 실행했다. 이제 `tailscale ssh deploy@ec2-a`로 바로 `/home/deploy/planetory`에서 `deploy.sh`를 돌린다. 계정만으로는 CI 배포와 사람 배포가 갈리지 않으므로 주체는 Tailscale SSH 접속 기록의 tailnet 신원으로 구분한다. 허용 범위는 tailnet 정책 파일이 정본이다.

**접근 차단은 ACL에서 한다.** 규칙 한 줄을 지우면 모든 노드에서 동시에 끊긴다.

`DEPLOY_HOST`에는 MagicDNS 이름이 아니라 **Tailscale IP**를 넣는다. 컨테이너 안에서는 MagicDNS가 해석되지 않는다.

이미지는 `docker build`와 `docker push`로 만든다. buildx를 쓰면 container driver가 dind 안에 buildkit 컨테이너를 따로 띄우고 push를 그 컨테이너가 수행하는데, Runner의 `extra_hosts`가 거기까지 닿지 않아 레지스트리 이름 해석에 실패한다. 빌드는 성공하고 push만 실패하는 형태로 나타나 원인을 찾기 어렵다. 빌드 Runner가 x86_64라 교차 빌드가 필요 없어 buildx를 쓸 이유도 없다.

## 도입 전 확인

- 기준 브랜치가 `main`인지 `master`인지
- Spark·Airflow 기반 이미지의 amd64 지원
- 각 서버의 Docker Compose, `.env`, 볼륨 경로와 방화벽
- 애플리케이션별 health endpoint와 실제 되돌리기 절차

HDFS 삭제, NameNode 초기화, 전체 노드 동시 재시작과 Gold 공개 전환은 일반 애플리케이션 배포 job에 넣지 않는다.

Hadoop/YARN 데몬은 호스트에서 실행한다. 일반 애플리케이션 배포와 분리해 다음 순서로 준비한다.

1. `S15P21C206-72`에서 OpenJDK 17과 Hadoop 3.5.0을 설치하고 `config/hadoop/`의 공통 파일을 `/etc/hadoop/`에 배포한다.
2. HDFS systemd 서비스를 배치한 뒤 [운영 절차](../../infra/distributed-system/README.md)에 따라 QJM·NameNode·DataNode를 초기화하고 RF2 표본을 검증한다.
3. `S15P21C206-73`에서 노드 역할에 맞는 `config/yarn/` 파일과 YARN systemd 서비스를 배포한다.
4. ResourceManager·NodeManager를 시작하고 Spark 3.5.5 sample application을 실행한다.

신규 NameNode format과 Standby bootstrap은 한 번만 수동 수행한다. `initializeSharedEdits`는 기존 단일 NameNode를 HA로 전환할 때만 사용한다.

GCP 자원 생성 스크립트는 `infra/provisioning/gcp/scripts/`에 있으며 CI에서 실행하지 않는다.

`S15P21C206-73`은 YARN XML·`scripts/*yarn*`·`validate.py` 변경의 로컬 검사와 실환경 검증까지만 완료했다. YARN XML 변경이 `validate:hadoop-config`를 고르고 Linux Runner에서 실패·통과하는 증거는 [S15P21C206-91](https://ssafy.atlassian.net/browse/S15P21C206-91)에서 남겼다(아래 「설정·계약 검사」).

- CI의 XML·Compose 검사는 VM 생성이나 실제 클러스터 동작을 검증하지 않는다.
- 설정 파일만 수정해도 validate는 실행된다.
- 현재 deploy 규칙은 애플리케이션 소스 변경을 기준으로 한다.
- Hadoop XML 배포는 운영 절차로 수행한다.

### 설정·계약 검사 (S15P21C206-91)

| job | 언제 | 무엇 |
| --- | --- | --- |
| `validate:compose` | Compose·Dockerfile·CI 파일 변경 | 루트·control-plane·worker Compose `config -q` |
| `validate:hadoop-config` | Hadoop·YARN XML, `workers`, `scripts/*yarn*`, `validate.py` 변경 | `infra/distributed-system/validate.py` |
| `validate:contracts` | `contracts/` 변경 | Gold 게시 계약·배열/레코드 checksum 벡터·온라인 파생 계산 계약의 검사기(Node 표준 모듈만 사용) |

- 세 job 모두 `validate` 단계에 `needs` 없이 있다. 기준 브랜치의 이미지 빌드 `build:*`는 `build` 단계에 `needs` 없이 있어, 같은 파이프라인의 검사가 하나라도 실패하면 시작하지 않는다. MR·브랜치 파이프라인에는 `build` 단계 job이 없고, `*:image`는 push하지 않는 확인용 빌드라 `needs: []`로 검사와 나란히 돈다. 거기서는 검사 실패가 파이프라인 실패로 드러난다.
- 계약 검사는 fixture와 검사기가 서로 맞는지만 본다. Publisher·Backend·Worker 코드가 계약을 따르는지는 각 컴포넌트의 테스트가 맡는다.
- 2026-09-25 확인: 브랜치 파이프라인 `#222677`(통과) → `#222681`(실패) → `#222683`(되돌림, 통과). `#222681`은 Gold fixture의 배열 checksum 한 글자, YARN `worker.xml`의 `yarn.nodemanager.resource.memory-mb`, worker Compose의 알 수 없는 키를 일부러 틀린 커밋 `64f58477`이다. `validate:contracts`(`CHECKSUM_MISMATCH`), `validate:hadoop-config`(assert), `validate:compose`(`Additional property ... is not allowed`)가 각각 실패했다. 실행 Runner는 `planetory-docker-runner`(GitLab Runner API 기준 `linux`/`amd64`, 태그 `amd64-docker`)다.
- 기준 브랜치에서 `build:*`가 실제로 멈추는 것은 develop을 깨야 볼 수 있어 확인하지 않았다. 위 stage 구조(검사는 `validate`, 이미지 빌드는 `needs` 없는 `build`)로 판단한다.
- PowerShell 스크립트는 CI에서 돌리지 않는다(S15P21C206-91 범위 정정). 운영자가 직접 실행하는 스크립트라 배포 경로 밖이다. mock으로 원격 자원을 건드리지 않는 `test-*.ps1` 8개는 스크립트를 바꾼 사람이 로컬에서 `pwsh -File`로 실행한다.

### data-platform 테스트 (S15P21C206-91)

| job | 언제 | 무엇 |
| --- | --- | --- |
| `validate:tess-hdfs-loader` | `ingestion/hdfs/**/*.py`·적재 스크립트 변경 | HDFS 적재기 31개, Sector 수용 5개 |
| `validate:data-platform` | airflow·ingestion·publisher 변경 | airflow 18개, ingestion `tests/` 42개, publisher 알림 3개. 표준 라이브러리만 쓴다 |
| `validate:astro-kernel` | `libs/astro-kernel`·spark·publisher 변경 | 커널 333개, spark 22개, publisher 목업 적재 7개. 의존성은 커널의 `uv.lock`으로 고정한다 |

- 세 job 모두 `validate` 단계라 실패하면 같은 파이프라인의 기준 브랜치 이미지 빌드가 시작하지 않는다(위 「설정·계약 검사」).
- Worker(`apps/derived-compute`) 테스트는 `derived-compute:test`(S15P21C206-88)가 맡는다.
- 새 테스트 파일을 만들면 해당 job의 `script`에 넣는다. `discover`로 도는 airflow·ingestion `tests/`는 저절로 포함된다.

현재 deploy job의 이미지 변수는 SSH 세션에만 export된다. 후속 실행과 롤백에서 같은 버전을 쓰려면 대상 서버의 `.env`에 해당 이미지 SHA를 반영해야 한다. 이를 자동화하고 서버별 동시 배포 잠금·health 검사·실패 시 이전 버전 복원을 추가하는 것은 실제 배포 전 남은 작업이다.

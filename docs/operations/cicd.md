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

최상위 파일은 공통 규칙과 각 배포 단위의 job을 불러온다. 한 프로그램의 변경은 다른 프로그램을 재시작하지 않는다. 이미지 빌드는 변경된 프로그램만 하되, EC2-A 서비스(Frontend·Backend)는 기준 브랜치 병합마다 빌드한다(아래 「배포 버튼 유지」).

## 실행 흐름

| 시점 | 실행 |
| --- | --- |
| Merge Request | Compose와 Docker 구성 검사 |
| 기준 브랜치 | 변경된 프로그램의 이미지 빌드·Registry push. Frontend·Backend는 변경과 관계없이 매번 빌드 |
| 배포 승인 | 선택한 서버에서 해당 이미지만 pull·재시작 |

소스 manifest가 없는 구성은 `rules:exists`로 빌드를 건너뛴다. 현재 기준은 Frontend `package-lock.json`, Backend `gradlew`, Python 구성의 `requirements.txt`다.

## 독립 배포

- Frontend·Backend: 서비스 인스턴스는 EC2-A 1개다. EC2-A job만 수동 실행한다. EC2-B job은 `S15P21C206-84`에서 제거했다.
- Ingestion: GCP Node 2~6에 같은 이미지를 각각 pull할 수 있다.
- Spark submit·Airflow·Publisher: GCP Node 1에 배포한다. YARN executor는 NodeManager가 실행하므로 Spark standalone Master/Worker 컨테이너를 추가하지 않는다.
- 이미지는 한 번 만들고 모든 대상 노드가 동일한 commit SHA 태그를 사용한다.
- 운영 Compose는 서버의 `.env`에서 다른 서비스의 현재 이미지와 실행 설정을 읽는다.

배포 job은 Compose 파일을 SSH로 복사한 뒤 `config`, `pull`, `up --no-deps` 순서로 실행한다. 수집·Spark·Publisher처럼 요청 시 실행하는 이미지는 `pull`까지만 수행한다.

서비스 인스턴스가 1개이므로 Backend 재시작은 전면 중단이다. 다만 세션은 EC2-A `redis-session`에 있으므로 그 컨테이너를 함께 재시작하지 않으면 로그인은 유지된다(구현 `S15P21C206-237` 전까지는 메모리 세션이라 전원 재로그인이 발생한다). 무중단 배포를 목표로 두지 않으며 진입·장애 경계는 [EC2 서비스 진입·장애 전환 경계](../architecture/ec2-service-entry-failover.md)를 따른다.

### 배포 버튼 유지 (S15P21C206-261)

기준 브랜치에서 Frontend·Backend는 `rules:changes` 없이 매번 빌드하고 두 배포 job을 띄운다. **배포할 때는 최신 develop 파이프라인의 버튼을 누른다.**

`changes`로 거르면 배포가 조용히 누락된다. 그 앱을 바꾸지 않은 병합의 파이프라인에는 배포 버튼이 없고, 그 앱을 바꾼 이전 파이프라인은 새 커밋에 자동 취소된다(`auto_cancel_pending_pipelines: enabled`). 기본 취소 방식은 `interruptible: false`인 job이 **이미 시작된** 파이프라인만 남기므로, 누르지 않은 수동 배포는 함께 취소된다. 2026-09-23 백엔드 병합 4건이 빌드만 되고 배포되지 못한 채 운영이 `e510d1da`에 머물렀다. 취소는 실패가 아니라 파이프라인이 빨갛게 뜨지 않는다.

옛 버튼은 GitLab이 막는다. 배포 job에 `environment: ec2-a`를 두면 프로젝트 설정 "옛 배포 job 막기"(`ci_forward_deployment_enabled`)가 걸려, 더 새 배포가 있는 상태에서 옛 파이프라인의 배포 job을 실패시킨다. environment는 **노드 하나**다. 배포 job이 노드 공용 `compose.yaml`을 함께 올리므로, 서비스별로 나누면 옛 백엔드 버튼이 옛 compose를 올려도 "백엔드로는 최신"이라 막히지 않는다. `resource_group`을 노드 단위로 두는 것과 같은 이유다.

막히지 않는 경우가 둘 있다.

- **이 규칙 이전 파이프라인의 job.** environment가 없어 배포로 세지 않는다. 2026-09-23 이전에 취소된 배포 job을 Retry하면 옛 compose가 올라간다.
- **예전에 성공한 배포 job의 재실행.** `ci_forward_deployment_rollback_allowed: true`라 롤백 목적으로 허용된다. 의도한 되돌리기에만 쓴다.

대가로 병합마다 빌드가 Backend 약 2분·Frontend 약 45초 늘고 레지스트리 태그가 쌓인다. GCP 노드(Ingestion·Spark·Airflow·Publisher)는 같은 구조를 아직 쓰지 않는다.

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
| 빌드 노드 | x86_64 | `amd64-docker` | `.docker-build`를 확장하는 `build:*`, Testcontainers에 dind가 필요한 `backend:build` | 등록됨. 현재 전체 job 처리 |
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

`S15P21C206-73`은 YARN XML·`scripts/*yarn*`·`validate.py` 변경의 로컬 검사와 실환경 검증까지만 완료했다. 정확한 Linux Runner 경로 선택과 성공·실패 Pipeline 증거는 기존 [S15P21C206-91](https://ssafy.atlassian.net/browse/S15P21C206-91)에서 확인하며, 73번 완료 상태는 현재 커밋의 CI 통과를 포함하지 않는다.

- CI의 XML·Compose 검사는 VM 생성이나 실제 클러스터 동작을 검증하지 않는다.
- 설정 파일만 수정해도 validate는 실행된다.
- 현재 deploy 규칙은 애플리케이션 소스 변경을 기준으로 한다.
- Hadoop XML 배포는 운영 절차로 수행한다.

현재 deploy job의 이미지 변수는 SSH 세션에만 export된다. 후속 실행과 롤백에서 같은 버전을 쓰려면 대상 서버의 `.env`에 해당 이미지 SHA를 반영해야 한다. 이를 자동화하고 서버별 동시 배포 잠금·health 검사·실패 시 이전 버전 복원을 추가하는 것은 실제 배포 전 남은 작업이다.

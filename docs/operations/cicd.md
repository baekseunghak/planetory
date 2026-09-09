# GitLab CI/CD

> 현재 파일은 배포 경계와 job 뼈대다. GitLab 파이프라인 `#184815`에서 정적 검사는 통과했으며 이미지 빌드·Registry push·실제 서버 배포는 별도로 검증한다.

Docker 개발·배포 방식은 [Docker 개발·배포 기준](docker.md), 서버 역할은 [시스템 아키텍처](../development/system-architecture.md)를 따른다.

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

최상위 파일은 공통 규칙과 각 배포 단위의 job을 불러온다. 한 프로그램의 변경은 다른 프로그램의 이미지를 만들거나 재시작하지 않는다.

## 실행 흐름

| 시점 | 실행 |
| --- | --- |
| Merge Request | Compose와 Docker 구성 검사 |
| 기준 브랜치 | 변경된 프로그램의 이미지 빌드·Registry push |
| 배포 승인 | 선택한 서버에서 해당 이미지만 pull·재시작 |

소스 manifest가 없는 구성은 `rules:exists`로 빌드를 건너뛴다. 현재 기준은 Frontend `package-lock.json`, Backend `gradlew`, Python 구성의 `requirements.txt`다.

## 독립 배포

- Frontend·Backend: EC2-A와 EC2-B job을 각각 수동 실행한다.
- Ingestion: GCP Node 2~6에 같은 이미지를 각각 pull할 수 있다.
- Spark submit·Airflow·Publisher: GCP Node 1에 배포한다. YARN executor는 NodeManager가 실행하므로 Spark standalone Master/Worker 컨테이너를 추가하지 않는다.
- 이미지는 한 번 만들고 모든 대상 노드가 동일한 commit SHA 태그를 사용한다.
- 운영 Compose는 서버의 `.env`에서 다른 서비스의 현재 이미지와 실행 설정을 읽는다.

배포 job은 Compose 파일을 SSH로 복사한 뒤 `config`, `pull`, `up --no-deps` 순서로 실행한다. 수집·Spark·Publisher처럼 요청 시 실행하는 이미지는 `pull`까지만 수행한다.

## 필요한 GitLab 변수

| 구분 | 변수 |
| --- | --- |
| 공통 SSH | `DEPLOY_USER`, File 타입 `DEPLOY_SSH_KEY`, File 타입 `DEPLOY_KNOWN_HOSTS` |
| EC2 | `EC2_A_HOST`, `EC2_A_DEPLOY_PATH`, `EC2_B_HOST`, `EC2_B_DEPLOY_PATH` |
| GCP CI 연결 | `GCP_NODE_1_HOST`~`GCP_NODE_6_HOST`, `GCP_NODE_1_DEPLOY_PATH`~`GCP_NODE_6_DEPLOY_PATH` |
| GCP 서버 `.env` | `GCP_ZONE`, `GCP_NODE_1_PROJECT`~`GCP_NODE_6_PROJECT` |
| 분산 이미지 | `SPARK_BASE_IMAGE`, `AIRFLOW_BASE_IMAGE` |
| Node 1 Airflow | 서버 `.env`의 `AIRFLOW_DB_PASSWORD`, `AIRFLOW_DATABASE_URL`, `AIRFLOW_FERNET_KEY`, `AIRFLOW_WEBSERVER_SECRET_KEY`, `AIRFLOW_DB_PATH`, `AIRFLOW_LOGS_PATH` |

변수는 Protected·Masked 범위를 적용한다. 운영 서버에는 Container Registry 읽기 전용 자격 증명을 미리 설정한다.

## 도입 전 확인

- `lab.ssafy.com` Runner가 Docker-in-Docker와 Buildx를 실행할 수 있는지
- 현재 ARM64 Runner가 privileged DinD에서 고정된 `tonistiigi/binfmt` 이미지를 실행해 amd64를 에뮬레이션할 수 있는지
- Container Registry 사용 권한
- 기준 브랜치가 `main`인지 `master`인지
- Spark·Airflow 기반 이미지의 amd64 지원
- 각 서버의 Docker Compose, `.env`, 볼륨 경로와 방화벽
- 애플리케이션별 health endpoint와 실제 되돌리기 절차

HDFS 삭제, NameNode 초기화, 전체 노드 동시 재시작과 Gold 공개 전환은 일반 애플리케이션 배포 job에 넣지 않는다.

Hadoop/YARN 데몬은 호스트에서 실행한다.

1. `infra/distributed-system/config/hadoop/`의 공통 파일을 `/etc/hadoop/`에 배포한다.
2. 노드 역할에 맞는 `config/yarn/` 파일을 배포한다.
3. [운영 절차](../../infra/distributed-system/README.md)에 따라 서비스를 시작한다.

신규 NameNode format과 Standby bootstrap은 한 번만 수동 수행한다. `initializeSharedEdits`는 기존 단일 NameNode를 HA로 전환할 때만 사용한다.

GCP 자원 생성 스크립트는 `infra/provisioning/gcp/scripts/`에 있으며 CI에서 실행하지 않는다.

- CI의 XML·Compose 검사는 VM 생성이나 실제 클러스터 동작을 검증하지 않는다.
- 설정 파일만 수정해도 validate는 실행된다.
- 현재 deploy 규칙은 애플리케이션 소스 변경을 기준으로 한다.
- Hadoop XML 배포는 운영 절차로 수행한다.

현재 deploy job의 이미지 변수는 SSH 세션에만 export된다. 후속 실행과 롤백에서 같은 버전을 쓰려면 대상 서버의 `.env`에 해당 이미지 SHA를 반영해야 한다. 이를 자동화하고 서버별 동시 배포 잠금·health 검사·실패 시 이전 버전 복원을 추가하는 것은 실제 배포 전 남은 작업이다.

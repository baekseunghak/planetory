# GitLab CI/CD

> 현재 파일은 배포 경계와 job 뼈대다. 애플리케이션 코드, Runner, Registry와 서버 변수가 준비된 뒤 실제 실행을 검증한다.

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
- Ingestion·Spark: OCI-A/B/C/D에 이미지를 각각 pull할 수 있다.
- Airflow·Publisher: 역할에 따라 OCI-A에 배포한다.
- 이미지는 한 번 만들고 모든 대상 노드가 동일한 commit SHA 태그를 사용한다.
- 운영 Compose는 서버의 `.env`에서 다른 서비스의 현재 이미지와 실행 설정을 읽는다.

배포 job은 Compose 파일을 SSH로 복사한 뒤 `config`, `pull`, `up --no-deps` 순서로 실행한다. 수집·Spark·Publisher처럼 요청 시 실행하는 이미지는 `pull`까지만 수행한다.

## 필요한 GitLab 변수

| 구분 | 변수 |
| --- | --- |
| 공통 SSH | `DEPLOY_USER`, File 타입 `DEPLOY_SSH_KEY`, File 타입 `DEPLOY_KNOWN_HOSTS` |
| EC2 | `EC2_A_HOST`, `EC2_A_DEPLOY_PATH`, `EC2_B_HOST`, `EC2_B_DEPLOY_PATH` |
| OCI | `OCI_A_HOST`~`OCI_D_HOST`, `OCI_A_DEPLOY_PATH`~`OCI_D_DEPLOY_PATH` |
| ARM 기반 이미지 | `SPARK_BASE_IMAGE`, `AIRFLOW_BASE_IMAGE` |

변수는 Protected·Masked 범위를 적용한다. 운영 서버에는 Container Registry 읽기 전용 자격 증명을 미리 설정한다.

## 도입 전 확인

- `lab.ssafy.com` Runner가 Docker-in-Docker와 Buildx를 실행할 수 있는지
- Container Registry 사용 권한
- 기준 브랜치가 `main`인지 `master`인지
- Spark·Airflow 기반 이미지의 ARM64 지원
- 각 서버의 Docker Compose, `.env`, 볼륨 경로와 방화벽
- 애플리케이션별 health endpoint와 실제 되돌리기 절차

HDFS 삭제, NameNode 초기화, 전체 노드 동시 재시작과 Gold 공개 전환은 일반 애플리케이션 배포 job에 넣지 않는다.


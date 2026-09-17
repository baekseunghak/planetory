# Docker 개발·배포 기준

## 역할

- 각 실행 프로그램의 `Dockerfile`: 동일한 소스로 개발·배포 이미지를 만든다.
- 루트 `compose.yaml`: 개발 PC에서 전체 또는 일부 컨테이너를 실행한다.
- `infra/service/compose.yaml`, `infra/distributed-system/compose.*.yaml`: CI/CD가 서버에서 Registry 이미지를 실행한다. 서버에서는 `compose.yaml`이라는 이름으로 받는다.

`contracts/`, `libs/`, `docs/`는 단독 프로그램이 아니므로 Dockerfile이 없다. `derived-compute`도 Python 분리가 결정될 때만 추가한다.

## 로컬 개발

`.env.example`을 `.env`로 복사하고 로컬 전용 값을 넣는다. `.env`는 Git에 포함되지 않는다.

```powershell
Copy-Item .env.example .env

# 서비스 전체
docker-compose -f compose.yaml --profile service up --build

# 분산 저장·YARN만
docker-compose -f compose.yaml --profile distributed up

# 모든 구현이 생긴 뒤 전체 실행
docker-compose -f compose.yaml --profile service --profile distributed --profile pipeline up --build
```

Compose는 서비스 이름으로 일부만 실행할 수 있다.

```powershell
docker-compose -f compose.yaml --profile service up service-db
docker-compose -f compose.yaml --profile service up --build frontend
docker-compose -f compose.yaml up namenode datanode-1 datanode-2
```

`service-db`는 루트 `compose.yaml`이 `include`하는 `experiments/distributed-pipeline/compose.yaml`에 정의돼 있고 `frontend`·`backend`와 함께 `service` 프로필에 속한다. 백엔드 로컬 DB 실행 기준은 [백엔드 개발 환경 안내](../../apps/backend/docs/development-setup.md) 2장이다.

현재 Airflow에는 PostgreSQL 드라이버와 DAG 위치만 있고 실제 DAG는 없다. Frontend·Backend·Ingestion·Spark·Publisher도 실행 코드와 manifest가 채워지기 전까지 해당 이미지 빌드를 완료할 수 없다. `docker-compose down -v`는 로컬 볼륨까지 삭제하므로 명시적으로 초기화할 때만 사용한다.

로컬 앱과 데이터 파이프라인은 EC2·GCP와 같은 `linux/amd64`를 기본으로 실행한다.

## 실제 배포

```text
기준 브랜치 변경
  → GitLab CI가 필요한 Dockerfile만 빌드
  → linux/amd64 이미지 생성
  → GitLab Container Registry에 commit SHA 태그로 push
  → 노드별 수동 deploy job
  → SSH로 대상 서버의 Compose 파일 갱신
  → 해당 이미지만 pull·재시작
```

- EC2-A: `infra/service/compose.yaml`, `linux/amd64`. 서비스 인스턴스는 이 노드 1개이고 EC2-B는 배포 대상이 아니다
- GCP Node 1: `infra/distributed-system/compose.control-plane.yaml`, Node 2~6: `infra/distributed-system/compose.worker.yaml`, 모두 `linux/amd64`
- EC2-A와 GCP Node 1~6 배포 job은 따로 실행한다.
- Airflow·Spark submit·Publisher는 GCP Node 1에서, 수집 이미지는 Node 2~6에서 관리한다.
- 서버의 `.env`에 실제 경로와 비밀 값을 보관한다. Registry 읽기 전용 로그인도 서버에서 미리 설정한다.
- 이전 커밋 SHA 이미지를 다시 배포할 수 있어야 한다. DB migration과 Gold 릴리스 전환은 이미지 되돌리기와 별도 절차다.

세부 CI 변수와 job은 [CI/CD](cicd.md)를 따른다.

GCP Hadoop/YARN 데몬은 호스트에서 실행한다. 운영 Compose가 DataNode·NodeManager를 생성하지 않는 것은 이 배치 방식에 따른 것이다. 최초 설치와 노드별 XML 복사는 [분산 시스템 운영 절차](../../infra/distributed-system/README.md)를 따른다. 로컬 단일 호스트 Compose와 실제 6대 VM 배포는 서로 다른 실행 환경이다.

## 공통 규칙

- 비밀번호, 토큰, 클라우드 키, 실제 IP와 데이터를 이미지에 넣지 않는다.
- HDFS, PostgreSQL과 Gold는 컨테이너 외부 볼륨에 저장한다.
- 호스트에서 만든 `node_modules`, `.venv`, JAR와 네이티브 파일을 이미지에 복사하지 않는다.
- `latest` 대신 commit SHA와 이미지 내용 식별값을 사용한다.
- 분산 이미지는 실제 GCP amd64 노드에서 import와 짧은 작업 실행까지 확인한다.

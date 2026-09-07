# Docker 개발·배포 기준

## 역할

- 각 실행 프로그램의 `Dockerfile`: 동일한 소스로 개발·배포 이미지를 만든다.
- 루트 `compose.yaml`: 개발 PC에서 전체 또는 일부 컨테이너를 실행한다.
- `infra/*/compose.yaml`: CI/CD가 서버에서 Registry 이미지를 실행한다. 서버에서 소스를 빌드하지 않는다.

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
docker-compose -f compose.yaml up service-db
docker-compose -f compose.yaml up --build frontend
docker-compose -f compose.yaml up namenode datanode-1 datanode-2
```

현재 애플리케이션 manifest와 실행 코드가 없으므로 `service-db`와 Hadoop/YARN 뼈대 외의 빌드는 아직 성공하지 않는다. `docker-compose down -v`는 로컬 볼륨까지 삭제하므로 명시적으로 초기화할 때만 사용한다.

로컬 앱은 기본 `linux/arm64`로 실행해 호환성을 확인한다. x86 개발 PC에서는 에뮬레이션으로 느릴 수 있으며 성능 측정값으로 사용하지 않는다.

## 실제 배포

```text
기준 브랜치 변경
  → GitLab CI가 필요한 Dockerfile만 빌드
  → linux/amd64 또는 linux/arm64 이미지 생성
  → GitLab Container Registry에 commit SHA 태그로 push
  → 노드별 수동 deploy job
  → SSH로 대상 서버의 Compose 파일 갱신
  → 해당 이미지만 pull·재시작
```

- EC2: `infra/service/compose.yaml`, `linux/amd64`
- OCI: `infra/distributed-system/compose.yaml`, `linux/arm64`
- EC2-A/B와 OCI-A/B/C/D 배포 job은 따로 실행한다.
- Airflow는 OCI-A에서 재시작한다. 수집·Spark·Publisher 이미지는 배치가 사용할 수 있도록 선택한 노드에 pull만 한다.
- 서버의 `.env`에 실제 경로와 비밀 값을 보관한다. Registry 읽기 전용 로그인도 서버에서 미리 설정한다.
- 이전 커밋 SHA 이미지를 다시 배포할 수 있어야 한다. DB migration과 Gold 릴리스 전환은 이미지 되돌리기와 별도 절차다.

세부 CI 변수와 job은 [CI/CD](cicd.md)를 따른다.

## 공통 규칙

- 비밀번호, 토큰, 클라우드 키, 실제 IP와 데이터를 이미지에 넣지 않는다.
- HDFS, PostgreSQL과 Gold는 컨테이너 외부 볼륨에 저장한다.
- 호스트에서 만든 `node_modules`, `.venv`, JAR와 네이티브 파일을 이미지에 복사하지 않는다.
- `latest` 대신 commit SHA와 이미지 내용 식별값을 사용한다.
- ARM64 이미지는 실제 OCI에서 import와 짧은 작업 실행까지 확인한다.

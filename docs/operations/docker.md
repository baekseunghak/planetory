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

Airflow TESS DAG의 Node 1 배포·접속 상태는 [분산 시스템 운영 절차](../../infra/distributed-system/README.md#airflow-db)를 따른다. 로컬 개발 Compose의 전체 파이프라인 기동과 운영 DAG 실행 검증은 별개다. `docker-compose down -v`는 로컬 볼륨까지 삭제하므로 명시적으로 초기화할 때만 사용한다.

로컬 앱과 데이터 파이프라인은 EC2·GCP와 같은 `linux/amd64`를 기본으로 실행한다.

## 실제 배포

### 프론트 Nginx와 OAuth 오류 구분 — S15P21C206-239

`apps/frontend/nginx.conf`는 Docker 내장 DNS(`127.0.0.11`)로 `backend:8080`을 요청 시점에 해석한다. 백엔드가 아직 없는 프론트 단독 배포에서도 정적 화면은 실행되며, 이후 백엔드가 등록되면 Nginx 재시작 없이 조회한다. DNS 결과의 유효 시간은 10초다.

- 신뢰하는 앞단 프록시가 전달한 `X-Forwarded-Proto`를 보존하고, 헤더가 없는 직접 로컬 요청에는 Nginx의 스킴을 사용한다. `Host`와 `X-Forwarded-Host`는 요청 Host를 전달한다. 운영의 컨테이너 진입 경로는 신뢰하는 프록시로 제한해야 한다. 백엔드의 전달 헤더 해석 설정(`server.forward-headers-strategy=framework` 등)은 인증·인프라 배포에서 함께 확인한다.
- Nginx 자체 리다이렉트는 상대 경로로 보낸다(`absolute_redirect off`). 컨테이너의 HTTP 스킴이나 내부 포트 8080을 외부 주소로 노출하지 않는다. 이미 백엔드가 잘못 만든 절대 URL을 이 설정만으로 고치는 것은 아니다.
- `/login/oauth2/`의 401·403은 기존 `authentication_failed` 안내로 보내며, 제공자 취소 `access_denied`는 유지한다. 이 경로와 로그인 시작 `/oauth2/`의 502·503·504는 `/oauth/callback?error=service_unavailable`로 보낸다. 이 오류 복귀 응답은 `Cache-Control: no-store`다.
- `/api/`는 원래 상태와 본문을 유지한다. 특히 `/api/v1/me`의 502·503·504를 401로 바꾸지 않는다. 서버 장애가 세션 만료를 의미하지 않으며 로그인 완료·만료 여부는 실제 인증 응답으로 판단한다.

`service_unavailable`은 Nginx가 만드는 화면 복귀 코드다. API의 `DEPENDENCY_UNAVAILABLE` 계약이나 외부 OAuth 제공자 설정을 바꾸지 않는다. 화면은 일시 장애를 안내하고 로그인 요청을 자동으로 반복하지 않으며 기존 복귀 목적지를 유지한다.

재현: `apps/frontend`에서 `npm run test:nginx`를 실행한다. 실제 Dockerfile의 기본 runtime 이미지와 별도 합성 백엔드·네트워크를 사용하며 Chrome으로 오류 화면을 확인한다. 종료 시 이번 실행의 컨테이너·네트워크·고유 테스트 이미지 태그만 정리한다. 정리 실패는 원래 테스트 예외를 덮지 않고 별도 경고와 실패 종료 코드로 알리며 나머지 정리를 계속한다. 공용 이미지·빌드 캐시는 일괄 삭제하지 않는다. [239 변경 범위·검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)에서 로컬 검증과 실제 배포 검증을 구분한다.

```text
기준 브랜치 변경
  → GitLab CI가 필요한 Dockerfile만 빌드
  → linux/amd64 이미지 생성
  → 자체 호스팅 레지스트리에 commit SHA 태그로 push
  → 노드별 수동 deploy job
  → SSH로 대상 서버의 Compose 파일 갱신
  → 해당 이미지만 pull·재시작
```

- EC2-A: `infra/service/compose.yaml`, `linux/amd64`. 서비스 인스턴스는 이 노드 1개이고 EC2-B는 배포 대상이 아니다
- GCP Node 1~6: 위 흐름을 쓰지 않는다. CI 배포 job이 없고, 코드는 불변 release 디렉터리로 운영자 스크립트가 설치한다(`S15P21C206-94`, [CI/CD](cicd.md) 「GCP 분산 시스템」). Node 1의 Airflow는 release에서 직접 빌드한 로컬 이미지, Spark 제출은 digest를 고정한 공개 이미지로 돈다. `compose.control-plane.yaml`은 Airflow release가 쓰고, `compose.worker.yaml`은 지금 쓰는 경로가 없다.
- 서버의 `.env`에 실제 경로와 비밀 값을 보관한다. 레지스트리는 tailnet 내부 전용이라 노드에 별도 로그인을 설정하지 않는다.
- 이전 커밋 SHA 이미지를 다시 배포할 수 있어야 한다. DB migration과 Gold 릴리스 전환은 이미지 되돌리기와 별도 절차다.

세부 CI 변수와 job은 [CI/CD](cicd.md)를 따른다.

GCP Hadoop/YARN 데몬은 호스트에서 실행한다. 운영 Compose가 DataNode·NodeManager를 생성하지 않는 것은 이 배치 방식에 따른 것이다. 최초 설치와 노드별 XML 복사는 [분산 시스템 운영 절차](../../infra/distributed-system/README.md)를 따른다. 로컬 단일 호스트 Compose와 실제 6대 VM 배포는 서로 다른 실행 환경이다.

호스트 HDFS 기준은 Hadoop 3.5.0과 OpenJDK 17이다. 기본 Spark 제출 이미지 `apache/spark:3.5.5-python3`는 `sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1`로 고정하며 JDK 11.0.26과 Hadoop client 3.3.4를 포함한다. 2026-09-18 Node 1에는 Ubuntu 저장소의 Docker 29.1.3과 Compose 2.40.3을 설치했고, 이 digest로 6대 YARN cluster mode HDFS 읽기·쓰기와 로그 집계를 검증했다. Node 2~6에도 CI 배포용으로 Docker를 설치했으나(`S15P21C206-226`) 그 배포 job은 `S15P21C206-94`에서 걷어냈고, 지금 Node 2~6에서 Docker를 쓰는 경로는 확인되지 않았다.

## 공통 규칙

- 비밀번호, 토큰, 클라우드 키, 실제 IP와 데이터를 이미지에 넣지 않는다.
- HDFS, PostgreSQL과 Gold는 컨테이너 외부 볼륨에 저장한다.
- 호스트에서 만든 `node_modules`, `.venv`, JAR와 네이티브 파일을 이미지에 복사하지 않는다.
- `latest` 대신 commit SHA와 이미지 내용 식별값을 사용한다.
- 분산 이미지는 실제 GCP amd64 노드에서 import와 짧은 작업 실행까지 확인한다.

175 알림 목록·모두 읽음에는 backend의 `NOTIFICATION_SIGNING_KEY` 주입이 필요하다. 서버 보호 환경에서 관리하고 실제 값을 출력하지 않는다. 길이·인스턴스 공유·교체·미설정 동작과 V23/FE 동시 반영은 [알림 키·전환](../../apps/backend/docs/development-setup.md#notification-key)을 따른다. 이 구성 변경은 배포 완료를 뜻하지 않는다.

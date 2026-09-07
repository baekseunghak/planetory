# 저장소 구조

## 원칙

디렉터리는 기술 이름보다 **배포 단위와 책임**으로 나눈다. 실제 파일이 생길 때만 만들며, 미래를 위한 빈 구조는 만들지 않는다.

```text
S15P21C206/
├─ compose.yaml               # 로컬 전체·부분 개발 진입점
├─ apps/
│  ├─ frontend/               # EC2 웹 화면
│  ├─ backend/                # EC2 API와 DB 변경
│  └─ derived-compute/        # EC2 온라인 계산기, 채택할 때만 생성
├─ distributed-system/
│  ├─ ingestion/              # OCI 원천 수집
│  ├─ spark/                  # OCI Spark 작업
│  ├─ airflow/                # OCI 작업 순서와 재시도
│  └─ publisher/              # Gold 검증·포장·전송
├─ infra/
│  ├─ service/                # EC2-A/B 실행 설정
│  └─ distributed-system/     # OCI-A/B/C/D 실행 설정
├─ contracts/
│  └─ gold/                   # Gold 스키마·예제·호환성 검사
├─ libs/
│  └─ astro-kernel/           # 실제로 공유할 때만 만드는 계산 코드
├─ experiments/
│  ├─ tess-bls/               # 기존 과학 알고리즘 실험
│  └─ distributed-pipeline/   # 분산 연결 PoC
├─ .gitlab/ci/                # 배포 단위별 CI/CD 설정
└─ docs/                      # 요구사항·설계·운영 문서
```

## 각 디렉터리의 역할

### `apps/`

사용자가 이용하는 서비스 프로그램이다. `frontend`와 `backend`는 각각 별도 이미지로 만들고 EC2-A/B에 배포할 수 있다. 서비스 DB 변경 파일은 DB를 사용하는 `apps/backend/`가 관리한다.

### `distributed-system/`

OCI에서 데이터를 수집·처리·전달하는 **실행 코드**다. 예를 들어 Spark의 변환 로직은 여기에 둔다. 서버 주소나 디스크 연결 설정은 두지 않는다.

### `infra/`

프로그램을 **어느 서버에서 어떻게 실행할지** 정한다. Docker Compose, 포트, 볼륨, Hadoop/YARN 설정, 노드 역할, 상태 확인과 되돌리기 스크립트가 들어간다.

예를 들어 `distributed-system/spark/sector_pipeline.py`는 데이터 처리 코드이고, `infra/distributed-system/node-c/`는 그 코드를 OCI-C에서 Worker로 실행하는 설정이다.

```text
infra/
├─ service/
│  ├─ compose.yaml
│  ├─ ec2-a/
│  └─ ec2-b/
└─ distributed-system/
   ├─ compose.yaml
   ├─ common/
   ├─ node-a/                 # Master + Worker
   ├─ node-b/                 # Checkpoint + Worker
   ├─ node-c/                 # Worker
   └─ node-d/                 # Worker
```

실제 IP, 비밀번호와 개인 키는 저장소에 넣지 않는다.

### `contracts/`

두 시스템이 주고받는 데이터의 **검사 가능한 약속**이다. Gold 필드·자료형·필수 여부, manifest 형식, 작은 정상·오류 예제를 둔다. OCI 생산자와 EC2 소비자가 같은 계약 검사를 사용하면 한쪽 변경이 상대를 깨뜨리는지 배포 전에 알 수 있다.

Java와 Python의 내부 객체 전체를 복사하지 않는다. 시스템 경계를 넘는 데이터만 둔다.

### `libs/`

둘 이상의 실행 프로그램이 실제로 함께 import하는 공용 코드다. Spark 배치와 EC2 온라인 계산이 같은 잔차·주기도 함수를 사용하기로 확정될 때만 `astro-kernel`을 만든다. 한 프로그램만 사용하면 원래 프로그램 안에 둔다.

기존 `experiments/tess-bls/`에서 공용 계산만 최소한으로 옮기고 Streamlit·그래프 코드는 포함하지 않는다. 운영 코드가 실험 디렉터리를 직접 import하지 않게 한다.

## PoC 이후 코드 이동

| 검증된 PoC 코드 | 운영 위치 |
| --- | --- |
| Spark 작업 | `distributed-system/spark/` |
| Gold 포장·전송 | `distributed-system/publisher/` |
| Gold 수신·DB 반영 | `apps/backend/` |
| 공용 수치 계산 | 두 실행체가 공유할 때만 `libs/astro-kernel/` |
| 노드별 실행 설정 | `infra/` |

합성 입력과 통합 검사는 `experiments/distributed-pipeline/`에 남겨 회귀 검사에 재사용한다.

## 새 파일 위치 결정법

1. 독립적으로 배포되는 서비스인가? → `apps/`
2. OCI 데이터 흐름을 실행하는 코드인가? → `distributed-system/`
3. 서버·컨테이너·네트워크 배치 설정인가? → `infra/`
4. 시스템 사이 데이터 형식인가? → `contracts/`
5. 둘 이상이 실제 공유하는 구현인가? → `libs/`
6. 아직 가능성만 시험하는가? → `experiments/`

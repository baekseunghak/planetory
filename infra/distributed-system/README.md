# GCP 분산 시스템 배포

실행 위치는 다음과 같이 나눈다.

- 호스트 서비스: Hadoop, YARN
- Docker: Airflow, Spark 제출, 수집기, Publisher

VM 생성은 [GCP 준비 절차](../provisioning/gcp/README.md)를 따른다. 설계와 남은 검증은 [GCP 인프라 구조](../../docs/architecture/gcp-distributed-infrastructure.md)를 따른다.

여섯 VM은 하나의 로컬 Docker 네트워크가 아니다. 메시 피어링된 고정 사설 IP와 `master-1`, `worker-2`~`worker-6` 호스트명을 사용한다.

- Hadoop 관리 포트는 외부 IPv4에 공개하지 않는다.
- HDFS의 모든 계층과 PublicationBundle 백업은 RF2를 사용한다.

Node 1은 `compose.control-plane.yaml`, Node 2~6은 `compose.worker.yaml`을 사용한다. CI는 대상 파일을 서버의 `compose.yaml`로 복사한다. 서버별 경로와 연결 정보는 각 노드의 `.env`에 둔다. Worker에는 Airflow DB 비밀 값이 필요 없다.

## 설정 배치

```text
config/hadoop/        # 모든 노드: core-site.xml, hdfs-site.xml, workers
config/yarn/
  worker.xml          # Node 1, 3~6
  standby-worker.xml  # Node 2: NameNode 자원을 남기는 Worker 설정
```

두 YARN 파일은 완전한 설정 파일이다. 노드 역할에 맞는 하나를 `/etc/hadoop/yarn-site.xml`로 복사한다. XML을 자동 병합하지 않는다.

| 대상 | 적용 파일 | NodeManager 한도 |
| --- | --- | --- |
| Node 1 | `worker.xml` | NodeManager 미실행. ResourceManager 설정만 사용 |
| Node 2 | `standby-worker.xml` | 16GiB / 2 vCore |
| Node 3~6 | `worker.xml` | 24GiB / 3 vCore |

ResourceManager의 단일 컨테이너 최대 메모리는 두 파일 모두 24GiB다.

`dfs.replication=2`는 새 파일의 기본값이다. 기존 파일의 복제 계수가 3인 클러스터에서만 백업과 경로 확인 후 `hdfs dfs -setrep -w 2 /lake`를 별도 실행하고 `hdfs fsck /lake -blocks -locations`로 확인한다. 신규 클러스터에는 이 변환 명령이 필요 없다.

저장소 루트에서 해당 서버에 체크아웃한 뒤 실행한다.

```bash
sudo install -d /etc/hadoop
sudo install -m 644 infra/distributed-system/config/hadoop/* /etc/hadoop/
# Node 1, 3~6
sudo install -m 644 infra/distributed-system/config/yarn/worker.xml /etc/hadoop/yarn-site.xml
# Node 2에서는 위 명령 대신 실행
sudo install -m 644 infra/distributed-system/config/yarn/standby-worker.xml /etc/hadoop/yarn-site.xml
```

다음 서버 초기 설정은 아직 구현하지 않았다.

- Hadoop과 JDK 설치
- `hdfs`·`yarn` 서비스 계정과 디렉터리 권한
- systemd 서비스 등록
- `HADOOP_CONF_DIR=/etc/hadoop` 적용

서비스는 실제 디스크 마운트가 성공한 뒤에만 시작해야 한다. `nofail`만으로는 시작 순서를 보장할 수 없으므로 systemd의 `RequiresMountsFor`에 데이터·메타데이터 경로를 지정한다.

| 경로 | 소유 계정 | 대상 노드 |
| --- | --- | --- |
| `/mnt/data/hdfs` | `hdfs` | Node 2~6 |
| `/mnt/data/yarn/local` | `yarn` | Node 2~6 |
| `/mnt/data/yarn/logs` | `yarn` | Node 2~6 |
| NameNode·JournalNode 경로 | `hdfs` | Node 1~3의 해당 역할 |

VPC Peering은 상대 프로젝트의 내부 DNS를 공유하지 않는다. 다음 두 곳에 같은 이름을 등록한다.

1. `create-mesh-peering.ps1`이 각 VM의 `/etc/hosts`에 짧은 이름과 GCE zonal/global FQDN을 등록한다.
2. Compose의 `extra_hosts`가 컨테이너에 같은 FQDN을 등록한다.

각 서버의 `.env`에는 다음 값을 설정한다.

- `GCP_ZONE`
- `GCP_NODE_1_PROJECT`부터 `GCP_NODE_6_PROJECT`

IP, 프로젝트 또는 존이 바뀌면 피어링 스크립트를 다시 실행하고 Compose 환경 변수도 갱신한다.

## 노드 역할

| 노드 | 역할 | 영속 경로 |
| --- | --- | --- |
| 1 | Active NameNode, JournalNode, ResourceManager, Airflow, Spark submit, Publisher | NameNode·JournalNode: 200GiB 제어 데이터 디스크 |
| 2 | Standby NameNode, JournalNode, DataNode, NodeManager, Ingestion | NameNode·JournalNode: 100GiB 메타데이터 디스크, HDFS 데이터: 2,000GiB |
| 3 | JournalNode, DataNode, NodeManager, Ingestion | JournalNode: 30GiB 부팅 디스크, HDFS 데이터: 2,000GiB |
| 4~6 | DataNode, NodeManager, Ingestion | HDFS 데이터: 각 2,000GiB |

ZooKeeper와 ZKFC는 사용하지 않는다. HDFS는 QJM을 사용하되 전환은 운영자가 수행한다. ResourceManager도 Node 1 단일 인스턴스로 두고 장애 시 Node 1 복구 후 Airflow 실패 단계부터 재시도한다.

## 최초 HDFS HA 초기화

다음 명령은 **빈 신규 클러스터에서 한 번만**, Hadoop 설치·설정·디스크 권한 준비 후 실행한다. `hdfs` 명령은 hdfs 계정, `yarn` 명령은 yarn 계정에서 실행한다. 기존 NameNode를 다시 포맷하면 HDFS 메타데이터가 사라진다.

1. Node 1~3에서 JournalNode를 시작한다.

```bash
hdfs --daemon start journalnode
```

2. Node 1에서 Active NameNode를 초기화하고 시작한다.

```bash
hdfs namenode -format planetory
hdfs --daemon start namenode
```

3. Node 2에서 Standby를 bootstrap하고 시작한다.

```bash
hdfs namenode -bootstrapStandby
hdfs --daemon start namenode
```

4. Node 2~6에서 DataNode·NodeManager를 시작한다.

```bash
hdfs --daemon start datanode
yarn --daemon start nodemanager
```

5. 두 NameNode가 Standby로 시작하므로 Node 1에서 safemode 해제를 기다린 후 최초 Active를 지정하고 ResourceManager를 시작한다. 기존 데이터가 있는데 safemode가 끝나지 않으면 원인을 확인하며 강제 해제하지 않는다.

```bash
hdfs dfsadmin -fs hdfs://master-1:8020 -safemode wait
hdfs haadmin -transitionToActive nn1
yarn --daemon start resourcemanager
hdfs haadmin -getServiceState nn1
hdfs haadmin -getServiceState nn2
hdfs dfsadmin -report
yarn node -list -all
```

`yarn node -list -all`에 표시된 각 호스트명을 다른 VM과 작업 컨테이너에서 확인한다. 아래 `<YARN이 표시한 호스트명>`은 출력값으로 바꾼다.

```bash
getent hosts <YARN이 표시한 호스트명>
```

사설 IP ping만 성공하고 이 검사가 실패하면 Spark 작업을 시작하지 않는다.

## 수동 전환

계획된 전환은 기존 Active를 먼저 Standby로 내린다.

```bash
hdfs haadmin -transitionToStandby nn1
hdfs haadmin -transitionToActive nn2
```

Node 1 장애 시에는 담당자가 GCP에서 Node 1 VM의 완전 중지를 확인한 뒤에만 Node 2에서 실행한다.

```bash
hdfs haadmin -transitionToActive nn2
hdfs fsck / -blocks
```

자동 fencing은 구성하지 않았으므로 응답 없는 Active를 대상으로 `hdfs haadmin -failover`를 실행하지 않는다. 기존 단일 NameNode 데이터를 HA로 전환하는 경우에만 공식 절차에 따라 `hdfs namenode -initializeSharedEdits`를 별도로 수행한다.

외부 HA 메타데이터 백업은 이 30일 PoC 범위에서 두지 않는다. 따라서 두 NameNode 메타데이터 디스크를 함께 잃으면 복구할 수 없다는 위험을 수용한다.

공개한 PublicationBundle은 `/lake/publication-bundle-backup/bundle_id=<bundle_id>`에 RF2로 보관한다. 이 경로는 EC2 온라인 조회에 사용하지 않고 manifest·checksum 기반 복구에만 사용한다.

## Airflow DB

Node 1의 `.env`에 `AIRFLOW_DB_PASSWORD`와 URL 인코딩된 같은 비밀번호를 포함한 `AIRFLOW_DATABASE_URL`을 설정한다. 최초 한 번 migration 후 상시 프로세스를 실행한다.

Node 1의 `.env`에는 다음 값을 생성해 보관한다.

- `AIRFLOW_DB_PASSWORD`
- `AIRFLOW_DATABASE_URL`
- `AIRFLOW_FERNET_KEY`
- `AIRFLOW_WEBSERVER_SECRET_KEY`

DB URL 형식은 다음과 같다.

```text
postgresql+psycopg2://airflow:<URL-인코딩된-비밀번호>@127.0.0.1:5432/airflow
```

Fernet key와 webserver secret key는 모든 Airflow 컨테이너에 동일하게 전달하고 임의로 교체하지 않는다. `/mnt/data/airflow-logs`는 이미지의 Airflow UID(기본 50000)가 쓸 수 있게 준비하고 로그 보존 기간을 제한한다.

```bash
docker compose --profile setup run --rm airflow-init
docker compose up -d airflow-db airflow-scheduler airflow-webserver
```

위 명령은 CI가 `compose.yaml`을 복사한 서버 배포 디렉터리에서 실행한다. 저장소 파일을 직접 사용할 때는 다음 옵션을 모든 명령에 추가한다.

```bash
-f infra/distributed-system/compose.control-plane.yaml --env-file <서버-env-경로>
```

- Airflow: 2.10.x, LocalExecutor
- 웹 UI: Node 1의 `127.0.0.1:8081`
- 접근 방법: SSH 터널

최초 UI 계정 생성과 scheduler/webserver의 동일한 Fernet·webserver secret key 설정은 서버 초기 설정에 포함한다.

## Spark 제출

Spark는 다음 모드로 제출한다.

```bash
--master yarn --deploy-mode cluster
```

Executor는 Docker 이미지가 아니라 Worker의 YARN 프로세스에서 실행된다. Python 의존성은 다음 중 하나로 준비한다.

- 모든 Worker에 같은 Python 버전과 패키지 설치
- `--archives`로 실행 환경 배포

제출 이미지에만 설치한 패키지는 Worker에 전달되지 않는다.

다음 항목은 후속 구현 대상이다.

- Airflow 실제 DAG
- 원격 수집 실행
- Spark 제출 연결
- Spark History Server

## 로컬 구성 검사

저장소 루트에서 `python infra/distributed-system/validate.py`를 실행한다. CI는 이 검사와 Compose 구문 검사를 수행한다. 실제 HDFS 쓰기·읽기, Worker 장애·수동 전환, Spark 제출 및 Gold 공개/롤백은 별도 통합 검증이 필요하다.

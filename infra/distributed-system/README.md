# GCP 분산 시스템 배포

Hadoop/YARN은 호스트의 서비스 계정으로 실행하고, Airflow·Spark 제출·수집·Publisher는 Docker로 실행한다. VM 생성은 [GCP 준비 절차](../provisioning/gcp/README.md), 설계와 남은 검증은 [GCP 인프라 구조](../../docs/development/gcp-distributed-infrastructure.md)를 따른다.

여섯 VM을 하나의 로컬 Docker 네트워크로 가정하지 않는다. 메시 피어링된 고정 사설 IP와 `master-1`, `worker-2`~`worker-6` 호스트명을 사용한다. Hadoop 관리 포트는 외부 IPv4에 공개하지 않는다.

Node 1은 `compose.control-plane.yaml`, Node 2~6은 `compose.worker.yaml`을 사용한다. CI는 대상 파일을 서버의 `compose.yaml`로 복사한다. 서버별 경로와 연결 정보는 각 노드의 `.env`에 둔다. Worker에는 Airflow DB 비밀 값이 필요 없다.

## 설정 배치

```text
config/hadoop/        # 모든 노드: core-site.xml, hdfs-site.xml, workers
config/yarn/
  worker.xml          # Node 1, 3~6
  standby-worker.xml  # Node 2: NameNode 자원을 남기는 Worker 설정
```

두 YARN 파일은 완전한 설정 파일이다. 하나를 선택해 `/etc/hadoop/yarn-site.xml`로 복사한다. XML을 자동 병합한다고 가정하지 않는다. Node 1은 ResourceManager만 실행하므로 worker.xml의 NodeManager 자원 값은 사용하지 않는다. Node 2의 NodeManager 한도는 16GiB/2 vCore, 나머지는 24GiB/3 vCore다. ResourceManager의 단일 컨테이너 최대 메모리는 두 파일 모두 24GiB다.

저장소 루트에서 해당 서버에 체크아웃한 뒤 실행한다.

```bash
sudo install -d /etc/hadoop
sudo install -m 644 infra/distributed-system/config/hadoop/* /etc/hadoop/
# Node 1, 3~6
sudo install -m 644 infra/distributed-system/config/yarn/worker.xml /etc/hadoop/yarn-site.xml
# Node 2에서는 위 명령 대신 실행
sudo install -m 644 infra/distributed-system/config/yarn/standby-worker.xml /etc/hadoop/yarn-site.xml
```

Hadoop/JDK 설치, `hdfs`·`yarn` 계정과 권한, 서비스 재시작 등록은 아직 구현하지 않았다. 각 서비스에 `HADOOP_CONF_DIR=/etc/hadoop`를 적용하고 실제 마운트가 성공한 뒤에만 시작해야 한다. VM의 `nofail` 마운트 옵션만으로는 이를 보장하지 않으므로 systemd 설치 시 `RequiresMountsFor`로 데이터·메타데이터 경로를 의존시킨다. Node 2~6은 `/mnt/data/hdfs`를 hdfs 소유, `/mnt/data/yarn/local`과 `/mnt/data/yarn/logs`를 yarn 소유로 준비한다. Node 1~3의 JournalNode 및 Node 1~2의 NameNode 경로도 hdfs 소유여야 한다.

호스트 `/etc/hosts`는 컨테이너에 상속되지 않으므로 Compose의 `extra_hosts`에 6개 사설 IP를 명시했다. IP 변경 시 생성 스크립트의 호스트 목록과 Compose 두 파일을 함께 수정한다.

## 노드 역할

| 노드 | 역할 | 영속 경로 |
| --- | --- | --- |
| 1 | Active NameNode, JournalNode, ResourceManager, Airflow, Spark submit, Publisher | NameNode·JournalNode: 200GiB 데이터 디스크 |
| 2 | Standby NameNode, JournalNode, DataNode, NodeManager, Ingestion | NameNode·JournalNode: 100GiB 메타데이터 디스크, HDFS: 2.75TiB |
| 3 | JournalNode, DataNode, NodeManager, Ingestion | JournalNode: 30GiB 부팅 디스크, HDFS: 3TiB |
| 4~6 | DataNode, NodeManager, Ingestion | HDFS: 각 3TiB |

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

외부 HA 메타데이터 백업은 이 30일 POC 범위에서 두지 않는다. 따라서 두 NameNode 메타데이터 디스크를 함께 잃으면 복구할 수 없다는 위험을 수용한다.

## Airflow DB

Node 1의 `.env`에 `AIRFLOW_DB_PASSWORD`와 URL 인코딩된 같은 비밀번호를 포함한 `AIRFLOW_DATABASE_URL`을 설정한다. 최초 한 번 migration 후 상시 프로세스를 실행한다.

`AIRFLOW_FERNET_KEY`와 `AIRFLOW_WEBSERVER_SECRET_KEY`도 `.env`에 생성·보관한다. 같은 키가 모든 Airflow 컨테이너에 전달되며 키를 임의로 교체하지 않는다. `/mnt/data/airflow-logs`는 이미지의 airflow UID(기본 50000)가 쓸 수 있도록 준비하고 로그 보존 기간을 제한한다. DB URL은 `postgresql+psycopg2://airflow:<URL-인코딩된-비밀번호>@127.0.0.1:5432/airflow` 형식이다.

```bash
docker compose --profile setup run --rm airflow-init
docker compose up -d airflow-db airflow-scheduler airflow-webserver
```

저장소 파일로 직접 실행할 때는 모든 명령에 `-f infra/distributed-system/compose.control-plane.yaml --env-file <서버-env-경로>`를 지정한다. 위 짧은 명령은 CI가 `compose.yaml`을 복사한 서버 배포 디렉터리 기준이다. Airflow 2.10.x 이미지와 LocalExecutor를 사용한다. 웹 UI는 Node 1의 `127.0.0.1:8081`에 바인딩하므로 SSH 터널로 접근한다. 최초 UI 계정 생성과 scheduler/webserver의 동일한 Fernet·webserver secret key 설정은 서버 초기 설정에 포함한다.

Spark는 `--master yarn --deploy-mode cluster`로 제출한다. Executor는 Docker 이미지 안이 아니라 Worker의 YARN 프로세스로 실행되므로 같은 Python 버전·패키지를 Worker에 설치하거나 `--archives`로 배포해야 한다. 제출 이미지에만 패키지를 설치하면 Worker에는 전달되지 않는다. Airflow의 실제 DAG, 원격 수집 실행과 Spark 제출 연결은 후속 구현 사항이다. History Server도 아직 배포하지 않는다.

## 로컬 구성 검사

저장소 루트에서 `python infra/distributed-system/validate.py`를 실행한다. CI는 이 검사와 Compose 구문 검사를 수행한다. 실제 HDFS 쓰기·읽기, Worker 장애·수동 전환, Spark 제출 및 Gold 공개/롤백은 별도 통합 검증이 필요하다.

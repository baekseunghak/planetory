# GCP 분산 시스템 배포

실행 위치는 다음과 같이 나눈다.

- 호스트 서비스: Hadoop, YARN
- Docker: Airflow, Spark 제출, 수집기, Publisher

VM 생성은 [GCP 준비 절차](../provisioning/gcp/README.md)를 따른다. 설계와 남은 검증은 [GCP 인프라 구조](../../docs/architecture/gcp-distributed-infrastructure.md)를 따른다.

## 실행 버전 기준

| 대상 | 기준 | 상태 |
| --- | --- | --- |
| HDFS 호스트 데몬 | Hadoop 3.5.0, OpenJDK 17 | `S15P21C206-72` 설치 기준 확정, 실제 설치 전 |
| Spark 제출 컨테이너 | `apache/spark:3.5.5-python3` | 기본 이미지 확정 |
| Spark와 Hadoop 클러스터 통합 | Spark 이미지의 Hadoop client 3.3.4 → Hadoop 3.5.0 | 로컬 HDFS 쓰기·읽기만 부분 검증, 실제 YARN 검증은 `S15P21C206-73` |

Hadoop 3.5.0 서버는 Java 17을 요구하므로 HDFS와 YARN 호스트 데몬은 OpenJDK 17로 실행한다. Spark 3.5 계열의 Java 17 지원 여부와 별개로 현재 Spark 이미지 자체는 JDK 11.0.26과 Hadoop client 3.3.4를 포함한다. 호스트 Hadoop의 JDK를 바꿔도 컨테이너 내부 JDK와 JAR는 자동으로 바뀌지 않는다.

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

`S15P21C206-73` 범위:

- `yarn` 서비스 계정과 YARN 로컬·로그 디렉터리 권한
- ResourceManager·NodeManager systemd 서비스 등록
- Worker Python 실행 환경과 Spark sample application 검증

### HDFS 호스트 설치 명세 (`S15P21C206-72`)

Jira `S15P21C206-72`는 서비스 계정·JDK·mount·QJM·RF2와 안전한 최초 초기화를 포함한다. 설치 구현은 [Hadoop 3.5.0 Cluster Setup](https://hadoop.apache.org/docs/r3.5.0/hadoop-project-dist/hadoop-common/ClusterSetup.html), [QJM HA](https://hadoop.apache.org/docs/r3.5.0/hadoop-project-dist/hadoop-hdfs/HDFSHighAvailabilityWithQJM.html)와 [Apache 공식 배포본](https://downloads.apache.org/hadoop/common/hadoop-3.5.0/)을 기준으로 하며, 노드 역할과 저장 경로는 이 저장소의 설정을 따른다.

구현 파일은 다음 둘이다.

- [install-hdfs-host.sh](scripts/install-hdfs-host.sh): 단일 노드의 사전 검사·설치·권한·systemd unit 생성을 담당한다.
- [install-hdfs-hosts.ps1](scripts/install-hdfs-hosts.ps1): 프로젝트·노드 매핑을 검증하고 `gcloud compute scp`·`gcloud compute ssh`로 Linux 스크립트를 호출한다.

설치 스크립트는 다음 순서와 중단 조건을 지킨다.

1. 노드 번호 `1~6`, Ubuntu 24.04 amd64, 예상 호스트명·사설 IP, 역할별 디스크 mount, 전체 호스트명 해석을 검사한다. 기존 HDFS 프로세스, NameNode `VERSION` 파일, 예상과 다른 Hadoop 설치·심볼릭 링크·설정이 있으면 변경 전에 중단한다.
2. `openjdk-17-jdk-headless`, 다운로드·인증서 도구를 설치하고 실제 `java` 경로와 Java 17을 확인한다. `hadoop` 시스템 그룹과 비밀번호·로그인 셸·SSH 키가 없는 `hdfs` 시스템 계정을 모든 노드에 만든다. 기존 관리자 계정은 SSH와 `sudo` 설치에만 사용한다.
3. 각 노드가 `hadoop-3.5.0.tar.gz`와 `.sha512`를 Apache 공식 배포 경로에서 내려받는다. 같은 디렉터리에서 `sha512sum -c`가 성공한 뒤에만 임시 경로에 압축을 풀고 실행 파일을 검사한다.
4. 검증한 배포본을 root 소유의 `/opt/hadoop-3.5.0`에 설치하고 `/opt/hadoop`이 해당 버전을 가리키게 한다. 기존 링크가 다른 대상이거나 일반 파일·디렉터리이면 자동 삭제·교체하지 않는다. 같은 버전과 checksum이 이미 확인되면 다운로드와 압축 해제를 생략한다.
5. 배포본의 기본 설정을 root 소유 `/etc/hadoop`에 준비한 뒤 저장소의 `config/hadoop/` 파일로 site 설정을 배치한다. `/etc/hadoop/hadoop-env.sh`, `/etc/default/hadoop`, `/etc/profile.d/hadoop.sh`에는 아래 기준을 적용한다.

   | 변수 | 값 |
   | --- | --- |
   | `JAVA_HOME` | `/usr/lib/jvm/java-17-openjdk-amd64`를 설치 후 실제 경로와 대조 |
   | `HADOOP_HOME` | `/opt/hadoop` |
   | `HADOOP_CONF_DIR` | `/etc/hadoop` |
   | `HADOOP_LOG_DIR` | `/var/log/hadoop` |
   | `HADOOP_PID_DIR` | `/run/hadoop-hdfs` |

6. Hadoop 배포본과 `/etc/hadoop`은 `root:root`, 로그·PID와 아래 역할별 데이터 디렉터리만 `hdfs:hadoop`으로 둔다. `/mnt/data`와 `/mnt/metadata` 상위 경로 전체의 소유권은 바꾸지 않는다.
7. `hadoop-hdfs-namenode.service`, `hadoop-hdfs-journalnode.service`, `hadoop-hdfs-datanode.service`를 역할 노드에 배치한다. 각 unit은 `User=hdfs`, `Group=hadoop`, `/etc/default/hadoop`과 역할별 `RequiresMountsFor`를 사용한다. 설치 단계에서는 unit을 시작하거나 활성화하지 않는다.
8. 설치 후 Java·Hadoop 버전, 계정의 로그인 불가, 경로별 쓰기 권한, 설정 파일 읽기, HDFS 프로세스 미실행과 NameNode 미포맷 상태를 확인한다. Node 1을 먼저 검증한 뒤 Node 2~6에 같은 설치를 적용한다.

이 설치 자동화에는 `hdfs namenode -format`, `-bootstrapStandby`, `-initializeSharedEdits`, 데몬 시작, 영속 경로 삭제를 넣지 않는다. 최초 format과 Standby bootstrap은 아래 초기화 절차에서 대상과 빈 클러스터 여부를 다시 확인한 뒤 별도로 수행한다.

네트워크는 `S15P21C206-71`에서 만든 VPC Peering·방화벽·`/etc/hosts`를 재사용한다. 설치 스크립트는 사설 IP·이름 해석·mount만 검사하며 VPC, 방화벽, 외부 IP, SSH 설정과 호스트 매핑을 만들거나 변경하지 않는다. HDFS 포트 연결은 데몬을 시작한 뒤 별도 검증한다.

Docker Engine과 Compose 설치는 `S15P21C206-72`에 포함하지 않는다. Node 1 Docker는 현재 Spark 제출 컨테이너를 사용하는 `S15P21C206-73` 착수 전에 필요하고, Node 2~6 Docker는 수집 컨테이너를 실제 배포할 때 필요하다. 2026-09-17 Jira 조회 기준으로 두 설치 책임을 명시한 별도 Task는 없으므로, 각 작업 착수 전에 기존 Task에 포함할지 별도 Task로 분리할지 확정한다. 확정 전에는 Docker 설치를 72번 완료 증거로 계산하지 않는다.

#### 설치 실행

저장소 루트에서 프로젝트 ID를 Node 1~6 순서로 지정한다. 실제 값은 저장소에 기록하지 않는다.

```powershell
$Projects = @(
  '<node-1-project>',
  '<node-2-project>',
  '<node-3-project>',
  '<node-4-project>',
  '<node-5-project>',
  '<node-6-project>'
)

# GCP 노드 매핑만 읽고 원격 변경은 하지 않는다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1 -Projects $Projects -WhatIf

# Node 1을 먼저 설치하고 PASS 출력과 서버 상태를 확인한다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1 -Projects $Projects

# Node 1 검증 후 Node 2~6을 순차 설치한다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1 -Projects $Projects -NodeNumbers 2,3,4,5,6
```

`-WhatIf`는 GCP의 VM 이름·상태·사설 IP만 확인하며 Linux 사전 검사를 실행하지 않는다. 실제 실행은 각 호스트에서 OS·hostname·사설 IP·mount·이름 해석·기존 HDFS 프로세스·NameNode format 여부·기존 설정 충돌을 먼저 검사하고 하나라도 다르면 설치 전에 중단한다. `PASS`는 설치 준비 완료를 뜻하며 HDFS 초기화나 72번 런타임 완료 증거가 아니다.

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

다음 명령은 **빈 신규 클러스터에서 한 번만**, Hadoop 3.5.0·OpenJDK 17 설치, 설정 배치와 디스크 권한 준비 후 `hdfs` 계정으로 실행한다. 설치·설정 자동화에 format을 포함하지 않으며, 기존 NameNode를 다시 포맷하면 HDFS 메타데이터가 사라지므로 실행 직전에 대상과 빈 클러스터 여부를 다시 승인받는다.

1. Node 1~3에서 JournalNode를 시작한다.

```bash
sudo systemctl start hadoop-hdfs-journalnode
```

2. Node 1에서 Active NameNode를 초기화하고 시작한다.

```bash
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs namenode -format planetory
sudo systemctl start hadoop-hdfs-namenode
```

3. Node 2에서 Standby를 bootstrap하고 시작한다.

```bash
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs namenode -bootstrapStandby
sudo systemctl start hadoop-hdfs-namenode
```

4. Node 2~6에서 DataNode를 시작한다.

```bash
sudo systemctl start hadoop-hdfs-datanode
```

5. 두 NameNode가 Standby로 시작하므로 Node 1에서 safemode 해제를 기다린 후 최초 Active를 지정한다. 기존 데이터가 있는데 safemode가 끝나지 않으면 원인을 확인하며 강제 해제하지 않는다.

```bash
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs dfsadmin -fs hdfs://master-1:8020 -safemode wait
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToActive nn1
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -getServiceState nn1
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -getServiceState nn2
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs dfsadmin -report
```

## HDFS 완료 검증

`S15P21C206-72`는 다음 결과를 모두 확인해야 완료한다.

- `nn1=active`, `nn2=standby`
- Node 1~3의 JournalNode 3개 실행
- Node 2~6의 Live DataNode 5개
- missing·corrupt block 0
- 익명 표본 파일의 쓰기·읽기 성공과 복제 계수 2
- `hdfs fsck <표본 경로> -files -blocks -locations`에서 서로 다른 두 DataNode의 블록 위치 확인
- 업로드 전과 다운로드 후 SHA-256 일치 및 `hdfs dfs -checksum <표본 경로>` 성공

표본은 `/validation/S15P21C206-72/` 아래에 두고 검증 결과와 함께 제거 여부를 결정한다. 자동 장애 전환, Worker 장애와 수동 NameNode 전환은 이 초기화 완료 조건에 포함하지 않는다.

## YARN 최초 시작 (`S15P21C206-73`)

HDFS 완료 검증 후 별도 작업에서 Node 2~6의 NodeManager와 Node 1의 ResourceManager를 시작한다.

```bash
# Node 2~6
yarn --daemon start nodemanager
# Node 1
yarn --daemon start resourcemanager
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
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToStandby nn1
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToActive nn2
```

Node 1 장애 시에는 담당자가 GCP에서 Node 1 VM의 완전 중지를 확인한 뒤에만 Node 2에서 실행한다.

```bash
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToActive nn2
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs fsck / -blocks
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

현재 기본 이미지 `apache/spark:3.5.5-python3`는 JDK 11.0.26과 `hadoop-client-api/runtime` 3.3.4를 포함한다. Hadoop 3.5.0 단일 HDFS에 대한 Parquet 쓰기·읽기와 checksum은 로컬 일회성 환경에서 통과했지만, 이 결과는 실제 6대 QJM·YARN 실행 증거가 아니다. `S15P21C206-73`에서 같은 이미지로 sample application을 제출해 Application ID, 성공 상태, HDFS 결과와 executor 로그를 확인한다.

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

저장소 루트에서 `python infra/distributed-system/validate.py`를 실행한다. CI는 이 검사와 Compose 구문 검사를 수행한다. 실제 HDFS 쓰기·읽기·RF2·checksum은 `S15P21C206-72`, YARN·Spark 제출은 `S15P21C206-73`의 런타임 검증이 필요하다. Worker 장애·수동 전환과 Gold 공개·롤백은 각각의 후속 통합 검증으로 남긴다.

# GCP 분산 시스템 배포

실행 위치는 다음과 같이 나눈다.

- 호스트 서비스: Hadoop, YARN
- Docker: Airflow, Spark 제출, 수집기, Publisher

VM 생성은 [GCP 준비 절차](../provisioning/gcp/README.md)를 따른다. 설계와 남은 검증은 [GCP 인프라 구조](../../docs/architecture/gcp-distributed-infrastructure.md)를 따른다.

## 실행 버전 기준

| 대상 | 기준 | 상태 |
| --- | --- | --- |
| HDFS 호스트 데몬 | Hadoop 3.5.0, OpenJDK 17 | QJM 3개·Active/Standby·DataNode 5개·RF2 런타임 검증 완료 |
| Spark 제출 컨테이너 | `apache/spark:3.5.5-python3` | 기본 이미지 확정 |
| Spark와 Hadoop 클러스터 통합 | Spark 이미지의 Hadoop client 3.3.4 → Hadoop 3.5.0 | YARN cluster mode HDFS 읽기·쓰기와 5개 Worker executor 검증 완료 |

2026-09-17 실환경 점검에서 6대의 저장소 설정 파일 일치 여부와 노드 간 사설망 route·ping·TCP 22 총 30개 방향, 각 노드의 18개 DNS 별칭을 검증했다. 이어 QJM 3개, `nn1=active`, `nn2=standby`, Live DataNode 5개와 RF2 표본 쓰기·읽기·checksum을 검증했다. 2026-09-18에는 ResourceManager 1개와 NodeManager 5개, Spark 3.5.5 cluster mode HDFS sample과 Node 2 자원 상한에 더해 Node 1·Worker 4 실제 중지와 수동 복구를 검증했다.

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
  capacity-scheduler.xml # 전체 노드: 단일 root.default queue
```

두 `yarn-site.xml` 프로필은 완전한 설정 파일이다. 노드 역할에 맞는 하나를 `/etc/hadoop/yarn-site.xml`로 복사하고 `capacity-scheduler.xml`도 함께 배치한다. 서버 배포본의 기본 scheduler 파일에 의존하지 않으며 XML을 자동 병합하지 않는다.

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

`S15P21C206-73`은 `yarn` 서비스 계정, 로컬·로그·PID 디렉터리, 역할별 systemd unit, UFW와 Spark sample까지 [YARN 설치·검증 절차](#yarn-설치검증-s15p21c206-73)로 자동화한다.

### HDFS 호스트 설치 명세 (`S15P21C206-72`)

Jira `S15P21C206-72`는 서비스 계정·JDK·mount·QJM·RF2와 안전한 최초 초기화를 포함한다. 설치 구현은 [Hadoop 3.5.0 Cluster Setup](https://hadoop.apache.org/docs/r3.5.0/hadoop-project-dist/hadoop-common/ClusterSetup.html), [QJM HA](https://hadoop.apache.org/docs/r3.5.0/hadoop-project-dist/hadoop-hdfs/HDFSHighAvailabilityWithQJM.html)와 [Apache 공식 배포본](https://downloads.apache.org/hadoop/common/hadoop-3.5.0/)을 기준으로 하며, 노드 역할과 저장 경로는 이 저장소의 설정을 따른다.

구현 파일은 다음과 같다.

- [install-hdfs-host.sh](scripts/install-hdfs-host.sh): 단일 노드의 사전 검사·설치·권한·systemd unit 생성을 담당한다.
- [install-hdfs-hosts.ps1](scripts/install-hdfs-hosts.ps1): tailnet 노드·Linux 계정·호스트명을 검증하고 `tailscale ssh`와 MagicDNS 경유 `scp`로 Linux 스크립트를 호출한다.
- [initialize-hdfs-ha.ps1](scripts/initialize-hdfs-ha.ps1): 방화벽·QJM·포맷·Standby bootstrap·DataNode·Active 전환·RF2 검증을 한 단계씩 실행하고 각 단계의 상태·포트·로그를 확인한다.
- [test-initialize-hdfs-ha.ps1](scripts/test-initialize-hdfs-ha.ps1): 초기화 단계와 포맷 보호 장치를 원격 변경 없이 검사한다.
- [validate-hdfs-recovery.ps1](scripts/validate-hdfs-recovery.ps1): 계획 전환, Node 1·Worker 중지, 순차 재기동과 최종 무결성 감사를 단계별로 수행한다.
- [test-hdfs-recovery.ps1](scripts/test-hdfs-recovery.ps1): `WhatIf`, 정확한 VM 대상, no-format·no-delete와 수동 전환 계약을 원격 변경 없이 검사한다.

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

네트워크는 `S15P21C206-71`에서 만든 VPC Peering·GCP 방화벽·`/etc/hosts`를 재사용한다. 설치 스크립트는 사설 IP·이름 해석·mount만 검사하며 VPC, 외부 IP, SSH 설정과 호스트 매핑을 만들거나 변경하지 않는다. 호스트 UFW의 역할별 HDFS 규칙과 실제 포트 연결은 초기화 스크립트가 데몬 시작 단계와 분리해 적용·검증한다.

Docker Engine과 Compose 설치는 `S15P21C206-72`에 포함하지 않는다. Node 1은 Spark 제출 책임과 함께 `S15P21C206-73`에서 Ubuntu 저장소의 Docker Engine·Compose를 설치하고 실제 제출까지 검증했다. Node 2~6 Docker는 수집 컨테이너를 실제 배포하는 작업에서 설치한다.

#### 설치 실행

저장소 루트에서 Tailscale 연결을 확인한 뒤 실행한다. Node 1은 `SSAFY@node-1`, Node 2~6은 `planetory-admin@node-*`를 사용하며 스크립트가 실제 호스트명까지 확인한다.

```powershell
tailscale status
tailscale ping node-1

# tailnet 도달성과 원격 호스트명만 읽고 원격 변경은 하지 않는다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1 -WhatIf

# Node 1을 먼저 설치하고 PASS 출력과 서버 상태를 확인한다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1

# Node 1 검증 후 Node 2~6을 순차 설치한다.
.\infra\distributed-system\scripts\install-hdfs-hosts.ps1 -NodeNumbers 2,3,4,5,6
```

`-WhatIf`도 `tailscale ping`과 읽기 전용 `hostname -s`를 실행해 선택한 모든 노드가 올바른 tailnet 대상인지 먼저 확인한다. 파일 업로드나 설치 명령은 실행하지 않는다. 실제 실행은 각 호스트에서 OS·hostname·사설 IP·mount·이름 해석·기존 HDFS 프로세스·NameNode format 여부·기존 설정 충돌을 먼저 검사하고 하나라도 다르면 설치 전에 중단한다. `PASS`는 설치 준비 완료를 뜻하며 HDFS 초기화나 72번 런타임 완료 증거가 아니다.

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

초기화는 [initialize-hdfs-ha.ps1](scripts/initialize-hdfs-ha.ps1)로 한 단계씩 실행한다. 각 단계는 6대 tailnet 대상과 실제 호스트명을 먼저 확인하고, 실패하면 다음 단계를 실행하지 않는다. `FormatActive`는 **빈 신규 클러스터에서 한 번만** 실행하며 기존 NameNode를 다시 포맷하면 메타데이터가 사라지므로 실행 직전에 별도 승인과 `-ApproveFormat`이 필요하다.

```powershell
$Init = '.\infra\distributed-system\scripts\initialize-hdfs-ha.ps1'

& $Init -Step Preflight
& $Init -Step NetworkDiagnostics
$AuditSinceUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
& $Init -Step ConfigureFirewall
& $Init -Step JournalNodes
& $Init -Step FormatActive -ApproveFormat
& $Init -Step BootstrapStandby
& $Init -Step DataNodes
& $Init -Step Activate
& $Init -Step ValidateRf2
& $Init -Step FinalAudit -AuditSinceUtc $AuditSinceUtc
```

`ConfigureFirewall`은 UFW의 기본 incoming deny와 기존 SSH 규칙을 유지하면서 아래 사설 IP·역할 포트만 허용한다.

| 대상 | 허용 출발지 | TCP 포트 |
| --- | --- | --- |
| Node 1 | `10.20.1.10`~`10.20.6.10`의 정확한 6개 IP | `8020,8485,9870` |
| Node 2 | 동일 | `8020,8485,9870,9864,9866,9867` |
| Node 3 | 동일 | `8485,9864,9866,9867` |
| Node 4~6 | 동일 | `9864,9866,9867` |
| Node 1~3 JournalNode HTTP | NameNode 2대의 `10.20.1.10`, `10.20.2.10` | `8480` |

2026-09-17 최초 실행에서는 UFW가 22번만 허용해 QJM RPC 8485 연결이 차단됐다. 역할별 규칙을 추가한 뒤 3개 endpoint 연결을 재검증했다. 후속 검토에서는 Standby가 edit log를 읽는 JournalNode HTTP 8480이 빠진 것을 확인해 두 NameNode에서 세 JournalNode로 가는 경로만 추가했다. 포맷은 성공했지만 관리자 계정이 `hdfs` 전용 `VERSION` 경로를 검사해 후속 시작이 중단됐으므로, 검사에 `sudo test`를 적용하고 재포맷 없이 시작만 재개하는 `StartFormattedActive` 복구 단계를 추가했다. 이 단계는 포맷 성공과 NameNode 미시작을 확인한 경우에만 사용한다.

`FinalAudit`은 과거 오류와 수정 뒤 새 오류를 구분하기 위해 UTC 검사 시작 시각을 필수로 받는다. 로그 파일 목록 조회와 읽기는 `hdfs` 권한 안에서 수행하며, 로그 없음·읽기 실패·검색 실패도 감사 실패로 처리한다. 두 NameNode에서 세 JournalNode의 8485/TCP와 8480/HTTP도 함께 검증한다.

현재 HDFS unit은 실행 중이지만 부팅 자동 시작은 활성화하지 않았다. 재부팅 후에는 JournalNode·NameNode·DataNode를 순서대로 시작하고 두 NameNode가 올라온 뒤 기존 Active가 없음을 확인해 수동 전환해야 한다.

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

2026-09-17 검증 표본 `/validation/S15P21C206-72/run-20260917T161435/sample.txt`는 SHA-256 `45d305da54016d35f10f62f0c45d50bb5f7769f2fa16d94f32c8d512941b8c50`로 업로드 전·다운로드 후가 일치했다. RF2 블록은 `worker-5`, `worker-6`에 저장됐고 최종 FSCK는 `HEALTHY`, missing·corrupt·under-replicated block은 모두 0이었다.

## YARN 설치·검증 (`S15P21C206-73`)

구현 파일은 다음과 같다.

- [install-yarn-host.sh](scripts/install-yarn-host.sh): 계정·디렉터리·설정·역할별 unit을 멱등 배치하고 Node 1에만 Ubuntu Docker를 준비한다. YARN unit이 active 또는 enabled이면 파일을 쓰기 전에 중단한다.
- [install-yarn-hosts.ps1](scripts/install-yarn-hosts.ps1): Node 1 canary와 Node 2~6 배치를 분리하고 원격 호스트명을 변경 전에 확인한다. `scp`는 비대화식·엄격한 host key 검증을 사용하고 실행 뒤 전용 staging 디렉터리를 정리한다.
- [initialize-yarn-cluster.ps1](scripts/initialize-yarn-cluster.ps1): `Preflight`, `ConfigureFirewall`, `Start`, `ValidateNodes`, `FinalAudit`을 독립 실행한다. 원격 명령은 Bash로 실행하고 HDFS는 `nn1`·`nn2` 중 정확히 하나가 Active인지 확인한다.
- [run-yarn-sample.ps1](scripts/run-yarn-sample.ps1), [yarn-hdfs-sample.py](scripts/yarn-hdfs-sample.py): 고정 Spark 3.5.5 image digest로 HDFS 읽기·쓰기를 실행하고 Application ID·executor 배치·checksum·집계 로그·Node 2 자원을 확인한다.
- [run-tess-hdfs-load.ps1](scripts/run-tess-hdfs-load.ps1), [test-tess-hdfs-load.ps1](scripts/test-tess-hdfs-load.ps1): 감사 완료 Sector를 Worker 5개 SequenceFile writer로 병렬 적재하고 RF2·manifest·offset 복원 감사 뒤 원자 확정한다. 상세 실행·복구 계약은 [TESS HDFS Raw 적재](../../distributed-system/ingestion/hdfs/README.md)를 따른다.
- [test-yarn.ps1](scripts/test-yarn.ps1): 원격 변경 없이 canary·`WhatIf`·단계 계약을 회귀 검사한다.

```powershell
$Install = '.\infra\distributed-system\scripts\install-yarn-hosts.ps1'
$Init = '.\infra\distributed-system\scripts\initialize-yarn-cluster.ps1'

& $Install -WhatIf
& $Install -NodeNumbers 1
& $Install -NodeNumbers 2,3,4,5,6
& $Init -Step Preflight
& $Init -Step ConfigureFirewall
$AuditSinceUtc = (@(& tailscale ssh SSAFY@node-1 'date -u +%Y-%m-%dT%H:%M:%SZ') | Select-Object -Last 1).Trim()
& $Init -Step Start
& $Init -Step ValidateNodes
& .\infra\distributed-system\scripts\run-yarn-sample.ps1
& $Init -Step FinalAudit -AuditSinceUtc $AuditSinceUtc
```

설치 전에 OpenSSH `known_hosts`에 각 `node-*` host key를 별도 확인해 등록해야 한다. 미등록되거나 변경된 key는 자동 수락하지 않고 설치와 sample 전송을 중단한다.

설치 단계는 unit을 활성화하거나 시작하지 않는다. `Start`는 Node 1의 ResourceManager와 Node 2~6의 NodeManager만 시작하고 준비 포트를 최대 30초 기다린다. `S15P21C206-74` 검증 결과 자동 fencing이 없는 PoC에서는 HDFS·YARN unit의 부팅 자동 시작을 활성화하지 않고 운영자 확인 뒤 수동 복구 순서를 유지한다. 재부팅 후에는 JournalNode·NameNode·DataNode와 HA 상태를 먼저 복구한 뒤 같은 `Start`와 `ValidateNodes`를 실행한다.

`Preflight`는 6개 노드가 NTP 동기화 상태이며 `Etc/UTC` 시간대를 사용하는지 확인한다. 감사 시작 시각은 운영자 PC가 아니라 Node 1에서 가져온다. `FinalAudit`은 이 시각 이후의 현재 및 숫자 suffix로 회전된 `hadoop-yarn-*.log` daemon 로그를 검사한다. `.out`과 `/mnt/data/yarn/logs`의 컨테이너 로그는 이 검사의 범위가 아니며, sample은 별도로 YARN 집계 로그를 가져와 결과와 executor host를 확인한다.

UFW는 적용 전에 `active`와 기본 `deny (incoming)`을 모두 확인하고, Node 1의 `8030~8033,8088`, Worker의 `8040~8042`를 정확한 6개 사설 IP에만 허용한다. Spark cluster mode는 Worker 간 driver `7078`과 block manager `7079~7095`를 사용한다. block manager는 한 Worker에 여러 컨테이너가 배치되면 기본 포트에서 증가하므로 단일 포트만 열면 remote broadcast fetch가 멈춘다. NodeManager의 `0.0.0.0` bind와 인증 없는 PoC 경계는 GCP VPC 방화벽과 이 UFW 고정 IP 규칙의 조합이며, 둘 중 하나라도 넓어지면 신뢰 경계를 재검토한다.

`/yarn-logs`는 Raw·Bronze·Silver와 분리된 YARN 운영 로그 집계 경로다. `Start`가 경로가 없을 때만 HDFS 슈퍼유저 소유·`1777`로 만들며 기존 경로의 권한을 다시 덮어쓰지 않는다. 현재 클러스터에는 집계 로그 삭제 서비스를 실행하는 주체가 없으므로 자동 보존 기간을 집행하지 않는다. 별도 운영 작업에서 삭제 주체와 기간을 확정하기 전까지 HDFS 사용량을 점검하고 명시적으로 정리해야 하며, `yarn.log-aggregation.retain-seconds`만 선언해 보존이 적용된 것으로 판단하지 않는다.

2026-09-18 최종 검증 결과는 다음과 같다.

- `yarn node -list -all`: `worker-2`~`worker-6` 5대 모두 `RUNNING`
- Application ID: `application_1789675115055_0005`, `Final-State: SUCCEEDED`, 로그 집계 `SUCCEEDED`
- executor: `worker-2`~`worker-6`에 각 1개, AM은 `worker-4`
- HDFS: `/validation/S15P21C206-73/run-20260917T202547Z/output`, `_SUCCESS`, part 5개와 각 HDFS 블록 기반 파일 checksum(`hdfs dfs -checksum`, MD5-of-CRC; SHA-256 아님) 확인
  - `part-00000`: `0000020000000000000000002961d4bae9d6c0032d416af28ebefd1e`
  - `part-00001`: `000002000000000000000000cf7782859886e29ca2a349b7057b4f1d`
  - `part-00002`: `0000020000000000000000006df067d00b0725fd60a989741e9dfe4b`
  - `part-00003`: `000002000000000000000000e66f211f124e44f232bb30f417b8852d`
  - `part-00004`: `000002000000000000000000f62ef44324cd05d56a2ca64e237624e8`
- Node 2: YARN `16384MB/2 vCore`, 실행 중 컨테이너 `1024MB/1 vCore`, 호스트 used 약 2.7GiB·available 약 32.5GiB, swap 0, 관리자 권한 커널 저널 기준 OOM 없음
- 성공 run 시작 뒤 6개 YARN daemon 로그의 새 `ERROR`·`FATAL` 0건, `nn1=active`, `nn2=standby`, Live DataNode 5개 유지

Worker Python 요구 조건은 3.12.x이며, 2026-09-18 검증 당시에는 모두 `/usr/bin/python3.12`의 Python 3.12.3으로 일치했다. sample은 추가 패키지를 설치하지 않고 Spark가 제공하는 PySpark를 사용한다. 광고 호스트명은 6개 VM과 제출 컨테이너에서 모두 사설 IP로 해석돼야 하며 실패하면 sample을 시작하지 않는다.

클러스터의 단일 컨테이너 최대치는 24GiB/3 vCore지만 Node 2는 16GiB/2 vCore만 광고하므로 그보다 큰 컨테이너를 받지 않고 Nodes 3~6만 후보가 된다. 이는 의도된 이기종 자원 배치다. 다만 현재 Node 2 unit은 `MemoryMax`나 cgroup 기반 OS 하드캡을 두지 않으므로 2줄 sample 결과를 실제 Sector workload의 메모리 안전성으로 확대하지 않는다.

sample의 HDFS `root` 사용자 이름과 `1777` 경로는 격리된 검증용이다. `S15P21C206-76` Raw 적재는 `planetory-admin:hadoop`, mode `0750`인 정확한 staging Sector만 쓰고 `hdfs` 슈퍼유저는 staging 준비·감사·최종 rename만 수행한다. `yarn`은 `hadoop` 기본 그룹으로 확정 Raw를 읽는다. Bronze·Silver 출력 경로의 소유권은 각 변환 작업에서 별도로 확정한다.

`/validation/S15P21C206-73/run-<UTC>`는 실패하더라도 자동 삭제하지 않아 검증 증거와 실패 원인을 보존한다. 확인이 끝난 run은 운영자가 정확한 경로를 다시 확인하고 승인한 뒤 `hdfs dfs -rm -r /validation/S15P21C206-73/run-<UTC>`로 정리한다. unit 중지는 UFW 규칙, `/yarn-logs`, `/validation` 결과를 되돌리지 않는다.

## 수동 전환

실행 스크립트는 [validate-hdfs-recovery.ps1](scripts/validate-hdfs-recovery.ps1)이다. 각 변경 단계는 `WhatIf`를 지원하며 실행 전 YARN 실행 작업 0개, VM·HA 상태, 대상 호스트를 다시 확인한다. `RunId`는 UTC `yyyyMMddTHHmmssZ` 형식이고 검증 파일은 `/validation/S15P21C206-74/run-<RunId>`에 남긴다. `Prepare`는 256MiB 무작위 표본을 만들고 원본 SHA-256을 같은 run의 `baseline-256m.sha256`에 별도로 보존하며, `FinalAudit`은 이 값과 HDFS에서 다시 받은 표본의 SHA-256을 비교한다. 두 단계의 로컬 `/tmp` 파일은 RunId를 포함한 정확한 경로만 `rm -f --`로 성공·실패 종료 때 정리한다. cleanup 실패는 출력에 남기고, 본 검증이 이미 실패했다면 그 종료 코드를 유지한다.

계획된 전환은 기존 Active를 먼저 Standby로 내린 다음 일반 승격을 사용한다.

```bash
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToStandby nn1
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToActive nn2
```

Node 1 장애 시에는 정지 전에 Node 2·3의 JournalNode가 active이고 Node 2에서 잔존 JournalNode의 `8485/TCP`·`8480/HTTP`에 도달할 수 있는지 확인한다. 담당자가 GCP에서 `master-1`의 상태가 `TERMINATED`임을 확인한 뒤에만 Node 2에서 강제 승격하며, 원격 승격 명령 직전에도 종료 상태를 다시 확인한다. 기존 Active가 응답하지 않는 상태의 일반 승격은 대기할 수 있고 자동 fencing이 없으므로, VM 종료 확인 없이 `--forceactive`를 사용하면 안 된다.

```bash
gcloud compute instances describe master-1 --project=<NODE1_PROJECT> --zone=asia-east1-b --format='value(status)'
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs haadmin -transitionToActive --forceactive nn2
sudo -u hdfs env HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs fsck / -blocks
```

Node 1 복구 순서는 VM·mount → JournalNode → Standby NameNode → ResourceManager이며 각 서비스의 준비 포트를 최종 단정한다. 계획된 failback 뒤에는 NameNode가 재시작 전 블록 리포트를 놓쳐 초과 복제를 보류할 수 있으므로 `worker-2`~`worker-6`의 DataNode IPC `9867`에 전체 block report를 요청한다. 실패해도 다섯 대를 모두 시도해 `BLOCKED_DATANODE_IPC`에 실패 호스트 전체를 출력한 뒤 중단하며, 모두 성공한 경우에만 under·over·missing·corrupt가 0인지 확인한다. 일반 Worker 복구 순서는 VM·mount → DataNode → NodeManager다. JournalNode를 겸하는 Worker 3을 중지하기 전에는 Node 1·2의 JournalNode active와 상호 `8485`·`8480` 경로를 먼저 확인하고, 복구는 VM·mount → JournalNode(`8485`, `8480`) → DataNode → NodeManager 순서로 수행한다. FinalAudit은 Node 1~3의 JournalNode와 HDFS 5개·YARN 5개 노드 회복을 함께 확인한다.

```powershell
$Recovery = '.\infra\distributed-system\scripts\validate-hdfs-recovery.ps1'
$Common = @{
  RunId = '20260917T224900Z'
  Node1ProjectId = 'planetory-0001'
  WorkerNode = 4
  WorkerProjectId = 'planetory-0004-508301'
}
& $Recovery -Step Preflight @Common
& $Recovery -Step Prepare @Common -WhatIf
# 승인 후 Prepare → PlannedToNode2 → PlannedToNode1 → StopNode1 → PromoteNode2
# → StartNode1 → FailbackNode1 → StopWorkerAndObserve → StartWorker → FinalAudit 순서로 실행한다.
```

자동 fencing은 구성하지 않았으므로 응답 없는 Active를 대상으로 `hdfs haadmin -failover`를 실행하지 않는다. 복구 스크립트도 `-format`, `-bootstrapStandby`, `-initializeSharedEdits`, HDFS 삭제를 수행하지 않는다. 기존 단일 NameNode 데이터를 HA로 전환하는 경우에만 공식 절차에 따라 `hdfs namenode -initializeSharedEdits`를 별도로 수행한다.

`/validation/S15P21C206-74/run-<RunId>`는 실패 원인과 검증 증거를 위해 자동 삭제하지 않는다. 로컬 `/tmp` cleanup은 이 HDFS 경로를 건드리지 않으며 다른 RunId의 파일도 삭제하지 않는다. 증거 보존이 끝나면 운영자가 정확한 RunId를 다시 확인하고 승인한 뒤 `hdfs dfs -rm -r /validation/S15P21C206-74/run-<RunId>`로 무작위 표본과 기대 SHA-256 파일을 함께 정리한다.

2026-09-18 run `20260917T224900Z`의 실환경 결과는 다음과 같다.

- 당시 256MiB 표본은 0바이트로 채워져 SHA-256 `a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484`가 장애 전후 같았지만, 이 값은 로컬에서도 재현되는 상수라 해시만으로 장애 복구를 입증하지 않는다. 당시 실환경 증거는 HDFS 쓰기·읽기, block location, RF2·FSCK와 장애 전후 상태를 함께 본 결과이며, 보완된 스크립트의 무작위 표본·Prepare 해시 전달 경로는 아직 실환경에서 실행하지 않았다.
- 계획 전환은 Node 2 승격 8초, Node 1 복귀 6초였고 양쪽에서 기존 파일 읽기와 Node 2 신규 쓰기가 성공했다.
- Node 1 VM 중지는 62초, 종료 확인 뒤 Node 2 강제 승격과 읽기·신규 쓰기는 49초, Node 1 순차 복구는 94초, failback은 6초였다.
- Worker 4 중단 뒤 HDFS 기본 heartbeat/recheck 조건에서 Dead DataNode 1개와 under-replicated 10개를 740초에 관찰했다. 중단 중 표본 읽기·checksum은 성공했고 재복제가 진행됐다.
- Worker 4의 DataNode→NodeManager 복구와 HDFS·YARN 5개 노드 회복은 88초였다. 전체 block report 뒤 표본 경로는 under·over·missing·corrupt 0, 평균 복제 2.0, `HEALTHY`였다.
- 장애 창 로그의 SIGTERM은 의도한 VM 종료였고, NameNode 재기동 직후의 미등록 DataNode report는 전체 block report로 해소했다. 복구 완료 `2026-09-17T23:57:47Z` 이후 HDFS·YARN 6개 노드 로그의 새 오류는 0건이다.
- ResourceManager·Airflow·Publisher는 Node 1 단일 장애 경계다. ResourceManager는 Node 1 복구 후 정상화했으며 Airflow·Publisher 컨테이너는 당시 배포되지 않아 재기동 검증 대상이 아니었다. 배포 후에는 실패한 Airflow 단계부터 재시도하고 Publisher 멱등성을 별도 확인한다.

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

## TESS 원천 수집 (`S15P21C206-75`)

Worker 2~6의 호스트 Python 3.12에서 [run-tess-ingestion.ps1](scripts/run-tess-ingestion.ps1)로 SPOC 2분 Light Curve를 수집한다. Tailscale 대상과 실제 호스트명, `/mnt/data` mount, passwordless sudo, 디스크 사용률 75% 미만·가용 공간 기본 100GiB 이상, 다른 활성 수집 unit·수동 downloader 부재와 공식 MAST 연결을 `Preflight`에서 먼저 확인한다. 코드는 `/mnt/data/planetory-ingestion/releases/<ReleaseId>`, 실행 데이터는 `/mnt/data/staging/S15P21C206-75/run-<RunId>`에 둔다. release는 결정적 내용 SHA로 식별하고 root 소유·일반 사용자 쓰기 금지로 고정한다.

실행 순서는 `Preflight` → `Install` → `SourceList` → Worker 2의 `Start -Sector 1 -Limit 1`·`Audit` canary → `InstallSupervisor`다. systemd 감독기는 기존 수동 PID가 있으면 먼저 인계 대기하고, 신규 Run에서는 Sector 1→2→6→7→8→9→10→11→12→13을 재개·감사한다. 한 Worker에는 supervisor 한 개만 두고 설정의 `download_concurrency`만큼 서로 다른 파일을 동시에 받는다. 현재 운영값은 4다. Worker 공통 잠금은 RunId가 다른 unit의 중복 실행도 막고, 잠금 충돌은 비정상 종료로 처리해 systemd 재시작을 유지한다. 설치 시 이전 unit은 state가 `COMPLETE`이고 inactive인 경우에만 disable해 재부팅 경합을 막는다. 프로세스 실패는 30초 후 systemd가 재기동하고, 네트워크 연속 실패는 최대 15분 backoff한다. `Type=notify` unit은 실제 다운로드·감사 진행 heartbeat가 5분간 없으면 watchdog 실패로 프로세스를 종료하고 재기동한다. 디스크 75%에서 멈추고 70% 미만에서 재개한다. 운영자 점검은 `Pause`로 활성 Sector를 자동 판별하고 supervisor를 먼저 정지한 뒤 현재 RunId·worker slot·Sector와 일치하는 기존 downloader만 종료한다. 완료 FITS와 `.part`를 보존하고 pause manifest를 남기며 HDFS 원본이나 다른 RunId를 삭제하지 않는다. 원천 파일을 HDFS로 옮기는 단계는 다운로드 전수 감사 뒤 별도 수행한다.

2026-09-18 데이터 RunId `20260918T080417Z`는 13:21 UTC에 Worker 5대의 Sector 3·4·5 전수 감사를 모두 통과했다. 고정 source list와 실제 FITS는 55,986개로 일치하며 검증 원본 100.94GiB, manifest를 포함한 run 디렉터리 101.13GiB, `.part` 0, 최신 실패 0이다. 누적 event 82,986건은 모두 `VALIDATED`이고 HTTP·기타 재시도와 손상된 완결 JSONL은 0이며 `/mnt/data` 사용률은 각 2%다. 순차 기준 3.12MiB/s에서 제한 동시성 4의 같은 15분 창 10.54MiB/s로 3.38배·237.8% 증가했다. 최종 ReleaseId `20260918T124821Z`, 내용 SHA `14b52924c9a60625dd78f5e10cbf9743399343fd035954de9e2a7c1077f900ee`는 Worker 2의 15분 canary 뒤 3~6에 한 대씩 롤링 적용했다. 별도 hang 검사에서는 worker-2 main PID `74730`을 `SIGSTOP`해 5분 watchdog timeout과 30초 재시작 뒤 PID `75912`, `NRestarts=0→1` 복구를 확인했다. 완료된 unit은 처음에는 `success/inactive`·enabled였고, 2026-09-19 expansion hardening rollout에서 `COMPLETE`·inactive를 다시 확인한 뒤 Worker 2~6 모두 disabled했다.

Sector 1~13 확대는 기존 RunId를 수정하지 않는다. 2026-09-19 공식 목록은 247,824개, `source_list_sha256=8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38`이다. 신규 expansion Run은 Sector 1·2·6~13 191,838개만 받고, 완료 뒤 `FinalCoverage`가 기존 3~5와 신규 10개 Sector의 Worker별 audit·complete, 실제 FITS 집합·바이트, `.part` 0과 총 247,824개를 합산한다. 최종 manifest와 SHA-256 sidecar는 신규 Run의 manifest 디렉터리에 5대 모두 같은 내용으로 보존한다. 이 단계까지가 75번의 다운로드 완료 조건이며 HDFS 적재는 76번 범위다.

실제 expansion은 데이터 RunId `20260919T005932Z`로 실행 중이다. 리뷰 보완 release `20260919T015748Z`, 내용 SHA `3d22c384455e6d2dd2c2049ea92ffe88b7725d63444bc571eb3770e13f54d298`은 비 ASCII FITS 무결성 처리, 따옴표 안 `/` 보존, Worker 전역 잠금과 이전 완료 unit 안전 비활성화를 포함한다. worker-2 canary는 기존 2,964개를 재사용하고 `SIGKILL` 뒤 PID `134505→134706`, `NRestarts=0→1`로 같은 Run을 재개했다. 이후 Worker 3~6을 한 대씩 재시작했고, 5대 모두 새 release `enabled/active/running`, lock PID 일치, 이전 unit disabled를 확인했다. 롤링 직후 합산은 17,273/191,838개(9.00%), 32.76GiB, 9.63MiB/s, 현재 실패·429·재시도 0이며 ETA 약 9시간 46분이다. Sector별 다운로드·감사는 서버에서 자율 수행한다. 운영자 연결이 필요한 단계는 모든 unit이 `COMPLETE`가 된 뒤 기존·신규 Run 증거를 결합하는 `FinalCoverage`뿐이며, 실패하거나 연결이 끊겨도 원본을 다시 받지 않고 같은 단계를 재실행한다.

## Spark 제출

Spark는 다음 모드로 제출한다.

```bash
--master yarn --deploy-mode cluster
```

현재 기본 이미지 `apache/spark:3.5.5-python3`는 JDK 11.0.26과 `hadoop-client-api/runtime` 3.3.4를 포함한다. Hadoop 3.5.0 단일 HDFS에 대한 Parquet 쓰기·읽기와 checksum은 로컬 일회성 환경에서 통과했고, `S15P21C206-73`에서 같은 이미지의 실제 6대 QJM·YARN sample application으로 Application ID, 성공 상태, HDFS 결과와 executor 로그까지 확인했다.

Executor는 Docker 이미지가 아니라 Worker의 YARN 프로세스에서 실행된다. Python 의존성은 다음 중 하나로 준비한다.

- 모든 Worker에 같은 Python 버전과 패키지 설치
- `--archives`로 실행 환경 배포

제출 이미지에만 설치한 패키지는 Worker에 전달되지 않는다.

다음 항목은 후속 구현 대상이다.

- Airflow 실제 DAG
- TIC·TCE·TOI·Archive·ExoFOP 원천별 snapshot 수집
- Spark 제출 연결
- Spark History Server

## 로컬 구성 검사

저장소 루트에서 `python infra/distributed-system/validate.py`, `pwsh -File infra/distributed-system/scripts/test-hdfs-recovery.ps1`, `pwsh -File infra/distributed-system/scripts/test-tess-ingestion.ps1`을 실행한다. CI는 XML·Compose 정적 검사를 수행하며 PowerShell Runner 검증은 `S15P21C206-91` 범위다. 실제 HDFS 쓰기·읽기·RF2·checksum은 `S15P21C206-72`, YARN·Spark 제출은 `S15P21C206-73`, Worker 장애·수동 NameNode 전환은 `S15P21C206-74`에서 런타임 검증을 완료했다. Gold 공개·롤백은 후속 통합 검증으로 남긴다.

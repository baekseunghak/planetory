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

최초 설치 당시 HDFS unit은 실행 중이지만 부팅 자동 시작은 비활성이었다. 2026-09-22 이후의 운영 상태와 재부팅 복구는 [전체 노드 부팅 복구](#전체-노드-부팅-복구)를 따른다.

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
- [run-tess-hdfs-load.ps1](scripts/run-tess-hdfs-load.ps1), [test-tess-hdfs-load.ps1](scripts/test-tess-hdfs-load.ps1): 75의 최종 coverage를 입력으로 Sector 1~13을 Worker 5개 SequenceFile writer로 병렬 적재하고 RF2·manifest·첫/중간/마지막 offset 복원 감사 뒤 덮어쓰기 없는 원자 rename으로 확정한다. 상세 실행·복구 계약은 [TESS HDFS Raw 적재](../../distributed-system/ingestion/hdfs/README.md)를 따른다.
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

최초 설치 단계는 unit을 활성화하거나 시작하지 않는다. `Start`는 Node 1의 ResourceManager와 Node 2~6의 NodeManager만 시작하고 준비 포트를 최대 30초 기다린다. `S15P21C206-74` 당시에는 자동 fencing이 없어 HDFS·YARN unit을 부팅 시 비활성으로 유지했다. 현재 부팅 설정·검증 범위는 [전체 노드 부팅 복구](#전체-노드-부팅-복구)를 따른다.

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

## 배포용 Docker 준비 (`S15P21C206-226`)

CI의 deploy job은 SSH로 접속해 `docker compose`를 실행한다. 그러려면 노드에 Docker 엔진과 **compose 플러그인**이 있고 배포 계정이 `docker` 그룹에 있어야 한다. `docker.io` 패키지에는 compose 플러그인이 들어 있지 않으므로 엔진만 설치하면 배포가 실패한다.

[install-docker-host.sh](scripts/install-docker-host.sh)가 사전 검사·설치·검증을 한 번에 한다. Hadoop·YARN 데몬과 설정에는 손대지 않는다.

```bash
# 변경 없이 현재 상태만 본다. 준비됐으면 0, 조치가 필요하면 1을 반환한다.
bash install-docker-host.sh --node 6 --deploy-user planetory-admin --check-only

# 실제 설치. root로 실행한다.
sudo bash install-docker-host.sh --node 6 --deploy-user planetory-admin
```

사전 검사는 노드 번호와 실제 호스트명이 맞는지, 배포 계정이 있는지, `/`에 5GB 이상 여유가 있는지 확인하고 하나라도 어긋나면 변경 전에 중단한다. 이미 갖춰진 항목은 건너뛰므로 여러 번 실행해도 안전하다.

검증은 설치 사실이 아니라 **배포 계정이 새 로그인에서 데몬에 도달하는지**를 본다. `usermod`는 이미 열려 있는 세션에 소급되지 않기 때문이다. 이어서 이 호스트의 Hadoop unit이 `active`인지 확인하고, 하나라도 아니면 실패로 끝낸다.

실패하면 그 노드에서 멈추고 다음 노드로 넘어가지 않는다. Docker 설치만 되돌리려면 `sudo apt-get remove --purge docker.io docker-compose-v2`를 실행한다. 그룹 변경은 `sudo gpasswd -d <계정> docker`로 되돌린다.

2026-09-21에 node-1~6 전부에서 Docker 29.1.3과 compose 2.40.3을 확인했고, 각 배포 계정이 레지스트리에서 이미지를 pull 하는 것과 Hadoop 데몬이 계속 `active`인 것을 실측했다. 같은 노드에 두 번 실행해 멱등성도 확인했다.

초기 판은 Hadoop unit 이름을 `hdfs-*`로 추측해 검사가 아무것도 확인하지 않고 통과했다. 실제 이름은 `hadoop-hdfs-*`다. unit 이름이 하나도 맞지 않으면 경고를 남기도록 고쳤다.

## 전체 노드 부팅 복구

`S15P21C206-252` 적용 전 관측: 2026-09-22 `.ssh` 경유 읽기 전용 점검에서 Node 1~6은 모두 접속·mount·Hadoop 3.5.0이 확인되고 서비스는 실행 중이나 boot enable은 비활성이었다. Node 1·2 NameNode는 모두 Standby, 두 Safe Mode는 OFF, JournalNode 세 대는 응답해 HDFS Active가 없는 상태였다. **당시에는 HDFS 클라이언트 조회가 성공하지 않았으므로** 설치 전 HA 복구를 별도 승인받았다. 다음 문단은 이 관측 이후의 운영 적용 결과다.

2026-09-22 후속 운영 적용·순차 재부팅 검증 완료: 승인 뒤 두 NameNode가 모두 Standby이고 Safe Mode OFF·JournalNode 3대가 응답함을 재확인해 `nn1`을 일반 승격했다. TESS/Airflow/HDFS/Bronze 운영 release `20260922T021406Z`의 대표 코드 SHA-256은 현재 저장소와 일치해 중복 배포하지 않았다. 새 root 소유 부팅 복구 release `/opt/planetory-boot-recovery/releases/5fec7b88`를 Node 1~6에 설치하고 Node 2~6의 역할별 unit, 마지막으로 Node 1 unit과 timer를 활성화했다. Node 6→5→4→3→2→1을 한 대씩 재부팅했고 매번 boot ID 변경·로컬 mount/서비스 자동 시작·클러스터의 Live DataNode 5개와 YARN NodeManager 5개를 확인했다. Node 1 재부팅 때는 Safe Mode ON 동안 timer가 승격을 보류한 뒤 OFF가 되자 `nn1`을 일반 승격했고 ResourceManager가 자동 복구됐다. 최종 `nn1=active`, `nn2=standby`, JournalNode 3대, 저복제·누락 block 0, Sector 14 Raw·Bronze `_READY.json` FSCK `HEALTHY`, YARN 실행 application 0, Airflow DB·Scheduler healthy와 Tailnet UI proxy를 확인했다. 파이프라인은 의도적으로 `tess_pipeline_enabled=false`, 상한 14, 발견 DAG pause를 유지했다. **응답 없는 Active의 자동 장애 전환, 동시 다중 노드 장애, Sector 15 이후 데이터 처리까지 검증한 것은 아니다.**

[configure-hadoop-boot-recovery.sh](scripts/configure-hadoop-boot-recovery.sh)는 기존 Node 1~6 HDFS·YARN systemd unit을 재부팅 시 기동하도록 등록한다. 설치 전 실제 호스트·사설 IP·mount·Hadoop 3.5.0·기존 NameNode format·가동 unit을 확인하고, Node 1에서는 양쪽 NameNode가 응답하며 정확히 한 Active이거나, 둘 다 Standby라면 JournalNode 정족수와 Safe Mode OFF를 확인한다. 기존 unit·HDFS 데이터·실행 중 데몬은 변경하거나 재시작하지 않는다. NameNode는 로컬 JournalNode, NodeManager는 로컬 DataNode 뒤에 시작을 시도하되 선행 서비스의 일시 실패가 재시도를 영구 차단하지 않는다. Node 1 ResourceManager는 HDFS 파일 조회가 가능해질 때까지 30초 간격으로 시작을 재시도한다. Node 1의 별도 systemd timer는 부팅 40초 뒤부터 매분 [boot controller](scripts/hadoop-boot-controller.sh)를 실행한다. **설치 시점에도 두 NameNode가 Standby라면 timer 즉시 활성화에 따라 nn1 승격이 일어날 수 있으므로, 적용 직전 승인 범위에 이 승격을 포함한다.**

적용 전에는 파이프라인을 drain하고 진행 중 YARN application이 없는지 확인한다. Node 2~6, 마지막에 Node 1 순서로 **각 노드에서** 스크립트 두 파일을 안전하게 전달·검증한 후 실행한다. 설치·enable 및 테스트 재부팅은 운영 변경이므로 정확한 노드·작업 범위의 직전 승인을 별도로 받는다. 기존 설치 스크립트 `install-hdfs-host.sh`와 `install-yarn-host.sh`는 초기 빈 클러스터 전용이므로 실행 중 서버에 다시 사용하지 않는다.

```powershell
# 작업 PC에서 먼저 접근 계정/호스트 키를 확인한다. 업로드와 설치는 운영 승인 후에만 실행한다.
tailscale ssh SSAFY@node-1 'hostname -s'
tailscale ssh planetory-admin@node-2 'hostname -s'
```

```bash
# 6대 각각, sudo 권한으로 실행한다. 예: Node 2 (Node 1에는 --node 1).
# 두 파일은 같은 디렉터리에 보관하며, 배포 전 SHA-256과 root 소유권을 확인한다.
sudo bash configure-hadoop-boot-recovery.sh --node 2 --check
sudo bash configure-hadoop-boot-recovery.sh --node 2 --install
for unit in hadoop-hdfs-journalnode hadoop-hdfs-namenode hadoop-hdfs-datanode hadoop-yarn-nodemanager; do systemctl is-enabled "$unit" || exit 1; done
# 마지막 Node 1 설치 후 timer가 즉시 활성화된다.
systemctl is-active planetory-hdfs-boot-recovery.timer
```

Controller는 mount·NameNode format·양쪽 NameNode의 **모두 응답하는** HA 상태·JournalNode 정족수·Node 1 Safe Mode 종료를 확인한다. 양쪽이 10초 간격으로 계속 standby일 때만 `nn1`을 일반 `-transitionToActive`로 승격한다. 이미 Active가 있으면 유지하고, 상대가 응답하지 않거나 두 Active가 관측되면 승격하지 않는다. `--forceactive`, fencing, format, 데이터 삭제를 실행하지 않는다. 계획 전환이나 HA 유지보수 **전에** Node 1에서 `sudo touch /etc/planetory/hadoop-boot-recovery.disabled`로 timer의 승격 동작을 막고, 수동 복구·검증을 마친 후 정확한 파일을 운영자가 해제한다. 구형 [수동 장애 전환](#수동-전환) 절차와 달리 **응답 없는 기존 Active의 자동 failover는 지원하지 않는다**. Node 1이 계속 중단되면 ResourceManager·Airflow 및 이 controller도 복구되지 않으며 Node 2 강제 승격에는 별도 VM 종료 확인이 필요하다.

실환경 검증은 노드별 새 부팅 ID, mount, 활성/부팅 enabled unit, Node 1 timer, `haadmin` active/standby, Safe Mode OFF, `dfsadmin -report` Live DataNode 5개·RF2, `yarn node -list` NodeManager 5개, Airflow DB·Scheduler/Webserver 자동 재시작, 중단된 Sector DAG의 재개와 원본 checksum을 순서대로 확인한다. Worker 단일 재부팅 → Node 2/3 재부팅 → Node 1 재부팅 → 전체 재부팅 순서로 작은 범위부터 실측하고, 노드별 실패 시 다음 재부팅을 중단한다. Node 1이 재부팅 중 Node 2가 이미 Active였다면 timer는 건드리지 않는다. 설치 직후 timer가 구동됐어도 재부팅 성공으로 보고하지 않는다. 장애 시에는 `systemctl status planetory-hdfs-boot-recovery.timer`, `journalctl -u planetory-hdfs-boot-recovery.service -n 50 --no-pager`와 기존 수동 복구 절차로 원인을 확인한다. 자동 시작을 일시 중단하려면 해당 노드의 정확한 unit만 `systemctl disable`하고 현재 실행 중인 서비스는 별도로 판단한다.

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
- 접근 방법: Tailscale Serve의 tailnet 전용 `https://node-1.tail97e363.ts.net/`. Airflow 자체는 `127.0.0.1:8081`에만 바인딩하고 Funnel은 사용하지 않는다.

2026-09-22에는 [Node 1 전용 배포 스크립트](scripts/deploy-tess-airflow-node1.sh)로 `/opt/planetory-airflow/releases/20260921T213515Z` 이미지를 빌드하고 DB·Scheduler·Webserver를 시작했다. `airflow dags list-import-errors` 0건, `tess_sector_download_raw_bronze` 표시·일시정지, DB healthy, tailnet HTTPS 응답 200을 확인했다. 다른 운영 서비스나 기존 HDFS 데이터는 변경하지 않았다. 생성된 UI `viewer` 계정은 읽기 전용이다. 최초 `--use-random-password` 출력에는 암호가 없어 계정 암호를 재설정했고, 새 암호는 Node 1의 root 전용 `/etc/planetory/airflow/viewer-password`에만 보관한다. 권한 있는 운영자가 아래 명령으로 직접 확인한다. 암호를 Git·Jira·채팅에 기록하지 않는다.

```powershell
tailscale ssh SSAFY@node-1 'sudo cat /etc/planetory/airflow/viewer-password'
```

최초 UI 배포 시점에는 DAG 화면만 볼 수 있었고, 실행 전 SSH Connection 6개·제한 sudo·불변 release·수집 run 계보의 별도 확인이 필요했다. 후속 release의 실제 설정과 제한 실행 결과는 아래에 기록한다.

2.x에서의 기존 코드 갱신은 새 불변 `/opt/planetory-airflow/releases/<UTC release>`에 `compose.yaml`, `distributed-system/airflow/`, `infra/distributed-system/scripts/deploy-tess-airflow-node1.sh`를 배치하고 `--update`를 실행해 활성 run 0건과 DAG import를 확인한 뒤 Scheduler·Webserver만 교체했다. 3.2.2용 현재 스크립트의 `--update`는 Scheduler가 이미 3.2.2인 경우에만 실행하며 Scheduler·DAG Processor·API Server를 교체한다. 어느 버전에서도 코드 갱신 명령은 새 Sector 실행이나 DB 버전 마이그레이션을 수행하지 않는다.

### Airflow 3.2.2 전환

전환 전 Node 1 운영은 2.10.5였다. 2026-09-22 먼저 공식 3.2.2 베이스로 격리 이미지를 빌드해 다섯 DAG import 오류 0건을 확인했다. 이후 승인된 일회성 전환으로 release `/opt/planetory-airflow/releases/20260922T143000Z`를 설치했다. 기존 `--update`는 2.x→3.x 마이그레이션 경로가 아니며 3.2.2가 이미 실행 중일 때만 허용한다.

전환은 [Node 1 일회성 업그레이드 스크립트](scripts/upgrade-tess-airflow3-node1.sh)로 수행한다. 활성 DagRun 0건·발견 DAG pause·`tess_pipeline_enabled=false` 확인 → 기존 Scheduler·Webserver 정지 → PostgreSQL `airflow` DB 일관성 백업 → 새 이름의 DB에 백업 복제 → **복제본에만** `airflow db migrate` → 새 API Server(`127.0.0.1:8081`)·Scheduler·DAG Processor 시작 → DAG import·Viewer·중지 플래그·health 검증 순서다. 새 DB URL과 별도 JWT secret은 root 전용 Airflow 환경 파일에 보관하고 기존 Fernet key·UI secret은 유지한다. SSH Connection·DagRun·pause 보존, Task SDK 상태 조회, UI 로그인·Tailnet Serve·재부팅 자동 시작은 운영 전환 후 별도 검증한다. 새 Sector 처리와 로컬 삭제는 전환 검증에 포함하지 않고 파이프라인 중지 상태를 유지한다. 운영 DB 스키마나 원본 데이터는 제자리 수정하지 않는다.

오류 시 스크립트가 새 3.x 서비스를 중지하고 보존한 2.10.5 release·기존 DB URL로 Scheduler·Webserver 복귀를 시도한다. 자동 복귀 실패는 수동 조사가 필요하다. 전환 후 3.x에서 새 DagRun이 생성되면 구 DB에 반영되지 않으므로, 복귀 전 이를 확인하고 별도 복구 판단을 한다. DB 복제·서비스 교체는 대상 DB명, 백업 위치, rollback release와 영향 시간을 확정해 실행 직전 별도 승인을 받는다. 전환 중에는 UI가 잠시 중단되며 HDFS·YARN·수집 Worker는 건드리지 않는다.

2026-09-22 운영 전환 결과: 기존 `airflow` DB는 그대로 보존하고 root 전용 `/mnt/data/airflow-backups/20260922T143000Z/airflow2.dump`(mode 0600)로 백업했다. 복제 DB `airflow3_20260922t143000z`에만 `airflow db migrate`를 적용하고 새 root 전용 `/etc/planetory/airflow/airflow3-20260922T143000Z.env`(mode 0600)로 연결했다. 새 Scheduler·DAG Processor·API Server의 이미지가 모두 `local/planetory-airflow:20260922T143000Z`, 재시작 정책 `unless-stopped`, 상태 running이다. 구 Webserver는 중지했으나 삭제하지 않았다. API `/api/v2/version`은 3.2.2, metadata·Scheduler·DAG Processor health는 모두 healthy, Tailnet UI와 health는 HTTP 200, Tailscale Serve는 tailnet 전용 loopback 프록시를 유지한다. 원본/복제 DB의 TESS DAG 5개·DagRun 20개·task 이력 39개·SSH Connection 6개와 다섯 DAG pause 상태가 일치하고 import 오류 0건이다. Viewer 계정과 `tess_pipeline_enabled=false`도 보존했다. **Viewer 실제 로그인, Task SDK를 통한 실행, 신규 Sector 처리, 서버 재부팅은 이번 버전 전환에서 검증하지 않았다.**

2026-09-22 release `20260922T134419Z`에서 기존 1~13 단일 DAG `tess_sector_download_raw_bronze`를 제거했다. 갱신 이미지가 이전 이미지를 기반으로 하므로 Dockerfile에서 해당 이전 DAG 파일도 명시적으로 제거한다. 활성 run 0건과 과거 DAG DagRun 0건을 확인한 뒤 Scheduler·Webserver만 교체하고 Airflow DB의 비활성 과거 DAG metadata 행 1건을 삭제했다. 현행 5개 DAG, import 오류 0건, UI health 200을 확인했다. 기존 DB 볼륨·다른 release·HDFS 데이터는 유지한다.

후속 release `20260922T135740Z`는 현행 5개 DAG의 `dag_display_name`에 `dag_id · 한국어 역할`을 설정하고 `description`을 추가했다. Node 1 Scheduler·Webserver만 교체한 뒤 운영 metadata에서 다섯 한국어 이름과 설명, DAG ID·pause 상태 보존, import 오류 0건, UI health 200을 확인했다. 표시 문구만 바꿨으며 데이터 DAG를 trigger하지 않았다.

2026-09-22에는 `/opt/planetory-hdfs-load/releases/20260921T230610Z`를 Node 1~6에, `/opt/planetory-bronze/releases/20260921T230610Z`를 Node 1에 설치했다. Node 1 Airflow에도 `/opt/planetory-airflow/releases/20260921T230610Z`를 설치하고 위 갱신 경로로 Scheduler·Webserver만 새 이미지로 교체했다. 기존 DB 컨테이너와 Tailscale Serve는 유지했다. 새 DAG 4개와 기존 단일 DAG 모두 일시정지, 신규 DagRun 0건, import 오류 0건, 로컬 UI health 성공을 확인했다. 이는 **코드 배포 검증**이며 SSH Connection·제한 sudo 권한과 실제 데이터 처리·재개는 검증하지 않았다. 어떤 DAG도 실행하거나 로컬 FITS를 삭제하지 않았다.

2026-09-22 후속 release `20260922T021406Z`에는 HDFS 코드를 Node 1~6, ingestion 코드를 Worker 2~6, Bronze와 Airflow를 Node 1에 설치했다. Airflow DB·Tailscale Serve는 유지하고 Scheduler·Webserver만 교체했으며 import 오류 0건이다. [Airflow 전용 접근 설정](scripts/configure-tess-airflow-node1.sh)은 Node 1의 root 관리 SSH 키와 별도의 Airflow 공개키를 사용한다. 전용 `tess-airflow` 계정은 Node 1 사설 IP에서만 인증하고 Worker에서는 완료 marker를 읽을 수 있는 그룹에만 속한다. 새 키의 비밀 값은 Node 1의 `/etc/planetory/airflow/ssh/`에 보관하고 Scheduler에 읽기 전용으로 mount한다. DB에는 내부 IP·계정·키 *경로*만 저장하며 기존 관리 계정의 광범위한 sudo 권한은 변경하지 않는다. 전용 계정의 sudo는 release 고정 Node 1 admission/Raw/Bronze 명령과 Worker의 수집 unit 시작으로 제한된다. Airflow SSH Connection 6개 모두 공개키 인증과 host-key 검증으로 연결됐다.

운영 상한은 DAG Param 기본 70과 영속 `tess_pipeline_max_sector` 중 작은 값이다. 이 실험은 `14`로 고정하고 `tess_pipeline_enabled=true`를 켜 [Sector 14 제어 스크립트](scripts/control-tess-sector14.ps1)로 최초 발견 run을 시작했다. `-Step Drain`은 신규 허가·trigger를 멈추지만 이미 시작된 Worker/systemd 작업은 이어진다. Sector 14 원천 19,970개의 run `20260922T024642Z`에서 다운로드·Raw·로컬 삭제·Bronze 네 DAG가 모두 성공했다. Raw `_READY`의 제품 수 19,970·RF2·Parquet success, FSCK HEALTHY·저복제/누락/손상 0을 확인했다. cleanup 전 75개 bundle 모두 fast 재감사가 HEALTHY였고 Worker 5대의 FITS 19,970개 삭제 뒤 잔여 0개다. Bronze final `_READY`의 제품 19,970개·관측값 386,159,890개·파싱 오류 0개·RF2, Spark/YARN 성공과 FSCK HEALTHY를 확인했다. cleanup task는 약 13분 30초로, 성능 개선은 별도 검증이 필요하다. 이후 `-Step Drain`을 실행해 `tess_pipeline_enabled=false`, 발견 DAG pause·활성 단계 run 0건으로 제한했다. 배포·실행과 재부팅 검증은 사용자가 Node 1~6 release, Sector 14 삭제, Worker 4와 Node 1 재부팅 범위를 명시 승인한 뒤 수행했다.

당시 Worker 4 다운로드 중 재부팅은 부팅 ID 변경, 수집 unit enabled 자동 재개, 이벤트 688→1,728건 증가, DataNode·NodeManager 수동 복구로 확인했다. 당시 Node 1 재부팅 뒤 Docker/Airflow는 자동 재시작했지만 HDFS/YARN은 수동 복구가 필요했다. NameNode가 6,631개 block의 30초 Safe Mode 연장 중 Active 전환을 거부했으므로 [기존 재부팅 검증 스크립트](scripts/verify-tess-reboot.ps1)는 Safe Mode OFF를 기다린 뒤 전환한다. 부팅은 이미 끝났는데 후속 복구만 실패했다면 `-Step RecoverNode1`로 **재부팅 없이** 이어서 복구한다. 이후의 자동 부팅 검증은 [전체 노드 부팅 복구](#전체-노드-부팅-복구)에 기록했다. Sector 15~70 실행까지 입증한 것은 아니다.

## TESS 원천 수집 (`S15P21C206-75`)

Worker 2~6의 호스트 Python 3.12에서 [run-tess-ingestion.ps1](scripts/run-tess-ingestion.ps1)로 SPOC 2분 Light Curve를 수집한다. Tailscale 대상과 실제 호스트명, `/mnt/data` mount, passwordless sudo, 디스크 사용률 75% 미만·가용 공간 기본 100GiB 이상, 다른 활성 수집 unit·수동 downloader 부재와 공식 MAST 연결을 `Preflight`에서 먼저 확인한다. 코드는 `/mnt/data/planetory-ingestion/releases/<ReleaseId>`, 실행 데이터는 `/mnt/data/staging/S15P21C206-75/run-<RunId>`에 둔다. release는 결정적 내용 SHA로 식별하고 root 소유·일반 사용자 쓰기 금지로 고정한다.

실행 순서는 `Preflight` → `Install` → `SourceList` → Worker 2의 `Start -Sector 1 -Limit 1`·`Audit` canary → `InstallSupervisor`다. systemd 감독기는 기존 수동 PID가 있으면 먼저 인계 대기하고, 신규 Run에서는 Sector 1→2→6→7→8→9→10→11→12→13을 재개·감사한다. 한 Worker에는 supervisor 한 개만 두고 설정의 `download_concurrency`만큼 서로 다른 파일을 동시에 받는다. 현재 운영값과 허용 상한은 16이다. Worker 공통 잠금은 RunId가 다른 unit의 중복 실행도 막고, 잠금 충돌은 비정상 종료로 처리해 systemd 재시작을 유지한다. 설치 시 이전 unit은 state가 `COMPLETE`이고 inactive인 경우에만 disable해 재부팅 경합을 막는다. 프로세스 실패는 30초 후 systemd가 재기동하고, 네트워크 연속 실패는 최대 15분 backoff한다. `Type=notify` unit은 실제 다운로드·감사 진행 heartbeat가 5분간 없으면 watchdog 실패로 프로세스를 종료하고 재기동한다. 디스크 75%에서 멈추고 70% 미만에서 재개한다. 운영자 점검은 `Pause`로 활성 Sector를 자동 판별하고 supervisor를 먼저 정지한 뒤 현재 RunId·worker slot·Sector와 일치하는 기존 downloader만 종료한다. 완료 FITS와 `.part`를 보존하고 pause manifest를 남기며 HDFS 원본이나 다른 RunId를 삭제하지 않는다. 원천 파일을 HDFS로 옮기는 단계는 다운로드 전수 감사 뒤 별도 수행한다.

2026-09-18 데이터 RunId `20260918T080417Z`는 13:21 UTC에 Worker 5대의 Sector 3·4·5 전수 감사를 모두 통과했다. 고정 source list와 실제 FITS는 55,986개로 일치하며 검증 원본 100.94GiB, manifest를 포함한 run 디렉터리 101.13GiB, `.part` 0, 최신 실패 0이다. 누적 event 82,986건은 모두 `VALIDATED`이고 HTTP·기타 재시도와 손상된 완결 JSONL은 0이며 `/mnt/data` 사용률은 각 2%다. 순차 기준 3.12MiB/s에서 제한 동시성 4의 같은 15분 창 10.54MiB/s로 3.38배·237.8% 증가했다. 최종 ReleaseId `20260918T124821Z`, 내용 SHA `14b52924c9a60625dd78f5e10cbf9743399343fd035954de9e2a7c1077f900ee`는 Worker 2의 15분 canary 뒤 3~6에 한 대씩 롤링 적용했다. 별도 hang 검사에서는 worker-2 main PID `74730`을 `SIGSTOP`해 5분 watchdog timeout과 30초 재시작 뒤 PID `75912`, `NRestarts=0→1` 복구를 확인했다. 완료된 unit은 처음에는 `success/inactive`·enabled였고, 2026-09-19 expansion hardening rollout에서 `COMPLETE`·inactive를 다시 확인한 뒤 Worker 2~6 모두 disabled했다.

Sector 1~13 확대는 기존 RunId를 수정하지 않는다. 2026-09-19 공식 목록은 247,824개, `source_list_sha256=8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38`이다. 신규 expansion Run은 Sector 1·2·6~13 191,838개만 받고, 완료 뒤 `FinalCoverage`가 기존 3~5와 신규 10개 Sector의 Worker별 audit·complete, 실제 FITS 집합·바이트, `.part` 0과 총 247,824개를 합산한다. 최종 manifest와 SHA-256 sidecar는 신규 Run의 manifest 디렉터리에 5대 모두 같은 내용으로 보존한다. 이 단계까지가 75번의 다운로드 완료 조건이며 HDFS 적재는 76번 범위다.

실제 expansion은 데이터 RunId `20260919T005932Z`로 실행했다. 리뷰 보완 release `20260919T015748Z`, 내용 SHA `3d22c384455e6d2dd2c2049ea92ffe88b7725d63444bc571eb3770e13f54d298`은 비 ASCII FITS 무결성 처리, 따옴표 안 `/` 보존, Worker 전역 잠금과 이전 완료 unit 안전 비활성화를 포함한다. worker-2 canary는 기존 2,964개를 재사용하고 `SIGKILL` 뒤 PID `134505→134706`, `NRestarts=0→1`로 같은 Run을 재개했다. 이후 Worker 3~6을 한 대씩 재시작했고, 5대 모두 새 release `enabled/active/running`, lock PID 일치, 이전 완료 unit disabled를 확인했다. 롤링 직후 합산은 17,273/191,838개(9.00%), 32.76GiB, 9.63MiB/s, 현재 실패·429·재시도 0이며 ETA 약 9시간 46분이었다. Sector별 다운로드·감사는 서버에서 자율 수행했다. 운영자 연결이 필요한 단계는 모든 unit이 `COMPLETE`가 된 뒤 기존·신규 Run 증거를 결합하는 `FinalCoverage`뿐이며, 실패하거나 연결이 끊겨도 원본을 다시 받지 않고 같은 단계를 재실행한다.

같은 expansion Run에서 Worker 2 동시성을 8→12→16으로 올린 canary는 각각 5분 3.78MiB/s, 3분 5.08MiB/s, 3분 6.50MiB/s였고 실패·429·HTTP 재시도는 0이었다. 최종 ReleaseId `20260919T032744Z`, 내용 SHA `da1685b7ef167fcac629745f4268ffd1192e2ccafbbe258910ecb4e83d190e94`를 Worker 3~6에 한 대씩 롤링 적용했다. 전체 5분 창은 57,062/191,838개(29.74%), 98.45GiB, 33.25MiB/s로 변경 전 9.75MiB/s보다 3.41배 증가했고 ETA는 1시간 59분이다. 5개 unit은 모두 Sector 7 `active/running`, `NRestarts=0`, 실패·429·HTTP 재시도 0이며, 프로세스 RSS 약 246~258MiB, 호스트 가용 RAM 약 32~33GiB, CPU idle 83~99%, I/O wait 0~3%를 확인했다. 회로차단 시 현재 in-flight batch까지 처리하는 계약 때문에 추가 확대는 하지 않고 운영 상한을 16으로 유지한다.

최종 expansion은 Worker 2~6 모두 `COMPLETE`, 191,838/191,838개, 340.68GiB, `.part`·현재 실패·429·HTTP 재시도 0으로 끝났다. 기타 재시도 누적 21회는 모두 최종 성공했다. 두 Run을 결합한 `FinalCoverage`는 247,824/247,824개, 441.62GiB, `.part` 0을 확인했고 5대의 `coverage-sectors-1-13.json` SHA-256은 `df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94`로 같다. 이 단계는 Sector 감사 시점의 SHA-256 증거와 현재 파일 집합·바이트를 결합하며 모든 FITS를 다시 해시하지 않는다.

`/mnt/data`는 수집 staging뿐 아니라 HDFS DataNode와 YARN local/log에도 공유된다. 2026-09-20 Worker 2~6의 실제 사용률은 모두 7%였지만 `dfs.datanode.du.reserved=0`으로 별도 HDFS 예약 공간이 없다. 현재 75/70% 수집 hysteresis는 수집 프로세스만 제어하므로, HDFS 적재 전에 staging 보존량·RF2 증가량·YARN 여유를 합산해 별도 용량 예산과 DataNode 예약값을 76번 운영 범위에서 확정해야 한다.

## TESS HDFS Sector 1~13 확장 (`S15P21C206-76`)

HDFS runner는 75의 FinalCoverage JSON과 SHA-256 sidecar가 Worker 2~6에서 모두 같은지 확인하고, 기존 Run의 Sector 3~5와 expansion Run의 Sector 1·2·6~13을 정확히 매핑한다. 각 Sector의 불변 final을 재감사하거나 새 staging을 적재한 뒤 Java `FileContext`의 `Rename.NONE`으로만 확정하며, 13개가 모두 성공한 뒤 source coverage SHA-256을 키로 전체 HDFS coverage marker를 원자 확정한다. systemd 재시작 횟수는 증거로 남기되 0을 성공 조건으로 두지 않고 최종 plan·bundle·manifest·RF2·복원 감사 결과로 판정한다.

전체 적재는 `run-tess-hdfs-load.ps1 -Step ServerRunAll`로 Node 1의 enabled systemd 조정기에 인계한다. 인계 뒤에는 운영자 PC가 꺼져도 실행과 실패 재시작이 계속된다. Node 1은 Worker 2~6을 `10.20.2.10`~`10.20.6.10`으로 직접 기동·감시하며 source bind를 `10.20.1.10`으로 고정하고, HDFS 데이터 경로도 `hdfs://planetory`의 사설망 이름 해석을 사용한다. Tailscale은 최초 배치와 운영자 조회 경로이지 서버 간 실행 경로가 아니다. 세부 재개·감사 계약은 [TESS HDFS Raw 적재](../../distributed-system/ingestion/hdfs/README.md)를 따른다.

`-CleanupSourceAfterCommit`을 지정하면 각 Sector의 최종 Raw 전수 감사가 끝난 뒤 그 Sector Worker plan에 포함된 로컬 FITS만 삭제한다. plan identity·정확한 경로·크기·SHA-256을 삭제 전에 다시 확인하고 불일치 시 삭제 없이 실패한다. HDFS 확정·감사와 cleanup은 같은 enabled systemd 조정기가 재시작 후 이어서 수행한다.

적재 전에는 HDFS safe mode OFF, Live DataNode 5개, 기본 RF2, 현재 사용률 75% 미만과 RF2 예상 사용률 70% 이하, Worker별 원본 디스크 가용 100GiB 이상을 확인한다. 저장소의 `hdfs-site.xml`은 `dfs.datanode.du.reserved=107374182400`(DataNode당 100GiB)을 선언하며 runner도 실제 클러스터 값을 요구한다. 기존 클러스터 설정 반영과 DataNode 재시작은 이번 코드 변경에 포함하지 않았으므로, 통제된 운영 작업으로 적용·검증하기 전에는 Sector 1~13 적재를 시작하지 않는다.

## Spark 제출

### TESS Raw → Bronze 운영 (`S15P21C206-77`)

[run-tess-bronze.ps1](scripts/run-tess-bronze.ps1)은 Node 1에 불변 코드를 설치하고 HDFS·YARN 사전 점검, Sector 단위 5제품 canary, enabled systemd 전체 실행과 상태 조회를 제공한다. 사전 점검은 NameNode active/standby, 양쪽 safe mode OFF, DataNode·NodeManager 각 5개, HDFS 사용률 75% 미만, 다른 실행 중 YARN application 부재와 Raw marker·manifest를 요구한다.

전체 실행은 Spark 3.5.5 YARN cluster mode에서 executor 5개×2 core, executor 6GiB+overhead 2GiB로 한 Sector씩 직렬 처리한다. Python 3.12 wheel과 `astro_kernel`은 HDFS RF2 archive로 배포하며 Spark HDFS 사용자는 Raw 소유자인 `planetory-admin`으로 고정한다. enabled systemd oneshot은 로컬 세션과 무관하게 실행된다. HDFS·YARN 등 일시적인 인프라 실패는 5분 뒤 자체 재시작하고, 제품 파싱·Raw checksum·marker 불일치 같은 데이터 계약 오류는 종료 코드 65로 구분한다. Sector 변환 오류는 `terminal_failed` 상태도 남기며, unit을 disable해 같은 실패 attempt가 누적되지 않게 한다. 성공해도 다음 부팅의 재실행을 막기 위해 disable한다. 최종 `/lake/bronze/tess/sector=<NNNN>`은 오류 0·제품 수 일치·출력 재읽기·RF2·checksum·FSCK를 통과한 staging `data`만 `Rename.NONE`으로 확정한다. 상세 스키마·오류 코드·명령은 [Spark README](../../distributed-system/spark/README.md)를 따른다.

2026-09-21 run `20260920T230600Z`에서 Sector 1~13 제품 247,824개·관측점 4,666,320,826개·520 parts·오류 0을 확정했다. 실행 시간은 2:14:41이며, 로컬 연결 단절 중에도 서버 실행이 계속됐다. 13개 marker 독립 합산, coverage marker, YARN 잔여 application 0과 전체 Bronze FSCK `HEALTHY`를 확인했다.

Spark는 다음 모드로 제출한다.

```bash
--master yarn --deploy-mode cluster
```

현재 기본 이미지 `apache/spark:3.5.5-python3`는 JDK 11.0.26과 `hadoop-client-api/runtime` 3.3.4를 포함한다. Hadoop 3.5.0 단일 HDFS에 대한 Parquet 쓰기·읽기와 checksum은 로컬 일회성 환경에서 통과했고, `S15P21C206-73`에서 같은 이미지의 실제 6대 QJM·YARN sample application으로 Application ID, 성공 상태, HDFS 결과와 executor 로그까지 확인했다.

Executor는 Docker 이미지가 아니라 Worker의 YARN 프로세스에서 실행된다. Python 의존성은 다음 중 하나로 준비한다.

- 모든 Worker에 같은 Python 버전과 패키지 설치
- `--archives`로 실행 환경 배포

제출 이미지에만 설치한 패키지는 Worker에 전달되지 않는다.

Sector 수집 → Raw → 로컬 cleanup → Bronze의 Airflow 순서와 재시도 경계는 [TESS DAG 계약](../../distributed-system/airflow/dags/README.md)을 따른다. DAG와 HDFS/Bronze 코드는 불변 release로 설치됐고 Airflow import를 확인했다. 실행 전 SSH Connection·제한 sudo 권한·run 계보를 확인하고 실제 처리·장애 재개를 별도로 검증해야 한다.

다음 항목은 후속 구현 대상이다.

- TIC·TCE·TOI·Archive·ExoFOP 원천별 snapshot 수집
- Spark 제출 연결
- Spark History Server

## 로컬 구성 검사

저장소 루트에서 `python infra/distributed-system/validate.py`, `pwsh -File infra/distributed-system/scripts/test-hdfs-recovery.ps1`, `pwsh -File infra/distributed-system/scripts/test-tess-ingestion.ps1`을 실행한다. CI는 XML·Compose 정적 검사를 수행하며 PowerShell Runner 검증은 `S15P21C206-91` 범위다. 실제 HDFS 쓰기·읽기·RF2·checksum은 `S15P21C206-72`, YARN·Spark 제출은 `S15P21C206-73`, Worker 장애·수동 NameNode 전환은 `S15P21C206-74`에서 런타임 검증을 완료했다. Gold 공개·롤백은 후속 통합 검증으로 남긴다.

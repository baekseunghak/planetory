# GCP 노드 운영 런북

> 대표 Jira: `S15P21C206-71`
> 상태: 운영 절차·실환경 점검 기준

이 문서는 생성이 끝난 GCP 6개 노드의 접속, 상태 확인, 사설망·이름 해석·방화벽 검사와 비용 종료 절차를 관리한다. VM·VPC·피어링 생성은 [GCP 프로비저닝](../../infra/provisioning/gcp/README.md), 목표 구조와 보안 경계는 [GCP 분산 인프라](../architecture/gcp-distributed-infrastructure.md), Hadoop·YARN 실행은 [분산 시스템 배포](../../infra/distributed-system/README.md)를 따른다.

## 1. Tailscale SSH 접속

팀원 등록, 서버별 SSH 계정과 접근 제한은 [Tailscale 팀 서버 접근 가이드](tailscale-team-access.md)를 따른다. 서버 점검과 자동화에서도 가이드의 사용자명을 명시하고 로컬·격리 실행 계정 이름을 원격 사용자로 추정하지 않는다.

```powershell
tailscale ping node-1
tailscale ssh SSAFY@node-1
tailscale ssh planetory-admin@node-2
```

일상 로그인·점검·파일 전송은 이 tailnet 경로를 사용한다. `gcloud`는 VM·디스크·네트워크 같은 GCP 제어 영역 조회·변경에 사용하고, `gcloud compute ssh`는 최초 Tailscale 등록 또는 tailnet 장애 복구에만 사용한다.

`node-*` 접속은 관리용 Tailscale 경로이며 `10.20.x.10`을 사용하는 GCP VPC Peering 실환경 검증을 대신하지 않는다.

## 2. 노드 상태 점검

각 노드에서 다음 조회 명령을 실행한다. 디스크를 포맷하거나 마운트 구성을 바꾸지 않는다.

```bash
hostname -s
uname -m
nproc
free -h
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
findmnt /mnt/data
df -h / /mnt/data
java -version 2>&1 || true
docker --version 2>&1 || true
docker compose version 2>&1 || true
```

Node 2는 메타데이터 디스크를 추가로 확인한다.

```bash
findmnt /mnt/metadata
df -h /mnt/metadata
```

Node 1~3은 역할에 맞는 QJM 경로를 확인한다.

```bash
readlink -f /var/lib/hadoop-hdfs/namenode  # Node 1~2
findmnt -T /var/lib/hadoop-hdfs/journal    # Node 1~3
```

## 3. 사설망·DNS·TCP 검증

각 노드에서 다른 다섯 노드를 검사한다. 여섯 노드에서 모두 성공해야 총 30개 방향의 경로가 확인된다.

```bash
SELF_IP=$(
  ip -4 -o addr show |
    awk '$4 ~ /^10\.20\./ { sub(/\/.*/, "", $4); print $4; exit }'
)

for n in 1 2 3 4 5 6; do
  target="10.20.$n.10"
  [ "$target" = "$SELF_IP" ] && continue

  ip route get "$target" | head -n 1
  ping -c 2 -W 2 "$target"

  if timeout 3 bash -c "</dev/tcp/$target/22" >/dev/null 2>&1; then
    echo "TCP 22 OK: $target"
  else
    echo "TCP 22 FAIL: $target"
  fi
done
```

`ip route get`은 GCP NIC와 해당 노드의 `10.20.x.10`을 출발지로 표시해야 한다. `tailscale0` 경로는 VPC Peering 검증으로 인정하지 않는다. TCP 22 성공은 라우팅과 SSH 포트 접근만 증명하며 로그인 권한이나 Hadoop 서비스 포트를 증명하지 않는다.

짧은 이름과 두 GCE FQDN을 각 노드에서 확인한다.

```bash
nodes=(
  'master-1:planetory-0001'
  'worker-2:planetory-0002'
  'worker-3:planetory-0003'
  'worker-4:planetory-0004-508301'
  'worker-5:planetory-0005'
  'worker-6:planetory-0006'
)

failed=0
for item in "${nodes[@]}"; do
  name="${item%%:*}"
  project="${item#*:}"

  getent hosts "$name" >/dev/null || { echo "FAIL $name"; failed=1; }
  for fqdn in \
    "$name.asia-east1-b.c.$project.internal" \
    "$name.c.$project.internal"
  do
    getent ahostsv4 "$fqdn" >/dev/null || { echo "FAIL $fqdn"; failed=1; }
  done
done

[ "$failed" -eq 0 ] && echo 'FQDN_ALL_OK'
exit "$failed"
```

VPC Peering은 상대 프로젝트의 내부 DNS를 공유하지 않는다. 원격 프로젝트 FQDN이 실패하면 `/etc/hosts`의 `# BEGIN planetory-cluster` 관리 블록에 짧은 이름과 zonal/global FQDN이 모두 있는지 확인한다. 같은 IP가 세 번 출력되는 것은 세 별칭을 각각 조회한 결과일 수 있으므로 중복 등록으로 단정하지 않는다.

Hadoop 시작 후에는 `yarn node -list -all`이 표시한 호스트명을 다른 VM과 작업 컨테이너에서 다시 확인한다.

```bash
getent hosts <YARN이 표시한 호스트명>
```

## 4. 컨테이너 이름 해석

실제 배포 디렉터리에서 Compose 구문과 실행 중 컨테이너의 이름 해석을 확인한다. 이미지나 컨테이너가 아직 없으면 완료로 기록하지 않는다.

```bash
docker compose config --quiet
```

Node 1:

```bash
docker compose exec -T airflow-scheduler \
  getent hosts master-1 worker-2 worker-3 worker-4 worker-5 worker-6
```

Node 2~6:

```bash
docker compose exec -T ingestion \
  getent hosts master-1 worker-2 worker-3 worker-4 worker-5 worker-6
```

짧은 이름 확인 후 3절의 실제 zonal/global FQDN도 같은 컨테이너에서 조회한다.

## 5. 호스트 방화벽과 리스너 확인

각 노드에서 다음 조회만 수행한다.

```bash
hostname -s
ip -br -4 addr show ens4
ip -br -4 addr show tailscale0 2>/dev/null || true
sudo ufw status verbose
sudo ufw status numbered
sudo ss -lntp
systemctl is-enabled ufw 2>/dev/null || true
systemctl is-active ufw 2>/dev/null || true
systemctl is-active tailscaled 2>/dev/null || true
```

`22 ALLOW Anywhere`와 IPv6 동일 규칙은 호스트 방화벽 기준 최소 개방이 아니다. Tailscale 관리 경로, Node 1 내부 관리 경로와 비상 GCP 직접 접속 경로를 확정하고 제한 규칙을 먼저 추가한다. 별도 tailnet SSH 세션에서 새 규칙을 검증하기 전에는 기존 허용 규칙을 삭제하거나 UFW를 재시작하지 않는다.

Hadoop과 애플리케이션 포트는 실제 서비스가 준비되기 전에 열지 않는다. HDFS 최초 초기화에서는 [단계형 초기화 스크립트](../../infra/distributed-system/scripts/initialize-hdfs-ha.ps1)의 `ConfigureFirewall`이 UFW 기본 incoming deny와 기존 SSH 규칙을 유지하면서 정확한 6개 사설 IP에만 역할별 `8020`, `8485`, `9870`, `9864`, `9866`, `9867`을 허용한다. JournalNode HTTP `8480`은 Standby의 edit log 읽기에 필요하므로 Node 1~3에서 두 NameNode IP `10.20.1.10`, `10.20.2.10`에만 별도로 허용한다. 적용 전후에는 `NetworkDiagnostics`와 `JournalNodes`로 두 NameNode에서 세 JournalNode의 `8485/TCP`와 `8480/HTTP`를 확인한다.

YARN은 [단계형 YARN 스크립트](../../infra/distributed-system/scripts/initialize-yarn-cluster.ps1)의 `ConfigureFirewall`을 사용한다. 이 단계는 UFW가 active이고 기본 incoming 정책이 deny인지 먼저 확인하며, 전제가 다르면 어떤 허용 규칙도 추가하지 않는다. Node 1의 ResourceManager `8030~8033,8088`과 Worker의 NodeManager `8040~8042`는 정확한 6개 사설 IP에서만 허용한다. Spark cluster mode 내부 통신은 Worker 5개 IP 사이에서 driver `7078`과 block manager `7079~7095`만 허용한다. block manager는 같은 Worker에 여러 컨테이너가 배치되면 `7079`부터 포트를 증가시키므로 기본 재시도 범위를 함께 열어야 한다. NodeManager가 모든 인터페이스에 bind하는 현재 PoC의 접근 경계는 GCP VPC 방화벽과 이 UFW 규칙의 조합이다.

YARN 상태는 다음처럼 확인한다. 현재 unit은 실행 중이지만 부팅 자동 시작은 비활성이다.

```bash
systemctl is-active hadoop-yarn-resourcemanager  # Node 1
systemctl is-active hadoop-yarn-nodemanager      # Node 2~6
sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
  HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn node -list -all
```

재부팅 뒤에는 HDFS HA와 DataNode 상태를 먼저 확인한 다음 [분산 시스템 YARN 절차](../../infra/distributed-system/README.md#yarn-설치검증-s15p21c206-73)의 `Start`, `ValidateNodes`, `FinalAudit` 순서로 복구한다. `S15P21C206-74` 검증 결과 자동 fencing이 없는 PoC에서는 HDFS·YARN unit을 disabled로 유지하고, 운영자가 기존 Active 부재와 서비스 의존 순서를 확인한 뒤 수동 기동한다.

## 6. HDFS 수동 장애 전환과 재기동

[복구 검증 스크립트](../../infra/distributed-system/scripts/validate-hdfs-recovery.ps1)는 `Preflight`와 `Prepare` 뒤 계획 전환, Node 1 장애, Worker 장애를 서로 분리한다. 변경 단계는 먼저 `-WhatIf`로 대상 프로젝트·VM을 확인하고 실행 중인 YARN 작업이 0개인 유지보수 창에서만 실행한다. 복구 중 `-format`, `-bootstrapStandby`, `-initializeSharedEdits`, HDFS 삭제는 사용하지 않는다.

- 계획 전환: Active를 Standby로 내린 뒤 반대 NameNode를 일반 승격한다.
- Node 1 장애: 정지 전에 Node 2·3의 JournalNode active와 잔존 `8485`·`8480` 경로를 확인한다. GCP에서 `master-1=TERMINATED`를 확인한 경우만 Node 2에서 `-transitionToActive --forceactive nn2`를 실행하며, 원격 승격 직전에도 종료 상태를 다시 확인한다. 자동 fencing이 없으므로 VM 상태를 확인할 수 없으면 중단한다.
- Node 1 재기동: mount → JournalNode → Standby NameNode → ResourceManager 순서이며 각 준비 포트를 최종 단정한다. 이후 계획 failback과 Worker 5개의 DataNode IPC `9867` full block report를 수행한다. 실패해도 다섯 대를 모두 시도해 차단된 호스트 전체를 보고한 뒤 중단한다.
- Worker 재기동: 일반 Worker는 mount → DataNode → NodeManager 순서다. Worker 3은 정지 전에 남을 Node 1·2 JournalNode와 상호 `8485`·`8480` 경로를 확인하고, mount → JournalNode → DataNode → NodeManager 순서로 복구한다. FinalAudit은 JournalNode 3대, Live DataNode 5개, YARN NodeManager 5개, under·missing·corrupt 0과 Prepare에서 기록한 무작위 표본 SHA-256을 확인한다. Worker 3 실제 장애 경로는 아직 실행하지 않았으므로 다음 유지보수 창의 후속 검증으로 남긴다.

ResourceManager·Airflow·Publisher는 Node 1에만 있으므로 Node 2 승격으로 복구되지 않는다. ResourceManager는 Node 1 재기동 순서에 포함한다. Airflow·Publisher가 배포된 환경에서는 컨테이너 상태와 로그를 확인한 뒤 실패한 Airflow 단계부터 재시도하고, Publisher는 같은 bundle의 멱등 적재를 확인한다. 2026-09-18 검증 당시 두 컨테이너는 배포되지 않아 이 부분은 실행 증거가 아니다.

실행 명령, 단계별 안전 조건, 검증 경로 정리 절차와 2026-09-18 실제 소요 시간은 [분산 시스템 수동 전환 절차](../../infra/distributed-system/README.md#수동-전환)에 기록한다.

## 7. tailnet SSH 장애와 GCP 비상 복구

먼저 클라이언트 연결, MagicDNS, 대상 노드와 SSH 권한을 확인한다.

```powershell
tailscale status
tailscale ping node-1
tailscale ssh SSAFY@node-1 hostname -s
```

실패하면 Tailscale Admin Console에서 사용자·장비 승인, 대상 노드 `Connected`, ACL의 네트워크 접근과 SSH 규칙을 각각 확인한다. Tailscale SSH는 대상 Linux 계정을 자동 생성하지 않으므로 Node 1은 `SSAFY`, Node 2~6은 `planetory-admin` 계정이 실제로 존재해야 한다.

tailnet으로 복구할 수 없고 서버 안의 `tailscaled` 또는 네트워크를 고쳐야 할 때만 GCP 직접 접속을 비상 경로로 사용한다. Worker는 실제 VM 이름으로 바꾼다. 진단 중 API 활성화 질문이 나올 수 있다.

```powershell
gcloud compute ssh master-1 --project=$ProjectId --zone=asia-east1-b --troubleshoot
gcloud compute firewall-rules describe planetory-admin-ssh --project=$ProjectId --format="yaml(network,sourceRanges,targetTags,allowed,disabled)"
gcloud compute instances describe master-1 --project=$ProjectId --zone=asia-east1-b --format="yaml(tags.items,networkInterfaces)"
```

진단의 `Source IP address`가 방화벽 `sourceRanges`에 없으면 기존 허용 목록을 보존하면서 현재 IPv4 `/32`를 추가한다.

```powershell
$FirewallJson = gcloud compute firewall-rules describe planetory-admin-ssh --project=$ProjectId --format=json
if ($LASTEXITCODE -ne 0) { throw 'SSH 방화벽 조회 실패: 갱신 중단' }
$Firewall = ($FirewallJson -join "`n") | ConvertFrom-Json
$CurrentIp = [System.Net.IPAddress]::Parse((Read-Host '진단에 나온 현재 Source IPv4').Trim())
if ($CurrentIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 주소를 입력하세요' }
$AdminRanges = (@($Firewall.sourceRanges) + "$CurrentIp/32" | Select-Object -Unique) -join ','
$AdminRanges
gcloud compute firewall-rules update planetory-admin-ssh `
  --project=$ProjectId `
  --source-ranges=$AdminRanges
if ($LASTEXITCODE -ne 0) { throw 'SSH 방화벽 갱신 실패' }
gcloud compute ssh master-1 --project=$ProjectId --zone=asia-east1-b
```

비상 접속으로 `tailscaled`를 복구한 뒤 `tailscale ping`과 `tailscale ssh`를 다시 통과해야 일상 경로가 복구된 것이다. `--source-ranges`는 전체 허용 목록을 교체한다. 현재 IP만 넣어 기존 관리 주소를 제거하거나 문제 해결을 위해 `0.0.0.0/0`을 열지 않는다. 피어링 재생성으로 SSH 허용 IP 불일치를 해결할 수 없다.

## 8. 리소스·quota·비용 종료 기준

각 프로젝트의 실제 리소스와 할당량을 조회한다.

```powershell
gcloud compute instances list --project=$ProjectId
gcloud compute disks list --project=$ProjectId
gcloud compute addresses list --project=$ProjectId
gcloud compute regions describe asia-east1 --project=$ProjectId
gcloud compute project-info describe --project=$ProjectId
```

2026-09-09 기준 720시간·공제 전 계획값은 Node 1 `$219.36`, Node 2 `$300.24`, Node 3~6 각 `$290.38`이다. 크레딧, 세금, 로그와 송신 비용은 포함하지 않았으므로 각 계정의 Billing에서 다시 확인한다. Node 2의 계획값과 추가 비용 여유를 고려해 결과 이전과 자원 정리를 27일 안에 완료한다.

예산 알림은 과금을 자동 중단하지 않는다. 티켓에는 각 계정의 Trial·크레딧 적용 여부, 현재 비용과 확인 시각, 예산 임계값, 알림 수신자, VM 중단일과 최종 자원 정리일을 기록한다.

VM만 중지하거나 삭제해도 `auto-delete=no` 영속 디스크와 예약 고정 IP는 계속 과금될 수 있다. 종료할 때 인스턴스, 디스크, 주소를 각각 확인하며 실제 삭제는 대상과 결과 이전 여부를 확인하고 승인받은 뒤 수행한다.

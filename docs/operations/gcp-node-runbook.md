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

YARN 상태는 다음처럼 확인한다. 2026-09-22 부팅 복구 release `5fec7b88` 적용 뒤 역할별 HDFS·YARN unit은 부팅 자동 시작이 활성화됐다.

```bash
systemctl is-active hadoop-yarn-resourcemanager  # Node 1
systemctl is-active hadoop-yarn-nodemanager      # Node 2~6
sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
  HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn node -list -all
```

`S15P21C206-74` 당시에는 자동 fencing이 없어 HDFS·YARN unit을 disabled로 두고 수동 기동했다. 2026-09-22 이후의 부팅 복구와 검증 조건은 [전체 노드 부팅 복구 절차](../../infra/distributed-system/README.md#전체-노드-부팅-복구)를 따른다.

`S15P21C206-252`의 [부팅 복구 구성과 검증 절차](../../infra/distributed-system/README.md#전체-노드-부팅-복구)는 Node 1~6에 적용하고 여섯 노드를 한 대씩 재부팅해 검증했다. Node 1 재부팅 뒤 양쪽 Standby에서 timer가 Safe Mode OFF를 기다려 `nn1`을 승격하고 ResourceManager가 자동 복구됐다. 설치 후에도 자동 fencing 없이 **응답 없는 기존 Active**를 승격할 수 없으므로 이 장애 전환은 아래 수동 절차를 따른다.

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

Tailscale SSH에서 추가 웹 인증이 필요한 경우, 기존 로컬 OpenSSH 설정의 `node-1-ssh` 별칭과 Node 1 경유 `node-2-ssh`~`node-6-ssh` ProxyJump 별칭으로도 접속을 점검한다. `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes node-1-ssh 'hostname -s'`처럼 등록된 host key를 검증하며 개인 키 내용이나 인증 파일을 출력·복사하지 않는다. 별칭의 실제 주소·키 경로는 각 작업 PC의 `.ssh/config`에서만 확인하고 운영 문서에 고정하지 않는다.

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

### 2026-09-17 실측 결과 (`S15P21C206-228`)

6개 프로젝트 모두에서 소유자 IAM과 결제 계정 IAM(`roles/billing.admin` 5개, `planetory-0003`은 확인 시점에 `roles/billing.costsManager`였고 이후 `billing.admin`으로 확보됨)을 받아 위 명령과 콘솔 결제 화면을 직접 조회한 결과다. 위 계획값은 이 절 앞부분의 사전 추정이며, 실측과의 차이는 이 표로 대체한다.

인스턴스는 6대 모두 `asia-east1-b`, `e2-custom-6-36864`, `RUNNING`이다. 디스크·quota·예약 IP는 다음과 같다.

| 노드 | 프로젝트 | 생성일 | 디스크(GB) | 리전 `DISKS_TOTAL_GB` | 예약 고정 IP |
| --- | --- | --- | --- | --- | --- |
| master-1 | planetory-0001 | 2026-09-09 | 30 + 200 pd-standard | 230 / 2048 (11%) | `planetory-master-ip` 1개 사용 중 |
| worker-2 | planetory-0002 | 2026-09-09 | 30 + 2000 pd-standard + 100 pd-balanced(metadata) | 2030 / 2048 (**99%**) | 없음 |
| worker-3 | planetory-0003 | 2026-09-10 | 30 + 2000 pd-standard | 2030 / 2048 (**99%**) | 없음 |
| worker-4 | planetory-0004-508301 | 2026-09-10 | 30 + 2000 pd-standard | 2030 / 4096 (50%) | 없음 |
| worker-5 | planetory-0005 | 2026-09-09 | 30 + 2000 pd-standard | 2030 / 4096 (50%) | 없음 |
| worker-6 | planetory-0006 | 2026-09-09 | 30 + 2000 pd-standard | 2030 / 2048 (**99%**) | 없음 |

`planetory-0002`·`0003`·`0006`은 리전 디스크 quota가 99%로 새 디스크를 붙일 여유가 거의 없다. 미사용 디스크와 미사용 예약 IP는 없었다. VM 내부 `/`, `/mnt/data`(, `/mnt/metadata`) 사용률은 6개 노드 모두 1-15%로 2절 운영 기준(70%) 대비 여유가 크다.

위 표의 "예약 고정 IP"는 별도로 예약해 둔 static 주소만 센 것이며, **6대 모두 퍼블릭 IP 자체는 갖고 있다.** master-1은 예약 static(`planetory-master-ip`), worker-2부터 worker-6까지는 인스턴스에 자동 할당된 임시(ephemeral) 외부 IP다. 6개 프로젝트 모두 Cloud Router·Cloud NAT가 없어 이 외부 IP가 각 VM의 유일한 인터넷 아웃바운드 경로다. **NAT를 먼저 구성하지 않고 이 외부 IP를 해제하면 1절의 Tailscale SSH(코디네이션 서버로 나가는 아웃바운드가 끊김)와 6절의 `gcloud compute ssh` 비상 경로가 모두 끊긴다.** SKU 실측상 임시 외부 IP 자체의 과금은 0에 가까워(worker-6에서 `External IP Charge on a Standard VM` 159.82시간 ₩0) 비용 정리 목적으로 뗄 실익도 없다.

각 결제 계정의 크레딧은 다음과 같다(확인 시각 2026-09-17 21:30 KST 전후, 콘솔 반영은 최대 24시간 지연될 수 있어 실제 잔액은 표시값보다 낮을 수 있다).

| 프로젝트 | 크레딧 잔액 | 총액 | 남은 비율 | 만료일 |
| --- | --- | --- | --- | --- |
| planetory-0001 | ₩311,669 | ₩435,523 | 72% | 2026-11-24 |
| planetory-0002 | ₩320,461 | ₩414,984 | 77% | 2026-12-08 |
| planetory-0003 | ₩336,315 | ₩414,984 | 81% | 2026-12-08 |
| planetory-0004-508301 | ₩336,326 | ₩414,984 | 81% | 2026-12-08 |
| planetory-0005 | ₩335,682 | ₩414,984 | 81% | 2026-11-24 |
| planetory-0006 | ₩326,049 | ₩414,984 | 79% | 2026-12-08 |

만료일은 모두 2026-11-24 이후로 목표 기한(2026-10-09)보다 뒤이므로, 이 기한에서는 만료가 아니라 소진 속도가 제약이다.

**정정(2026-09-18):** 위 2026-09-17 판정의 하루 사용액은 `정가` 월 합계를 대략적인 가동일수로 나눈 값이라 워커 사이에 실제로 없는 차이(₩11,587-13,819)가 생겼다. 결제 보고서를 날짜별로 그룹화(`그룹화 기준(날짜)`, `청구 기간별 기간`을 원하는 구간으로 지정)해 최근 안정 구간(2026년 9월 12일부터 16일까지)의 일별 실측값으로 다시 계산했다.

- `planetory-0001`: 최근 3일(9월 15일부터 17일까지) 서비스별 내역에 `Kubernetes Engine`·`Cloud Monitoring`이 **₩0**으로 확인되어 완전히 해제됐다(Kubernetes Engine API도 `disabled` 상태). 2026년 9월 1일부터 8일까지는 이 VM 생성(9-10) 이전의 별도 GKE 사용으로 하루 ₩8,340-8,800이 나갔으나 이는 이미 소진되어 현재 잔액에 반영된 매몰 비용이다. 현재 안정 하루 사용액은 ₩10,035다. 워커 기준(₩13,321/일)과의 차이(₩3,285/일)는 pd-standard 1,800GB(2030GB-230GB) 차이의 이론가(₩3,240/일)와 1.4% 오차로 일치해, 디스크를 줄여 둔 효과로 설명된다.
- `planetory-0003`·`0004-508301`·`0005`·`0006`: 최근 5일 하루 사용액이 ₩13,274-13,374로 사실상 동일하다(같은 인스턴스·같은 디스크 구성이므로 요율은 같고, 잔액 차이는 아래처럼 생성·가동 개시 시각 차이로 설명된다).
- `planetory-0002`: 하루 ₩13,735-13,827로 나머지 워커보다 ₩450-500/일 높다. metadata용 pd-balanced 100GB의 이론가(₩450-500/일)와 일치해, 추가 디스크 때문이다.

2026-09-18 확인 시각 기준 잔액과 위 실측 요율로, 2026-10-09까지 21일을 다시 계산했다.

| 프로젝트 | 하루 사용액(실측) | 잔액(09-18) | 21일 필요액 | 잔액 대비 여유 | 소진 예상일 |
| --- | --- | --- | --- | --- | --- |
| planetory-0001 | ₩10,035 | ₩303,888 | ₩210,735 | ₩93,153 (31%) | 10-18경 |
| planetory-0003 | ₩13,321 | ₩325,051 | ₩279,741 | ₩45,310 (16%) | 10-12경 |
| planetory-0004-508301 | ₩13,323 | ₩325,022 | ₩279,783 | ₩45,239 (16%) | 10-12경 |
| planetory-0005 | ₩13,321 | ₩325,317 | ₩279,741 | ₩45,576 (16%) | 10-12경 |
| planetory-0006 | ₩13,322 | ₩315,134 | ₩279,762 | ₩35,372 (13%) | 10-11경 |
| planetory-0002 | ₩13,790 | ₩309,516 | ₩289,590 | **₩19,926 (7%)** | **10-10경** |

`planetory-0002`가 여전히 가장 위험하며 소진 예상이 목표 기한 바로 다음 날이다. `planetory-0003`·`0004-508301`·`0005`의 잔액이 09-18 기준 서로 300원 이내로 거의 같은 이유는, 0005가 생성일(9/10)이 하루 빠르지만 당일 첫 가동이 예상보다 늦게 시작돼(첫날 실측 ₩2,788로 정상 가동일의 약 5시간 분량) 하루 일찍 생성된 효과가 상쇄됐기 때문이다. `planetory-0006`이 이 셋보다 잔액이 약 ₩10,000(하루치) 적은 것은 정상 가동 개시가 하루 더 빨랐던 것과 일치한다.

하루 사용액의 약 28%는 사용률 1-15%인 pd-standard 디스크 비용이지만, GCP 영속 디스크는 축소가 불가능하고 위 quota 한계로 교체용 신규 디스크를 붙일 여유도 없어 이번 점검에서는 디스크 축소를 실행하지 않았다.

각 결제 계정에는 `EXCLUDE_ALL_CREDITS` 예산 알림을 6개 계정 각 1개, 실제 크레딧 총액·기한 10-09로 통일했다. 처음에는 `planetory-0002`부터 `planetory-0006`까지를 크레딧 총액을 모르는 상태에서 보수값 ₩380,000으로, `planetory-0001`은 매월 리셋되는 중복 예산과 함께 만들어 기준이 갈렸으나, 6개 계정 크레딧 총액을 모두 확인한 뒤 아래처럼 정리했다.

| 프로젝트 | 예산 이름 | 금액(=크레딧 총액) | 기간 | 임계값 |
| --- | --- | --- | --- | --- |
| planetory-0001 | `planetory-0001 크레딧 누적 감시` | ₩435,523 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |
| planetory-0002 | `planetory-0002 크레딧 소진 감시` | ₩414,984 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |
| planetory-0003 | `planetory-0003 크레딧 소진 감시` | ₩414,984 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |
| planetory-0004-508301 | `planetory-0004-508301 크레딧 소진 감시` | ₩414,984 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |
| planetory-0005 | `planetory-0005 크레딧 소진 감시` | ₩414,984 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |
| planetory-0006 | `planetory-0006 크레딧 소진 감시` | ₩414,984 | 2026-08-25 - 2026-10-09 | 50 / 80 / 100% |

`planetory-0001`의 매월 리셋 중복 예산(`크레딧 소진 감시`)은 누적 소진을 추적하지 못해 삭제했다. 80% 임계값은 하루 사용액 기준 2026년 10월 7-8일경 도달해 기한 전 조기 경보로 작동한다.

미확정 사항: `planetory-0005`·`0006`이 다른 워커보다 하루 사용액이 낮게 나온 원인(추정 오차인지 실제 차이인지), `planetory-0001` Kubernetes Engine·Cloud Monitoring 사용 목적, VM 생성 후 27일 기준(9월 9-10일 생성분 10월 6-7일)과 이번 목표 기한(10-09) 중 자원 정리 기준으로 어느 쪽을 따를지, 6개 프로젝트 모두 Cloud NAT가 없어 외부 IP가 유일한 아웃바운드 경로인 상태를 그대로 유지할지 NAT를 별도로 구성할지.

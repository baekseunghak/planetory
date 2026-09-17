# GCP 노드 운영 런북

> 대표 Jira: `S15P21C206-71`
> 상태: 운영 절차·실환경 점검 기준

이 문서는 생성이 끝난 GCP 6개 노드의 접속, 상태 확인, 사설망·이름 해석·방화벽 검사와 비용 종료 절차를 관리한다. VM·VPC·피어링 생성은 [GCP 프로비저닝](../../infra/provisioning/gcp/README.md), 목표 구조와 보안 경계는 [GCP 분산 인프라](../architecture/gcp-distributed-infrastructure.md), Hadoop·YARN 실행은 [분산 시스템 배포](../../infra/distributed-system/README.md)를 따른다.

## 1. Tailscale SSH 접속

팀원 등록, 서버별 SSH 계정과 접근 제한은 [Tailscale 팀 서버 접근 가이드](tailscale-team-access.md)를 따른다. 서버 점검과 자동화에서도 가이드의 사용자명을 명시하고 로컬·격리 실행 계정 이름을 원격 사용자로 추정하지 않는다.

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

`22 ALLOW Anywhere`와 IPv6 동일 규칙은 호스트 방화벽 기준 최소 개방이 아니다. Tailscale 관리 경로, Node 1 내부 관리 경로와 비상 GCP 직접 접속 경로를 확정하고 제한 규칙을 먼저 추가한다. 별도 SSH 세션에서 새 규칙을 검증하기 전에는 기존 허용 규칙을 삭제하거나 UFW를 재시작하지 않는다.

Hadoop과 애플리케이션 포트는 실제 서비스가 준비되기 전에 열지 않는다. 서비스 시작 후 `ss -lntp`의 실제 리스너와 필요한 노드 관계를 기준으로 허용 범위를 결정한다.

## 6. SSH 접속 장애

집·교육장·VPN 변경으로 접속 공인 IP가 달라질 수 있다. Worker는 실제 VM 이름으로 바꾼다. 진단 중 API 활성화 질문이 나올 수 있다.

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

`--source-ranges`는 전체 허용 목록을 교체한다. 현재 IP만 넣어 기존 관리 주소를 제거하거나 문제 해결을 위해 `0.0.0.0/0`을 열지 않는다. 피어링 재생성으로 SSH 허용 IP 불일치를 해결할 수 없다.

## 7. 리소스·quota·비용 종료 기준

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

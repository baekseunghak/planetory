# GCP 6계정 클러스터 생성·확인·피어링

각 팀원이 Windows PowerShell에서 자신의 GCP 프로젝트에 노드 1대를 생성하고, 전체 6개 프로젝트를 메시 피어링하는 절차입니다. 인프라 구성은 [GCP 인프라 구조](../../../docs/architecture/gcp-distributed-infrastructure.md)를 참고합니다.

## 1. Google Cloud CLI 설치와 로그인

PowerShell에서 Google Cloud CLI를 설치합니다.

```powershell
winget install --id Google.CloudSDK --exact
```

설치 후 PowerShell을 다시 열고 실행합니다.

```powershell
gcloud --version
gcloud auth login
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud projects list
```

## 2. 작업 변수 설정

```powershell
# 저장소 루트에서 실행
Set-Location infra/provisioning/gcp

$ProjectId = 'my-real-project-id'
gcloud config set project $ProjectId
gcloud config get-value project

$AdminCidr = "$(Invoke-RestMethod 'https://api.ipify.org')/32"
$AdminCidr
```

스크립트 실행이 차단될 때만 현재 PowerShell에서 허용합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

노드 번호는 중복되지 않게 배정합니다.

```text
Node 1: Master
Node 2: Standby NameNode + Worker
Node 3: JournalNode + Worker
Node 4~6: Worker
```

| 담당자 | 담당 노드 | 역할 |
|---|---:|---|
| 김동혁 | Node 1 | Master |
| 백지웅 | Node 2 | Standby NameNode + Worker |
| 강재민 | Node 3 | JournalNode + Worker |
| 윤성용 | Node 4 | Worker |
| 백승학 | Node 5 | Worker |
| 하서진 | Node 6 | Worker |

## 3. 노드 생성

마스터 담당자:

```powershell
.\scripts\create-node.ps1 -ProjectId $ProjectId -Node 1 -AdminCidr $AdminCidr
```

Worker 담당자는 자신의 번호 `2~6`을 넣습니다.

```powershell
.\scripts\create-node.ps1 -ProjectId $ProjectId -Node 2 -AdminCidr $AdminCidr
```

| 구분 | 머신 | 부팅 | 제어/HDFS 데이터 | HA 메타데이터 | 외부 IPv4 |
|---|---|---:|---:|---:|---|
| Node 1 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | 제어 데이터 200GiB | 기존 제어 데이터 디스크 사용 | Standard 고정 IP |
| Node 2 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | HDFS 데이터 2,000GiB | 100GiB `pd-balanced` | Standard 임시 IP |
| Node 3~6 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | HDFS 데이터 2,000GiB | 없음 | Standard 임시 IP |

Worker의 부팅 디스크와 HDFS 데이터 디스크는 모두 지역 `pd-standard` 2,048GiB 할당량을 사용한다.

- 기본 사용량: `30 + 2,000 = 2,030GiB`
- 남는 할당량: 18GiB
- 2,048GiB 초과 시: VM 생성 전에 스크립트 중단
- Node 2 메타데이터 디스크: 별도 SSD 할당량을 사용하는 `pd-balanced`

다른 크기로 생성하려면:

```powershell
.\scripts\create-node.ps1 -ProjectId $ProjectId -Node 2 -AdminCidr $AdminCidr `
  -MachineType e2-standard-4 -DataDiskSizeGiB 1024 -BootDiskSizeGiB 30 `
  -MetadataDiskSizeGiB 100 `
  -Zone asia-east1-b
```

Compute Engine API 활성화 확인이 나오면 `y`를 입력합니다.

```text
API [compute.googleapis.com] not enabled on project [...]. Would you like to enable and retry (this will take a few minutes)?
(y/N)? y
```

## 4. 생성 결과·IP·SSH 확인

```powershell
.\scripts\inspect-node.ps1 -ProjectId $ProjectId -Node 1
# Worker 담당자는 -Node 2~6
.\scripts\inspect-node.ps1 -ProjectId $ProjectId -Node 2
```

GCP 리소스 조회 뒤 tailnet SSH 연결과 `/mnt/data` 마운트까지 확인합니다.

```powershell
.\scripts\inspect-node.ps1 -ProjectId $ProjectId -Node 2 -CheckSsh
```

직접 접속할 때도 `node-*` MagicDNS와 서버별 Linux 계정을 사용합니다.

```powershell
tailscale ping node-1
tailscale ssh SSAFY@node-1
tailscale ssh planetory-admin@node-2
```

`gcloud`는 VM·디스크·네트워크 같은 GCP 제어 영역에 계속 사용한다. `gcloud compute ssh`는 노드 최초 생성 후 Tailscale을 설치·등록하거나 tailnet 장애를 복구할 때만 사용하며, 일상 접속과 설치 자동화에는 사용하지 않는다. 상세 장애 절차는 [GCP 노드 운영 런북](../../../docs/operations/gcp-node-runbook.md)을 따른다.

마운트 확인이 실패하면 시작 로그를 확인합니다.

```powershell
gcloud compute instances get-serial-port-output worker-2 --project=$ProjectId --zone=asia-east1-b
```

SSH 접속 후:

```bash
sudo journalctl -u google-startup-scripts.service --no-pager
findmnt /mnt/data
df -h /mnt/data
# Node 2만 추가 확인
findmnt /mnt/metadata
df -h /mnt/metadata
```

Node 1~3은 QJM용 JournalNode 경로도 확인합니다.

```bash
readlink -f /var/lib/hadoop-hdfs/namenode  # Node 1~2
findmnt -T /var/lib/hadoop-hdfs/journal    # Node 1~3
```

## 5. 전체 메시 피어링

6개 노드 생성이 끝나면 프로젝트 ID를 노드 순서대로 입력합니다.

- 모든 참여자가 같은 배열과 순서를 사용합니다.
- 부분 테스트는 중복되지 않은 프로젝트 ID 2~6개로 실행할 수 있습니다.
- 6대를 넘기려면 방화벽과 IP 계획부터 다시 정해야 합니다.
- 스크립트는 피어링 생성 후 tailnet SSH로 짧은 호스트명과 GCE FQDN을 등록하고 이름 해석을 검사합니다.

```powershell
# 현재 운영 프로젝트 (노드 1~6 순서). 정본은 GCP 분산 인프라 문서의 노드 표다.
$Projects = @(
  'planetory-0001',
  'planetory-0002',
  'planetory-0003',
  'planetory-0004-508301',
  'planetory-0005',
  'planetory-0006'
)
```

각 팀원이 자신의 프로젝트에서 한 번씩 실행합니다.

`$ProjectId`와 `$Projects`에는 예시가 아닌 실제 프로젝트 ID를 입력합니다. `/etc/hosts`까지 갱신하려면 자신의 노드가 tailnet에 등록되어 있어야 합니다. `planetory-vpc` 조회가 실패하면 활성 계정과 해당 프로젝트의 네트워크를 먼저 확인합니다.

```powershell
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud compute networks list --project=$ProjectId --format="table(name)"
```

권한 오류면 해당 계정의 프로젝트 접근 권한을 확인하고, 목록에 `planetory-vpc`가 없으면 노드 생성 진행 상태를 확인합니다. 피어링 스크립트는 누락된 VPC를 자동 생성하지 않습니다. `create-node.ps1`은 기존 리소스가 있으면 실패하므로 무조건 재실행하지 않습니다.

```powershell
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects
```

다른 존을 사용했다면 생성 때와 같은 값을 전달합니다.

```powershell
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects -Zone asia-east1-b
```

프로젝트당 `$Projects.Count - 1`개 피어링이 `ACTIVE`인지 확인합니다.

### 일부 노드만 준비된 경우

실제 생성 번호를 유지합니다. 예를 들어 1·2·5·6번만 준비됐다면 아래 배열의 프로젝트 ID를 실제 값으로 바꾸고, 모든 참여자가 같은 매핑을 사용합니다.

```powershell
$Projects = @('actual-master-project', 'actual-worker2-project', 'actual-worker5-project', 'actual-worker6-project')
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects -NodeNumbers 1,2,5,6
```

`-NodeNumbers`를 생략하면 기존처럼 1부터 순서대로 번호를 붙입니다. 스크립트는 변경 전에 자기 VM의 이름·네트워크·내부 IP를 검사합니다. 실제 생성 번호가 다르면 중단합니다. 기존 피어링은 이름이 달라도 연결 대상이 같으면 재사용하며, 같은 이름이 다른 대상에 쓰이면 자동 삭제하지 않고 중단합니다. 나중에 3·4번을 추가할 때 전체 프로젝트 배열과 `-NodeNumbers 1,2,3,4,5,6`으로 각 프로젝트에서 다시 실행합니다. 양쪽 설정이 끝나야 연결 상태를 확인할 수 있습니다.

tailnet 등록을 먼저 해결해야 한다면 같은 명령에 `-SkipHosts`를 추가해 피어링만 처리합니다. 기본 실행은 Node 1의 `SSAFY@node-1`, Node 2~6의 `planetory-admin@node-*`를 검증한 뒤 `/etc/hosts`에 노드 별칭을 기록하며 수정 전 `/etc/hosts.planetory-backup-*`를 남깁니다. 구형 `# planetory-cluster` 블록은 자동 삭제하지 않으므로 직접 확인 후 정리해야 합니다. SSH 방화벽, 외부 IP와 sshd 설정을 직접 변경하는 명령은 이 스크립트에 없습니다.

오프라인 회귀 검사: `pwsh -NoProfile -File .\scripts\test-mesh-peering.ps1` (실제 gcloud·tailnet 호출 없음).

```powershell
$Network = gcloud compute networks describe planetory-vpc `
  --project=$ProjectId `
  --format=json | ConvertFrom-Json

$Network.peerings |
  Select-Object name, state, stateDetails, network |
  Format-Table -AutoSize
```

### 잘못된 피어링 초기화·재연결

`reset-mesh-peering.ps1 -ProjectId $ProjectId`만 실행하면 **조회만 하며 삭제하지 않습니다**. `peer-node-4`가 실제 6번 프로젝트를 가리키면 연결 대상이 틀린 것이 아니라 예전 이름이 남은 것입니다. 이름까지 맞추려면 그 연결만 삭제한 뒤 생성 스크립트를 다시 실행합니다. 이때 해당 연결은 일시 중단됩니다.

```powershell
# 목록에서 peer-node-4가 실제 6번 프로젝트를 가리키는지 확인한 경우에만
.\scripts\reset-mesh-peering.ps1 -ProjectId $ProjectId -PeeringNames peer-node-4 -WhatIf
# 미리보기 확인 후 위 명령의 -WhatIf를 빼고 실행
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects -NodeNumbers 1,2,5,6
```

생성 후 `getent hosts` 출력에 같은 IP가 세 번 나오는 것은 짧은 이름과 FQDN 두 개를 각각 조회하기 때문입니다. 이 출력만으로 `/etc/hosts`에 중복 등록됐다고 판단하지 않습니다. 로컬 피어링의 `ACTIVE`만으로 다른 프로젝트끼리의 전체 메시 통신까지 검증된 것은 아닙니다.

이름만 잘못 붙었고 연결 대상 프로젝트가 맞으면 삭제하지 않아도 됩니다. 생성 스크립트가 대상을 기준으로 재사용합니다. 잘못된 대상이나 이름 충돌이 있을 때만 삭제합니다. 먼저 배치 작업을 중지하고 팀원에게 연결 중단을 알립니다.

```powershell
# 현재 프로젝트의 연결 이름과 상대 네트워크 조회 (삭제하지 않음)
.\scripts\reset-mesh-peering.ps1 -ProjectId $ProjectId

# 목록에서 확인한 잘못된 이름만 지정 (아래 이름은 예시)
$WrongPeerings = @('peer-node-3', 'peer-node-4')
.\scripts\reset-mesh-peering.ps1 -ProjectId $ProjectId -PeeringNames $WrongPeerings -WhatIf

# 대상 확인 후 실행: 연결마다 확인 질문이 나옴
.\scripts\reset-mesh-peering.ps1 -ProjectId $ProjectId -PeeringNames $WrongPeerings

# 실제 프로젝트 배열과 노드 번호로 재연결 (1·2·5·6 예시)
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects -NodeNumbers 1,2,5,6
```

- 삭제 범위는 지정 프로젝트의 `planetory-vpc` 안에서 지정한 피어링뿐입니다. 이름이 하나라도 없으면 삭제 전에 중단합니다.
- 상대 프로젝트의 피어링은 자동 삭제하지 않습니다. 전체 재구성이 필요하면 각 담당자가 자기 프로젝트에서 조회·삭제·재생성합니다. 양쪽 설정 후 `ACTIVE`를 확인합니다.
- VM·디스크·VPC·방화벽·`/etc/hosts`는 삭제하지 않습니다. 호스트 매핑은 SSH 복구 후 올바른 `-NodeNumbers`로 생성 스크립트를 재실행해 갱신합니다.
- 중간 실패 시 이미 삭제한 연결은 자동 복구되지 않습니다. 목록을 다시 조회하고 생성 스크립트로 복구합니다. 데이터 디스크는 남지만 분산 작업은 실패할 수 있습니다.

## 6. 구축 후 검증과 운영

노드별 Tailscale SSH 접속, 상태 점검, 사설망·FQDN·TCP·방화벽 검사와 비용 종료 절차는 [GCP 노드 운영 런북](../../../docs/operations/gcp-node-runbook.md)을 따른다.

## 7. 소프트웨어 설치와 운영

VM 생성은 디스크 마운트와 호스트명 등록까지 수행한다. `S15P21C206-72`에서 Hadoop 3.5.0·OpenJDK 17 기반 HDFS를 설치·초기화하고, `S15P21C206-73`에서 YARN과 Spark sample application을 검증한다. Docker 설치와 NameNode 초기화·수동 전환 명령은 [분산 시스템 운영 절차](../../distributed-system/README.md)에서 관리한다.

## 공식 참고

- [VM 생성 옵션](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create)
- [고정 외부 IP 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/addresses/create)
- [VPC Peering 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/networks/peerings/create)
- [VPC Peering 삭제](https://docs.cloud.google.com/sdk/gcloud/reference/compute/networks/peerings/delete)
- [방화벽 허용 주소 갱신](https://docs.cloud.google.com/sdk/gcloud/reference/compute/firewall-rules/update)
- [VPC Peering DNS 제한](https://docs.cloud.google.com/vpc/docs/vpc-peering#dns_support)
- [Compute Engine 내부 DNS 이름](https://docs.cloud.google.com/compute/docs/internal-dns)
- [GCP 네트워크 가격](https://cloud.google.com/vpc/network-pricing)

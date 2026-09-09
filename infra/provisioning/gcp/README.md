# GCP 6계정 클러스터 생성·확인·피어링

각 팀원이 Windows PowerShell에서 자신의 GCP 프로젝트에 노드 1대를 생성하고, 전체 6개 프로젝트를 메시 피어링하는 절차입니다. 인프라 구성은 [GCP 인프라 구조](../../../docs/development/gcp-distributed-infrastructure.md)를 참고합니다.

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

## 3. 노드 생성

마스터 담당자:

```powershell
.\scripts\create-node.ps1 -ProjectId $ProjectId -Node 1 -AdminCidr $AdminCidr
```

Worker 담당자는 자신의 번호 `2~6`을 넣습니다.

```powershell
.\scripts\create-node.ps1 -ProjectId $ProjectId -Node 2 -AdminCidr $AdminCidr
```

| 구분 | 머신 | 부팅 | 데이터 디스크 | HA 메타데이터 | 외부 IPv4 |
|---|---|---:|---:|---:|---|
| Node 1 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | 200GiB | 기존 데이터 디스크 사용 | Standard 고정 IP |
| Node 2 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | 2000GiB | 100GiB `pd-balanced` | Standard 임시 IP |
| Node 3~6 | `e2-custom-6-36864` (6 vCPU / 36GiB) | 30GiB | 2000GiB | 없음 | Standard 임시 IP |

Worker의 Boot와 Data는 모두 지역 `pd-standard` 2,048GiB 할당량을 사용한다. 기본값은 `30 + 2,000 = 2,030GiB`이며 18GiB를 남긴다. 합계가 2,048GiB를 넘으면 생성 전에 스크립트가 중단한다. Node 2의 Metadata는 별도 SSD 할당량을 사용하는 `pd-balanced`다.

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

SSH 연결과 `/mnt/data` 마운트까지 확인합니다.

```powershell
.\scripts\inspect-node.ps1 -ProjectId $ProjectId -Node 2 -CheckSsh
```

직접 접속하거나 실제 SSH 명령과 키 경로를 확인합니다.

```powershell
gcloud compute ssh master-1 --project=$ProjectId --zone=asia-east1-b
gcloud compute ssh worker-2 --project=$ProjectId --zone=asia-east1-b
gcloud compute ssh master-1 --project=$ProjectId --zone=asia-east1-b --dry-run
```

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

현재 6개 노드 생성이 끝나면 프로젝트 ID를 노드 순서대로 입력합니다. 테스트나 확장 시 스크립트는 중복되지 않은 프로젝트 ID를 2개 이상 받아 입력 개수대로 처리합니다. 모든 참여자가 같은 배열과 순서를 사용합니다.

```powershell
$Projects = @(
  'actual-master-project',
  'actual-worker2-project',
  'actual-worker3-project',
  'actual-worker4-project',
  'actual-worker5-project',
  'actual-worker6-project'
)
```

각 팀원이 자신의 프로젝트에서 한 번씩 실행합니다.

```powershell
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects
```

프로젝트당 `$Projects.Count - 1`개 피어링이 `ACTIVE`인지 확인합니다.

```powershell
$Network = gcloud compute networks describe planetory-vpc `
  --project=$ProjectId `
  --format=json | ConvertFrom-Json

$Network.peerings |
  Select-Object name, state, stateDetails, network |
  Format-Table -AutoSize
```

## 6. 노드 간 통신 확인

자신의 VM에 SSH로 접속한 뒤 실행합니다.

```bash
for n in 1 2 3 4 5 6; do
  ping -c 2 -W 2 "10.20.$n.10"
done
```

## 7. 필요한 관리 명령

공인 IP가 바뀌었을 때 SSH 허용 주소를 갱신합니다.

```powershell
$AdminCidr = "$(Invoke-RestMethod 'https://api.ipify.org')/32"
gcloud compute firewall-rules update planetory-admin-ssh `
  --project=$ProjectId `
  --source-ranges=$AdminCidr
```

현재 생성된 리소스를 확인합니다.

```powershell
gcloud compute instances list --project=$ProjectId
gcloud compute disks list --project=$ProjectId
gcloud compute addresses list --project=$ProjectId
```

생성 스크립트는 기존 동명 리소스가 있으면 중단합니다. VM을 삭제해도 `auto-delete=no` 데이터 디스크와 예약 고정 IP는 남아 과금될 수 있습니다.

## 8. 소프트웨어 설치와 운영

VM 생성은 디스크 마운트와 호스트명 등록까지 수행한다. Hadoop/YARN 및 Docker 설치 후 [분산 시스템 운영 절차](../../distributed-system/README.md)를 따른다. NameNode 초기화·수동 전환 명령은 그 문서에서 관리한다.

## 공식 참고

- [VM 생성 옵션](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create)
- [고정 외부 IP 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/addresses/create)
- [VPC Peering 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/networks/peerings/create)
- [GCP 네트워크 가격](https://cloud.google.com/vpc/network-pricing)

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

6개 노드 생성이 끝나면 프로젝트 ID를 노드 순서대로 입력합니다.

- 모든 참여자가 같은 배열과 순서를 사용합니다.
- 부분 테스트는 중복되지 않은 프로젝트 ID 2~6개로 실행할 수 있습니다.
- 6대를 넘기려면 방화벽과 IP 계획부터 다시 정해야 합니다.
- 스크립트는 피어링 생성 후 짧은 호스트명과 GCE FQDN을 등록하고 이름 해석을 검사합니다.

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

다른 존을 사용했다면 생성 때와 같은 값을 전달합니다.

```powershell
.\scripts\create-mesh-peering.ps1 -ProjectId $ProjectId -Projects $Projects -Zone asia-east1-b
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
getent hosts master-1 worker-2 worker-3 worker-4 worker-5 worker-6
```

Hadoop 시작 후에는 `yarn node -list -all`이 표시한 전체 호스트명을 다른 VM과 작업 컨테이너에서 `getent hosts <호스트명>`으로 확인합니다. VPC Peering은 상대 프로젝트의 내부 DNS를 공유하지 않으므로 IP ping만으로 YARN 연결을 판정하지 않습니다.

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

## 8. 운영 기한과 비용 확인

2026-09-09 기준, 720시간 공제 전 계획값은 다음과 같습니다.

| 노드 | 계획값 |
| --- | ---: |
| Node 1 | $219.36 |
| Node 2 | $300.24 |
| Node 3~6 | 각 $290.38 |

크레딧, 세금, 로그와 송신 비용은 포함하지 않았습니다. 각 계정의 Billing에서 다시 확인합니다.

> Node 2의 $300 초과와 추가 비용 여유를 고려해 **27일 안에 결과 이전과 자원 정리**를 완료합니다.

```powershell
gcloud compute instances list --project=$ProjectId
gcloud compute disks list --project=$ProjectId
gcloud compute addresses list --project=$ProjectId
```

VM만 중지하거나 삭제해도 남아 있는 영속 디스크와 예약 IP는 계속 과금될 수 있습니다.

## 9. 소프트웨어 설치와 운영

VM 생성은 디스크 마운트와 호스트명 등록까지 수행한다. Hadoop/YARN 및 Docker 설치 후 [분산 시스템 운영 절차](../../distributed-system/README.md)를 따른다. NameNode 초기화·수동 전환 명령은 그 문서에서 관리한다.

## 공식 참고

- [VM 생성 옵션](https://docs.cloud.google.com/sdk/gcloud/reference/compute/instances/create)
- [고정 외부 IP 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/addresses/create)
- [VPC Peering 생성](https://docs.cloud.google.com/sdk/gcloud/reference/compute/networks/peerings/create)
- [VPC Peering DNS 제한](https://docs.cloud.google.com/vpc/docs/vpc-peering#dns_support)
- [Compute Engine 내부 DNS 이름](https://docs.cloud.google.com/compute/docs/internal-dns)
- [GCP 네트워크 가격](https://cloud.google.com/vpc/network-pricing)

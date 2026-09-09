[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,
 [Parameter(Mandatory)][ValidateRange(1,6)][int]$Node,
 [Parameter(Mandatory)][string]$AdminCidr,
 [ValidatePattern('^[a-z0-9-]+$')][string]$MachineType='e2-highmem-4',
 [ValidateRange(10,65536)][int]$DataDiskSizeGiB=200,
 [ValidateRange(10,65536)][int]$MetadataDiskSizeGiB=100,
 [ValidateRange(10,65536)][int]$BootDiskSizeGiB=30,
 [ValidatePattern('^[a-z]+-[a-z]+[0-9]+-[a-z]$')][string]$Zone='asia-east1-b'
)
$ErrorActionPreference='Stop'
$ip=$null
if ($AdminCidr -notmatch '/32$' -or -not [Net.IPAddress]::TryParse(($AdminCidr -replace '/32$',''),[ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -eq '0.0.0.0') { throw 'AdminCidr must be your IPv4 address followed by /32.' }
function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
 $output
}
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI first.' }
$region=$Zone.Substring(0,$Zone.Length-2)
$network='planetory-vpc'
$subnet="node-$Node-subnet"
$role=switch ($Node) { 1 {'master'} 2 {'standby-worker'} default {'worker'} }
$nameNodeRole=switch ($Node) { 1 {'active'} 2 {'standby'} default {'none'} }
$journalNode=if ($Node -le 3) {'yes'} else {'no'}
$vm=if ($Node -eq 1) {'master-1'} else {"worker-$Node"}
if (-not $PSBoundParameters.ContainsKey('DataDiskSizeGiB')) {
 $DataDiskSizeGiB=if ($Node -eq 1) {200} else {2000}
}
$standardDiskQuotaGiB=2048
$standardDiskTotalGiB=$BootDiskSizeGiB+$DataDiskSizeGiB
if ($standardDiskTotalGiB -gt $standardDiskQuotaGiB) {
 throw "Boot and data pd-standard disks total $standardDiskTotalGiB GiB, exceeding the $standardDiskQuotaGiB GiB regional quota."
}
Invoke-Gcloud services enable compute.googleapis.com "--project=$ProjectId"
Invoke-Gcloud compute machine-types describe $MachineType "--project=$ProjectId" "--zone=$Zone" '--format=value(name,guestCpus,memoryMb)'
$diskSummary="boot $BootDiskSizeGiB GiB + data $DataDiskSizeGiB GiB"
if ($Node -eq 2) { $diskSummary+=" + metadata $MetadataDiskSizeGiB GiB pd-balanced" }
Write-Host "$vm : $MachineType / $diskSummary / $Zone"
# Existing resources cause failure; no overwrite or automatic adoption.
Invoke-Gcloud compute networks create $network "--project=$ProjectId" --subnet-mode=custom
Invoke-Gcloud compute networks subnets create $subnet "--project=$ProjectId" "--network=$network" "--region=$region" "--range=10.20.$Node.0/24"
$sources=(1..6 | ForEach-Object {"10.20.$_.10/32"}) -join ','
Invoke-Gcloud compute firewall-rules create planetory-internal "--project=$ProjectId" "--network=$network" --direction=INGRESS "--source-ranges=$sources" --target-tags=planetory-cluster "--allow=tcp,udp,icmp"
Invoke-Gcloud compute firewall-rules create planetory-admin-ssh "--project=$ProjectId" "--network=$network" --direction=INGRESS "--source-ranges=$AdminCidr" --target-tags=planetory-cluster --allow=tcp:22
$nic="network=$network,subnet=$subnet,private-network-ip=10.20.$Node.10,network-tier=STANDARD"
if ($Node -eq 1) {
 Invoke-Gcloud compute addresses create planetory-master-ip "--project=$ProjectId" "--region=$region" --network-tier=STANDARD
 $address=Invoke-Gcloud compute addresses describe planetory-master-ip "--project=$ProjectId" "--region=$region" '--format=value(address)'
 $nic+=",address=$($address.Trim())"
}
# New disk only. Worker external IP is ephemeral by default.
Invoke-Gcloud compute disks create "$vm-data" "--project=$ProjectId" "--zone=$Zone" --type=pd-standard "--size=${DataDiskSizeGiB}GB"
if ($Node -eq 2) {
 Invoke-Gcloud compute disks create "$vm-metadata" "--project=$ProjectId" "--zone=$Zone" --type=pd-balanced "--size=${MetadataDiskSizeGiB}GB"
}
$startup=@'
#!/bin/bash
set -euo pipefail
mount_disk() {
  local device="$1" target="$2" marker="$3"
  for attempt in $(seq 1 60); do
    [ -b "$device" ] && break
    sleep 2
  done
  [ -b "$device" ] || { echo "Disk missing: $device"; exit 1; }
  [ "$(lsblk -nr -o NAME "$device" | wc -l)" -eq 1 ] || { echo "Partitioned disk: $device"; exit 1; }
  local type uuid
  type=$(blkid -p -s TYPE -o value "$device" || true)
  if [ -z "$type" ]; then
    [ -z "$(wipefs --no-act --noheadings --output TYPE "$device")" ] || { echo "Unknown signature: $device"; exit 1; }
    mkfs.ext4 -m 0 "$device"
  elif [ "$type" != ext4 ]; then
    echo "Unexpected filesystem on $device: $type"; exit 1
  fi
  mkdir -p "$target"
  uuid=$(blkid -s UUID -o value "$device")
  if mountpoint -q "$target"; then
    [ "$(findmnt -n -o UUID --target "$target")" = "$uuid" ] || { echo "Wrong mounted disk: $target"; exit 1; }
  else
    [ -z "$(ls -A "$target")" ] || { echo "Nonempty mount directory: $target"; exit 1; }
  fi
  if ! grep -q "^UUID=$uuid " /etc/fstab; then
    if awk -v target="$target" '$2 == target { found=1 } END { exit !found }' /etc/fstab; then
      echo "Conflicting fstab entry: $target"; exit 1
    fi
    printf 'UUID=%s %s ext4 defaults,nofail 0 2\n' "$uuid" "$target" >> /etc/fstab
  fi
  mountpoint -q "$target" || mount "$target"
  touch "/var/lib/$marker"
}
mount_disk /dev/disk/by-id/google-planetory-data /mnt/data planetory-data-ready
if [ -e /dev/disk/by-id/google-planetory-metadata ]; then
  mount_disk /dev/disk/by-id/google-planetory-metadata /mnt/metadata planetory-metadata-ready
fi
prepare_link() {
  local source="$1" target="$2"
  mkdir -p "$source" "$(dirname "$target")"
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ "$(readlink -f "$target")" = "$(readlink -f "$source")" ] || { echo "Conflicting HA path: $target"; exit 1; }
  else
    ln -s "$source" "$target"
  fi
}
case '__NODE__' in
  1)
    prepare_link /mnt/data/namenode /var/lib/hadoop-hdfs/namenode
    prepare_link /mnt/data/journal /var/lib/hadoop-hdfs/journal
    ;;
  2)
    prepare_link /mnt/metadata/namenode /var/lib/hadoop-hdfs/namenode
    prepare_link /mnt/metadata/journal /var/lib/hadoop-hdfs/journal
    ;;
  3)
    mkdir -p /var/lib/hadoop-hdfs/journal
    ;;
esac
if ! grep -q '^# planetory-cluster$' /etc/hosts; then
  cat >> /etc/hosts <<'HOSTS'
# planetory-cluster
10.20.1.10 master-1
10.20.2.10 worker-2
10.20.3.10 worker-3
10.20.4.10 worker-4
10.20.5.10 worker-5
10.20.6.10 worker-6
HOSTS
fi
echo PLANETORY_DATA_READY
'@
$tempFile=[IO.Path]::GetTempFileName()
try {
 $startup=$startup.Replace('__NODE__',[string]$Node)
 [IO.File]::WriteAllText($tempFile,$startup.Replace("`r`n","`n")+"`n",[Text.UTF8Encoding]::new($false))
 $instanceArgs=@('compute','instances','create',$vm,"--project=$ProjectId","--zone=$Zone","--machine-type=$MachineType",
  "--network-interface=$nic","--tags=planetory-cluster,planetory-$role",
  "--labels=service=planetory,role=$role,node=$Node,namenode=$nameNodeRole,journalnode=$journalNode",
  '--boot-disk-type=pd-standard',"--boot-disk-size=${BootDiskSizeGiB}GB",
  "--disk=name=$vm-data,device-name=planetory-data,auto-delete=no",
  '--image-family=ubuntu-2404-lts-amd64','--image-project=ubuntu-os-cloud','--no-service-account','--no-scopes',
  "--metadata-from-file=startup-script=$tempFile")
 if ($Node -eq 2) { $instanceArgs+="--disk=name=$vm-metadata,device-name=planetory-metadata,auto-delete=no" }
 Invoke-Gcloud @instanceArgs
} finally { Remove-Item -LiteralPath $tempFile -Force }
Write-Host 'Created. Use inspect-node.ps1 -CheckSsh to check startup and mount.'

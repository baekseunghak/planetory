[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ProjectId,
 [Parameter(Mandatory)][ValidateRange(1,6)][int]$Node,
 [string]$Zone='asia-east1-b',
 [switch]$CheckSsh
)
$ErrorActionPreference='Stop'
function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
 $output
}
$vm=if ($Node -eq 1) {'master-1'} else {"worker-$Node"}
$tailHost="node-$Node"
$tailUser=if ($Node -eq 1) {'SSAFY'} else {'planetory-admin'}
$sshTarget="$tailUser@$tailHost"
$raw=Invoke-Gcloud compute instances describe $vm "--project=$ProjectId" "--zone=$Zone" --format=json
$info=($raw -join "`n") | ConvertFrom-Json
$nic=$info.networkInterfaces[0]
[pscustomobject]@{Name=$info.name;Status=$info.status;Zone=$Zone;Machine=$info.machineType.Split('/')[-1];InternalIp=$nic.networkIP;ExternalIp=($nic.accessConfigs.natIP -join ',');Tier=($nic.accessConfigs.networkTier -join ',')} | Format-List
foreach ($disk in $info.disks) {
 $name=$disk.source.Split('/')[-1]
 Invoke-Gcloud compute disks describe $name "--project=$ProjectId" "--zone=$Zone" '--format=table(name,sizeGb,type.basename(),status)'
}
Invoke-Gcloud compute networks peerings list "--project=$ProjectId" --network=planetory-vpc '--format=table(name,peerNetwork,state,stateDetails)'
Write-Host "Tailnet check: tailscale ping $tailHost"
Write-Host "SSH: tailscale ssh $sshTarget"
Write-Host "Startup logs: gcloud compute instances get-serial-port-output $vm --project=$ProjectId --zone=$Zone"
if ($CheckSsh) {
 if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
 $check='set -eu; hostname; hostname --fqdn; test -f /var/lib/planetory-data-ready; mountpoint /mnt/data; findmnt /mnt/data; df -h / /mnt/data'
 if ($Node -eq 1) { $check+='; test -d /var/lib/hadoop-hdfs/namenode; test -d /var/lib/hadoop-hdfs/journal; readlink -f /var/lib/hadoop-hdfs/namenode /var/lib/hadoop-hdfs/journal' }
 if ($Node -eq 2) { $check+='; test -f /var/lib/planetory-metadata-ready; mountpoint /mnt/metadata; findmnt /mnt/metadata; df -h /mnt/metadata; test -d /var/lib/hadoop-hdfs/namenode; test -d /var/lib/hadoop-hdfs/journal; readlink -f /var/lib/hadoop-hdfs/namenode /var/lib/hadoop-hdfs/journal' }
 if ($Node -eq 3) { $check+='; test -d /var/lib/hadoop-hdfs/journal; findmnt -T /var/lib/hadoop-hdfs/journal' }
 $check+='; getent hosts master-1 worker-2 worker-3 worker-4 worker-5 worker-6; lsblk --ascii -o NAME,SIZE,FSTYPE,MOUNTPOINTS'
 & tailscale ping --timeout=5s $tailHost
 if ($LASTEXITCODE -ne 0) { throw "Tailnet ping failed: $tailHost" }
 & tailscale ssh $sshTarget $check
 if ($LASTEXITCODE -ne 0) { throw "Tailnet SSH check failed: $sshTarget" }
}

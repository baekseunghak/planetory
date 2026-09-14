[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ProjectId,
 [Parameter(Mandatory)][ValidateCount(2,6)][string[]]$Projects,
 [ValidateCount(2,6)][ValidateRange(1,6)][int[]]$NodeNumbers,
 [switch]$SkipHosts,
 [ValidatePattern('^[a-z]+-[a-z]+[0-9]+-[a-z]$')][string]$Zone='asia-east1-b'
)
$ErrorActionPreference='Stop'
if ($Projects.Count -lt 2) { throw 'Supply at least two project IDs in node order.' }
if (@($Projects | Select-Object -Unique).Count -ne $Projects.Count) { throw 'Project IDs must be distinct.' }
foreach ($project in $Projects) {
 if ($project -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw "Invalid project ID: $project" }
}
if ($ProjectId -notin $Projects) { throw 'ProjectId must occur in Projects.' }
if (-not $NodeNumbers) { $NodeNumbers=@(1..$Projects.Count) }
if ($NodeNumbers.Count -ne $Projects.Count -or @($NodeNumbers | Select-Object -Unique).Count -ne $NodeNumbers.Count) { throw 'NodeNumbers must contain one distinct node number per project, in the same order.' }
function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
 $output
}
$network='planetory-vpc'
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI first.' }
try {
 $json=Invoke-Gcloud compute networks describe $network "--project=$ProjectId" --format=json
} catch {
 throw "Cannot read network '$network' in project '$ProjectId'. Check the original gcloud error above, the actual project ID, active gcloud account and Compute Network permissions. The network must already exist from create-node.ps1; inspect existing resources before rerunning provisioning. No peering or VM changes were made. Cause: $($_.Exception.Message)"
}
$local=($json -join "`n") | ConvertFrom-Json
$node=$NodeNumbers[[array]::IndexOf($Projects,$ProjectId)]
$vm=if ($node -eq 1) {'master-1'} else {"worker-$node"}
$vmJson=Invoke-Gcloud compute instances describe $vm "--project=$ProjectId" "--zone=$Zone" --format=json
$instance=($vmJson -join "`n") | ConvertFrom-Json
if (-not @($instance.networkInterfaces | Where-Object { $_.network -like "*/projects/$ProjectId/global/networks/$network" -and $_.networkIP -eq "10.20.$node.10" }).Count) { throw "VM $vm does not match $network / 10.20.$node.10. Check Projects and NodeNumbers before peering. No changes were made." }
# Check all name conflicts before creating any peering.
for ($i=0;$i -lt $Projects.Count;$i++) {
 $peer=$Projects[$i]
 if ($peer -eq $ProjectId) { continue }
 $target="/projects/$peer/global/networks/$network"
 if (@($local.peerings | Where-Object { $_.network -like "*$target" }).Count) { continue }
 $name="peer-node-$($NodeNumbers[$i])"
 if (@($local.peerings | Where-Object { $_.name -eq $name }).Count) { throw "Peering name $name is already used by a different network. Inspect existing peerings; nothing has been changed." }
}
for ($i=0;$i -lt $Projects.Count;$i++) {
 $peer=$Projects[$i]
 if ($peer -eq $ProjectId) { continue }
 $name="peer-node-$($NodeNumbers[$i])"
 $existing=@($local.peerings | Where-Object {$_.network -like "*/projects/$peer/global/networks/$network"})
 if ($existing.Count) {
  if ($existing[0].name -ne $name) {
   Write-Warning "Node $($NodeNumbers[$i]) ($peer): existing name '$($existing[0].name)', expected '$name'. Target network matches; keeping the connection. To correct the name, explicitly delete '$($existing[0].name)' with reset-mesh-peering.ps1 -PeeringNames, then rerun this script. Deletion interrupts this connection."
  }
  Write-Host "Already configured: $($existing[0].name) ($peer), state=$($existing[0].state)"
  continue
 }
 Invoke-Gcloud compute networks peerings create $name "--project=$ProjectId" "--network=$network" "--peer-project=$peer" "--peer-network=$network" --format=none
}
Invoke-Gcloud compute networks describe $network "--project=$ProjectId" '--format=flattened(peerings[].name,peerings[].network,peerings[].state,peerings[].stateDetails)'
if ($SkipHosts) { Write-Host 'Peering configuration finished. Hosts update skipped; check both sides for ACTIVE state.'; return }
$hostNames=@()
$hostLines=@('# BEGIN planetory-cluster')
for ($i=0;$i -lt $Projects.Count;$i++) {
 $number=$NodeNumbers[$i]
 $nodeHostName=if ($number -eq 1) {'master-1'} else {"worker-$number"}
 $zonal="$nodeHostName.$Zone.c.$($Projects[$i]).internal"
 $global="$nodeHostName.c.$($Projects[$i]).internal"
 $hostLines+="10.20.$number.10 $nodeHostName $zonal $global"
 $hostNames+=@($nodeHostName,$zonal,$global)
}
$hostLines+='# END planetory-cluster'
$tempFile=[IO.Path]::GetTempFileName()
try {
 [IO.File]::WriteAllText($tempFile,($hostLines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
 Invoke-Gcloud compute scp $tempFile "${vm}:/tmp/planetory-cluster-hosts" "--project=$ProjectId" "--zone=$Zone"
 $replaceHosts="if sudo grep -q '^# planetory-cluster$' /etc/hosts; then echo 'Legacy hosts block found; inspect and migrate it manually before retrying.' >&2; exit 1; fi; sudo cp -p /etc/hosts /etc/hosts.planetory-backup-"+'$(date +%s%N)'+" && sudo sed -i '/^# BEGIN planetory-cluster$/,/^# END planetory-cluster$/d' /etc/hosts && sudo sh -c 'cat /tmp/planetory-cluster-hosts >> /etc/hosts' && rm /tmp/planetory-cluster-hosts"
 Invoke-Gcloud compute ssh $vm "--project=$ProjectId" "--zone=$Zone" "--command=$replaceHosts"
 Write-Host 'Checking three aliases per node (short name + two FQDNs); repeated IP rows are expected.'
 Invoke-Gcloud compute ssh $vm "--project=$ProjectId" "--zone=$Zone" "--command=getent hosts $($hostNames -join ' ')"
} finally {
 Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
$peeringsPerProject=$Projects.Count-1
$directionalEntries=$Projects.Count*$peeringsPerProject
Write-Host "Expect $peeringsPerProject ACTIVE peerings per project and $directionalEntries directional entries total. Short and GCE FQDN aliases were installed and resolved on $vm."

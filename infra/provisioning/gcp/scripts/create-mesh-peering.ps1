[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ProjectId,
 [Parameter(Mandatory)][ValidateCount(2,6)][string[]]$Projects,
 [ValidatePattern('^[a-z]+-[a-z]+[0-9]+-[a-z]$')][string]$Zone='asia-east1-b'
)
$ErrorActionPreference='Stop'
if ($Projects.Count -lt 2) { throw 'Supply at least two project IDs in node order.' }
if (@($Projects | Select-Object -Unique).Count -ne $Projects.Count) { throw 'Project IDs must be distinct.' }
foreach ($project in $Projects) {
 if ($project -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw "Invalid project ID: $project" }
}
if ($ProjectId -notin $Projects) { throw 'ProjectId must occur in Projects.' }
function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
 $output
}
$network='planetory-vpc'
$json=Invoke-Gcloud compute networks describe $network "--project=$ProjectId" --format=json
$local=($json -join "`n") | ConvertFrom-Json
for ($i=0;$i -lt $Projects.Count;$i++) {
 $peer=$Projects[$i]
 if ($peer -eq $ProjectId) { continue }
 $name="peer-node-$($i+1)"
 $existing=@($local.peerings | Where-Object {$_.name -eq $name})
 if ($existing.Count) {
  if (-not $existing[0].network.EndsWith("/projects/$peer/global/networks/$network")) { throw "Conflicting peering $name" }
  Write-Host "Already configured: $name ($peer)"
  continue
 }
 Invoke-Gcloud compute networks peerings create $name "--project=$ProjectId" "--network=$network" "--peer-project=$peer" "--peer-network=$network"
}
Invoke-Gcloud compute networks describe $network "--project=$ProjectId" '--format=flattened(peerings[].name,peerings[].network,peerings[].state,peerings[].stateDetails)'
$node=[array]::IndexOf($Projects,$ProjectId)+1
$vm=if ($node -eq 1) {'master-1'} else {"worker-$node"}
$hostNames=@()
$hostLines=@('# BEGIN planetory-cluster')
for ($i=0;$i -lt $Projects.Count;$i++) {
 $number=$i+1
 $host=if ($number -eq 1) {'master-1'} else {"worker-$number"}
 $zonal="$host.$Zone.c.$($Projects[$i]).internal"
 $global="$host.c.$($Projects[$i]).internal"
 $hostLines+="10.20.$number.10 $host $zonal $global"
 $hostNames+=@($host,$zonal,$global)
}
$hostLines+='# END planetory-cluster'
$tempFile=[IO.Path]::GetTempFileName()
try {
 [IO.File]::WriteAllText($tempFile,($hostLines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
 Invoke-Gcloud compute scp $tempFile "${vm}:/tmp/planetory-cluster-hosts" "--project=$ProjectId" "--zone=$Zone"
 $replaceHosts="sudo sed -i '/^# planetory-cluster$/,+6d; /^# BEGIN planetory-cluster$/,/^# END planetory-cluster$/d' /etc/hosts && sudo sh -c 'cat /tmp/planetory-cluster-hosts >> /etc/hosts' && rm /tmp/planetory-cluster-hosts"
 Invoke-Gcloud compute ssh $vm "--project=$ProjectId" "--zone=$Zone" "--command=$replaceHosts"
 Invoke-Gcloud compute ssh $vm "--project=$ProjectId" "--zone=$Zone" "--command=getent hosts $($hostNames -join ' ')"
} finally {
 Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
$peeringsPerProject=$Projects.Count-1
$directionalEntries=$Projects.Count*$peeringsPerProject
Write-Host "Expect $peeringsPerProject ACTIVE peerings per project and $directionalEntries directional entries total. Short and GCE FQDN aliases were installed and resolved on $vm."

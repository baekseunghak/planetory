[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ProjectId,
 [Parameter(Mandatory)][string[]]$Projects
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
$peeringsPerProject=$Projects.Count-1
$directionalEntries=$Projects.Count*$peeringsPerProject
Write-Host "Each member runs this in their project. Expect $peeringsPerProject ACTIVE peerings per project, $directionalEntries directional entries total."

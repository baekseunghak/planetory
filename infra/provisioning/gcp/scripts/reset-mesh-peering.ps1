[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
 [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$ProjectId,
 [ValidateNotNullOrEmpty()][ValidatePattern('^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$')][string[]]$PeeringNames
)
$ErrorActionPreference='Stop'
function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' '). Earlier successful deletions are not rolled back; inspect peerings before retrying." }
 $output
}
$network='planetory-vpc'
$json=Invoke-Gcloud compute networks describe $network "--project=$ProjectId" --format=json
$local=($json -join "`n") | ConvertFrom-Json
$local.peerings | Select-Object name,state,network | Format-Table -AutoSize -Wrap
# No names means read-only inspection, never delete all by default.
if (-not $PeeringNames) {
 Write-Host 'INSPECTION ONLY: nothing deleted. Specify names from the table with -PeeringNames <name> -WhatIf to preview; remove -WhatIf to delete after confirmation.'
 return
}
$targets=@($PeeringNames | Select-Object -Unique)
foreach ($peeringName in $targets) {
 if ($peeringName -notin @($local.peerings.name)) { throw "Peering '$peeringName' not found in $ProjectId/$network. No changes were made." }
}
foreach ($peeringName in $targets) {
 $peer=@($local.peerings | Where-Object { $_.name -eq $peeringName })[0]
 if ($PSCmdlet.ShouldProcess("$ProjectId/$network/$peeringName -> $($peer.network)", 'Delete local peering (cluster connectivity will be interrupted)')) {
  Invoke-Gcloud compute networks peerings delete $peeringName "--project=$ProjectId" "--network=$network" --quiet
 }
}
Invoke-Gcloud compute networks describe $network "--project=$ProjectId" '--format=flattened(peerings[].name,peerings[].network,peerings[].state,peerings[].stateDetails)'

# Offline regression check: gcloud, tailscale and scp are mocked; no remote resources are touched.
$ErrorActionPreference='Stop'
$meshTestState=@{ Calls=[Collections.Generic.List[string]]::new(); FailDescribe=$false; HostsContent=''; Peerings=@(); Node=1; Project='test-master' }
function gcloud {
 $meshTestState.Calls.Add(($args -join ' '))
 $global:LASTEXITCODE=0
 if (($args -join ' ') -like 'compute networks peerings delete*') {
  if ($meshTestState.FailDelete) { $global:LASTEXITCODE=1; return }
  $deletedName=$args[4]
  $meshTestState.Peerings=@($meshTestState.Peerings | Where-Object { $_.name -ne $deletedName })
  return
 }
 if (($args -join ' ') -like 'compute networks describe*') {
  if ($meshTestState.FailDescribe) { $global:LASTEXITCODE=1; return }
  return (@{peerings=$meshTestState.Peerings} | ConvertTo-Json -Depth 5 -Compress)
 }
 if (($args -join ' ') -like 'compute instances describe*') {
  return (@{networkInterfaces=@(@{network="https://www.googleapis.com/compute/v1/projects/$($meshTestState.Project)/global/networks/planetory-vpc"; networkIP="10.20.$($meshTestState.Node).10"})} | ConvertTo-Json -Depth 5 -Compress)
 }
}
function tailscale {
 $meshTestState.Calls.Add("tailscale $($args -join ' ')")
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  if ($meshTestState.Node -eq 1) { return 'master-1' }
  return "worker-$($meshTestState.Node)"
 }
}
function scp {
 $meshTestState.Calls.Add("scp $($args -join ' ')")
 $meshTestState.HostsContent=Get-Content -LiteralPath $args[0] -Raw
 $global:LASTEXITCODE=0
}
& "$PSScriptRoot/create-mesh-peering.ps1" -ProjectId test-master -Projects test-master,test-worker
if ($meshTestState.HostsContent -notmatch '10\.20\.1\.10 master-1 master-1\.asia-east1-b\.c\.test-master\.internal' -or
    $meshTestState.HostsContent -notmatch '10\.20\.2\.10 worker-2 worker-2\.asia-east1-b\.c\.test-worker\.internal') {
 throw 'Host aliases were not generated correctly.'
}
if (@($meshTestState.Calls | Where-Object { $_ -like 'compute networks peerings create*' }).Count -ne 1) { throw 'Expected one peering creation.' }
$meshTestState.Calls.Clear()
$meshTestState.FailDescribe=$true
$failure=''
try { & "$PSScriptRoot/create-mesh-peering.ps1" -ProjectId test-master -Projects test-master,test-worker }
catch { $failure=$_.Exception.Message }
if ($failure -notlike "*Cannot read network 'planetory-vpc' in project 'test-master'*") { throw 'Expected actionable VPC lookup error.' }
if ($meshTestState.Calls.Count -ne 1) { throw 'Failed VPC lookup must stop before mutations.' }
$meshTestState.FailDescribe=$false
$meshTestState.Calls.Clear()
$meshTestState.Node=5
$meshTestState.Project='test-worker5'
$meshTestState.Peerings=@(@{name='peer-node-4'; network='https://www.googleapis.com/compute/v1/projects/test-worker6/global/networks/planetory-vpc'; state='ACTIVE'})
& "$PSScriptRoot/create-mesh-peering.ps1" -ProjectId test-worker5 -Projects test-master,test-worker,test-worker5,test-worker6 -NodeNumbers 1,2,5,6 -WarningVariable nameWarnings
if (($nameWarnings -join ' ') -notlike "*existing name 'peer-node-4', expected 'peer-node-6'*") { throw 'Mismatched peering name must be explained.' }
if ($meshTestState.HostsContent -notmatch '10\.20\.5\.10 worker-5' -or $meshTestState.HostsContent -notmatch '10\.20\.6\.10 worker-6' -or $meshTestState.HostsContent -match 'worker-[34]') { throw 'Sparse node numbering was not preserved.' }
if (@($meshTestState.Calls | Where-Object { $_ -like '*peerings create*--peer-project=test-worker6*' }).Count) { throw 'Existing peer network should be reused regardless of name.' }
if (-not @($meshTestState.Calls | Where-Object { $_ -like 'scp *planetory-admin@node-5:*' }).Count) { throw 'Wrong tailnet target for node 5.' }
$meshTestState.Calls.Clear()
$failure=''
try { & "$PSScriptRoot/create-mesh-peering.ps1" -ProjectId test-worker5 -Projects test-master,test-worker,test-worker5,test-worker6 }
catch { $failure=$_.Exception.Message }
if ($failure -notlike '*does not match*' -or @($meshTestState.Calls | Where-Object { $_ -match 'peerings create|^scp |tailscale ssh' }).Count) { throw 'Wrong mapping must fail before mutation.' }
$meshTestState.Calls.Clear()
& "$PSScriptRoot/create-mesh-peering.ps1" -ProjectId test-worker5 -Projects test-master,test-worker,test-worker5,test-worker6 -NodeNumbers 1,2,5,6 -SkipHosts
if (@($meshTestState.Calls | Where-Object { $_ -match '^scp |tailscale (ping|ssh)' }).Count) { throw 'SkipHosts must not use tailnet SSH.' }
Write-Host 'PASS: aliases, sparse nodes, existing peers, preflight failures and SkipHosts (offline).'
$meshTestState.Peerings=@(
 @{name='peer-node-3'; network='projects/test-worker3/global/networks/planetory-vpc'},
 @{name='peer-node-4'; network='projects/test-worker4/global/networks/planetory-vpc'},
 @{name='unrelated'; network='projects/test-other/global/networks/other'}
)
$meshTestState.Calls.Clear()
& "$PSScriptRoot/reset-mesh-peering.ps1" -ProjectId test-master -InformationVariable resetInfo
if (($resetInfo -join ' ') -notlike '*INSPECTION ONLY*') { throw 'Read-only reset must explain that nothing was deleted.' }
& "$PSScriptRoot/reset-mesh-peering.ps1" -ProjectId test-master -PeeringNames peer-node-3 -WhatIf
$failure=''
try { & "$PSScriptRoot/reset-mesh-peering.ps1" -ProjectId test-master -PeeringNames peer-node-3,missing -Confirm:$false }
catch { $failure=$_.Exception.Message }
if ($failure -notlike '*No changes were made*' -or @($meshTestState.Calls | Where-Object { $_ -like '*peerings delete*' }).Count) { throw 'Preview or missing target must not delete anything.' }
$meshTestState.FailDelete=$true
try { & "$PSScriptRoot/reset-mesh-peering.ps1" -ProjectId test-master -PeeringNames peer-node-3,peer-node-4 -Confirm:$false }
catch { $failure=$_.Exception.Message }
if ($failure -notlike '*gcloud failed*' -or @($meshTestState.Calls | Where-Object { $_ -like '*peerings delete*' }).Count -ne 1) { throw 'Delete failure must stop the reset.' }
$meshTestState.FailDelete=$false
$meshTestState.Calls.Clear()
& "$PSScriptRoot/reset-mesh-peering.ps1" -ProjectId test-master -PeeringNames peer-node-3 -Confirm:$false
if (@($meshTestState.Calls | Where-Object { $_ -like '*peerings delete peer-node-3 --project=test-master --network=planetory-vpc --quiet' }).Count -ne 1 -or
    $meshTestState.Peerings.Count -ne 2 -or 'unrelated' -notin $meshTestState.Peerings.name -or 'peer-node-3' -in $meshTestState.Peerings.name) { throw 'Reset must delete only the selected local peering.' }
Write-Host 'PASS: reset inspection, WhatIf, missing target, failed delete and scoped deletion (offline).'

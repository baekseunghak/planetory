# Offline regression check: gcloud is mocked; no cloud resources are touched.
$ErrorActionPreference='Stop'
$installTestState=@{Calls=[Collections.Generic.List[string]]::new();BadNode=0}

function gcloud {
 $installTestState.Calls.Add(($args -join ' '))
 $global:LASTEXITCODE=0
 if (($args -join ' ') -like 'compute instances describe*') {
  $vm=$args[3]
  $node=if ($vm -eq 'master-1') {1} else {[int]($vm -replace 'worker-','')}
  $ip=if ($installTestState.BadNode -eq $node) {'10.20.99.10'} else {"10.20.$node.10"}
  return (@{name=$vm;status='RUNNING';networkInterfaces=@(@{networkIP=$ip})} | ConvertTo-Json -Depth 4 -Compress)
 }
}

$projects=@('test-master','test-worker2','test-worker3','test-worker4','test-worker5','test-worker6')
$script=Join-Path $PSScriptRoot 'install-hdfs-hosts.ps1'

& $script -Projects $projects -WhatIf
if (@($installTestState.Calls | Where-Object { $_ -match 'compute (scp|ssh)' }).Count) {
 throw 'WhatIf must not upload files or use SSH.'
}

$installTestState.Calls.Clear()
& $script -Projects $projects -Confirm:$false
if (@($installTestState.Calls | Where-Object { $_ -like 'compute instances describe master-1*' }).Count -ne 1 -or
    @($installTestState.Calls | Where-Object { $_ -like 'compute scp*master-1:/tmp/planetory-hdfs-install/*' }).Count -ne 1 -or
    @($installTestState.Calls | Where-Object { $_ -like '*compute ssh master-1*--command=sudo bash*/install-hdfs-host.sh --node 1*' }).Count -ne 1) {
 throw 'Node 1 upload or install command is incorrect.'
}
if (@($installTestState.Calls | Where-Object { $_ -match 'namenode -format|bootstrapStandby|initializeSharedEdits|--daemon start' }).Count) {
 throw 'The orchestration command must not initialize or start HDFS.'
}

$installTestState.Calls.Clear()
$failure=''
try { & $script -Projects $projects -NodeNumbers 1,2 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*Install Node 1 alone*' -or $installTestState.Calls.Count) {
 throw 'Node 1 must be a standalone canary before other nodes.'
}

$installTestState.Calls.Clear()
$installTestState.BadNode=3
$failure=''
try { & $script -Projects $projects -NodeNumbers 2,3 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*No install commands were run*' -or
    @($installTestState.Calls | Where-Object { $_ -match 'compute (scp|ssh)' }).Count) {
 throw 'All selected node mappings must pass before the first mutation.'
}

Write-Host 'PASS: WhatIf, Node 1 canary, upload command and all-node preflight (offline).'

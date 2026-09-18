# Offline regression check: tailscale and scp are mocked; no remote resources are touched.
$ErrorActionPreference='Stop'
$installTestState=@{Calls=[Collections.Generic.List[string]]::new();BadNode=0}

function tailscale {
 $installTestState.Calls.Add("tailscale $($args -join ' ')")
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  $node=[int](($args[1] -split 'node-')[-1])
  if ($installTestState.BadNode -eq $node) { return 'wrong-host' }
  if ($node -eq 1) { return 'master-1' }
  return "worker-$node"
 }
}

function scp {
 $installTestState.Calls.Add("scp $($args -join ' ')")
 $global:LASTEXITCODE=0
}

$script=Join-Path $PSScriptRoot 'install-hdfs-hosts.ps1'

& $script -WhatIf
if (@($installTestState.Calls | Where-Object { $_ -like 'scp *' -or $_ -match '/tmp/planetory-hdfs-install|sudo bash' }).Count) {
 throw 'WhatIf must run only tailnet reachability and hostname preflight.'
}

$installTestState.Calls.Clear()
& $script -Confirm:$false
if (@($installTestState.Calls | Where-Object { $_ -eq 'tailscale ping --timeout=5s node-1' }).Count -ne 1 -or
    @($installTestState.Calls | Where-Object { $_ -eq 'tailscale ssh SSAFY@node-1 hostname -s' }).Count -ne 1 -or
    @($installTestState.Calls | Where-Object { $_ -like 'scp *SSAFY@node-1:/tmp/planetory-hdfs-install/*' }).Count -ne 1 -or
    @($installTestState.Calls | Where-Object { $_ -like 'tailscale ssh SSAFY@node-1 sudo bash*/install-hdfs-host.sh --node 1*' }).Count -ne 1) {
 throw 'Node 1 tailnet upload or install command is incorrect.'
}
if (@($installTestState.Calls | Where-Object { $_ -match 'namenode -format|bootstrapStandby|initializeSharedEdits|--daemon start|gcloud' }).Count) {
 throw 'The orchestration command must not initialize HDFS, start it, or use gcloud.'
}

$installTestState.Calls.Clear()
$failure=''
try { & $script -NodeNumbers 1,2 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*Install Node 1 alone*' -or $installTestState.Calls.Count) {
 throw 'Node 1 must be a standalone canary before other nodes.'
}

$installTestState.Calls.Clear()
$installTestState.BadNode=3
$failure=''
try { & $script -NodeNumbers 2,3 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*No install commands were run*' -or
    @($installTestState.Calls | Where-Object { $_ -like 'scp *' -or $_ -match '/tmp/planetory-hdfs-install|sudo bash' }).Count) {
 throw 'All selected tailnet mappings must pass before the first mutation.'
}

Write-Host 'PASS: WhatIf, Node 1 canary, tailnet upload and all-node preflight (offline).'

# Offline recovery contract check: gcloud and tailscale are mocked; no remote resources are touched.
$ErrorActionPreference='Stop'
$recoveryTestState=@{Calls=[Collections.Generic.List[string]]::new()}

function tailscale {
 $recoveryTestState.Calls.Add("tailscale $($args -join ' ')")
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  $node=[int](($args[1] -split 'node-')[-1])
  if ($node -eq 1) { return 'master-1' }
  return "worker-$node"
 }
 return 'mock-remote-ok'
}

function gcloud {
 $recoveryTestState.Calls.Add("gcloud $($args -join ' ')")
 $global:LASTEXITCODE=0
 if (($args -join ' ') -match 'instances describe') { return 'RUNNING' }
 return 'mock-gcloud-ok'
}

$script=Join-Path $PSScriptRoot 'validate-hdfs-recovery.ps1'
$common=@{RunId='20260918T120000Z';Node1ProjectId='test-master';WorkerNode=5;WorkerProjectId='test-worker5'}

& $script -Step Preflight @common
if (@($recoveryTestState.Calls | Where-Object { $_ -match 'instances (stop|start)|transitionTo(Active|Standby)|dfs -put|systemctl start' }).Count) {
 throw 'Recovery Preflight must be read-only.'
}

foreach ($step in 'Prepare','PlannedToNode2','PlannedToNode1','StopNode1','PromoteNode2','StartNode1','FailbackNode1','StopWorkerAndObserve','StartWorker') {
 $recoveryTestState.Calls.Clear()
 & $script -Step $step @common -WhatIf
 if ($recoveryTestState.Calls.Count) { throw "$step WhatIf must stop before remote or GCP calls." }
}

$source=Get-Content -Raw $script
if ($source -notmatch [regex]::Escape('$Command=$Command.Replace("`r",'''')')) {
 throw 'Recovery remote commands must remove CR before Bash execution.'
}
if ($source -notmatch [regex]::Escape("base64 --decode | bash")) {
 throw 'Recovery remote commands must use the repository Base64 transport contract.'
}
foreach ($required in (
 'instances stop master-1',
 'instances start master-1',
 'haadmin -transitionToActive --forceactive nn2',
 'haadmin -transitionToStandby nn2',
 'haadmin -transitionToActive nn1',
 'Under replicated blocks:',
 'systemctl start hadoop-hdfs-datanode',
 'systemctl start hadoop-yarn-nodemanager',
 'dfsadmin -triggerBlockReport',
 'AIRFLOW_PUBLISHER_NOT_DEPLOYED'
)) {
 if ($source -notmatch [regex]::Escape($required)) { throw "Missing recovery contract: $required" }
}
foreach ($forbidden in ('namenode -format','-bootstrapStandby','-initializeSharedEdits','dfs -rm','rm -rf','haadmin -failover')) {
 if ($source -match [regex]::Escape($forbidden)) { throw "Recovery script must not contain: $forbidden" }
}

Write-Host 'PASS: read-only preflight, WhatIf guards, exact VM targets, failover, Worker recovery and no-format contracts (offline).'

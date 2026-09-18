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

function Get-StepSource {
 param([string]$Start,[string]$End)
 $startIndex=$source.IndexOf("'$Start' {")
 $endIndex=$source.IndexOf("'$End' {",$startIndex)
 if ($startIndex -lt 0 -or $endIndex -le $startIndex) { throw "Missing recovery step boundary: $Start -> $End" }
 $source.Substring($startIndex,$endIndex-$startIndex)
}

$stopNode1Source=Get-StepSource StopNode1 PromoteNode2
foreach ($required in ('Assert-RemoteHost $node3','timeout 3 bash -c "</dev/tcp/worker-3/8485"','NODE2_SURVIVING_JOURNAL_QUORUM_OK','NODE3_SURVIVING_JOURNAL_QUORUM_OK')) {
 if ($stopNode1Source -notmatch [regex]::Escape($required)) { throw "StopNode1 must verify surviving JournalNode quorum: $required" }
}
if ($stopNode1Source.IndexOf('NODE3_SURVIVING_JOURNAL_QUORUM_OK') -gt $stopNode1Source.IndexOf('instances stop master-1')) {
 throw 'StopNode1 must verify surviving JournalNodes before stopping Node 1.'
}

$promoteSource=Get-StepSource PromoteNode2 StartNode1
$terminatedGuard='Assert-InstanceStatus $Node1ProjectId master-1 TERMINATED'
$forceActive='haadmin -transitionToActive --forceactive nn2'
if ([regex]::Matches($promoteSource,[regex]::Escape($terminatedGuard)).Count -lt 2) {
 throw 'PromoteNode2 must confirm Node 1 is TERMINATED before and immediately before forced activation.'
}
if ($promoteSource.IndexOf($terminatedGuard) -gt $promoteSource.IndexOf($forceActive)) {
 throw 'PromoteNode2 TERMINATED guard must precede forced activation.'
}

$failbackSource=Get-StepSource FailbackNode1 StopWorkerAndObserve
foreach ($required in ('for host in worker-2 worker-3 worker-4 worker-5 worker-6; do','if ! hdfs_cmd dfsadmin -triggerBlockReport','BLOCKED_DATANODE_IPC=')) {
 if ($failbackSource -notmatch [regex]::Escape($required)) { throw "Failback must report every blocked DataNode IPC target: $required" }
}

$startWorkerSource=Get-StepSource StartWorker FinalAudit
foreach ($required in ('if ($WorkerNode -eq 3)','systemctl start hadoop-hdfs-journalnode','WORKER3_JOURNALNODE_STARTED')) {
 if ($startWorkerSource -notmatch [regex]::Escape($required)) { throw "Worker 3 recovery must restore JournalNode first: $required" }
}
if ($startWorkerSource.IndexOf('systemctl start hadoop-hdfs-journalnode') -gt $startWorkerSource.IndexOf('systemctl start hadoop-hdfs-datanode')) {
 throw 'Worker 3 JournalNode must start before its DataNode.'
}

$finalAuditSource=$source.Substring($source.IndexOf("'FinalAudit' {"))
foreach ($required in ('$nodes[0..2]','FINAL_JOURNALNODE_ACTIVE')) {
 if ($finalAuditSource -notmatch [regex]::Escape($required)) { throw "FinalAudit must verify all three JournalNodes: $required" }
}
foreach ($forbidden in ('namenode -format','-bootstrapStandby','-initializeSharedEdits','dfs -rm','rm -rf','haadmin -failover')) {
 if ($source -match [regex]::Escape($forbidden)) { throw "Recovery script must not contain: $forbidden" }
}

Write-Host 'PASS: read-only preflight, WhatIf guards, exact VM targets, failover, Worker recovery and no-format contracts (offline).'

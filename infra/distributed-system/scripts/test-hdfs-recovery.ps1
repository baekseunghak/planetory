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

function Get-StepSourceFrom {
 param([string]$Candidate,[string]$Start,[string]$End)
 $startIndex=$Candidate.IndexOf("'$Start' {")
 $endIndex=$Candidate.IndexOf("'$End' {",$startIndex)
 if ($startIndex -lt 0 -or $endIndex -le $startIndex) { throw "Missing recovery step boundary: $Start -> $End" }
 $Candidate.Substring($startIndex,$endIndex-$startIndex)
}

function Get-StepSource {
 param([string]$Start,[string]$End)
 Get-StepSourceFrom $source $Start $End
}

function Assert-TmpCleanupContract {
 param([string]$Candidate)
 $prepare=Get-StepSourceFrom $Candidate Prepare PlannedToNode2
 $final=$Candidate.Substring($Candidate.IndexOf("'FinalAudit' {"))
 $prepareCleanup='rm -f -- "$local_source" "$local_copy" "$local_sha" "$local_fsck"'
 $finalCleanup='rm -f -- "$final_report" "$final_fsck" "$final_copy" "$final_yarn"'

 foreach ($required in ('local_fsck=/tmp/S15P21C206-74-__RUN_ID__-baseline-fsck.txt','trap cleanup EXIT',$prepareCleanup,'RECOVERY_TMP_CLEANUP_FAILED step=Prepare run_id=__RUN_ID__')) {
  if ($prepare -notmatch [regex]::Escape($required)) { throw "Prepare cleanup contract missing: $required" }
 }
 foreach ($required in ('final_copy=/tmp/S15P21C206-74-__RUN_ID__-final-baseline.bin','trap cleanup EXIT',$finalCleanup,'RECOVERY_TMP_CLEANUP_FAILED step=FinalAudit run_id=__RUN_ID__')) {
  if ($final -notmatch [regex]::Escape($required)) { throw "FinalAudit cleanup contract missing: $required" }
 }
 foreach ($fixedPath in ('/tmp/S15P21C206-74-final-report.txt','/tmp/S15P21C206-74-final-fsck.txt','/tmp/S15P21C206-74-final-baseline.bin','/tmp/S15P21C206-74-final-yarn.txt')) {
  if ($final -match [regex]::Escape($fixedPath)) { throw "FinalAudit temp path must include RunId: $fixedPath" }
 }
}

$prepareSource=Get-StepSource Prepare PlannedToNode2
foreach ($required in ('dd if=/dev/urandom','local_sha=/tmp/S15P21C206-74-__RUN_ID__-baseline.sha256','__EXPECTED_SHA_PATH__')) {
 if ($prepareSource -notmatch [regex]::Escape($required)) { throw "Prepare must persist the random recovery sample checksum: $required" }
}
if ($prepareSource -match [regex]::Escape('/dev/zero')) { throw 'Prepare must not use the reproducible zero-filled recovery sample.' }

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

$startNode1Source=Get-StepSource StartNode1 FailbackNode1
if ([regex]::Matches($startNode1Source,[regex]::Escape('ss -lnt | grep -q ":8032 "')).Count -lt 2) {
 throw 'StartNode1 must assert the ResourceManager client port after its readiness loop.'
}

$failbackSource=Get-StepSource FailbackNode1 StopWorkerAndObserve
foreach ($required in ('for host in worker-2 worker-3 worker-4 worker-5 worker-6; do','if ! hdfs_cmd dfsadmin -triggerBlockReport','BLOCKED_DATANODE_IPC=')) {
 if ($failbackSource -notmatch [regex]::Escape($required)) { throw "Failback must report every blocked DataNode IPC target: $required" }
}

$stopWorkerSource=Get-StepSource StopWorkerAndObserve StartWorker
foreach ($required in ('if ($WorkerNode -eq 3)','Assert-RemoteHost $node2','NODE1_SURVIVING_WORKER3_JOURNAL_QUORUM_OK','NODE2_SURVIVING_WORKER3_JOURNAL_QUORUM_OK')) {
 if ($stopWorkerSource -notmatch [regex]::Escape($required)) { throw "Worker 3 stop must verify the surviving JournalNode quorum: $required" }
}
if ($stopWorkerSource.IndexOf('NODE2_SURVIVING_WORKER3_JOURNAL_QUORUM_OK') -gt $stopWorkerSource.IndexOf('instances stop $workerVm')) {
 throw 'Worker 3 surviving JournalNodes must be verified before stopping the VM.'
}

$startWorkerSource=Get-StepSource StartWorker FinalAudit
foreach ($required in ('if ($WorkerNode -eq 3)','systemctl start hadoop-hdfs-journalnode','WORKER3_JOURNALNODE_STARTED')) {
 if ($startWorkerSource -notmatch [regex]::Escape($required)) { throw "Worker 3 recovery must restore JournalNode first: $required" }
}
if ($startWorkerSource.IndexOf('systemctl start hadoop-hdfs-journalnode') -gt $startWorkerSource.IndexOf('systemctl start hadoop-hdfs-datanode')) {
 throw 'Worker 3 JournalNode must start before its DataNode.'
}

$finalAuditSource=$source.Substring($source.IndexOf("'FinalAudit' {"))
foreach ($required in ('$nodes[0..2]','FINAL_JOURNALNODE_ACTIVE','dfs -cat ''__EXPECTED_SHA_PATH__''','test "$expected_sha" = "$actual_sha"')) {
 if ($finalAuditSource -notmatch [regex]::Escape($required)) { throw "FinalAudit recovery contract missing: $required" }
}
if ($finalAuditSource -match [regex]::Escape('/dev/zero')) { throw 'FinalAudit must compare with the checksum emitted by Prepare.' }
Assert-TmpCleanupContract $source
foreach ($mutation in (
 $source.Replace('rm -f -- "$local_source" "$local_copy" "$local_sha" "$local_fsck"',''),
 $source.Replace('rm -f -- "$final_report" "$final_fsck" "$final_copy" "$final_yarn"','')
)) {
 $rejected=$false
 try { Assert-TmpCleanupContract $mutation } catch { $rejected=$true }
 if (-not $rejected) { throw 'Recovery cleanup mutation must be rejected.' }
}
foreach ($forbidden in ('namenode -format','-bootstrapStandby','-initializeSharedEdits','dfs -rm','rm -rf','haadmin -failover')) {
 if ($source -match [regex]::Escape($forbidden)) { throw "Recovery script must not contain: $forbidden" }
}

Write-Host 'PASS: read-only preflight, WhatIf guards, exact VM targets, failover, Worker recovery and no-format contracts (offline).'

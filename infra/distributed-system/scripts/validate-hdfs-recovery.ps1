[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)]
 [ValidateSet('Preflight','Prepare','PlannedToNode2','PlannedToNode1','StopNode1','PromoteNode2','StartNode1','FailbackNode1','StopWorkerAndObserve','StartWorker','FinalAudit')]
 [string]$Step,
 [Parameter(Mandatory)][ValidatePattern('^\d{8}T\d{6}Z$')][string]$RunId,
 [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$Node1ProjectId,
 [Parameter(Mandatory)][ValidateSet(3,4,5,6)][int]$WorkerNode,
 [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')][string]$WorkerProjectId
)
$ErrorActionPreference='Stop'

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI first.' }

$nodes=@(
 [pscustomobject]@{Number=1;Target='SSAFY@node-1';HostName='master-1'},
 [pscustomobject]@{Number=2;Target='planetory-admin@node-2';HostName='worker-2'},
 [pscustomobject]@{Number=3;Target='planetory-admin@node-3';HostName='worker-3'},
 [pscustomobject]@{Number=4;Target='planetory-admin@node-4';HostName='worker-4'},
 [pscustomobject]@{Number=5;Target='planetory-admin@node-5';HostName='worker-5'},
 [pscustomobject]@{Number=6;Target='planetory-admin@node-6';HostName='worker-6'}
)
$node1=$nodes[0]
$node2=$nodes[1]
$node3=$nodes[2]
$worker=$nodes[$WorkerNode-1]
$workerVm="worker-$WorkerNode"
$validationRoot="/validation/S15P21C206-74/run-$RunId"
$baselinePath="$validationRoot/baseline-256m.bin"
$expectedShaPath="$validationRoot/baseline-256m.sha256"
$hdfs='sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs'
$yarn='sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn'

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Invoke-Remote {
 param([object]$Node,[string]$Command,[string]$Label)
 $Command=$Command.Replace("`r",'')
 Write-Host "== $Label =="
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
 $remoteCommand="printf '%s' '$payload' | base64 --decode | bash"
 $output=@(& tailscale ssh $Node.Target $remoteCommand 2>&1)
 $exitCode=$LASTEXITCODE
 $output | ForEach-Object { Write-Host $_ }
 if ($exitCode -ne 0) { throw "$Label failed on $($Node.Target) (exit $exitCode)." }
 $output
}

function Invoke-Gcloud {
 $output=@(& gcloud @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "gcloud failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Get-InstanceStatus {
 param([string]$Project,[string]$Vm)
 (@(Invoke-Gcloud compute instances describe $Vm "--project=$Project" --zone=asia-east1-b '--format=value(status)') | Select-Object -Last 1).Trim()
}

function Wait-InstanceStatus {
 param([string]$Project,[string]$Vm,[string]$Expected)
 for ($attempt=1;$attempt -le 60;$attempt++) {
  $status=Get-InstanceStatus $Project $Vm
  if ($status -eq $Expected) { Write-Host "INSTANCE_STATUS=${Vm}:$status"; return }
  Start-Sleep -Seconds 5
 }
 throw "$Vm did not reach $Expected within 300 seconds."
}

function Assert-RemoteHost {
 param([object]$Node)
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false "node-$($Node.Number)"
 $actual=@(Invoke-Tailscale ssh $Node.Target hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne $Node.HostName) { throw "$($Node.Target) must resolve to $($Node.HostName)." }
}

function Wait-RemoteHost {
 param([object]$Node)
 for ($attempt=1;$attempt -le 60;$attempt++) {
  & tailscale ping --timeout=5s --until-direct=false "node-$($Node.Number)" 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
   $actual=@(& tailscale ssh $Node.Target hostname -s 2>&1) | Select-Object -Last 1
   if ($LASTEXITCODE -eq 0 -and $actual.Trim() -eq $Node.HostName) { Write-Host "TAILNET_READY=$($Node.HostName)"; return }
  }
  Start-Sleep -Seconds 5
 }
 throw "$($Node.HostName) did not become reachable within 300 seconds."
}

function Assert-InstanceStatus {
 param([string]$Project,[string]$Vm,[string]$Expected)
 $actual=Get-InstanceStatus $Project $Vm
 if ($actual -ne $Expected) { throw "$Project/$Vm must be $Expected, actual=$actual." }
 Write-Host "INSTANCE_STATUS=${Vm}:$actual"
}

function Assert-NoRunningYarnApplications {
 param([object]$Node)
 $command='set -eu; '+$yarn+' application -list -appStates RUNNING 2>&1 | tee /tmp/S15P21C206-74-running-apps.txt; grep -Eq "Total number of applications .*:[[:space:]]*0" /tmp/S15P21C206-74-running-apps.txt; echo NO_RUNNING_YARN_APPLICATIONS'
 $null=Invoke-Remote $Node $command 'Confirm no running YARN applications'
}

$mutatingSteps=@('Prepare','PlannedToNode2','PlannedToNode1','StopNode1','PromoteNode2','StartNode1','FailbackNode1','StopWorkerAndObserve','StartWorker')
if ($Step -in $mutatingSteps -and -not $PSCmdlet.ShouldProcess('Planetory six-node Hadoop cluster',"S15P21C206-74 $Step")) { return }

switch ($Step) {
 'Preflight' {
  foreach ($node in $nodes) { Assert-RemoteHost $node }
  Assert-InstanceStatus $Node1ProjectId master-1 RUNNING
  Assert-InstanceStatus $WorkerProjectId $workerVm RUNNING
  Assert-NoRunningYarnApplications $node1
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
hdfs_cmd dfsadmin -report | tee /tmp/S15P21C206-74-preflight-report.txt
grep -q "Live datanodes (5)" /tmp/S15P21C206-74-preflight-report.txt
grep -q "Under replicated blocks: 0" /tmp/S15P21C206-74-preflight-report.txt
grep -q "Blocks with corrupt replicas: 0" /tmp/S15P21C206-74-preflight-report.txt
grep -q "Missing blocks: 0" /tmp/S15P21C206-74-preflight-report.txt
if hdfs_cmd dfs -test -e '__VALIDATION_ROOT__'; then echo VALIDATION_PATH_EXISTS >&2; exit 1; fi
systemctl is-active --quiet hadoop-yarn-resourcemanager
echo RECOVERY_PREFLIGHT_OK
'@.Replace('__VALIDATION_ROOT__',$validationRoot)
  $null=Invoke-Remote $node1 $command 'Recovery preflight'
 }
 'Prepare' {
  Assert-RemoteHost $node1
  Assert-NoRunningYarnApplications $node1
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
if hdfs_cmd dfs -test -e '__VALIDATION_ROOT__'; then echo VALIDATION_PATH_EXISTS >&2; exit 1; fi
local_source=/tmp/S15P21C206-74-__RUN_ID__-baseline.bin
local_copy=/tmp/S15P21C206-74-__RUN_ID__-baseline.copy.bin
local_sha=/tmp/S15P21C206-74-__RUN_ID__-baseline.sha256
local_fsck=/tmp/S15P21C206-74-__RUN_ID__-baseline-fsck.txt
cleanup() {
 main_status=$?
 trap - EXIT
 if rm -f -- "$local_source" "$local_copy" "$local_sha" "$local_fsck"; then
  echo "RECOVERY_TMP_CLEANUP_OK step=Prepare run_id=__RUN_ID__"
 else
  echo "RECOVERY_TMP_CLEANUP_FAILED step=Prepare run_id=__RUN_ID__" >&2
  if test "$main_status" -eq 0; then exit 1; fi
 fi
 exit "$main_status"
}
trap cleanup EXIT
dd if=/dev/urandom of="$local_source" bs=1M count=256 status=none
source_sha=$(sha256sum "$local_source" | cut -d " " -f 1)
printf '%s\n' "$source_sha" > "$local_sha"
hdfs_cmd dfs -mkdir -p '__VALIDATION_ROOT__'
hdfs_cmd dfs -put "$local_source" '__BASELINE_PATH__'
hdfs_cmd dfs -put "$local_sha" '__EXPECTED_SHA_PATH__'
test "$(hdfs_cmd dfs -stat %r '__BASELINE_PATH__')" = 2
hdfs_cmd dfs -checksum '__BASELINE_PATH__'
hdfs_cmd dfs -get '__BASELINE_PATH__' "$local_copy"
copy_sha=$(sha256sum "$local_copy" | cut -d " " -f 1)
test "$source_sha" = "$copy_sha"
hdfs_cmd fsck '__BASELINE_PATH__' -files -blocks -locations | tee "$local_fsck"
grep -q "Status: HEALTHY" "$local_fsck"
grep -q "Live_repl=2" "$local_fsck"
echo HDFS_PATH='__BASELINE_PATH__'
echo SHA256="$source_sha"
echo RECOVERY_SAMPLE_PREPARED
'@.Replace('__RUN_ID__',$RunId).Replace('__VALIDATION_ROOT__',$validationRoot).Replace('__BASELINE_PATH__',$baselinePath).Replace('__EXPECTED_SHA_PATH__',$expectedShaPath)
  $null=Invoke-Remote $node1 $command 'Prepare RF2 recovery sample'
 }
 'PlannedToNode2' {
  Assert-RemoteHost $node1
  Assert-RemoteHost $node2
  Assert-NoRunningYarnApplications $node1
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn1)" = active; test "$('+$hdfs+' haadmin -getServiceState nn2)" = standby; '+$hdfs+' haadmin -transitionToStandby nn1; test "$('+$hdfs+' haadmin -getServiceState nn1)" = standby; echo NN1_PLANNED_STANDBY'
  $null=Invoke-Remote $node1 $command 'Planned transition: Node 1 to standby'
  $command=@'
set -eu
start=$(date +%s)
__HDFS__ haadmin -transitionToActive nn2
test "$(__HDFS__ haadmin -getServiceState nn2)" = active
__HDFS__ dfs -cat '__BASELINE_PATH__' >/dev/null
printf "planned Node 2 write __RUN_ID__\n" > /tmp/S15P21C206-74-planned-node2.txt
__HDFS__ dfs -put /tmp/S15P21C206-74-planned-node2.txt '__VALIDATION_ROOT__/planned-node2.txt'
__HDFS__ dfs -checksum '__VALIDATION_ROOT__/planned-node2.txt'
echo PLANNED_TO_NN2_SECONDS=$(($(date +%s)-start))
echo PLANNED_TO_NN2_OK
'@.Replace('__HDFS__',$hdfs).Replace('__BASELINE_PATH__',$baselinePath).Replace('__VALIDATION_ROOT__',$validationRoot).Replace('__RUN_ID__',$RunId)
  $null=Invoke-Remote $node2 $command 'Planned transition: activate Node 2 and validate I/O'
 }
 'PlannedToNode1' {
  Assert-RemoteHost $node1
  Assert-RemoteHost $node2
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn2)" = active; test "$('+$hdfs+' haadmin -getServiceState nn1)" = standby; '+$hdfs+' haadmin -transitionToStandby nn2; test "$('+$hdfs+' haadmin -getServiceState nn2)" = standby; echo NN2_PLANNED_STANDBY'
  $null=Invoke-Remote $node2 $command 'Planned transition: Node 2 to standby'
  $command='set -eu; start=$(date +%s); '+$hdfs+' haadmin -transitionToActive nn1; test "$('+$hdfs+' haadmin -getServiceState nn1)" = active; '+$hdfs+' dfs -cat "'+$baselinePath+'" >/dev/null; echo PLANNED_TO_NN1_SECONDS=$(($(date +%s)-start)); echo PLANNED_TO_NN1_OK'
  $null=Invoke-Remote $node1 $command 'Planned transition: activate Node 1 and validate read'
 }
 'StopNode1' {
  Assert-RemoteHost $node1
  Assert-RemoteHost $node2
  Assert-RemoteHost $node3
  Assert-InstanceStatus $Node1ProjectId master-1 RUNNING
  Assert-NoRunningYarnApplications $node1
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn1)" = active; test "$('+$hdfs+' haadmin -getServiceState nn2)" = standby; '+$hdfs+' dfs -cat "'+$baselinePath+'" >/dev/null; systemctl is-active --quiet hadoop-hdfs-journalnode; systemctl is-active --quiet hadoop-hdfs-namenode; systemctl is-active --quiet hadoop-yarn-resourcemanager; echo NODE1_STOP_PREREQUISITES_OK'
  $null=Invoke-Remote $node1 $command 'Node 1 stop prerequisites'
  $command='set -eu; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; timeout 3 bash -c "</dev/tcp/worker-3/8485"; timeout 3 bash -c "</dev/tcp/worker-3/8480"; echo NODE2_SURVIVING_JOURNAL_QUORUM_OK'
  $null=Invoke-Remote $node2 $command 'Confirm surviving JournalNode quorum from Node 2'
  $command='set -eu; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; echo NODE3_SURVIVING_JOURNAL_QUORUM_OK'
  $null=Invoke-Remote $node3 $command 'Confirm surviving JournalNode on Node 3'
  $started=Get-Date
  $null=Invoke-Gcloud compute instances stop master-1 "--project=$Node1ProjectId" --zone=asia-east1-b --quiet
  Wait-InstanceStatus $Node1ProjectId master-1 TERMINATED
  Write-Host "NODE1_STOP_SECONDS=$([int]((Get-Date)-$started).TotalSeconds)"
 }
 'PromoteNode2' {
  Assert-InstanceStatus $Node1ProjectId master-1 TERMINATED
  Assert-RemoteHost $node2
  Assert-RemoteHost $node3
  Assert-InstanceStatus $Node1ProjectId master-1 TERMINATED
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
systemctl is-active --quiet hadoop-hdfs-journalnode
timeout 3 bash -c "</dev/tcp/worker-3/8485"
start=$(date +%s)
hdfs_cmd haadmin -transitionToActive --forceactive nn2
test "$(hdfs_cmd haadmin -getServiceState nn2)" = active
hdfs_cmd dfs -cat '__BASELINE_PATH__' >/dev/null
printf "Node 1 stopped; Node 2 active __RUN_ID__\n" > /tmp/S15P21C206-74-node1-down.txt
hdfs_cmd dfs -put /tmp/S15P21C206-74-node1-down.txt '__VALIDATION_ROOT__/node1-down-write.txt'
hdfs_cmd dfs -checksum '__VALIDATION_ROOT__/node1-down-write.txt'
hdfs_cmd dfsadmin -report | tee /tmp/S15P21C206-74-node1-down-report.txt
grep -q "Live datanodes (5)" /tmp/S15P21C206-74-node1-down-report.txt
echo NODE2_PROMOTION_SECONDS=$(($(date +%s)-start))
echo NODE2_FAILURE_PROMOTION_IO_OK
'@.Replace('__BASELINE_PATH__',$baselinePath).Replace('__VALIDATION_ROOT__',$validationRoot).Replace('__RUN_ID__',$RunId)
  $null=Invoke-Remote $node2 $command 'Promote Node 2 after confirmed Node 1 stop'
 }
 'StartNode1' {
  Assert-InstanceStatus $Node1ProjectId master-1 TERMINATED
  Assert-RemoteHost $node2
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn2)" = active; echo NN2_ACTIVE_BEFORE_NODE1_START'
  $null=Invoke-Remote $node2 $command 'Confirm Node 2 remains active'
  $started=Get-Date
  $null=Invoke-Gcloud compute instances start master-1 "--project=$Node1ProjectId" --zone=asia-east1-b --quiet
  Wait-InstanceStatus $Node1ProjectId master-1 RUNNING
  Wait-RemoteHost $node1
  $command=@'
set -eu
mountpoint -q /mnt/data
sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION
sudo systemctl start hadoop-hdfs-journalnode
for attempt in {1..30}; do ss -lnt | grep -q ":8485 " && break; sleep 1; done
ss -lnt | grep -q ":8485 "
sudo systemctl start hadoop-hdfs-namenode
for attempt in {1..30}; do ss -lnt | grep -q ":8020 " && break; sleep 1; done
ss -lnt | grep -q ":8020 "
test "$(__HDFS__ haadmin -getServiceState nn1)" = standby
test "$(__HDFS__ haadmin -getServiceState nn2)" = active
sudo systemctl start hadoop-yarn-resourcemanager
for attempt in {1..30}; do ss -lnt | grep -q ":8032 " && break; sleep 1; done
ss -lnt | grep -q ":8032 "
systemctl is-active --quiet hadoop-yarn-resourcemanager
containers=$(sudo docker ps -a --format '{{.Names}}' 2>/dev/null || true)
if printf '%s\n' "$containers" | grep -Eq 'airflow|publisher'; then echo CONTROL_PLANE_CONTAINERS_PRESENT; else echo AIRFLOW_PUBLISHER_NOT_DEPLOYED; fi
echo NODE1_STANDBY_AND_RM_RECOVERED
'@.Replace('__HDFS__',$hdfs)
  $null=Invoke-Remote $node1 $command 'Recover Node 1 in dependency order'
  Write-Host "NODE1_START_AND_RECOVERY_SECONDS=$([int]((Get-Date)-$started).TotalSeconds)"
 }
 'FailbackNode1' {
  Assert-RemoteHost $node1
  Assert-RemoteHost $node2
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn2)" = active; test "$('+$hdfs+' haadmin -getServiceState nn1)" = standby; '+$hdfs+' haadmin -transitionToStandby nn2; test "$('+$hdfs+' haadmin -getServiceState nn2)" = standby; echo NN2_FAILBACK_STANDBY'
  $null=Invoke-Remote $node2 $command 'Failback: Node 2 to standby'
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
start=$(date +%s)
hdfs_cmd haadmin -transitionToActive nn1
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
blocked=""
for host in worker-2 worker-3 worker-4 worker-5 worker-6; do
 if ! hdfs_cmd dfsadmin -triggerBlockReport "$host:9867"; then blocked="$blocked $host"; fi
done
if test -n "$blocked"; then echo BLOCKED_DATANODE_IPC="$blocked" >&2; exit 1; fi
hdfs_cmd dfs -cat '__BASELINE_PATH__' >/dev/null
systemctl is-active --quiet hadoop-yarn-resourcemanager
echo NODE1_FAILBACK_SECONDS=$(($(date +%s)-start))
echo NODE1_FAILBACK_OK
'@.Replace('__BASELINE_PATH__',$baselinePath)
  $null=Invoke-Remote $node1 $command 'Failback: activate Node 1 and validate read'
 }
 'StopWorkerAndObserve' {
  Assert-RemoteHost $node1
  Assert-RemoteHost $worker
  Assert-InstanceStatus $WorkerProjectId $workerVm RUNNING
  Assert-NoRunningYarnApplications $node1
  if ($WorkerNode -eq 3) {
   Assert-RemoteHost $node2
   $command='set -eu; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; timeout 3 bash -c "</dev/tcp/worker-2/8485"; timeout 3 bash -c "</dev/tcp/worker-2/8480"; echo NODE1_SURVIVING_WORKER3_JOURNAL_QUORUM_OK'
   $null=Invoke-Remote $node1 $command 'Confirm Node 1 survives Worker 3 JournalNode stop'
   $command='set -eu; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; timeout 3 bash -c "</dev/tcp/master-1/8485"; timeout 3 bash -c "</dev/tcp/master-1/8480"; echo NODE2_SURVIVING_WORKER3_JOURNAL_QUORUM_OK'
   $null=Invoke-Remote $node2 $command 'Confirm Node 2 survives Worker 3 JournalNode stop'
  }
  $workerIp="10.20.$WorkerNode.10"
  $command='set -eu; test "$('+$hdfs+' haadmin -getServiceState nn1)" = active; '+$hdfs+' fsck "'+$baselinePath+'" -files -blocks -locations | tee /tmp/S15P21C206-74-worker-target-fsck.txt; grep -q "'+$workerIp+':9866" /tmp/S15P21C206-74-worker-target-fsck.txt; '+$hdfs+' dfs -cat "'+$baselinePath+'" >/dev/null; echo WORKER_TARGET_OWNS_BASELINE_BLOCK'
  $null=Invoke-Remote $node1 $command "Confirm baseline replica on Worker $WorkerNode"
  $started=Get-Date
  $null=Invoke-Gcloud compute instances stop $workerVm "--project=$WorkerProjectId" --zone=asia-east1-b --quiet
  Wait-InstanceStatus $WorkerProjectId $workerVm TERMINATED
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
observed=false
for attempt in $(seq 1 720); do
 report=$(hdfs_cmd dfsadmin -report)
 dead=$(printf '%s\n' "$report" | sed -n 's/^Dead datanodes (\([0-9][0-9]*\)):.*/\1/p')
 under=$(printf '%s\n' "$report" | awk -F: '/Under replicated blocks:/ { gsub(/[[:space:]]/,"",$2); print $2 }')
 if test "${dead:-0}" -ge 1 -a "${under:-0}" -ge 1; then
  echo DEAD_DATANODES="$dead"
  echo UNDER_REPLICATED_BLOCKS="$under"
  observed=true
  break
 fi
 sleep 1
done
$observed
hdfs_cmd dfs -cat '__BASELINE_PATH__' >/dev/null
hdfs_cmd dfs -checksum '__BASELINE_PATH__'
hdfs_cmd fsck '__BASELINE_PATH__' -files -blocks -locations | tee /tmp/S15P21C206-74-worker-down-fsck.txt
grep -Eq "Live_repl=[12]" /tmp/S15P21C206-74-worker-down-fsck.txt
echo WORKER_DOWN_RF2_READ_OK
'@.Replace('__BASELINE_PATH__',$baselinePath)
  $null=Invoke-Remote $node1 $command "Observe Worker $WorkerNode failure and verify RF2 read"
  Write-Host "WORKER_FAILURE_DETECTION_SECONDS=$([int]((Get-Date)-$started).TotalSeconds)"
 }
 'StartWorker' {
  Assert-InstanceStatus $WorkerProjectId $workerVm TERMINATED
  Assert-RemoteHost $node1
  $started=Get-Date
  $null=Invoke-Gcloud compute instances start $workerVm "--project=$WorkerProjectId" --zone=asia-east1-b --quiet
  Wait-InstanceStatus $WorkerProjectId $workerVm RUNNING
  Wait-RemoteHost $worker
  $journalNodeRecovery=''
  if ($WorkerNode -eq 3) {
   $journalNodeRecovery='sudo systemctl start hadoop-hdfs-journalnode; for attempt in {1..30}; do ss -lnt | grep -q ":8485 " && break; sleep 1; done; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; echo WORKER3_JOURNALNODE_STARTED; '
  }
  $command='set -eu; mountpoint -q /mnt/data; '+$journalNodeRecovery+'sudo systemctl start hadoop-hdfs-datanode; for attempt in {1..30}; do ss -lnt | grep -q ":9866 " && break; sleep 1; done; ss -lnt | grep -q ":9866 "; sudo systemctl start hadoop-yarn-nodemanager; for attempt in {1..30}; do ss -lnt | grep -q ":8041 " && break; sleep 1; done; ss -lnt | grep -q ":8041 "; echo WORKER_SERVICES_STARTED_IN_ORDER'
  $null=Invoke-Remote $worker $command "Start Worker $WorkerNode DataNode then NodeManager"
  $command=@'
set -eu
__HDFS__ dfsadmin -triggerBlockReport '__WORKER_HOST__:9867'
for attempt in $(seq 1 120); do
 report=$(__HDFS__ dfsadmin -report)
 live=$(printf '%s\n' "$report" | sed -n 's/^Live datanodes (\([0-9][0-9]*\)):.*/\1/p')
 under=$(printf '%s\n' "$report" | awk -F: '/Under replicated blocks:/ { gsub(/[[:space:]]/,"",$2); print $2 }')
 yarn_nodes=$(__YARN__ node -list -all 2>&1 | awk '$2 == "RUNNING" { count++ } END { print count + 0 }')
 if test "${live:-0}" = 5 -a "${under:-1}" = 0 -a "$yarn_nodes" = 5; then echo WORKER_CLUSTER_RECOVERED; break; fi
 sleep 2
done
test "${live:-0}" = 5
test "${under:-1}" = 0
test "$yarn_nodes" = 5
__HDFS__ dfs -cat '__BASELINE_PATH__' >/dev/null
__HDFS__ dfs -checksum '__BASELINE_PATH__'
echo WORKER_RECOVERY_RF2_YARN_OK
'@.Replace('__HDFS__',$hdfs).Replace('__YARN__',$yarn).Replace('__BASELINE_PATH__',$baselinePath).Replace('__WORKER_HOST__',$worker.HostName)
  $null=Invoke-Remote $node1 $command "Verify Worker $WorkerNode recovery"
  Write-Host "WORKER_START_AND_RECOVERY_SECONDS=$([int]((Get-Date)-$started).TotalSeconds)"
 }
 'FinalAudit' {
  foreach ($node in $nodes) { Assert-RemoteHost $node }
  Assert-InstanceStatus $Node1ProjectId master-1 RUNNING
  Assert-InstanceStatus $WorkerProjectId $workerVm RUNNING
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
final_report=/tmp/S15P21C206-74-__RUN_ID__-final-report.txt
final_fsck=/tmp/S15P21C206-74-__RUN_ID__-final-fsck.txt
final_copy=/tmp/S15P21C206-74-__RUN_ID__-final-baseline.bin
final_yarn=/tmp/S15P21C206-74-__RUN_ID__-final-yarn.txt
cleanup() {
 main_status=$?
 trap - EXIT
 if rm -f -- "$final_report" "$final_fsck" "$final_copy" "$final_yarn"; then
  echo "RECOVERY_TMP_CLEANUP_OK step=FinalAudit run_id=__RUN_ID__"
 else
  echo "RECOVERY_TMP_CLEANUP_FAILED step=FinalAudit run_id=__RUN_ID__" >&2
  if test "$main_status" -eq 0; then exit 1; fi
 fi
 exit "$main_status"
}
trap cleanup EXIT
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
hdfs_cmd dfsadmin -report | tee "$final_report"
grep -q "Live datanodes (5)" "$final_report"
grep -q "Dead datanodes (0)" "$final_report" || ! grep -q "Dead datanodes" "$final_report"
grep -q "Under replicated blocks: 0" "$final_report"
grep -q "Blocks with corrupt replicas: 0" "$final_report"
grep -q "Missing blocks: 0" "$final_report"
hdfs_cmd fsck '__VALIDATION_ROOT__' -files -blocks -locations | tee "$final_fsck"
grep -q "Status: HEALTHY" "$final_fsck"
grep -q "Over-replicated blocks:[[:space:]]*0" "$final_fsck"
hdfs_cmd dfs -get -f '__BASELINE_PATH__' "$final_copy"
expected_sha=$(hdfs_cmd dfs -cat '__EXPECTED_SHA_PATH__' | tr -d '[:space:]')
printf '%s' "$expected_sha" | grep -Eq '^[0-9a-f]{64}$'
actual_sha=$(sha256sum "$final_copy" | cut -d " " -f 1)
test "$expected_sha" = "$actual_sha"
systemctl is-active --quiet hadoop-yarn-resourcemanager
__YARN__ node -list -all 2>&1 | tee "$final_yarn"
test "$(awk '$2 == "RUNNING" { count++ } END { print count + 0 }' "$final_yarn")" = 5
echo FINAL_SHA256="$actual_sha"
echo FINAL_HDFS_YARN_RECOVERY_AUDIT_OK
'@.Replace('__RUN_ID__',$RunId).Replace('__VALIDATION_ROOT__',$validationRoot).Replace('__BASELINE_PATH__',$baselinePath).Replace('__EXPECTED_SHA_PATH__',$expectedShaPath).Replace('__YARN__',$yarn)
  $null=Invoke-Remote $node1 $command 'Final HDFS/YARN recovery audit'
  foreach ($node in $nodes[0..2]) {
   $command='set -eu; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8485 "; ss -lnt | grep -q ":8480 "; echo FINAL_JOURNALNODE_ACTIVE'
   $null=Invoke-Remote $node $command "Final JournalNode $($node.Number) service audit"
  }
  foreach ($node in $nodes[1..5]) {
   $command='set -eu; systemctl is-active --quiet hadoop-hdfs-datanode; systemctl is-active --quiet hadoop-yarn-nodemanager; echo WORKER_SERVICES_ACTIVE'
   $null=Invoke-Remote $node $command "Final Worker $($node.Number) service audit"
  }
 }
}

Write-Host "PASS: $Step"

[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Worker4','Node1','RecoverNode1')]
    [string]$Step,
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$RunId,
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$CodeReleaseId='20260922T021406Z'
)

$ErrorActionPreference='Stop'
if (-not $PSCmdlet.ShouldProcess($Step,"Reboot and verify Sector 14 run $RunId")) { return }
$node1='SSAFY@node-1'
$worker='planetory-admin@node-4'
$hdfs='sudo -n -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs'
$yarn='sudo -n -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn'

function Invoke-Remote([string]$Target,[string]$Command) {
    $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command.Replace("`r",'')))
    $result=@(& tailscale ssh $Target "printf '%s' '$payload' | base64 --decode | bash" 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Remote check failed on $Target ($LASTEXITCODE): $($result -join ' ')" }
    $result
}
function Wait-NewBoot([string]$Target,[string]$Before) {
    for ($attempt=0; $attempt -lt 90; $attempt++) {
        $output=@(& tailscale ssh $Target 'cat /proc/sys/kernel/random/boot_id' 2>&1)
        if ($LASTEXITCODE -eq 0) {
            $observed=(@($output) | Select-Object -Last 1).Trim()
            if ($observed -match '^[0-9a-f-]{36}$' -and $observed -ne $Before) {
                Write-Host "BOOT_CHANGED target=$Target boot_id=$observed"
                return
            }
        }
        Start-Sleep -Seconds 5
    }
    throw "Reboot could not be verified on $Target; inspect the VM before retrying."
}
function Restart-Host([string]$Target,[string]$Before) {
    $null=@(& tailscale ssh $Target 'sudo -n systemctl reboot' 2>&1)
    if ($LASTEXITCODE -notin @(0,255)) { Write-Host "REBOOT_SSH_DISCONNECTED exit=$LASTEXITCODE" }
    Wait-NewBoot $Target $Before
}

if ($Step -eq 'Worker4') {
    $unit="planetory-tess-ingestion-$RunId-worker-3.service"
    $events="/mnt/data/staging/S15P21C206-75/run-$RunId/manifests/sector-14-worker-3.events.jsonl"
    $before=@(Invoke-Remote $worker "set -eu; mountpoint -q /mnt/data; systemctl is-active --quiet '$unit'; cat /proc/sys/kernel/random/boot_id; wc -l < '$events'")
    $boot=($before | Select-Object -First 1).Trim()
    $lines=[long](($before | Select-Object -Last 1).Trim())
    $null=Invoke-Remote $node1 "set -eu; $yarn application -list -appStates RUNNING,ACCEPTED,NEW | grep -q 'Total number of applications.*):0'; $hdfs dfsadmin -report | grep -q 'Live datanodes (5)'"
    Restart-Host $worker $boot
    $restore=@"
set -eu
mountpoint -q /mnt/data
sudo -n systemctl start hadoop-hdfs-datanode
sudo -n systemctl start hadoop-yarn-nodemanager
for attempt in `$(seq 1 60); do
  if systemctl is-active --quiet '$unit'; then break; fi
  sleep 2
done
systemctl is-active --quiet '$unit'
test `$(wc -l < '$events') -ge $lines
echo WORKER4_INGESTION_RESUMED events_before=$lines events_after=`$(wc -l < '$events')
"@
    Invoke-Remote $worker $restore | ForEach-Object { Write-Host $_ }
    $null=Invoke-Remote $node1 "set -eu; $hdfs dfsadmin -report | grep -q 'Live datanodes (5)'"
    return
}

$unit="planetory-tess-ingestion-$RunId-worker-3.service"
$preflight=@"
set -eu
test `"`$($hdfs haadmin -getServiceState nn1)`" = active
test `"`$($hdfs haadmin -getServiceState nn2)`" = standby
$hdfs dfsadmin -report | grep -q 'Live datanodes (5)'
$yarn application -list -appStates RUNNING,ACCEPTED,NEW | grep -q 'Total number of applications.*):0'
sudo -n docker inspect -f '{{.Config.Image}}' planetory-distributed-system-airflow-scheduler-1 | grep -qx 'local/planetory-airflow:$CodeReleaseId'
cat /proc/sys/kernel/random/boot_id
"@
if ($Step -eq 'Node1') {
    $boot=(@(Invoke-Remote $node1 $preflight) | Select-Object -Last 1).Trim()
    Restart-Host $node1 $boot
}
$restore=@"
set -eu
mountpoint -q /mnt/data
sudo -n systemctl start hadoop-hdfs-journalnode
sudo -n systemctl start hadoop-hdfs-namenode
for attempt in `$(seq 1 60); do
  state2=`$($hdfs haadmin -getServiceState nn2 2>/dev/null || true)
  state1=`$($hdfs haadmin -getServiceState nn1 2>/dev/null || true)
  if test `"`$state2`" = standby && { test `"`$state1`" = standby || test `"`$state1`" = active; }; then break; fi
  sleep 2
done
test `"`$state2`" = standby
for attempt in `$(seq 1 60); do
  if $hdfs dfsadmin -safemode get | grep -q 'Safe mode is OFF in master-1/10.20.1.10:8020'; then break; fi
  sleep 2
done
$hdfs dfsadmin -safemode get | grep -q 'Safe mode is OFF in master-1/10.20.1.10:8020'
if test `"`$state1`" = standby; then $hdfs haadmin -transitionToActive nn1; fi
test `"`$($hdfs haadmin -getServiceState nn1)`" = active
sudo -n systemctl start hadoop-yarn-resourcemanager
for attempt in `$(seq 1 60); do
  if sudo -n docker ps --format '{{.Names}}' | grep -q planetory-distributed-system-airflow-scheduler-1; then break; fi
  sleep 2
done
test `"`$(sudo -n docker inspect -f '{{.Config.Image}}' planetory-distributed-system-airflow-scheduler-1)`" = 'local/planetory-airflow:$CodeReleaseId'
sudo -n docker exec planetory-distributed-system-airflow-scheduler-1 airflow variables get tess_pipeline_max_sector | grep -qx 14
sudo -n docker exec planetory-distributed-system-airflow-scheduler-1 airflow variables get tess_pipeline_enabled | grep -qx true
$hdfs dfsadmin -safemode get | grep -q 'OFF'
$hdfs dfsadmin -report | grep -q 'Live datanodes (5)'
systemctl is-active --quiet hadoop-yarn-resourcemanager
echo NODE1_AIRFLOW_HDFS_YARN_RESTORED
"@
Invoke-Remote $node1 $restore | ForEach-Object { Write-Host $_ }
$null=Invoke-Remote $worker "systemctl is-active --quiet '$unit'"

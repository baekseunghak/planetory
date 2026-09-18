[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [ValidateRange(60,600)][int]$TimeoutSeconds=300
)
$ErrorActionPreference='Stop'

$sparkImage='apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1'
$sampleFile=Join-Path $PSScriptRoot 'yarn-hdfs-sample.py'
if (-not (Test-Path -LiteralPath $sampleFile -PathType Leaf)) { throw "Missing sample: $sampleFile" }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { throw 'Install an OpenSSH client with scp first.' }

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Invoke-Remote {
 param([string]$Target,[string]$Command,[string]$Label)
 Write-Host "== $Label =="
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
 $remoteCommand="printf '%s' '$payload' | base64 --decode | bash"
 $output=@(& tailscale ssh $Target $remoteCommand 2>&1)
 $exitCode=$LASTEXITCODE
 $output | ForEach-Object { Write-Host $_ }
 if ($exitCode -ne 0) { throw "$Label failed on $Target (exit $exitCode)." }
 $output
}

function Invoke-Scp {
 $output=@(& scp @args 2>&1)
 if ($LASTEXITCODE -ne 0) { throw "scp failed: $($args -join ' ')`n$($output -join "`n")" }
 $output
}

$node1='SSAFY@node-1'
$node2='planetory-admin@node-2'
foreach ($target in @(@('node-1',$node1,'master-1'),@('node-2',$node2,'worker-2'))) {
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false $target[0]
 $actual=@(Invoke-Tailscale ssh $target[1] hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne $target[2]) { throw "$($target[1]) must resolve to $($target[2])." }
}
if (-not $PSCmdlet.ShouldProcess('Planetory YARN cluster','pull pinned Spark image and run HDFS read/write sample')) { return }

$runStartedUtc=[datetime]::UtcNow
$runId=$runStartedUtc.ToString('yyyyMMddTHHmmssZ')
$oomSince=$runStartedUtc.ToString('yyyy-MM-dd HH:mm:ss UTC',[Globalization.CultureInfo]::InvariantCulture)
$container="planetory-yarn-sample-$runId".ToLowerInvariant()
$remoteDir="/tmp/planetory-yarn-sample-$runId"
$remoteSample="$remoteDir/yarn-hdfs-sample.py"
$base="/validation/S15P21C206-73/run-$runId"
$input="$base/input/input.txt"
$output="$base/output"
$scpArgs=@('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',$sampleFile,"${node1}:$remoteSample")
try {
 $null=Invoke-Remote $node1 "install -d -m 700 $remoteDir" 'Prepare Node 1 sample staging'
 Invoke-Scp @scpArgs

$launch=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
yarn_cmd() { sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn "$@"; }
systemctl is-active --quiet hadoop-yarn-resourcemanager
nn1_state=$(hdfs_cmd haadmin -getServiceState nn1)
nn2_state=$(hdfs_cmd haadmin -getServiceState nn2)
case "$nn1_state:$nn2_state" in
 active:standby|standby:active) ;;
 *) echo "INVALID_HDFS_HA_STATE=nn1:$nn1_state,nn2:$nn2_state" >&2; exit 1;;
esac
test "$(yarn_cmd node -list -all | awk '$2 == "RUNNING" { count++ } END { print count + 0 }')" = 5
test "$(yarn_cmd application -list -appStates RUNNING | awk '$1 ~ /^application_/ { count++ } END { print count + 0 }')" = 0
printf 'planetory yarn sample one\nplanetory yarn sample two\n' > /tmp/__RUN_ID__-input.txt
hdfs_cmd dfs -mkdir -p __BASE__/input
hdfs_cmd dfs -put /tmp/__RUN_ID__-input.txt __INPUT__
hdfs_cmd dfs -chmod 1777 __BASE__
sudo docker pull __IMAGE__
sudo docker image inspect __IMAGE__ --format 'SPARK_IMAGE_ID={{.Id}}'
sudo docker run --rm --network host \
  --add-host master-1:10.20.1.10 \
  --add-host worker-2:10.20.2.10 \
  --add-host worker-3:10.20.3.10 \
  --add-host worker-4:10.20.4.10 \
  --add-host worker-5:10.20.5.10 \
  --add-host worker-6:10.20.6.10 \
  --entrypoint python3 __IMAGE__ -c 'import socket; expected={"master-1":"10.20.1.10","worker-2":"10.20.2.10","worker-3":"10.20.3.10","worker-4":"10.20.4.10","worker-5":"10.20.5.10","worker-6":"10.20.6.10"}; actual={k:socket.gethostbyname(k) for k in expected}; assert actual == expected, actual; print("CONTAINER_RESOLUTION_OK", actual)'
sudo docker run -d --name __CONTAINER__ --network host \
  --add-host master-1:10.20.1.10 \
  --add-host worker-2:10.20.2.10 \
  --add-host worker-3:10.20.3.10 \
  --add-host worker-4:10.20.4.10 \
  --add-host worker-5:10.20.5.10 \
  --add-host worker-6:10.20.6.10 \
  -e HADOOP_CONF_DIR=/etc/hadoop -e YARN_CONF_DIR=/etc/hadoop \
  -v /etc/hadoop:/etc/hadoop:ro -v __SAMPLE__:/opt/planetory/yarn-hdfs-sample.py:ro \
  --entrypoint /opt/spark/bin/spark-submit __IMAGE__ \
  --master yarn --deploy-mode cluster --name S15P21C206-73-hdfs-sample \
  --conf spark.driver.port=7078 --conf spark.blockManager.port=7079 \
  --conf spark.yarn.stagingDir=hdfs://planetory__BASE__/staging \
  --conf spark.executor.instances=5 --conf spark.executor.cores=1 \
  --conf spark.executor.memory=512m --conf spark.executor.memoryOverhead=512 \
  --conf spark.driver.memory=512m --conf spark.driver.memoryOverhead=512 \
  --conf spark.pyspark.python=/usr/bin/python3 \
  --conf spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3 \
  --conf spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3 \
  /opt/planetory/yarn-hdfs-sample.py hdfs://planetory__INPUT__ hdfs://planetory__OUTPUT__
echo SAMPLE_CONTAINER_STARTED=__CONTAINER__
'@.Replace('__RUN_ID__',$runId).Replace('__BASE__',$base).Replace('__INPUT__',$input).Replace('__OUTPUT__',$output).Replace('__IMAGE__',$sparkImage).Replace('__CONTAINER__',$container).Replace('__SAMPLE__',$remoteSample)
$null=Invoke-Remote $node1 $launch 'Prepare HDFS input and launch Spark sample'

$deadline=[datetime]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds,60))
$applicationId=$null
while ([datetime]::UtcNow -lt $deadline) {
 Start-Sleep -Seconds 2
 $logs=@(Invoke-Tailscale ssh $node1 "sudo docker logs $container 2>&1 || true")
 $match=[regex]::Matches(($logs -join "`n"),'application_[0-9]+_[0-9]+') | Select-Object -Last 1
 if ($match) { $applicationId=$match.Value; break }
}
if (-not $applicationId) {
 $logs=@(Invoke-Tailscale ssh $node1 "sudo docker logs $container 2>&1 || true")
 $null=Invoke-Tailscale ssh $node1 "sudo docker rm $container >/dev/null 2>&1 || true"
 throw "Spark submission did not produce an application ID within 60 seconds.`n$($logs -join "`n")"
}
Write-Host "APPLICATION_ID=$applicationId"

$yarn='sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn'
try {
 $placement=@'
set -eu
yarn_cmd() { sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn "$@"; }
for attempt in {1..120}; do
 yarn_cmd node -list -all > /tmp/__APP_ID__-nodes.txt 2>&1
 total=$(awk '$2 == "RUNNING" { sum += $4 } END { print sum + 0 }' /tmp/__APP_ID__-nodes.txt)
 node2=$(awk '$1 == "worker-2:8041" { print $4 + 0 }' /tmp/__APP_ID__-nodes.txt)
 test "$total" -ge 6 -a "$node2" -ge 1 && break
 sleep 1
done
test "$total" -ge 6
test "$node2" -ge 1
cat /tmp/__APP_ID__-nodes.txt
echo RUNNING_CONTAINERS="$total"
echo NODE2_RUNNING_CONTAINERS="$node2"
'@.Replace('__APP_ID__',$applicationId)
 $null=Invoke-Remote $node1 $placement 'Wait for AM, five executors and Node 2 placement'
 $null=Invoke-Remote $node1 ($yarn+' application -status '+$applicationId+'; '+$yarn+' node -list -all') 'Running application and node placement'
 $node2During=@'
set -eu
echo NODE2_DURING_APPLICATION
sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn node -status worker-2:8041
free -m
ps -C java -o pid=,rss=,args= | grep -E 'NameNode|DataNode|JournalNode|NodeManager|ApplicationMaster|CoarseGrainedExecutorBackend'
oom_log=$(sudo -n journalctl -k --since '__OOM_SINCE__' --no-pager) || { echo NODE2_OOM_AUDIT_FAILED >&2; exit 1; }
if printf '%s\n' "$oom_log" | grep -Ei 'out of memory|oom-kill|killed process'; then exit 1; fi
echo NODE2_NO_OOM_DURING_SAMPLE
'@.Replace('__OOM_SINCE__',$oomSince)
 $null=Invoke-Remote $node2 $node2During 'Node 2 memory during sample'

 $deadline=[datetime]::UtcNow.AddSeconds($TimeoutSeconds)
 while ([datetime]::UtcNow -lt $deadline) {
  $state=@(Invoke-Tailscale ssh $node1 "sudo docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' $container") | Select-Object -Last 1
  if ($state -match '^false\s+(\d+)$') {
   if ([int]$Matches[1] -ne 0) {
    $logs=@(Invoke-Tailscale ssh $node1 "sudo docker logs $container 2>&1")
    throw "Spark sample container failed with exit $($Matches[1]).`n$($logs -join "`n")"
   }
   break
  }
  Start-Sleep -Seconds 3
 }
 if ([datetime]::UtcNow -ge $deadline) { throw "Spark sample exceeded $TimeoutSeconds seconds." }
} catch {
 $failure=$_
 $cleanup=@(& tailscale ssh $node1 ($yarn+' application -kill '+$applicationId+' >/dev/null 2>&1 || true; sudo docker rm -f '+$container+' >/dev/null 2>&1 || true') 2>&1)
 if ($LASTEXITCODE -ne 0) { Write-Warning "Sample cleanup failed: $($cleanup -join "`n")" }
 throw $failure
}

$null=Invoke-Remote $node1 "sudo docker logs $container 2>&1; sudo docker rm $container >/dev/null" 'Spark submit log and container cleanup'
$verify=@'
set -eu
yarn_cmd() { sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn "$@"; }
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
yarn_cmd application -status __APP_ID__ | tee /tmp/__APP_ID__-status.txt
grep -Eq 'Final-State[[:space:]]*:[[:space:]]*SUCCEEDED' /tmp/__APP_ID__-status.txt
hdfs_cmd dfs -test -e __OUTPUT__/_SUCCESS
hdfs_cmd dfs -ls __OUTPUT__
hdfs_cmd dfs -cat '__OUTPUT__/part-*' | tee /tmp/__APP_ID__-output.txt
test "$(grep -c '^partition=' /tmp/__APP_ID__-output.txt)" = 5
for host in worker-2 worker-3 worker-4 worker-5 worker-6; do grep -q "host=$host," /tmp/__APP_ID__-output.txt; done
hdfs_cmd dfs -checksum '__OUTPUT__/part-*'
for attempt in 1 2 3 4 5; do
 if yarn_cmd logs -applicationId __APP_ID__ > /tmp/__APP_ID__-yarn.log 2>&1; then break; fi
 sleep 2
done
test -s /tmp/__APP_ID__-yarn.log
grep -E 'Container:|partition=|host=' /tmp/__APP_ID__-yarn.log | head -n 80 || true
wc -c /tmp/__APP_ID__-yarn.log
echo HDFS_INPUT=__INPUT__
echo HDFS_OUTPUT=__OUTPUT__
echo YARN_LOG_HDFS_ROOT=/yarn-logs
echo YARN_LOG_LOCAL=/tmp/__APP_ID__-yarn.log
echo SPARK_YARN_HDFS_SAMPLE_OK
'@.Replace('__APP_ID__',$applicationId).Replace('__INPUT__',$input).Replace('__OUTPUT__',$output)
$null=Invoke-Remote $node1 $verify 'Verify SUCCEEDED state, HDFS output, checksum and aggregated logs'
$node2After=@'
set -eu
__YARN__ node -status worker-2:8041
free -m
oom_log=$(sudo -n journalctl -k --since '__OOM_SINCE__' --no-pager) || { echo NODE2_OOM_AUDIT_FAILED >&2; exit 1; }
if printf '%s\n' "$oom_log" | grep -Ei 'out of memory|oom-kill|killed process'; then exit 1; fi
echo NODE2_NO_OOM_AFTER_SAMPLE
'@.Replace('__YARN__',$yarn).Replace('__OOM_SINCE__',$oomSince)
$null=Invoke-Remote $node2 $node2After 'Node 2 limit after sample'

Write-Host "PASS: APPLICATION_ID=$applicationId HDFS_OUTPUT=$output"
} finally {
 $cleanup=@(& tailscale ssh $node1 "rm -rf -- $remoteDir" 2>&1)
 if ($LASTEXITCODE -ne 0) { Write-Warning "Sample staging cleanup failed: $($cleanup -join "`n")" }
}

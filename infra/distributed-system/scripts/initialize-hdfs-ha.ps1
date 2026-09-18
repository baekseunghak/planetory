[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)]
 [ValidateSet('Preflight','NetworkDiagnostics','ConfigureFirewall','JournalNodes','FormatActive','StartFormattedActive','BootstrapStandby','DataNodes','Activate','ValidateRf2','FinalAudit')]
 [string]$Step,
 [switch]$ApproveFormat,
 [string]$AuditSinceUtc
)
$ErrorActionPreference='Stop'

if ($Step -eq 'FormatActive' -and -not $ApproveFormat) {
 throw 'FormatActive creates the new HDFS namespace. Re-run with -ApproveFormat after confirming Node 1 and Node 2 are empty.'
}
$auditSinceLog=''
if ($Step -eq 'FinalAudit') {
 if (-not $AuditSinceUtc) {
  throw 'FinalAudit requires -AuditSinceUtc in yyyy-MM-ddTHH:mm:ssZ format so historical errors are not reported as new.'
 }
 try {
  $style=[Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $parsed=[datetime]::ParseExact($AuditSinceUtc,'yyyy-MM-ddTHH:mm:ssZ',[Globalization.CultureInfo]::InvariantCulture,$style)
 } catch {
  throw 'AuditSinceUtc must use UTC yyyy-MM-ddTHH:mm:ssZ format.'
 }
 $auditSinceLog=$parsed.ToString('yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
}
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
 throw 'Install Tailscale CLI and join the project tailnet first.'
}

$nodes=@(
 [pscustomobject]@{Number=1;Target='SSAFY@node-1';HostName='master-1'},
 [pscustomobject]@{Number=2;Target='planetory-admin@node-2';HostName='worker-2'},
 [pscustomobject]@{Number=3;Target='planetory-admin@node-3';HostName='worker-3'},
 [pscustomobject]@{Number=4;Target='planetory-admin@node-4';HostName='worker-4'},
 [pscustomobject]@{Number=5;Target='planetory-admin@node-5';HostName='worker-5'},
 [pscustomobject]@{Number=6;Target='planetory-admin@node-6';HostName='worker-6'}
)
$hdfs='sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs'

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) {
  throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")"
 }
 $output
}

function Invoke-Remote {
 param([string]$Target,[string]$Command,[string]$Label)
 $Command=$Command.Replace("`r",'')
 Write-Host "== $Label =="
 $output=@(& tailscale ssh $Target $Command 2>&1)
 $exitCode=$LASTEXITCODE
 $output | ForEach-Object { Write-Host $_ }
 if ($exitCode -ne 0) { throw "$Label failed on $Target (exit $exitCode)." }
}

foreach ($node in $nodes) {
 $null=Invoke-Tailscale ping --timeout=5s "node-$($node.Number)"
 $actual=@(Invoke-Tailscale ssh $node.Target hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne $node.HostName) {
  throw "Node $($node.Number) target $($node.Target) must resolve to $($node.HostName)."
 }
}

$readOnlySteps=@('Preflight','NetworkDiagnostics','FinalAudit')
if ($Step -notin $readOnlySteps -and -not $PSCmdlet.ShouldProcess("Planetory HDFS cluster",$Step)) {
 return
}

switch ($Step) {
 'Preflight' {
  foreach ($node in $nodes) {
   $command='set -eu; echo HOST; hostname -s; sudo -n true; test "$(readlink -f /opt/hadoop)" = /opt/hadoop-3.5.0; /usr/lib/jvm/java-17-openjdk-amd64/bin/java -version 2>&1 | head -n 1; '+$hdfs+' version | head -n 1; mountpoint -q /mnt/data; findmnt -n -o TARGET,SOURCE,FSTYPE /mnt/data; '+$hdfs+' getconf -confKey dfs.replication; '+$hdfs+' getconf -confKey dfs.namenode.shared.edits.dir; systemctl list-unit-files "hadoop-hdfs-*.service" --no-legend; echo HDFS_PROCESSES; pgrep -u hdfs -af java || true; echo HDFS_PORTS; ss -lnt | grep -E ":(8020|8480|8485|9870|9864|9866|9867)[[:space:]]" || true'
   if ($node.Number -eq 2) { $command+='; mountpoint -q /mnt/metadata; findmnt -n -o TARGET,SOURCE,FSTYPE /mnt/metadata' }
   if ($node.Number -le 2) { $command+='; if sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION; then echo NAMENODE_FORMATTED; else echo NAMENODE_UNFORMATTED; fi' }
   Invoke-Remote $node.Target $command "Preflight Node $($node.Number)"
  }
 }
 'NetworkDiagnostics' {
  foreach ($node in $nodes[0..2]) {
   $command='set -u; echo HOST; hostname -s; echo RESOLUTION; getent ahostsv4 master-1 worker-2 worker-3; echo ROUTES; ip route get 10.20.1.10; ip route get 10.20.2.10; ip route get 10.20.3.10; echo JOURNALNODE; systemctl is-active hadoop-hdfs-journalnode || true; ss -lntp | grep -E ":(8480|8485) " || true; echo TCP_8485; for host in master-1 worker-2 worker-3; do if timeout 3 bash -c "</dev/tcp/$host/8485"; then echo TCP_8485_OK=$host; else echo TCP_8485_FAIL=$host; fi; done'
   if ($node.Number -le 2) {
    $command+='; echo TCP_8480; for host in master-1 worker-2 worker-3; do if timeout 3 bash -c "</dev/tcp/$host/8480"; then code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://$host:8480/"); case "$code" in 2*|3*) echo TCP_8480_HTTP_OK=$host:$code;; *) echo TCP_8480_HTTP_FAIL=$host:$code;; esac; else echo TCP_8480_FAIL=$host; fi; done'
   }
   $command+='; echo UFW; sudo ufw status verbose; echo NFT_FILTER; sudo nft list ruleset | grep -E "hook input|policy|8480|8485|10\.20\." || true'
   Invoke-Remote $node.Target $command "HDFS network diagnostics Node $($node.Number)"
  }
 }
 'ConfigureFirewall' {
  # Keep UFW default-deny; grant only the six fixed cluster IPs the ports used by this node's roles.
  foreach ($node in $nodes) {
   $ports=switch ($node.Number) {
    1 { '8020,8485,9870' }
    2 { '8020,8485,9870,9864,9866,9867' }
    3 { '8485,9864,9866,9867' }
    default { '9864,9866,9867' }
   }
   $command='set -eu; sudo ufw status verbose | grep -qE "^Status: active$"; sudo ufw status verbose | grep -qE "^Default: deny \(incoming\)"; for source in 10.20.1.10 10.20.2.10 10.20.3.10 10.20.4.10 10.20.5.10 10.20.6.10; do sudo ufw allow from "$source" to any port '+$ports+' proto tcp comment planetory-hdfs-private; done'
   if ($node.Number -le 3) {
    $command+='; for source in 10.20.1.10 10.20.2.10; do sudo ufw allow from "$source" to any port 8480 proto tcp comment planetory-hdfs-private; done'
   }
   $command+='; sudo ufw status verbose; echo HDFS_FIREWALL_OK'
   Invoke-Remote $node.Target $command "HDFS firewall Node $($node.Number) ports $ports"
  }
 }
 'JournalNodes' {
  foreach ($node in $nodes[0..2]) {
   $command='set -eu; sudo systemctl start hadoop-hdfs-journalnode; sleep 2; systemctl is-active --quiet hadoop-hdfs-journalnode; ss -lnt | grep -q ":8480 "; ss -lnt | grep -q ":8485 "; pgrep -u hdfs -f org.apache.hadoop.hdfs.qjournal.server.JournalNode >/dev/null; systemctl is-enabled hadoop-hdfs-journalnode || true; sudo journalctl -u hadoop-hdfs-journalnode -n 20 --no-pager; echo JOURNALNODE_OK'
   Invoke-Remote $node.Target $command "JournalNode Node $($node.Number)"
  }
  $command='set -eu; for host in master-1 worker-2 worker-3; do timeout 3 bash -c "</dev/tcp/$host/8485"; echo QJM_RPC_8485_OK=$host; timeout 3 bash -c "</dev/tcp/$host/8480"; code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://$host:8480/"); case "$code" in 2*|3*) echo QJM_HTTP_8480_OK=$host:$code;; *) echo QJM_HTTP_8480_FAIL=$host:$code; exit 1;; esac; done'
  Invoke-Remote $nodes[0].Target $command 'QJM connectivity from Node 1'
  Invoke-Remote $nodes[1].Target $command 'QJM connectivity from Node 2'
 }
 'FormatActive' {
  $command='set -eu; sudo test ! -f /var/lib/hadoop-hdfs/namenode/current/VERSION; ! systemctl is-active --quiet hadoop-hdfs-namenode; systemctl is-active --quiet hadoop-hdfs-journalnode; for host in master-1 worker-2 worker-3; do timeout 3 bash -c "</dev/tcp/$host/8485"; done; '+$hdfs+' namenode -format -nonInteractive planetory; sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION; sudo systemctl start hadoop-hdfs-namenode; sleep 3; systemctl is-active --quiet hadoop-hdfs-namenode; ss -lnt | grep -q ":8020 "; ss -lnt | grep -q ":9870 "; sudo journalctl -u hadoop-hdfs-namenode -n 25 --no-pager; echo ACTIVE_NAMENODE_FORMATTED_AND_STARTED'
  Invoke-Remote $nodes[0].Target $command 'Format and start Node 1 NameNode'
 }
 'StartFormattedActive' {
  # Recovery only: format can succeed before a later check fails, so resume without invoking format again.
  $command='set -eu; sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION; ! systemctl is-active --quiet hadoop-hdfs-namenode; systemctl is-active --quiet hadoop-hdfs-journalnode; for host in master-1 worker-2 worker-3; do timeout 3 bash -c "</dev/tcp/$host/8485"; done; sudo systemctl start hadoop-hdfs-namenode; sleep 3; systemctl is-active --quiet hadoop-hdfs-namenode; ss -lnt | grep -q ":8020 "; ss -lnt | grep -q ":9870 "; sudo journalctl -u hadoop-hdfs-namenode -n 25 --no-pager; echo FORMATTED_ACTIVE_NAMENODE_STARTED'
  Invoke-Remote $nodes[0].Target $command 'Resume Node 1 after successful format'
 }
 'BootstrapStandby' {
  Invoke-Remote $nodes[0].Target 'set -eu; sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION; systemctl is-active --quiet hadoop-hdfs-namenode; echo ACTIVE_NAMENODE_PREREQUISITE_OK' 'Node 1 prerequisite'
  $command='set -eu; sudo test ! -f /var/lib/hadoop-hdfs/namenode/current/VERSION; ! systemctl is-active --quiet hadoop-hdfs-namenode; systemctl is-active --quiet hadoop-hdfs-journalnode; '+$hdfs+' namenode -bootstrapStandby -nonInteractive; sudo test -f /var/lib/hadoop-hdfs/namenode/current/VERSION; sudo systemctl start hadoop-hdfs-namenode; sleep 3; systemctl is-active --quiet hadoop-hdfs-namenode; ss -lnt | grep -q ":8020 "; ss -lnt | grep -q ":9870 "; sudo journalctl -u hadoop-hdfs-namenode -n 25 --no-pager; echo STANDBY_NAMENODE_BOOTSTRAPPED_AND_STARTED'
  Invoke-Remote $nodes[1].Target $command 'Bootstrap and start Node 2 NameNode'
 }
 'DataNodes' {
  foreach ($node in $nodes[1..5]) {
   $command='set -eu; sudo systemctl start hadoop-hdfs-datanode; sleep 3; systemctl is-active --quiet hadoop-hdfs-datanode; ss -lnt | grep -q ":9866 "; pgrep -u hdfs -f org.apache.hadoop.hdfs.server.datanode.DataNode >/dev/null; sudo journalctl -u hadoop-hdfs-datanode -n 20 --no-pager; echo DATANODE_OK'
   Invoke-Remote $node.Target $command "DataNode Node $($node.Number)"
  }
 }
 'Activate' {
  $command='set -eu; timeout 300 '+$hdfs+' dfsadmin -fs hdfs://master-1:8020 -safemode wait; '+$hdfs+' haadmin -transitionToActive nn1; test "$('+$hdfs+' haadmin -getServiceState nn1)" = active; test "$('+$hdfs+' haadmin -getServiceState nn2)" = standby; '+$hdfs+' dfsadmin -report | tee /tmp/S15P21C206-72-dfsadmin-report.txt; grep -q "Live datanodes (5)" /tmp/S15P21C206-72-dfsadmin-report.txt; echo HA_ACTIVE_STANDBY_AND_FIVE_DATANODES_OK'
  Invoke-Remote $nodes[0].Target $command 'Activate Node 1 and verify HA'
 }
 'ValidateRf2' {
  $runId=Get-Date -Format 'yyyyMMddTHHmmss'
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
hdfs_cmd dfsadmin -report | tee /tmp/S15P21C206-72-dfsadmin-report.txt
grep -q "Live datanodes (5)" /tmp/S15P21C206-72-dfsadmin-report.txt
local_source=/tmp/S15P21C206-72-sample-__RUN_ID__.txt
local_copy=/tmp/S15P21C206-72-sample-__RUN_ID__.downloaded.txt
hdfs_path=/validation/S15P21C206-72/run-__RUN_ID__/sample.txt
printf "Planetory anonymous HDFS RF2 validation __RUN_ID__\n" > "$local_source"
source_sha=$(sha256sum "$local_source" | cut -d " " -f 1)
hdfs_cmd dfs -mkdir -p "$(dirname "$hdfs_path")"
hdfs_cmd dfs -put "$local_source" "$hdfs_path"
replication=$(hdfs_cmd dfs -stat %r "$hdfs_path")
test "$replication" = 2
hdfs_cmd dfs -checksum "$hdfs_path"
hdfs_cmd dfs -get "$hdfs_path" "$local_copy"
copy_sha=$(sha256sum "$local_copy" | cut -d " " -f 1)
test "$source_sha" = "$copy_sha"
fsck_out=/tmp/S15P21C206-72-fsck-__RUN_ID__.txt
hdfs_cmd fsck "$hdfs_path" -files -blocks -locations | tee "$fsck_out"
grep -q "Status: HEALTHY" "$fsck_out"
grep -q "Live_repl=2" "$fsck_out"
locations=$(grep -oE "(10\.20\.[2-6]\.10|worker-[2-6][^, ]*):[0-9]+" "$fsck_out" | sort -u | wc -l)
test "$locations" -ge 2
echo HDFS_PATH=$hdfs_path
echo SHA256=$source_sha
echo DISTINCT_BLOCK_LOCATIONS=$locations
echo RF2_WRITE_READ_CHECKSUM_OK
'@.Replace('__RUN_ID__',$runId)
  Invoke-Remote $nodes[0].Target $command 'RF2 write, read and checksum validation'
 }
 'FinalAudit' {
  foreach ($node in $nodes) {
   $services=if ($node.Number -eq 1) {
    'hadoop-hdfs-journalnode hadoop-hdfs-namenode'
   } elseif ($node.Number -eq 2) {
    'hadoop-hdfs-journalnode hadoop-hdfs-namenode hadoop-hdfs-datanode'
   } elseif ($node.Number -eq 3) {
    'hadoop-hdfs-journalnode hadoop-hdfs-datanode'
   } else {
    'hadoop-hdfs-datanode'
   }
   $command=@'
set -eu
for service in __SERVICES__; do
 systemctl is-active --quiet "$service"
 if systemctl is-failed --quiet "$service"; then exit 1; fi
 echo ACTIVE=$service
done
audit_since='__AUDIT_SINCE__'
cd /
set +e
log_files=$(sudo -u hdfs find /var/log/hadoop -maxdepth 1 -type f -name 'hadoop-hdfs-*.log' -print 2>/dev/null)
find_rc=$?
set -e
if test "$find_rc" -ne 0 -o -z "$log_files"; then
 echo HDFS_LOG_AUDIT_FAILED=list-or-read >&2
 exit 1
fi
set +e
error_count=$(sudo -u hdfs awk -v since="$audit_since" 'substr($0,1,19) >= since && $0 ~ / ERROR | FATAL / { count++ } END { print count + 0 }' $log_files 2>/dev/null)
awk_rc=$?
set -e
if test "$awk_rc" -ne 0 -o -z "$error_count"; then
 echo HDFS_LOG_AUDIT_FAILED=scan >&2
 exit 1
fi
if test "$error_count" -ne 0; then
 echo HDFS_LOG_ERRORS=$error_count SINCE_UTC="$audit_since" >&2
 exit 1
fi
echo HDFS_LOG_ERRORS=0 SINCE_UTC="$audit_since"
'@.Replace('__SERVICES__',$services).Replace('__AUDIT_SINCE__',$auditSinceLog)
   Invoke-Remote $node.Target $command "Final service and log audit Node $($node.Number)"
  }
  $journalCommand='set -eu; for host in master-1 worker-2 worker-3; do timeout 3 bash -c "</dev/tcp/$host/8485"; echo QJM_RPC_8485_OK=$host; timeout 3 bash -c "</dev/tcp/$host/8480"; code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://$host:8480/"); case "$code" in 2*|3*) echo QJM_HTTP_8480_OK=$host:$code;; *) echo QJM_HTTP_8480_FAIL=$host:$code; exit 1;; esac; done'
  Invoke-Remote $nodes[0].Target $journalCommand 'Final QJM path audit from Node 1'
  Invoke-Remote $nodes[1].Target $journalCommand 'Final QJM path audit from Node 2'
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd haadmin -getServiceState nn1)" = active
test "$(hdfs_cmd haadmin -getServiceState nn2)" = standby
for host in master-1 worker-2; do timeout 3 bash -c "</dev/tcp/$host/8020"; timeout 3 bash -c "</dev/tcp/$host/9870"; done
for host in worker-2 worker-3 worker-4 worker-5 worker-6; do timeout 3 bash -c "</dev/tcp/$host/9864"; timeout 3 bash -c "</dev/tcp/$host/9866"; timeout 3 bash -c "</dev/tcp/$host/9867"; done
hdfs_cmd dfsadmin -report | tee /tmp/S15P21C206-72-final-report.txt
grep -q "Live datanodes (5)" /tmp/S15P21C206-72-final-report.txt
grep -q "Under replicated blocks: 0" /tmp/S15P21C206-72-final-report.txt
grep -q "Blocks with corrupt replicas: 0" /tmp/S15P21C206-72-final-report.txt
grep -q "Missing blocks: 0" /tmp/S15P21C206-72-final-report.txt
hdfs_cmd fsck /validation/S15P21C206-72 -files -blocks -locations | tee /tmp/S15P21C206-72-final-fsck.txt
grep -q "Status: HEALTHY" /tmp/S15P21C206-72-final-fsck.txt
hdfs_cmd dfs -ls -R /validation/S15P21C206-72
echo FINAL_HDFS_AUDIT_OK
'@
  Invoke-Remote $nodes[0].Target $command 'Final cluster audit from Node 1'
 }
}

Write-Host "PASS: $Step"

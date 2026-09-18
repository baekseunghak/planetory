[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)]
 [ValidateSet('Preflight','ConfigureFirewall','Start','ValidateNodes','FinalAudit')]
 [string]$Step,
 [string]$AuditSinceUtc
)
$ErrorActionPreference='Stop'

$auditSinceLog=''
if ($Step -eq 'FinalAudit') {
 if (-not $AuditSinceUtc) { throw 'FinalAudit requires -AuditSinceUtc in yyyy-MM-ddTHH:mm:ssZ format.' }
 try {
  $style=[Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  $parsed=[datetime]::ParseExact($AuditSinceUtc,'yyyy-MM-ddTHH:mm:ssZ',[Globalization.CultureInfo]::InvariantCulture,$style)
 } catch { throw 'AuditSinceUtc must use UTC yyyy-MM-ddTHH:mm:ssZ format.' }
 $auditSinceLog=$parsed.ToString('yyyy-MM-dd HH:mm:ss',[Globalization.CultureInfo]::InvariantCulture)
}
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }

$nodes=@(
 [pscustomobject]@{Number=1;Target='SSAFY@node-1';HostName='master-1'},
 [pscustomobject]@{Number=2;Target='planetory-admin@node-2';HostName='worker-2'},
 [pscustomobject]@{Number=3;Target='planetory-admin@node-3';HostName='worker-3'},
 [pscustomobject]@{Number=4;Target='planetory-admin@node-4';HostName='worker-4'},
 [pscustomobject]@{Number=5;Target='planetory-admin@node-5';HostName='worker-5'},
 [pscustomobject]@{Number=6;Target='planetory-admin@node-6';HostName='worker-6'}
)
$yarn='sudo -u yarn env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/yarn'
$hdfs='sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs'

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

foreach ($node in $nodes) {
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false "node-$($node.Number)"
 $actual=@(Invoke-Tailscale ssh $node.Target hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne $node.HostName) {
  throw "Node $($node.Number) target $($node.Target) must resolve to $($node.HostName)."
 }
}

$readOnlySteps=@('Preflight','ValidateNodes','FinalAudit')
if ($Step -notin $readOnlySteps -and -not $PSCmdlet.ShouldProcess('Planetory YARN cluster',$Step)) { return }

switch ($Step) {
 'Preflight' {
  foreach ($node in $nodes) {
   $unit=if ($node.Number -eq 1) {'hadoop-yarn-resourcemanager'} else {'hadoop-yarn-nodemanager'}
   $command='set -eu; hostname -s; getent passwd yarn; test ! -e /var/lib/hadoop-yarn/.ssh; test -r /etc/hadoop/yarn-site.xml; test -r /etc/hadoop/capacity-scheduler.xml; test -r /etc/default/hadoop-yarn; systemctl show -p LoadState -p ActiveState '+$unit+'; '+$yarn+' version | head -n 1; grep -E "<name>yarn\.(resourcemanager|nodemanager|scheduler|log-aggregation)" /etc/hadoop/yarn-site.xml'
   if ($node.Number -eq 1) {
    $command+='; docker --version; docker compose version; systemctl is-active docker'
   } else {
    $command+='; python3 --version | grep -Eq "^Python 3[.]12[.][0-9]+$"; readlink -f /usr/bin/python3; stat -c "%n owner=%U group=%G mode=%a" /mnt/data/yarn/local /mnt/data/yarn/logs'
   }
   $null=Invoke-Remote $node.Target $command "YARN preflight Node $($node.Number)"
  }
 }
 'ConfigureFirewall' {
  foreach ($node in $nodes) {
   $ports=if ($node.Number -eq 1) {'8030,8031,8032,8033,8088'} else {'8040,8041,8042'}
   $command='set -eu; sudo ufw status verbose | grep -qE "^Status: active$"; sudo ufw status verbose | grep -qE "^Default: deny \(incoming\)"; for source in 10.20.1.10 10.20.2.10 10.20.3.10 10.20.4.10 10.20.5.10 10.20.6.10; do sudo ufw allow from "$source" to any port '+$ports+' proto tcp comment planetory-yarn-private; done; sudo ufw status verbose; echo YARN_FIREWALL_OK'
   if ($node.Number -ne 1) {
    $command+='; for source in 10.20.2.10 10.20.3.10 10.20.4.10 10.20.5.10 10.20.6.10; do sudo ufw allow from "$source" to any port 7078 proto tcp comment planetory-spark-private; sudo ufw allow from "$source" to any port 7079:7095 proto tcp comment planetory-spark-private; done; echo SPARK_FIREWALL_OK'
   }
   $null=Invoke-Remote $node.Target $command "YARN firewall Node $($node.Number) ports $ports"
  }
 }
 'Start' {
  $command='set -eu; systemctl is-active --quiet hadoop-hdfs-namenode; nn1_state=$('+$hdfs+' haadmin -getServiceState nn1); nn2_state=$('+$hdfs+' haadmin -getServiceState nn2); case "$nn1_state:$nn2_state" in active:standby|standby:active) ;; *) echo "INVALID_HDFS_HA_STATE=nn1:$nn1_state,nn2:$nn2_state" >&2; exit 1;; esac; if ! '+$hdfs+' dfs -test -d /yarn-logs; then '+$hdfs+' dfs -mkdir /yarn-logs; '+$hdfs+' dfs -chmod 1777 /yarn-logs; fi; sudo systemctl start hadoop-yarn-resourcemanager; for attempt in {1..30}; do ready=true; for port in 8030 8031 8032 8033 8088; do ss -lnt | grep -q ":$port " || ready=false; done; $ready && break; sleep 1; done; $ready; systemctl is-active --quiet hadoop-yarn-resourcemanager; sudo journalctl -u hadoop-yarn-resourcemanager -n 30 --no-pager; echo RESOURCEMANAGER_OK'
  $null=Invoke-Remote $nodes[0].Target $command 'Start ResourceManager on Node 1'
  foreach ($node in $nodes[1..5]) {
   $command='set -eu; systemctl is-active --quiet hadoop-hdfs-datanode; sudo systemctl start hadoop-yarn-nodemanager; for attempt in {1..30}; do ready=true; for port in 8040 8041 8042; do ss -lnt | grep -q ":$port " || ready=false; done; $ready && break; sleep 1; done; $ready; systemctl is-active --quiet hadoop-yarn-nodemanager; sudo journalctl -u hadoop-yarn-nodemanager -n 30 --no-pager; echo NODEMANAGER_OK'
   $null=Invoke-Remote $node.Target $command "Start NodeManager on Node $($node.Number)"
  }
 }
 'ValidateNodes' {
  $command='set -eu; '+$yarn+' node -list -all | tee /tmp/S15P21C206-73-yarn-nodes.txt; grep -Eq "Total Nodes:[[:space:]]*5" /tmp/S15P21C206-73-yarn-nodes.txt; test "$(awk ''$2 == "RUNNING" { count++ } END { print count + 0 }'' /tmp/S15P21C206-73-yarn-nodes.txt)" = 5; awk ''$2 == "RUNNING" { host=$1; sub(/:[0-9]+$/, "", host); print "YARN_HOST=" host }'' /tmp/S15P21C206-73-yarn-nodes.txt'
  $output=@(Invoke-Remote $nodes[0].Target $command 'List five RUNNING NodeManagers')
  $advertised=@($output | ForEach-Object { if ($_ -match '^YARN_HOST=(.+)$') { $Matches[1] } } | Sort-Object -Unique)
  if ($advertised.Count -ne 5) { throw "Expected five unique advertised YARN hosts, got $($advertised -join ', ')." }
  $hostArgs=$advertised -join ' '
  foreach ($node in $nodes) {
   $command='set -eu; for host in '+$hostArgs+'; do ip=$(getent ahostsv4 "$host" | awk ''NR == 1 { print $1 }''); case "$ip" in 10.20.2.10|10.20.3.10|10.20.4.10|10.20.5.10|10.20.6.10) echo YARN_RESOLUTION_OK="$host:$ip";; *) echo YARN_RESOLUTION_FAIL="$host:$ip" >&2; exit 1;; esac; done'
   $null=Invoke-Remote $node.Target $command "Resolve advertised YARN hosts from Node $($node.Number)"
  }
 }
 'FinalAudit' {
  foreach ($node in $nodes) {
   $unit=if ($node.Number -eq 1) {'hadoop-yarn-resourcemanager'} else {'hadoop-yarn-nodemanager'}
   $command=@'
set -eu
systemctl is-active --quiet __UNIT__
if systemctl is-failed --quiet __UNIT__; then exit 1; fi
audit_since='__AUDIT_SINCE__'
cd /
set +e
log_files=$(sudo -u yarn find /var/log/hadoop-yarn -maxdepth 1 -type f \( -name 'hadoop-yarn-*.log' -o -name 'hadoop-yarn-*.log.[0-9]*' \) -print 2>/dev/null)
find_rc=$?
set -e
if test "$find_rc" -ne 0 -o -z "$log_files"; then echo YARN_LOG_AUDIT_FAILED=list-or-read >&2; exit 1; fi
set +e
error_count=$(sudo -u yarn awk -v since="$audit_since" 'substr($0,1,19) >= since && $0 ~ / ERROR | FATAL / { count++ } END { print count + 0 }' $log_files 2>/dev/null)
awk_rc=$?
set -e
if test "$awk_rc" -ne 0 -o -z "$error_count"; then echo YARN_LOG_AUDIT_FAILED=scan >&2; exit 1; fi
test "$error_count" = 0 || { echo YARN_LOG_ERRORS="$error_count" SINCE_UTC="$audit_since" >&2; exit 1; }
echo ACTIVE=__UNIT__
echo YARN_LOG_ERRORS=0 SINCE_UTC="$audit_since"
'@.Replace('__UNIT__',$unit).Replace('__AUDIT_SINCE__',$auditSinceLog)
   $null=Invoke-Remote $node.Target $command "YARN service and log audit Node $($node.Number)"
  }
  $command='set -eu; '+$yarn+' node -list -all | tee /tmp/S15P21C206-73-final-nodes.txt; grep -Eq "Total Nodes:[[:space:]]*5" /tmp/S15P21C206-73-final-nodes.txt; test "$(awk ''$2 == "RUNNING" { count++ } END { print count + 0 }'' /tmp/S15P21C206-73-final-nodes.txt)" = 5; '+$hdfs+' dfsadmin -report | grep -q "Live datanodes (5)"; nn1_state=$('+$hdfs+' haadmin -getServiceState nn1); nn2_state=$('+$hdfs+' haadmin -getServiceState nn2); case "$nn1_state:$nn2_state" in active:standby|standby:active) ;; *) echo "INVALID_HDFS_HA_STATE=nn1:$nn1_state,nn2:$nn2_state" >&2; exit 1;; esac; echo FINAL_YARN_HDFS_AUDIT_OK'
  $null=Invoke-Remote $nodes[0].Target $command 'Final cluster audit from Node 1'
  $null=Invoke-Remote $nodes[1].Target ('set -eu; '+$yarn+' node -status worker-2:8041; free -m; ps -C java -o pid=,rss=,args= | grep -E "NameNode|DataNode|JournalNode|NodeManager"') 'Node 2 resource audit'
 }
}

Write-Host "PASS: $Step"

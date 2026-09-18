# Offline regression check: tailscale is mocked; no remote resources are touched.
$ErrorActionPreference='Stop'
$testState=@{Calls=[Collections.Generic.List[string]]::new()}

function tailscale {
 $testState.Calls.Add("tailscale $($args -join ' ')")
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  $node=[int](($args[1] -split 'node-')[-1])
  if ($node -eq 1) { return 'master-1' }
  return "worker-$node"
 }
}

$script=Join-Path $PSScriptRoot 'initialize-hdfs-ha.ps1'

& $script -Step Preflight
if (@($testState.Calls | Where-Object { $_ -match 'systemctl start|namenode -format|bootstrapStandby|transitionToActive|dfs -put' }).Count) {
 throw 'Preflight must not mutate the cluster.'
}

$testState.Calls.Clear()
& $script -Step NetworkDiagnostics
if (@($testState.Calls | Where-Object { $_ -match 'systemctl start|namenode -format|bootstrapStandby|transitionToActive|dfs -put|ufw allow' }).Count -or
    @($testState.Calls | Where-Object { $_ -match 'TCP_8485' }).Count -ne 3 -or
    @($testState.Calls | Where-Object { $_ -match 'TCP_8480' }).Count -ne 2) {
 throw 'NetworkDiagnostics must be read-only.'
}

$testState.Calls.Clear()
& $script -Step ConfigureFirewall -Confirm:$false
$firewallCalls=@($testState.Calls | Where-Object { $_ -match 'ufw allow' })
if ($firewallCalls.Count -ne 6 -or
    @($firewallCalls | Where-Object { $_ -notmatch '10\.20\.1\.10 10\.20\.2\.10 10\.20\.3\.10 10\.20\.4\.10 10\.20\.5\.10 10\.20\.6\.10' }).Count -or
    @($firewallCalls | Where-Object { -not $_.Contains('Default: deny \(incoming\)') }).Count -or
    @($firewallCalls | Where-Object { $_ -match 'port 8480' }).Count -ne 3 -or
    @($firewallCalls | Where-Object { $_ -match 'port 8480' -and $_ -notmatch 'for source in 10\.20\.1\.10 10\.20\.2\.10' }).Count -or
    @($testState.Calls | Where-Object { $_ -match 'ufw disable|ufw reset|delete allow|namenode -format' }).Count) {
 throw 'ConfigureFirewall must add role ports for six fixed IPs and JN HTTP only for both NameNodes.'
}

$testState.Calls.Clear()
& $script -Step JournalNodes -Confirm:$false
if (@($testState.Calls | Where-Object { $_ -match 'systemctl start hadoop-hdfs-journalnode' }).Count -ne 3 -or
    @($testState.Calls | Where-Object { $_ -match 'ss -lnt.*8480' }).Count -ne 3 -or
    @($testState.Calls | Where-Object { $_ -match 'QJM_HTTP_8480_OK' }).Count -ne 2 -or
    @($testState.Calls | Where-Object { $_ -match 'namenode -format|bootstrapStandby|datanode|transitionToActive|dfs -put' }).Count) {
 throw 'JournalNodes must start and verify only the three JournalNodes.'
}

$testState.Calls.Clear()
$failure=''
try { & $script -Step FormatActive -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*-ApproveFormat*' -or $testState.Calls.Count) {
 throw 'FormatActive must require explicit format approval before any remote call.'
}

$testState.Calls.Clear()
& $script -Step FormatActive -ApproveFormat -WhatIf
if (@($testState.Calls | Where-Object { $_ -match 'namenode -format' }).Count) {
 throw 'WhatIf must not format the NameNode.'
}

$testState.Calls.Clear()
& $script -Step FormatActive -ApproveFormat -Confirm:$false
$formatCalls=@($testState.Calls | Where-Object { $_ -match 'namenode -format' })
if ($formatCalls.Count -ne 1 -or $formatCalls[0] -notmatch '-nonInteractive' -or $formatCalls[0] -match ' -force') {
 throw 'FormatActive must format once, non-interactively, without force.'
}

$testState.Calls.Clear()
& $script -Step StartFormattedActive -Confirm:$false
if (@($testState.Calls | Where-Object { $_ -match 'namenode -format' }).Count -or
    @($testState.Calls | Where-Object { $_ -match 'systemctl start hadoop-hdfs-namenode' }).Count -ne 1) {
 throw 'StartFormattedActive must resume a formatted Node 1 without formatting it again.'
}

$testState.Calls.Clear()
& $script -Step ValidateRf2 -Confirm:$false
if (@($testState.Calls | Where-Object { $_ -match 'dfs -put' }).Count -ne 1 -or
    @($testState.Calls | Where-Object { $_ -match 'dfs -checksum' }).Count -ne 1 -or
    @($testState.Calls | Where-Object { $_ -match 'fsck.*-locations' }).Count -ne 1) {
 throw 'ValidateRf2 must write, checksum and inspect block locations.'
}

$testState.Calls.Clear()
$failure=''
try { & $script -Step FinalAudit } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*-AuditSinceUtc*' -or $testState.Calls.Count) {
 throw 'FinalAudit must require a UTC audit start before any remote call.'
}

$testState.Calls.Clear()
& $script -Step FinalAudit -AuditSinceUtc '2026-09-17T08:00:00Z'
$logAuditCalls=@($testState.Calls | Where-Object { $_ -match 'HDFS_LOG_AUDIT_FAILED' })
if (@($testState.Calls | Where-Object { $_ -match 'systemctl start|namenode -format|bootstrapStandby|transitionToActive|dfs -put|ufw allow' }).Count -or
    $logAuditCalls.Count -ne 6 -or
    @($logAuditCalls | Where-Object { $_ -notmatch 'cd /' -or
                                      $_ -notmatch 'sudo -u hdfs find' -or
                                      $_ -notmatch 'find_rc.*-ne 0' -or
                                      $_ -notmatch 'awk -v since' -or
                                      $_ -notmatch 'awk_rc.*-ne 0' -or
                                      $_ -notmatch 'error_count.*-ne 0' -or
                                      $_ -match '\|\| true' }).Count -or
    @($testState.Calls | Where-Object { $_ -match 'QJM_HTTP_8480_OK' }).Count -ne 2 -or
    @($testState.Calls | Where-Object { $_ -match 'fsck /validation/S15P21C206-72' }).Count -ne 1) {
 throw 'FinalAudit must be read-only and verify the completed validation path.'
}
if (@($testState.Calls | Where-Object { $_ -match "`r" }).Count) {
 throw 'Remote HDFS commands must normalize Windows CRLF before Bash execution.'
}

Write-Host 'PASS: staged preflight, firewall, format recovery, RF2 and final-audit contracts (offline).'

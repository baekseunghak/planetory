# Offline regression check: tailscale and scp are mocked; no remote resources are touched.
$ErrorActionPreference='Stop'
$yarnTestState=@{Calls=[Collections.Generic.List[string]]::new();BadNode=0}

function tailscale {
 $recorded="tailscale $($args -join ' ')"
 if ($args[0] -eq 'ssh' -and $args.Count -ge 3 -and $args[2] -match "^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 --decode \| bash$") {
  $decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1]))
  $recorded="tailscale ssh $($args[1]) $decoded"
 }
 $yarnTestState.Calls.Add($recorded)
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  $node=[int](($args[1] -split 'node-')[-1])
  if ($yarnTestState.BadNode -eq $node) { return 'wrong-host' }
  if ($node -eq 1) { return 'master-1' }
  return "worker-$node"
 }
 return 'mock-remote-ok'
}

function scp {
 $yarnTestState.Calls.Add("scp $($args -join ' ')")
 $global:LASTEXITCODE=0
}

$install=Join-Path $PSScriptRoot 'install-yarn-hosts.ps1'
$initialize=Join-Path $PSScriptRoot 'initialize-yarn-cluster.ps1'
$sample=Join-Path $PSScriptRoot 'run-yarn-sample.ps1'

& $install -WhatIf
if (@($yarnTestState.Calls | Where-Object { $_ -like 'scp *' -or $_ -match '/tmp/planetory-yarn-install|sudo bash' }).Count) {
 throw 'Install WhatIf must run only tailnet and hostname preflight.'
}

$yarnTestState.Calls.Clear()
& $install -Confirm:$false
if (@($yarnTestState.Calls | Where-Object { $_ -like 'scp *SSAFY@node-1:/tmp/planetory-yarn-install-*/*' }).Count -ne 1 -or
    @($yarnTestState.Calls | Where-Object { $_ -like 'tailscale ssh SSAFY@node-1 sudo bash*/install-yarn-host.sh --node 1*' }).Count -ne 1) {
 throw 'Node 1 YARN upload or install command is incorrect.'
}

$yarnTestState.Calls.Clear()
$failure=''
try { & $install -NodeNumbers 1,2 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*Install Node 1 alone*' -or $yarnTestState.Calls.Count) {
 throw 'Node 1 must be a standalone YARN and Docker canary.'
}

$yarnTestState.Calls.Clear()
$yarnTestState.BadNode=4
$failure=''
try { & $install -NodeNumbers 2,3,4 -Confirm:$false } catch { $failure=$_.Exception.Message }
if ($failure -notlike '*No install commands were run*' -or
    @($yarnTestState.Calls | Where-Object { $_ -like 'scp *' -or $_ -match '/tmp/planetory-yarn-install|sudo bash' }).Count) {
 throw 'Every selected YARN target must pass before the first mutation.'
}
$yarnTestState.BadNode=0

$yarnTestState.Calls.Clear()
& $initialize -Step Preflight
if (@($yarnTestState.Calls | Where-Object { $_ -match 'systemctl start|ufw allow|docker pull|dfs -put' }).Count) {
 throw 'YARN Preflight must be read-only.'
}
$pythonChecks=@($yarnTestState.Calls | Where-Object { $_.Contains('python3 --version | grep -Eq "^Python 3[.]12[.][0-9]+$"') })
if ($pythonChecks.Count -ne 5 -or @($yarnTestState.Calls | Where-Object { $_.Contains('Python 3.12.3') }).Count) {
 throw 'YARN Preflight must accept every Python 3.12 patch version on the five Workers.'
}
$clockChecks=@($yarnTestState.Calls | Where-Object {
 $_.Contains('test "$(timedatectl show -p NTPSynchronized --value)" = yes') -and
 $_.Contains('test "$(timedatectl show -p Timezone --value)" = Etc/UTC')
})
if ($clockChecks.Count -ne 6) { throw 'YARN Preflight must require synchronized UTC clocks on all six nodes.' }

$yarnTestState.Calls.Clear()
& $initialize -Step ConfigureFirewall -Confirm:$false
$firewall=@($yarnTestState.Calls | Where-Object { $_ -match 'ufw allow' })
if ($firewall.Count -ne 6 -or
    @($firewall | Where-Object { $_ -notmatch '10\.20\.1\.10 10\.20\.2\.10 10\.20\.3\.10 10\.20\.4\.10 10\.20\.5\.10 10\.20\.6\.10' }).Count -or
    @($firewall | Where-Object { -not $_.Contains('Default: deny \(incoming\)') }).Count -or
    @($firewall | Where-Object { $_ -match 'ufw disable|ufw reset' }).Count) {
 throw 'YARN firewall must add only role ports for the six fixed private IPs.'
}

$yarnTestState.Calls.Clear()
& $initialize -Step Start -Confirm:$false
if (@($yarnTestState.Calls | Where-Object { $_ -match 'systemctl start hadoop-yarn-resourcemanager' }).Count -ne 1 -or
    @($yarnTestState.Calls | Where-Object { $_ -match 'systemctl start hadoop-yarn-nodemanager' }).Count -ne 5 -or
    @($yarnTestState.Calls | Where-Object { $_ -match 'systemctl enable|namenode -format|dfs -rm' }).Count) {
 throw 'Start must start one ResourceManager and five NodeManagers without enabling or initializing storage.'
}

$yarnTestState.Calls.Clear()
& $sample -WhatIf
if (@($yarnTestState.Calls | Where-Object { $_ -like 'scp *' -or $_ -match 'docker pull|docker run|dfs -put' }).Count) {
 throw 'Sample WhatIf must stop before upload, HDFS write, image pull or container start.'
}

Write-Host 'PASS: YARN canary, all-node preflight, firewall, staged start and sample WhatIf (offline).'

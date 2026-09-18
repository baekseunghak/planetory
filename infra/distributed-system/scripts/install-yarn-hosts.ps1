[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [ValidateCount(1,5)][ValidateRange(1,6)][int[]]$NodeNumbers=@(1)
)
$ErrorActionPreference='Stop'

if (@($NodeNumbers | Select-Object -Unique).Count -ne $NodeNumbers.Count) { throw 'NodeNumbers must not contain duplicates.' }
if (1 -in $NodeNumbers -and $NodeNumbers.Count -ne 1) { throw 'Install Node 1 alone, verify Docker and ResourceManager files, then run Node 2~6.' }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { throw 'Install an OpenSSH client with scp first.' }

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 if ($LASTEXITCODE -ne 0) { throw "tailscale failed: $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Invoke-Scp {
 $output=@(& scp @args 2>&1)
 if ($LASTEXITCODE -ne 0) { throw "scp failed: $($args -join ' ')`n$($output -join "`n")" }
 $output
}

$configDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../config/yarn'))
$installer=Join-Path $PSScriptRoot 'install-yarn-host.sh'
$bundle=@(
 $installer,
 (Join-Path $configDir 'worker.xml'),
 (Join-Path $configDir 'standby-worker.xml'),
 (Join-Path $configDir 'capacity-scheduler.xml')
)
foreach ($file in $bundle) {
 if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing install input: $file" }
}

$nodes=@()
foreach ($node in @($NodeNumbers | Sort-Object)) {
 $tailHost="node-$node"
 $user=if ($node -eq 1) {'SSAFY'} else {'planetory-admin'}
 $expectedHost=if ($node -eq 1) {'master-1'} else {"worker-$node"}
 $sshTarget="$user@$tailHost"
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false $tailHost
 $hostname=@(Invoke-Tailscale ssh $sshTarget hostname -s) | Select-Object -Last 1
 if (-not $hostname -or $hostname.Trim() -ne $expectedHost) {
  throw "Node $node tailnet target $sshTarget must resolve to $expectedHost. No install commands were run."
 }
 $nodes+=[pscustomobject]@{Node=$node;SshTarget=$sshTarget;ExpectedHost=$expectedHost}
}

$remoteDir="/tmp/planetory-yarn-install-$PID"
foreach ($target in $nodes) {
 $description='install repository-managed YARN files without starting YARN; Node 1 also installs Ubuntu Docker'
 if (-not $PSCmdlet.ShouldProcess("Node $($target.Node) $($target.SshTarget)",$description)) { continue }
 try {
  Invoke-Tailscale ssh $target.SshTarget "install -d -m 700 $remoteDir"
  $scpArgs=@('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes')+$bundle+"$($target.SshTarget):$remoteDir/"
  Invoke-Scp @scpArgs
  Invoke-Tailscale ssh $target.SshTarget "sudo bash $remoteDir/install-yarn-host.sh --node $($target.Node) --source-dir $remoteDir"
  Write-Host "Node $($target.Node) YARN preparation passed: $($target.ExpectedHost)"
 } finally {
  $cleanup=@(& tailscale ssh $target.SshTarget "rm -rf -- $remoteDir" 2>&1)
  if ($LASTEXITCODE -ne 0) { Write-Warning "YARN install staging cleanup failed: $($cleanup -join "`n")" }
 }
}

Write-Host 'Finished. YARN daemons were not enabled or started.'

[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [ValidateCount(1,5)][ValidateRange(1,6)][int[]]$NodeNumbers=@(1)
)
$ErrorActionPreference='Stop'

if (@($NodeNumbers | Select-Object -Unique).Count -ne $NodeNumbers.Count) { throw 'NodeNumbers must not contain duplicates.' }
if (1 -in $NodeNumbers -and $NodeNumbers.Count -ne 1) { throw 'Install Node 1 alone, verify it, then run Node 2~6 separately.' }
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { throw 'Install an OpenSSH client with scp first.' }

function Invoke-Tailscale {
 $output=& tailscale @args
 if ($LASTEXITCODE -ne 0) { throw "tailscale failed: $($args -join ' ')" }
 $output
}

function Invoke-Scp {
 $output=& scp @args
 if ($LASTEXITCODE -ne 0) { throw "scp failed: $($args -join ' ')" }
 $output
}

$configDir=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../config/hadoop'))
$installer=Join-Path $PSScriptRoot 'install-hdfs-host.sh'
$bundle=@(
 $installer,
 (Join-Path $configDir 'core-site.xml'),
 (Join-Path $configDir 'hdfs-site.xml'),
 (Join-Path $configDir 'workers')
)
foreach ($file in $bundle) {
 if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing install input: $file" }
}

# Verify every selected tailnet target before the first mutation.
$nodes=@()
foreach ($node in @($NodeNumbers | Sort-Object)) {
 $tailHost="node-$node"
 $user=if ($node -eq 1) {'SSAFY'} else {'planetory-admin'}
 $expectedHost=if ($node -eq 1) {'master-1'} else {"worker-$node"}
 $sshTarget="$user@$tailHost"
 $null=Invoke-Tailscale ping --timeout=5s $tailHost
 $hostname=@(Invoke-Tailscale ssh $sshTarget hostname -s) | Select-Object -Last 1
 if (-not $hostname -or $hostname.Trim() -ne $expectedHost) {
  throw "Node $node tailnet target $sshTarget must resolve to $expectedHost. No install commands were run."
 }
 $nodes+=[pscustomobject]@{Node=$node;SshTarget=$sshTarget;ExpectedHost=$expectedHost}
}

$remoteDir='/tmp/planetory-hdfs-install'
foreach ($target in $nodes) {
 $description='upload verified installer and prepare Hadoop HDFS without starting or formatting it'
 if (-not $PSCmdlet.ShouldProcess("Node $($target.Node) $($target.SshTarget)",$description)) { continue }
 Invoke-Tailscale ssh $target.SshTarget "install -d -m 700 $remoteDir"
 Invoke-Scp @bundle "$($target.SshTarget):$remoteDir/"
 Invoke-Tailscale ssh $target.SshTarget "sudo bash $remoteDir/install-hdfs-host.sh --node $($target.Node) --source-dir $remoteDir"
 Write-Host "Node $($target.Node) install preparation passed over tailnet: $($target.ExpectedHost)"
}

Write-Host 'Finished. No HDFS daemon was enabled, started, formatted or bootstrapped.'

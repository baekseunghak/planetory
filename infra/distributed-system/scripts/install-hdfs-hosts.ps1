[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)][ValidateCount(6,6)][string[]]$Projects,
 [ValidateCount(1,5)][ValidateRange(1,6)][int[]]$NodeNumbers=@(1),
 [ValidatePattern('^[a-z]+-[a-z]+[0-9]+-[a-z]$')][string]$Zone='asia-east1-b'
)
$ErrorActionPreference='Stop'

if (@($Projects | Select-Object -Unique).Count -ne 6) { throw 'Projects must contain six distinct project IDs in Node 1~6 order.' }
foreach ($project in $Projects) {
 if ($project -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$') { throw "Invalid project ID: $project" }
}
if (@($NodeNumbers | Select-Object -Unique).Count -ne $NodeNumbers.Count) { throw 'NodeNumbers must not contain duplicates.' }
if (1 -in $NodeNumbers -and $NodeNumbers.Count -ne 1) { throw 'Install Node 1 alone, verify it, then run Node 2~6 separately.' }
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) { throw 'Install Google Cloud CLI first.' }

function Invoke-Gcloud {
 $output=& gcloud @args
 if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
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

$nodes=@()
foreach ($node in @($NodeNumbers | Sort-Object)) {
 $project=$Projects[$node-1]
 $vm=if ($node -eq 1) {'master-1'} else {"worker-$node"}
 $raw=Invoke-Gcloud compute instances describe $vm "--project=$project" "--zone=$Zone" --format=json
 $instance=($raw -join "`n") | ConvertFrom-Json
 $expectedIp="10.20.$node.10"
 if ($instance.name -ne $vm -or $instance.status -ne 'RUNNING' -or $instance.networkInterfaces[0].networkIP -ne $expectedIp) {
  throw "Node $node must be RUNNING as $vm/$expectedIp in project $project. No install commands were run."
 }
 $nodes+=[pscustomobject]@{Node=$node;Project=$project;Vm=$vm}
}

$remoteDir='/tmp/planetory-hdfs-install'
foreach ($target in $nodes) {
 $description="upload verified installer and prepare Hadoop HDFS without starting or formatting it"
 if (-not $PSCmdlet.ShouldProcess("Node $($target.Node) $($target.Vm) in $($target.Project)",$description)) { continue }
 Invoke-Gcloud compute ssh $target.Vm "--project=$($target.Project)" "--zone=$Zone" "--command=install -d -m 700 $remoteDir"
 Invoke-Gcloud compute scp @bundle "$($target.Vm):$remoteDir/" "--project=$($target.Project)" "--zone=$Zone"
 Invoke-Gcloud compute ssh $target.Vm "--project=$($target.Project)" "--zone=$Zone" "--command=sudo bash $remoteDir/install-hdfs-host.sh --node $($target.Node) --source-dir $remoteDir"
 Write-Host "Node $($target.Node) install preparation passed: $($target.Vm)"
}

Write-Host 'Finished. No HDFS daemon was enabled, started, formatted or bootstrapped.'

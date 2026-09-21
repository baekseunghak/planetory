[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Install', 'Preflight', 'Canary', 'Start', 'Retry', 'Status')]
    [string]$Step,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$CodeReleaseId,

    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$RunId = ([datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')),

    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$UnitId,

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$PipelineVersion,

    [ValidateRange(1, [long]::MaxValue)]
    [long[]]$TicId,

    [ValidatePattern('^/lake/silver/pipeline_version=[A-Za-z0-9._-]+/run_id=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z$')]
    [string]$RetryFrom,

    [ValidatePattern('^/lake/bronze/tess/coverage=[0-9a-f]{64}$')]
    [string]$BronzeCoverage = '/lake/bronze/tess/coverage=df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94',

    [ValidateRange(1, 500)]
    [int]$ShufflePartitions = 200,

    [ValidateRange(1, 200)]
    [int]$OutputPartitions = 80
)

$ErrorActionPreference = 'Stop'
$node1 = 'SSAFY@node-1'
$releaseRoot = '/opt/planetory-silver/releases'
$release = "$releaseRoot/$CodeReleaseId"
if (-not $UnitId) { $UnitId = $RunId }
$unit = "planetory-tess-silver-$UnitId.service"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $PipelineVersion) { $PipelineVersion = "S15P21C206-78-$CodeReleaseId" }

function Invoke-Tailscale {
    $output = @(& tailscale @args 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
    $output
}

function Invoke-Remote {
    param([string]$Command, [string]$Label, [switch]$Sudo)
    Write-Host "== $Label =="
    $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command.Replace("`r", '')))
    $shell = if ($Sudo) { 'sudo -n bash' } else { 'bash' }
    $output = @(& tailscale ssh $node1 "printf '%s' '$payload' | base64 --decode | $shell" 2>&1)
    $exitCode = $LASTEXITCODE
    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) { throw "$Label failed (exit $exitCode)." }
    $output
}

function Assert-LocalTools {
    foreach ($name in @('tailscale', 'scp', 'tar', 'python')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing local command: $name" }
    }
    $null = Invoke-Tailscale ping --timeout=5s --until-direct=false node-1
    $actual = @(Invoke-Tailscale ssh $node1 hostname -s) | Select-Object -Last 1
    if (-not $actual -or $actual.Trim() -ne 'master-1') { throw 'node-1 must resolve to master-1.' }
}

function Install-SilverUnit {
    param([string]$Exec, [string]$Description)
    $unitText = @"
[Unit]
Description=$Description
After=network-online.target hadoop-hdfs-namenode.service hadoop-yarn-resourcemanager.service docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$release
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=$Exec
ExecStartPost=-/usr/bin/systemctl disable %n
ExecStopPost=-/bin/sh -c 'if [ "`$EXIT_CODE" = "exited" ] && [ "`$EXIT_STATUS" = "65" ]; then /usr/bin/systemctl disable "%n"; fi'
TimeoutStartSec=infinity
Restart=on-failure
RestartPreventExitStatus=65
RestartSec=5min
UMask=0027

[Install]
WantedBy=multi-user.target
"@
    $unitPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unitText.Replace("`r", '')))
    $start = @'
set -eu
release='__RELEASE__'
unit='__UNIT__'
test -f "$release/spark/tess_silver_ctl.py"
candidate=$(mktemp /run/planetory-silver-unit.XXXXXX)
trap 'rm -f -- "$candidate"' EXIT
printf '%s' '__UNIT_PAYLOAD__' | base64 --decode > "$candidate"
if [ -e "/etc/systemd/system/$unit" ]; then
  cmp -s "$candidate" "/etc/systemd/system/$unit" || { echo UNIT_DEFINITION_MISMATCH >&2; exit 1; }
else
  install -o root -g root -m 0644 "$candidate" "/etc/systemd/system/$unit"
  systemctl daemon-reload
  systemctl enable "$unit"
fi
if systemctl is-active --quiet "$unit"; then
  echo SILVER_UNIT_ALREADY_ACTIVE="$unit"
  exit 0
fi
started=$(systemctl show "$unit" -p ExecMainStartTimestampMonotonic --value)
if [ "$started" != 0 ] && [ "$(systemctl show "$unit" -p Result --value)" = success ]; then
  echo SILVER_UNIT_ALREADY_COMPLETE="$unit"
  exit 0
fi
systemctl reset-failed "$unit" || true
systemctl --no-block start "$unit"
echo SILVER_UNIT_STARTED="$unit"
'@.Replace('__RELEASE__', $release).Replace('__UNIT__', $unit).Replace('__UNIT_PAYLOAD__', $unitPayload)
    $null = Invoke-Remote $start 'Start autonomous Silver processing' -Sudo
}

Assert-LocalTools

if ($Step -eq 'Install') {
    if (-not $PSCmdlet.ShouldProcess($release, 'Install immutable Silver release on Node 1')) { return }
    & (Join-Path $PSScriptRoot 'test-tess-silver.ps1')
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "planetory-silver-$CodeReleaseId-$PID"
    $archive = "$tempRoot.tar.gz"
    try {
        $null = New-Item -ItemType Directory -Path (Join-Path $tempRoot 'spark') -Force
        $null = New-Item -ItemType Directory -Path (Join-Path $tempRoot 'astro_kernel') -Force
        foreach ($name in @('requirements.txt', 'tess_bronze_ctl.py', 'tess_silver.py', 'tess_silver_ctl.py')) {
            Copy-Item -LiteralPath (Join-Path $repoRoot "distributed-system\spark\$name") -Destination (Join-Path $tempRoot "spark\$name")
        }
        Copy-Item -Path (Join-Path $repoRoot 'libs\astro-kernel\astro_kernel\*.py') -Destination (Join-Path $tempRoot 'astro_kernel')
        Copy-Item -LiteralPath (Join-Path $repoRoot 'distributed-system\ingestion\hdfs\TessSequenceFileTool.java') -Destination $tempRoot
        & tar -czf $archive -C $tempRoot .
        if ($LASTEXITCODE -ne 0) { throw 'Failed to build Silver release archive.' }
        $archiveSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        $remoteArchive = "/tmp/planetory-silver-$CodeReleaseId.tar.gz"
        & scp -o BatchMode=yes -o StrictHostKeyChecking=yes $archive "${node1}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Failed to upload Silver release archive.' }
        $install = @'
set -eu
archive='__ARCHIVE__'
release='__RELEASE__'
expected='__SHA__'
actual=$(sha256sum "$archive" | awk '{print $1}')
test "$actual" = "$expected"
if [ -e "$release" ]; then
  test -f "$release/.archive-sha256"
  test "$(cat "$release/.archive-sha256")" = "$expected"
  echo SILVER_RELEASE_CACHED="$release"
  rm -f -- "$archive"
  exit 0
fi
mkdir -p '__RELEASE_ROOT__'
stage=$(mktemp -d /opt/planetory-silver/release-part.XXXXXX)
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT
tar -xzf "$archive" -C "$stage"
test -f "$stage/spark/tess_silver.py"
test -f "$stage/spark/tess_silver_ctl.py"
test -f "$stage/spark/tess_bronze_ctl.py"
test -f "$stage/spark/requirements.txt"
test -d "$stage/astro_kernel"
mkdir "$stage/classes"
classpath=$(env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hadoop classpath)
env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 javac -encoding UTF-8 -cp "$classpath" -d "$stage/classes" "$stage/TessSequenceFileTool.java"
printf '%s\n' "$expected" > "$stage/.archive-sha256"
chown -R root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
mv "$stage" "$release"
trap - EXIT
rm -f -- "$archive"
echo SILVER_RELEASE_OK="$release"
'@.Replace('__ARCHIVE__', $remoteArchive).Replace('__RELEASE__', $release).Replace('__RELEASE_ROOT__', $releaseRoot).Replace('__SHA__', $archiveSha)
        $null = Invoke-Remote $install 'Install immutable Silver release' -Sudo
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    }
    return
}

if ($Step -eq 'Preflight') {
    $command = "set -eu`ntest -f '$release/spark/tess_silver_ctl.py'`nsudo -n /usr/bin/python3.12 '$release/spark/tess_silver_ctl.py' preflight --bronze-coverage '$BronzeCoverage'"
    $null = Invoke-Remote $command 'Silver read-only preflight'
    return
}

if ($Step -eq 'Canary') {
    if (-not $TicId -or $TicId.Count -gt 5) { throw 'Canary requires one to five explicit TIC IDs.' }
    if (-not $PSCmdlet.ShouldProcess("TIC $($TicId -join ',') validation path", 'Run Silver canary')) { return }
    $ticArgs = @($TicId | ForEach-Object { "--tic-id $_" }) -join ' '
    $command = "set -eu`ntest -f '$release/spark/tess_silver_ctl.py'`nsudo -n /usr/bin/python3.12 '$release/spark/tess_silver_ctl.py' canary --release-dir '$release' --run-id '$RunId' --pipeline-version '$PipelineVersion' --bronze-coverage '$BronzeCoverage' --shuffle-partitions '$ShufflePartitions' --output-partitions '$OutputPartitions' $ticArgs"
    $null = Invoke-Remote $command 'Run Silver canary'
    return
}

$baseExec = "/usr/bin/python3.12 $release/spark/tess_silver_ctl.py"
if ($Step -eq 'Start') {
    if (-not $PSCmdlet.ShouldProcess("HDFS Silver run $RunId", "Start $unit")) { return }
    $exec = "$baseExec run --release-dir $release --run-id $RunId --pipeline-version $PipelineVersion --bronze-coverage $BronzeCoverage --shuffle-partitions $ShufflePartitions --output-partitions $OutputPartitions"
    Install-SilverUnit -Exec $exec -Description "Planetory TESS Bronze to Silver $RunId"
    return
}

if ($Step -eq 'Retry') {
    if (-not $RetryFrom) { throw 'Retry requires -RetryFrom with a completed Silver attempt path.' }
    if (-not $PSCmdlet.ShouldProcess("Failed TICs from $RetryFrom", "Start $unit")) { return }
    $exec = "$baseExec retry --release-dir $release --run-id $RunId --pipeline-version $PipelineVersion --bronze-coverage $BronzeCoverage --shuffle-partitions $ShufflePartitions --output-partitions $OutputPartitions --retry-from $RetryFrom"
    Install-SilverUnit -Exec $exec -Description "Planetory TESS Silver failed-TIC retry $RunId"
    return
}

if ($Step -eq 'Status') {
    $status = @'
set -eu
unit='__UNIT__'
sudo -n systemctl status "$unit" --no-pager || true
sudo -n journalctl -u "$unit" -n 120 --no-pager || true
'@.Replace('__UNIT__', $unit)
    $null = Invoke-Remote $status 'Read Silver processing status'
}

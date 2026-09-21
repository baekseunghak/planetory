[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Install', 'Preflight', 'Canary', 'Start', 'Status')]
    [string]$Step,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$CodeReleaseId,

    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$RunId = ([datetime]::UtcNow.ToString('yyyyMMddTHHmmssZ')),

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$PipelineVersion,

    [ValidateNotNullOrEmpty()]
    [int[]]$Sector = @(3, 4, 5),

    [ValidateRange(1, 200)]
    [int]$OutputPartitions = 40
)

$ErrorActionPreference = 'Stop'
$node1 = 'SSAFY@node-1'
$releaseRoot = '/opt/planetory-bronze/releases'
$release = "$releaseRoot/$CodeReleaseId"
$unit = "planetory-tess-bronze-$RunId.service"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $PipelineVersion) { $PipelineVersion = "S15P21C206-77-$CodeReleaseId" }
if (@($Sector | Sort-Object -Unique).Count -ne $Sector.Count) { throw 'Sector values must be unique.' }
if (@($Sector | Where-Object { $_ -lt 1 -or $_ -gt 13 }).Count) { throw 'Sector values must be in 1..13.' }

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

function Get-SectorArgs {
    (@($Sector | ForEach-Object { "--sector $_" }) -join ' ')
}

Assert-LocalTools

if ($Step -eq 'Install') {
    if (-not $PSCmdlet.ShouldProcess($release, 'Install immutable Bronze release on Node 1')) { return }
    & (Join-Path $PSScriptRoot 'test-tess-bronze.ps1')

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) "planetory-bronze-$CodeReleaseId-$PID"
    $archive = "$tempRoot.tar.gz"
    try {
        $null = New-Item -ItemType Directory -Path (Join-Path $tempRoot 'spark') -Force
        $null = New-Item -ItemType Directory -Path (Join-Path $tempRoot 'astro_kernel') -Force
        foreach ($name in @('requirements.txt', 'tess_bronze.py', 'tess_bronze_ctl.py')) {
            Copy-Item -LiteralPath (Join-Path $repoRoot "distributed-system\spark\$name") -Destination (Join-Path $tempRoot "spark\$name")
        }
        Copy-Item -Path (Join-Path $repoRoot 'libs\astro-kernel\astro_kernel\*.py') -Destination (Join-Path $tempRoot 'astro_kernel')
        Copy-Item -LiteralPath (Join-Path $repoRoot 'distributed-system\ingestion\hdfs\TessSequenceFileTool.java') -Destination $tempRoot
        & tar -czf $archive -C $tempRoot .
        if ($LASTEXITCODE -ne 0) { throw 'Failed to build Bronze release archive.' }
        $archiveSha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        $remoteArchive = "/tmp/planetory-bronze-$CodeReleaseId.tar.gz"
        & scp -o BatchMode=yes -o StrictHostKeyChecking=yes $archive "${node1}:$remoteArchive"
        if ($LASTEXITCODE -ne 0) { throw 'Failed to upload Bronze release archive.' }
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
  echo BRONZE_RELEASE_CACHED="$release"
  rm -f -- "$archive"
  exit 0
fi
mkdir -p '__RELEASE_ROOT__'
stage=$(mktemp -d /opt/planetory-bronze/release-part.XXXXXX)
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT
tar -xzf "$archive" -C "$stage"
test -f "$stage/spark/tess_bronze.py"
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
echo BRONZE_RELEASE_OK="$release"
'@.Replace('__ARCHIVE__', $remoteArchive).Replace('__RELEASE__', $release).Replace('__RELEASE_ROOT__', $releaseRoot).Replace('__SHA__', $archiveSha)
        $null = Invoke-Remote $install 'Install immutable Bronze release' -Sudo
    } finally {
        if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    }
    return
}

$sectorArgs = Get-SectorArgs
if ($Step -eq 'Preflight') {
    $command = "set -eu`ntest -f '$release/spark/tess_bronze_ctl.py'`nsudo -n /usr/bin/python3.12 '$release/spark/tess_bronze_ctl.py' preflight $sectorArgs"
    $null = Invoke-Remote $command 'Bronze read-only preflight'
    return
}

if ($Step -eq 'Canary') {
    if ($Sector.Count -ne 1) { throw 'Canary requires exactly one Sector.' }
    if (-not $PSCmdlet.ShouldProcess("Sector $($Sector[0]) validation path", 'Run five-product Bronze canary')) { return }
    $command = "set -eu`ntest -f '$release/spark/tess_bronze_ctl.py'`nsudo -n /usr/bin/python3.12 '$release/spark/tess_bronze_ctl.py' canary --release-dir '$release' --run-id '$RunId' --pipeline-version '$PipelineVersion' --sector $($Sector[0]) --canary-products 5"
    $null = Invoke-Remote $command 'Run Bronze canary'
    return
}

if ($Step -eq 'Start') {
    if (-not $PSCmdlet.ShouldProcess("HDFS Bronze sectors $($Sector -join ',')", "Start $unit")) { return }
    $exec = "/usr/bin/python3.12 $release/spark/tess_bronze_ctl.py run-all --release-dir $release --run-id $RunId --pipeline-version $PipelineVersion --output-partitions $OutputPartitions $sectorArgs"
    $unitText = @"
[Unit]
Description=Planetory TESS Raw to Bronze $RunId
After=network-online.target hadoop-hdfs-namenode.service hadoop-yarn-resourcemanager.service docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$release
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=$exec
ExecStartPost=-/usr/bin/systemctl disable %n
TimeoutStartSec=infinity
Restart=on-failure
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
test -f "$release/spark/tess_bronze_ctl.py"
candidate=$(mktemp /run/planetory-bronze-unit.XXXXXX)
trap 'rm -f -- "$candidate"' EXIT
printf '%s' '__UNIT_PAYLOAD__' | base64 --decode > "$candidate"
if [ -e "/etc/systemd/system/$unit" ]; then
  cmp -s "$candidate" "/etc/systemd/system/$unit" || { echo UNIT_DEFINITION_MISMATCH >&2; exit 1; }
else
  sudo -n install -o root -g root -m 0644 "$candidate" "/etc/systemd/system/$unit"
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable "$unit"
fi
if sudo -n systemctl is-active --quiet "$unit"; then
  echo BRONZE_UNIT_ALREADY_ACTIVE="$unit"
  exit 0
fi
started=$(sudo -n systemctl show "$unit" -p ExecMainStartTimestampMonotonic --value)
if [ "$started" != 0 ] && [ "$(sudo -n systemctl show "$unit" -p Result --value)" = success ]; then
  echo BRONZE_UNIT_ALREADY_COMPLETE="$unit"
  exit 0
fi
sudo -n systemctl reset-failed "$unit" || true
sudo -n systemctl --no-block start "$unit"
echo BRONZE_UNIT_STARTED="$unit"
'@.Replace('__RELEASE__', $release).Replace('__UNIT__', $unit).Replace('__UNIT_PAYLOAD__', $unitPayload)
    $null = Invoke-Remote $start 'Start autonomous Bronze conversion' -Sudo
    return
}

if ($Step -eq 'Status') {
    $status = @'
set -eu
unit='__UNIT__'
sudo -n systemctl status "$unit" --no-pager || true
sudo -n journalctl -u "$unit" -n 120 --no-pager || true
'@.Replace('__UNIT__', $unit)
    $null = Invoke-Remote $status 'Read Bronze conversion status'
}

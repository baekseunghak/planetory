[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)]
 [ValidateSet('ConfigureCapacity','Preflight','Install','Build','Upload','Status','Audit','Commit','CoverageCommit','RunAll')]
 [string]$Step,
 [Parameter(Mandatory)][ValidatePattern('^\d{8}T\d{6}Z$')][string]$RunId,
 [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceListSha256,
 [ValidateRange(1,13)][int]$Sector=3,
 [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$ReleaseId=$RunId,
 [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$CodeReleaseId=$RunId,
 [ValidateRange(512,1024)][int]$TargetBundleMiB=512,
 [ValidateRange(0,[long]::MaxValue)][long]$ExpectedSectorBytes=0,
 [ValidateRange(80,1000)][int]$MinimumWorkerFreeGiB=100,
 [AllowEmptyString()][ValidateScript({$_ -eq '' -or $_ -match '^[0-9a-f]{64}$'})][string]$ExpectedCoverageSha256='',
 [ValidateCount(1,5)][ValidateSet(2,3,4,5,6)][int[]]$NodeNumbers=(2..6),
 [string]$LocalIngestionPath=(Join-Path $PSScriptRoot '../../../distributed-system/ingestion')
)
$ErrorActionPreference='Stop'
$mutatingSteps=@('ConfigureCapacity','Install','Build','Upload','Commit','CoverageCommit','RunAll')
if ($Step -in $mutatingSteps -and -not $PSCmdlet.ShouldProcess("TESS HDFS release=$ReleaseId sector=$Sector","S15P21C206-76 $Step")) { return }
if ($Step -in @('ConfigureCapacity','Commit','CoverageCommit') -and (@($NodeNumbers).Count -ne 5 -or (@($NodeNumbers | Sort-Object) -join ',') -ne '2,3,4,5,6')) {
 throw "$Step requires all Workers 2..6."
}
if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
if ($Step -in @('ConfigureCapacity','Install') -and -not (Get-Command scp -ErrorAction SilentlyContinue)) { throw 'Install an OpenSSH client with scp first.' }
$LocalIngestionPath=(Resolve-Path $LocalIngestionPath).Path
$loaderRoot=Join-Path $LocalIngestionPath 'hdfs'
$hdfsSitePath=(Resolve-Path (Join-Path $PSScriptRoot '../config/hadoop/hdfs-site.xml')).Path
foreach ($name in @('tess_hdfs_load.py','TessSequenceFileTool.java','manifest_to_parquet.py')) {
 if (-not (Test-Path -LiteralPath (Join-Path $loaderRoot $name) -PathType Leaf)) { throw "Missing HDFS loader file: $name" }
}

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Invoke-Remote {
 param([string]$Target,[string]$Command,[string]$Label)
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command.Replace("`r",'')))
 $remote="printf '%s' '$payload' | base64 --decode | bash"
 Write-Host "== $Label ($Target) =="
 $output=@(& tailscale ssh $Target $remote 2>&1)
 $exitCode=$LASTEXITCODE
 $output | ForEach-Object { Write-Host $_ }
 if ($exitCode -ne 0) { throw "$Label failed on $Target (exit $exitCode)." }
}

function Invoke-RemoteCapture {
 param([string]$Target,[string]$Command,[string]$Label)
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command.Replace("`r",'')))
 $remote="printf '%s' '$payload' | base64 --decode | bash"
 $output=@(& tailscale ssh $Target $remote 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "$Label failed on $Target (exit $exitCode):`n$($output -join "`n")" }
 $output
}

function Invoke-Scp {
 param([string]$Source,[string]$Destination)
 $output=@(& scp -o BatchMode=yes -o StrictHostKeyChecking=yes $Source $Destination 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "scp failed ($exitCode): $Source -> $Destination`n$($output -join "`n")" }
}

function Assert-Host([string]$Alias,[string]$Target,[string]$Expected) {
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false $Alias
 $actual=@(Invoke-Tailscale ssh $Target hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne $Expected) { throw "$Alias must resolve to $Expected." }
}

function Test-HdfsPath([string]$Path) {
 $command=@'
set -eu
if sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs dfs -test -e '__PATH__'; then
 echo HDFS_PATH_PRESENT
else
 echo HDFS_PATH_ABSENT
fi
'@.Replace('__PATH__',$Path)
 @((Invoke-RemoteCapture $node1 $command "Check HDFS path $Path")) -contains 'HDFS_PATH_PRESENT'
}

function Wait-HdfsUploaders([int]$CurrentSector,[string]$CurrentRunId) {
 $started=[DateTimeOffset]::UtcNow
 $deadline=$started.AddHours(3)
 while ($true) {
  $pending=@()
  foreach ($node in $NodeNumbers) {
   $slot=$node-1
   $unit="planetory-tess-hdfs-load-$CurrentRunId-s$CurrentSector-w$slot.service"
   $command="sudo systemctl show '$unit' --property=LoadState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager"
   $state=@{}
   foreach ($line in @(Invoke-RemoteCapture "planetory-admin@node-$node" $command "Read Worker $slot uploader state")) {
    if ($line -match '^([^=]+)=(.*)$') { $state[$Matches[1]]=$Matches[2] }
   }
   if ($state.LoadState -ne 'loaded') { throw "Uploader unit is not loaded: $unit" }
   if ($state.ActiveState -eq 'inactive' -and $state.Result -eq 'success' -and $state.ExecMainStatus -eq '0') { continue }
   if ($state.ActiveState -eq 'failed' -or ($state.ActiveState -eq 'inactive' -and $state.Result -ne 'success')) {
    throw "Uploader failed: $unit active=$($state.ActiveState) sub=$($state.SubState) result=$($state.Result) exit=$($state.ExecMainStatus) restarts=$($state.NRestarts)"
   }
   $pending += "w$slot=$($state.ActiveState)/$($state.SubState)"
  }
  if (-not $pending) {
   $restartSummary=@()
   foreach ($node in $NodeNumbers) {
    $slot=$node-1
    $unit="planetory-tess-hdfs-load-$CurrentRunId-s$CurrentSector-w$slot.service"
    $restarts=@(Invoke-RemoteCapture "planetory-admin@node-$node" "sudo systemctl show '$unit' --property=NRestarts --value --no-pager" "Read Worker $slot uploader restarts") | Select-Object -Last 1
    $restartSummary += "w$slot=$restarts"
   }
   $elapsed=[Math]::Round(([DateTimeOffset]::UtcNow-$started).TotalSeconds,1)
   Write-Host "UPLOAD_COMPLETE sector=$CurrentSector elapsed_seconds=$elapsed restarts=$($restartSummary -join ',')"
   return
  }
  if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Upload wait timed out after 3 hours: sector=$CurrentSector pending=$($pending -join ',')" }
  $elapsed=[Math]::Round(([DateTimeOffset]::UtcNow-$started).TotalMinutes,1)
  Write-Host "UPLOAD_WAIT sector=$CurrentSector elapsed_minutes=$elapsed pending=$($pending -join ',')"
  Start-Sleep -Seconds 30
 }
}

function Invoke-OrchestratedStep(
 [string]$ChildStep,
 [int]$CurrentSector,
 [string]$CurrentRunId=$RunId,
 [string]$CurrentSourceSha=$ExpectedSourceListSha256,
 [string]$CurrentReleaseId=$ReleaseId,
 [long]$CurrentSectorBytes=$ExpectedSectorBytes
) {
 $parameters=@{
  Step=$ChildStep
  RunId=$CurrentRunId
  ExpectedSourceListSha256=$CurrentSourceSha
  Sector=$CurrentSector
  ReleaseId=$CurrentReleaseId
  CodeReleaseId=$CodeReleaseId
  TargetBundleMiB=$TargetBundleMiB
  ExpectedSectorBytes=$CurrentSectorBytes
  MinimumWorkerFreeGiB=$MinimumWorkerFreeGiB
  ExpectedCoverageSha256=$ExpectedCoverageSha256
  NodeNumbers=$NodeNumbers
  LocalIngestionPath=$LocalIngestionPath
  Confirm=$false
 }
 & $PSCommandPath @parameters
}

function Get-CoverageDocument {
 if (-not $ExpectedCoverageSha256) { throw 'ExpectedCoverageSha256 is required for Sector 1~13 coverage.' }
 if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'Python is required to validate the coverage manifest.' }
 $coverageBase64=$null
 foreach ($node in $NodeNumbers) {
  $command=@'
set -eu
manifest='/mnt/data/staging/S15P21C206-75/run-__RUN_ID__/manifests/coverage-sectors-1-13.json'
checksum="$manifest.sha256"
test -f "$manifest" -a -f "$checksum"
actual=$(sha256sum "$manifest" | cut -d ' ' -f 1)
declared=$(cut -d ' ' -f 1 "$checksum")
test "$actual" = '__COVERAGE_SHA__'
test "$declared" = '__COVERAGE_SHA__'
base64 -w 0 "$manifest"
'@.Replace('__RUN_ID__',$RunId).Replace('__COVERAGE_SHA__',$ExpectedCoverageSha256)
  $encoded=@(Invoke-RemoteCapture "planetory-admin@node-$node" $command "Read Worker $($node-1) coverage manifest") | Select-Object -Last 1
  if (-not $encoded) { throw "Worker $($node-1) returned no coverage manifest." }
  if ($coverageBase64 -and $coverageBase64 -ne $encoded) { throw 'Worker coverage manifests differ despite the expected checksum.' }
  $coverageBase64=$encoded
 }
 $temporary=[IO.Path]::GetTempFileName()
 try {
  [IO.File]::WriteAllBytes($temporary,[Convert]::FromBase64String($coverageBase64))
  $loader=Join-Path $loaderRoot 'tess_hdfs_load.py'
  $output=@(& python $loader coverage-map --coverage-manifest $temporary --expected-sha $ExpectedCoverageSha256 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Coverage validation failed:`n$($output -join "`n")" }
  $json=$output | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $json) { throw 'Coverage validator returned no JSON map.' }
  $map=$json | ConvertFrom-Json
  if ($map.expected -ne 247824 -or $map.validated -ne 247824 -or (@($map.sectors.sector) -join ',') -ne ((1..13) -join ',')) {
   throw 'Coverage map must contain all 247,824 products in Sector 1 through 13.'
  }
  $inputRun=@($map.sectors | Where-Object { $_.run_id -eq $RunId })
  if (-not $inputRun -or @($inputRun | Where-Object { $_.source_list_sha256 -ne $ExpectedSourceListSha256 }).Count) {
   throw 'Coverage map does not match the requested expansion RunId and source checksum.'
  }
  [pscustomobject]@{Map=$map;Base64=$coverageBase64}
 } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function New-LoaderBundle {
 $archive=Join-Path ([IO.Path]::GetTempPath()) "S15P21C206-76-$CodeReleaseId-$PID.tgz"
 $hasher=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
 try {
  $files=@(
   Get-ChildItem -LiteralPath (Join-Path $LocalIngestionPath 'ingestion') -Recurse -File
   foreach ($name in @('tess_hdfs_load.py','TessSequenceFileTool.java','manifest_to_parquet.py')) {
    Get-Item -LiteralPath (Join-Path $loaderRoot $name)
   }
  ) | Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]|\.pyc$' } | Sort-Object FullName
  foreach ($file in $files) {
   $relative=[IO.Path]::GetRelativePath($LocalIngestionPath,$file.FullName).Replace('\','/')
   $hasher.AppendData([Text.Encoding]::UTF8.GetBytes("$relative`0"))
   $stream=[IO.File]::OpenRead($file.FullName)
   try {
    $buffer=[byte[]]::new(1MB)
    while (($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0) { $hasher.AppendData($buffer,0,$read) }
   } finally { $stream.Dispose() }
   $hasher.AppendData([byte[]]@(0))
  }
  $contentSha=[Convert]::ToHexString($hasher.GetHashAndReset()).ToLowerInvariant()
  & tar -czf $archive '--exclude=__pycache__' '--exclude=*.pyc' -C $LocalIngestionPath ingestion hdfs/tess_hdfs_load.py hdfs/TessSequenceFileTool.java hdfs/manifest_to_parquet.py
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create HDFS loader bundle.' }
  [pscustomobject]@{
   Path=$archive
   ContentSha256=$contentSha
   ArchiveSha256=(Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  }
 } catch {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  throw
 } finally { $hasher.Dispose() }
}

$node1='SSAFY@node-1'
$codeRelease="/opt/planetory-hdfs-load/releases/$CodeReleaseId"
$runRoot="/mnt/data/staging/S15P21C206-75/run-$RunId"
$sourceList="$runRoot/manifests/tess-service-v1.json"
$rawRoot="$runRoot/raw"
$localState="$runRoot/hdfs-load/sector=$('{0:D4}' -f $Sector)"
$stage="/lake/raw/tess/.staging/run=$RunId/release=$ReleaseId/sector=$('{0:D4}' -f $Sector)"
$final="/lake/raw/tess/release=$ReleaseId/sector=$('{0:D4}' -f $Sector)"
$finalUri="hdfs://planetory$final"
$targetBytes=[int64]$TargetBundleMiB*1MB
$slotArgs=($NodeNumbers | ForEach-Object { "--worker-slot $($_-1)" }) -join ' '

switch ($Step) {
 'ConfigureCapacity' {
  $configSha=(Get-FileHash -Algorithm SHA256 -LiteralPath $hdfsSitePath).Hash.ToLowerInvariant()
  $targets=@(,@('node-1',$node1,'master-1'); foreach ($node in $NodeNumbers) { ,@("node-$node","planetory-admin@node-$node","worker-$node") })
  foreach ($target in $targets) {
   Assert-Host $target[0] $target[1] $target[2]
   $remoteConfig="/tmp/S15P21C206-76-$CodeReleaseId-hdfs-site.xml"
   Invoke-Scp $hdfsSitePath "$($target[1]):$remoteConfig"
   $command=@'
set -eu
candidate='__CANDIDATE__'
current=/etc/hadoop/hdfs-site.xml
cleanup() { status=$?; trap - EXIT; rm -f -- "$candidate"; exit "$status"; }
trap cleanup EXIT
test -f "$current"
test "$(sha256sum "$candidate" | cut -d ' ' -f 1)" = '__CONFIG_SHA__'
python3 - "$current" "$candidate" <<'PY'
import sys
import xml.etree.ElementTree as ET

RESERVED = "dfs.datanode.du.reserved"
EXPECTED = "107374182400"

def properties(path):
    result = {}
    for item in ET.parse(path).getroot().findall("property"):
        name = (item.findtext("name") or "").strip()
        value = (item.findtext("value") or "").strip()
        if not name or name in result:
            raise SystemExit(f"invalid or duplicate Hadoop property: {name!r}")
        result[name] = value
    return result

current = properties(sys.argv[1])
candidate = properties(sys.argv[2])
current_reserved = current.pop(RESERVED, None)
candidate_reserved = candidate.pop(RESERVED, None)
if candidate_reserved != EXPECTED:
    raise SystemExit("candidate HDFS reserve is not 100 GiB")
if current_reserved not in (None, "0", EXPECTED):
    raise SystemExit(f"unexpected current HDFS reserve: {current_reserved}")
if current != candidate:
    changed = sorted(set(current) ^ set(candidate) | {key for key in current.keys() & candidate.keys() if current[key] != candidate[key]})
    raise SystemExit("HDFS config drift outside reserve: " + ",".join(changed))
PY
if test "$(sha256sum "$current" | cut -d ' ' -f 1)" = '__CONFIG_SHA__'; then
 echo CONFIG_CACHED host="$(hostname -s)" sha256=__CONFIG_SHA__
else
 sudo install -o root -g root -m 0644 "$candidate" "$current"
 test "$(sha256sum "$current" | cut -d ' ' -f 1)" = '__CONFIG_SHA__'
 echo CONFIG_UPDATED host="$(hostname -s)" sha256=__CONFIG_SHA__
fi
'@.Replace('__CANDIDATE__',$remoteConfig).Replace('__CONFIG_SHA__',$configSha)
   $output=@(Invoke-RemoteCapture $target[1] $command "Configure HDFS reserve on $($target[2])")
   $output | ForEach-Object { Write-Host $_ }
  }
  foreach ($node in $NodeNumbers) {
   $worker="planetory-admin@node-$node"
   $command=@'
set -eu
sudo systemctl restart hadoop-hdfs-datanode
for attempt in $(seq 1 40); do
 if systemctl is-active --quiet hadoop-hdfs-datanode && pgrep -u hdfs -f org.apache.hadoop.hdfs.server.datanode.DataNode >/dev/null; then
  value=$(env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs getconf -confKey dfs.datanode.du.reserved)
  test "$value" = 107374182400
  echo DATANODE_RESTARTED host="$(hostname -s)" reserved="$value"
  exit 0
 fi
 sleep 3
done
sudo journalctl -u hadoop-hdfs-datanode -n 30 --no-pager >&2
exit 1
'@
   Invoke-Remote $worker $command "Restart DataNode Worker $($node-1)"
   $verify=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
for attempt in $(seq 1 40); do
 live=$(hdfs_cmd dfsadmin -report | sed -n 's/^Live datanodes (\([0-9][0-9]*\)):.*/\1/p')
 if test "$live" = 5; then
  echo HDFS_LIVE_OK live_datanodes="$live"
  exit 0
 fi
 sleep 3
done
echo "LIVE_DATANODES_NOT_RECOVERED=${live:-unknown}" >&2
exit 1
'@
   Invoke-Remote $node1 $verify "Verify HDFS after Worker $($node-1) restart"
  }
  $final=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
test "$(hdfs_cmd getconf -confKey dfs.datanode.du.reserved)" = 107374182400
safe_mode=$(hdfs_cmd dfsadmin -safemode get)
test -n "$safe_mode"
if printf '%s\n' "$safe_mode" | grep -qv '^Safe mode is OFF'; then echo "$safe_mode" >&2; exit 1; fi
test "$(hdfs_cmd dfsadmin -report | sed -n 's/^Live datanodes (\([0-9][0-9]*\)):.*/\1/p')" = 5
echo HDFS_CAPACITY_CONFIGURED reserved=107374182400 live_datanodes=5
'@
  Invoke-Remote $node1 $final 'Validate HDFS capacity configuration'
 }
 'Preflight' {
  Assert-Host 'node-1' $node1 'master-1'
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
nn1=$(hdfs_cmd haadmin -getServiceState nn1)
nn2=$(hdfs_cmd haadmin -getServiceState nn2)
case "$nn1:$nn2" in active:standby|standby:active) ;; *) echo "INVALID_HA_STATE=$nn1:$nn2" >&2; exit 1;; esac
test "$(hdfs_cmd getconf -confKey dfs.replication)" = 2
test "$(hdfs_cmd getconf -confKey dfs.datanode.du.reserved)" = 107374182400
safe_mode=$(hdfs_cmd dfsadmin -safemode get)
test -n "$safe_mode"
if printf '%s\n' "$safe_mode" | grep -qv '^Safe mode is OFF'; then echo "$safe_mode" >&2; exit 1; fi
test "$(hdfs_cmd dfsadmin -report | sed -n 's/^Live datanodes (\([0-9][0-9]*\)):.*/\1/p')" = 5
read -r capacity used_bytes available used <<EOF
$(hdfs_cmd dfs -df / | awk 'NR==2 {gsub(/%/,"",$5); print $2, $3, $4, $5}')
EOF
test "$used" -lt 75
expected=__EXPECTED_SECTOR_BYTES__
if test "$expected" -gt 0; then
 projected=$((used_bytes + expected * 2))
 test $((projected * 100)) -le $((capacity * 70)) || { echo "HDFS_PROJECTED_USAGE_EXCEEDS_70_PERCENT" >&2; exit 1; }
 test "$available" -ge $((expected * 2)) || { echo "HDFS_CAPACITY_INSUFFICIENT" >&2; exit 1; }
fi
echo HDFS_PREFLIGHT_OK ha="$nn1:$nn2" live_datanodes=5 replication=2 used_percent="$used" expected_source_bytes="$expected"
'@.Replace('__EXPECTED_SECTOR_BYTES__',[string]$ExpectedSectorBytes)
  Invoke-Remote $node1 $command 'HDFS cluster preflight'
  foreach ($node in $NodeNumbers) {
   Assert-Host "node-$node" "planetory-admin@node-$node" "worker-$node"
   $slot=$node-1
   $command=@'
set -eu
run_root='__RUN_ROOT__'
source_list='__SOURCE_LIST__'
audit="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.audit.json"
complete="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.complete.json"
test -x /opt/hadoop/bin/hdfs
test "$(env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs getconf -confKey dfs.datanode.du.reserved)" = 107374182400
test -f "$source_list" -a -f "$audit" -a -f "$complete"
available_kib=$(df -Pk /mnt/data | awk 'NR==2 {print $4}')
test "$available_kib" -ge __MINIMUM_FREE_KIB__ || { echo "WORKER_CAPACITY_INSUFFICIENT available_kib=$available_kib" >&2; exit 1; }
test -z "$(find '__RAW_ROOT__/sector=__SECTOR_PAD__' -maxdepth 1 -type f -name '*.part' -print -quit)"
python3.12 - "$source_list" "$audit" "$complete" <<'PY'
import json,sys
source=json.load(open(sys.argv[1],encoding='utf-8'))
audit=json.load(open(sys.argv[2],encoding='utf-8'))
complete=json.load(open(sys.argv[3],encoding='utf-8'))
assert source['source_list_sha256']=='__SOURCE_SHA__'
assert audit['schema']=='planetory.download-audit.v1'
assert audit['source_list_sha256']=='__SOURCE_SHA__'
assert audit['worker_slot']==__SLOT__ and audit['sectors']==[__SECTOR__]
assert audit['expected']==audit['validated'] and not audit['errors']
assert complete['schema']=='planetory.ingestion-sector-complete.v1'
assert complete['worker_slot']==__SLOT__ and complete['sector']==__SECTOR__
assert complete['source_list_sha256']=='__SOURCE_SHA__' and complete['validated']==audit['validated']
print('WORKER_AUDIT_GATE_OK',audit['validated'],audit['total_bytes'])
PY
'@.Replace('__RUN_ROOT__',$runRoot).Replace('__SOURCE_LIST__',$sourceList).Replace('__RAW_ROOT__',$rawRoot).Replace('__SECTOR__',[string]$Sector).Replace('__SECTOR_PAD__',('{0:D4}' -f $Sector)).Replace('__SLOT__',[string]$slot).Replace('__SOURCE_SHA__',$ExpectedSourceListSha256).Replace('__MINIMUM_FREE_KIB__',[string]([int64]$MinimumWorkerFreeGiB*1MB))
   Invoke-Remote "planetory-admin@node-$node" $command "Worker $slot download audit gate"
  }
 }
 'Install' {
  $bundle=New-LoaderBundle
  try {
   $targets=@(,@('node-1',$node1,'master-1'); foreach ($node in $NodeNumbers) { ,@("node-$node","planetory-admin@node-$node","worker-$node") })
   foreach ($target in $targets) {
    Assert-Host $target[0] $target[1] $target[2]
    $remoteArchive="/tmp/S15P21C206-76-$CodeReleaseId.tgz"
    Invoke-Scp $bundle.Path "$($target[1]):$remoteArchive"
    $command=@'
set -eu
release='__RELEASE__'
archive=/tmp/S15P21C206-76-__CODE_RELEASE__.tgz
work=/tmp/S15P21C206-76-__CODE_RELEASE__-work-$$
cleanup() { status=$?; trap - EXIT; rm -f -- "$archive"; test -z "$work" || sudo rm -rf -- "$work"; exit "$status"; }
trap cleanup EXIT
if test -f "$release/READY"; then
 test "$(cat "$release/READY")" = '__CONTENT_SHA__' || { echo RELEASE_ID_CONFLICT >&2; exit 1; }
 test -x "$release" && test -r "$release/hdfs/tess_hdfs_load.py" || { echo RELEASE_PERMISSION_INVALID >&2; exit 1; }
 echo INSTALL_CACHED content_sha256=__CONTENT_SHA__
 exit 0
fi
test ! -e "$release" || { echo INCOMPLETE_RELEASE_CONFLICT >&2; exit 1; }
mkdir -m 0700 "$work"
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = '__ARCHIVE_SHA__'
tar -xzf "$archive" -C "$work"
mkdir -p "$work/classes"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop
javac -encoding UTF-8 -cp "$(/opt/hadoop/bin/hadoop classpath)" -d "$work/classes" "$work/hdfs/TessSequenceFileTool.java"
PYTHONPATH="$work" python3.12 -m compileall -q "$work/ingestion" "$work/hdfs"
printf '%s\n' '__CONTENT_SHA__' > "$work/READY"
sudo chown -R root:root "$work"
sudo chmod -R a=rX,u+w "$work"
sudo install -d -o root -g root -m 0755 "$(dirname "$release")"
sudo test ! -e "$release" || { echo RELEASE_RACE_CONFLICT >&2; exit 1; }
sudo mv "$work" "$release"
work=''
test -x "$release" && test -r "$release/hdfs/tess_hdfs_load.py"
echo INSTALL_OK release="$release" content_sha256=__CONTENT_SHA__
'@.Replace('__RELEASE__',$codeRelease).Replace('__CODE_RELEASE__',$CodeReleaseId).Replace('__CONTENT_SHA__',$bundle.ContentSha256).Replace('__ARCHIVE_SHA__',$bundle.ArchiveSha256)
    Invoke-Remote $target[1] $command 'Install immutable HDFS loader'
   }
  } finally { Remove-Item -LiteralPath $bundle.Path -Force -ErrorAction SilentlyContinue }
 }
 'Build' {
  Assert-Host 'node-1' $node1 'master-1'
  $prepare=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
if hdfs_cmd dfs -test -e '__FINAL__'; then echo FINAL_ALREADY_EXISTS >&2; exit 1; fi
hdfs_cmd dfs -mkdir -p '__STAGE__/.control'
hdfs_cmd dfs -chown -R planetory-admin:hadoop '__STAGE__'
hdfs_cmd dfs -chmod 0750 '__STAGE__' '__STAGE__/.control'
echo STAGE_PREPARED=__STAGE__
'@.Replace('__STAGE__',$stage).Replace('__FINAL__',$final)
  Invoke-Remote $node1 $prepare 'Prepare exact HDFS staging path'
  foreach ($node in $NodeNumbers) {
   $slot=$node-1
   $command=@'
set -eu
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH='__RELEASE__'
state='__STATE__'
plan="$state/worker-__SLOT__.plan.json"
remote='__STAGE__/.control/worker=__SLOT__/plan.json'
install -d -m 0750 "$state"
python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' plan \
 --source-list '__SOURCE_LIST__' --events '__RUN_ROOT__/manifests/sector-__SECTOR__-worker-__SLOT__.events.jsonl' \
 --audit-manifest '__RUN_ROOT__/manifests/sector-__SECTOR__-worker-__SLOT__.audit.json' --raw-root '__RAW_ROOT__' \
 --worker-slot __SLOT__ --sector __SECTOR__ --run-id '__RUN_ID__' --release-id '__DATA_RELEASE__' \
 --target-bundle-bytes __TARGET_BYTES__ --output "$plan"
/opt/hadoop/bin/hdfs dfs -mkdir -p '__STAGE__/.control/worker=__SLOT__'
if /opt/hadoop/bin/hdfs dfs -test -e "$remote"; then
 /opt/hadoop/bin/hdfs dfs -cat "$remote" > "$plan.remote"
 cmp -s "$plan" "$plan.remote" || { echo PLAN_CONFLICT >&2; exit 1; }
 rm -f -- "$plan.remote"
 echo PLAN_CACHED worker=__SLOT__
else
 if /opt/hadoop/bin/hdfs dfs -test -e "$remote.part"; then /opt/hadoop/bin/hdfs dfs -rm -f "$remote.part"; fi
 /opt/hadoop/bin/hdfs dfs -put "$plan" "$remote.part"
 /opt/hadoop/bin/hdfs dfs -mv "$remote.part" "$remote"
 echo PLAN_UPLOADED worker=__SLOT__
fi
'@.Replace('__RELEASE__',$codeRelease).Replace('__STATE__',$localState).Replace('__STAGE__',$stage).Replace('__SOURCE_LIST__',$sourceList).Replace('__RUN_ROOT__',$runRoot).Replace('__RAW_ROOT__',$rawRoot).Replace('__RUN_ID__',$RunId).Replace('__DATA_RELEASE__',$ReleaseId).Replace('__SECTOR__',[string]$Sector).Replace('__SLOT__',[string]$slot).Replace('__TARGET_BYTES__',[string]$targetBytes)
   Invoke-Remote "planetory-admin@node-$node" $command "Build Worker $slot deterministic plan"
  }
 }
 'Upload' {
  foreach ($node in $NodeNumbers) {
   $slot=$node-1
   $unit="planetory-tess-hdfs-load-$RunId-s$Sector-w$slot.service"
   $plan="$localState/worker-$slot.plan.json"
   $unitText=@"
[Unit]
Description=Planetory TESS HDFS load run $RunId sector $Sector worker $slot
Wants=network-online.target
After=network-online.target hadoop-hdfs-datanode.service
RequiresMountsFor=/mnt/data
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=planetory-admin
WorkingDirectory=$codeRelease
Environment=JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
Environment=HADOOP_CONF_DIR=/etc/hadoop
Environment=PYTHONPATH=$codeRelease
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3.12 $codeRelease/hdfs/tess_hdfs_load.py upload --plan $plan --stage-uri $stage --final-uri $finalUri --classes $codeRelease/classes
Restart=on-failure
RestartSec=30s
TimeoutStartSec=3h
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

"@
   $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unitText.Replace("`r",'')))
   $command=@'
set -eu
unit='__UNIT__'
temporary=/tmp/__UNIT__
cleanup() { status=$?; trap - EXIT; rm -f -- "$temporary"; exit "$status"; }
trap cleanup EXIT
test -f '__PLAN__' -a -f '__RELEASE__/READY'
printf '%s' '__UNIT_BASE64__' | base64 --decode > "$temporary"
sudo install -o root -g root -m 0644 "$temporary" "/etc/systemd/system/$unit"
sudo systemctl daemon-reload
sudo systemctl disable "$unit" >/dev/null 2>&1 || true
sudo systemctl --no-block start "$unit"
echo UPLOAD_STARTED unit="$unit"
'@.Replace('__UNIT__',$unit).Replace('__PLAN__',$plan).Replace('__RELEASE__',$codeRelease).Replace('__UNIT_BASE64__',$encoded)
   Invoke-Remote "planetory-admin@node-$node" $command "Start Worker $slot HDFS uploader"
  }
 }
 'Status' {
  foreach ($node in $NodeNumbers) {
   $slot=$node-1
   $unit="planetory-tess-hdfs-load-$RunId-s$Sector-w$slot.service"
   $command="sudo systemctl show '$unit' --property=LoadState,UnitFileState,ActiveState,SubState,Result,NRestarts,ExecMainStatus --no-pager; sudo journalctl -u '$unit' -n 8 --no-pager"
   Invoke-Remote "planetory-admin@node-$node" $command "Worker $slot upload status"
  }
  Invoke-Remote $node1 "sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs dfs -ls -R '$stage'" 'HDFS staging status'
 }
 'Audit' {
  $command=@'
set -eu
sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH='__RELEASE__' \
 python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' audit --stage-uri '__STAGE__' --final-uri '__FINAL_URI__' \
 --source-sha '__SOURCE_SHA__' --run-id '__RUN_ID__' --release-id '__DATA_RELEASE__' --sector __SECTOR__ __SLOT_ARGS__
'@.Replace('__RELEASE__',$codeRelease).Replace('__STAGE__',$stage).Replace('__FINAL_URI__',$finalUri).Replace('__SOURCE_SHA__',$ExpectedSourceListSha256).Replace('__RUN_ID__',$RunId).Replace('__DATA_RELEASE__',$ReleaseId).Replace('__SECTOR__',[string]$Sector).Replace('__SLOT_ARGS__',$slotArgs)
  Invoke-Remote $node1 $command 'Audit bundles, offsets, checksums and RF2'
 }
 'Commit' {
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
audit=/tmp/S15P21C206-76-__RUN_ID__-s__SECTOR__.audit.json
spark_script=/tmp/S15P21C206-76-__RUN_ID__-manifest.py
ready=/tmp/S15P21C206-76-__RUN_ID__-ready.json
fsck=/tmp/S15P21C206-76-__RUN_ID__-fsck.txt
cleanup() { status=$?; trap - EXIT; sudo rm -f -- "$audit" "$spark_script" "$ready" "$fsck"; exit "$status"; }
trap cleanup EXIT
if hdfs_cmd dfs -test -e '__FINAL__'; then
 sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH='__RELEASE__' \
  python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' audit --stage-uri '__FINAL__' --final-uri '__FINAL_URI__' \
  --source-sha '__SOURCE_SHA__' --run-id '__RUN_ID__' --release-id '__DATA_RELEASE__' \
  --sector __SECTOR__ __SLOT_ARGS__ --output "$audit"
 count=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["product_count"])' "$audit")
 hdfs_cmd dfs -cat '__FINAL__/_READY.json' > "$ready"
 PYTHONPATH='__RELEASE__' python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' ready --ready-json "$ready" \
  --run-id '__RUN_ID__' --release-id '__DATA_RELEASE__' --source-sha '__SOURCE_SHA__' \
  --sector __SECTOR__ --product-count "$count" --replication 2
 hdfs_cmd dfs -test -e '__FINAL__/manifest.parquet/_SUCCESS'
 echo COMMIT_CACHED final='__FINAL__'
 exit 0
fi
if hdfs_cmd dfs -test -e '__STAGE__/_READY.json.part'; then
 hdfs_cmd dfs -rm -f '__STAGE__/_READY.json.part'
fi
sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH='__RELEASE__' \
 python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' audit --stage-uri '__STAGE__' --final-uri '__FINAL_URI__' \
 --source-sha '__SOURCE_SHA__' --run-id '__RUN_ID__' --release-id '__DATA_RELEASE__' \
 --sector __SECTOR__ __SLOT_ARGS__ --output "$audit"
count=$(sudo -u hdfs python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["product_count"])' "$audit")
if hdfs_cmd dfs -test -e '__STAGE__/manifest.parquet'; then
 hdfs_cmd dfs -rm -r -skipTrash '__STAGE__/manifest.parquet'
fi
cp '__RELEASE__/hdfs/manifest_to_parquet.py' "$spark_script"
sudo docker pull '__SPARK_IMAGE__'
sudo docker run --rm --network host \
 --add-host master-1:10.20.1.10 --add-host worker-2:10.20.2.10 --add-host worker-3:10.20.3.10 \
 --add-host worker-4:10.20.4.10 --add-host worker-5:10.20.5.10 --add-host worker-6:10.20.6.10 \
 -e HADOOP_CONF_DIR=/etc/hadoop -e HADOOP_USER_NAME=planetory-admin -v /etc/hadoop:/etc/hadoop:ro \
 -v "$spark_script":/opt/planetory/manifest_to_parquet.py:ro \
 --entrypoint /opt/spark/bin/spark-submit '__SPARK_IMAGE__' --master local[1] \
 /opt/planetory/manifest_to_parquet.py \
 'hdfs://planetory__STAGE__/.control/worker=*/bundle-*.manifest.jsonl' \
 'hdfs://planetory__STAGE__/manifest.parquet' "$count" '__SOURCE_SHA__' __SECTOR__
hdfs_cmd dfs -test -e '__STAGE__/manifest.parquet/_SUCCESS'
hdfs_cmd dfs -setrep -w 2 '__STAGE__/manifest.parquet'
python3 - "$ready" "$count" <<'PY'
import json,sys
value={'schema':'planetory.tess-hdfs-release.v1','run_id':'__RUN_ID__','release_id':'__DATA_RELEASE__',
       'source_list_sha256':'__SOURCE_SHA__','sector':__SECTOR__,'product_count':int(sys.argv[2]),'replication':2}
with open(sys.argv[1],'w',encoding='utf-8',newline='\n') as handle: json.dump(value,handle,sort_keys=True); handle.write('\n')
PY
if hdfs_cmd dfs -test -e '__STAGE__/_READY.json'; then
 hdfs_cmd dfs -rm -f '__STAGE__/_READY.json'
fi
hdfs_cmd dfs -put "$ready" '__STAGE__/_READY.json.part'
hdfs_cmd dfs -mv '__STAGE__/_READY.json.part' '__STAGE__/_READY.json'
hdfs_cmd dfs -mkdir -p '/lake/raw/tess/release=__DATA_RELEASE__'
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop
classpath='__RELEASE__/classes:'"$(/opt/hadoop/bin/hadoop classpath)"
sudo -u hdfs env JAVA_HOME="$JAVA_HOME" HADOOP_CONF_DIR="$HADOOP_CONF_DIR" \
 java -cp "$classpath" TessSequenceFileTool commit '__STAGE__' '__FINAL__'
hdfs_cmd dfs -cat '__FINAL__/_READY.json' | cmp -s "$ready" -
hdfs_cmd fsck '__FINAL__' -files -blocks > "$fsck"
grep -q 'Status: HEALTHY' "$fsck"
grep -Eq 'Under-replicated blocks:[[:space:]]+0' "$fsck"
grep -E 'Status: HEALTHY|Under-replicated blocks:|Missing blocks:|Corrupt blocks:' "$fsck"
echo COMMIT_OK final='__FINAL__' products="$count"
'@.Replace('__RUN_ID__',$RunId).Replace('__SECTOR__',[string]$Sector).Replace('__DATA_RELEASE__',$ReleaseId).Replace('__SOURCE_SHA__',$ExpectedSourceListSha256).Replace('__RELEASE__',$codeRelease).Replace('__STAGE__',$stage).Replace('__FINAL__',$final).Replace('__FINAL_URI__',$finalUri).Replace('__SLOT_ARGS__',$slotArgs).Replace('__SPARK_IMAGE__','apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1')
  Invoke-Remote $node1 $command 'Build manifest.parquet and atomically commit Raw sector'
 }
 'CoverageCommit' {
  $document=Get-CoverageDocument
  $coverageStage="/lake/raw/tess/.staging/coverage=$ExpectedCoverageSha256/run=$RunId"
  $coverageFinal="/lake/raw/tess/coverage=$ExpectedCoverageSha256"
  $command=@'
set -eu
hdfs_cmd() { sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"; }
source=/tmp/S15P21C206-76-__RUN_ID__-coverage-source.json
ready=/tmp/S15P21C206-76-__RUN_ID__-coverage-ready.json
existing=/tmp/S15P21C206-76-__RUN_ID__-coverage-existing.json
cleanup() { status=$?; trap - EXIT; sudo rm -f -- "$source" "$ready" "$existing"; exit "$status"; }
trap cleanup EXIT
printf '%s' '__COVERAGE_BASE64__' | base64 --decode > "$source"
test "$(sha256sum "$source" | cut -d ' ' -f 1)" = '__COVERAGE_SHA__'
sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH='__RELEASE__' \
 python3.12 '__RELEASE__/hdfs/tess_hdfs_load.py' coverage-ready --coverage-manifest "$source" \
 --expected-sha '__COVERAGE_SHA__' --output "$ready"
if hdfs_cmd dfs -test -e '__COVERAGE_FINAL__'; then
 hdfs_cmd dfs -cat '__COVERAGE_FINAL__/_READY.json' > "$existing"
 cmp -s "$ready" "$existing" || { echo COVERAGE_READY_CONFLICT >&2; exit 1; }
 echo COVERAGE_COMMIT_CACHED final='__COVERAGE_FINAL__'
 exit 0
fi
hdfs_cmd dfs -mkdir -p '__COVERAGE_STAGE__'
unexpected=$(hdfs_cmd dfs -find '__COVERAGE_STAGE__' | grep -Ev '^__COVERAGE_STAGE__$|^__COVERAGE_STAGE__/_READY.json(.part)?$' || true)
test -z "$unexpected" || { echo "COVERAGE_STAGE_UNEXPECTED=$unexpected" >&2; exit 1; }
if hdfs_cmd dfs -test -e '__COVERAGE_STAGE__/_READY.json'; then
 hdfs_cmd dfs -cat '__COVERAGE_STAGE__/_READY.json' > "$existing"
 cmp -s "$ready" "$existing" || { echo COVERAGE_STAGE_CONFLICT >&2; exit 1; }
else
 if hdfs_cmd dfs -test -e '__COVERAGE_STAGE__/_READY.json.part'; then hdfs_cmd dfs -rm -f '__COVERAGE_STAGE__/_READY.json.part'; fi
 hdfs_cmd dfs -put "$ready" '__COVERAGE_STAGE__/_READY.json.part'
 hdfs_cmd dfs -mv '__COVERAGE_STAGE__/_READY.json.part' '__COVERAGE_STAGE__/_READY.json'
fi
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop
classpath='__RELEASE__/classes:'"$(/opt/hadoop/bin/hadoop classpath)"
sudo -u hdfs env JAVA_HOME="$JAVA_HOME" HADOOP_CONF_DIR="$HADOOP_CONF_DIR" \
 java -cp "$classpath" TessSequenceFileTool commit '__COVERAGE_STAGE__' '__COVERAGE_FINAL__'
hdfs_cmd dfs -cat '__COVERAGE_FINAL__/_READY.json' > "$existing"
cmp -s "$ready" "$existing"
echo COVERAGE_COMMIT_OK final='__COVERAGE_FINAL__'
'@.Replace('__RUN_ID__',$RunId).Replace('__COVERAGE_BASE64__',$document.Base64).Replace('__COVERAGE_SHA__',$ExpectedCoverageSha256).Replace('__RELEASE__',$codeRelease).Replace('__COVERAGE_STAGE__',$coverageStage).Replace('__COVERAGE_FINAL__',$coverageFinal)
  Invoke-Remote $node1 $command 'Atomically commit Sector 1-13 HDFS coverage'
 }
 'RunAll' {
  $runStarted=[DateTimeOffset]::UtcNow
  if ($ExpectedCoverageSha256) {
   $document=Get-CoverageDocument
   $contexts=@($document.Map.sectors)
  } else {
   $contexts=@(3..5 | ForEach-Object {
    [pscustomobject]@{sector=$_;run_id=$RunId;release_id=$ReleaseId;source_list_sha256=$ExpectedSourceListSha256;total_bytes=$ExpectedSectorBytes}
   })
  }
  $first=$contexts[0]
  Invoke-OrchestratedStep 'Preflight' ([int]$first.sector) ([string]$first.run_id) ([string]$first.source_list_sha256) ([string]$first.release_id) ([long]$first.total_bytes)
  Invoke-OrchestratedStep 'Install' ([int]$first.sector) ([string]$first.run_id) ([string]$first.source_list_sha256) ([string]$first.release_id) ([long]$first.total_bytes)
  foreach ($context in $contexts) {
   $currentSector=[int]$context.sector
   $currentRunId=[string]$context.run_id
   $currentSourceSha=[string]$context.source_list_sha256
   $currentReleaseId=[string]$context.release_id
   $currentBytes=[long]$context.total_bytes
   Write-Host "RUN_ALL_PREFLIGHT sector=$currentSector run=$currentRunId"
   Invoke-OrchestratedStep 'Preflight' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
   $currentFinal="/lake/raw/tess/release=$currentReleaseId/sector=$('{0:D4}' -f $currentSector)"
   Write-Host "RUN_ALL_SECTOR_START sector=$currentSector"
   if (Test-HdfsPath $currentFinal) {
    Invoke-OrchestratedStep 'Commit' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
    Write-Host "RUN_ALL_SECTOR_CACHED sector=$currentSector"
    continue
   }
   Invoke-OrchestratedStep 'Build' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
   Invoke-OrchestratedStep 'Upload' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
   Wait-HdfsUploaders $currentSector $currentRunId
   Invoke-OrchestratedStep 'Audit' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
   Invoke-OrchestratedStep 'Commit' $currentSector $currentRunId $currentSourceSha $currentReleaseId $currentBytes
   Write-Host "RUN_ALL_SECTOR_COMPLETE sector=$currentSector"
  }
  if ($ExpectedCoverageSha256) {
   Invoke-OrchestratedStep 'CoverageCommit' 1 $RunId $ExpectedSourceListSha256 $ReleaseId 0
  }
  $elapsed=[Math]::Round(([DateTimeOffset]::UtcNow-$runStarted).TotalMinutes,1)
  Write-Host "RUN_ALL_COMPLETE sectors=$(@($contexts.sector) -join ',') elapsed_minutes=$elapsed"
 }
}

Write-Host "PASS: $Step"

[CmdletBinding(SupportsShouldProcess,ConfirmImpact='High')]
param(
 [Parameter(Mandatory)]
 [ValidateSet('Preflight','Install','SourceList','Start','Status','Progress','Pause','Audit','InstallSupervisor','SupervisorStatus','TestSupervisorRestart','TestSupervisorWatchdog')]
 [string]$Step,
 [Parameter(Mandatory)][ValidatePattern('^\d{8}T\d{6}Z$')][string]$RunId,
 [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSourceListSha256,
 [ValidateSet(3,4,5)][int]$Sector=3,
 [ValidateRange(0,100000)][int]$Limit=0,
 [ValidateRange(1,1440)][int]$RateWindowMinutes=15,
 [string]$ReleaseId='',
 [ValidateCount(1,3)][ValidateSet(3,4,5)][int[]]$Sectors=(3..5),
 [ValidateCount(1,5)][ValidateSet(2,3,4,5,6)][int[]]$NodeNumbers=(2..6),
 [string]$LocalIngestionPath=(Join-Path $PSScriptRoot '../../../distributed-system/ingestion')
)
$ErrorActionPreference='Stop'
$ReleaseId=if ($ReleaseId) { $ReleaseId } else { $RunId }
if ($ReleaseId -notmatch '^\d{8}T\d{6}Z$') { throw 'ReleaseId must use UTC yyyyMMddTHHmmssZ.' }

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { throw 'Install Tailscale CLI and join the project tailnet first.' }
$LocalIngestionPath=(Resolve-Path $LocalIngestionPath).Path
$mutatingSteps=@('Install','SourceList','Start','Pause','Audit','InstallSupervisor','TestSupervisorRestart','TestSupervisorWatchdog')
if ($Step -in $mutatingSteps -and -not $PSCmdlet.ShouldProcess("Worker $($NodeNumbers -join ',')","S15P21C206-75 $Step Sector $Sector run $RunId")) { return }

function Invoke-Tailscale {
 $output=@(& tailscale @args 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "tailscale failed ($exitCode): $($args -join ' ')`n$($output -join "`n")" }
 $output
}

function Invoke-Remote {
 param([int]$Node,[string]$Command,[string]$Label)
 $Command=$Command.Replace("`r",'')
 Write-Host "== worker-$Node $Label =="
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
 $remote="printf '%s' '$payload' | base64 --decode | bash"
 $output=@(& tailscale ssh "planetory-admin@node-$Node" $remote 2>&1)
 $exitCode=$LASTEXITCODE
 $output | ForEach-Object { Write-Host $_ }
 if ($exitCode -ne 0) { throw "worker-$Node $Label failed (exit $exitCode)." }
}

function Invoke-RemoteCapture {
 param([int]$Node,[string]$Command,[string]$Label)
 $Command=$Command.Replace("`r",'')
 $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Command))
 $remote="printf '%s' '$payload' | base64 --decode | bash"
 $output=@(& tailscale ssh "planetory-admin@node-$Node" $remote 2>&1)
 $exitCode=$LASTEXITCODE
 if ($exitCode -ne 0) { throw "worker-$Node $Label failed (exit $exitCode):`n$($output -join "`n")" }
 $output
}

function Format-ByteRate([double]$BytesPerSecond) {
 if ($BytesPerSecond -ge 1MB) { return ('{0:N2} MiB/s' -f ($BytesPerSecond / 1MB)) }
 if ($BytesPerSecond -ge 1KB) { return ('{0:N2} KiB/s' -f ($BytesPerSecond / 1KB)) }
 return ('{0:N0} B/s' -f $BytesPerSecond)
}

function Format-ByteCount([double]$Bytes) {
 if ($Bytes -ge 1GB) { return ('{0:N2} GiB' -f ($Bytes / 1GB)) }
 if ($Bytes -ge 1MB) { return ('{0:N2} MiB' -f ($Bytes / 1MB)) }
 return ('{0:N2} KiB' -f ($Bytes / 1KB))
}

function Format-Eta([double]$Seconds) {
 if ([double]::IsNaN($Seconds) -or [double]::IsInfinity($Seconds) -or $Seconds -lt 0) { return 'unknown' }
 $span=[TimeSpan]::FromSeconds($Seconds)
 if ($span.TotalDays -ge 1) { return ('{0}d {1:00}h {2:00}m' -f [Math]::Floor($span.TotalDays),$span.Hours,$span.Minutes) }
 return ('{0}h {1:00}m' -f [Math]::Floor($span.TotalHours),$span.Minutes)
}

function Assert-RemoteHost {
 param([int]$Node)
 $null=Invoke-Tailscale ping --timeout=5s --until-direct=false "node-$Node"
 $actual=@(Invoke-Tailscale ssh "planetory-admin@node-$Node" hostname -s) | Select-Object -Last 1
 if (-not $actual -or $actual.Trim() -ne "worker-$Node") { throw "node-$Node must resolve to worker-$Node." }
}

function New-Bundle {
 $required=@('ingestion','config','requirements.txt')
 foreach ($item in $required) {
  if (-not (Test-Path (Join-Path $LocalIngestionPath $item))) { throw "Missing ingestion bundle item: $item" }
 }
 $archive=Join-Path ([IO.Path]::GetTempPath()) "S15P21C206-75-$ReleaseId-$PID.tgz"
 try {
  $hasher=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
  try {
   $files=foreach ($item in $required) {
    Get-ChildItem -LiteralPath (Join-Path $LocalIngestionPath $item) -Recurse -File
   }
   foreach ($file in ($files | Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]|\.pyc$' } | Sort-Object FullName)) {
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
  } finally { $hasher.Dispose() }
  & tar -czf $archive '--exclude=__pycache__' '--exclude=*.pyc' -C $LocalIngestionPath @required
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create ingestion bundle.' }
  [pscustomobject]@{
   Path=$archive
   ArchiveSha256=(Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
   ContentSha256=$contentSha
   Base64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($archive))
  }
 } catch {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  throw
 }
}

$release="/mnt/data/planetory-ingestion/releases/$ReleaseId"
$runRoot="/mnt/data/staging/S15P21C206-75/run-$RunId"
$sourceList="$runRoot/manifests/tess-service-v1.json"
$rawRoot="$runRoot/raw"

switch ($Step) {
 'Preflight' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $command=@'
set -eu
test "$(hostname -s)" = 'worker-__NODE__'
test "$(python3.12 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" = 3.12
mountpoint -q /mnt/data
sudo -n true
disk_percent=$(df -P /mnt/data | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
test "$disk_percent" -lt 75
python3.12 - <<'PY'
import urllib.request
response=urllib.request.urlopen('https://archive.stsci.edu/missions/tess/download_scripts/sector/tesscurl_sector_3_lc.sh', timeout=20)
assert response.status == 200
response.close()
PY
echo PREFLIGHT_OK host=$(hostname -s) disk_percent=$disk_percent
'@.Replace('__NODE__',[string]$node)
   Invoke-Remote $node $command 'preflight'
  }
 }
 'Install' {
  $bundle=New-Bundle
  try {
   foreach ($node in $NodeNumbers) {
    Assert-RemoteHost $node
    $command=@'
set -eu
release='__RELEASE__'
run_root='__RUN_ROOT__'
archive=/tmp/S15P21C206-75-__RUN_ID__-ingestion.tgz
cleanup() { status=$?; trap - EXIT; rm -f -- "$archive"; exit "$status"; }
trap cleanup EXIT
sudo install -d -o "$(id -un)" -g "$(id -gn)" "$release" "$run_root" "$run_root/manifests" "$run_root/logs" "$run_root/pids" "$run_root/raw"
if test -f "$release/READY"; then
 if test "$(cat "$release/READY")" = '__CONTENT_SHA__'; then
  echo INSTALL_CACHED content_sha256=__CONTENT_SHA__
  exit 0
 fi
 echo RELEASE_ID_CONFLICT release="$release" >&2
 exit 1
fi
if test -d "$release" && test -n "$(find "$release" -mindepth 1 -maxdepth 1 -print -quit)"; then
 echo INCOMPLETE_RELEASE_CONFLICT release="$release" >&2
 exit 1
fi
printf '%s' '__BUNDLE_BASE64__' | base64 --decode > "$archive"
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = '__ARCHIVE_SHA__'
tar -xzf "$archive" -C "$release"
python3.12 -m compileall -q "$release/ingestion"
printf '%s\n' '__CONTENT_SHA__' > "$release/READY"
sudo chown -R root:root "$release"
sudo chmod -R go-w "$release"
echo INSTALL_OK release="$release" content_sha256=__CONTENT_SHA__ archive_sha256=__ARCHIVE_SHA__
'@.Replace('__RELEASE__',$release).Replace('__RUN_ROOT__',$runRoot).Replace('__RUN_ID__',$RunId).Replace('__CONTENT_SHA__',$bundle.ContentSha256).Replace('__ARCHIVE_SHA__',$bundle.ArchiveSha256).Replace('__BUNDLE_BASE64__',$bundle.Base64)
    Invoke-Remote $node $command 'install immutable run bundle'
   }
  } finally {
   Remove-Item -LiteralPath $bundle.Path -Force -ErrorAction SilentlyContinue
  }
 }
 'SourceList' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $command=@'
set -eu
release='__RELEASE__'
source_list='__SOURCE_LIST__'
test -f "$release/READY"
cd "$release"
python3.12 -m ingestion source-list --config config/service-v1.json --output "$source_list"
actual=$(PYTHONPATH="$release" python3.12 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["source_list_sha256"])' "$source_list")
test "$actual" = '__EXPECTED_SHA__'
echo SOURCE_LIST_VERIFIED sha256="$actual"
'@.Replace('__RELEASE__',$release).Replace('__SOURCE_LIST__',$sourceList).Replace('__EXPECTED_SHA__',$ExpectedSourceListSha256)
   Invoke-Remote $node $command 'generate and verify source list'
  }
 }
 'Start' {
 foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $limitArg=if ($Limit -gt 0) { "--limit $Limit" } else { '' }
   $command=@'
set -eu
release='__RELEASE__'
run_root='__RUN_ROOT__'
source_list='__SOURCE_LIST__'
raw_root='__RAW_ROOT__'
pid_file="$run_root/pids/sector-__SECTOR__-worker-__SLOT__.pid"
exit_file="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.exit"
events="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.events.jsonl"
manifest="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.run.json"
log="$run_root/logs/sector-__SECTOR__-worker-__SLOT__.log"
test -f "$release/READY"
test -f "$source_list"
sudo chown -R root:root "$release"
sudo chmod -R go-w "$release"
test "$(stat -c '%U:%G' "$release")" = root:root
actual=$(PYTHONPATH="$release" python3.12 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["source_list_sha256"])' "$source_list")
test "$actual" = '__EXPECTED_SHA__'
if test -f "$pid_file" && kill -0 "$(cat "$pid_file")" 2>/dev/null; then echo INGESTION_ALREADY_RUNNING >&2; exit 1; fi
rm -f -- "$exit_file" "$manifest"
nohup bash -c '
 set +e
 cd "__RELEASE__"
 PYTHONPATH="__RELEASE__" python3.12 -u -m ingestion download \
  --config config/service-v1.json --source-list "__SOURCE_LIST__" --output "__RAW_ROOT__" \
  --events "__EVENTS__" --run-manifest "__MANIFEST__" --worker-slot __SLOT__ --sector __SECTOR__ __LIMIT_ARG__
 code=$?
 printf "%s\n" "$code" > "__EXIT_FILE__.part"
 mv "__EXIT_FILE__.part" "__EXIT_FILE__"
 exit "$code"
' > "$log" 2>&1 < /dev/null &
pid=$!
printf '%s\n' "$pid" > "$pid_file"
sleep 1
kill -0 "$pid"
echo INGESTION_STARTED pid="$pid" sector=__SECTOR__ worker_slot=__SLOT__ log="$log"
'@.Replace('__RELEASE__',$release).Replace('__RUN_ROOT__',$runRoot).Replace('__SOURCE_LIST__',$sourceList).Replace('__RAW_ROOT__',$rawRoot).Replace('__EXPECTED_SHA__',$ExpectedSourceListSha256).Replace('__SECTOR__',[string]$Sector).Replace('__SLOT__',[string]$slot).Replace('__LIMIT_ARG__',$limitArg).Replace('__EVENTS__',"$runRoot/manifests/sector-$Sector-worker-$slot.events.jsonl").Replace('__MANIFEST__',"$runRoot/manifests/sector-$Sector-worker-$slot.run.json").Replace('__EXIT_FILE__',"$runRoot/manifests/sector-$Sector-worker-$slot.exit")
   Invoke-Remote $node $command 'start sector download'
  }
 }
 'Status' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $command=@'
set -eu
run_root='__RUN_ROOT__'
pid_file="$run_root/pids/sector-__SECTOR__-worker-__SLOT__.pid"
exit_file="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.exit"
events="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.events.jsonl"
manifest="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.run.json"
log="$run_root/logs/sector-__SECTOR__-worker-__SLOT__.log"
pid=$(cat "$pid_file" 2>/dev/null || true)
if test -n "$pid" && kill -0 "$pid" 2>/dev/null; then state=RUNNING; elif test -f "$exit_file"; then state=FINISHED; else state=NOT_STARTED; fi
events_count=$(wc -l < "$events" 2>/dev/null || echo 0)
final_count=$(find "$run_root/raw/sector=000__SECTOR__" -maxdepth 1 -type f -name '*.fits' 2>/dev/null | wc -l)
part_count=$(find "$run_root/raw/sector=000__SECTOR__" -maxdepth 1 -type f -name '*.part' 2>/dev/null | wc -l)
disk_percent=$(df -P /mnt/data | awk 'NR==2 {print $5}')
echo STATUS state="$state" pid="${pid:-none}" exit=$(cat "$exit_file" 2>/dev/null || echo pending) events="$events_count" fits="$final_count" parts="$part_count" disk="$disk_percent"
if test "$state" = FINISHED && test -f "$manifest"; then cat "$manifest"; fi
test -f "$log" && tail -n 3 "$log" || true
'@.Replace('__RUN_ROOT__',$runRoot).Replace('__SECTOR__',[string]$Sector).Replace('__SLOT__',[string]$slot)
   Invoke-Remote $node $command 'status'
  }
 }
 'Progress' {
  $metrics=@()
  $sectorCsv=($Sectors -join ',')
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $command=@'
set -eu
source_list='__SOURCE_LIST__'
run_root='__RUN_ROOT__'
test -f "$source_list"
python3.12 - "$source_list" "$run_root" __SLOT__ '__SECTORS__' __WINDOW_MINUTES__ '__EXPECTED_SHA__' <<'PY'
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
run_root = Path(sys.argv[2])
slot = int(sys.argv[3])
sectors = {int(value) for value in sys.argv[4].split(',')}
window_seconds = int(sys.argv[5]) * 60
expected_sha = sys.argv[6]
source = json.loads(source_path.read_text(encoding='utf-8'))
if source.get('schema') != 'planetory.tess-source-list.v1':
    raise SystemExit('SOURCE_LIST_SCHEMA_MISMATCH')
if source.get('source_list_sha256') != expected_sha:
    raise SystemExit('SOURCE_LIST_SHA256_MISMATCH')
if int(source.get('product_count', -1)) != len(source.get('products', [])):
    raise SystemExit('SOURCE_LIST_PRODUCT_COUNT_MISMATCH')
digest = hashlib.sha256()
for product in sorted(source['products'], key=lambda value: (int(value['sector']), value['filename'])):
    digest.update(
        f"{int(product['sector'])}\t{int(product['tic_id'])}\t{product['filename']}\t{product['mast_uri']}\t{int(product['assigned_worker'])}\n".encode('utf-8')
    )
if digest.hexdigest() != expected_sha:
    raise SystemExit('SOURCE_LIST_CONTENT_MISMATCH')

products = [
    product for product in source['products']
    if int(product['assigned_worker']) == slot and int(product['sector']) in sectors
]
selected_filenames = {product['filename'] for product in products}
latest = {}
recent_bytes = 0
now = dt.datetime.now(dt.timezone.utc)
for sector in sectors:
    path = run_root / 'manifests' / f'sector-{sector}-worker-{slot}.events.jsonl'
    if not path.is_file():
        continue
    content = path.read_bytes()
    if content and not content.endswith(b'\n'):
        content = content[:content.rfind(b'\n') + 1]
    for line_number, line in enumerate(content.splitlines(), 1):
        try:
            event = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit(f'INVALID_EVENT_JSON path={path} line={line_number}: {error}') from error
        filename = event.get('filename')
        if filename:
            latest[filename] = event
        if event.get('status') != 'VALIDATED' or event.get('cached'):
            continue
        recorded = event.get('recorded_at')
        if not recorded:
            continue
        moment = dt.datetime.fromisoformat(recorded.replace('Z', '+00:00'))
        if 0 <= (now - moment).total_seconds() <= window_seconds:
            recent_bytes += int(event.get('bytes_transferred', 0))

validated = [
    event for filename, event in latest.items()
    if filename in selected_filenames
    and event.get('status') == 'VALIDATED'
]
completed_bytes = sum(int(event.get('size_bytes', 0)) for event in validated)
partial_bytes = 0
for sector in sectors:
    directory = run_root / 'raw' / f'sector={sector:04d}'
    if directory.is_dir():
        partial_bytes += sum(path.stat().st_size for path in directory.glob('*.part'))
state_path = run_root / 'manifests' / f'supervisor-worker-{slot}.json'
state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.is_file() else {}
print(json.dumps({
    'node': slot + 1,
    'worker_slot': slot,
    'status': state.get('status', 'UNKNOWN'),
    'sector': state.get('sector'),
    'total': len(products),
    'completed': len(validated),
    'completed_bytes': completed_bytes,
    'partial_bytes': partial_bytes,
    'recent_bytes': recent_bytes,
    'window_seconds': window_seconds,
}, separators=(',', ':')))
PY
'@.Replace('__SOURCE_LIST__',$sourceList).Replace('__RUN_ROOT__',$runRoot).Replace('__SLOT__',[string]$slot).Replace('__SECTORS__',$sectorCsv).Replace('__WINDOW_MINUTES__',[string]$RateWindowMinutes).Replace('__EXPECTED_SHA__',$ExpectedSourceListSha256)
   $json=@(Invoke-RemoteCapture $node $command 'read ingestion progress') | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
   if (-not $json) { throw "worker-$node returned no progress metric." }
   $metric=$json | ConvertFrom-Json
   $metrics += $metric
   $percent=if ($metric.total -gt 0) { 100.0 * $metric.completed / $metric.total } else { 0.0 }
   $rate=[double]$metric.recent_bytes / [double]$metric.window_seconds
   Write-Output ('WORKER node={0} status={1} sector={2} files={3}/{4} percent={5:N2}% verified={6} partial={7} rate={8}' -f $metric.node,$metric.status,($metric.sector ?? '-'),$metric.completed,$metric.total,$percent,(Format-ByteCount $metric.completed_bytes),(Format-ByteCount $metric.partial_bytes),(Format-ByteRate $rate))
  }
  $total=[double](($metrics | Measure-Object -Property total -Sum).Sum)
  $completed=[double](($metrics | Measure-Object -Property completed -Sum).Sum)
  $completedBytes=[double](($metrics | Measure-Object -Property completed_bytes -Sum).Sum)
  $partialBytes=[double](($metrics | Measure-Object -Property partial_bytes -Sum).Sum)
  $recentBytes=[double](($metrics | Measure-Object -Property recent_bytes -Sum).Sum)
  $windowSeconds=[double]($RateWindowMinutes * 60)
  $rate=$recentBytes / $windowSeconds
  $percent=if ($total -gt 0) { 100.0 * $completed / $total } else { 0.0 }
  $averageSize=if ($completed -gt 0) { $completedBytes / $completed } else { 0.0 }
  $remainingBytes=[Math]::Max(0.0,($total - $completed) * $averageSize)
  $eta=if ($rate -gt 0 -and $averageSize -gt 0) { Format-Eta ($remainingBytes / $rate) } else { 'unknown' }
  Write-Output ('TOTAL run={0} sectors={1} files={2}/{3} percent={4:N2}% verified={5} partial={6} rate={7} window={8}m eta={9}' -f $RunId,$sectorCsv,$completed,$total,$percent,(Format-ByteCount $completedBytes),(Format-ByteCount $partialBytes),(Format-ByteRate $rate),$RateWindowMinutes,$eta)
 }
 'Pause' {
  $sectorExplicit=if ($PSBoundParameters.ContainsKey('Sector')) { 'true' } else { 'false' }
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $unitName="planetory-tess-ingestion-$RunId-worker-$slot.service"
   $command=@'
set -eu
unit='__UNIT_NAME__'
run_root='__RUN_ROOT__'
slot='__SLOT__'
requested_sector='__SECTOR__'
sector_explicit='__SECTOR_EXPLICIT__'
state_file="$run_root/manifests/supervisor-worker-$slot.json"
detected_sector=$(python3.12 - "$state_file" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    print('')
else:
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('status') == 'COMPLETE':
        print('COMPLETE')
        raise SystemExit(0)
    sector = value.get('sector')
    print(sector if sector in (3, 4, 5) else '')
PY
)
if test "$detected_sector" = COMPLETE; then
 echo "PAUSE_NOT_REQUIRED status=COMPLETE"
 exit 0
fi
if test -n "$detected_sector"; then
 if test "$sector_explicit" = true && test "$requested_sector" != "$detected_sector"; then
  echo "PAUSE_SECTOR_MISMATCH requested=$requested_sector active=$detected_sector" >&2
  exit 1
 fi
 sector=$detected_sector
else
 sector=$requested_sector
fi
case "$sector" in 3|4|5) ;; *) echo "INVALID_PAUSE_SECTOR sector=$sector" >&2; exit 1;; esac
pid_file="$run_root/pids/sector-$sector-worker-$slot.pid"
sudo systemctl stop "$unit"
state=$(systemctl is-active "$unit" 2>/dev/null || true)
test "$state" = inactive
matched=''
for pid in $(pgrep -f 'python3.12 -u -m ingestion download' 2>/dev/null || true); do
 test -r "/proc/$pid/cmdline" || continue
 process_command=$(tr '\000' ' ' < "/proc/$pid/cmdline")
 case "$process_command" in
  *"--source-list $run_root/manifests/tess-service-v1.json"*"--output $run_root/raw"*"--worker-slot $slot"*"--sector $sector"*)
   test -z "$matched" || { echo "MULTIPLE_MATCHING_DOWNLOADERS first=$matched second=$pid" >&2; exit 1; }
   matched=$pid
   ;;
 esac
done
forced=false
if test -n "$matched" && kill -0 "$matched" 2>/dev/null; then
 kill -TERM "$matched"
 attempt=0
 while kill -0 "$matched" 2>/dev/null && test "$attempt" -lt 30; do
  sleep 1
  attempt=$((attempt + 1))
 done
 if kill -0 "$matched" 2>/dev/null; then
  kill -KILL "$matched"
  forced=true
 fi
else
 matched=none
fi
legacy=$(cat "$pid_file" 2>/dev/null || true)
if test -n "$legacy"; then
 attempt=0
 while kill -0 "$legacy" 2>/dev/null && test "$attempt" -lt 10; do
  sleep 1
  attempt=$((attempt + 1))
 done
fi
remaining=0
for pid in $(pgrep -f 'python3.12 -u -m ingestion download' 2>/dev/null || true); do
 test -r "/proc/$pid/cmdline" || continue
 process_command=$(tr '\000' ' ' < "/proc/$pid/cmdline")
 case "$process_command" in
  *"$run_root"*"--worker-slot $slot"*) remaining=$((remaining + 1));;
 esac
done
test "$remaining" -eq 0
sector_dir=$(printf '%04d' "$sector")
fits=$(find "$run_root/raw/sector=$sector_dir" -maxdepth 1 -type f -name '*.fits' 2>/dev/null | wc -l)
parts=$(find "$run_root/raw/sector=$sector_dir" -maxdepth 1 -type f -name '*.part' 2>/dev/null | wc -l)
part_bytes=$(find "$run_root/raw/sector=$sector_dir" -maxdepth 1 -type f -name '*.part' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')
events_file="$run_root/manifests/sector-$sector-worker-$slot.events.jsonl"
events=$(wc -l < "$events_file" 2>/dev/null || echo 0)
pause_file="$run_root/manifests/pause-worker-$slot.json"
python3.12 - "$state_file" "$pause_file" "$slot" "$sector" "$state" "$matched" "$forced" "$fits" "$parts" "$part_bytes" "$events" <<'PY'
import datetime as dt
import json
import os
import sys
from pathlib import Path

state_path, pause_path = map(Path, sys.argv[1:3])
slot, sector = map(int, sys.argv[3:5])
unit_state, downloader_pid, forced = sys.argv[5:8]
fits, parts, part_bytes, events = map(int, sys.argv[8:12])
recorded_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

def atomic(path, value):
    temporary = path.with_name(path.name + '.part')
    with temporary.open('w', encoding='utf-8', newline='\n') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)

atomic(pause_path, {
    'schema': 'planetory.ingestion-pause.v1',
    'paused_at': recorded_at,
    'worker_slot': slot,
    'sector': sector,
    'unit_state': unit_state,
    'downloader_pid': downloader_pid,
    'forced': forced == 'true',
    'fits': fits,
    'parts': parts,
    'part_bytes': part_bytes,
    'events': events,
})
atomic(state_path, {
    'schema': 'planetory.ingestion-supervisor.v1',
    'updated_at': recorded_at,
    'status': 'PAUSED_OPERATOR',
    'worker_slot': slot,
    'sector': sector,
    'pause_manifest': str(pause_path),
})
PY
echo "PAUSED_OK host=$(hostname -s) unit=$state sector=$sector downloader_pid=$matched forced=$forced fits=$fits parts=$parts part_bytes=$part_bytes events=$events pause_manifest=$pause_file"
'@.Replace('__UNIT_NAME__',$unitName).Replace('__RUN_ROOT__',$runRoot).Replace('__SLOT__',[string]$slot).Replace('__SECTOR__',[string]$Sector).Replace('__SECTOR_EXPLICIT__',$sectorExplicit)
   Invoke-Remote $node $command 'pause supervisor and matching downloader'
  }
 }
 'Audit' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $limitArg=if ($Limit -gt 0) { "--limit $Limit" } else { '' }
   $command=@'
set -eu
release='__RELEASE__'
run_root='__RUN_ROOT__'
exit_file="$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.exit"
test -f "$exit_file"
test "$(cat "$exit_file")" = 0
cd "$release"
PYTHONPATH="$release" python3.12 -m ingestion audit \
 --source-list '__SOURCE_LIST__' --output '__RAW_ROOT__' \
 --events "$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.events.jsonl" \
 --audit-manifest "$run_root/manifests/sector-__SECTOR__-worker-__SLOT__.audit.json" \
 --worker-slot __SLOT__ --sector __SECTOR__ __LIMIT_ARG__
'@.Replace('__RELEASE__',$release).Replace('__RUN_ROOT__',$runRoot).Replace('__SOURCE_LIST__',$sourceList).Replace('__RAW_ROOT__',$rawRoot).Replace('__SECTOR__',[string]$Sector).Replace('__SLOT__',[string]$slot).Replace('__LIMIT_ARG__',$limitArg)
   Invoke-Remote $node $command 'audit completed sector'
  }
 }
 'InstallSupervisor' {
  $sectorArgs=($Sectors | ForEach-Object { "--sector $_" }) -join ' '
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $unitName="planetory-tess-ingestion-$RunId-worker-$slot.service"
   $unit=@"
[Unit]
Description=Planetory TESS ingestion run $RunId worker $slot
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/mnt/data
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=main
WatchdogSec=5min
User=planetory-admin
WorkingDirectory=$release
Environment=PYTHONPATH=$release
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=/usr/bin/python3.12 -m ingestion supervise --config $release/config/service-v1.json --source-list $sourceList --expected-source-list-sha256 $ExpectedSourceListSha256 --output $rawRoot --run-root $runRoot --worker-slot $slot $sectorArgs
Restart=on-failure
RestartSec=30s
TimeoutStopSec=30s
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$runRoot

[Install]
WantedBy=multi-user.target
"@
   $unitBase64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($unit.Replace("`r",'')))
   $command=@'
set -eu
release='__RELEASE__'
run_root='__RUN_ROOT__'
source_list='__SOURCE_LIST__'
unit='__UNIT_NAME__'
temporary=/tmp/S15P21C206-75-__RUN_ID__-worker-__SLOT__.service
cleanup() { status=$?; trap - EXIT; rm -f -- "$temporary"; exit "$status"; }
trap cleanup EXIT
test -f "$release/READY"
test -f "$source_list"
actual=$(PYTHONPATH="$release" python3.12 -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="utf-8"))["source_list_sha256"])' "$source_list")
test "$actual" = '__EXPECTED_SHA__'
printf '%s' '__UNIT_BASE64__' | base64 --decode > "$temporary"
sudo install -o root -g root -m 0644 "$temporary" "/etc/systemd/system/$unit"
sudo systemctl daemon-reload
sudo systemctl enable "$unit"
sudo systemctl restart "$unit"
sudo systemctl is-enabled --quiet "$unit"
sudo systemctl is-active --quiet "$unit"
sudo systemctl show "$unit" --property=ActiveState,SubState,MainPID,NRestarts --no-pager
'@.Replace('__RELEASE__',$release).Replace('__RUN_ROOT__',$runRoot).Replace('__SOURCE_LIST__',$sourceList).Replace('__RUN_ID__',$RunId).Replace('__SLOT__',[string]$slot).Replace('__UNIT_NAME__',$unitName).Replace('__EXPECTED_SHA__',$ExpectedSourceListSha256).Replace('__UNIT_BASE64__',$unitBase64)
   Invoke-Remote $node $command 'install and start ingestion supervisor'
  }
 }
 'SupervisorStatus' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $unitName="planetory-tess-ingestion-$RunId-worker-$slot.service"
   $command=@'
set -eu
unit='__UNIT_NAME__'
state='__RUN_ROOT__/manifests/supervisor-worker-__SLOT__.json'
sudo systemctl show "$unit" --property=LoadState,UnitFileState,ActiveState,SubState,Result,MainPID,NRestarts,ExecStart --no-pager
test -f "$state" && cat "$state" || true
sudo journalctl -u "$unit" -n 5 --no-pager
'@.Replace('__UNIT_NAME__',$unitName).Replace('__RUN_ROOT__',$runRoot).Replace('__SLOT__',[string]$slot)
   Invoke-Remote $node $command 'supervisor status'
  }
 }
 'TestSupervisorRestart' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $unitName="planetory-tess-ingestion-$RunId-worker-$slot.service"
   $command=@'
set -eu
unit='__UNIT_NAME__'
before_pid=$(sudo systemctl show "$unit" --property=MainPID --value)
before_restarts=$(sudo systemctl show "$unit" --property=NRestarts --value)
test "$before_pid" -gt 1
sudo systemctl kill --kill-who=main --signal=SIGKILL "$unit"
attempt=0
while test "$attempt" -lt 45; do
 sleep 2
 after_pid=$(sudo systemctl show "$unit" --property=MainPID --value)
 after_restarts=$(sudo systemctl show "$unit" --property=NRestarts --value)
 if test "$after_pid" -gt 1 && test "$after_pid" != "$before_pid" && test "$after_restarts" -gt "$before_restarts" && sudo systemctl is-active --quiet "$unit"; then
  echo SUPERVISOR_RESTART_OK before_pid="$before_pid" after_pid="$after_pid" before_restarts="$before_restarts" after_restarts="$after_restarts"
  exit 0
 fi
 attempt=$((attempt + 1))
done
sudo systemctl status "$unit" --no-pager || true
echo SUPERVISOR_RESTART_FAILED >&2
exit 1
'@.Replace('__UNIT_NAME__',$unitName)
   Invoke-Remote $node $command 'test supervisor SIGKILL restart'
  }
 }
 'TestSupervisorWatchdog' {
  foreach ($node in $NodeNumbers) {
   Assert-RemoteHost $node
   $slot=$node-1
   $unitName="planetory-tess-ingestion-$RunId-worker-$slot.service"
   $command=@'
set -eu
unit='__UNIT_NAME__'
before_pid=$(sudo systemctl show "$unit" --property=MainPID --value)
before_restarts=$(sudo systemctl show "$unit" --property=NRestarts --value)
watchdog_usec=$(sudo systemctl show "$unit" --property=WatchdogUSec --value)
test "$before_pid" -gt 1
test "$watchdog_usec" != 0
cleanup() {
 if kill -0 "$before_pid" 2>/dev/null; then sudo kill -CONT "$before_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
sudo kill -STOP "$before_pid"
attempt=0
while test "$attempt" -lt 240; do
 sleep 2
 after_pid=$(sudo systemctl show "$unit" --property=MainPID --value)
 after_restarts=$(sudo systemctl show "$unit" --property=NRestarts --value)
 if test "$after_pid" -gt 1 && test "$after_pid" != "$before_pid" && test "$after_restarts" -gt "$before_restarts" && sudo systemctl is-active --quiet "$unit"; then
  trap - EXIT
  echo WATCHDOG_RESTART_OK before_pid="$before_pid" after_pid="$after_pid" before_restarts="$before_restarts" after_restarts="$after_restarts" watchdog_usec="$watchdog_usec"
  exit 0
 fi
 attempt=$((attempt + 1))
done
sudo systemctl status "$unit" --no-pager || true
echo WATCHDOG_RESTART_FAILED >&2
exit 1
'@.Replace('__UNIT_NAME__',$unitName)
   Invoke-Remote $node $command 'test supervisor watchdog restart'
  }
 }
}

Write-Host "PASS: $Step"

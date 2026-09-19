# Offline cluster ingestion contract check: Tailscale is mocked and no remote resources are touched.
$ErrorActionPreference='Stop'
$calls=[Collections.Generic.List[string]]::new()

function tailscale {
 $calls.Add("tailscale $($args -join ' ')")
 $global:LASTEXITCODE=0
 if ($args[0] -eq 'ping') { return 'pong' }
 if ($args[0] -eq 'ssh' -and $args[2] -eq 'hostname') {
  $node=[int](($args[1] -split 'node-')[-1])
  return "worker-$node"
 }
 if ($args[0] -eq 'ssh') {
  return '{"node":2,"worker_slot":1,"status":"RUNNING","sector":3,"total":10,"completed":4,"completed_bytes":8388608,"partial_bytes":1048576,"recent_bytes":943718400,"window_seconds":900,"failed":1,"http_retries":3,"retry_429":2,"error_retries":1}'
 }
 return 'mock-remote-ok'
}

$script=Join-Path $PSScriptRoot 'run-tess-ingestion.ps1'
$common=@{RunId='20260918T120000Z';ExpectedSourceListSha256=('a'*64);Sector=3;NodeNumbers=@(2)}

& $script -Step Preflight @common
if ($calls -match 'sudo install|nohup|source-list') { throw 'Preflight must be read-only.' }

foreach ($step in 'Install','SourceList','Start','Pause','Audit','FinalCoverage','InstallSupervisor','TestSupervisorRestart','TestSupervisorWatchdog') {
 $calls.Clear()
 & $script -Step $step @common -WhatIf
 if ($calls.Count) { throw "$step WhatIf must stop before remote calls." }
}

foreach ($boundary in 1,13) {
 $calls.Clear()
 & $script -Step Start @common -Sector $boundary -WhatIf
 if ($calls.Count) { throw "Sector $boundary WhatIf must stop before remote calls." }
}
$calls.Clear()
& $script -Step InstallSupervisor @common -Sectors @(1,2,6,7,8,9,10,11,12,13) -WhatIf
if ($calls.Count) { throw 'Expanded supervisor WhatIf must stop before remote calls.' }

$calls.Clear()
$progress=@(& $script -Step Progress @common)
if (($progress -join "`n") -notmatch 'files=4/10.*percent=40[.,]00%') { throw 'Progress must aggregate completed files and percentage.' }
if (($progress -join "`n") -notmatch 'verified=8[.,]00 MiB.*partial=1[.,]00 MiB.*rate=1[.,]00 MiB/s') { throw 'Progress must report verified bytes, partial bytes and recent transfer rate.' }
if (($progress -join "`n") -notmatch 'failures=1.*failureRate=10[.,]0000%.*retry429=2.*httpRetries=3.*otherRetries=1') { throw 'Progress must report current failures and retry metrics.' }

$legacyProgress=@(& $script -Step Progress -RunId '20260918T080417Z' -ExpectedSourceListSha256 ('a'*64) -NodeNumbers 2)
if (($legacyProgress -join "`n") -notmatch 'sectors=3,4,5') {
 throw 'Legacy completed Run must keep the original Progress command without an added Sectors argument.'
}

$source=Get-Content -Raw $script
foreach ($required in (
 'disk_percent" -lt 75',
 'required_free_bytes=$((__MINIMUM_FREE_GIB__ * 1024 * 1024 * 1024))',
 "systemctl list-units --type=service --state=active 'planetory-tess-ingestion-*'",
 "pgrep -fc 'python3.12 -u -m ingestion download'",
 'sudo install -d',
 'python3.12 -m ingestion source-list',
 '--expected-source-list-sha256 ''__EXPECTED_SHA__''',
 'test "$actual" = ''__EXPECTED_SHA__''',
 '--worker-slot __SLOT__ --sector __SECTOR__ __LIMIT_ARG__',
 'nohup bash -c',
 'INGESTION_ALREADY_RUNNING',
 'python3.12 -m ingestion audit',
 'python3.12 -m ingestion coverage',
 "sector_dir=`$(printf 'sector=%04d' __SECTOR__)",
 'if test -f "$events"; then events_count=$(wc -l < "$events"); else events_count=0; fi',
 "retry_429 = sum(int(event.get('http_retries', {}).get('429', 0)) for event in validated)",
 '--worker-slot __SLOT__ --sector __SECTOR__ __LIMIT_ARG__',
 'rm -f -- "$exit_file" "$manifest"',
 'rm -f -- "$archive"',
 'RELEASE_ID_CONFLICT',
 'content_sha256=__CONTENT_SHA__',
 'sudo chown -R root:root "$release"',
 'Type=notify',
 'NotifyAccess=main',
 'WatchdogSec=5min',
 'Restart=on-failure',
 'RequiresMountsFor=/mnt/data',
 'StartLimitIntervalSec=0',
 'ProtectSystem=strict',
 'ReadWritePaths=$runRoot $globalLockRoot',
 'python3.12 -m ingestion supervise',
 'sudo install -d -o planetory-admin -g planetory-admin -m 0750 "$global_lock_root"',
 'test "$old_status" = COMPLETE',
 'EXISTING_SUPERVISOR_ACTIVE',
 'sudo systemctl disable "$existing_unit"',
 'sudo systemctl enable "$unit"',
 'sudo systemctl restart "$unit"',
 'sudo systemctl kill --kill-who=main --signal=SIGKILL "$unit"',
  'SUPERVISOR_RESTART_OK',
  'sudo kill -STOP "$before_pid"',
  'WatchdogUSec',
  'WATCHDOG_RESTART_OK',
  'sudo systemctl stop "$unit"',
  '*"--source-list $run_root/manifests/tess-service-v1.json"*"--output $run_root/raw"*"--worker-slot $slot"*"--sector $sector"*',
  'PAUSE_SECTOR_MISMATCH',
  'kill -TERM "$matched"',
  'test "$remaining" -eq 0',
  'planetory.ingestion-pause.v1',
  'PAUSED_OPERATOR',
  'PAUSED_OK',
 'source_list_sha256',
 'bytes_transferred',
 'window_seconds',
 "glob('*.part')",
 'INVALID_EVENT_JSON',
 'SOURCE_LIST_CONTENT_MISMATCH',
 'SOURCE_LIST_SCHEMA_MISMATCH',
 'PAUSE_NOT_REQUIRED status=COMPLETE',
 'planetory.ingestion-coverage-shard.v1',
 'planetory.ingestion-coverage.v1',
 'coverage-sectors-1-13.json',
 'FinalCoverage requires expansion Sectors',
 "'Progress'"
)) {
 if ($source -notmatch [regex]::Escape($required)) { throw "Missing cluster ingestion contract: $required" }
}

$config=Get-Content -Raw (Join-Path $PSScriptRoot '../../../distributed-system/ingestion/config/service-v1.json') | ConvertFrom-Json
if (($config.sectors.sector -join ',') -ne '1,2,3,4,5,6,7,8,9,10,11,12,13') {
 throw 'Service config must cover Sector 1~13 in order.'
}
if (($config.sectors.expected_count | Measure-Object -Sum).Sum -ne 247824) {
 throw 'Service config must contain 247,824 products.'
}
foreach ($forbidden in ('rm -rf','hdfs dfs -rm','hash(mast_uri)','gcloud compute')) {
 if ($source -match [regex]::Escape($forbidden)) { throw "Cluster ingestion script must not contain: $forbidden" }
}
if ($source -match 'sector=000__SECTOR__') { throw 'Sector paths must use four-digit formatting for Sector 10~13.' }

function Assert-Guard([string]$Candidate) {
 if ($Candidate -notmatch [regex]::Escape('test "$disk_percent" -lt 75')) { throw 'Missing 75% preflight stop line.' }
 if ($Candidate -notmatch [regex]::Escape('test "$actual" = ''__EXPECTED_SHA__''')) { throw 'Missing source list checksum guard.' }
}
Assert-Guard $source
foreach ($mutation in (
 $source.Replace('test "$disk_percent" -lt 75',''),
 $source.Replace('test "$actual" = ''__EXPECTED_SHA__''','')
)) {
 $rejected=$false
 try { Assert-Guard $mutation } catch { $rejected=$true }
 if (-not $rejected) { throw 'Cluster ingestion guard mutation must be rejected.' }
}

$progressBlock=[regex]::Match($source,"(?s)'Progress' \{(.*?)\r?\n 'Pause' \{").Groups[1].Value
if (-not $progressBlock) { throw 'Progress block not found.' }
foreach ($forbidden in ('rm -f','rm -r','unlink(','write_text(','append_event(','systemctl ','kill ')) {
 if ($progressBlock -match [regex]::Escape($forbidden)) { throw "Progress must remain read-only: $forbidden" }
}

$pauseBlock=[regex]::Match($source,"(?s)'Pause' \{(.*?)\r?\n 'Audit' \{").Groups[1].Value
if (-not $pauseBlock) { throw 'Pause block not found.' }
if ($pauseBlock -match [regex]::Escape('rm -')) { throw 'Pause must preserve completed and partial files.' }
$stopIndex=$pauseBlock.IndexOf('sudo systemctl stop "$unit"')
$termIndex=$pauseBlock.IndexOf('kill -TERM "$matched"')
if ($stopIndex -lt 0 -or $termIndex -lt 0 -or $stopIndex -ge $termIndex) {
 throw 'Pause must stop the supervisor before terminating a matching legacy downloader.'
}

$pythonBlock=[regex]::Match($progressBlock,"(?s)<<'PY'\r?\n(.*?)\r?\nPY").Groups[1].Value
if (-not $pythonBlock) { throw 'Progress Python block not found.' }
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) "S15P21C206-75-progress-$PID"
try {
 $manifestRoot=Join-Path $fixtureRoot 'manifests'
 $rawRoot=Join-Path $fixtureRoot 'raw/sector=0003'
 New-Item -ItemType Directory -Force -Path $manifestRoot,$rawRoot | Out-Null
 $sourceFixture=Join-Path $manifestRoot 'source.json'
 $products=@(
  @{assigned_worker=1;sector=3;tic_id=1;filename='one.fits';mast_uri='mast:TESS/product/one.fits'},
  @{assigned_worker=2;sector=3;tic_id=2;filename='other-worker.fits';mast_uri='mast:TESS/product/other-worker.fits'}
 )
 $canonical=($products | Sort-Object sector,filename | ForEach-Object {
  "$($_.sector)`t$($_.tic_id)`t$($_.filename)`t$($_.mast_uri)`t$($_.assigned_worker)`n"
 }) -join ''
 $fixtureSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical))).ToLowerInvariant()
 @{schema='planetory.tess-source-list.v1';source_list_sha256=$fixtureSha;product_count=$products.Count;products=$products} |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $sourceFixture -Encoding utf8
 @{
  filename='one.fits';status='VALIDATED';recorded_at=[DateTime]::UtcNow.ToString('o')
  cached=$false;size_bytes=2048;bytes_transferred=1024
 } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $manifestRoot 'sector-3-worker-1.events.jsonl') -Encoding utf8
 [IO.File]::WriteAllBytes((Join-Path $rawRoot 'one.fits.part'),[byte[]]::new(128))
 $metricJson=& python -c $pythonBlock $sourceFixture $fixtureRoot 1 '3' 15 $fixtureSha
 if ($LASTEXITCODE -ne 0) { throw 'Progress Python fixture failed.' }
 $metric=$metricJson | ConvertFrom-Json
 if ($metric.total -ne 1 -or $metric.completed -ne 1 -or $metric.completed_bytes -ne 2048 -or $metric.partial_bytes -ne 128) {
  throw "Progress Python fixture returned unexpected metrics: $metricJson"
 }
 Set-Content -LiteralPath (Join-Path $manifestRoot 'sector-3-worker-1.events.jsonl') -Value "{broken}`n" -NoNewline
 $invalidOutput=& python -c $pythonBlock $sourceFixture $fixtureRoot 1 '3' 15 $fixtureSha 2>&1
 if ($LASTEXITCODE -eq 0 -or ($invalidOutput -join "`n") -notmatch 'INVALID_EVENT_JSON') {
  throw 'Progress must reject a malformed complete event line.'
 }
 $mutated=Get-Content -Raw $sourceFixture | ConvertFrom-Json
 $mutated.products[0].assigned_worker=2
 $mutated | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $sourceFixture -Encoding utf8
 $mutationOutput=& python -c $pythonBlock $sourceFixture $fixtureRoot 1 '3' 15 $fixtureSha 2>&1
 if ($LASTEXITCODE -eq 0 -or ($mutationOutput -join "`n") -notmatch 'SOURCE_LIST_CONTENT_MISMATCH') {
  throw 'Progress must reject source-list content mutation.'
 }
} finally {
 Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'PASS: exact Worker targets, read-only progress, 75% stop, immutable bundle, source-list checksum, background run and audit contracts (offline).'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runner = Join-Path $PSScriptRoot 'run-tess-silver.ps1'
$self = Join-Path $PSScriptRoot 'test-tess-silver.ps1'
foreach ($script in @($runner, $self)) {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "PowerShell parse failed: $script`n$($errors -join "`n")" }
}

$pythonFiles = @(
    (Join-Path $repoRoot 'distributed-system\spark\tess_silver.py'),
    (Join-Path $repoRoot 'distributed-system\spark\tess_silver_ctl.py'),
    (Join-Path $repoRoot 'distributed-system\spark\test_tess_silver.py')
)
$syntaxScript = 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8"), filename=p) for p in sys.argv[1:]]'
& python -c $syntaxScript @pythonFiles
if ($LASTEXITCODE -ne 0) { throw 'Silver Python syntax validation failed.' }

$previousBytecode = $env:PYTHONDONTWRITEBYTECODE
try {
    $env:PYTHONDONTWRITEBYTECODE = '1'
    & python $pythonFiles[2]
    if ($LASTEXITCODE -ne 0) { throw 'Silver contract tests failed.' }
    & python -m unittest discover -s (Join-Path $repoRoot 'distributed-system\airflow\tests') -p 'test_tess_silver_dag.py'
    if ($LASTEXITCODE -ne 0) { throw 'Silver Airflow contract tests failed.' }
} finally {
    $env:PYTHONDONTWRITEBYTECODE = $previousBytecode
}

$job = Get-Content -LiteralPath $pythonFiles[0] -Raw
foreach ($required in @(
    'planetory.tess-silver-stage.v4',
    'initial_search=result',
    'f"{args.output}/iteration"',
    'MASK_CONTRACT_VERSION',
    'source_sha256=str(row["raw_sha256"])',
    'exclusion_ledger(prepared, detrended)',
    'quality0_baseline_pending_interval_mask',
    'groupByKey(args.shuffle_partitions)',
    'StorageLevel.DISK_ONLY',
    '--retry-manifest',
    'functions.col("status").isin("failed", "incomplete")',
    'baseline_time=prepared.time',
    '"left_anti"',
    'science_audit_json',
    'mode("errorifexists")'
)) {
    if (-not $job.Contains($required)) { throw "Missing Silver job contract: $required" }
}
foreach ($forbidden in @('.toPandas(', 'bronze.collect(', 'grouped.collect(')) {
    if ($job.Contains($forbidden)) { throw "Driver-wide materialization is forbidden: $forbidden" }
}

$control = Get-Content -LiteralPath $pythonFiles[1] -Raw
foreach ($required in @(
    'validate_bronze_coverage',
    'planetory.tess-silver-attempt.v4',
    'planetory.tess-silver-stage.v4',
    '("target_combined", "periodogram", "iteration", "manifest")',
    'SilverDataContractError',
    'SILVER_TERMINAL_SCHEMA',
    'part_checksum_digest',
    'fsck_healthy',
    'atomic_commit',
    'root = "/validation/S15P21C206-78" if validation else "/lake/silver"',
    'SILVER_CANARY_AUDIT=',
    'cleanup_spark_staging',
    'retry source is not a completed Silver attempt'
    'yarn_slot'
)) {
    if (-not $control.Contains($required)) { throw "Missing Silver control contract: $required" }
}

$runnerText = Get-Content -LiteralPath $runner -Raw
foreach ($required in @(
    'Type=oneshot',
    'Restart=on-failure',
    'RestartPreventExitStatus=65',
    'TimeoutStartSec=infinity',
    'systemctl --no-block start',
    'Canary requires one to five explicit TIC IDs',
    'Retry requires -RetryFrom'
)) {
    if (-not $runnerText.Contains($required)) { throw "Missing Silver runner contract: $required" }
}
$runnerTokens = $null
$runnerErrors = $null
$runnerAst = [Management.Automation.Language.Parser]::ParseFile($runner, [ref]$runnerTokens, [ref]$runnerErrors)
$unitAssignment = $runnerAst.Find({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left.Extent.Text -eq '$unitText'
}, $true)
if (-not $unitAssignment) { throw 'Silver systemd unit template assignment is missing.' }
$release = '/opt/planetory-silver/releases/test'
$Exec = '/usr/bin/true'
$Description = 'Silver test'
Invoke-Expression $unitAssignment.Extent.Text
foreach ($required in @('ExecStart=/usr/bin/true', 'RestartPreventExitStatus=65', '$EXIT_CODE', '$EXIT_STATUS')) {
    if (-not $unitText.Contains($required)) { throw "Rendered Silver unit contract is missing: $required" }
}

Write-Host 'PASS: Silver data, science, Spark operation and safety contracts'

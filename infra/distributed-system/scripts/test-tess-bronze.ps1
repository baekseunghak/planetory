[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$scripts = @(
    (Join-Path $PSScriptRoot 'run-tess-bronze.ps1'),
    (Join-Path $PSScriptRoot 'test-tess-bronze.ps1')
)
foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "PowerShell parse failed: $script`n$($errors -join "`n")" }
}

$pythonFiles = @(
    (Join-Path $repoRoot 'distributed-system\spark\tess_bronze.py'),
    (Join-Path $repoRoot 'distributed-system\spark\tess_bronze_ctl.py'),
    (Join-Path $repoRoot 'distributed-system\spark\test_tess_bronze.py')
)
$syntaxScript = 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8"), filename=p) for p in sys.argv[1:]]'
& python -c $syntaxScript @pythonFiles
if ($LASTEXITCODE -ne 0) { throw 'Python syntax validation failed.' }
$previousBytecode = $env:PYTHONDONTWRITEBYTECODE
try {
    $env:PYTHONDONTWRITEBYTECODE = '1'
    & python $pythonFiles[2]
    if ($LASTEXITCODE -ne 0) { throw 'Bronze unit tests failed.' }
} finally {
    $env:PYTHONDONTWRITEBYTECODE = $previousBytecode
}

$control = Get-Content -LiteralPath $pythonFiles[1] -Raw
foreach ($required in @(
    'TessSequenceFileTool',
    'contract_ok',
    'raw_ready_sha256',
    'part_checksums_sha256',
    'BRONZE_PARSE_ERRORS',
    '--python-version',
    'pip==24.3.1',
    'manylinux_2_17_x86_64',
    'BRONZE_SPARK_PATHS_READY',
    'BRONZE_COVERAGE_COMMIT_OK',
    'RAW_COVERAGE_SHA256',
    'HADOOP_USER_NAME',
    '/lake/bronze/tess/.staging/'
)) {
    if (-not $control.Contains($required)) { throw "Missing Bronze control contract: $required" }
}
if ($control -match 'hdfs\("dfs", "-rm", "-r", "-skipTrash", (?!output)') {
    throw 'Bronze control may only delete its exact successful attempt path.'
}
$runner = Get-Content -LiteralPath $scripts[0] -Raw
foreach ($required in @('Type=oneshot', 'Restart=on-failure', 'RestartSec=5min', 'StartLimitIntervalSec=0',
                         'TimeoutStartSec=infinity', 'ExecStartPost=-/usr/bin/systemctl disable %n',
                         'systemctl enable', 'systemctl --no-block start')) {
    if (-not $runner.Contains($required)) { throw "Missing autonomous Bronze unit contract: $required" }
}
$java = Get-Content -LiteralPath (Join-Path $repoRoot 'distributed-system\ingestion\hdfs\TessSequenceFileTool.java') -Raw
if (-not $java.Contains('Options.Rename.NONE')) { throw 'Atomic no-overwrite rename contract is missing.' }
Write-Host 'PASS: Bronze Python, PowerShell and safety contracts'

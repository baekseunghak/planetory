[CmdletBinding()]
param(
 [string]$Python='python'
)
$ErrorActionPreference='Stop'
$runner=Join-Path $PSScriptRoot 'run-tess-hdfs-load.ps1'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$loader=Join-Path $root 'distributed-system/ingestion/hdfs'

$tokens=$null
$parseErrors=$null
[System.Management.Automation.Language.Parser]::ParseFile($runner,[ref]$tokens,[ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors -join "`n") }

$runnerText=Get-Content -LiteralPath $runner -Raw
foreach ($required in @('Preflight','Build','Upload','Status','Audit','Commit','Commit requires all Workers 2..6','manifest.parquet','--no-block start','TimeoutStartSec=3h','StrictHostKeyChecking=yes','Invoke-Scp',"@(,@('node-1'",'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop','javac -encoding UTF-8')) {
 if (-not $runnerText.Contains($required)) { throw "Runner contract is missing: $required" }
}
if ($runnerText.Contains('__BUNDLE_BASE64__')) { throw 'Loader archive must not be embedded in a Windows process argument.' }
if ($runnerText.Contains('systemctl enable "$unit"')) { throw 'Transient HDFS upload units must not start again after boot.' }
$common=@{RunId='20260918T120000Z';ExpectedSourceListSha256=('a'*64);Sector=3}
foreach ($step in @('Install','Build','Upload','Commit')) {
 & $runner -Step $step @common -WhatIf
}
$java=Get-Content -LiteralPath (Join-Path $loader 'TessSequenceFileTool.java') -Raw
foreach ($required in @('SequenceFile.Writer','writer.getLength()','reader.seek','SHA-256')) {
 if (-not $java.Contains($required)) { throw "SequenceFile contract is missing: $required" }
}

$previousBytecode=$env:PYTHONDONTWRITEBYTECODE
try {
 $env:PYTHONDONTWRITEBYTECODE='1'
 & $Python -m unittest (Join-Path $loader 'test_tess_hdfs_load.py')
 if ($LASTEXITCODE -ne 0) { throw 'HDFS load planner tests failed.' }
 & $Python -c 'import ast,pathlib,sys; [ast.parse(path.read_text(encoding="utf-8"), filename=str(path)) for path in pathlib.Path(sys.argv[1]).glob("*.py")]' $loader
 if ($LASTEXITCODE -ne 0) { throw 'HDFS loader Python syntax check failed.' }
} finally { $env:PYTHONDONTWRITEBYTECODE=$previousBytecode }
Write-Host 'PASS: TESS HDFS load offline contracts'

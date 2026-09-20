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
foreach ($required in @('ConfigureCapacity','Preflight','Build','Upload','Status','Audit','Commit','CoverageCommit','RunAll','ServerRunAll','Wait-HdfsUploaders','Get-CoverageDocument','coverage-map','coverage-ready','ExpectedCoverageSha256','RUN_ALL_COMPLETE sectors=','requires all Workers 2..6','manifest.parquet','--no-block start','TimeoutStartSec=3h','StrictHostKeyChecking=yes','Invoke-Scp',"@(,@('node-1'",'tess_hdfs_runall.py','runall --config','sudo ssh -n','-b 10.20.1.10','10.20.2.10,10.20.3.10,10.20.4.10,10.20.5.10,10.20.6.10','PYTHONUNBUFFERED=1','RuntimeDirectory=planetory-tess-hdfs-runall-$RunId','StateDirectory=planetory-tess-hdfs-runall-$RunId','ConditionPathExists=!/var/lib/planetory-tess-hdfs-runall-$RunId/complete','HDFS_PATH_CHECK_FAILED','export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop','javac -encoding UTF-8','sudo chmod -R a=rX,u+w "$work"','validate_release_permissions','RELEASE_OWNER_INVALID','RELEASE_MUTABLE','RELEASE_FILE_NOT_READABLE','RELEASE_DIRECTORY_NOT_TRAVERSABLE','RELEASE_PERMISSION_INVALID','Under-replicated blocks:[[:space:]]+0','dfs.datanode.du.reserved','HDFS config drift outside reserve','DATANODE_RESTARTED','HDFS_CAPACITY_CONFIGURED','"$fsck"')) {
 if (-not $runnerText.Contains($required)) { throw "Runner contract is missing: $required" }
}
if ($runnerText.Contains("test `"`$(hdfs_cmd dfsadmin -safemode get)`" = 'Safe mode is OFF'")) {
 throw 'HA safe mode validation must accept one OFF line per NameNode.'
}
if ($runnerText.Contains("Invoke-OrchestratedStep 'Audit' `$currentSector `$currentRunId `$currentSourceSha `$currentReleaseId `$currentBytes")) {
 throw 'RunAll must rely on Commit integrated full audit instead of repeating the same audit twice.'
}
if (-not $runnerText.Contains("RUN_ALL_PREFLIGHT_REUSED sector=`$currentSector")) {
 throw 'RunAll must reuse the pre-install preflight for its first Sector.'
}
foreach ($required in @('$pythonPackageRoot=$LocalIngestionPath','$env:PYTHONPATH=$pythonPackageRoot','$env:PYTHONPATH=$previousPythonPath')) {
 if (-not $runnerText.Contains($required)) { throw "Coverage validation must scope and restore its Python package path: $required" }
}
foreach ($required in @("`$env:PYTHONDONTWRITEBYTECODE='1'",'$env:PYTHONDONTWRITEBYTECODE=$previousBytecode')) {
 if (-not $runnerText.Contains($required)) { throw "Coverage validation must not leave Python bytecode artifacts: $required" }
}
if ($runnerText.Contains('__BUNDLE_BASE64__')) { throw 'Loader archive must not be embedded in a Windows process argument.' }
if ($runnerText.Contains('systemctl enable "$unit" >/dev/null 2>&1 || true')) { throw 'Transient HDFS upload units must not start again after boot.' }
if ($runnerText.Contains("hdfs_cmd dfs -mv '__STAGE__' '__FINAL__'")) { throw 'Final Sector commit must use atomic no-overwrite rename.' }
foreach ($forbidden in @('spark_script=/tmp',"cp '__RELEASE__/hdfs/manifest_to_parquet.py'",'| cmp -s "$ready" -','hdfs_cmd dfs -cat ''__COVERAGE_FINAL__/_READY.json'' > "$existing"')) {
 if ($runnerText.Contains($forbidden)) { throw "Cross-user temporary-file contract regressed: $forbidden" }
}
foreach ($required in @("-v '__RELEASE__/hdfs/manifest_to_parquet.py':/opt/planetory/manifest_to_parquet.py:ro",'sudo -u hdfs python3 - "$ready" "$count"','sudo -u hdfs cmp -s "$ready"','base64 --decode | sudo -u hdfs tee "$source"','sudo find "$release" -type d ! -perm -0005','sudo find "$release" -type f ! -perm -0004')) {
 if (-not $runnerText.Contains($required)) { throw "Cross-user temporary-file contract is missing: $required" }
}
$common=@{RunId='20260918T120000Z';ExpectedSourceListSha256=('a'*64);Sector=3}
foreach ($step in @('ConfigureCapacity','Install','Build','Upload','Commit','CoverageCommit','RunAll','ServerRunAll')) {
 & $runner -Step $step @common -WhatIf
}
$boundary=$common.Clone()
$boundary.Sector=1
& $runner -Step Build @boundary -WhatIf
$boundary.Sector=13
& $runner -Step Build @boundary -WhatIf
$java=Get-Content -LiteralPath (Join-Path $loader 'TessSequenceFileTool.java') -Raw
foreach ($required in @('SequenceFile.Writer','writer.getLength()','reader.seek','SHA-256','FileContext','Options.Rename.NONE','ATOMIC_COMMIT_OK')) {
 if (-not $java.Contains($required)) { throw "SequenceFile contract is missing: $required" }
}
$hdfsSite=Get-Content -LiteralPath (Join-Path $root 'infra/distributed-system/config/hadoop/hdfs-site.xml') -Raw
if (-not $hdfsSite.Contains('<name>dfs.datanode.du.reserved</name>') -or -not $hdfsSite.Contains('<value>107374182400</value>')) {
 throw 'HDFS must reserve 100 GiB per DataNode for local staging and recovery headroom.'
}

$previousBytecode=$env:PYTHONDONTWRITEBYTECODE
try {
 $env:PYTHONDONTWRITEBYTECODE='1'
 & $Python -m unittest (Join-Path $loader 'test_tess_hdfs_load.py')
 if ($LASTEXITCODE -ne 0) { throw 'HDFS load planner tests failed.' }
 & $Python -c 'import ast,pathlib,sys; [ast.parse(path.read_text(encoding="utf-8"), filename=str(path)) for path in pathlib.Path(sys.argv[1]).glob("*.py")]' $loader
 if ($LASTEXITCODE -ne 0) { throw 'HDFS loader Python syntax check failed.' }
 $previousPythonPath=$env:PYTHONPATH
 try {
  $env:PYTHONPATH=(Join-Path $root 'distributed-system/ingestion')
  & $Python (Join-Path $loader 'tess_hdfs_load.py') --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'HDFS loader direct CLI package import failed.' }
 } finally { $env:PYTHONPATH=$previousPythonPath }
} finally { $env:PYTHONDONTWRITEBYTECODE=$previousBytecode }
Write-Host 'PASS: TESS HDFS load offline contracts'

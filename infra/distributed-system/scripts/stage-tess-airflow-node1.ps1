[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$CodeReleaseId
)

$ErrorActionPreference='Stop'
$repoRoot=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$release="/opt/planetory-airflow/releases/$CodeReleaseId"
if (-not $PSCmdlet.ShouldProcess($release,'Stage immutable Airflow release on Node 1')) { return }
$archive=Join-Path ([IO.Path]::GetTempPath()) "planetory-airflow-$CodeReleaseId-$PID.tgz"
$remoteArchive="/tmp/planetory-airflow-$CodeReleaseId.tgz"
try {
    & tar -czf $archive '--exclude=__pycache__' '--exclude=*.pyc' -C $repoRoot `
        'infra/distributed-system/compose.control-plane.yaml' `
        'infra/distributed-system/scripts/deploy-tess-airflow-node1.sh' `
        'infra/distributed-system/scripts/upgrade-tess-airflow3-node1.sh' `
        'infra/distributed-system/scripts/configure-tess-airflow-node1.sh' `
        'infra/distributed-system/scripts/configure-tess-airflow-account.sh' `
        'infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh' `
        'infra/distributed-system/scripts/configure-tess-gold-airflow-node1.sh' `
        'distributed-system/airflow/Dockerfile' `
        'distributed-system/airflow/requirements.txt' `
        'distributed-system/airflow/dags'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to pack Airflow release.' }
    $sha=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    & scp -o BatchMode=yes -o StrictHostKeyChecking=yes $archive "SSAFY@node-1:$remoteArchive"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to transfer Airflow release.' }
    $command=@'
set -eu
release='__RELEASE__'
archive='__ARCHIVE__'
expected='__SHA__'
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "$expected"
if test -e "$release"; then
  test -f "$release/.archive-sha256"
  test "$(cat "$release/.archive-sha256")" = "$expected"
  echo AIRFLOW_RELEASE_CACHED="$release"
  rm -f -- "$archive"
  exit 0
fi
stage=$(mktemp -d /opt/planetory-airflow/release-part.XXXXXX)
trap 'rm -rf -- "$stage"; rm -f -- "$archive"' EXIT
tar -xzf "$archive" -C "$stage"
cp "$stage/infra/distributed-system/compose.control-plane.yaml" "$stage/compose.yaml"
test -f "$stage/distributed-system/airflow/dags/tess_sector_discovery_dag.py"
test -f "$stage/infra/distributed-system/scripts/configure-tess-airflow-node1.sh"
test -f "$stage/infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh"
test -f "$stage/infra/distributed-system/scripts/configure-tess-gold-airflow-node1.sh"
printf '%s\n' "$expected" > "$stage/.archive-sha256"
chown -R root:root "$stage"
chmod -R go-w "$stage"
mv "$stage" "$release"
trap - EXIT
rm -f -- "$archive"
echo AIRFLOW_RELEASE_STAGED="$release" archive_sha256="$expected"
'@.Replace('__RELEASE__',$release).Replace('__ARCHIVE__',$remoteArchive).Replace('__SHA__',$sha)
    # A CRLF checkout puts CR into the here-string; Linux bash rejects `set -eu\r` before anything runs.
    $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command.Replace("`r",'')))
    & tailscale ssh SSAFY@node-1 "printf '%s' '$payload' | base64 --decode | sudo -n bash"
    if ($LASTEXITCODE -ne 0) { throw 'Airflow release staging failed.' }
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}

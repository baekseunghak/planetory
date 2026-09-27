[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Start','Drain','Status')]
    [string]$Step,
    [ValidatePattern('^[0-9]{8}T[0-9]{6}Z$')]
    [string]$CodeReleaseId='20260922T021406Z'
)

$ErrorActionPreference='Stop'
if ($Step -ne 'Status' -and -not $PSCmdlet.ShouldProcess('Node 1 Airflow, Sector 14 only', $Step)) { return }
$command=@'
set -eu
test "$(hostname -s)" = master-1
scheduler=planetory-distributed-system-airflow-scheduler-1
test "$(docker inspect -f '{{.Config.Image}}' "$scheduler")" = 'local/planetory-airflow:__RELEASE__'
run() { docker exec "$scheduler" airflow "$@"; }
test "$(run variables get tess_pipeline_max_sector)" = 14
case '__STEP__' in
  Start)
    test "$(run variables get tess_pipeline_enabled)" = false
    run dags list-import-errors | grep -Fq 'No data found'
    docker exec "$scheduler" python -c 'from airflow.models import DagRun; from airflow.settings import Session; s=Session(); assert s.query(DagRun).filter(DagRun.state.in_(("queued", "running"))).count() == 0, "ACTIVE_DAG_RUNS"; s.close()'
    docker exec "$scheduler" python /opt/airflow/dags/tess_airflow_connections.py --release __RELEASE__ --verify-only
    for dag in tess_sector_download tess_sector_raw tess_sector_cleanup tess_sector_bronze tess_sector_discovery; do
      run dags unpause "$dag"
    done
    run variables set tess_pipeline_enabled true
    run dags trigger -r planetory-sector14-__RELEASE__ tess_sector_discovery
    echo TESS_SECTOR14_TRIGGERED
    ;;
  Drain)
    run variables set tess_pipeline_enabled false
    run dags pause tess_sector_discovery
    echo TESS_SECTOR14_DRAINING
    ;;
  Status)
    echo CAP="$(run variables get tess_pipeline_max_sector)" ENABLED="$(run variables get tess_pipeline_enabled)"
    for dag in tess_sector_discovery tess_sector_download tess_sector_raw tess_sector_cleanup tess_sector_bronze; do
      run dags list-runs -d "$dag" | tail -n 5
    done
    ;;
esac
'@.Replace('__RELEASE__',$CodeReleaseId).Replace('__STEP__',$Step)
$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command.Replace("`r",'')))
& tailscale ssh SSAFY@node-1 "printf '%s' '$payload' | base64 --decode | sudo -n bash"
if ($LASTEXITCODE -ne 0) { throw "Sector 14 Airflow $Step failed." }

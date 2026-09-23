#!/usr/bin/env bash
set -euo pipefail

# One-time 2.10.5 -> 3.2.2 cutover. Preserve the old DB and release for rollback.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 ]] || { echo NODE1_ROOT_REQUIRED >&2; exit 1; }
umask 077
release_dir="$(cd "$(dirname "$0")/../../.." && pwd -P)"
release="$(basename "$release_dir")"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z$ && -f "$release_dir/compose.yaml" ]] || {
  echo AIRFLOW_RELEASE_INCOMPLETE >&2; exit 1;
}
old_dir=/opt/planetory-airflow/releases/20260922T135740Z
old_env=/etc/planetory/airflow/airflow.env
new_env="/etc/planetory/airflow/airflow3-${release}.env"
backup_dir="/mnt/data/airflow-backups/$release"
new_db="airflow3_${release,,}"
image="local/planetory-airflow:$release"
db_container=planetory-distributed-system-airflow-db-1
old_compose=(docker compose --env-file "$old_env" -f "$old_dir/compose.yaml")
new_compose=(docker compose --env-file "$new_env" -f "$release_dir/compose.yaml")

[[ -f "$old_dir/compose.yaml" && -f "$old_env" && ! -e "$new_env" && ! -e "$backup_dir" ]] || {
  echo AIRFLOW_UPGRADE_TARGET_NOT_CLEAN >&2; exit 1;
}
[[ "$(docker exec planetory-distributed-system-airflow-scheduler-1 airflow version)" == 2.10.5 ]] || {
  echo AIRFLOW_SOURCE_VERSION_CHANGED >&2; exit 1;
}
docker exec planetory-distributed-system-airflow-scheduler-1 python -c '
from airflow.models import DagModel, DagRun, Variable
from airflow.settings import Session
s = Session()
try:
    assert Variable.get("tess_pipeline_enabled", default_var="false") == "false"
    assert s.query(DagRun).filter(DagRun.state.in_(("queued", "running"))).count() == 0
    dag = s.query(DagModel).filter_by(dag_id="tess_sector_discovery").one()
    assert dag.is_paused
finally:
    s.close()
'
[[ "$(docker exec "$db_container" psql -U airflow -d airflow -Atc 'select datname from pg_database' | grep -Fxc "$new_db" || true)" == 0 ]] || {
  echo AIRFLOW_CLONE_DB_ALREADY_EXISTS >&2; exit 1;
}
docker image inspect apache/airflow:3.2.2-python3.12 >/dev/null
cd "$release_dir"
docker build --network none --build-arg AIRFLOW_IMAGE=apache/airflow:3.2.2-python3.12 \
  -f distributed-system/airflow/Dockerfile -t "$image" .
docker run --rm --network none --entrypoint python "$image" -c '
from airflow.dag_processing.dagbag import DagBag
bag = DagBag(dag_folder="/opt/airflow/dags", include_examples=False)
required = {"tess_sector_discovery", "tess_sector_download", "tess_sector_raw", "tess_sector_cleanup", "tess_sector_bronze"}
assert not bag.import_errors, bag.import_errors
assert set(bag.dags) == required
assert all(bag.dags[dag_id].is_paused_upon_creation for dag_id in required)
'
grep -Eq '^AIRFLOW_DATABASE_URL=postgresql\+psycopg2://.*@127\.0\.0\.1:5432/airflow$' "$old_env"
[[ "$(grep -c '^AIRFLOW_IMAGE=' "$old_env")" == 1 ]]
[[ "$(grep -c '^AIRFLOW_JWT_SECRET=' "$old_env" || true)" == 0 ]]
cp -- "$old_env" "$new_env"
sed -i -E "s#^(AIRFLOW_DATABASE_URL=.*)/airflow\$#\1/$new_db#; s#^AIRFLOW_IMAGE=.*#AIRFLOW_IMAGE=$image#" "$new_env"
printf 'AIRFLOW_JWT_SECRET=%s\n' "$(openssl rand -hex 48)" >> "$new_env"
chmod 0600 "$new_env"
"${new_compose[@]}" config --quiet

stopped=0
rollback() {
  status=$?
  trap - EXIT
  if (( status != 0 && stopped == 1 )); then
    "${new_compose[@]}" stop airflow-api-server airflow-dag-processor airflow-scheduler airflow-triggerer || true
    "${old_compose[@]}" up -d --no-deps airflow-scheduler airflow-webserver || echo AIRFLOW_ROLLBACK_FAILED >&2
    echo AIRFLOW_2X_ROLLBACK_ATTEMPTED >&2
  fi
  exit "$status"
}
trap rollback EXIT
"${old_compose[@]}" stop airflow-scheduler airflow-webserver
stopped=1
install -d -m 0700 "$backup_dir"
docker exec "$db_container" pg_dump -U airflow -Fc airflow > "$backup_dir/airflow2.dump"
[[ -s "$backup_dir/airflow2.dump" ]]
docker exec "$db_container" createdb -U airflow -O airflow "$new_db"
docker exec -i "$db_container" pg_restore -U airflow -d "$new_db" --no-owner --no-privileges < "$backup_dir/airflow2.dump"
"${new_compose[@]}" --profile setup run --rm --no-deps airflow-init
"${new_compose[@]}" up -d --no-deps airflow-api-server airflow-dag-processor airflow-scheduler airflow-triggerer
healthy=0
for attempt in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:8081/api/v2/monitor/health | python3 -c '
import json, sys
try:
    health = json.load(sys.stdin)
    assert all(health[key]["status"] == "healthy" for key in ("metadatabase", "scheduler", "dag_processor", "triggerer"))
except (AssertionError, KeyError, ValueError):
    sys.exit(1)
'; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]]
[[ "$("${new_compose[@]}" exec -T airflow-scheduler airflow version)" == 3.2.2 ]]
"${new_compose[@]}" exec -T airflow-dag-processor airflow dags list-import-errors | grep -Fq 'No data found'
"${new_compose[@]}" exec -T airflow-api-server airflow users list -o plain | grep -Eq '[[:space:]]viewer[[:space:]]'
[[ "$("${new_compose[@]}" exec -T airflow-scheduler airflow variables get tess_pipeline_enabled)" == false ]]
curl --fail --silent --output /dev/null http://127.0.0.1:8081/api/v2/monitor/health
trap - EXIT
echo "AIRFLOW_322_READY release=$release database=$new_db backup=$backup_dir/airflow2.dump"

#!/usr/bin/env bash
set -euo pipefail

# Run as root on master-1 from an immutable release containing compose.yaml and distributed-system/airflow/.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 ]] || { echo 'NODE1_ROOT_REQUIRED' >&2; exit 1; }
umask 077
release_dir="$(cd "$(dirname "$0")/../../.." && pwd -P)"
[[ -f "$release_dir/compose.yaml" && -f "$release_dir/distributed-system/airflow/Dockerfile" ]] || {
  echo 'AIRFLOW_RELEASE_INCOMPLETE' >&2; exit 1;
}
if [[ "${1:-}" == --viewer-password ]]; then
  cd "$release_dir"
  compose=(docker compose --env-file /etc/planetory/airflow/airflow.env -f compose.yaml)
  password_file=/etc/planetory/airflow/viewer-password
  if [[ ! -f "$password_file" ]]; then openssl rand -hex 24 > "$password_file"; fi
  chmod 0600 "$password_file"
  password="$(<"$password_file")"
  if "${compose[@]}" exec -T airflow-api-server airflow users list -o plain | grep -Eq '[[:space:]]viewer[[:space:]]'; then
    "${compose[@]}" exec -T airflow-api-server airflow users reset-password \
      --username viewer --password "$password" >/dev/null
  else
    "${compose[@]}" exec -T airflow-api-server airflow users create \
      --username viewer --firstname Planetory --lastname Viewer \
      --role Viewer --email viewer@planetory.invalid --password "$password" >/dev/null
  fi
  unset password
  echo 'AIRFLOW_VIEWER_PASSWORD_SET'
  exit 0
fi
if [[ "${1:-}" == --update ]]; then
  [[ -f /etc/planetory/airflow/airflow.env ]] || { echo 'AIRFLOW_ENV_MISSING' >&2; exit 1; }
  cd "$release_dir"
  scheduler=planetory-distributed-system-airflow-scheduler-1
  api_server=planetory-distributed-system-airflow-api-server-1
  old_image="$(docker inspect -f '{{.Config.Image}}' "$scheduler")"
  [[ "$old_image" == "$(docker inspect -f '{{.Config.Image}}' "$api_server")" ]] || {
    echo 'AIRFLOW_IMAGE_DRIFT' >&2; exit 1;
  }
  [[ "$(docker exec "$scheduler" airflow version)" == "3.2.2" ]] || {
    echo 'AIRFLOW_MAJOR_UPGRADE_REQUIRES_DB_CLONE_AND_MIGRATION' >&2; exit 1;
  }
  docker image inspect "$old_image" >/dev/null
  docker exec "$scheduler" python -c '
from airflow.models.dagrun import DagRun
from airflow.settings import Session
session = Session()
try:
    active = session.query(DagRun).filter(DagRun.state.in_(("queued", "running"))).count()
    assert active == 0, f"AIRFLOW_ACTIVE_DAG_RUNS={active}"
finally:
    session.close()
'
  image="local/planetory-airflow:$(basename "$release_dir")"
  [[ "$image" != "$old_image" ]] || { echo 'AIRFLOW_RELEASE_ALREADY_ACTIVE' >&2; exit 1; }
  compose=(docker compose --env-file /etc/planetory/airflow/airflow.env -f compose.yaml)
  AIRFLOW_IMAGE="$image" "${compose[@]}" config --quiet
  docker build --network none --build-arg "AIRFLOW_IMAGE=$old_image" \
    -f distributed-system/airflow/Dockerfile -t "$image" .
  docker run --rm --network none --entrypoint python "$image" -c '
from airflow.dag_processing.dagbag import DagBag
bag = DagBag(dag_folder="/opt/airflow/dags", include_examples=False)
required = {"tess_sector_discovery", "tess_sector_download", "tess_sector_raw", "tess_sector_cleanup", "tess_sector_bronze"}
assert not bag.import_errors, bag.import_errors
assert required <= set(bag.dags), required - set(bag.dags)
assert "tess_sector_download_raw_bronze" not in bag.dags
assert all(bag.dags[dag_id].is_paused_upon_creation for dag_id in required)
print("AIRFLOW_FIVE_PAUSED_DAGS_READY")
'
  switched=0
  rollback() {
    status=$?
    trap - EXIT
    if [[ "$status" != 0 && "$switched" == 1 ]]; then
      AIRFLOW_IMAGE="$old_image" "${compose[@]}" up -d --no-deps airflow-scheduler airflow-dag-processor airflow-api-server || \
        echo 'AIRFLOW_ROLLBACK_FAILED' >&2
      echo "AIRFLOW_UPDATE_ROLLED_BACK old_image=$old_image" >&2
    fi
    exit "$status"
  }
  trap rollback EXIT
  switched=1
  AIRFLOW_IMAGE="$image" "${compose[@]}" up -d --no-deps airflow-scheduler airflow-dag-processor airflow-api-server
  for attempt in $(seq 1 60); do
    if curl --fail --silent --output /dev/null http://127.0.0.1:8081/api/v2/monitor/health; then break; fi
    sleep 2
  done
  curl --fail --silent --output /dev/null http://127.0.0.1:8081/api/v2/monitor/health
  "${compose[@]}" exec -T airflow-dag-processor airflow dags list-import-errors | grep -Fq 'No data found'
  [[ "$(docker inspect -f '{{.Config.Image}}' "$scheduler")" == "$image" ]]
  [[ "$(docker inspect -f '{{.Config.Image}}' "$api_server")" == "$image" ]]
  [[ "$(docker inspect -f '{{.Config.Image}}' planetory-distributed-system-airflow-dag-processor-1)" == "$image" ]]
  [[ "$(docker inspect -f '{{.State.Running}}' "$scheduler")" == true ]]
  [[ "$(docker inspect -f '{{.State.Running}}' "$api_server")" == true ]]
  [[ "$(docker inspect -f '{{.State.Running}}' planetory-distributed-system-airflow-dag-processor-1)" == true ]]
  trap - EXIT
  echo "AIRFLOW_UPDATE_READY image=$image previous=$old_image"
  exit 0
fi
[[ ! -e /etc/planetory/airflow ]] || [[ -d /etc/planetory/airflow ]] || exit 1
[[ -z "$(docker ps -q --filter 'name=planetory-distributed-system-airflow')" ]] || {
  echo 'AIRFLOW_CONTAINERS_ALREADY_RUNNING' >&2; exit 1;
}
[[ -z "$(ss -ltnH '( sport = :8081 )')" ]] || { echo 'AIRFLOW_PORT_IN_USE' >&2; exit 1; }
docker info >/dev/null
tailscale status >/dev/null
install -d -m 0700 /etc/planetory/airflow
install -d -m 0755 /mnt/data/airflow-logs
chown 50000:0 /mnt/data/airflow-logs

python3 - "$release_dir" <<'PY'
import base64
import os
import secrets
import sys
from pathlib import Path

root = Path('/etc/planetory/airflow')
target = root / 'airflow.env'
if target.exists():
    raise SystemExit(0)
release = Path(sys.argv[1])
password = secrets.token_hex(32)
fernet = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
values = {
    'AIRFLOW_DB_PASSWORD': password,
    'AIRFLOW_DATABASE_URL': f'postgresql+psycopg2://airflow:{password}@127.0.0.1:5432/airflow',
    'AIRFLOW_FERNET_KEY': fernet,
    'AIRFLOW_WEBSERVER_SECRET_KEY': secrets.token_hex(32),
    'AIRFLOW_JWT_SECRET': secrets.token_hex(48),
    'AIRFLOW_IMAGE': 'local/planetory-airflow:' + release.name,
    'AIRFLOW_DB_PATH': '/mnt/data/airflow-postgres',
    'AIRFLOW_LOGS_PATH': '/mnt/data/airflow-logs',
    'GCP_NODE_1_PROJECT': 'planetory-0001',
    'GCP_NODE_2_PROJECT': 'planetory-0002',
    'GCP_NODE_3_PROJECT': 'planetory-0003',
    'GCP_NODE_4_PROJECT': 'planetory-0004-508301',
    'GCP_NODE_5_PROJECT': 'planetory-0005',
    'GCP_NODE_6_PROJECT': 'planetory-0006',
}
with open(target, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as handle:
    for name, value in values.items():
        handle.write(f'{name}={value}\n')
PY

cd "$release_dir"
image="local/planetory-airflow:$(basename "$release_dir")"
docker build --build-arg AIRFLOW_IMAGE=apache/airflow:3.2.2-python3.12 \
  -f distributed-system/airflow/Dockerfile -t "$image" .
compose=(docker compose --env-file /etc/planetory/airflow/airflow.env -f compose.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d airflow-db
"${compose[@]}" --profile setup run --rm airflow-init
"${compose[@]}" up -d airflow-scheduler airflow-dag-processor airflow-api-server
"${compose[@]}" exec -T airflow-dag-processor airflow dags list-import-errors
"${compose[@]}" exec -T airflow-scheduler airflow dags list | grep -F tess_sector_discovery
bash "$0" --viewer-password
for attempt in $(seq 1 60); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:8081/api/v2/monitor/health; then break; fi
  sleep 2
done
curl --fail --silent --output /dev/null http://127.0.0.1:8081/api/v2/monitor/health
tailscale serve --bg --https=443 http://127.0.0.1:8081
tailscale serve status
echo 'AIRFLOW_TAILNET_READY'

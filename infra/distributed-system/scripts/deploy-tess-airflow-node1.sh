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
  if "${compose[@]}" exec -T airflow-webserver airflow users list -o plain | grep -Eq '[[:space:]]viewer[[:space:]]'; then
    "${compose[@]}" exec -T airflow-webserver airflow users reset-password \
      --username viewer --password "$password" >/dev/null
  else
    "${compose[@]}" exec -T airflow-webserver airflow users create \
      --username viewer --firstname Planetory --lastname Viewer \
      --role Viewer --email viewer@planetory.invalid --password "$password" >/dev/null
  fi
  unset password
  echo 'AIRFLOW_VIEWER_PASSWORD_SET'
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
docker build --build-arg AIRFLOW_IMAGE=apache/airflow:2.10.5-python3.12 \
  -f distributed-system/airflow/Dockerfile -t "$image" .
compose=(docker compose --env-file /etc/planetory/airflow/airflow.env -f compose.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d airflow-db
"${compose[@]}" --profile setup run --rm airflow-init
"${compose[@]}" up -d airflow-scheduler airflow-webserver
"${compose[@]}" exec -T airflow-scheduler airflow dags list-import-errors
"${compose[@]}" exec -T airflow-scheduler airflow dags list | grep -F tess_sector_download_raw_bronze
bash "$0" --viewer-password
for attempt in $(seq 1 60); do
  if curl --fail --silent --output /dev/null http://127.0.0.1:8081/health; then break; fi
  sleep 2
done
curl --fail --silent --output /dev/null http://127.0.0.1:8081/health
tailscale serve --bg --https=443 http://127.0.0.1:8081
tailscale serve status
echo 'AIRFLOW_TAILNET_READY'

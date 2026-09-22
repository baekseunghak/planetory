#!/usr/bin/env bash
set -euo pipefail

# Run only after installing an immutable Silver release and the 252 Airflow account.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 && $# == 1 ]] || {
  echo SILVER_AIRFLOW_NODE1_ARGS >&2; exit 1;
}
release_id=$1
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo INVALID_RELEASE_ID >&2; exit 1; }
release="/opt/planetory-silver/releases/$release_id"
controller="$release/spark/tess_silver_ctl.py"
[[ -f "$controller" ]] || {
  echo IMMUTABLE_SILVER_RELEASE_MISSING >&2; exit 1;
}
for path in /opt/planetory-silver /opt/planetory-silver/releases \
            "$release" "$release/spark" "$controller"; do
  [[ ! -L "$path" && "$(stat -c %u "$path")" == 0 \
    && -z "$(find "$path" -maxdepth 0 -perm /022 -print)" ]] || {
    echo SILVER_RELEASE_NOT_ROOT_OWNED_OR_WRITABLE >&2; exit 1;
  }
done
id tess-airflow >/dev/null
sudoers="/etc/sudoers.d/planetory-tess-silver-airflow-$release_id"
candidate="$(mktemp /etc/sudoers.d/planetory-tess-silver-airflow.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
cat > "$candidate" <<EOF
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_silver_ctl\\.py (run|canary|retry) --release-dir $release --run-id [0-9]{8}T[0-9]{6}Z --pipeline-version [A-Za-z0-9][A-Za-z0-9._-]{0,63} --bronze-coverage /lake/bronze/tess/coverage=[0-9a-f]{64} --shuffle-partitions [0-9]+ --output-partitions [0-9]+( --tic-id [0-9]+){0,5}( --retry-from /lake/silver/pipeline_version=[A-Za-z0-9._-]+/run_id=[0-9]{8}T[0-9]{6}Z/attempt=[0-9]{8}T[0-9]{6}Z)?$
EOF
chmod 0440 "$candidate"
visudo -cf "$candidate" >/dev/null
if [[ -e "$sudoers" ]]; then
  cmp -s "$candidate" "$sudoers" || { echo SILVER_AIRFLOW_SUDOERS_CONFLICT >&2; exit 1; }
else
  install -o root -g root -m 0440 "$candidate" "$sudoers"
fi
visudo -c >/dev/null
if sudo -l -U tess-airflow | grep -Fq 'NOPASSWD: ALL'; then
  echo AIRFLOW_SUDO_TOO_BROAD >&2; exit 1;
fi
docker exec planetory-distributed-system-airflow-scheduler-1 \
  airflow pools set tess_yarn 1 'Planetory YARN Spark submissions' >/dev/null
echo "SILVER_AIRFLOW_SUDO_READY release=$release_id"

#!/usr/bin/env bash
set -euo pipefail

# Root-only, repeatable internal-SSH principal and narrow sudo policy.
[[ "$(id -u)" == 0 && $# == 3 ]] || { echo AIRFLOW_ACCOUNT_ARGS >&2; exit 1; }
role=$1 release=$2 public_b64=$3
[[ "$role" == node1 || "$role" == worker ]] || exit 1
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
public_key="$(printf '%s' "$public_b64" | base64 --decode)"
[[ "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || exit 1
if ! id tess-airflow >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /home/tess-airflow --shell /bin/bash tess-airflow
fi
if [[ "$role" == worker ]]; then usermod -a -G planetory-admin tess-airflow; fi
groups="$(id -nG tess-airflow)"
for forbidden in sudo google-sudoers docker lxd admin; do
  [[ " $groups " != *" $forbidden "* ]] || { echo AIRFLOW_USER_PRIVILEGED >&2; exit 1; }
done
install -d -o tess-airflow -g tess-airflow -m 0700 /home/tess-airflow/.ssh
touch /home/tess-airflow/.ssh/authorized_keys
chown tess-airflow:tess-airflow /home/tess-airflow/.ssh/authorized_keys
chmod 0600 /home/tess-airflow/.ssh/authorized_keys
authorized="from=\"10.20.1.10\",restrict $public_key"
if ! grep -Fxq -- "$authorized" /home/tess-airflow/.ssh/authorized_keys; then
  printf '%s\n' "$authorized" >> /home/tess-airflow/.ssh/authorized_keys
fi

sudoers=/etc/sudoers.d/planetory-tess-airflow
candidate="$(mktemp /etc/sudoers.d/planetory-tess-airflow.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
if [[ "$role" == worker ]]; then
  printf '%s\n' 'tess-airflow ALL=(root) NOPASSWD: /usr/bin/systemctl ^start planetory-tess-ingestion-[0-9]{8}T[0-9]{6}Z-worker-[1-5]\.service$' > "$candidate"
else
  hdfs="/opt/planetory-hdfs-load/releases/$release"
  bronze="/opt/planetory-bronze/releases/$release"
  cat > "$candidate" <<EOF
tess-airflow ALL=(root) NOPASSWD: /usr/bin/env ^PYTHONPATH=$hdfs /usr/bin/python3\\.12 $hdfs/hdfs/tess_sector_admission\\.py (status|prepare|finalize) --sector (1[4-9]|[2-6][0-9]|70)( --[a-z-]+ [^ ]+)*$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/env ^JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop PYTHONPATH=$hdfs /usr/bin/python3\\.12 $hdfs/hdfs/tess_hdfs_runall\\.py (runall|cleanup-sector) --config /etc/planetory/tess-hdfs-runall/[0-9]{8}T[0-9]{6}Z\\.json --sector (1[4-9]|[2-6][0-9]|70) --expected-run-id [0-9]{8}T[0-9]{6}Z --expected-source-sha [a-f0-9]{64} --expected-code-release $hdfs( --skip-cleanup)?$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$bronze/spark/tess_bronze_ctl\\.py run-all --release-dir $bronze --run-id [0-9]{8}T[0-9]{6}Z --pipeline-version [A-Za-z0-9._-]+ --output-partitions [0-9]+ --sector (1[4-9]|[2-6][0-9]|70) --raw-release [0-9]{8}T[0-9]{6}Z --expected-source-sha [a-f0-9]{64}$
EOF
fi
chmod 0440 "$candidate"
visudo -cf "$candidate" >/dev/null
if [[ -e "$sudoers" ]]; then
  cmp -s "$candidate" "$sudoers" || { echo AIRFLOW_SUDOERS_CONFLICT >&2; exit 1; }
else
  install -o root -g root -m 0440 "$candidate" "$sudoers"
fi
visudo -c >/dev/null
if sudo -l -U tess-airflow | grep -Fq 'NOPASSWD: ALL'; then
  echo AIRFLOW_SUDO_TOO_BROAD >&2; exit 1
fi
echo "TESS_AIRFLOW_ACCOUNT_READY role=$role host=$(hostname -s)"

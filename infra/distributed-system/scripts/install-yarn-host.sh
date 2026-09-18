#!/usr/bin/env bash
set -Eeuo pipefail

HADOOP_HOME=/opt/hadoop
HADOOP_CONF_DIR=/etc/hadoop

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

node=""
source_dir=""
while (($#)); do
  case "$1" in
    --node)
      (($# >= 2)) || fail '--node requires a value.'
      node="$2"
      shift 2
      ;;
    --source-dir)
      (($# >= 2)) || fail '--source-dir requires a value.'
      source_dir="$2"
      shift 2
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$node" =~ ^[1-6]$ ]] || fail '--node must be an integer from 1 to 6.'
[[ -n "$source_dir" ]] || fail '--source-dir is required.'
[[ $EUID -eq 0 ]] || fail 'Run this script as root.'
source_dir="$(readlink -f "$source_dir")"
for file in worker.xml standby-worker.xml capacity-scheduler.xml; do
  [[ -f "$source_dir/$file" ]] || fail "Missing source file: $source_dir/$file"
done

expected_host=master-1
[[ "$node" == 1 ]] || expected_host="worker-$node"
expected_ip="10.20.${node}.10"
role=nodemanager
profile=worker.xml
[[ "$node" == 1 ]] && role=resourcemanager
[[ "$node" == 2 ]] && profile=standby-worker.xml

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

cat > "$work_dir/yarn-env.sh" <<'EOF'
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export HADOOP_HOME=/opt/hadoop
export HADOOP_CONF_DIR=/etc/hadoop
export HADOOP_LOG_DIR=/var/log/hadoop-yarn
export HADOOP_PID_DIR=/run/hadoop-yarn
export HADOOP_IDENT_STRING=yarn
export YARN_HOME=/opt/hadoop
EOF

cat > "$work_dir/hadoop-yarn-default" <<'EOF'
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
HADOOP_HOME=/opt/hadoop
HADOOP_CONF_DIR=/etc/hadoop
HADOOP_LOG_DIR=/var/log/hadoop-yarn
HADOOP_PID_DIR=/run/hadoop-yarn
HADOOP_IDENT_STRING=yarn
YARN_HOME=/opt/hadoop
EOF

mount_dependency=""
if [[ "$role" == nodemanager ]]; then
  mount_dependency='RequiresMountsFor=/mnt/data/yarn/local /mnt/data/yarn/logs'
fi
cat > "$work_dir/hadoop-yarn-${role}.service" <<EOF
[Unit]
Description=Apache Hadoop YARN ${role}
Wants=network-online.target
After=network-online.target
${mount_dependency}

[Service]
Type=forking
User=yarn
Group=hadoop
EnvironmentFile=/etc/default/hadoop-yarn
RuntimeDirectory=hadoop-yarn
RuntimeDirectoryMode=0750
PIDFile=/run/hadoop-yarn/hadoop-yarn-${role}.pid
ExecStart=/opt/hadoop/bin/yarn --daemon start ${role}
ExecStop=/opt/hadoop/bin/yarn --daemon stop ${role}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

for command in awk cut getent grep hostname id install ip mountpoint passwd pgrep readlink runuser systemctl uname useradd; do
  command -v "$command" >/dev/null || fail "Required command is missing: $command"
done
[[ "$(hostname -s)" == "$expected_host" ]] || fail "Expected hostname $expected_host, got $(hostname -s)."
ip -4 -o address show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fx "$expected_ip" >/dev/null ||
  fail "Expected private IP $expected_ip is not assigned to this host."
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'Ubuntu 24.04 is required.'
[[ "$(uname -m)" == x86_64 ]] || fail 'amd64/x86_64 is required.'
[[ "$(readlink -f "$HADOOP_HOME")" == /opt/hadoop-3.5.0 ]] || fail 'Hadoop 3.5.0 is required.'
[[ "$(< "$HADOOP_CONF_DIR/.planetory-hadoop-version")" == 3.5.0 ]] || fail 'Planetory Hadoop marker is missing or invalid.'
[[ -x /usr/lib/jvm/java-17-openjdk-amd64/bin/java ]] || fail 'OpenJDK 17 is required.'

hdfs_units=(hadoop-hdfs-datanode)
case "$node" in
  1) hdfs_units=(hadoop-hdfs-namenode hadoop-hdfs-journalnode) ;;
  2) hdfs_units=(hadoop-hdfs-namenode hadoop-hdfs-journalnode hadoop-hdfs-datanode) ;;
  3) hdfs_units=(hadoop-hdfs-journalnode hadoop-hdfs-datanode) ;;
esac
for unit in "${hdfs_units[@]}"; do
  systemctl is-active --quiet "$unit" || fail "HDFS prerequisite is not active: $unit"
done
unit="hadoop-yarn-${role}.service"
systemctl is-active --quiet "$unit" 2>/dev/null && fail "Stop $unit before installing or updating managed files."
systemctl is-enabled --quiet "$unit" 2>/dev/null && fail "Disable $unit before installing or updating managed files."
if pgrep -f 'org\.apache\.hadoop\.yarn\.server\.(resourcemanager|nodemanager)\.' >/dev/null; then
  fail 'Stop the YARN daemon before installing or updating managed files.'
fi

getent group hadoop >/dev/null || fail 'The Hadoop system group is missing.'
if getent passwd yarn >/dev/null; then
  [[ "$(id -gn yarn)" == hadoop ]] || fail 'Existing yarn user does not use the hadoop primary group.'
  [[ "$(getent passwd yarn | cut -d: -f6)" == /var/lib/hadoop-yarn ]] || fail 'Existing yarn user has an unexpected home.'
  [[ "$(getent passwd yarn | cut -d: -f7)" == /usr/sbin/nologin ]] || fail 'Existing yarn user has an interactive shell.'
  [[ "$(passwd -S yarn | awk '{print $2}')" == L ]] || fail 'Existing yarn user password is not locked.'
fi
[[ ! -e /var/lib/hadoop-yarn/.ssh && ! -L /var/lib/hadoop-yarn/.ssh ]] || fail 'The yarn account must not have an SSH directory.'
for path in "$HADOOP_CONF_DIR/yarn-site.xml" "$HADOOP_CONF_DIR/capacity-scheduler.xml" "$HADOOP_CONF_DIR/yarn-env.sh" /etc/default/hadoop-yarn "/etc/systemd/system/hadoop-yarn-${role}.service"; do
  [[ ! -L "$path" ]] || fail "Managed path must not be a symlink: $path"
done
for dir in /var/lib/hadoop-yarn /var/log/hadoop-yarn /run/hadoop-yarn; do
  [[ ! -L "$dir" ]] || fail "Managed directory must not be a symlink: $dir"
done
if [[ "$role" == nodemanager ]]; then
  mountpoint -q /mnt/data || fail '/mnt/data is not mounted.'
  for dir in /mnt/data/yarn/local /mnt/data/yarn/logs; do
    [[ ! -L "$dir" ]] || fail "Managed directory must not be a symlink: $dir"
  done
  [[ "$(python3 --version)" == Python\ 3.12.* ]] || fail 'Worker Python 3.12 is required.'
fi

if ! getent passwd yarn >/dev/null; then
  useradd --system --gid hadoop --home-dir /var/lib/hadoop-yarn --no-create-home --shell /usr/sbin/nologin yarn
fi
install -d -o yarn -g hadoop -m 0750 /var/lib/hadoop-yarn /var/log/hadoop-yarn /run/hadoop-yarn
if [[ "$role" == nodemanager ]]; then
  install -d -o yarn -g hadoop -m 0750 /mnt/data/yarn/local /mnt/data/yarn/logs
fi

install -o root -g root -m 0644 "$source_dir/$profile" "$HADOOP_CONF_DIR/yarn-site.xml"
install -o root -g root -m 0644 "$source_dir/capacity-scheduler.xml" "$HADOOP_CONF_DIR/capacity-scheduler.xml"
install -o root -g root -m 0644 "$work_dir/yarn-env.sh" "$HADOOP_CONF_DIR/yarn-env.sh"
install -o root -g root -m 0644 "$work_dir/hadoop-yarn-default" /etc/default/hadoop-yarn
install -o root -g root -m 0644 "$work_dir/hadoop-yarn-${role}.service" "/etc/systemd/system/hadoop-yarn-${role}.service"
systemctl daemon-reload

if [[ "$node" == 1 ]]; then
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y docker.io docker-compose-v2
  fi
  systemctl enable --now docker
  docker --version
  docker compose version
fi

runuser -u yarn -- env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_HOME=/opt/hadoop HADOOP_CONF_DIR=/etc/hadoop "$HADOOP_HOME/bin/yarn" version |
  grep -Fx 'Hadoop 3.5.0' >/dev/null || fail 'YARN Hadoop version verification failed.'
for dir in /var/lib/hadoop-yarn /var/log/hadoop-yarn /run/hadoop-yarn; do
  runuser -u yarn -- test -w "$dir" || fail "yarn cannot write to $dir"
done
if [[ "$role" == nodemanager ]]; then
  for dir in /mnt/data/yarn/local /mnt/data/yarn/logs; do
    runuser -u yarn -- test -w "$dir" || fail "yarn cannot write to $dir"
  done
fi
systemctl is-active --quiet "$unit" && fail "$unit started unexpectedly."
systemctl is-enabled --quiet "$unit" && fail "$unit was enabled unexpectedly."

printf 'PASS: Node %s prepared for YARN %s; YARN remains disabled and stopped.\n' "$node" "$role"

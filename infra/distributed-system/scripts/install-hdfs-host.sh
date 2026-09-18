#!/usr/bin/env bash
set -Eeuo pipefail

HADOOP_VERSION="3.5.0"
HADOOP_HOME="/opt/hadoop"
HADOOP_VERSION_HOME="/opt/hadoop-${HADOOP_VERSION}"
HADOOP_CONF_DIR="/etc/hadoop"
DOWNLOAD_BASE="https://downloads.apache.org/hadoop/common/hadoop-${HADOOP_VERSION}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: sudo bash %s --node <1-6> --source-dir <directory>\n' "$0"
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ "$node" =~ ^[1-6]$ ]] || fail '--node must be an integer from 1 to 6.'
[[ -n "$source_dir" ]] || fail '--source-dir is required.'
[[ $EUID -eq 0 ]] || fail 'Run this script as root.'
source_dir="$(readlink -f "$source_dir")"
for file in core-site.xml hdfs-site.xml workers; do
  [[ -f "$source_dir/$file" ]] || fail "Missing source file: $source_dir/$file"
done

expected_host="master-1"
if [[ "$node" != 1 ]]; then
  expected_host="worker-$node"
fi
expected_ip="10.20.${node}.10"

roles=()
data_dirs=()
case "$node" in
  1)
    roles=(namenode journalnode)
    data_dirs=(/var/lib/hadoop-hdfs/namenode /var/lib/hadoop-hdfs/journal)
    ;;
  2)
    roles=(namenode journalnode datanode)
    data_dirs=(/var/lib/hadoop-hdfs/namenode /var/lib/hadoop-hdfs/journal /mnt/data/hdfs)
    ;;
  3)
    roles=(journalnode datanode)
    data_dirs=(/var/lib/hadoop-hdfs/journal /mnt/data/hdfs)
    ;;
  *)
    roles=(datanode)
    data_dirs=(/mnt/data/hdfs)
    ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

cat > "$work_dir/hadoop-env.sh" <<'EOF'
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export HADOOP_HOME=/opt/hadoop
export HADOOP_CONF_DIR=/etc/hadoop
export HADOOP_LOG_DIR=/var/log/hadoop
export HADOOP_PID_DIR=/run/hadoop-hdfs
EOF

cat > "$work_dir/hadoop-default" <<'EOF'
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
HADOOP_HOME=/opt/hadoop
HADOOP_CONF_DIR=/etc/hadoop
HADOOP_LOG_DIR=/var/log/hadoop
HADOOP_PID_DIR=/run/hadoop-hdfs
HADOOP_IDENT_STRING=hdfs
EOF

cat > "$work_dir/hadoop-profile.sh" <<'EOF'
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export HADOOP_HOME=/opt/hadoop
export HADOOP_CONF_DIR=/etc/hadoop
export PATH="${PATH}:/opt/hadoop/bin:/opt/hadoop/sbin"
EOF
printf '%s\n' "$HADOOP_VERSION" > "$work_dir/hadoop-version"

role_mounts() {
  case "$node:$1" in
    1:namenode) printf '/var/lib/hadoop-hdfs/namenode' ;;
    1:journalnode) printf '/var/lib/hadoop-hdfs/journal' ;;
    2:namenode) printf '/var/lib/hadoop-hdfs/namenode' ;;
    2:journalnode) printf '/var/lib/hadoop-hdfs/journal' ;;
    2:datanode|3:datanode|4:datanode|5:datanode|6:datanode) printf '/mnt/data/hdfs' ;;
    3:journalnode) printf '/var/lib/hadoop-hdfs/journal' ;;
    *) fail "Unsupported node/role pair: $node/$1" ;;
  esac
}

render_unit() {
  local role="$1" mounts
  mounts="$(role_mounts "$role")"
  cat > "$work_dir/hadoop-hdfs-${role}.service" <<EOF
[Unit]
Description=Apache Hadoop HDFS ${role}
Wants=network-online.target
After=network-online.target
RequiresMountsFor=${mounts}

[Service]
Type=forking
User=hdfs
Group=hadoop
EnvironmentFile=/etc/default/hadoop
RuntimeDirectory=hadoop-hdfs
RuntimeDirectoryMode=0750
PIDFile=/run/hadoop-hdfs/hadoop-hdfs-${role}.pid
ExecStart=/opt/hadoop/bin/hdfs --daemon start ${role}
ExecStop=/opt/hadoop/bin/hdfs --daemon stop ${role}
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
}

for role in "${roles[@]}"; do
  render_unit "$role"
done

same_or_absent() {
  local desired="$1" target="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] || fail "Managed path must be a regular file: $target"
    cmp -s "$desired" "$target" || fail "Conflicting managed file: $target"
  fi
}

contains_role() {
  local wanted="$1" role
  for role in "${roles[@]}"; do
    [[ "$role" == "$wanted" ]] && return 0
  done
  return 1
}

for command in apt-get awk cmp cut find findmnt getent grep hostname id ip mountpoint passwd pgrep readlink runuser sha512sum systemctl tr uname; do
  command -v "$command" >/dev/null || fail "Required command is missing: $command"
done

[[ "$(hostname -s)" == "$expected_host" ]] || fail "Expected hostname $expected_host, got $(hostname -s)."
ip -4 -o address show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fx "$expected_ip" >/dev/null ||
  fail "Expected private IP $expected_ip is not assigned to this host."

source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail 'Ubuntu 24.04 is required.'
[[ "$(uname -m)" == x86_64 ]] || fail 'amd64/x86_64 is required.'
mountpoint -q /mnt/data || fail '/mnt/data is not mounted.'
if [[ "$node" == 2 ]]; then
  mountpoint -q /mnt/metadata || fail '/mnt/metadata is not mounted.'
fi
case "$node" in
  1)
    [[ "$(readlink -f /var/lib/hadoop-hdfs/namenode)" == /mnt/data/namenode ]] || fail 'Node 1 NameNode path must resolve to /mnt/data/namenode.'
    [[ "$(readlink -f /var/lib/hadoop-hdfs/journal)" == /mnt/data/journal ]] || fail 'Node 1 JournalNode path must resolve to /mnt/data/journal.'
    ;;
  2)
    [[ "$(readlink -f /var/lib/hadoop-hdfs/namenode)" == /mnt/metadata/namenode ]] || fail 'Node 2 NameNode path must resolve to /mnt/metadata/namenode.'
    [[ "$(readlink -f /var/lib/hadoop-hdfs/journal)" == /mnt/metadata/journal ]] || fail 'Node 2 JournalNode path must resolve to /mnt/metadata/journal.'
    [[ ! -L /mnt/data/hdfs ]] || fail '/mnt/data/hdfs must not be a symlink.'
    ;;
  3)
    [[ "$(readlink -f /var/lib/hadoop-hdfs/journal)" == /var/lib/hadoop-hdfs/journal ]] || fail 'Node 3 JournalNode path must stay on the boot disk.'
    [[ ! -L /mnt/data/hdfs ]] || fail '/mnt/data/hdfs must not be a symlink.'
    ;;
  *)
    [[ ! -L /mnt/data/hdfs ]] || fail '/mnt/data/hdfs must not be a symlink.'
    ;;
esac

for i in {1..6}; do
  host="worker-$i"
  [[ "$i" == 1 ]] && host="master-1"
  getent ahostsv4 "$host" | awk '{print $1}' | grep -Fx "10.20.${i}.10" >/dev/null ||
    fail "$host does not resolve to 10.20.${i}.10."
done

if pgrep -f 'org\.apache\.hadoop\.hdfs\.server\.(namenode\.NameNode|datanode\.DataNode|journalnode\.JournalNode)' >/dev/null; then
  fail 'An HDFS daemon is already running.'
fi
for role in namenode journalnode datanode; do
  unit="hadoop-hdfs-${role}.service"
  systemctl is-active --quiet "$unit" && fail "$unit is already active."
  if [[ -e "/etc/systemd/system/$unit" ]] && ! contains_role "$role"; then
    fail "Unexpected role unit exists on Node $node: $unit"
  fi
done
if [[ "$node" == 1 || "$node" == 2 ]]; then
  [[ ! -e /var/lib/hadoop-hdfs/namenode/current/VERSION ]] || fail 'NameNode is already formatted.'
fi

if getent passwd hdfs >/dev/null; then
  [[ "$(id -gn hdfs)" == hadoop ]] || fail 'Existing hdfs user does not use the hadoop primary group.'
  [[ "$(getent passwd hdfs | cut -d: -f6)" == /var/lib/hadoop-hdfs ]] || fail 'Existing hdfs user has an unexpected home.'
  [[ "$(getent passwd hdfs | cut -d: -f7)" == /usr/sbin/nologin ]] || fail 'Existing hdfs user has an interactive shell.'
  [[ "$(passwd -S hdfs | awk '{print $2}')" == L ]] || fail 'Existing hdfs user password is not locked.'
fi
[[ ! -e /var/lib/hadoop-hdfs/.ssh && ! -L /var/lib/hadoop-hdfs/.ssh ]] || fail 'The hdfs service account must not have an SSH directory.'

other_install="$(find /opt -mindepth 1 -maxdepth 1 -name 'hadoop-*' ! -name "hadoop-${HADOOP_VERSION}" -print -quit 2>/dev/null || true)"
[[ -z "$other_install" ]] || fail "Another Hadoop installation exists: $other_install"
if [[ -e "$HADOOP_VERSION_HOME" || -L "$HADOOP_VERSION_HOME" ]]; then
  [[ -d "$HADOOP_VERSION_HOME" && ! -L "$HADOOP_VERSION_HOME" && -f "$HADOOP_VERSION_HOME/.planetory-distribution.sha512" && ! -L "$HADOOP_VERSION_HOME/.planetory-distribution.sha512" ]] ||
    fail "$HADOOP_VERSION_HOME exists without a Planetory checksum marker."
fi
if [[ -e "$HADOOP_HOME" || -L "$HADOOP_HOME" ]]; then
  [[ -L "$HADOOP_HOME" && "$(readlink -f "$HADOOP_HOME")" == "$HADOOP_VERSION_HOME" ]] ||
    fail "$HADOOP_HOME does not point to $HADOOP_VERSION_HOME."
fi
if [[ -e "$HADOOP_CONF_DIR" || -L "$HADOOP_CONF_DIR" ]]; then
  [[ -d "$HADOOP_CONF_DIR" && ! -L "$HADOOP_CONF_DIR" ]] || fail "$HADOOP_CONF_DIR must be a regular directory."
fi
for dir in /var/log/hadoop /run/hadoop-hdfs; do
  [[ ! -L "$dir" ]] || fail "$dir must not be a symlink."
done

same_or_absent "$source_dir/core-site.xml" "$HADOOP_CONF_DIR/core-site.xml"
same_or_absent "$source_dir/hdfs-site.xml" "$HADOOP_CONF_DIR/hdfs-site.xml"
same_or_absent "$source_dir/workers" "$HADOOP_CONF_DIR/workers"
same_or_absent "$work_dir/hadoop-env.sh" "$HADOOP_CONF_DIR/hadoop-env.sh"
same_or_absent "$work_dir/hadoop-version" "$HADOOP_CONF_DIR/.planetory-hadoop-version"
same_or_absent "$work_dir/hadoop-default" /etc/default/hadoop
same_or_absent "$work_dir/hadoop-profile.sh" /etc/profile.d/hadoop.sh
for role in "${roles[@]}"; do
  same_or_absent "$work_dir/hadoop-hdfs-${role}.service" "/etc/systemd/system/hadoop-hdfs-${role}.service"
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl openjdk-17-jdk-headless tar

java_bin=/usr/lib/jvm/java-17-openjdk-amd64/bin/java
[[ -x "$java_bin" ]] || fail "Java executable is missing: $java_bin"
"$java_bin" -version 2>&1 | grep -q 'version "17\.' || fail 'OpenJDK 17 verification failed.'

getent group hadoop >/dev/null || groupadd --system hadoop
if ! getent passwd hdfs >/dev/null; then
  useradd --system --gid hadoop --home-dir /var/lib/hadoop-hdfs --no-create-home --shell /usr/sbin/nologin hdfs
fi

checksum_name="hadoop-${HADOOP_VERSION}.tar.gz.sha512"
archive_name="hadoop-${HADOOP_VERSION}.tar.gz"
curl --fail --location --retry 3 --proto '=https' --output "$work_dir/$checksum_name" "$DOWNLOAD_BASE/$checksum_name"
expected_checksum="$(awk -F ' = ' -v label="SHA512 ($archive_name)" '$1 == label {print $2}' "$work_dir/$checksum_name")"
[[ "$expected_checksum" =~ ^[0-9a-fA-F]{128}$ ]] || fail 'Apache SHA-512 file has an unexpected format.'
expected_checksum="${expected_checksum,,}"

if [[ -d "$HADOOP_VERSION_HOME" ]]; then
  [[ "$(tr '[:upper:]' '[:lower:]' < "$HADOOP_VERSION_HOME/.planetory-distribution.sha512")" == "$expected_checksum" ]] ||
    fail "Installed Hadoop checksum differs from the Apache checksum."
  [[ -x "$HADOOP_VERSION_HOME/bin/hdfs" ]] || fail 'Installed Hadoop is missing bin/hdfs.'
else
  curl --fail --location --retry 3 --proto '=https' --output "$work_dir/$archive_name" "$DOWNLOAD_BASE/$archive_name"
  printf '%s  %s\n' "$expected_checksum" "$archive_name" > "$work_dir/check.sha512"
  (cd "$work_dir" && sha512sum --check check.sha512)
  tar -xzf "$work_dir/$archive_name" -C "$work_dir"
  [[ -x "$work_dir/hadoop-${HADOOP_VERSION}/bin/hdfs" ]] || fail 'Downloaded Hadoop archive is invalid.'
  mv "$work_dir/hadoop-${HADOOP_VERSION}" "$HADOOP_VERSION_HOME"
  printf '%s' "$expected_checksum" > "$HADOOP_VERSION_HOME/.planetory-distribution.sha512"
  chown -R root:root "$HADOOP_VERSION_HOME"
  chmod -R go-w "$HADOOP_VERSION_HOME"
fi
[[ -L "$HADOOP_HOME" ]] || ln -s "$HADOOP_VERSION_HOME" "$HADOOP_HOME"

install -d -o root -g root -m 0755 "$HADOOP_CONF_DIR"
cp -a --no-clobber "$HADOOP_VERSION_HOME/etc/hadoop/." "$HADOOP_CONF_DIR/"
install -o root -g root -m 0644 "$source_dir/core-site.xml" "$HADOOP_CONF_DIR/core-site.xml"
install -o root -g root -m 0644 "$source_dir/hdfs-site.xml" "$HADOOP_CONF_DIR/hdfs-site.xml"
install -o root -g root -m 0644 "$source_dir/workers" "$HADOOP_CONF_DIR/workers"
install -o root -g root -m 0644 "$work_dir/hadoop-env.sh" "$HADOOP_CONF_DIR/hadoop-env.sh"
install -o root -g root -m 0644 "$work_dir/hadoop-default" /etc/default/hadoop
install -o root -g root -m 0644 "$work_dir/hadoop-profile.sh" /etc/profile.d/hadoop.sh
install -o root -g root -m 0644 "$work_dir/hadoop-version" "$HADOOP_CONF_DIR/.planetory-hadoop-version"
chown -R root:root "$HADOOP_CONF_DIR"
chmod -R go-w "$HADOOP_CONF_DIR"

install -d -o hdfs -g hadoop -m 0750 /var/log/hadoop /run/hadoop-hdfs
for dir in "${data_dirs[@]}"; do
  install -d -o hdfs -g hadoop -m 0750 "$dir"
done

for role in "${roles[@]}"; do
  install -o root -g root -m 0644 "$work_dir/hadoop-hdfs-${role}.service" "/etc/systemd/system/hadoop-hdfs-${role}.service"
done
systemctl daemon-reload

[[ "$(runuser -u hdfs -- env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_HOME=/opt/hadoop HADOOP_CONF_DIR=/etc/hadoop HADOOP_LOG_DIR=/var/log/hadoop HADOOP_PID_DIR=/run/hadoop-hdfs "$HADOOP_HOME/bin/hdfs" version | awk 'NR == 1 {print $2}')" == "$HADOOP_VERSION" ]] ||
  fail 'Hadoop version verification failed.'
for dir in /var/log/hadoop /run/hadoop-hdfs "${data_dirs[@]}"; do
  runuser -u hdfs -- test -w "$dir" || fail "hdfs cannot write to $dir"
done
for role in "${roles[@]}"; do
  unit="hadoop-hdfs-${role}.service"
  systemctl is-active --quiet "$unit" && fail "$unit started unexpectedly."
  systemctl is-enabled --quiet "$unit" && fail "$unit was enabled unexpectedly."
done
if [[ "$node" == 1 || "$node" == 2 ]]; then
  [[ ! -e /var/lib/hadoop-hdfs/namenode/current/VERSION ]] || fail 'NameNode was formatted unexpectedly.'
fi

printf 'PASS: Node %s prepared with Hadoop %s; HDFS daemons remain disabled and stopped.\n' "$node" "$HADOOP_VERSION"

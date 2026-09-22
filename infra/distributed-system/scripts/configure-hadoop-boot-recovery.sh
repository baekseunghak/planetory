#!/usr/bin/env bash
set -Eeuo pipefail

usage() { echo "Usage: sudo bash $0 --node <1-6> --check|--install"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
node='' action=''
while (($#)); do
  case "$1" in
    --node) (($# >= 2)) || fail 'Missing node'; node="$2"; shift 2 ;;
    --check|--install) [[ -z "$action" ]] || fail 'Choose one action'; action="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ "$node" =~ ^[1-6]$ && -n "$action" ]] || { usage; exit 2; }
[[ $EUID -eq 0 ]] || fail 'Run as root'

host=master-1
[[ "$node" == 1 ]] || host="worker-$node"
[[ "$(hostname -s)" == "$host" ]] || fail "Expected $host"
ip -4 -o address show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Fxq "10.20.$node.10" || fail 'Wrong private IP'
mountpoint -q /mnt/data || fail '/mnt/data is not mounted'
[[ "$node" != 2 ]] || mountpoint -q /mnt/metadata || fail '/mnt/metadata is not mounted'
[[ "$(readlink -f /opt/hadoop)" == /opt/hadoop-3.5.0 ]] || fail 'Unexpected Hadoop version'
[[ "$(</etc/hadoop/.planetory-hadoop-version)" == 3.5.0 ]] || fail 'Missing managed Hadoop marker'
[[ -f /etc/hadoop/hdfs-site.xml ]] || fail 'Missing HDFS configuration'
[[ -f /etc/hadoop/yarn-site.xml ]] || fail 'Missing YARN configuration'
[[ -f /etc/default/hadoop-yarn ]] || fail 'Missing YARN environment'
[[ ! -e /etc/systemd/system/planetory-hdfs-boot-recovery.service || "$node" == 1 ]] || fail 'Unexpected recovery unit on Worker'

roles=(hadoop-hdfs-datanode hadoop-yarn-nodemanager)
if [[ "$node" == 1 ]]; then
  roles=(hadoop-hdfs-journalnode hadoop-hdfs-namenode hadoop-yarn-resourcemanager)
elif [[ "$node" == 2 ]]; then
  roles=(hadoop-hdfs-journalnode hadoop-hdfs-namenode hadoop-hdfs-datanode hadoop-yarn-nodemanager)
elif [[ "$node" == 3 ]]; then
  roles=(hadoop-hdfs-journalnode hadoop-hdfs-datanode hadoop-yarn-nodemanager)
fi
for unit in "${roles[@]}"; do
  [[ -f "/etc/systemd/system/$unit.service" && ! -L "/etc/systemd/system/$unit.service" ]] || fail "Missing managed unit: $unit"
  systemctl is-active --quiet "$unit.service" || fail "Start/repair $unit before enabling boot recovery"
done
if [[ "$node" == 1 || "$node" == 2 ]]; then
  [[ -f /var/lib/hadoop-hdfs/namenode/current/VERSION ]] || fail 'NameNode has no existing format'
fi
if [[ "$node" == 1 ]]; then
  [[ "$(readlink -f /var/lib/hadoop-hdfs/namenode)" == /mnt/data/namenode ]] || fail 'Wrong NameNode disk'
  [[ "$(readlink -f /var/lib/hadoop-hdfs/journal)" == /mnt/data/journal ]] || fail 'Wrong JournalNode disk'
elif [[ "$node" == 2 ]]; then
  [[ "$(readlink -f /var/lib/hadoop-hdfs/namenode)" == /mnt/metadata/namenode ]] || fail 'Wrong NameNode disk'
  [[ "$(readlink -f /var/lib/hadoop-hdfs/journal)" == /mnt/metadata/journal ]] || fail 'Wrong JournalNode disk'
fi
[[ "$(runuser -u hdfs -- env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs getconf -confKey dfs.ha.automatic-failover.enabled)" == false ]] || fail 'Automatic HA mode differs from boot-only contract'

controller="$(dirname "$(readlink -f "$0")")/hadoop-boot-controller.sh"
if [[ "$node" == 1 ]]; then
  [[ -f "$controller" && ! -L "$controller" ]] || fail 'Missing controller beside installer'
  bash -n "$controller" || fail 'Invalid controller syntax'
  hdfs_cmd=(runuser -u hdfs -- env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs)
  nn1="$(timeout 12 "${hdfs_cmd[@]}" haadmin -getServiceState nn1)" || fail 'Cannot query nn1'
  nn2="$(timeout 12 "${hdfs_cmd[@]}" haadmin -getServiceState nn2)" || fail 'Cannot query nn2'
  case "$nn1:$nn2" in
    active:standby|standby:active) ;;
    standby:standby)
      count=0
      for journal in master-1 worker-2 worker-3; do
        if timeout 3 bash -c 'echo >/dev/tcp/"$1"/8485' _ "$journal" 2>/dev/null; then ((count+=1)); fi
      done
      ((count >= 2)) || fail 'Both standby but JournalNode quorum is unavailable'
      timeout 15 "${hdfs_cmd[@]}" dfsadmin -fs hdfs://master-1:8020 -safemode get | grep -Fq 'Safe mode is OFF' || fail 'Both standby but nn1 Safe Mode is active'
      echo 'NOTICE: both standby; installing the Node 1 timer can promote nn1 when its checks pass'
      ;;
    *) fail 'NameNode states are inconsistent or unreachable' ;;
  esac
fi

# Existing drop-ins are never overwritten unless identical to this version.
check_managed() {
  local target="$1" content="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] || fail "Invalid managed target: $target"
    cmp -s "$content" "$target" || fail "Conflicting managed target: $target"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
if [[ "$node" == 1 || "$node" == 2 ]]; then
  mkdir -p "$tmp/hadoop-hdfs-namenode.service.d"
  printf '[Unit]\nWants=hadoop-hdfs-journalnode.service\nAfter=hadoop-hdfs-journalnode.service\n' > "$tmp/hadoop-hdfs-namenode.service.d/planetory-boot.conf"
fi
if [[ "$node" != 1 ]]; then
  mkdir -p "$tmp/hadoop-yarn-nodemanager.service.d"
  printf '[Unit]\nWants=hadoop-hdfs-datanode.service\nAfter=hadoop-hdfs-datanode.service\n' > "$tmp/hadoop-yarn-nodemanager.service.d/planetory-boot.conf"
else
  mkdir -p "$tmp/hadoop-yarn-resourcemanager.service.d"
  cat > "$tmp/hadoop-yarn-resourcemanager.service.d/planetory-boot.conf" <<'EOF'
[Unit]
Wants=hadoop-hdfs-namenode.service
After=hadoop-hdfs-namenode.service
[Service]
ExecStartPre=/usr/bin/timeout 20 /opt/hadoop/bin/hdfs dfs -test -d /
RestartSec=30
EOF
  cat > "$tmp/planetory-hdfs-boot-recovery.service" <<'EOF'
[Unit]
Description=Conservative HDFS cold-boot Active recovery
Wants=network-online.target
After=network-online.target hadoop-hdfs-namenode.service hadoop-hdfs-journalnode.service
[Service]
Type=oneshot
ExecStart=/usr/local/libexec/planetory/hadoop-boot-controller.sh
TimeoutStartSec=90
EOF
  cat > "$tmp/planetory-hdfs-boot-recovery.timer" <<'EOF'
[Unit]
Description=Recheck HDFS boot recovery without automatic fencing
[Timer]
OnBootSec=40s
OnCalendar=minutely
AccuracySec=5s
Unit=planetory-hdfs-boot-recovery.service
[Install]
WantedBy=timers.target
EOF
fi

# Verify every target before making any persistent change.
for dir in "$tmp"/*.service.d; do
  [[ -d "$dir" ]] || continue
  target="/etc/systemd/system/$(basename "$dir")"
  [[ ! -e "$target" || ( -d "$target" && ! -L "$target" ) ]] || fail "Invalid drop-in directory: $target"
  for file in "$dir"/*; do
    check_managed "$target/$(basename "$file")" "$file"
  done
done
if [[ "$node" == 1 ]]; then
  for file in "$tmp"/*.service "$tmp"/*.timer; do
    check_managed "/etc/systemd/system/$(basename "$file")" "$file"
  done
  target=/usr/local/libexec/planetory/hadoop-boot-controller.sh
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] && cmp -s "$controller" "$target" || fail "Conflicting controller: $target"
  fi
fi
if [[ "$action" == --check ]]; then
  echo "PASS: $host boot recovery preflight; no persistent changes"
  exit 0
fi
for dir in "$tmp"/*.service.d; do
  [[ -d "$dir" ]] || continue
  target="/etc/systemd/system/$(basename "$dir")"
  install -d -o root -g root -m 0755 "$target"
  for file in "$dir"/*; do install -o root -g root -m 0644 "$file" "$target/$(basename "$file")"; done
done
if [[ "$node" == 1 ]]; then
  install -d -o root -g root -m 0755 /usr/local/libexec/planetory /etc/planetory
  install -o root -g root -m 0755 "$controller" /usr/local/libexec/planetory/hadoop-boot-controller.sh
  for file in "$tmp"/*.service "$tmp"/*.timer; do install -o root -g root -m 0644 "$file" "/etc/systemd/system/$(basename "$file")"; done
fi
systemctl daemon-reload
systemctl enable "${roles[@]/%/.service}"
[[ "$node" != 1 ]] || systemctl enable --now planetory-hdfs-boot-recovery.timer
for unit in "${roles[@]}"; do systemctl is-enabled --quiet "$unit.service" || fail "Not enabled: $unit"; done
if [[ "$node" == 1 ]]; then
  systemctl is-enabled --quiet planetory-hdfs-boot-recovery.timer || fail 'Timer not enabled'
  systemctl is-active --quiet planetory-hdfs-boot-recovery.timer || fail 'Timer not running'
fi
echo "PASS: $host boot units enabled; no running Hadoop service restarted and no reboot requested"

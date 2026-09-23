#!/usr/bin/env bash
set -Eeuo pipefail

# This is boot recovery, NOT automatic failover of an unreachable Active.
hdfs() {
  timeout 8 runuser -u hdfs -- env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    HADOOP_CONF_DIR=/etc/hadoop /opt/hadoop/bin/hdfs "$@"
}

journal_quorum() {
  local host count=0
  for host in master-1 worker-2 worker-3; do
    if timeout 3 bash -c 'echo >/dev/tcp/"$1"/8485' _ "$host" 2>/dev/null; then
      ((count+=1))
    fi
  done
  ((count >= 2))
}

states() {
  state1="$(hdfs haadmin -getServiceState nn1 2>/dev/null)" || return 1
  state2="$(hdfs haadmin -getServiceState nn2 2>/dev/null)" || return 1
  [[ "$state1" =~ ^(active|standby)$ && "$state2" =~ ^(active|standby)$ ]]
}

try_promote() {
  states || { echo 'WAIT: both NameNodes must be reachable'; return 1; }
  if [[ "$state1" == active && "$state2" == active ]]; then
    echo 'ERROR: two Active NameNodes; manual intervention required' >&2
    return 1
  fi
  if [[ "$state1" == active || "$state2" == active ]]; then
    echo "READY: existing Active is $([[ "$state1" == active ]] && echo nn1 || echo nn2)"
    return 0
  fi
  journal_quorum || { echo 'WAIT: JournalNode quorum unavailable'; return 1; }
  hdfs dfsadmin -fs hdfs://master-1:8020 -safemode get | grep -Fq 'Safe mode is OFF' || {
    echo 'WAIT: nn1 Safe Mode has not ended'; return 1;
  }
  # A second observation makes cold-start races less likely; it is not fencing.
  sleep 10
  [[ ! -e /etc/planetory/hadoop-boot-recovery.disabled ]] || return 0
  states && [[ "$state1" == standby && "$state2" == standby ]] || {
    echo 'WAIT: NameNode state changed or became unknown'; return 1;
  }
  journal_quorum || { echo 'WAIT: JournalNode quorum changed'; return 1; }
  hdfs dfsadmin -fs hdfs://master-1:8020 -safemode get | grep -Fq 'Safe mode is OFF' || return 1
  hdfs haadmin -transitionToActive nn1
  [[ "$(hdfs haadmin -getServiceState nn1)" == active ]] || return 1
  echo 'READY: nn1 promoted without force after both NameNodes reported standby'
}

main() {
  [[ "$(hostname -s)" == master-1 ]] || { echo 'Node 1 only' >&2; return 1; }
  [[ ! -e /etc/planetory/hadoop-boot-recovery.disabled ]] || { echo 'PAUSED: maintenance'; return 0; }
  exec 9>/run/lock/planetory-hdfs-boot-recovery.lock
  flock -n 9 || { echo 'WAIT: recovery check already running'; return 0; }
  mountpoint -q /mnt/data &&
    [[ "$(readlink -f /var/lib/hadoop-hdfs/namenode)" == /mnt/data/namenode ]] &&
    [[ -f /var/lib/hadoop-hdfs/namenode/current/VERSION ]] &&
    systemctl is-active --quiet hadoop-hdfs-journalnode &&
    systemctl is-active --quiet hadoop-hdfs-namenode || {
      echo 'WAIT: Node 1 mount/format/daemons unavailable'; return 1;
    }
  [[ "$(hdfs getconf -confKey dfs.ha.automatic-failover.enabled)" == false ]] || {
    echo 'ERROR: HA mode changed; stop this manual-HA controller' >&2; return 1;
  }
  try_promote
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi

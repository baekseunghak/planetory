#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 && $# == 1 ]] || exit 1
release=$1
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
base="$(cd "$(dirname "$0")/../../.." && pwd -P)"
account="$base/infra/distributed-system/scripts/configure-tess-airflow-account.sh"
[[ -f "$account" ]] || exit 1
for path in "/opt/planetory-hdfs-load/releases/$release/READY" \
            "/opt/planetory-bronze/releases/$release/.archive-sha256"; do
  [[ -f "$path" ]] || { echo AIRFLOW_DEPENDENCY_RELEASE_MISSING >&2; exit 1; }
done
keydir=/etc/planetory/airflow/ssh
install -d -o root -g root -m 0750 "$keydir"
if [[ ! -e "$keydir/id_ed25519" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C 'planetory-tess-airflow' -f "$keydir/id_ed25519" >/dev/null
fi
[[ -f "$keydir/id_ed25519.pub" ]] || { echo AIRFLOW_PUBLIC_KEY_MISSING >&2; exit 1; }
chown 50000:0 "$keydir/id_ed25519"
chmod 0400 "$keydir/id_ed25519"
public_b64="$(awk '{print $1 " " $2}' "$keydir/id_ed25519.pub" | base64 -w0)"

node1_host="$(awk '{print "10.20.1.10 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
known_hosts=/etc/planetory/tess-hdfs-runall/known_hosts
[[ "$(awk 'END {print NR}' "$known_hosts")" == 5 ]] || exit 1
expected="$(printf '10.20.%s.10\n' 2 3 4 5 6)"
[[ "$(awk '{print $1}' "$known_hosts")" == "$expected" ]] || exit 1
known_candidate="$(mktemp "$keydir/.known_hosts.XXXXXX")"
trap 'rm -f -- "$known_candidate"' EXIT
printf '%s\n' "$node1_host" > "$known_candidate"
cat "$known_hosts" >> "$known_candidate"
if [[ -f "$keydir/known_hosts" ]]; then
  cmp -s "$known_candidate" "$keydir/known_hosts" || { echo AIRFLOW_HOST_KEYS_CHANGED >&2; exit 1; }
else
  install -o root -g root -m 0644 "$known_candidate" "$keydir/known_hosts"
fi

bash "$account" node1 "$release" "$public_b64"
for node in 2 3 4 5 6; do
  ssh -T -F /dev/null -b 10.20.1.10 \
    -i /etc/planetory/tess-hdfs-runall/id_ed25519 \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" \
    "planetory-admin@10.20.$node.10" \
    "sudo -n bash -s -- worker '$release' '$public_b64'" < "$account"
done
echo "TESS_AIRFLOW_INTERNAL_SSH_READY release=$release"

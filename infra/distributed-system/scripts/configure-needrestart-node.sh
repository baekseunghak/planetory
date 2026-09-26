#!/usr/bin/env bash
# needrestart가 Hadoop 데몬과 Planetory 파이프라인 unit을 자동 재시작하지 않게 한다 (S15P21C206-78).
#
# 2026-09-25 unattended-upgrades가 libcurl 보안 업데이트를 설치한 뒤 needrestart가
# hadoop-yarn-nodemanager를 재시작해, 실행 중이던 Silver executor 6개와 그 계산 결과를 잃었다.
# 보안 업데이트 설치는 그대로 두고 이 서비스들의 재시작만 점검 시간으로 미룬다.
# 서비스 재시작·패키지·타이머는 건드리지 않는다. 여러 번 실행해도 안전하다.
set -Eeuo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

node=""
check_only=0
while (($#)); do
  case "$1" in
    --node)
      (($# >= 2)) || fail '--node requires a value.'
      node="$2"
      shift 2
      ;;
    --check-only)
      check_only=1
      shift
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$node" =~ ^[1-6]$ ]] || fail '--node must be an integer from 1 to 6.'
expected_host=master-1
[[ "$node" == 1 ]] || expected_host="worker-$node"
actual_host="$(hostname -s)"
[[ "$actual_host" == "$expected_host" ]] ||
  fail "Node mismatch: --node $node expects host '$expected_host' but this host is '$actual_host'."
command -v needrestart >/dev/null 2>&1 || fail 'needrestart is not installed.'
[[ -d /etc/needrestart/conf.d ]] || fail '/etc/needrestart/conf.d is missing.'

target=/etc/needrestart/conf.d/50-planetory.conf
candidate="$(mktemp)"
trap 'rm -f -- "$candidate"' EXIT
cat > "$candidate" <<'EOF'
# Planetory: Hadoop daemons and pipeline units restart only in a maintenance window.
# Managed by infra/distributed-system/scripts/configure-needrestart-node.sh (S15P21C206-78).
$nrconf{override_rc}{qr(^hadoop-)} = 0;
$nrconf{override_rc}{qr(^planetory-)} = 0;
EOF

# The same perl evaluation needrestart applies to conf.d, checked against real unit names.
verify() {
  perl -e '
    our %nrconf;
    do $ARGV[0]; die "parse: $@" if $@;
    for my $unit (qw(hadoop-yarn-nodemanager.service hadoop-hdfs-datanode.service
                     hadoop-hdfs-namenode.service hadoop-yarn-resourcemanager.service
                     planetory-tess-silver-20260924T133559Z.service planetory-spark-history.service)) {
      grep({ $unit =~ $_ && $nrconf{override_rc}{$_} == 0 } keys %{$nrconf{override_rc}})
        or die "not excluded: $unit\n";
    }
    for my $unit (qw(ssh.service cron.service)) {
      grep({ $unit =~ $_ } keys %{$nrconf{override_rc}}) and die "unexpectedly excluded: $unit\n";
    }' "$1"
}

state=missing
if [[ -e "$target" ]]; then
  cmp -s "$candidate" "$target" && state=installed || state=conflict
fi
printf 'node-%s (%s) %s: %s\n' "$node" "$actual_host" "$target" "$state"
# Restarts needrestart would perform now; excluded units must wait for a maintenance window.
pending="$(needrestart -b -r l 2>/dev/null | sed -n 's/^NEEDRESTART-SVC: //p' | grep -E '^(hadoop|planetory)-' || true)"
printf 'pending Hadoop/pipeline restarts: %s\n' "${pending:-none}"

if ((check_only)); then
  [[ "$state" == installed ]] && verify "$target" && { printf 'CHECK: ready\n'; exit 0; }
  printf 'CHECK: action required\n'
  exit 1
fi

[[ "$state" != conflict ]] || fail "$target differs from the managed content; inspect it before replacing."
verify "$candidate"
if [[ "$state" == missing ]]; then
  install -o root -g root -m 0644 "$candidate" "$target"
fi
verify "$target"
needrestart -b -r l >/dev/null
printf 'NEEDRESTART_OVERRIDE_READY %s\n' "$target"

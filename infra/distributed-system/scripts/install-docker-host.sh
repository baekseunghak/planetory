#!/usr/bin/env bash
# GCP 노드에 배포용 Docker 실행 환경을 준비한다.
#
# CI의 deploy job은 SSH로 접속해 docker compose를 실행한다. 그러려면 노드에
# Docker 엔진이 있고 배포 계정이 docker 그룹에 있어야 한다. 이 스크립트는
# 그 두 가지만 한다. Hadoop·YARN 데몬과 설정에는 손대지 않는다.
#
# 여러 번 실행해도 안전하다. 이미 갖춰진 항목은 건너뛴다.
set -Eeuo pipefail

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
info() { printf '  %s\n' "$*"; }

node=""
deploy_user=""
check_only=0
while (($#)); do
  case "$1" in
    --node)
      (($# >= 2)) || fail '--node requires a value.'
      node="$2"
      shift 2
      ;;
    --deploy-user)
      (($# >= 2)) || fail '--deploy-user requires a value.'
      deploy_user="$2"
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
[[ -n "$deploy_user" ]] || fail '--deploy-user is required.'

# 실행 전 검사. 대상이 맞는지, 계정이 있는지, 용량이 되는지 먼저 본다.
expected_host=master-1
[[ "$node" == 1 ]] || expected_host="worker-$node"
actual_host="$(hostname -s)"
[[ "$actual_host" == "$expected_host" ]] ||
  fail "Node mismatch: --node $node expects host '$expected_host' but this host is '$actual_host'."

id "$deploy_user" >/dev/null 2>&1 || fail "Deploy user does not exist: $deploy_user"

# 수집·Spark 이미지를 받을 여유. 설치 직후 바로 디스크가 차는 상황만 막는다.
min_free_mb=5120
free_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
((free_mb >= min_free_mb)) ||
  fail "Not enough free space on /: ${free_mb}MB available, ${min_free_mb}MB required."

has_docker=0
command -v docker >/dev/null 2>&1 && has_docker=1
# deploy job은 `docker compose`를 쓴다. docker.io 패키지에는 compose 플러그인이
# 들어 있지 않으므로 엔진만 깔고 끝내면 배포가 실패한다.
has_compose=0
docker compose version >/dev/null 2>&1 && has_compose=1
in_group=0
id -nG "$deploy_user" | tr ' ' '\n' | grep -qx docker && in_group=1

printf 'node-%s (%s)\n' "$node" "$actual_host"
info "free space: ${free_mb}MB"
info "docker installed: $has_docker"
info "docker compose available: $has_compose"
info "deploy user '$deploy_user' in docker group: $in_group"

if ((check_only)); then
  if ((has_docker && has_compose && in_group)); then
    printf 'CHECK: ready\n'
    exit 0
  fi
  printf 'CHECK: action required\n'
  exit 1
fi

[[ $EUID -eq 0 ]] || fail 'Run this script as root.'

if ((has_docker)); then
  info 'docker already installed, skipping'
else
  info 'installing docker.io from the distribution repository'
  # 배포판 패키지만 쓴다. 외부 스크립트를 내려받아 실행하지 않는다.
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null
fi

if ((has_compose)); then
  info 'docker compose already available, skipping'
else
  info 'installing docker-compose-v2'
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null
fi

systemctl enable --now docker >/dev/null
systemctl is-active --quiet docker || fail 'docker service is not active after enabling.'

if ((in_group)); then
  info "'$deploy_user' already in docker group, skipping"
else
  info "adding '$deploy_user' to docker group"
  usermod -aG docker "$deploy_user"
fi

# 검증. 설치 사실이 아니라 배포 계정이 실제로 데몬을 쓸 수 있는지 본다.
server_version="$(docker version --format '{{.Server.Version}}')"
[[ -n "$server_version" ]] || fail 'docker daemon did not report a server version.'

compose_version="$(docker compose version --short 2>/dev/null || true)"
[[ -n "$compose_version" ]] || fail 'docker compose is not available. The deploy job needs it.'
info "docker compose: $compose_version"

# usermod는 이미 열려 있는 세션에 소급되지 않는다. 새 로그인으로 확인한다.
if su -s /bin/sh -l "$deploy_user" -c 'docker version --format "{{.Server.Version}}"' >/dev/null 2>&1; then
  info "'$deploy_user' can reach the daemon"
else
  fail "'$deploy_user' cannot reach the docker daemon even in a new login shell."
fi

# Hadoop 데몬이 이 작업으로 영향을 받지 않았는지 확인한다.
# unit 이름은 실제 클러스터 기준이다. 틀리면 아무것도 검사하지 않고 조용히 통과한다.
hadoop_units=(
  hadoop-hdfs-namenode
  hadoop-hdfs-journalnode
  hadoop-hdfs-datanode
  hadoop-yarn-resourcemanager
  hadoop-yarn-nodemanager
)
found=0
for unit in "${hadoop_units[@]}"; do
  if systemctl list-units --type=service --all --no-legend "$unit.service" 2>/dev/null | grep -q .; then
    found=1
    state="$(systemctl is-active "$unit" || true)"
    info "$unit: $state"
    [[ "$state" == active ]] || fail "$unit is '$state' after the change. Investigate before continuing."
  fi
done
((found)) || info 'WARN: no Hadoop unit found on this host. Verify the unit names before trusting this check.'

printf 'OK: node-%s docker %s, compose %s, deploy user %s\n' "$node" "$server_version" "$compose_version" "$deploy_user"

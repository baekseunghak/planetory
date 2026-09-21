#!/usr/bin/env bash
# 배포 대상 호스트에 CI 전용 deploy 계정을 만든다.
#
# CI가 사람의 관리 계정을 쓰지 않게 한다. 계정을 나누면 키를 회수·교체할 때
# 사람 계정을 건드리지 않아도 되고, 접속 주체가 로그에서 갈린다.
#
# 이 계정에 sudo를 주지 않는다. 배포에 필요한 권한은 docker 그룹뿐이다.
# docker 그룹은 사실상 root와 같으므로 그 위에 sudo까지 얹지 않는다.
#
#   provision-deploy-user.sh --pubkey <공개키 파일> [--user deploy] [--check-only]
#
# 여러 번 실행해도 안전하다. 이미 갖춰진 항목은 건너뛴다.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

pubkey=""
user=deploy
check_only=0
while (($#)); do
  case "$1" in
    --pubkey) (($# >= 2)) || fail '--pubkey requires a value.'; pubkey="$2"; shift 2 ;;
    --user)   (($# >= 2)) || fail '--user requires a value.'; user="$2"; shift 2 ;;
    --check-only) check_only=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

home="/home/$user"
auth="$home/.ssh/authorized_keys"

has_user=0
id "$user" >/dev/null 2>&1 && has_user=1
in_docker=0
((has_user)) && id -nG "$user" | tr ' ' '\n' | grep -qx docker && in_docker=1
has_key=0
[[ -s "$auth" ]] && has_key=1

printf '%s\n' "$(hostname -s)"
info "계정 '$user': $has_user"
info "docker 그룹: $in_docker"
info "authorized_keys: $has_key"

if ((check_only)); then
  if ((has_user && in_docker && has_key)); then
    printf 'CHECK: ready\n'
    exit 0
  fi
  printf 'CHECK: action required\n'
  exit 1
fi

[[ $EUID -eq 0 ]] || fail 'Run this script as root.'
[[ -n "$pubkey" ]] || fail '--pubkey is required.'
[[ -r "$pubkey" ]] || fail "공개키 파일을 읽을 수 없다: $pubkey"
# 개인 키를 잘못 넘기는 사고를 막는다.
if grep -q 'PRIVATE KEY' "$pubkey"; then
  fail '개인 키가 전달됐다. 공개키(.pub)를 넘긴다.'
fi
grep -qE '^(ssh-(ed25519|rsa)|ecdsa-sha2-) ' "$pubkey" || fail '공개키 형식이 아니다.'

getent group docker >/dev/null || fail 'docker 그룹이 없다. 먼저 Docker를 설치한다.'

if ((has_user)); then
  info "'$user' 이미 있음, 건너뜀"
else
  info "'$user' 생성"
  useradd --create-home --shell /bin/bash --comment 'CI deploy account' "$user"
fi

if ((in_docker)); then
  info 'docker 그룹 이미 포함, 건너뜀'
else
  info 'docker 그룹 추가'
  usermod -aG docker "$user"
fi

install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
install -m 600 -o "$user" -g "$user" "$pubkey" "$auth"
info 'authorized_keys 설치'

# sudo를 주지 않는 것이 이 계정의 전제다. 누가 나중에 넣었는지 확인한다.
if id -nG "$user" | tr ' ' '\n' | grep -qxE 'sudo|wheel|google-sudoers|admin'; then
  info "WARN: '$user'가 sudo 계열 그룹에 있다. 의도한 구성이 아니다."
fi

# 검증. 설정이 아니라 실제로 되는지 본다.
su -s /bin/sh -l "$user" -c 'docker version --format "{{.Server.Version}}"' >/dev/null 2>&1 ||
  fail "'$user'가 docker 데몬에 도달하지 못한다."

printf 'OK: %s 준비 완료 (docker 접근 가능, sudo 없음)\n' "$user"

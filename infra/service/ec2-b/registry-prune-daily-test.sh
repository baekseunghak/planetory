#!/bin/sh
# registry-prune-daily.sh 검증. 네트워크·Webhook·레지스트리를 타지 않는다.
# 핵심은 하나다: 배포 중인 이미지를 못 읽으면 정리 스크립트를 부르지 않는다.
set -u

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sha=0123456789abcdef0123456789abcdef01234567

# 정리 스크립트 대역: 받은 인자를 적기만 한다.
printf '#!/bin/sh\necho "$@" >"%s/prune-args"\n' "$tmp" >"$tmp/prune"
chmod +x "$tmp/prune"

# run <ssh 대역 본문>
run() {
  printf '#!/bin/sh\n%s\n' "$1" >"$tmp/ssh"
  chmod +x "$tmp/ssh"
  rm -f "$tmp/prune-args" "$tmp/notify"
  WATCH_NOTIFY_LOG="$tmp/notify" REGISTRY_URL=https://example.invalid EC2_A_HOST=ec2-a.invalid \
    PRUNE_SSH="$tmp/ssh" PRUNE_BIN="$tmp/prune" bash "$here/registry-prune-daily.sh" --apply >/dev/null 2>&1
}

fails=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

run "echo BACKEND_IMAGE=r/planetory/backend:$sha; echo FRONTEND_IMAGE=r/planetory/frontend:$sha-sky"
check "배포 중인 SHA를 --in-use로 넘긴다" "grep -q -- '--in-use $sha --apply' '$tmp/prune-args'"
check "SHA가 아닌 태그 꼬리(-sky)는 버린다" "! grep -q -- '-sky' '$tmp/prune-args'"

run "exit 255"
check "SSH 실패면 정리하지 않는다" "[ ! -e '$tmp/prune-args' ]"
check "SSH 실패면 경고한다" "grep -q '건너뜀' '$tmp/notify'"

run "echo NOT_AN_IMAGE=1"
check "SHA 이미지가 없으면 정리하지 않는다" "[ ! -e '$tmp/prune-args' ]"

[ "$fails" -eq 0 ] && echo "전부 통과" || { echo "$fails개 실패"; exit 1; }

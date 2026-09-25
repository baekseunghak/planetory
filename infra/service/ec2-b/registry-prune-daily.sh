#!/usr/bin/env bash
# 레지스트리 일일 정리 [S15P21C206-262]. 알림 컨벤션은 notify.sh 머리말을 따른다.
#
# registry-prune.sh에 배포 중인 이미지를 --in-use로 넘기는 일만 한다. 나머지 인자는 그대로
# 넘긴다. cron은 --apply --gc를 주고, 사람이 볼 때는 인자 없이 돌려 모의 실행한다.
#
# 배포 중인 이미지는 EC2-A .env에서 읽는다. S15P21C206-261 이후 develop 병합마다 태그가 생겨
# 배포 중인 이미지가 최신 KEEP개 밖으로 밀리기 쉽다. **읽지 못하면 지우지 않는다.** 보호 목록
# 없이 돌면 운영 이미지를 지우고, 그 뒤로는 롤백도 재배포도 pull에서 실패한다.
#
# GCP 노드 이미지는 보호 목록에 넣지 않는다. 변경이 있을 때만 빌드돼 KEEP개 안에 머문다.
set -Eeuo pipefail
. "$(dirname "$0")/notify.sh"

: "${REGISTRY_URL:?REGISTRY_URL이 필요하다}"
: "${EC2_A_HOST:?EC2_A_HOST가 필요하다. tailnet 주소나 이름}"
deploy_path="${EC2_A_DEPLOY_PATH:-/home/deploy/planetory}"
keep="${PRUNE_KEEP:-30}"
ssh_bin="${PRUNE_SSH:-ssh}"
prune_bin="${PRUNE_BIN:-$(dirname "$0")/registry-prune.sh}"

skip() {
  notify_send warn "레지스트리 정리 건너뜀 — $1. 아무것도 지우지 않았다. EC2-A 접속(ssh deploy@$EC2_A_HOST)과 $deploy_path/.env를 확인한다."
  exit 1
}

# grep은 원격에서 한다. .env의 비밀 값을 이 노드로 가져오지 않는다.
declared=$("$ssh_bin" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  "deploy@$EC2_A_HOST" "grep -hE '^[A-Z_]+_IMAGE=' '$deploy_path/.env'") || skip "EC2-A에서 배포 중인 이미지를 읽지 못했다"
in_use=$(printf '%s\n' "$declared" | grep -oE '[0-9a-f]{40}' | sort -u | paste -sd, -) || true
[[ -n "$in_use" ]] || skip "EC2-A .env에 commit SHA 이미지가 없다"

notify_log "prune keep=$keep in_use=$in_use $*"
exec "$prune_bin" --registry "$REGISTRY_URL" --keep "$keep" --in-use "$in_use" "$@"

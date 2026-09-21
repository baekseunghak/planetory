#!/usr/bin/env bash
# 레지스트리의 오래된 commit SHA 태그를 정리한다.
#
# 정책
#   - 저장소마다 최신 KEEP개만 남긴다. 기본 10개다.
#   - commit SHA 형식(40자리 16진수) 태그만 후보다. latest처럼 사람이 붙인
#     이름은 형식이 달라 지우지 않는다.
#   - 배포 중인 이미지를 지우면 롤백이 막힌다. --in-use로 보호할 태그를 준다.
#     각 노드 .env에 적힌 SHA를 넘기면 된다.
#   - 삭제는 digest 단위라 같은 digest를 가리키는 태그가 함께 사라진다.
#     내용이 같은 커밋은 digest도 같으므로, 남길 태그와 digest가 겹치면
#     후보라도 건너뛴다. 이 보호가 없으면 최신 태그와 latest까지 날아간다.
#   - 매니페스트를 지워도 블롭은 남는다. 실제 용량은 --gc에서 준다.
#
#   registry-prune.sh --registry <URL> [--keep N] [--in-use <sha>[,<sha>...]]
#                     [--apply] [--gc]
#
# 기본은 모의 실행이다. --apply 없이는 아무것도 지우지 않는다.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

registry=""
keep=10
in_use=""
apply=0
do_gc=0
container="${REGISTRY_CONTAINER:-registry}"
while (($#)); do
  case "$1" in
    --registry) (($# >= 2)) || fail '--registry requires a value.'; registry="$2"; shift 2 ;;
    --keep)     (($# >= 2)) || fail '--keep requires a value.'; keep="$2"; shift 2 ;;
    --in-use)   (($# >= 2)) || fail '--in-use requires a value.'; in_use="$2"; shift 2 ;;
    --apply)    apply=1; shift ;;
    --gc)       do_gc=1; shift ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$registry" ]] || fail '--registry is required. 예: https://<호스트>:5000'
[[ "$keep" =~ ^[0-9]+$ ]] && ((keep >= 1)) || fail '--keep must be a positive integer.'
command -v curl >/dev/null 2>&1 || fail 'curl이 필요하다.'

api() { curl -sS --max-time 20 "$@"; }

json_array() { tr -d ' ' | sed -n "s/.*\"$1\":\\[\\([^]]*\\)\\].*/\\1/p" | tr ',' '\n' | tr -d '"' | sed '/^$/d'; }

digest_of() {
  api -I \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "$registry/v2/$1/manifests/$2" |
    grep -i '^docker-content-digest:' | tr -d '\r' | awk '{print $2}'
}

created_of() {
  api -H 'Accept: application/vnd.docker.distribution.manifest.v1+prettyjws' \
    "$registry/v2/$1/manifests/$2" 2>/dev/null |
    grep -o '"created":"[^"]*"' | head -1 | cut -d'"' -f4
}

repos="$(api "$registry/v2/_catalog?n=1000" | json_array repositories)"
[[ -n "$repos" ]] || { printf '저장소가 없다.\n'; exit 0; }

# 보호 목록. 부분 일치가 아니라 정확히 같은 태그만 지킨다.
protected="$(printf '%s' "$in_use" | tr ',' '\n' | sed '/^$/d')"
is_protected() {
  [[ -n "$protected" ]] || return 1
  printf '%s\n' "$protected" | grep -qx "$1"
}

total_del=0
total_keep=0

for repo in $repos; do
  tags="$(api "$registry/v2/$repo/tags/list" | json_array tags)"
  if [[ -z "$tags" ]]; then
    printf '%s: 태그 없음\n' "$repo"
    continue
  fi

  sha_tags="$(printf '%s\n' "$tags" | grep -E '^[0-9a-f]{40}$' || true)"
  if [[ -z "$sha_tags" ]]; then
    printf '%s: SHA 태그 없음 (기타 태그 유지)\n' "$repo"
    continue
  fi

  # 최신 판단은 매니페스트 생성 시각으로 한다. 태그 문자열 순서는 의미가 없다.
  ranked=""
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    created="$(created_of "$repo" "$tag" || true)"
    [[ -n "$created" ]] || created="0000-00-00T00:00:00Z"
    ranked+="$created $tag"$'\n'
  done <<<"$sha_tags"
  sorted="$(printf '%s' "$ranked" | sed '/^$/d' | sort -r | awk '{print $2}')"

  # 1단계: 남길 태그와 지울 후보를 나눈다.
  keep_digests=""
  drop_tags=""
  idx=0
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    idx=$((idx + 1))
    if ((idx <= keep)); then
      total_keep=$((total_keep + 1))
      keep_digests+="$(digest_of "$repo" "$tag")"$'\n'
    elif is_protected "$tag"; then
      printf '%s: %s 보호됨(배포 중)\n' "$repo" "${tag:0:12}"
      total_keep=$((total_keep + 1))
      keep_digests+="$(digest_of "$repo" "$tag")"$'\n'
    else
      drop_tags+="$tag"$'\n'
    fi
  done <<<"$sorted"

  # SHA가 아닌 태그도 지켜야 한다. digest가 같으면 함께 지워지기 때문이다.
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    printf '%s' "$tag" | grep -qE '^[0-9a-f]{40}$' && continue
    keep_digests+="$(digest_of "$repo" "$tag")"$'\n'
  done <<<"$tags"

  # 2단계: 남길 digest를 건드리지 않는 것만 지운다.
  deleted_digests=""
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    d="$(digest_of "$repo" "$tag")"
    if [[ -z "$d" ]]; then
      printf '%s: %s digest를 찾지 못해 건너뜀\n' "$repo" "${tag:0:12}"
      continue
    fi
    if printf '%s\n' "$keep_digests" | grep -qx "$d"; then
      printf '%s: %s 남길 태그와 같은 이미지라 건너뜀\n' "$repo" "${tag:0:12}"
      total_keep=$((total_keep + 1))
      continue
    fi
    if printf '%s\n' "$deleted_digests" | grep -qx "$d"; then
      total_del=$((total_del + 1))
      continue
    fi
    if ((apply)); then
      code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$registry/v2/$repo/manifests/$d")"
      printf '%s: %s 삭제 (HTTP %s)\n' "$repo" "${tag:0:12}" "$code"
    else
      printf '%s: %s 삭제 예정\n' "$repo" "${tag:0:12}"
    fi
    deleted_digests+="$d"$'\n'
    total_del=$((total_del + 1))
  done <<<"$drop_tags"
done

if ((apply)); then
  printf '\n삭제 %d개, 유지 %d개\n' "$total_del" "$total_keep"
else
  printf '\n모의 실행: 삭제 예정 %d개, 유지 %d개. 실제로 지우려면 --apply를 준다.\n' "$total_del" "$total_keep"
fi

if ((do_gc)); then
  ((apply)) || fail '--gc는 --apply와 함께 써야 의미가 있다.'
  command -v docker >/dev/null 2>&1 || fail 'docker가 필요하다.'
  # 가비지 수집 중 push가 들어오면 방금 올린 블롭이 회수될 수 있다.
  # 레지스트리를 읽기 전용으로 두고 돌린 뒤 되돌린다.
  printf '\n가비지 수집 시작. 그동안 push가 거부된다.\n'
  docker exec -e REGISTRY_STORAGE_MAINTENANCE_READONLY='{"enabled":true}' "$container" \
    registry garbage-collect /etc/distribution/config.yml ||
    fail '가비지 수집 실패. 레지스트리 상태를 확인한다.'
  docker restart "$container" >/dev/null
  printf '가비지 수집 완료, 레지스트리 재시작됨.\n'
fi

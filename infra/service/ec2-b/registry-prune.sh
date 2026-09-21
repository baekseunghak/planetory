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
data_dir="${REGISTRY_DATA_DIR:-/srv/registry/data}"
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
command -v python3 >/dev/null 2>&1 || fail 'python3가 필요하다. JSON 파싱에 쓴다.'

api() { curl -sS --max-time 20 "$@"; }

# JSON은 python으로 읽는다. 무엇을 지울지 정하는 입력이라 파싱이 틀리면
# 곧바로 잘못된 삭제가 된다. 레지스트리 응답은 여러 줄로 정렬돼 오고
# 매니페스트는 중첩이라 sed·grep으로는 조용히 어긋난다.
json_array() {
  python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
for v in (d.get('$1') or []):
    print(v)
"
}

digest_of() {
  api -I \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "$registry/v2/$1/manifests/$2" |
    grep -i '^docker-content-digest:' | tr -d '\r' | awk '{print $2}'
}

ACCEPT_ALL=(
  -H 'Accept: application/vnd.oci.image.index.v1+json'
  -H 'Accept: application/vnd.oci.image.manifest.v1+json'
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json'
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json'
)

# 생성 시각은 이미지 config 블롭에만 있다.
# schema1(v1+prettyjws)에서 읽던 초판은 registry 3이 OCI 매니페스트를 쓰면서
# 항상 404를 받았다. 그래서 모든 태그의 시각이 비고, 보존 대상이 생성순이 아니라
# 태그 문자열 역순으로 정해졌다. 최신 이미지가 삭제 후보가 되는 상태였다.
# 매니페스트에서 config 블롭 digest를 꺼낸다. 인덱스면 첫 자식을 가리킨다.
# 출력은 `child <digest>` 또는 `config <digest>`.
manifest_ref() {
  python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(1)
ms=d.get('manifests')
if ms:
    print('child', ms[0]['digest'])
elif d.get('config',{}).get('digest'):
    print('config', d['config']['digest'])
else:
    sys.exit(1)
"
}

created_of() {
  _repo="$1"
  _ref="$2"
  _out="$(api "${ACCEPT_ALL[@]}" "$registry/v2/$_repo/manifests/$_ref" 2>/dev/null | manifest_ref)" || return 1
  _kind="${_out%% *}"
  _dig="${_out##* }"

  # 멀티 아키텍처 인덱스면 첫 자식 매니페스트를 한 번 더 따라간다.
  if [[ "$_kind" == child ]]; then
    _out="$(api "${ACCEPT_ALL[@]}" "$registry/v2/$_repo/manifests/$_dig" 2>/dev/null | manifest_ref)" || return 1
    [[ "${_out%% *}" == config ]] || return 1
    _dig="${_out##* }"
  fi

  _created="$(api "$registry/v2/$_repo/blobs/$_dig" 2>/dev/null | python3 -c "
import json,sys
try:
    print(json.load(sys.stdin).get('created') or '')
except Exception:
    sys.exit(1)
")" || return 1
  [[ -n "$_created" ]] || return 1
  printf '%s' "$_created"
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

  # 최신 판단은 이미지 생성 시각으로 한다. 태그 문자열 순서는 의미가 없다.
  #
  # 시각을 하나라도 못 읽으면 이 저장소는 건드리지 않는다. 대체값을 넣으면
  # 정렬이 조용히 태그 문자열 순서로 바뀌어 최신 이미지를 지우게 된다.
  # 못 지우는 것보다 잘못 지우는 것이 훨씬 비싸다.
  ranked=""
  missing=0
  while IFS= read -r tag; do
    [[ -n "$tag" ]] || continue
    if created="$(created_of "$repo" "$tag")"; then
      ranked+="$created $tag"$'\n'
    else
      printf '%s: %s 생성 시각을 읽지 못했다\n' "$repo" "${tag:0:12}"
      missing=1
    fi
  done <<<"$sha_tags"

  if ((missing)); then
    printf '%s: 생성 시각을 확인하지 못해 이 저장소는 건너뛴다\n' "$repo"
    continue
  fi

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
  # 가비지 수집 중에 push가 들어오면 방금 올라온 블롭이 아직 어떤 매니페스트에도
  # 매달려 있지 않아 회수 대상이 된다. 이미지가 조용히 깨진다.
  #
  # `docker exec -e`로는 막지 못한다. 그 환경변수는 exec한 프로세스에만 붙고
  # 이미 떠 있는 레지스트리 서버는 그대로 쓰기를 받는다. 서버를 실제로 멈춰야 한다.
  # 그래서 컨테이너를 정지한 뒤 일회용 컨테이너로 스토리지를 직접 청소한다.
  gc_image="$(docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null || true)"
  [[ -n "$gc_image" ]] || fail "레지스트리 컨테이너를 찾을 수 없다: $container"
  [[ -d "$data_dir" ]] || fail "레지스트리 데이터 디렉터리가 없다: $data_dir"

  printf '\n레지스트리를 정지하고 가비지 수집을 실행한다. 그동안 push·pull이 모두 멈춘다.\n'
  docker stop "$container" >/dev/null || fail '레지스트리를 정지하지 못했다.'

  gc_status=0
  docker run --rm -v "$data_dir":/var/lib/registry "$gc_image" \
    garbage-collect /etc/distribution/config.yml || gc_status=$?

  # 수집이 실패해도 레지스트리는 반드시 되살린다. 여기서 멈추면 CI 전체가 멈춘다.
  docker start "$container" >/dev/null || fail '레지스트리를 다시 띄우지 못했다. 즉시 확인한다.'

  ((gc_status == 0)) || fail "가비지 수집이 실패했다(exit $gc_status). 레지스트리는 다시 떴다."
  printf '가비지 수집 완료, 레지스트리 재기동됨.\n'
fi

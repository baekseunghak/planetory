#!/usr/bin/env bash
# 이미지에 비밀값이 섞여 들어갔는지 검사한다.
#
# 이미지 레이어는 지워도 남는다. 한 레이어에서 비밀 파일을 넣고 다음 레이어에서
# 지워도 앞 레이어에 그대로 있다. 그래서 최종 파일 목록만 보지 않고 빌드
# 히스토리와 환경변수를 함께 본다.
#
#   image-secret-scan.sh <이미지 참조> [...]
#   image-secret-scan.sh --self-test
#
# 종료 코드 0은 발견 없음, 1은 발견, 2는 사용법·환경 오류다.
# 찾은 값은 마스킹해 출력한다. 리포트 자체가 비밀을 흘리면 안 된다.
set -Eeuo pipefail

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

# 어디에 있든 우리 비밀이다. 예외를 두지 않는다.
RISKY_ALWAYS='(^|/)(\.env(\..+)?|\.npmrc|\.netrc|\.pgpass|id_rsa|id_ed25519|credentials)$|(^|/)\.git/|(^|/)\.ssh/|(^|/)\.aws/'
# 인증서·키 스토어는 베이스 이미지와 타사 패키지가 정상적으로 잔뜩 넣는다.
# 이것까지 그대로 올리면 경보가 무뎌져 진짜를 놓친다. 우리가 넣을 수 없는 위치만 건너뛴다.
RISKY_CERT='\.pem$|\.p12$|\.pfx$|\.jks$|keystore'
CERT_ALLOW='^(etc/(ssl|ssl[0-9.]*|pki|ca-certificates)/|usr/(share|lib|local/share)/)|/site-packages/|/dist-packages/|/node_modules/'
# 값이 비밀로 보이는 환경변수 이름.
RISKY_ENV='(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|WEBHOOK)'
# 빌드 명령에 박힌 비밀. --build-arg로 넘긴 값은 히스토리에 남는다.
RISKY_HISTORY='(PASSWORD=|PASSWD=|SECRET=|TOKEN=|API_?KEY=|ACCESS_?KEY=|BEGIN [A-Z ]*PRIVATE KEY|Authorization: ?(Bearer|Basic))'

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

# 값을 그대로 찍지 않는다. `이름=값` 형태의 값 부분을 앞 4글자만 남기고 가린다.
mask() { sed -E 's/(=|: ?)([^ "]{4})[^ "]{2,}/\1\2****/g' | cut -c1-160; }

scan_image() {
  image="$1"
  printf '%s\n' "$image"
  docker image inspect "$image" >/dev/null 2>&1 || fail "이미지를 찾을 수 없다: $image"

  # 1) 환경변수
  docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    awk -F= 'NF {print}' |
    grep -Ei "^[^=]*$RISKY_ENV[^=]*=" >"$work/env" || true

  # 2) 빌드 히스토리
  docker history --no-trunc --format '{{.CreatedBy}}' "$image" 2>/dev/null |
    grep -Ei "$RISKY_HISTORY" >"$work/hist" || true

  # 3) 각 레이어가 담은 파일 이름
  #
  # `docker export`는 평탄화된 최종 파일시스템만 준다. 한 레이어에서 비밀을
  # 넣고 다음 레이어에서 지우면 거기엔 안 보이지만 앞 레이어에는 그대로 남아
  # 있고, 이미지를 받는 쪽은 그 레이어까지 전부 받는다. 초판이 export를 써서
  # 바로 이 경우를 놓쳤다. 그래서 레이어 아카이브를 하나씩 본다.
  rm -rf "$work/img"
  mkdir -p "$work/img"
  docker save "$image" 2>/dev/null | tar -x -C "$work/img" 2>/dev/null ||
    fail "이미지를 저장할 수 없다: $image"

  : >"$work/all"
  find "$work/img" -type f -print0 |
    while IFS= read -r -d '' blob; do
      tar -tf "$blob" 2>/dev/null >>"$work/all" || true
    done

  { grep -Ei "$RISKY_ALWAYS" "$work/all" || true
    grep -Ei "$RISKY_CERT" "$work/all" | grep -Ev "$CERT_ALLOW" || true; } |
    sort -u | head -20 >"$work/files"
  rm -rf "$work/img"

  n=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '  [발견] ENV %s\n' "$(printf '%s' "$line" | mask)"
    n=$((n + 1))
  done <"$work/env"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '  [발견] HISTORY %s\n' "$(printf '%s' "$line" | mask)"
    n=$((n + 1))
  done <"$work/hist"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf '  [발견] FILE %s\n' "$line"
    n=$((n + 1))
  done <"$work/files"

  if ((n)); then
    printf '  %d건\n' "$n"
  else
    printf '  발견 없음\n'
  fi
  return "$((n > 0))"
}

self_test() {
  st="$(mktemp -d)"
  trap 'rm -rf -- "$work" "$st"; docker rmi -f planetory-scan-selftest:dirty planetory-scan-selftest:clean planetory-scan-selftest:deleted >/dev/null 2>&1 || true' EXIT

  printf 'DB_PASSWORD=hunter2\n' >"$st/.env"
  cat >"$st/Dockerfile.dirty" <<'DF'
FROM alpine:3.20
COPY .env /app/.env
ENV API_TOKEN=abcd1234efgh
DF
  cat >"$st/Dockerfile.clean" <<'DF'
FROM alpine:3.20
ENV SPRING_PROFILES_ACTIVE=prod
DF

  # 넣었다가 다음 레이어에서 지운 경우. 최종 파일시스템에는 없지만 레이어에는 남는다.
  cat >"$st/Dockerfile.deleted" <<'DF'
FROM alpine:3.20
COPY .env /app/.env
RUN rm -f /app/.env
DF

  docker build -q -f "$st/Dockerfile.dirty" -t planetory-scan-selftest:dirty "$st" >/dev/null
  docker build -q -f "$st/Dockerfile.clean" -t planetory-scan-selftest:clean "$st" >/dev/null
  docker build -q -f "$st/Dockerfile.deleted" -t planetory-scan-selftest:deleted "$st" >/dev/null

  if "$0" planetory-scan-selftest:clean >/dev/null 2>&1; then
    printf '  깨끗한 이미지: 오탐 없음\n'
  else
    printf 'FAIL: 깨끗한 이미지를 오탐했다\n'
    "$0" planetory-scan-selftest:clean || true
    exit 1
  fi

  out="$("$0" planetory-scan-selftest:dirty 2>&1)" && {
    printf 'FAIL: 심어둔 비밀을 놓쳤다\n%s\n' "$out"
    exit 1
  }
  printf '%s' "$out" | grep -q 'ENV API_TOKEN' || { printf 'FAIL: ENV 탐지 실패\n%s\n' "$out"; exit 1; }
  printf '%s' "$out" | grep -q 'FILE .*\.env' || { printf 'FAIL: 파일 탐지 실패\n%s\n' "$out"; exit 1; }
  printf '%s' "$out" | grep -q 'hunter2' && { printf 'FAIL: 비밀 원문이 리포트에 노출됐다\n'; exit 1; }
  printf '  오염된 이미지: ENV와 파일 모두 탐지, 원문 미노출\n'
  # 회귀 방지의 핵심. export만 보던 초판은 여기서 "발견 없음"을 냈다.
  out2="$("$0" planetory-scan-selftest:deleted 2>&1)" && {
    printf 'FAIL: 다음 레이어에서 지운 비밀을 놓쳤다. 레이어별 검사가 동작하지 않는다\n%s\n' "$out2"
    exit 1
  }
  printf '%s' "$out2" | grep -q 'FILE .*\.env' || { printf 'FAIL: 삭제된 .env를 레이어에서 찾지 못했다\n%s\n' "$out2"; exit 1; }
  printf '  지워진 레이어의 비밀: 탐지\n'

  printf 'PASS: 탐지·오탐 없음·마스킹·삭제된 레이어까지 확인\n'
}

(($#)) || fail '사용법: image-secret-scan.sh <이미지 참조> [...] | --self-test'
command -v docker >/dev/null 2>&1 || fail 'docker가 필요하다.'

if [ "$1" = "--self-test" ]; then
  self_test
  exit 0
fi

total=0
for image in "$@"; do
  scan_image "$image" || total=$((total + 1))
done

if ((total)); then
  printf '\n결과: %d개 이미지에서 발견. 배포 전에 제거한다.\n' "$total"
  exit 1
fi
printf '\n결과: 발견 없음\n'

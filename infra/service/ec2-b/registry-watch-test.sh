#!/bin/sh
# registry-watch.sh의 세 점검을 검증한다. 네트워크·Webhook·docker를 타지 않는다.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# run <모드> [VAR=VAL ...]
run() {
  _mode=$1
  shift
  WATCH_NOTIFY_LOG="$tmp/notify" WATCH_STATE_DIR="$tmp" REGISTRY_URL=https://example.invalid \
    env "$@" sh "$here/registry-watch.sh" "$_mode" >>"$tmp/log" 2>&1
}
fail() { echo "FAIL: $1"; echo "--- 알림 ---"; cat "$tmp/notify" 2>/dev/null; echo "--- 로그 ---"; cat "$tmp/log" 2>/dev/null; exit 1; }
count() { if [ -f "$tmp/notify" ]; then wc -l <"$tmp/notify" | tr -d ' '; else echo 0; fi; }

# 1) 무응답: 임계 3회에 1건, 4회째 억제, 복구 1건
printf '%s' 'xxxxo' >"$tmp/probe"
i=0
while [ "$i" -lt 5 ]; do
  run health WATCH_PROBE_FILE="$tmp/probe" WATCH_THRESHOLD=3
  i=$((i + 1))
done
[ "$(count)" -eq 2 ] || fail "무응답 알림 2건을 기대했으나 $(count)건"
head -1 "$tmp/notify" | grep -q '레지스트리 무응답' || fail "첫 알림이 무응답이 아니다"
head -1 "$tmp/notify" | grep -q '🚨' || fail "긴급 이모지가 없다"
tail -1 "$tmp/notify" | grep -q '✅' || fail "복구 이모지가 없다"

# 2) 디스크: 임계 초과 1건, 반복 억제, 회복 1건
rm -f "$tmp/notify"
run disk REGISTRY_DISK_PCT_STUB=90
run disk REGISTRY_DISK_PCT_STUB=92
[ "$(count)" -eq 1 ] || fail "디스크 경고는 1건이어야 하는데 $(count)건"
grep -q '⚠️' "$tmp/notify" || fail "경고 이모지가 없다"
grep -q '90%' "$tmp/notify" || fail "사용률이 본문에 없다"
run disk REGISTRY_DISK_PCT_STUB=40
[ "$(count)" -eq 2 ] || fail "디스크 회복 알림이 없다"

# 3) 임계 미만에서는 아무것도 보내지 않는다
rm -f "$tmp/notify"
run disk REGISTRY_DISK_PCT_STUB=10
[ "$(count)" -eq 0 ] || fail "정상일 때 알림이 나갔다"

# 4) 인증서: 갱신 실패 1건, 반복 억제, 성공 시 회복 1건
rm -f "$tmp/notify"
: >"$tmp/tls.crt"
run cert REGISTRY_CERT_STUB=fail REGISTRY_CERT_NAME=x REGISTRY_CERT_DIR="$tmp"
run cert REGISTRY_CERT_STUB=fail REGISTRY_CERT_NAME=x REGISTRY_CERT_DIR="$tmp"
[ "$(count)" -eq 1 ] || fail "인증서 경고는 1건이어야 하는데 $(count)건"
grep -q '인증서 갱신 실패' "$tmp/notify" || fail "인증서 실패 문구가 없다"
run cert REGISTRY_CERT_STUB=ok REGISTRY_CERT_NAME=x REGISTRY_CERT_DIR="$tmp"
[ "$(count)" -eq 2 ] || fail "인증서 회복 알림이 없다"

echo "PASS: 무응답·디스크·인증서 각각 1건 알림, 중복 억제, 복구 알림, 정상 시 무알림"

#!/bin/sh
# uptime-watch.sh의 임계·중복억제·복구 판정을 검증한다.
# 상태가 실행 사이에 파일로 이어지므로 실제로 여러 번 호출해 확인한다.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# x x o  x x x x o
#     └ 임계 전 복구(알림 없음)
#           └ 3회째에 장애 알림, 4회째는 중복 억제
#                 └ 복구 알림
seq='xxoxxxxo'
printf '%s' "$seq" >"$tmp/probe"

i=0
n=$(printf '%s' "$seq" | wc -c | tr -d ' ')
while [ "$i" -lt "$n" ]; do
  WATCH_PROBE_FILE="$tmp/probe" \
  WATCH_NOTIFY_LOG="$tmp/notify" \
  WATCH_STATE="$tmp/state" \
  WATCH_THRESHOLD=3 \
  WATCH_URL=https://example.invalid/ \
    sh "$here/uptime-watch.sh" >>"$tmp/log" 2>&1
  i=$((i + 1))
done

[ -f "$tmp/notify" ] || { echo "FAIL: 알림이 한 번도 발생하지 않았다"; cat "$tmp/log"; exit 1; }

lines=$(wc -l <"$tmp/notify" | tr -d ' ')
if [ "$lines" -ne 2 ]; then
  echo "FAIL: 알림 2건을 기대했으나 ${lines}건"
  cat "$tmp/notify"
  exit 1
fi

head -1 "$tmp/notify" | grep -q '장애 의심' || { echo "FAIL: 첫 알림은 장애여야 한다"; cat "$tmp/notify"; exit 1; }
head -1 "$tmp/notify" | grep -q '연속 3회' || { echo "FAIL: 임계 3회에서 알려야 한다"; cat "$tmp/notify"; exit 1; }
tail -1 "$tmp/notify" | grep -q '복구' || { echo "FAIL: 마지막 알림은 복구여야 한다"; cat "$tmp/notify"; exit 1; }

read -r fails alerted <"$tmp/state"
[ "$fails" = "0" ] && [ "$alerted" = "0" ] || { echo "FAIL: 복구 후 상태가 '0 0'이 아니다: $fails $alerted"; exit 1; }

echo "PASS: 임계 3회 알림 1건, 중복 억제, 복구 알림 1건, 상태 초기화"

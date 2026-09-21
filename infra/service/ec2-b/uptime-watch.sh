#!/bin/sh
# 공개 URL 알림 전용 외부 관찰(인계 100).
# 사람에게 알리기만 한다. 진입 전환·DNS 편집에 개입하지 않는다.
# 근거: docs/architecture/ec2-service-entry-failover.md 4장과 D4.
#
# EC2-A와 같은 가용 영역에서 돌므로 인스턴스·앱·터널 장애만 감지한다.
# 가용 영역이나 리전 단위 장애는 관찰자도 함께 멈춰 감지하지 못한다.
set -eu

# 감시 대상은 실제 서비스가 응답하는 공개 URL이다. 기본값을 두지 않는다.
# 잘못된 기본값은 「감시하고 있다」는 착각만 만들고 정작 장애는 못 잡는다.
URL="${WATCH_URL:?WATCH_URL을 지정한다}"
STATE="${WATCH_STATE:-/var/lib/planetory-watch/state}"
HOOK_FILE="${WATCH_HOOK_FILE:-/etc/planetory/mattermost-webhook}"
THRESHOLD="${WATCH_THRESHOLD:-3}"
TIMEOUT="${WATCH_TIMEOUT:-10}"

log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
}

# 성공이면 0을 반환하고 표준출력에 판정 근거를 남긴다.
probe() {
  if [ -n "${WATCH_PROBE_FILE:-}" ]; then
    # 자체 검사용. 파일에 적힌 결과를 앞에서부터 하나씩 소비한다(o=성공, x=실패).
    _seq=$(cat "$WATCH_PROBE_FILE")
    _c=$(printf '%s' "$_seq" | cut -c1)
    printf '%s' "$_seq" | cut -c2- >"$WATCH_PROBE_FILE"
    printf 'stub:%s' "$_c"
    [ "$_c" = "o" ]
    return $?
  fi

  # curl은 실패해도 -w로 코드를 찍는다(도달 실패는 000). 여기서 또 찍으면 코드가 겹친다.
  _code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  printf 'http:%s' "$_code"
  case "$_code" in
    2??|3??) return 0 ;;
    *) return 1 ;;
  esac
}

notify() {
  _text="$1"
  if [ -n "${WATCH_NOTIFY_LOG:-}" ]; then
    echo "$_text" >>"$WATCH_NOTIFY_LOG"
    return 0
  fi
  if [ ! -r "$HOOK_FILE" ]; then
    log "webhook 파일을 읽을 수 없어 알림을 보내지 못했다: $HOOK_FILE"
    return 0
  fi
  _hook=$(cat "$HOOK_FILE")
  if [ -z "$_hook" ]; then
    log "webhook 파일이 비어 있다"
    return 0
  fi
  # 알림 전송 실패가 관찰 자체를 멈추면 안 된다.
  curl -sS -o /dev/null --max-time "$TIMEOUT" \
    -X POST -H 'Content-Type: application/json' \
    --data "$(printf '{"text":"%s"}' "$_text")" \
    "$_hook" 2>/dev/null || log "알림 전송 실패"
}

mkdir -p "$(dirname "$STATE")"
[ -f "$STATE" ] || echo "0 0" >"$STATE"
read -r fails alerted <"$STATE"

if reason=$(probe); then
  if [ "$alerted" -eq 1 ]; then
    notify "복구: $URL 응답 정상 ($reason)"
    log "recovered $reason"
  fi
  fails=0
  alerted=0
else
  fails=$((fails + 1))
  log "fail $fails/$THRESHOLD $reason"
  # 임계에 처음 도달할 때만 보낸다. 장애가 이어져도 알림을 반복하지 않는다.
  if [ "$fails" -ge "$THRESHOLD" ] && [ "$alerted" -eq 0 ]; then
    notify "장애 의심: $URL 연속 $fails회 실패 ($reason). EC2-A와 Cloudflare Tunnel을 확인한다."
    alerted=1
  fi
fi

echo "$fails $alerted" >"$STATE"

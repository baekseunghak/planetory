# Mattermost 알림 공용 함수. 실행 파일이 아니라 점(.)으로 읽어 쓴다.
#
# 알림 컨벤션
#   <이모지> [심각도] <무슨 일> — <근거>. <확인할 것>.
#
#   🚨 [긴급]  사용자가 지금 영향받는다. 즉시 확인한다
#   ⚠️ [경고]  지금은 멀쩡하나 방치하면 터진다. 며칠 안에 처리한다
#   ✅ [복구]  직전 사건이 끝났다. 할 일 없다
#
#   한 사건에 한 번만 보낸다. 상황이 이어져도 반복하지 않는다.
#   복구로 사건을 닫고 그때 상태를 초기화한다.
#   정상일 때는 아무것도 보내지 않는다.
#   확인할 행동이 없는 알림은 만들지 않는다.

HOOK_FILE="${WATCH_HOOK_FILE:-/etc/planetory/mattermost-webhook}"
NOTIFY_TIMEOUT="${WATCH_TIMEOUT:-10}"
# Mattermost에서 통합 기능의 사용자 이름·아이콘 덮어쓰기가 꺼져 있으면 조용히 무시된다.
BOT_NAME="${WATCH_BOT_NAME:-CI 감시 알림}"
BOT_ICON="${WATCH_BOT_ICON:-:ssafy_emergency:}"

notify_log() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
}

# notify_send <urgent|warn|ok> <본문>
notify_send() {
  case "$1" in
    urgent) _label='🚨 [긴급]' ;;
    warn)   _label='⚠️ [경고]' ;;
    ok)     _label='✅ [복구]' ;;
    *)      notify_log "알 수 없는 심각도: $1"; return 0 ;;
  esac
  _text="$_label $2"

  if [ -n "${WATCH_NOTIFY_LOG:-}" ]; then
    echo "$_text" >>"$WATCH_NOTIFY_LOG"
    return 0
  fi
  if [ ! -r "$HOOK_FILE" ]; then
    notify_log "webhook 파일을 읽을 수 없어 알림을 보내지 못했다: $HOOK_FILE"
    return 0
  fi
  _hook=$(cat "$HOOK_FILE")
  if [ -z "$_hook" ]; then
    notify_log "webhook 파일이 비어 있다"
    return 0
  fi
  _body=$(printf '{"username":"%s","icon_emoji":"%s","text":"%s"}' "$BOT_NAME" "$BOT_ICON" "$_text")
  # 알림 전송 실패가 관찰 자체를 멈추면 안 된다.
  curl -sS -o /dev/null --max-time "$NOTIFY_TIMEOUT" -X POST -H 'Content-Type: application/json' --data "$_body" "$_hook" 2>/dev/null || notify_log "알림 전송 실패"
}

#!/bin/sh
# 이미지 레지스트리 관찰. 알림 컨벤션은 notify.sh 머리말을 따른다.
#
#   health  레지스트리 무응답 감시. 짧은 주기로 돈다
#   daily   디스크 여유와 인증서 갱신. 하루 1회
#
# 인증서는 알리지 않고 먼저 갱신한다. tailscale cert는 갱신 시점이 아니면
# 같은 인증서를 그대로 쓰므로 매일 돌려도 안전하다. 실패했을 때만 알린다.
# 인증서가 만료되면 빌드와 배포가 함께 멈춘다.
set -eu

. "$(dirname "$0")/notify.sh"

MODE="${1:-health}"
STATE_DIR="${WATCH_STATE_DIR:-/var/lib/planetory-watch}"
THRESHOLD="${WATCH_THRESHOLD:-3}"
TIMEOUT="${WATCH_TIMEOUT:-10}"
DISK_WARN_PCT="${REGISTRY_DISK_WARN_PCT:-85}"
CERT_DIR="${REGISTRY_CERT_DIR:-/srv/registry/certs}"
DATA_DIR="${REGISTRY_DATA_DIR:-/srv/registry/data}"
CONTAINER="${REGISTRY_CONTAINER:-registry}"

mkdir -p "$STATE_DIR"

# 상태 파일은 점검마다 분리한다. 한 사건의 억제가 다른 점검을 가리면 안 된다.
read_state() {
  _f="$STATE_DIR/$1"
  [ -f "$_f" ] || echo "0 0" >"$_f"
  read -r fails alerted <"$_f"
}
write_state() {
  echo "$2 $3" >"$STATE_DIR/$1"
}

probe_registry() {
  if [ -n "${WATCH_PROBE_FILE:-}" ]; then
    _seq=$(cat "$WATCH_PROBE_FILE")
    _c=$(printf '%s' "$_seq" | cut -c1)
    printf '%s' "$_seq" | cut -c2- >"$WATCH_PROBE_FILE"
    printf 'stub:%s' "$_c"
    [ "$_c" = "o" ]
    return $?
  fi
  _code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$REGISTRY_URL/v2/" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  printf 'http:%s' "$_code"
  case "$_code" in
    2??|3??) return 0 ;;
    *) return 1 ;;
  esac
}

disk_pct() {
  if [ -n "${REGISTRY_DISK_PCT_STUB:-}" ]; then
    echo "$REGISTRY_DISK_PCT_STUB"
    return 0
  fi
  df -P "$DATA_DIR" | awk 'NR==2 {gsub(/%/,"",$5); print $5}'
}

check_health() {
  : "${REGISTRY_URL:?REGISTRY_URL을 지정한다}"
  read_state registry-health
  if reason=$(probe_registry); then
    if [ "$alerted" -eq 1 ]; then
      notify_send ok "레지스트리 정상 — 이미지 push·pull이 다시 가능하다 ($reason)."
      notify_log "registry recovered $reason"
    fi
    write_state registry-health 0 0
  else
    fails=$((fails + 1))
    notify_log "registry fail $fails/$THRESHOLD $reason"
    if [ "$fails" -ge "$THRESHOLD" ] && [ "$alerted" -eq 0 ]; then
      notify_send urgent "레지스트리 무응답 — 연속 $fails회 실패 ($reason). 빌드와 배포가 모두 멈춘다. EC2-B의 registry 컨테이너를 확인한다."
      alerted=1
    fi
    write_state registry-health "$fails" "$alerted"
  fi
}

check_disk() {
  read_state registry-disk
  _pct=$(disk_pct)
  if [ "$_pct" -ge "$DISK_WARN_PCT" ]; then
    if [ "$alerted" -eq 0 ]; then
      notify_send warn "레지스트리 디스크 ${_pct}% — 임계 ${DISK_WARN_PCT}%를 넘었다. 커밋마다 SHA 태그가 쌓인다. 오래된 태그를 정리한다."
      write_state registry-disk 0 1
    fi
  else
    if [ "$alerted" -eq 1 ]; then
      notify_send ok "레지스트리 디스크 ${_pct}% — 임계 아래로 내려왔다."
    fi
    write_state registry-disk 0 0
  fi
}

check_cert() {
  : "${REGISTRY_CERT_NAME:?REGISTRY_CERT_NAME을 지정한다}"
  read_state registry-cert
  _before=$(cksum "$CERT_DIR/tls.crt" 2>/dev/null | awk '{print $1}')

  if [ -n "${REGISTRY_CERT_STUB:-}" ]; then
    _ok=$([ "$REGISTRY_CERT_STUB" = "ok" ] && echo 0 || echo 1)
  else
    tailscale cert --cert-file "$CERT_DIR/tls.crt" --key-file "$CERT_DIR/tls.key" "$REGISTRY_CERT_NAME" >/dev/null 2>&1
    _ok=$?
  fi

  if [ "$_ok" -ne 0 ]; then
    notify_log "cert 갱신 실패"
    if [ "$alerted" -eq 0 ]; then
      notify_send warn "레지스트리 인증서 갱신 실패 — 만료되면 빌드와 배포가 함께 멈춘다. EC2-B에서 tailscale cert를 직접 실행해 원인을 본다."
      write_state registry-cert 0 1
    fi
    return 0
  fi

  if [ "$alerted" -eq 1 ]; then
    notify_send ok "레지스트리 인증서 갱신 정상 — 이전 실패가 해소됐다."
  fi
  write_state registry-cert 0 0

  _after=$(cksum "$CERT_DIR/tls.crt" 2>/dev/null | awk '{print $1}')
  if [ "$_before" != "$_after" ]; then
    notify_log "cert 갱신됨. registry 재시작"
    # 레지스트리는 기동할 때만 인증서를 읽는다. 갱신했으면 다시 띄워야 적용된다.
    docker restart "$CONTAINER" >/dev/null 2>&1 || notify_log "registry 재시작 실패"
  fi
}

case "$MODE" in
  health) check_health ;;
  daily)  check_disk; check_cert ;;
  disk)   check_disk ;;
  cert)   check_cert ;;
  *) echo "사용법: $0 [health|daily|disk|cert]" >&2; exit 2 ;;
esac

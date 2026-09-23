#!/usr/bin/env bash
# Offline decision test: never executes Hadoop, systemd, or SSH.
set -Eeuo pipefail
source "$(dirname "$0")/hadoop-boot-controller.sh"

MOCK_STATE1=standby MOCK_STATE2=standby MOCK_SAFE=OFF MOCK_QUORUM=0 MOCK_PROMOTIONS=0
hdfs() {
  case "$1 $2" in
    'haadmin -getServiceState')
      if [[ "$3" == nn1 ]]; then echo "$MOCK_STATE1"; else echo "$MOCK_STATE2"; fi ;;
    'haadmin -transitionToActive')
      ((MOCK_PROMOTIONS+=1)); MOCK_STATE1=active ;;
    'dfsadmin -fs') echo "Safe mode is $MOCK_SAFE" ;;
    *) echo "Unexpected HDFS call: $*" >&2; return 1 ;;
  esac
}
journal_quorum() { return "$MOCK_QUORUM"; }
sleep() {
  if [[ -n "${MOCK_CHANGED_STATE:-}" ]]; then MOCK_STATE2="$MOCK_CHANGED_STATE"; fi
}
assert_no_promotion() {
  if try_promote >/dev/null 2>&1; then
    [[ "$MOCK_STATE1" == active || "$MOCK_STATE2" == active ]] || {
      echo 'Unexpected success with no Active' >&2; exit 1;
    }
  fi
  [[ "$MOCK_PROMOTIONS" == 0 ]] || { echo 'Unexpected promotion' >&2; exit 1; }
}

MOCK_STATE2=active
assert_no_promotion
MOCK_STATE1=active
assert_no_promotion # Split-brain must never trigger a third transition.
MOCK_STATE1=standby
MOCK_STATE2=standby
MOCK_SAFE=ON
assert_no_promotion
MOCK_SAFE=OFF
MOCK_QUORUM=1
assert_no_promotion
MOCK_QUORUM=0
MOCK_STATE2=unknown
assert_no_promotion
MOCK_STATE2=standby
MOCK_CHANGED_STATE=active
assert_no_promotion
MOCK_CHANGED_STATE=''
MOCK_STATE2=standby
try_promote >/dev/null
[[ "$MOCK_PROMOTIONS" == 1 && "$MOCK_STATE1" == active ]] || exit 1
try_promote >/dev/null # Rechecks must not promote an existing Active.
[[ "$MOCK_PROMOTIONS" == 1 ]] || exit 1
echo 'PASS: HDFS boot controller promotes only stable, reachable standby pair'

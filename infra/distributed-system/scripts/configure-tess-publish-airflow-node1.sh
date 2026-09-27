#!/usr/bin/env bash
set -euo pipefail

# Run as root on Node 1 after installing a pipeline release that carries tess_publish_ctl.py
# (run-tess-silver.ps1 -Step Install) and after configure-tess-gold-airflow-node1.sh for the same release.
# It lets the Airflow account start and read the 276 publish unit, exactly as tess_publication_contract.py
# builds the commands. The Publisher image and DB env file are root-only operator settings.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 && $# -eq 1 ]] || {
  echo PUBLISH_AIRFLOW_NODE1_ARGS >&2; exit 1;
}
release_id=$1
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo INVALID_RELEASE_ID >&2; exit 1; }
release="/opt/planetory-silver/releases/$release_id"
for path in /opt/planetory-silver /opt/planetory-silver/releases "$release" "$release/spark" \
            "$release/spark/tess_publish_ctl.py" /etc/planetory/publisher \
            /etc/planetory/publisher/env /etc/planetory/publisher/image; do
  [[ -e "$path" && ! -L "$path" && "$(stat -c %u "$path")" == 0 \
    && -z "$(find "$path" -maxdepth 0 -perm /022 -print)" ]] || {
    echo PUBLISH_PATH_NOT_ROOT_OWNED_OR_WRITABLE >&2; exit 1;
  }
done
# The controller runs as root and imports the Bronze, Silver and Gold controllers from the release.
[[ -z "$(find "$release" \( -type l -o ! -user root -o -perm /022 \) -print -quit)" ]] || {
  echo PUBLISH_PATH_NOT_ROOT_OWNED_OR_WRITABLE >&2; exit 1;
}
[[ -z "$(find /etc/planetory/publisher/env -maxdepth 0 -perm /077 -print)" ]] || {
  echo PUBLISHER_ENV_NOT_ROOT_ONLY >&2; exit 1;
}
grep -Eqx '[a-z0-9.-]+(:[0-9]+)?/planetory/publisher(:[0-9a-f]{40}|@sha256:[0-9a-f]{64})' \
  /etc/planetory/publisher/image || { echo PUBLISHER_IMAGE_NOT_PINNED >&2; exit 1; }
id tess-airflow >/dev/null
run='[0-9]{8}T[0-9]{6}Z'
sudoers="/etc/sudoers.d/planetory-tess-publish-airflow-$release_id"
candidate="$(mktemp /etc/sudoers.d/planetory-tess-publish-airflow.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
cat > "$candidate" <<EOF
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_publish_ctl\\.py start-unit publish --release-dir $release --run-id $run --approval airflow/tess-publication-run/$run/approved\$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_publish_ctl\\.py status publish --run-id $run\$
EOF
chmod 0440 "$candidate"
visudo -cf "$candidate" >/dev/null
if [[ -e "$sudoers" ]]; then
  cmp -s "$candidate" "$sudoers" || { echo PUBLISH_AIRFLOW_SUDOERS_CONFLICT >&2; exit 1; }
else
  install -o root -g root -m 0440 "$candidate" "$sudoers"
fi
visudo -c >/dev/null
if sudo -l -U tess-airflow | grep -Fq 'NOPASSWD: ALL'; then
  echo AIRFLOW_SUDO_TOO_BROAD >&2; exit 1;
fi
echo "PUBLISH_AIRFLOW_SUDO_READY release=$release_id"

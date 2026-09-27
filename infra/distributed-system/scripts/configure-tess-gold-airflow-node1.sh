#!/usr/bin/env bash
set -euo pipefail

# Run as root on Node 1 after installing an immutable pipeline release that carries the Gold stage
# (run-tess-silver.ps1 -Step Install) and after configure-tess-silver-airflow-node1.sh.
# It lets the Airflow account run exactly the commands tess_publication_contract.py builds.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 && $# -eq 1 ]] || {
  echo GOLD_AIRFLOW_NODE1_ARGS >&2; exit 1;
}
release_id=$1
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo INVALID_RELEASE_ID >&2; exit 1; }
release="/opt/planetory-silver/releases/$release_id"
for path in /opt/planetory-silver /opt/planetory-silver/releases "$release" "$release/spark" \
            "$release/spark/tess_gold_ctl.py" "$release/spark/tess_gold.py" "$release/spark/tess_gate.py" \
            "$release/spark/tess_external_ctl.py" "$release/contracts/gold/publication-candidates.schema.json"; do
  [[ -e "$path" && ! -L "$path" && "$(stat -c %u "$path")" == 0 \
    && -z "$(find "$path" -maxdepth 0 -perm /022 -print)" ]] || {
    echo GOLD_RELEASE_NOT_ROOT_OWNED_OR_WRITABLE >&2; exit 1;
  }
done
# The controllers run as root and import the whole release (Bronze/Silver controllers, astro_kernel).
[[ -z "$(find "$release" \( -type l -o ! -user root -o -perm /022 \) -print -quit)" ]] || {
  echo GOLD_RELEASE_NOT_ROOT_OWNED_OR_WRITABLE >&2; exit 1;
}
id tess-airflow >/dev/null
# sudoers requires '=' inside command arguments to be escaped as '\='.
run='[0-9]{8}T[0-9]{6}Z'
token='[A-Za-z0-9][A-Za-z0-9._/-]{0,127}'
silver="/lake/silver/pipeline_version\\=[A-Za-z0-9._-]+/run_id\\=$run/attempt\\=$run"
sudoers="/etc/sudoers.d/planetory-tess-gold-airflow-$release_id"
candidate="$(mktemp /etc/sudoers.d/planetory-tess-gold-airflow.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
cat > "$candidate" <<EOF
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_external_ctl\\.py collect --run-id $run --release-dir $release\$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_gold_ctl\\.py start-unit run --release-dir $release --run-id $run --silver-attempt $silver --external /lake/external/tess/run_id\\=$run( --required-source (exofop_toi|mast_tce_s1_s13|nea_pscomppars|nea_toi)){1,4}( --exclude-tic [0-9]+){0,20} --approval-identity $token --approval-discoverability $token --approval-external $token --shuffle-partitions [0-9]+ --output-partitions [0-9]+\$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_gold_ctl\\.py start-unit gate --release-dir $release --attempt /lake/gold/tess/publication-candidates/run_id\\=$run/attempt\\=$run\$
tess-airflow ALL=(root) NOPASSWD: /usr/bin/python3.12 ^$release/spark/tess_gold_ctl\\.py status (run|gate) --run-id $run\$
EOF
chmod 0440 "$candidate"
visudo -cf "$candidate" >/dev/null
if [[ -e "$sudoers" ]]; then
  cmp -s "$candidate" "$sudoers" || { echo GOLD_AIRFLOW_SUDOERS_CONFLICT >&2; exit 1; }
else
  install -o root -g root -m 0440 "$candidate" "$sudoers"
fi
visudo -c >/dev/null
if sudo -l -U tess-airflow | grep -Fq 'NOPASSWD: ALL'; then
  echo AIRFLOW_SUDO_TOO_BROAD >&2; exit 1;
fi
echo "GOLD_AIRFLOW_SUDO_READY release=$release_id"

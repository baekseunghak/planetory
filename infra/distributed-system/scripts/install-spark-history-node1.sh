#!/usr/bin/env bash
set -euo pipefail

# Spark History Server on Node 1 for the Bronze/Silver event logs (S15P21C206-78).
# It binds to 127.0.0.1 only. tailscale0 traffic is accepted before UFW, so an all-interfaces port would be
# open to every tailnet device; the tailnet reaches this read-only UI only through `tailscale serve`.
[[ "$(id -u)" == 0 && "$(hostname -s)" == master-1 && $# -eq 0 ]] || {
  echo SPARK_HISTORY_NODE1_ARGS >&2; exit 1;
}
image=apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1
name=planetory-spark-history.service
unit="/etc/systemd/system/$name"
log_dir=/spark-history
port=18080
hdfs_dfs=(sudo -u hdfs env JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop
  /opt/hadoop/bin/hdfs dfs)

# The same pinned image submits Spark, so it is already present; never pull a moving tag here.
docker image inspect "$image" >/dev/null || { echo SPARK_IMAGE_MISSING >&2; exit 1; }
if ! "${hdfs_dfs[@]}" -test -d "$log_dir"; then
  "${hdfs_dfs[@]}" -mkdir "$log_dir"
  "${hdfs_dfs[@]}" -chown planetory-admin "$log_dir"
  "${hdfs_dfs[@]}" -chmod 0750 "$log_dir"
fi

candidate="$(mktemp /etc/systemd/system/.planetory-spark-history.XXXXXX)"
trap 'rm -f -- "$candidate"' EXIT
cat > "$candidate" <<EOF
[Unit]
Description=Planetory Spark History Server
After=network-online.target docker.service hadoop-hdfs-namenode.service
Wants=network-online.target
Requires=docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f planetory-spark-history
ExecStart=/usr/bin/docker run --rm --name planetory-spark-history --network host \
  --add-host master-1:10.20.1.10 --add-host worker-2:10.20.2.10 --add-host worker-3:10.20.3.10 \
  --add-host worker-4:10.20.4.10 --add-host worker-5:10.20.5.10 --add-host worker-6:10.20.6.10 \
  -e HADOOP_CONF_DIR=/etc/hadoop -e HADOOP_USER_NAME=planetory-admin \
  -e SPARK_LOCAL_IP=127.0.0.1 -e SPARK_DAEMON_MEMORY=1g \
  -e "SPARK_HISTORY_OPTS=-Dspark.history.fs.logDirectory=hdfs://planetory$log_dir -Dspark.history.ui.port=$port -Dspark.history.fs.cleaner.enabled=true -Dspark.history.fs.cleaner.maxAge=30d" \
  -v /etc/hadoop:/etc/hadoop:ro --entrypoint /opt/spark/bin/spark-class \
  $image org.apache.spark.deploy.history.HistoryServer
ExecStop=/usr/bin/docker stop planetory-spark-history
Restart=always
RestartSec=30s

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$candidate"
if [[ -e "$unit" ]]; then
  cmp -s "$candidate" "$unit" || { echo SPARK_HISTORY_UNIT_CONFLICT >&2; exit 1; }
else
  mv -- "$candidate" "$unit"
  systemctl daemon-reload
fi
systemctl enable --now "$name"

for _ in $(seq 1 30); do
  curl -sf -m5 "http://127.0.0.1:$port/api/v1/applications?limit=1" >/dev/null && break
  sleep 5
done
curl -sf -m5 "http://127.0.0.1:$port/api/v1/applications?limit=1" >/dev/null || {
  echo SPARK_HISTORY_NOT_READY >&2; exit 1;
}
# Refuse to expose anything unless the server itself listens on loopback alone; the tailscaled
# listener from an earlier run of this script is the only other socket allowed on the port.
listeners="$(ss -ltnpH "sport = :$port" | grep -v '"tailscaled"' | awk '{print $4}' | sort -u)"
[[ "$listeners" == "127.0.0.1:$port" ]] || {
  systemctl disable --now "$name"; echo "SPARK_HISTORY_BIND_NOT_LOOPBACK $listeners" >&2; exit 1;
}
tailscale serve --bg --http="$port" "http://127.0.0.1:$port"
echo "SPARK_HISTORY_READY http://node-1:$port"

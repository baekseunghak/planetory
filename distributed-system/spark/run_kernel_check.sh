#!/usr/bin/env bash
# S15P21C206-127: bounded validation only; run on master with a prepared package.
set -euo pipefail
task_dir=${1:?package directory required}
mode=${2:?export or worker required}
attempt=${3:?new attempt name required}
shift 3
[[ $mode == export || $mode == worker ]]
[[ $attempt =~ ^[a-z0-9-]+$ ]]
cd "$task_dir"
sha256sum -c SHA256SUMS
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export HADOOP_CONF_DIR=/etc/hadoop
export YARN_CONF_DIR=/etc/hadoop
base=/lake/validation/worker-127-2939779df51b
runtime=/lake/bronze/tess/.runtime/python-deps-ff5d451719b11bd5eb03eb6c293987bde9b14f95478ffbee807aec7016a2a179.tar.gz
[[ $(/opt/hadoop/bin/hdfs getconf -confKey fs.defaultFS) == hdfs://planetory ]]
if /opt/hadoop/bin/hdfs dfs -test -e "$base/$attempt"; then
  echo "Output already exists: $base/$attempt" >&2
  exit 1
fi
hosts=()
for n in 1 2 3 4 5 6; do
  name=worker
  [[ $n != 1 ]] || name=master
  hosts+=(--add-host "$name-$n:10.20.$n.10")
done
set +e
sudo -n docker run --rm --network host "${hosts[@]}" \
  -e HADOOP_CONF_DIR=/etc/hadoop -e YARN_CONF_DIR=/etc/hadoop \
  -e HADOOP_USER_NAME=planetory-admin \
  -v /etc/hadoop:/etc/hadoop:ro -v "$PWD:/opt/planetory:ro" \
  --entrypoint /opt/spark/bin/spark-submit \
  apache/spark@sha256:39321d67b23e2e0953f81b60778f74bf40c40a18dfb0e881e6a38593af60afa1 \
  --master yarn --deploy-mode cluster --name "S15P21C206-127-$attempt" \
  --archives "hdfs://planetory$runtime#environment" \
  --py-files /opt/planetory/kernel-check.zip \
  --conf spark.driver.port=7078 --conf spark.blockManager.port=7079 \
  --conf "spark.yarn.stagingDir=hdfs://planetory$base/staging-$attempt" \
  --conf spark.executor.instances=2 --conf spark.executor.cores=2 \
  --conf spark.executor.memory=6g --conf spark.executor.memoryOverhead=2048 \
  --conf spark.driver.memory=2g --conf spark.driver.memoryOverhead=1024 \
  --conf spark.pyspark.python=/usr/bin/python3 \
  --conf spark.executorEnv.PYSPARK_PYTHON=/usr/bin/python3 \
  --conf spark.yarn.appMasterEnv.PYSPARK_PYTHON=/usr/bin/python3 \
  --conf spark.executorEnv.PYTHONPATH=./kernel-check.zip:./environment \
  --conf spark.yarn.appMasterEnv.PYTHONPATH=./kernel-check.zip:./environment \
  --conf spark.yarn.maxAppAttempts=1 --conf spark.speculation=false \
  /opt/planetory/run_check.py "$mode" --output "hdfs://planetory$base/$attempt" "$@"
result=$?
printf '%s\n' "$result" > "$attempt.exit"
exit "$result"

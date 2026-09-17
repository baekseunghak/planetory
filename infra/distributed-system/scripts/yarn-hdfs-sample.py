import socket
import sys
import time

from pyspark.sql import SparkSession


if len(sys.argv) != 3:
    raise SystemExit("usage: yarn-hdfs-sample.py <input> <output>")

spark = SparkSession.builder.appName("S15P21C206-73-hdfs-sample").getOrCreate()
deadline = time.monotonic() + 120
while spark.sparkContext._jsc.sc().getExecutorIds().size() < 5:
    if time.monotonic() >= deadline:
        raise RuntimeError("five executors did not register within 120 seconds")
    time.sleep(1)

print("REGISTERED_EXECUTORS=5")
line_count = spark.sparkContext.textFile(sys.argv[1]).count()


def probe(index, rows):
    list(rows)
    time.sleep(15)
    yield f"partition={index},host={socket.gethostname()},input_lines={line_count}"


spark.sparkContext.parallelize(range(10), 5).mapPartitionsWithIndex(probe).saveAsTextFile(sys.argv[2])
spark.stop()

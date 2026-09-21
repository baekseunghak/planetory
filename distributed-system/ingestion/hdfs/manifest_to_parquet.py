import sys

from pyspark.sql import SparkSession, functions as F, types as T


if len(sys.argv) != 6:
    raise SystemExit("usage: manifest_to_parquet.py <input-glob> <output> <count> <source-sha> <sector>")

input_glob, output, expected_count, source_sha, sector = sys.argv[1:]
schema = T.StructType([
    T.StructField("filename", T.StringType(), False),
    T.StructField("tic_id", T.LongType(), False),
    T.StructField("sector", T.IntegerType(), False),
    T.StructField("size_bytes", T.LongType(), False),
    T.StructField("sha256", T.StringType(), False),
    T.StructField("bundle_location", T.StringType(), False),
    T.StructField("sequence_key", T.StringType(), False),
    T.StructField("offset_start", T.LongType(), False),
    T.StructField("offset_end", T.LongType(), False),
    T.StructField("input_snapshot_id", T.StringType(), False),
    T.StructField("source_list_sha256", T.StringType(), False),
    T.StructField("worker_slot", T.IntegerType(), False),
])
spark = SparkSession.builder.appName("S15P21C206-76-manifest").getOrCreate()
frame = spark.read.schema(schema).json(input_glob)
count = frame.count()
if count != int(expected_count):
    raise RuntimeError(f"manifest count mismatch: {count} != {expected_count}")
missing = F.lit(False)
for field in schema.fields:
    missing = missing | F.col(field.name).isNull()
if frame.filter(missing).limit(1).count():
    raise RuntimeError("manifest contains a null required field")
if frame.filter(F.col("sector") != int(sector)).limit(1).count():
    raise RuntimeError("manifest sector mismatch")
if frame.filter(F.col("source_list_sha256") != source_sha).limit(1).count():
    raise RuntimeError("manifest source checksum mismatch")
if frame.select("filename").distinct().count() != count:
    raise RuntimeError("duplicate manifest filename")
frame.orderBy("filename").coalesce(1).write.mode("errorifexists").parquet(output)
print(f"MANIFEST_PARQUET_OK rows={count} output={output}")
spark.stop()

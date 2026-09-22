"""D19 bounded Bronze -> preprocessing/BLS parity harness, not Silver publication.

Local and YARN execute the same exported TIC snapshots. Outputs are immutable
attempts; retry skips successful TICs only when input and code identities match.
"""
import argparse
import hashlib
import inspect
import json
import platform
from pathlib import Path

import numpy as np

from astro_kernel import bls, preprocessing, transit_model


FIELDS = ("tic_id", "sector", "product_id", "raw_sha256", "input_snapshot_id",
          "time", "flux", "flux_err", "quality", "cadenceno")
VERSION = "planetory.kernel-check.v1"


def clean(value):
    if isinstance(value, np.ndarray):
        return clean(value.tolist())
    if isinstance(value, np.generic):
        return clean(value.item())
    if isinstance(value, float) and not np.isfinite(value):
        return "NaN" if np.isnan(value) else "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def dumps(value):
    return json.dumps(clean(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def code_identity():
    return digest([inspect.getsource(m) for m in (bls, preprocessing, transit_model)] +
                  [inspect.getsource(inspect.getmodule(evaluate))])


def snapshot(rows):
    rows = sorted(rows, key=lambda r: (r["sector"], r["product_id"]))
    if not rows or len({r["tic_id"] for r in rows}) != 1:
        raise ValueError("one nonempty TIC required")
    if len({r["sector"] for r in rows}) != len(rows):
        raise ValueError("multiple products for one TIC/Sector; select a release explicitly")
    return dict(schema=VERSION, tic_id=rows[0]["tic_id"], input_sha256=digest(rows), products=rows)


def validate_input(item):
    rebuilt = snapshot(item["products"])
    if item != rebuilt:
        raise ValueError("input snapshot identity mismatch")
    return item


def evaluate(item, fail_tic=None):
    import astropy
    validate_input(item)
    result = dict(schema=VERSION, tic_id=item["tic_id"], input_sha256=item["input_sha256"],
                  code_sha256=code_identity(), environment=dict(
                      python=platform.python_version(), numpy=np.__version__, astropy=astropy.__version__,
                      platform=platform.platform(), machine=platform.machine()),
                  sectors=[r["sector"] for r in item["products"]], status="failed")
    if item["tic_id"] == fail_tic:
        result.update(error_stage="test_injection", error_code="injected_failure")
        return result
    stage = "preprocessing"
    try:
        curves = [preprocessing.SectorInput(
            r["tic_id"], r["sector"], r["product_id"],
            *[np.asarray(r[k], dtype=np.int64 if k in ("quality", "cadenceno") else float)
              for k in ("time", "flux", "flux_err", "quality", "cadenceno")]) for r in item["products"]]
        prepared, detrended = preprocessing.preprocess_silver(curves)
        result["preprocessing_version"] = detrended.version
        result["prepared"] = dict(time=prepared.time, sector=prepared.sector,
                                  product_id=prepared.product_id, source_row=prepared.source_row,
                                  cadenceno=prepared.cadenceno, excluded=prepared.excluded)
        result["detrended"] = dict(flux=detrended.flux_det, trend=detrended.trend,
                                   kept=detrended.kept, segment_id=detrended.segment_id,
                                   failures=detrended.failures, status=detrended.status)
        if detrended.status != "ok":
            result.update(error_stage=stage, error_code=detrended.status)
            return clean(result)
        stage = "bls"
        found = bls.search_bls(prepared.time, detrended.flux_det, sector=prepared.sector,
                               baseline_time=prepared.time, input_snapshot_id=item["input_sha256"],
                               preprocessing_version=detrended.version)
        pg = found.pop("periodogram")
        result["bls"] = found
        result["periodogram"] = dict(periods=pg.periods, power=pg.power)
        if found["status"] == "failed":
            result.update(error_stage=stage, error_code="invalid_peak")
        else:
            result["status"] = "ok"  # no_quality_peak is a successful calculation
    except (preprocessing.PreprocessError, bls.BlsError) as exc:
        result.update(error_stage=stage, error_code=exc.code)
    return clean(result)


def indexed(items):
    out = {}
    for item in items:
        if item["tic_id"] in out:
            raise ValueError("duplicate TIC in attempt")
        out[item["tic_id"]] = item
    return out


def pending(inputs, previous):
    current, old = indexed(inputs), indexed(previous)
    if set(old) - set(current):
        raise ValueError("previous attempt includes unexpected TIC")
    code = code_identity()
    for tic, row in old.items():
        if row["input_sha256"] != current[tic]["input_sha256"] or row["code_sha256"] != code:
            raise ValueError("retry input/code changed; start a new baseline")
    return [row for tic, row in current.items() if tic not in old or old[tic]["status"] != "ok"]


def compare(a, b, path="", rtol=1e-12, atol=0):
    if isinstance(a, dict):
        if not isinstance(b, dict) or a.keys() != b.keys():
            raise ValueError(f"field mismatch: {path}")
        for key in a:
            compare(a[key], b[key], f"{path}/{key}", rtol, atol)
    elif isinstance(a, list):
        if not isinstance(b, list) or len(a) != len(b):
            raise ValueError(f"length mismatch: {path}")
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}/{i}", rtol, atol)
    elif isinstance(a, float) and isinstance(b, (int, float)):
        if not np.isclose(a, b, rtol=rtol, atol=atol):
            raise ValueError(f"numeric mismatch: {path}")
    elif type(a) is not type(b) or a != b:
        raise ValueError(f"value mismatch: {path}")


def read_local(path):
    with Path(path).open(encoding="utf-8-sig") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write_local(path, rows):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(dumps(row) + "\n")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode", choices=("export", "local", "worker", "compare"))
    p.add_argument("--input", required=True, help="export: one immutable Bronze sector path; otherwise snapshot JSONL")
    p.add_argument("--output", required=True, help="new attempt path, never overwritten")
    p.add_argument("--previous", help="one prior result JSONL, for retry or comparison")
    p.add_argument("--retry", help="retry delta JSONL to compose during comparison")
    p.add_argument("--count", type=int, default=20, help="export sample size, 20..50 TICs")
    p.add_argument("--fail-tic", type=int, help="validation only: intentionally fail one TIC to test retry")
    args = p.parse_args()
    if args.mode == "compare":
        if not args.previous:
            p.error("compare requires --previous")
        baseline = indexed(read_local(args.input))
        actual = indexed(read_local(args.previous))
        if args.retry:
            delta = indexed(read_local(args.retry))
            expected = {tic for tic, row in actual.items() if row["status"] != "ok"}
            expected |= set(baseline) - set(actual)
            if set(delta) != expected:
                raise ValueError("retry must contain exactly missing/failed TICs")
            actual.update(delta)
        if baseline.keys() != actual.keys():
            raise ValueError("TIC coverage mismatch")
        environments = {tic: dict(reference=baseline[tic]["environment"], worker=actual[tic]["environment"])
                        for tic in baseline}
        # OS/environment are evidence, not numerical outputs. Never relax the
        # preregistered numerical tolerance when environments differ.
        compare({tic: {k: v for k, v in row.items() if k != "environment"} for tic, row in baseline.items()},
                {tic: {k: v for k, v in row.items() if k != "environment"} for tic, row in actual.items()})
        failures = [tic for tic, row in actual.items() if row["status"] != "ok"]
        write_local(args.output, [dict(parity_passed=True, n_tics=len(actual),
                                      failed_tics=failures, all_successful=not failures,
                                      rtol=1e-12, atol=0, environments=environments)])
        print(f"Parity passed; {len(failures)} failed TICs (not silently treated as no signal)")
        return
    if args.mode == "local":
        inputs = [validate_input(row) for row in read_local(args.input)]
        work = pending(inputs, read_local(args.previous) if args.previous else [])
        write_local(args.output, (evaluate(row, args.fail_tic) for row in work))
        print(f"Completed {len(work)} TICs")
        return
    from pyspark.sql import SparkSession
    spark = SparkSession.builder.appName("planetory-127-kernel-check").getOrCreate()
    try:
        print(f"application_id={spark.sparkContext.applicationId}", flush=True)
        if args.mode == "export":
            if not 20 <= args.count <= 50:
                raise ValueError("bounded export requires 20..50 TICs")
            jpath = spark._jvm.org.apache.hadoop.fs.Path(args.input.rstrip("/") + "/_READY.json")
            if not jpath.getFileSystem(spark._jsc.hadoopConfiguration()).exists(jpath):
                raise ValueError("Bronze _READY.json missing")
            frame = spark.read.parquet(args.input)
            ids = [r.tic_id for r in frame.select("tic_id").distinct().orderBy("tic_id").limit(args.count).collect()]
            if len(ids) != args.count:
                raise ValueError("not enough distinct TICs")
            selected = frame.filter(frame.tic_id.isin(ids)).select(*FIELDS)
            rows = selected.rdd.map(lambda r: (r.tic_id, clean(r.asDict(recursive=True))))
            output = rows.groupByKey().map(lambda pair: dumps(snapshot(list(pair[1]))))
        else:
            # ponytail: bounded <=50 TIC validation only; not a full Silver batch runner.
            inputs = [validate_input(json.loads(line)) for line in spark.sparkContext.textFile(args.input).take(51)]
            if not 1 <= len(inputs) <= 50:
                raise ValueError("worker check requires 1..50 exported TICs")
            old = [json.loads(line) for line in spark.sparkContext.textFile(args.previous).take(51)] if args.previous else []
            work = pending(inputs, old)
            from tess_kernel_check import evaluate as worker_evaluate
            output = spark.sparkContext.parallelize(work, max(1, min(len(work), 20))).map(
                lambda row: dumps(worker_evaluate(row, args.fail_tic)))
        output.saveAsTextFile(args.output)
    finally:
        spark.stop()


if __name__ == "__main__":
    main()

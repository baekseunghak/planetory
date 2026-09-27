"""80 Gold 변환: Silver에 저장한 행으로 되살려 만든 결과가 메모리의 119 객체로 만든 결과와 같은지 본다.

합성 곡선 두 Sector로 실제 119 전처리·122 반복 탐색을 돌린 뒤, Silver의 직렬화 함수(`_target_row`, `_json`)로
저장 형태를 만들고 되살린다. ID·승인·외부 라벨은 합성값이며 운영 값이 아니다.
"""
import functools
import hashlib
import inspect
import json
import sys
import unittest
from contextlib import redirect_stderr
from copy import deepcopy
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_external_ctl  # noqa: E402
import tess_gold  # noqa: E402
from tess_gold import RUN_POLICY, GoldContractError, silver_state, star  # noqa: E402
from tess_silver import _json, _schemas, _target_row  # noqa: E402
from astro_kernel.candidate_aggregation import combine  # noqa: E402
from astro_kernel.external_catalog import build_snapshot  # noqa: E402
from astro_kernel.iteration import iterate_bls  # noqa: E402
from astro_kernel.preprocessing import SectorInput, preprocess_silver  # noqa: E402

TIC = 999999101
APPROVALS = dict(identity="fixture-identity", discoverability="fixture-rule", external="fixture-external")
PERIOD, EPOCH, DURATION_H, DEPTH = 3.3, 1355.0, 3.0, 0.005


def target_fields():
    fake = SimpleNamespace(StructType=lambda fields: list(fields), StructField=lambda name, *args: name,
                           **{t: lambda *args: object() for t in
                              ("ArrayType", "DoubleType", "LongType", "StringType", "BooleanType")})
    return _schemas(fake)[0]


def sector(number, start, rng):
    time = start + np.arange(0, 12.5, 2 / 1440)
    flux = 1000 * (1 + rng.normal(0, 0.0005, time.size))
    flux[np.abs((time - EPOCH + PERIOD / 2) % PERIOD - PERIOD / 2) < DURATION_H / 48] *= 1 - DEPTH
    name = f"tess-s{number:04d}-{TIC}-synthetic_lc.fits"
    return SectorInput(tic_id=TIC, sector=number, product_id=name, time=time, flux=flux,
                       flux_err=np.full(time.size, 0.5), quality=np.zeros(time.size, np.int64),
                       cadenceno=np.arange(time.size), source_sha256=hashlib.sha256(name.encode()).hexdigest())


def delivery(**overrides):
    args = dict(source="toi", scope=[str(TIC)], rows=[], raw_sha256="a" * 64,
                retrieved_at="2026-09-27T00:00:00Z", source_uri="https://example.org/toi", source_table="toi",
                time_evidence="fixture:explicit-TDB", complete=True, validated=True)
    return {"toi": build_snapshot(**dict(args, **overrides))}


@functools.cache
def silver_fixture():
    rng = np.random.default_rng(7)
    curves = [sector(3, 1354.0, rng), sector(4, 1367.5, rng)]
    checksums = {c.product_id: c.source_sha256 for c in curves}
    prepared, detrended = preprocess_silver(curves)
    snapshot = "bronze-products-sha256:" + "0" * 64
    iteration = iterate_bls(prepared.time, detrended.flux_det, sector=prepared.sector, baseline_time=prepared.time,
                            input_snapshot_id=snapshot, preprocessing_version=detrended.version)
    # What the job reads from Silver: the CURVE_COLUMNS of one target_combined row and the iteration result_json.
    stored = dict(zip(target_fields(), _target_row(prepared, detrended, snapshot)))
    row = {name: stored[name] for name in tess_gold.CURVE_COLUMNS}
    return checksums, prepared, detrended, row, json.loads(_json(iteration))


class SilverFixture:
    @classmethod
    def setUpClass(cls):
        cls.checksums, cls.prepared, cls.detrended, cls.row, cls.iteration = silver_fixture()

    def build(self, iteration=None, row="stored", **overrides):
        args = dict(product_checksums=self.checksums, deliveries=delivery(), required_sources=["toi"],
                    approvals=APPROVALS)
        args.update(overrides)
        return star(TIC, iteration or self.iteration, self.row if row == "stored" else row, **args)


class GoldFromSilverTest(SilverFixture, unittest.TestCase):
    def test_stored_silver_rebuilds_the_same_gold_as_memory(self):
        from_row = self.build()
        with patch.object(tess_gold, "rebuild", lambda row: (self.prepared, self.detrended)):
            from_memory = self.build()
        self.assertEqual(from_row["status"], "ready", from_row["reasons"])
        self.assertEqual(from_row, from_memory)

        bundle = from_row["payload"]["bundle"]
        self.assertEqual(bundle["id"], TIC)
        self.assertTrue(all(c["id"] // tess_gold.ID_SLOTS == TIC for c in from_row["payload"]["candidates"]))
        self.assertEqual({s["sector"] for s in from_row["payload"]["segments"]}, {3, 4})
        snapshots = bundle["manifest"]["input_snapshot_ids"]
        self.assertTrue(all(f"{p}:sha256:{c}" in snapshots for p, c in self.checksums.items()))

        # The run-level versions this stage passes are the ones 79 accepts.
        light = {k: v for k, v in from_row.items() if k != "payload"}
        run = combine(run_id="run-fixture", silver_attempt="silver/fixture", targets=[TIC], stars=[light],
                      **RUN_POLICY)
        self.assertEqual((run["status"], run["manifest"]["counts"]["ready"]), ("complete", 1))

    def test_only_curve_columns_leave_the_silver_scan(self):
        self.assertLessEqual(set(tess_gold.CURVE_COLUMNS), set(target_fields()))
        source = inspect.getsource(tess_gold.run)
        self.assertIn('.parquet(f"{silver}/target_combined").select(*CURVE_COLUMNS)', source)
        # The curve join's shuffle is the evaluate parallelism; a repartition would move the curves twice.
        self.assertNotIn(".repartition(", source)
        self.assertIn('"spark.sql.shuffle.partitions", str(args.shuffle_partitions)', source)

    def test_held_and_no_signal_stars_never_need_curves(self):
        incomplete = dict(self.iteration, status="incomplete", complete=False, termination="max_iterations_reached")
        self.assertEqual(self.build(incomplete, row=None)["status"], "held")
        silent = dict(self.iteration, accepted=[], n_accepted=0, termination="no_quality_peak")
        self.assertEqual(self.build(silent, row=None)["status"], "no_signal")

    def test_source_failure_keeps_the_run_open(self):
        failed = self.build(deliveries=delivery(complete=False))
        self.assertEqual(failed["status"], "request_failed")
        self.assertEqual(failed["reasons"], ["external:toi:source_held"])

    def test_one_broken_star_is_rejected_alone(self):
        missing = dict(list(self.checksums.items())[:1])
        broken = self.build(product_checksums=missing)
        self.assertEqual(broken["status"], "rejected")
        self.assertTrue(broken["reasons"][0].startswith("gold:SegmentationError:"))

    def test_run_contract_violations_stop_the_stage(self):
        with self.assertRaisesRegex(GoldContractError, "bls_config_version"):
            self.build(dict(self.iteration, bls_config_version="other-search"))
        with self.assertRaisesRegex(GoldContractError, "without Silver curve"):
            self.build(row=None)
        other = dict(deepcopy(self.row), input_snapshot_id="bronze-products-sha256:" + "1" * 64)
        with self.assertRaisesRegex(GoldContractError, "disagree"):
            self.build(row=other)


def toi_csv(*rows, preamble=""):
    """An NEA TOI export as the collector stores it; rows are (tid, toi, period, epoch BJD)."""
    header = ",".join(tess_external_ctl.TOI_COLUMNS) + "\n"
    body = "".join(f"{tic},{toi},PC,{period},{epoch},3.0,1000,2026-09-01\n" for tic, toi, period, epoch in rows)
    return (preamble + header + body).encode()


def collected(data, **overrides):
    """The collector's _READY record for data, built with the collector's own inspection."""
    info = tess_external_ctl.inspect_csv(data, tess_external_ctl.TOI_COLUMNS)
    return {"sha256": hashlib.sha256(data).hexdigest(), "requested_url": "https://example.org/toi",
            "retrieved_at": "2026-09-27T00:00:00Z", "preamble_lines": info["preamble_lines"],
            "row_count": info["row_count"], **overrides}


def toi_source(data, **overrides):
    return tess_gold.parse_source("nea_toi", data, collected(data, **overrides))


class ExternalSourceTest(unittest.TestCase):
    def test_collected_files_are_normalized_and_grouped_per_star(self):
        source = toi_source(toi_csv((1, "1.01", 2.0, 2458355.0), (2, "2.01", 3.0, 2458356.0), (1, "1.02", 4.0, "x"),
                                    preamble="# exported by a test\n"))
        self.assertEqual({k: (len(r), len(h)) for k, (r, h) in source["by_tic"].items()}, {"1": (1, 1), "2": (1, 0)})
        self.assertEqual(source["by_tic"]["1"][0][0]["epoch_btjd"], 1355.0)
        self.assertTrue(source["validated"])
        # A row whose TIC cannot be read would make absence look real, so the whole source is unvalidated.
        unread = toi_source(toi_csv(("", "9.01", 2.0, 2458355.0), (1, "1.01", 2.0, 2458355.0)))
        self.assertFalse(unread["validated"])
        self.assertEqual(tess_gold.deliveries(1, {"nea_toi": unread})["nea_toi"]["status"], "hold")

        data = toi_csv((1, "1.01", 2.0, 2458355.0))
        for record, payload in ((collected(data, sha256="0" * 64), data), (collected(data, row_count=2), data),
                                ({k: v for k, v in collected(data).items() if k != "requested_url"}, data),
                                (collected(data, sha256=hashlib.sha256(b"\xff" + data).hexdigest()), b"\xff" + data)):
            with self.assertRaises(GoldContractError):
                tess_gold.parse_source("nea_toi", payload, record)
        with self.assertRaisesRegex(GoldContractError, "unsupported"):
            tess_gold.parse_source("other_catalog", data, collected(data))

    def test_run_marker_must_cover_exactly_the_required_files(self):
        data = toi_csv((1, "1.01", 2.0, 2458355.0))
        marker = {"schema": tess_gold.EXTERNAL_READY_SCHEMA, "sources": {"nea_toi": collected(data)}}
        self.assertEqual(list(tess_gold.select_sources(marker, {"nea_toi.csv": data}, ["nea_toi"])), ["nea_toi"])
        for broken, files, required in ((dict(marker, schema="x"), {"nea_toi.csv": data}, ["nea_toi"]),
                                        (marker, {}, ["nea_toi"]),
                                        (marker, {"nea_toi.csv": data}, ["nea_toi", "exofop_toi"])):
            with self.assertRaises(GoldContractError):
                tess_gold.select_sources(broken, files, required)

    def test_star_snapshot_ignores_download_time_and_other_stars(self):
        def snapshot(data, tic=1, **overrides):
            return tess_gold.deliveries(tic, {"nea_toi": toi_source(data, **overrides)})["nea_toi"]

        base = snapshot(toi_csv((1, "1.01", 2.0, 2458355.0), (2, "2.01", 3.0, 2458356.0)))
        self.assertEqual(base["status"], "ready")
        again = snapshot(toi_csv((2, "2.01", 9.9, 2458356.0), (1, "1.01", 2.0, 2458355.0)),
                         retrieved_at="2026-10-01T00:00:00Z")
        self.assertEqual(again["snapshot"]["sha256"], base["snapshot"]["sha256"])
        changed = snapshot(toi_csv((1, "1.01", 2.5, 2458355.0)))
        self.assertNotEqual(changed["snapshot"]["sha256"], base["snapshot"]["sha256"])
        self.assertEqual(snapshot(toi_csv((2, "2.01", 3.0, 2458356.0)))["status"], "ready")  # absence, not failure


def products(checksums, procver="spoc-5.0.0"):
    """Bronze rows as the job collects them per star: product, checksum, Sector, PROCVER, TIMEDEL (days)."""
    return [dict(product_id=pid, raw_sha256=sha, sector=int(pid.split("-s")[1][:4]), procver=procver,
                 timedel=2 / 1440) for pid, sha in checksums.items()]


class SparkBoundaryTest(SilverFixture, unittest.TestCase):
    def spark_row(self, iteration, rows=None):
        return dict(self.row, result_json=json.dumps(iteration),
                    products=products(self.checksums) if rows is None else rows)

    def test_executor_returns_contract_errors_as_data(self):
        sources = {"nea_toi": toi_source(toi_csv((2, "2.01", 3.0, 2458356.0)))}
        good = tess_gold.evaluate_row(self.spark_row(self.iteration), sources, ["nea_toi"], APPROVALS)
        self.assertEqual(good["status"], "ready")
        expected = self.build(deliveries=tess_gold.deliveries(TIC, sources), required_sources=["nea_toi"])
        self.assertEqual({k: v for k, v in good.items() if k != "metadata"}, expected)
        self.assertEqual(good["metadata"]["observations"], {"3": {"cadence": "120s", "source_version": "spoc-5.0.0"},
                                                            "4": {"cadence": "120s", "source_version": "spoc-5.0.0"}})
        self.assertEqual(json.loads(tess_gold.bundle_line(good))["metadata"], good["metadata"])
        self.assertFalse({"payload", "metadata"} & set(tess_gold.light(good)))
        bad = tess_gold.evaluate_row(self.spark_row(dict(self.iteration, bls_config_version="x")),
                                     sources, ["nea_toi"], APPROVALS)
        self.assertEqual(set(bad), {"tic_id", "contract_error"})
        # One Sector cannot carry two PROCVERs: the observation row would be ambiguous.
        rows = products(self.checksums)
        clash = rows + [dict(rows[0], product_id="other", procver="spoc-9.9.9")]
        result = tess_gold.evaluate_row(self.spark_row(self.iteration, clash), sources, ["nea_toi"], APPROVALS)
        self.assertIn("contract_error", result)

    def test_arguments_reject_unsafe_runs(self):
        base = ["--silver-attempt", "s", "--bronze-path", "b", "--external", "e", "--required-source", "toi",
                "--approval-identity", "i", "--approval-discoverability", "d", "--approval-external", "x",
                "--run-id", "20260927T000000Z", "--attempt-id", "20260927T000001Z", "--output", "o"]
        self.assertEqual(tess_gold.parse_args(base).required_source, ["toi"])
        for extra in (["--approval-external", " "], ["--run-id", "run-1"], ["--required-source", "toi"],
                      [arg for tic in range(1, 7) for arg in ("--tic-id", str(tic))]):
            with self.assertRaises(SystemExit), redirect_stderr(StringIO()):
                tess_gold.parse_args(base + extra)


class SilverStateTest(unittest.TestCase):
    def stage(self, stage, status, retryable=False, error_code=None):
        return dict(tic_id=7, stage=stage, status=status, retryable=retryable, error_code=error_code)

    def test_only_unfinished_silver_stars_are_mapped(self):
        self.assertIsNone(silver_state([self.stage("initial_bls", "succeeded"), self.stage("iteration", "qa_stopped")]))
        self.assertIsNone(silver_state([self.stage("initial_bls", "no_quality_peak"),
                                        self.stage("iteration", "succeeded")]))
        rejected = silver_state([self.stage("initial_bls", "failed", error_code="invalid_bronze_row")])
        self.assertEqual((rejected["status"], rejected["reasons"]),
                         ("rejected", ["silver:initial_bls:invalid_bronze_row"]))
        retry = silver_state([self.stage("initial_bls", "failed", True, "unexpected_processing_error")])
        self.assertEqual(retry["status"], "unprocessed")
        capped = silver_state([self.stage("initial_bls", "succeeded"), self.stage("iteration", "incomplete")])
        self.assertEqual((capped["status"], capped["reasons"]), ("unprocessed", ["silver:iteration:incomplete"]))


if __name__ == "__main__":
    unittest.main()

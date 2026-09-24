import hashlib
import importlib.util
import inspect
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_silver  # noqa: E402
from tess_silver import (  # noqa: E402
    MASKED_PROVENANCE_STATUS,
    PROVENANCE_STATUS,
    SILVER_MANIFEST_SCHEMA_VERSION,
    _schemas,
    input_snapshot_id,
    process_tic,
    science_audit,
)
from tess_silver_ctl import (  # noqa: E402
    SILVER_READY_SCHEMA,
    SilverDataContractError,
    bronze_coverage,
    discard_failed_attempt,
    run_attempt,
    submit,
    validate_bronze_coverage,
)
from astro_kernel.preprocessing import (  # noqa: E402
    MASK_CONTRACT_VERSION, IntervalMask, PreprocessError, preprocess_silver,
)
from astro_kernel.bls import search_bls  # noqa: E402
from astro_kernel.iteration import ITERATION_VERSION, iterate_bls  # noqa: E402


def bronze_row(tic_id=123, sector=1, product_id="p1", suffix="a"):
    return {
        "tic_id": tic_id,
        "sector": sector,
        "product_id": product_id,
        "time": [1.0, 2.0],
        "flux": [10.0, 9.9],
        "flux_err": [0.1, 0.1],
        "quality": [0, 0],
        "cadenceno": [1, 2],
        "raw_sha256": suffix * 64,
        "input_snapshot_id": f"snapshot-{suffix}",
    }


def prepared():
    return SimpleNamespace(
        tic_id=123,
        time=np.array([1.0, 2.0]),
        flux=np.array([1.0, 0.99]),
        flux_err=np.array([0.01, np.nan]),
        sector=np.array([1, 1]),
        product_id=np.array(["p1", "p1"], dtype=object),
        source_row=np.array([0, 1]),
        cadenceno=np.array([1, 2]),
        original_quality=np.array([0, 0]),
        normalization_median={1: 10.0},
        excluded=[],
        n_raw=2,
        interval_masks=(),
    )


def detrended(status="ok"):
    return SimpleNamespace(
        version="silver-biweight-1.0.0",
        status=status,
        time=np.array([1.0, 2.0]),
        trend=np.array([1.0, 1.0]),
        flux_det=np.array([1.0, 0.99]),
        kept=np.array([True, True]),
        segment_id=np.array([0, 0]),
        reasons=np.array(["", ""], dtype=object),
        failures=[],
    )


def search_result(status="ok"):
    periodogram = SimpleNamespace(
        periods=np.array([0.5, 1.0]),
        power=np.array([1.0, 2.0]),
        epoch_btjd=np.array([1.0, 1.0]),
        duration_hours=np.array([1.2, 1.2]),
        depth=np.array([0.01, 0.02]),
        depth_err=np.array([0.001, 0.002]),
        snr=np.array([10.0, 10.0]),
        sde=np.array([7.0, 8.0]),
        valid_input=np.array([True, True]),
        config={"version": "test"},
    )
    return {
        "status": status,
        "peaks": [],
        "accepted_peaks": [],
        "periodogram": periodogram,
        "input_snapshot_id": "ignored-by-fixture",
        "preprocessing_version": "silver-biweight-1.0.0",
        "bls_config_version": "bls_grid_v1/poc_linear20k",
        "candidate_quality_version": "gate_v1/snr7_sde6",
        "n_input": 2,
        "n_valid": 2,
        "n_accepted": 0,
    }


def call(rows, preprocess, search, *, interval_masks=(), iteration_location=None, iterate=iterate_bls):
    return process_tic(
        rows,
        run_id="run",
        attempt_id="attempt",
        pipeline_version="pipeline",
        target_location="/final/target_combined",
        periodogram_location="/final/periodogram",
        iteration_location=iteration_location,
        interval_masks=interval_masks,
        preprocess=preprocess,
        search=search,
        iterate=iterate,
    )


class SilverDataOwnerContractTest(unittest.TestCase):
    def test_snapshot_is_stable_across_bronze_row_order(self):
        rows = [bronze_row(sector=2, product_id="p2", suffix="b"), bronze_row()]
        expected = hashlib.sha256(
            b"p1\tsnapshot-a\t" + b"a" * 64 + b"\n" +
            b"p2\tsnapshot-b\t" + b"b" * 64 + b"\n"
        ).hexdigest()
        self.assertEqual(input_snapshot_id(rows), f"bronze-products-sha256:{expected}")
        self.assertEqual(input_snapshot_id(rows), input_snapshot_id(reversed(rows)))

    def test_missing_lineage_is_a_per_tic_failure(self):
        row = bronze_row()
        row["raw_sha256"] = "bad"
        result = call([row], lambda curves, **kwargs: (prepared(), detrended()), lambda *args, **kwargs: None)
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[18], "invalid_lineage")
        self.assertIsNone(result.target)


class SilverScienceOwnerContractTest(unittest.TestCase):
    @staticmethod
    def real_bronze_row(count=600):
        row = bronze_row()
        row.update(
            time=np.linspace(0.0, 20.0, count).tolist(),
            flux=(1000.0 * (1.0 + 0.001 * np.sin(np.linspace(0.0, 20.0, count)))).tolist(),
            flux_err=np.full(count, 0.1).tolist(),
            quality=np.zeros(count, dtype=int).tolist(),
            cadenceno=np.arange(count).tolist(),
        )
        return row

    def test_real_preprocessing_adapter_combines_bronze_arrays(self):
        count = 600
        row = self.real_bronze_row(count)

        def search(*args, **kwargs):
            result = search_result("ok")
            result["input_snapshot_id"] = kwargs["input_snapshot_id"]
            result["n_input"] = count
            result["n_valid"] = count
            return result

        result = call([row], preprocess_silver, search)
        self.assertEqual(result.manifest[5], "succeeded")
        self.assertEqual(result.target[23:27], (count, count, count, 0))

    def test_interval_mask_contract_preserves_original_rows_and_evidence(self):
        row = self.real_bronze_row()
        row["quality"][15] = 128
        captured = {}
        mask = IntervalMask(
            interval_id="drn4-s1-test",
            product_id="p1",
            sector=1,
            product_sha256="a" * 64,
            coordinate="cadenceno",
            start=10,
            end=20,
            closed="both",
            reason="known_bad_interval",
            source_uri="fixture://drn4",
            source_sha256="b" * 64,
            version="fixture-v1",
        )

        def preprocess(curves, **kwargs):
            captured["source_sha256"] = curves[0].source_sha256
            return preprocess_silver(curves, **kwargs)

        def search(*args, **kwargs):
            result = search_result("ok")
            result["input_snapshot_id"] = kwargs["input_snapshot_id"]
            return result

        result = call([row], preprocess, search, interval_masks=[mask])
        self.assertEqual(captured["source_sha256"], "a" * 64)
        self.assertEqual(result.manifest[12:15], (MASKED_PROVENANCE_STATUS, MASK_CONTRACT_VERSION, 1))
        self.assertEqual(result.target[4], MASKED_PROVENANCE_STATUS)
        self.assertEqual(result.target[20], MASK_CONTRACT_VERSION)
        self.assertEqual(json.loads(result.target[21])[0]["interval_id"], "drn4-s1-test")
        ledger = json.loads(result.target[22])
        self.assertEqual(len(ledger), 11)
        overlap = next(row for row in ledger if row["source_row"] == 15)
        self.assertEqual(overlap["original_quality"], 128)
        self.assertEqual(overlap["interval_ids"], ["drn4-s1-test"])
        self.assertEqual(overlap["reasons"], ["quality_flag", "interval_mask", "known_bad_interval"])
        self.assertEqual(result.target[23], result.target[25] + result.target[26])

    def test_broken_row_conservation_fails_closed(self):
        def preprocess(curves, **kwargs):
            value = prepared()
            value.n_raw = 3
            return value, detrended()

        result = call([bronze_row()], preprocess, lambda *args, **kwargs: search_result("ok"))
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[18], "provenance_mismatch")
        self.assertIsNone(result.target)

    def test_mask_for_another_raw_product_is_isolated(self):
        mask = IntervalMask(
            interval_id="wrong-product",
            product_id="p1",
            sector=1,
            product_sha256="c" * 64,
            coordinate="cadenceno",
            start=10,
            end=20,
            closed="both",
            reason="known_bad_interval",
            source_uri="fixture://drn4",
            source_sha256="b" * 64,
            version="fixture-v1",
        )
        result = call(
            [self.real_bronze_row()],
            preprocess_silver,
            lambda *args, **kwargs: search_result("ok"),
            interval_masks=[mask],
        )
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[18], "mask_source_mismatch")
        self.assertIsNone(result.target)

    def test_nonfinite_cadence_times_serialize_as_strict_json(self):
        # Real SPOC curves carry NaN times in data gaps; the 2026-09-23 YARN Canary failed on this.
        # The defect is in target serialization before BLS, so a stub search keeps this Astropy-free.
        row = self.real_bronze_row(620)
        row["time"][5] = float("nan")
        row["time"][6] = float("inf")
        row["quality"][7] = 128

        def search(*args, **kwargs):
            result = search_result("ok")
            result["input_snapshot_id"] = kwargs["input_snapshot_id"]
            return result

        result = call([row], preprocess_silver, search)
        self.assertIn(result.manifest[5], {"succeeded", "no_quality_peak"}, result.manifest[18:20])
        excluded = json.loads(result.target[18])
        ledger = json.loads(result.target[22])
        by_row = {item["source_row"]: item for item in excluded}
        self.assertEqual((by_row[5]["original_time"], by_row[5]["original_time_nonfinite"]), (None, "NaN"))
        self.assertEqual(by_row[6]["original_time_nonfinite"], "+Infinity")
        self.assertEqual(by_row[7]["original_time"], row["time"][7])
        # Preparation exclusions use exactly the ledger's encoding.
        ledger_rows = {item["source_row"]: item for item in ledger}
        for source_row, item in by_row.items():
            self.assertEqual(item, ledger_rows[source_row])

    @unittest.skipUnless(importlib.util.find_spec("astropy"), "Astropy runtime is not installed")
    def test_real_preprocessing_to_bls_boundary_executes(self):
        result = call([self.real_bronze_row()], preprocess_silver, search_bls,
                      iteration_location="/final/iteration")
        self.assertIn(result.manifest[5], {"succeeded", "no_quality_peak"})
        self.assertIsNotNone(result.periodogram)
        self.assertIsNotNone(result.iteration)
        self.assertIn(result.iteration_manifest[5], {"succeeded", "incomplete", "failed"})
        self.assertEqual(result.iteration[1], result.periodogram[1])

    def test_ok_preprocessing_passes_aligned_provenance_to_bls(self):
        captured = {}

        def search(time, flux, **kwargs):
            captured.update(time=time, flux=flux, **kwargs)
            result = search_result("ok")
            result["input_snapshot_id"] = kwargs["input_snapshot_id"]
            return result

        result = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()), search)
        self.assertEqual(result.manifest[0], SILVER_MANIFEST_SCHEMA_VERSION)
        self.assertEqual(result.manifest[5], "succeeded")
        self.assertEqual(result.manifest[12], PROVENANCE_STATUS)
        self.assertEqual(result.manifest[13:15], (MASK_CONTRACT_VERSION, 0))
        np.testing.assert_array_equal(captured["sector"], prepared().sector)
        np.testing.assert_array_equal(captured["baseline_time"], prepared().time)
        self.assertIsNotNone(result.target)
        self.assertIsNotNone(result.periodogram)

    def test_non_ok_preprocessing_never_calls_bls(self):
        called = False

        def search(*args, **kwargs):
            nonlocal called
            called = True

        result = call(
            [bronze_row()],
            lambda curves, **kwargs: (prepared(), detrended("insufficient_observations")),
            search,
        )
        self.assertFalse(called)
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[18], "insufficient_observations")
        self.assertIsNotNone(result.target)
        self.assertIsNone(result.periodogram)

    def test_no_quality_peak_is_terminal_success_without_candidate(self):
        result = call(
            [bronze_row()],
            lambda curves, **kwargs: (prepared(), detrended()),
            lambda *args, **kwargs: search_result("no_quality_peak"),
        )
        self.assertEqual(result.manifest[5], "no_quality_peak")
        self.assertFalse(result.manifest[6])
        self.assertIsNone(result.manifest[18])

    def test_canary_audit_is_bounded_and_keeps_science_metrics(self):
        result = call(
            [bronze_row()],
            lambda curves, **kwargs: (prepared(), detrended()),
            lambda *args, **kwargs: search_result("ok"),
        )
        audit = science_audit(result)
        self.assertEqual(audit["tic_id"], 123)
        self.assertEqual(audit["sectors"], [1])
        self.assertEqual(audit["provenance_status"], PROVENANCE_STATUS)
        self.assertEqual(audit["interval_mask_count"], 0)
        self.assertEqual(audit["accepted_peak_count"], 0)
        self.assertEqual(audit["accepted_peaks"], [])


class SilverSparkOperatorContractTest(unittest.TestCase):
    def test_serialized_rows_match_declared_parquet_schemas(self):
        fake = SimpleNamespace(
            StructType=lambda fields: list(fields),
            StructField=lambda name, *args: name,
            ArrayType=lambda *args: object(),
            DoubleType=lambda: object(),
            LongType=lambda: object(),
            StringType=lambda: object(),
            BooleanType=lambda: object(),
        )
        target_schema, periodogram_schema, manifest_schema, _, iteration_schema = _schemas(fake)
        result = call(
            [bronze_row()],
            lambda curves, **kwargs: (prepared(), detrended()),
            lambda *args, **kwargs: search_result("ok"),
        )
        self.assertEqual(len(result.target), len(target_schema))
        self.assertEqual(len(result.periodogram), len(periodogram_schema))
        self.assertEqual(len(result.manifest), len(manifest_schema))

        seen = {}
        def iterate(time, flux, **kwargs):
            seen.update(kwargs)
            return dict(status="ok", termination="no_quality_peak", complete=True, n_accepted=0,
                        accepted=[], input_snapshot_id=kwargs["input_snapshot_id"],
                        preprocessing_version=kwargs["preprocessing_version"],
                        iteration_version=ITERATION_VERSION, iteration_config_sha256="f" * 64,
                        bls_config_version=kwargs["initial_search"]["bls_config_version"],
                        candidate_quality_version=kwargs["initial_search"]["candidate_quality_version"])
        connected = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()),
                         lambda *args, **kwargs: search_result("ok"),
                         iteration_location="/final/iteration", iterate=iterate)
        self.assertIsNotNone(seen["initial_search"])
        self.assertEqual(connected.iteration_manifest[4:6], ("iteration", "succeeded"))
        self.assertEqual(connected.iteration_manifest[17], "/final/iteration")
        self.assertEqual(len(connected.iteration), len(iteration_schema))
        self.assertTrue(json.loads(connected.iteration[-1])["complete"])

    def test_iteration_failure_keeps_initial_search_and_is_retryable_per_stage(self):
        result = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()),
                      lambda *args, **kwargs: search_result("ok"),
                      iteration_location="/final/iteration",
                      iterate=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("worker problem")))
        self.assertEqual(result.manifest[5], "succeeded")
        self.assertIsNotNone(result.periodogram)
        self.assertIsNone(result.iteration)
        self.assertEqual(result.iteration_manifest[4:7], ("iteration", "failed", True))
        self.assertIsNone(result.iteration_manifest[17])
        self.assertEqual(result.iteration_manifest[18], "unexpected_iteration_error")

    def test_incomplete_iteration_is_not_success_or_gold_candidate(self):
        def incomplete(time, flux, **kwargs):
            return dict(status="incomplete", termination="max_iterations_reached", complete=False,
                        n_accepted=0, accepted=[], input_snapshot_id=kwargs["input_snapshot_id"],
                        preprocessing_version=kwargs["preprocessing_version"],
                        iteration_version=ITERATION_VERSION, iteration_config_sha256="f" * 64,
                        bls_config_version=kwargs["initial_search"]["bls_config_version"],
                        candidate_quality_version=kwargs["initial_search"]["candidate_quality_version"])
        result = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()),
                      lambda *args, **kwargs: search_result("ok"),
                      iteration_location="/final/iteration", iterate=incomplete)
        self.assertEqual(result.iteration_manifest[5:7], ("incomplete", False))
        self.assertEqual(result.iteration_manifest[18], "max_iterations_reached")
        self.assertFalse(result.iteration[4])

    def test_iteration_qa_verdict_is_a_science_stop_not_a_processing_failure(self):
        def stopped_by(termination):
            def iterate(time, flux, **kwargs):
                return dict(status="failed", termination=termination, complete=False,
                            n_accepted=1, accepted=[{"step": 0}], input_snapshot_id=kwargs["input_snapshot_id"],
                            preprocessing_version=kwargs["preprocessing_version"],
                            iteration_version=ITERATION_VERSION, iteration_config_sha256="f" * 64,
                            bls_config_version=kwargs["initial_search"]["bls_config_version"],
                            candidate_quality_version=kwargs["initial_search"]["candidate_quality_version"])
            return iterate

        for termination in ("removal_qa_failed", "candidate_validation_failed"):
            with self.subTest(termination=termination):
                result = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()),
                              lambda *args, **kwargs: search_result("ok"),
                              iteration_location="/final/iteration", iterate=stopped_by(termination))
                # Accepted candidates before the stop are kept, and it must not count as failed or retry.
                self.assertEqual(result.iteration_manifest[5:7], ("qa_stopped", False))
                self.assertEqual(result.iteration_manifest[17], "/final/iteration")
                self.assertEqual(result.iteration_manifest[18], termination)
                self.assertEqual(result.iteration[5], 1)
        # A numerical failure can hide a code defect, so it stays a processing failure.
        numerical = call([bronze_row()], lambda curves, **kwargs: (prepared(), detrended()),
                         lambda *args, **kwargs: search_result("ok"),
                         iteration_location="/final/iteration", iterate=stopped_by("numerical_failure"))
        self.assertEqual(numerical.iteration_manifest[5], "failed")

    def test_unexpected_failure_is_retryable_and_does_not_escape_tic(self):
        failed = call(
            [bronze_row()],
            lambda curves, **kwargs: (_ for _ in ()).throw(RuntimeError("worker bug")),
            lambda *args, **kwargs: None,
        )
        succeeded = call(
            [bronze_row(tic_id=456)],
            lambda curves, **kwargs: (prepared(), detrended()),
            lambda *args, **kwargs: search_result("ok"),
        )
        self.assertEqual(failed.manifest[5:7], ("failed", True))
        self.assertEqual(failed.manifest[18], "unexpected_processing_error")
        self.assertEqual(succeeded.manifest[5], "succeeded")

    def test_code_defect_after_reading_bronze_is_not_reported_as_bad_input(self):
        # The 2026-09-23 Canary NaN serialization defect surfaced as invalid_bronze_row.
        def broken(curves, **kwargs):
            raise ValueError("Out of range float values are not JSON compliant: nan")

        result = call([bronze_row()], broken, lambda *args, **kwargs: None)
        self.assertEqual(result.manifest[5:7], ("failed", True))
        self.assertEqual(result.manifest[18], "unexpected_processing_error")
        self.assertIn("ValueError: Out of range float", result.manifest[19])

        def data_error(curves, **kwargs):
            raise PreprocessError("duplicate_time", "p1")

        known = call([bronze_row()], data_error, lambda *args, **kwargs: None)
        self.assertEqual(known.manifest[5:7], ("failed", False))
        self.assertEqual(known.manifest[18], "duplicate_time")

    def test_failed_attempt_staging_is_discarded_only_after_the_app_ended(self):
        output = "/lake/silver/.staging/run=20260924T000000Z/attempt=20260924T000100Z"
        for state, expected in (("RUNNING", False), ("UNKNOWN", False), ("FAILED", True), ("KILLED", True)):
            with self.subTest(state=state), \
                    patch("tess_silver_ctl.application_state", return_value=state), \
                    patch("tess_silver_ctl.hdfs_exists", return_value=True), \
                    patch("tess_silver_ctl.hdfs") as hdfs, \
                    patch("tess_silver_ctl.cleanup_spark_staging") as cleanup:
                self.assertEqual(discard_failed_attempt("20260924T000000Z", "20260924T000100Z",
                                                        output, "application_1_2"), expected)
                self.assertEqual(hdfs.called, expected)
                self.assertEqual(cleanup.called, expected)
        with self.assertRaisesRegex(RuntimeError, "unexpected path"):
            discard_failed_attempt("20260924T000000Z", "20260924T000100Z", "/lake/silver", None)

    def test_restartable_failure_discards_staging_but_contract_failure_keeps_it(self):
        args = SimpleNamespace(release_dir=".", run_id="20260924T000000Z", state_root="/tmp/state",
                               pipeline_version="v", output_partitions=1, shuffle_partitions=1)
        coverage = {"coverage_sha256": "a" * 64, "ready_sha256": "b" * 64, "pipeline_version": "p",
                    "bronze_paths": []}
        for error, discards in ((RuntimeError("YARN application ended as FAILED"), True),
                                (SilverDataContractError("bad input"), False)):
            written = []
            with self.subTest(error=type(error).__name__), \
                    patch("tess_silver_ctl.build_runtime", return_value="/runtime"), \
                    patch("tess_silver_ctl.prepare_paths"), \
                    patch("tess_silver_ctl.write_state", side_effect=lambda path, state: written.append(dict(state))), \
                    patch("tess_silver_ctl.submit", side_effect=error), \
                    patch("tess_silver_ctl.discard_failed_attempt", return_value=True) as discard:
                with self.assertRaises(type(error)):
                    run_attempt(args=args, coverage=coverage)
                self.assertEqual(discard.called, discards)
                self.assertEqual(written[-1]["status"], "failed" if discards else "terminal_failed")

    def test_submit_requests_four_cores_per_executor_with_single_threaded_numerics(self):
        captured = []

        def popen(command, **kwargs):
            captured.extend(command)
            raise RuntimeError("stop after capturing the command")

        coverage = {"coverage_sha256": "a" * 64, "ready_sha256": "b" * 64, "pipeline_version": "p",
                    "bronze_paths": ["/lake/bronze/tess/sector=0001"]}
        with patch("tess_silver_ctl.subprocess.Popen", side_effect=popen), \
                self.assertRaisesRegex(RuntimeError, "stop after"):
            submit(release_dir=Path("/opt/planetory-silver/releases/20260924T000000Z"),
                   runtime_hdfs="/runtime.tar.gz", coverage=coverage, run_id="20260924T000000Z",
                   attempt_id="20260924T000100Z", pipeline_version="v", output="/o", final_output="/f",
                   output_partitions=80, shuffle_partitions=500, state_file=Path("state.json"), state={})
        for conf in ("spark.executor.instances=5", "spark.executor.cores=4", "spark.executor.memory=6g",
                     "spark.executor.memoryOverhead=4096", "spark.executorEnv.OMP_NUM_THREADS=1"):
            with self.subTest(conf=conf):
                self.assertIn(conf, captured)

    def test_tic_results_are_computed_before_any_coalesced_write(self):
        # A lazy persist would run all BLS work inside the coalesced write tasks.
        source = inspect.getsource(tess_silver.run)
        self.assertIn("results.count()", source)
        self.assertLess(source.index("results.count()"), source.index(".coalesce("))

    def test_malformed_bronze_row_is_isolated_before_sorting(self):
        row = bronze_row()
        del row["sector"]
        result = call([row], lambda curves, **kwargs: (prepared(), detrended()), lambda *args, **kwargs: None)
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[18], "invalid_bronze_row")

    def test_manifest_tic_survives_malformed_product_sort_key(self):
        row = bronze_row(tic_id=456)
        row["sector"] = None
        result = call([row], lambda curves, **kwargs: (prepared(), detrended()), lambda *args, **kwargs: None)
        self.assertEqual(result.manifest[3], 456)
        self.assertEqual(result.manifest[5], "failed")

    def test_coverage_requires_all_verified_bronze_sector_markers(self):
        rows = []
        markers = {}
        for sector in range(1, 14):
            location = f"/lake/bronze/tess/sector={sector:04d}"
            ready_sha256 = f"{sector:064x}"
            rows.append({
                "sector": sector,
                "location": location,
                "ready_sha256": ready_sha256,
                "product_count": 10,
                "observation_count": 100,
            })
            markers[sector] = ({
                "schema": "planetory.tess-bronze-sector.v1",
                "data_schema": "planetory.tess-bronze.v1",
                "sector": sector,
                "pipeline_version": "bronze-v1",
                "product_count": 10,
                "observation_count": 100,
                "replication": 2,
            }, ready_sha256)
        coverage = {
            "schema": "planetory.tess-bronze-coverage.v1",
            "pipeline_version": "bronze-v1",
            "product_count": 130,
            "observation_count": 1300,
            "replication": 2,
            "sectors": rows,
        }
        validate_bronze_coverage(coverage, markers)
        markers[3][0]["pipeline_version"] = "other"
        with self.assertRaisesRegex(SilverDataContractError, "sector=3"):
            validate_bronze_coverage(coverage, markers)

    def test_attempt_ready_schema_is_versioned(self):
        self.assertEqual(SILVER_READY_SCHEMA, "planetory.tess-silver-attempt.v4")

    def test_coverage_path_cannot_escape_the_bronze_snapshot_root(self):
        for path in ("/tmp/coverage=" + "a" * 64,
                     "/lake/bronze/tess/sector=0014",
                     "/lake/bronze/tess/coverage=" + "a" * 64 + "/../other"):
            with self.subTest(path=path), self.assertRaises(SilverDataContractError):
                bronze_coverage(path)

    def test_canary_filters_tic_before_row_scans(self):
        source = (Path(__file__).resolve().parent / "tess_silver.py").read_text(encoding="utf-8")
        self.assertLess(source.index('if args.tic_id:\n                bronze = bronze.filter'),
                        source.index('bronze.filter(functions.col("schema_version")'))
        self.assertIn('if not args.tic_id and not args.retry_manifest:', source)


if __name__ == "__main__":
    unittest.main()

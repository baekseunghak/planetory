import contextlib
import hashlib
import io
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
import tess_silver_ctl  # noqa: E402
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

    def test_real_iteration_kernel_keeps_validation_exceptions_out_of_qa_stopped(self):
        # The real kernel decides the termination; only its BLS/QA/SNR leaves are stubbed.
        import astro_kernel.iteration as kernel
        n = 1000
        time = np.linspace(1.0, 21.0, n)
        long_prepared = SimpleNamespace(**{**vars(prepared()), "time": time, "flux": np.ones(n),
            "flux_err": np.full(n, 0.01), "sector": np.ones(n, int), "product_id": np.array(["p1"] * n, dtype=object),
            "source_row": np.arange(n), "cadenceno": np.arange(1, n + 1), "original_quality": np.zeros(n, int),
            "n_raw": n})
        long_detrended = SimpleNamespace(**{**vars(detrended()), "time": time, "trend": np.ones(n),
            "flux_det": 1 + np.random.default_rng(42).normal(0, 0.001, n), "kept": np.ones(n, bool),
            "segment_id": np.zeros(n, int), "reasons": np.array([""] * n, dtype=object)})
        peak = dict(rank=1, period_days=2.0, epoch_btjd=1.5, duration_hours=2.0, depth=0.01, depth_err=0.0001,
                    power=100.0, sde=10.0, snr=20.0, n_transits=10, n_in_transit=30, sector_stats=[],
                    sector_consistency_status="unavailable", mask_dropped_fraction=None, diagnostic_reasons=[])
        config = dict(period_min_days=0.5, period_max_days=6.0, n_periods=20000, durations_hours=[1.2, 1.92, 2.88, 4.8])

        def run_with(original_snr):
            searches = iter([[peak], []])
            with patch.object(kernel, "search_bls", lambda *args, **kwargs: dict(
                    status="ok", peaks=next(searches), periodogram=SimpleNamespace(config=config))), \
                    patch.object(kernel, "refine_peak", lambda t, f, p, *args: p), \
                    patch.object(kernel, "_qa", lambda *args: dict(qa_failures="")), \
                    patch.object(kernel, "fixed_snr", original_snr):
                return call([bronze_row()], lambda curves, **kwargs: (long_prepared, long_detrended),
                            lambda *args, **kwargs: search_result("ok"), iteration_location="/final/iteration",
                            iterate=lambda *args, **kwargs: iterate_bls(*args, **{**kwargs, "initial_search": None}))

        weak = run_with(lambda *args: 0.0)
        self.assertEqual(weak.iteration_manifest[5:7], ("qa_stopped", False))
        self.assertEqual(weak.iteration_manifest[18], "candidate_validation_failed")

        def broken(*args):
            raise RuntimeError("original validation defect")
        crashed = run_with(broken)
        self.assertEqual(crashed.iteration_manifest[5], "failed")
        self.assertEqual(crashed.iteration_manifest[18], "numerical_failure")
        last = json.loads(crashed.iteration[-1])["steps"][-1]
        self.assertEqual((last["phase"], last["error_type"]), ("original_validation", "RuntimeError"))

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
        args = SimpleNamespace(command="run", release_dir=".", run_id="20260924T000000Z", state_root="/tmp/state",
                               pipeline_version="v", output_partitions=1, shuffle_partitions=1)
        snapshot = {"sha256": "a" * 64, "schema": "s", "sectors": [], "coverage": None}
        for error, discards in ((RuntimeError("YARN application ended as FAILED"), True),
                                (SilverDataContractError("bad input"), False)):
            written = []
            with self.subTest(error=type(error).__name__), \
                    patch("tess_silver_ctl.silver_capacity_budget", return_value=10**12), \
                    patch("tess_silver_ctl.build_runtime", return_value="/runtime"), \
                    patch("tess_silver_ctl.prepare_paths"), \
                    patch("tess_silver_ctl.write_state", side_effect=lambda path, state: written.append(dict(state))), \
                    patch("tess_silver_ctl.submit", side_effect=error), \
                    patch("tess_silver_ctl.discard_failed_attempt", return_value=True) as discard:
                with self.assertRaises(type(error)):
                    run_attempt(args=args, snapshot=snapshot)
                self.assertEqual(discard.called, discards)
                self.assertEqual(written[-1]["status"], "failed" if discards else "terminal_failed")
                self.assertEqual(written[-1]["unit"], "planetory-tess-silver-20260924T000000Z.service")

    def test_submit_spreads_executors_evenly_within_the_yarn_caps(self):
        captured = []

        def popen(command, **kwargs):
            captured.extend(command)
            raise RuntimeError("stop after capturing the command")

        snapshot = {"sha256": "a" * 64, "sectors": [
            {"sector": 1, "location": "/lake/bronze/tess/sector=0001", "pipeline_version": "p"}]}
        with patch("tess_silver_ctl.subprocess.Popen", side_effect=popen), \
                patch("tess_bronze_ctl.hdfs_exists", return_value=True), \
                self.assertRaisesRegex(RuntimeError, "stop after"):
            submit(release_dir=Path("/opt/planetory-silver/releases/20260924T000000Z"),
                   runtime_hdfs="/runtime.tar.gz", snapshot=snapshot, run_id="20260924T000000Z",
                   attempt_id="20260924T000100Z", pipeline_version="v", output="/o", final_output="/f",
                   output_partitions=80, shuffle_partitions=500, state_file=Path("state.json"), state={},
                   capacity_budget_bytes=1)
        for conf in ("spark.executorEnv.OMP_NUM_THREADS=1",
                     "spark.eventLog.enabled=true", "spark.eventLog.dir=hdfs://planetory/spark-history"):
            with self.subTest(conf=conf):
                self.assertIn(conf, captured)
        conf = dict(c.split("=", 1) for c in captured if c.startswith("spark.") and "=" in c)
        # YARN rejects any container above yarn.scheduler.maximum-allocation-vcores=3 (2026-09-24 Canary).
        self.assertLessEqual(int(conf["spark.executor.cores"]), 3)
        # Memory-only placement: the container size decides how many executors share a worker.
        container_mb = int(conf["spark.executor.memory"].removesuffix("g")) * 1024 + int(
            conf["spark.executor.memoryOverhead"])
        driver_mb = int(conf["spark.driver.memory"].removesuffix("g")) * 1024 + int(
            conf["spark.driver.memoryOverhead"])
        per_worker = [24576 // container_mb] * 4 + [16384 // container_mb]
        self.assertEqual(per_worker, [3, 3, 3, 3, 2])
        self.assertEqual(int(conf["spark.dynamicAllocation.maxExecutors"]), sum(per_worker))
        self.assertEqual(conf["spark.dynamicAllocation.initialExecutors"], conf["spark.dynamicAllocation.maxExecutors"])
        self.assertLessEqual(driver_mb, 24576 - 3 * container_mb)
        # A fixed instance count would override the dynamic initial size; no shuffle service is installed.
        self.assertNotIn("spark.executor.instances", conf)
        self.assertEqual(conf["spark.dynamicAllocation.enabled"], "true")
        self.assertEqual(conf["spark.dynamicAllocation.shuffleTracking.enabled"], "true")
        self.assertNotIn("spark.dynamicAllocation.cachedExecutorIdleTimeout", conf)

    def test_only_the_columns_process_tic_reads_leave_the_jvm(self):
        full = [dict(bronze_row(sector=2, product_id="p2", suffix="b"), procver="v", bundle_location="/x"),
                dict(bronze_row(), procver="v", bundle_location="/x")]
        slim = [{key: row[key] for key in tess_silver.SILVER_INPUT_COLUMNS} for row in full]
        preprocess = lambda curves, **kwargs: (prepared(), detrended())  # noqa: E731
        self.assertEqual(repr(call(full, preprocess, lambda *a, **k: search_result())),
                         repr(call(slim, preprocess, lambda *a, **k: search_result())))
        source = inspect.getsource(tess_silver.run)
        self.assertIn("inputs.select(*SILVER_INPUT_COLUMNS).rdd", source)

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
        self.assertEqual(SILVER_READY_SCHEMA, "planetory.tess-silver-attempt.v5")

    def test_coverage_path_cannot_escape_the_bronze_snapshot_root(self):
        for path in ("/tmp/coverage=" + "a" * 64,
                     "/lake/bronze/tess/sector=0014",
                     "/lake/bronze/tess/coverage=" + "a" * 64 + "/../other"):
            with self.subTest(path=path), self.assertRaises(SilverDataContractError):
                bronze_coverage(path)

    def test_canary_filters_tic_before_row_scans(self):
        source = inspect.getsource(tess_silver.run)
        # The TIC filter shrinks the cached key rows before the checks, and again the array rows before BLS.
        self.assertLess(source.index('base = base.filter(functions.col("tic_id").isin(args.tic_id))'),
                        source.index("base.persist("))
        self.assertIn('inputs = inputs.filter(functions.col("tic_id").isin(args.tic_id))', source)
        self.assertIn('if not args.tic_id and not args.retry_manifest and not args.delta_from_sector:', source)


class SilverIncrementalContractTest(unittest.TestCase):
    """275: cumulative Sector snapshot, changed-TIC selection and the HDFS capacity guard."""

    DF = "Filesystem Size Used Available Use%\nhdfs://planetory 10026228858880 6460597239808 3565547732992 64%\n"

    @staticmethod
    def marker(sector, version):
        return {"schema": "planetory.tess-bronze-sector.v1", "data_schema": "planetory.tess-bronze.v1",
                "sector": sector, "pipeline_version": version, "product_count": 10,
                "observation_count": 100, "replication": 2}

    def sector_snapshot(self, versions, finished=None):
        finished = set(versions) if finished is None else finished
        listing = "\n".join(f"-rw-r--r-- 2 hdfs hdfs 0 2026-09-22 00:00 /lake/bronze/tess/sector={s:04d}/_SUCCESS"
                            for s in sorted(finished))
        markers = {f"/lake/bronze/tess/sector={s:04d}/_READY.json": (self.marker(s, v), f"{s:064x}")
                   for s, v in versions.items()}
        with patch("tess_silver_ctl.hdfs", return_value=SimpleNamespace(stdout=listing)), \
                patch("tess_silver_ctl.hdfs_json", side_effect=lambda path: markers[path]), \
                contextlib.redirect_stdout(io.StringIO()):
            return tess_silver_ctl.bronze_sector_snapshot(max(versions))

    def test_sector_snapshot_pins_each_sector_version_and_shares_the_coverage_id(self):
        snapshot = self.sector_snapshot({1: "bronze-a", 2: "bronze-a", 3: "bronze-b"})
        self.assertEqual([row["pipeline_version"] for row in snapshot["sectors"]], ["bronze-a", "bronze-a", "bronze-b"])
        self.assertEqual(snapshot["sectors"][2]["ready_sha256"], f"{3:064x}")
        self.assertIsNone(snapshot["coverage"])
        # The ID depends on the Sector rows only, so a coverage-derived snapshot of the same rows matches.
        same = tess_silver_ctl.snapshot_from_rows(list(reversed(snapshot["sectors"])), coverage="/lake/x")
        self.assertEqual(same["sha256"], snapshot["sha256"])
        changed = [dict(row) for row in snapshot["sectors"]]
        changed[2]["ready_sha256"] = "f" * 64
        self.assertNotEqual(tess_silver_ctl.snapshot_from_rows(changed, coverage=None)["sha256"], snapshot["sha256"])

    def test_sector_snapshot_refuses_unfinished_or_mismatched_markers(self):
        with self.assertRaisesRegex(SilverDataContractError, "incomplete sector=2"):
            self.sector_snapshot({1: "v", 2: "v"}, finished={1})
        for key, value in (("sector", 9), ("replication", 1), ("product_count", 0), ("pipeline_version", "a b"),
                           ("schema", "other")):
            marker = self.marker(1, "v")
            marker[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(SilverDataContractError, "sector=1"):
                tess_silver_ctl.validate_sector_marker(1, marker)

    def test_capacity_budget_stops_at_the_planned_usage_line(self):
        # 2026-09-27 inspection: 64.44% used leaves about 1,560 GB (RF2) below the 80% line.
        budget = tess_silver_ctl.capacity_budget(self.DF)
        self.assertEqual(budget, int(10026228858880 * 0.80) - 6460597239808)
        self.assertAlmostEqual(budget / 1e9, 1560.4, places=0)
        self.assertEqual((tess_silver_ctl.SILVER_CAPACITY_LIMIT, tess_silver_ctl.PREFLIGHT_STOP_PERCENT), (0.80, 85))
        full = "Filesystem Size Used Available Use%\nhdfs://planetory 1000 800 200 80%\n"
        with patch("tess_silver_ctl.hdfs", return_value=SimpleNamespace(stdout=full)), \
                self.assertRaisesRegex(SilverDataContractError, "no Silver capacity"):
            tess_silver_ctl.silver_capacity_budget()

    def test_estimate_reproduces_the_measured_sector_1_to_13_attempt(self):
        # attempt=20260924T133730Z: 247,824 products, 128,258 TICs, 683,026,561,628 bytes RF2.
        estimate = tess_silver.estimate_output_bytes(247824, 128258)
        self.assertLess(abs(estimate - 683026561628) / 683026561628, 0.001)

    def test_silver_preflight_refuses_a_second_silver_application(self):
        listing = ("Total number of applications:1\n                Application-Id\tApplication-Name\n"
                   "application_1_0001\tS15P21C206-78-silver-20260927T000000Z-20260927T000100Z\tSPARK\n")
        args = SimpleNamespace(through_sector=14, bronze_coverage=tess_silver_ctl.DEFAULT_BRONZE_COVERAGE)
        with patch("tess_silver_ctl.yarn", return_value=SimpleNamespace(stdout=listing)), \
                patch("tess_silver_ctl.cluster_preflight") as shared, \
                self.assertRaisesRegex(RuntimeError, "another Silver application"):
            tess_silver_ctl.silver_preflight(args)
        shared.assert_not_called()
        idle = listing.replace("application_1_0001\tS15P21C206-78-silver", "application_1_0002\tS15P21C206-77-bronze")
        with patch("tess_silver_ctl.yarn", return_value=SimpleNamespace(stdout=idle)), \
                patch("tess_silver_ctl.cluster_preflight", return_value={"sha256": "a"}) as shared:
            tess_silver_ctl.silver_preflight(args)
        shared.assert_called_once_with(args.bronze_coverage, through_sector=14)

    def test_gold_keeps_its_coverage_preflight_and_silver_input_fields(self):
        # 80 Gold calls cluster_preflight(<coverage path>) and re-audits its v4 Silver input against
        # coverage_sha256/ready_sha256; 275 must not change either for the coverage path.
        self.assertEqual(list(inspect.signature(tess_silver_ctl.cluster_preflight).parameters)[0], "bronze_coverage_path")
        self.assertEqual(tess_silver_ctl.SILVER_INPUT_SCHEMAS,
                         ("planetory.tess-silver-attempt.v4", "planetory.tess-silver-attempt.v5"))
        coverage_sha = "c" * 64
        path = f"/lake/bronze/tess/coverage={coverage_sha}"
        rows = [{"sector": s, "location": f"/lake/bronze/tess/sector={s:04d}", "ready_sha256": f"{s:064x}",
                 "product_count": 10, "observation_count": 100} for s in range(1, 14)]
        value = {"schema": "planetory.tess-bronze-coverage.v1", "pipeline_version": "bronze-a", "product_count": 130,
                 "observation_count": 1300, "replication": 2, "sectors": rows}
        markers = {f"{row['location']}/_READY.json": (self.marker(row["sector"], "bronze-a"), row["ready_sha256"])
                   for row in rows}
        markers[f"{path}/_READY.json"] = (value, "d" * 64)
        with patch("tess_silver_ctl.hdfs_json", side_effect=lambda p: markers[p]), \
                patch("tess_silver_ctl.hdfs_exists", return_value=True), contextlib.redirect_stdout(io.StringIO()):
            snapshot = tess_silver_ctl.bronze_coverage(path)
        self.assertEqual((snapshot["coverage_sha256"], snapshot["ready_sha256"]), (coverage_sha, "d" * 64))
        self.assertEqual(snapshot["bronze_paths"], [row["location"] for row in rows])
        self.assertEqual(snapshot["coverage"], path)

    def test_submit_passes_every_sector_version_and_the_selection(self):
        captured = []

        def popen(command, **kwargs):
            captured.extend(command)
            raise RuntimeError("stop after capturing the command")

        snapshot = tess_silver_ctl.snapshot_from_rows([
            {"sector": s, "location": f"/lake/bronze/tess/sector={s:04d}", "ready_sha256": "a" * 64,
             "pipeline_version": "bronze-a" if s < 14 else "bronze-b", "product_count": 1, "observation_count": 1}
            for s in (1, 14)], coverage=None)
        with patch("tess_silver_ctl.subprocess.Popen", side_effect=popen), \
                patch("tess_bronze_ctl.hdfs_exists", return_value=False), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "stop after"):
            submit(release_dir=Path("/opt/planetory-silver/releases/20260927T000000Z"), runtime_hdfs="/r.tar.gz",
                   snapshot=snapshot, run_id="20260927T000000Z", attempt_id="20260927T000100Z",
                   pipeline_version="v", output="/o", final_output="/f", output_partitions=80,
                   shuffle_partitions=200, state_file=Path("state.json"), state={}, capacity_budget_bytes=123,
                   selection={"delta_from_sector": 14, "tic_buckets": 16, "tic_bucket": 3})
        job = captured[captured.index("/opt/planetory/tess_silver.py") + 1:]
        parsed = tess_silver.parse_args(job)
        self.assertEqual(parsed.bronze_versions, {1: "bronze-a", 14: "bronze-b"})
        self.assertEqual((parsed.delta_from_sector, parsed.tic_buckets, parsed.tic_bucket), (14, 16, 3))
        self.assertEqual((parsed.bronze_snapshot_sha256, parsed.capacity_budget_bytes), (snapshot["sha256"], 123))

    def job_args(self, *extra):
        return ["--bronze-path", "hdfs://planetory/lake/bronze/tess/sector=0001", "--bronze-sector-version", "1=a",
                "--bronze-path", "hdfs://planetory/lake/bronze/tess/sector=0014", "--bronze-sector-version", "14=b",
                "--bronze-snapshot-sha256", "a" * 64, "--capacity-budget-bytes", "1", "--pipeline-version", "v",
                "--run-id", "20260927T000000Z", "--attempt-id", "20260927T000100Z", "--output", "/o",
                "--final-output", "/f", *extra]

    def test_job_rejects_inconsistent_snapshot_and_selection_arguments(self):
        tess_silver.parse_args(self.job_args("--delta-from-sector", "14", "--tic-buckets", "4", "--tic-bucket", "3"))
        for extra in (["--delta-from-sector", "13"],
                      ["--delta-from-sector", "14", "--tic-buckets", "4", "--tic-bucket", "4"],
                      ["--tic-buckets", "4"],
                      ["--delta-from-sector", "14", "--tic-id", "5"],
                      ["--bronze-sector-version", "14=c"],
                      ["--capacity-budget-bytes", "-1"]):
            with self.subTest(extra=extra), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                tess_silver.parse_args(self.job_args(*extra))

    def test_controller_rejects_selection_without_a_sector_snapshot(self):
        valid = SimpleNamespace(through_sector=70, delta_from_sector=14, tic_buckets=16, tic_bucket=15)
        tess_silver_ctl.validate_snapshot_request(valid)
        for values in ({"through_sector": None}, {"delta_from_sector": 71}, {"tic_bucket": 16},
                       {"delta_from_sector": None}, {"through_sector": 0}):
            with self.subTest(values=values), self.assertRaises(SilverDataContractError):
                tess_silver_ctl.validate_snapshot_request(SimpleNamespace(**{**vars(valid), **values}))

    def test_changed_tics_keep_all_snapshot_rows_and_are_chosen_before_row_scans(self):
        source = inspect.getsource(tess_silver.select_changed_tics)
        self.assertIn('"left_semi"', source)
        self.assertIn("functions.pmod(", source)
        # The bucket narrows the rows first, so the changed set is computed within one bucket only.
        self.assertLess(source.index("functions.pmod("), source.index('functions.col("sector") >= delta_from_sector'))
        run = inspect.getsource(tess_silver.run)
        self.assertLess(run.index("select_changed_tics("), run.index('functions.col("schema_version")'))
        # The capacity guard must refuse before any TIC is grouped for BLS.
        self.assertLess(run.index('"capacity_budget_exceeded"'), run.index("groupByKey("))
        # The version map is read only for snapshot Sectors (no ANSI missing-key lookup).
        self.assertIn('in_snapshot, ~functions.col("pipeline_version").eqNullSafe(versions[functions.col("sector")])',
                      run)

    def test_input_checks_read_bronze_arrays_once_and_never_shuffle_them_for_selection(self):
        # 2026-09-27 Sector 14 run: every check re-ran the left_semi selection over all Bronze rows
        # (about 30 minutes for 14 Sectors) and BLS input shuffled the array rows once more.
        run = inspect.getsource(tess_silver.run)
        checks = run[:run.index("groupByKey(")]
        self.assertIn("base = bronze.select(*BRONZE_KEY_COLUMNS)", checks)
        self.assertLess(checks.index("base.persist("), checks.index("select_changed_tics("))
        self.assertEqual(checks.count("keys.agg("), 1)
        self.assertNotIn(".limit(1).count()", checks)
        self.assertNotIn("bronze.count()", checks)
        self.assertIn('inputs.join(functions.broadcast(selected_ids), "tic_id", "left_semi")', checks)
        self.assertEqual(tess_silver.BRONZE_KEY_COLUMNS, ("tic_id", "sector", "schema_version", "pipeline_version"))

    def test_attempt_marker_records_the_snapshot_selection_and_capacity(self):
        snapshot = tess_silver_ctl.snapshot_from_rows([
            {"sector": 14, "location": "/lake/bronze/tess/sector=0014", "ready_sha256": "a" * 64,
             "pipeline_version": "bronze-b", "product_count": 1, "observation_count": 1}], coverage=None)
        summary = {"contract_ok": True, "manifest_tics": 2, "science_audit_json": "[]", "selected_tics": 2,
                   "selected_products": 3, "estimated_output_bytes": 99, "succeeded_tics": 1,
                   "no_quality_peak_tics": 1, "failed_tics": 0, "retryable_failed_tics": 0, "iteration_tics": 2,
                   "iteration_succeeded_tics": 2, "iteration_incomplete_tics": 0, "iteration_qa_stopped_tics": 0,
                   "iteration_failed_tics": 0, "bronze_snapshot_sha256": snapshot["sha256"]}
        written = {}

        def hdfs(*argv, input_text=None, **kwargs):
            if input_text is not None:
                written["marker"] = json.loads(input_text)
            return SimpleNamespace(stdout=json.dumps(summary) if "-cat" in argv else "")

        kwargs = dict(release_dir=Path("/r"), snapshot=snapshot, run_id="20260927T000000Z",
                      attempt_id="20260927T000100Z", pipeline_version="v", output="/o", final="/f",
                      application_id="application_1_0001", capacity_budget_bytes=500,
                      selection={"delta_from_sector": 14, "tic_buckets": 16, "tic_bucket": 0}, operation="run")
        with patch("tess_silver_ctl.hdfs", side_effect=hdfs), \
                patch("tess_silver_ctl.part_checksum_digest", return_value=(1, "c" * 64)), \
                patch("tess_silver_ctl.fsck_healthy"), patch("tess_silver_ctl.atomic_commit"), \
                patch("tess_silver_ctl.hdfs_exists", side_effect=lambda path: path != "/f"), \
                patch("tess_silver_ctl.audit_attempt") as audit, contextlib.redirect_stdout(io.StringIO()):
            tess_silver_ctl.finalize_attempt(**kwargs)
            marker = written["marker"]
            self.assertEqual(marker["schema"], "planetory.tess-silver-attempt.v5")
            self.assertEqual(marker["bronze_snapshot_sha256"], snapshot["sha256"])
            self.assertEqual(marker["bronze_snapshot"]["sectors"][0]["pipeline_version"], "bronze-b")
            self.assertEqual(marker["selection"], kwargs["selection"])
            self.assertEqual(marker["operation"], "run")  # the planner reads it back as increment coverage
            # A Sector snapshot has no coverage, so Gold's coverage re-audit refuses this attempt.
            self.assertEqual((marker["bronze_coverage_sha256"], marker["bronze_coverage_ready_sha256"]), (None, None))
            self.assertEqual((marker["selected_products"], marker["estimated_output_bytes"],
                              marker["capacity_budget_bytes"]), (3, 99, 500))
            self.assertEqual(audit.call_args.args[1]["bronze_snapshot_sha256"], snapshot["sha256"])
            summary["bronze_snapshot_sha256"] = "d" * 64
            with self.assertRaisesRegex(SilverDataContractError, "submitted Bronze snapshot"):
                tess_silver_ctl.finalize_attempt(**kwargs)


class SilverIncrementPlanTest(unittest.TestCase):
    """275 plan: one increment rule for the backlog and every later Sector, recomputed from HDFS evidence."""

    V4 = {"schema": "planetory.tess-silver-attempt.v4", "bronze_coverage_sha256": "a" * 64}

    @staticmethod
    def v5(through, selection=None, operation="run", estimated=100):
        return {"schema": "planetory.tess-silver-attempt.v5", "operation": operation, "selection": selection,
                "estimated_output_bytes": estimated,
                "bronze_snapshot": {"sectors": [{"sector": s} for s in range(1, through + 1)]}}

    @staticmethod
    def bucket(through, start, buckets, bucket, estimated=100):
        return SilverIncrementPlanTest.v5(through, {"delta_from_sector": start, "tic_buckets": buckets,
                                                    "tic_bucket": bucket}, estimated=estimated)

    def test_bronze_watermark_is_the_last_contiguous_final_sector(self):
        listing = "\n".join(f"-rw-r--r-- 2 u g 0 2026-09-22 00:00 /lake/bronze/tess/sector={s:04d}/_SUCCESS"
                            for s in (*range(1, 15), 16))
        self.assertEqual(tess_silver_ctl.bronze_through(listing), 14)
        self.assertEqual(tess_silver_ctl.bronze_through(""), 0)

    def test_each_marker_names_the_coverage_it_completes(self):
        inc = tess_silver_ctl.attempt_increment
        self.assertEqual(inc(self.V4), (13, 1, 1, 0))
        self.assertEqual(inc(self.bucket(70, 15, 16, 3)), (70, 15, 16, 3))
        self.assertEqual(inc(self.v5(20)), (20, 1, 1, 0))
        # A retry and a canary repeat or sample other attempts, and other schemas are not Silver coverage.
        self.assertIsNone(inc(self.v5(20, operation="retry")))
        self.assertIsNone(inc(self.v5(20, operation=None)))
        self.assertIsNone(inc({"schema": "planetory.tess-silver-attempt.v3"}))

    def test_watermark_advances_only_through_finished_increments(self):
        progress = tess_silver_ctl.silver_progress
        inc = tess_silver_ctl.attempt_increment
        self.assertEqual(progress([]), (0, None, set()))
        # 2026-09-27 state: Sector 1~13 original (v4) and the Sector 14 increment.
        today = [inc(self.V4), inc(self.bucket(14, 14, 1, 0))]
        self.assertEqual(progress(today), (14, None, set()))
        partial = today + [inc(self.bucket(70, 15, 16, k)) for k in (0, 3)]
        self.assertEqual(progress(partial), (14, (70, 15, 16), {0, 3}))
        finished = today + [inc(self.bucket(70, 15, 16, k)) for k in range(16)]
        self.assertEqual(progress(finished), (70, None, set()))
        # An increment that would skip Sectors is not coverage; two open ones at once are a conflict.
        self.assertEqual(progress(today + [inc(self.bucket(70, 20, 4, 0))]), (14, None, set()))
        with self.assertRaisesRegex(SilverDataContractError, "more than one unfinished"):
            progress(partial + [inc(self.bucket(69, 15, 8, 0))])

    def test_buckets_are_only_a_capacity_split(self):
        self.assertEqual(tess_silver_ctl.plan_buckets(72_910_470_000), 1)  # the Sector 14 run
        self.assertEqual(tess_silver_ctl.plan_buckets(3_000_000_000_000), 15)
        self.assertEqual(tess_silver_ctl.plan_buckets(0), 1)
        step = tess_silver_ctl.next_step((70, 15, 16), {0, 1, 3}, 190, 482)
        self.assertEqual((step["action"], step["tic_bucket"], step["done_buckets"]), ("run", 2, [0, 1, 3]))
        self.assertEqual(tess_silver_ctl.next_step((70, 15, 16), set(), 500, 482)["action"], "wait_capacity")

    def plan(self, markers, *, active=(), estimate=None):
        listing = "\n".join(f"/lake/bronze/tess/sector={s:04d}/_SUCCESS" for s in range(1, 71))
        df = "Filesystem Size Used Available Use%\nhdfs://planetory 1000000 600000 400000 60%\n"

        def hdfs(*argv, **kwargs):
            return SimpleNamespace(stdout=df if "-df" in argv else listing)

        out = io.StringIO()
        with patch("tess_silver_ctl.active_silver_work", return_value=list(active)), \
                patch("tess_silver_ctl.hdfs", side_effect=hdfs), \
                patch("tess_silver_ctl.committed_silver_markers", return_value=markers), \
                patch("tess_silver_ctl.plan_estimate", return_value=estimate) as priced, \
                contextlib.redirect_stdout(out):
            tess_silver_ctl.command_plan(SimpleNamespace())
        line = next(line for line in out.getvalue().splitlines() if line.startswith("SILVER_PLAN_JSON="))
        return json.loads(line.removeprefix("SILVER_PLAN_JSON=")), priced

    def test_plan_starts_the_backlog_increment_from_todays_evidence(self):
        value, priced = self.plan([self.V4, self.bucket(14, 14, 1, 0)], estimate=90_000)  # fits the fake budget
        priced.assert_called_once()
        self.assertEqual(priced.call_args.args[1:], (70, 15))
        self.assertEqual((value["bronze_through"], value["silver_through"]), (70, 14))
        self.assertEqual((value["action"], value["through_sector"], value["delta_from_sector"],
                          value["tic_buckets"], value["tic_bucket"]), ("run", 70, 15, 1, 0))
        self.assertEqual(value["capacity_budget_bytes"], 200000)  # 80% of the fake 1,000,000 minus 600,000

    def test_plan_continues_an_open_increment_without_repricing(self):
        markers = [self.V4, self.bucket(14, 14, 1, 0), self.bucket(70, 15, 16, 0, 150), self.bucket(70, 15, 16, 1, 170)]
        value, priced = self.plan(markers)
        priced.assert_not_called()
        self.assertEqual((value["tic_buckets"], value["tic_bucket"], value["estimated_bucket_bytes"]), (16, 2, 170))
        self.assertEqual(value["action"], "run")  # 170 fits the 100000 budget of this fake df

    def test_plan_waits_while_silver_runs_and_idles_when_caught_up(self):
        value, priced = self.plan([], active=["planetory-tess-silver-20260927T020101Z.service"])
        self.assertEqual(value["action"], "busy")
        priced.assert_not_called()
        caught_up = [self.V4] + [self.bucket(70, 14, 1, 0)]
        value, _ = self.plan(caught_up)
        self.assertEqual((value["action"], value["silver_through"]), ("idle", 70))

    def test_plan_only_job_counts_the_selection_and_stops_before_bls(self):
        run = inspect.getsource(tess_silver.run)
        self.assertLess(run.index("if args.plan_only:"), run.index('"capacity_budget_exceeded"'))
        self.assertLess(run.index('f"{args.output}/_PLAN"'), run.index("groupByKey("))
        self.assertTrue(tess_silver.parse_args(SilverIncrementalContractTest().job_args(
            "--delta-from-sector", "14", "--plan-only")).plan_only)


class SilverUnitControllerTest(unittest.TestCase):
    RELEASE = "/opt/planetory-silver/releases/20260924T093328Z"

    def args(self, **values):
        return SimpleNamespace(**{
            "operation": "run", "release_dir": self.RELEASE, "run_id": "20260924T133559Z",
            "pipeline_version": "S15P21C206-78-20260924T093328Z",
            "bronze_coverage": "/lake/bronze/tess/coverage=" + "a" * 64,
            "shuffle_partitions": 500, "output_partitions": 80, "tic_id": None, "retry_from": None,
            **values,
        })

    def test_unit_names_are_deterministic_per_request(self):
        retry = "/lake/silver/pipeline_version=v1/run_id=20260924T133559Z/attempt=20260925T000000Z"
        self.assertEqual(tess_silver_ctl.unit_name("run", "20260924T133559Z"),
                         "planetory-tess-silver-20260924T133559Z.service")
        self.assertEqual(tess_silver_ctl.unit_name("retry", "20260924T133559Z", retry),
                         "planetory-tess-silver-retry-20260924T133559Z-20260925T000000Z.service")
        with self.assertRaises(SilverDataContractError):
            tess_silver_ctl.unit_name("retry", "20260924T133559Z", None)

    def test_unit_runs_the_same_release_controller_with_restart_policy(self):
        text = tess_silver_ctl.unit_text(self.args())
        self.assertIn(f"ExecStart=/usr/bin/python3.12 {self.RELEASE}/spark/tess_silver_ctl.py run "
                      f"--release-dir {self.RELEASE} ", text)
        self.assertIn("--shuffle-partitions 500 --output-partitions 80", text)
        for line in ("Restart=on-failure", "RestartPreventExitStatus=65", "TimeoutStartSec=infinity"):
            self.assertIn(line, text.splitlines())

    def start(self, root, props, attempt=None):
        calls = []
        with patch.object(tess_silver_ctl, "UNIT_ROOT", root), \
                patch("tess_silver_ctl.validate_unit_request"), \
                patch("tess_silver_ctl.systemd_properties", return_value=props), \
                patch("tess_silver_ctl.latest_attempt", return_value=attempt), \
                patch("tess_silver_ctl.run", side_effect=lambda argv, **_: calls.append(argv[1:])):
            tess_silver_ctl.command_start_unit(self.args(state_root="/state"))
        return calls

    def test_start_unit_is_idempotent_and_refuses_a_changed_definition(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            name = "planetory-tess-silver-20260924T133559Z.service"
            calls = self.start(root, {"ActiveState": "inactive", "ExecMainStartTimestampMonotonic": "0"})
            self.assertEqual(calls[0], ["daemon-reload"])
            self.assertEqual(calls[-1], ["--no-block", "start", name])
            self.assertEqual((root / name).read_text(encoding="utf-8"), tess_silver_ctl.unit_text(self.args()))
            # A retried Airflow task must not start a running or finished unit again.
            self.assertEqual(self.start(root, {"ActiveState": "active"}), [])
            # After a reboot systemd reports a finished unit as never started; the attempt still knows.
            self.assertEqual(self.start(root, {"ActiveState": "inactive", "ExecMainStartTimestampMonotonic": "0"},
                                        {"status": "complete"}), [])
            # A failed unit restarts under the same name; systemd keeps the definition.
            self.assertEqual(self.start(root, {"ActiveState": "failed", "Result": "exit-code",
                                               "ExecMainStartTimestampMonotonic": "5"},
                                        {"status": "failed"})[-1][-1], name)
            (root / name).write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(SilverDataContractError, "UNIT_DEFINITION_MISMATCH"):
                self.start(root, {})

    def test_a_completed_request_refuses_to_run_again_from_any_entry_point(self):
        with patch("tess_silver_ctl.latest_attempt", return_value={"status": "complete"}):
            with self.assertRaisesRegex(SilverDataContractError, "SILVER_UNIT_ALREADY_COMPLETE"):
                tess_silver_ctl.refuse_completed_unit(self.args(command="run", state_root="/state"))
        with patch("tess_silver_ctl.latest_attempt", return_value={"status": "failed"}):
            tess_silver_ctl.refuse_completed_unit(self.args(command="run", state_root="/state"))

    def test_start_unit_rejects_a_release_other_than_the_running_controller(self):
        with self.assertRaises(SilverDataContractError):
            tess_silver_ctl.validate_unit_request(self.args())

    def test_status_reports_the_unit_and_latest_attempt(self):
        import contextlib
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp, "run=20260924T133559Z")
            run_dir.mkdir()
            retry_unit = "planetory-tess-silver-retry-20260924T133559Z-20260925T000000Z.service"
            # The unit-less attempt predates the field and belongs to `run`; the newer one is a retry's.
            for attempt, state in (("20260924T133600Z", {"status": "failed"}),
                                   ("20260924T140000Z", {"status": "running"}),
                                   ("20260925T010000Z", {"status": "complete", "unit": retry_unit})):
                (run_dir / f"attempt={attempt}.json").write_text(json.dumps(state))
            out = io.StringIO()
            with patch("tess_silver_ctl.systemd_properties", return_value={"ActiveState": "active"}), \
                    contextlib.redirect_stdout(out):
                tess_silver_ctl.command_status(SimpleNamespace(
                    operation="run", run_id="20260924T133559Z", retry_from=None, state_root=tmp))
            retry = tess_silver_ctl.latest_attempt(tmp, "20260924T133559Z", retry_unit)
        value = json.loads(out.getvalue().removeprefix("SILVER_STATUS_JSON="))
        self.assertEqual(value["attempt"], {"status": "running"})
        self.assertEqual(value["unit"], "planetory-tess-silver-20260924T133559Z.service")
        self.assertEqual(retry["status"], "complete")


if __name__ == "__main__":
    unittest.main()

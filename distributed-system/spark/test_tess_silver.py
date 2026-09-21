import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

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
    validate_bronze_coverage,
)
from astro_kernel.preprocessing import MASK_CONTRACT_VERSION, IntervalMask, preprocess_silver  # noqa: E402
from astro_kernel.bls import search_bls  # noqa: E402


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


def call(rows, preprocess, search, *, interval_masks=()):
    return process_tic(
        rows,
        run_id="run",
        attempt_id="attempt",
        pipeline_version="pipeline",
        target_location="/final/target_combined",
        periodogram_location="/final/periodogram",
        interval_masks=interval_masks,
        preprocess=preprocess,
        search=search,
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
        self.assertEqual(result.manifest[17], "invalid_lineage")
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
        self.assertEqual(result.manifest[17], "provenance_mismatch")
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
        self.assertEqual(result.manifest[17], "mask_source_mismatch")
        self.assertIsNone(result.target)

    @unittest.skipUnless(importlib.util.find_spec("astropy"), "Astropy runtime is not installed")
    def test_real_preprocessing_to_bls_boundary_executes(self):
        result = call([self.real_bronze_row()], preprocess_silver, search_bls)
        self.assertIn(result.manifest[5], {"succeeded", "no_quality_peak"})
        self.assertIsNotNone(result.periodogram)

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
        self.assertEqual(result.manifest[17], "insufficient_observations")
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
        self.assertIsNone(result.manifest[17])

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
        target_schema, periodogram_schema, manifest_schema, _ = _schemas(fake)
        result = call(
            [bronze_row()],
            lambda curves, **kwargs: (prepared(), detrended()),
            lambda *args, **kwargs: search_result("ok"),
        )
        self.assertEqual(len(result.target), len(target_schema))
        self.assertEqual(len(result.periodogram), len(periodogram_schema))
        self.assertEqual(len(result.manifest), len(manifest_schema))

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
        self.assertEqual(failed.manifest[17], "unexpected_processing_error")
        self.assertEqual(succeeded.manifest[5], "succeeded")

    def test_malformed_bronze_row_is_isolated_before_sorting(self):
        row = bronze_row()
        del row["sector"]
        result = call([row], lambda curves, **kwargs: (prepared(), detrended()), lambda *args, **kwargs: None)
        self.assertEqual(result.manifest[5], "failed")
        self.assertEqual(result.manifest[17], "invalid_bronze_row")

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
        self.assertEqual(SILVER_READY_SCHEMA, "planetory.tess-silver-attempt.v2")


if __name__ == "__main__":
    unittest.main()

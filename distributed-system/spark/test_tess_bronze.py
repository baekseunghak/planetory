import hashlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from astro_kernel.preprocessing import PreprocessError  # noqa: E402
from tess_bronze import BRONZE_SCHEMA_VERSION, _hash_values, transform_record  # noqa: E402
from tess_bronze_ctl import (  # noqa: E402
    RAW_COVERAGE_SCHEMA,
    RAW_COVERAGE_SHA256,
    validate_raw_coverage,
)


def manifest(payload=b"fits", sector=3):
    return {
        "sample.fits": {
            "filename": "sample.fits",
            "tic_id": 123,
            "sector": sector,
            "size_bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bundle_location": f"hdfs://planetory/raw/sector={sector:04d}/bundle.seq",
            "sequence_key": "sample.fits",
            "offset_start": 1,
            "offset_end": 2,
            "input_snapshot_id": "snapshot",
            "source_list_sha256": "a" * 64,
            "worker_slot": 1,
        }
    }


def coverage_contract():
    contexts = {}
    sectors = []
    for sector in range(1, 14):
        release = "old" if sector in (3, 4, 5) else "new"
        count = 100 + sector
        ready_sha = f"{sector:064x}"
        source_sha = "a" * 64 if release == "old" else "b" * 64
        path = f"/lake/raw/tess/release={release}/sector={sector:04d}"
        contexts[sector] = {
            "release": release,
            "path": path,
            "ready_sha256": ready_sha,
            "ready": {"product_count": count, "source_list_sha256": source_sha},
        }
        sectors.append({
            "sector": sector,
            "release_id": release,
            "location": path,
            "ready_sha256": ready_sha,
            "source_list_sha256": source_sha,
            "product_count": count,
        })
    total = sum(row["product_count"] for row in sectors)
    return contexts, {
        "schema": RAW_COVERAGE_SCHEMA,
        "source_coverage_sha256": RAW_COVERAGE_SHA256,
        "replication": 2,
        "expected": total,
        "validated": total,
        "sectors": sectors,
    }


class FakeFits:
    @staticmethod
    def open(*args, **kwargs):
        class Context:
            def __enter__(self):
                return []

            def __exit__(self, *exc):
                return False

        return Context()


class BronzeTransformTest(unittest.TestCase):
    def test_snapshot_hash_is_sorted_and_delimited(self):
        expected = hashlib.sha256(b"a\nb\n").hexdigest()
        self.assertEqual(_hash_values(["b", "a"]), expected)

    def test_raw_coverage_requires_all_matching_sectors(self):
        contexts, value = coverage_contract()
        validate_raw_coverage(value, contexts)
        value["sectors"][0]["ready_sha256"] = "f" * 64
        with self.assertRaisesRegex(RuntimeError, "sector=1"):
            validate_raw_coverage(value, contexts)

    def test_success_preserves_arrays_and_lineage(self):
        payload = b"fits"
        curve = SimpleNamespace(
            tic_id=123,
            sector=3,
            product_id="sample.fits",
            time=np.array([1.0, np.nan]),
            flux=np.array([2.0, np.inf]),
            flux_err=np.array([0.1, np.nan]),
            quality=np.array([0, 1], dtype=np.int64),
            cadenceno=np.array([7, 8], dtype=np.int64),
        )
        meta = dict(
            PROCVER="fixture",
            TIMESYS="TDB",
            BJDREFI=2457000,
            BJDREFF=0.0,
            TIMEUNIT="d",
            TIMEDEL=1 / 720,
            FLUX_UNIT="e-/s",
        )
        with patch.dict(sys.modules, {"astropy.io": SimpleNamespace(fits=FakeFits)}), patch(
            "tess_bronze.parse_spoc_hdul", return_value=(curve, meta)
        ):
            kind, row, error, product = transform_record(
                "sample.fits",
                payload,
                manifest(payload),
                expected_sector=3,
                raw_release="release",
                pipeline_version="pipeline",
            )
        self.assertEqual(kind, "success")
        self.assertIsNone(error)
        self.assertEqual(product, "sample.fits")
        self.assertTrue(np.isnan(row[3][1]))
        self.assertTrue(np.isinf(row[4][1]))
        self.assertEqual(row[6], [0, 1])
        self.assertEqual(row[-2], BRONZE_SCHEMA_VERSION)

    def test_missing_manifest_is_explicit(self):
        kind, row, error, _ = transform_record(
            "missing.fits",
            b"fits",
            {},
            expected_sector=3,
            raw_release="release",
            pipeline_version="pipeline",
        )
        self.assertEqual(kind, "error")
        self.assertIsNone(row)
        self.assertEqual(error[5:7], ("input", "manifest_entry_missing"))

    def test_checksum_failure_does_not_parse(self):
        kind, _, error, _ = transform_record(
            "sample.fits",
            b"wrong",
            manifest(b"fits"),
            expected_sector=3,
            raw_release="release",
            pipeline_version="pipeline",
        )
        self.assertEqual(kind, "error")
        self.assertEqual(error[5:7], ("raw_checksum", "raw_size_mismatch"))

    def test_parse_failure_is_isolated_as_product_error(self):
        with patch.dict(sys.modules, {"astropy.io": SimpleNamespace(fits=FakeFits)}), patch(
            "tess_bronze.parse_spoc_hdul",
            side_effect=PreprocessError("invalid_fits_structure", "sample.fits"),
        ):
            kind, row, error, product = transform_record(
                "sample.fits",
                b"fits",
                manifest(),
                expected_sector=3,
                raw_release="release",
                pipeline_version="pipeline",
            )
        self.assertEqual(kind, "error")
        self.assertIsNone(row)
        self.assertEqual(product, "sample.fits")
        self.assertEqual(error[5:7], ("fits_parse", "invalid_fits_structure"))


if __name__ == "__main__":
    unittest.main()

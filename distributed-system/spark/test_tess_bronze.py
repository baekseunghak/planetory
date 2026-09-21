import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from astro_kernel.preprocessing import PreprocessError  # noqa: E402
from tess_bronze import (  # noqa: E402
    BRONZE_SCHEMA_VERSION,
    BRONZE_TERMINAL_SCHEMA,
    REQUIRED_MANIFEST_FIELDS,
    ManifestContractError,
    _hash_values,
    _manifest_map,
    _write_terminal_marker,
    transform_record,
)
from tess_bronze_ctl import (  # noqa: E402
    DATA_CONTRACT_EXIT_CODE,
    RAW_COVERAGE_SCHEMA,
    RAW_COVERAGE_SHA256,
    BronzeDataContractError,
    cli,
    finalize_sector,
    run_sector,
    submit,
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
    @staticmethod
    def fake_pyspark_functions():
        class Expression:
            def isNull(self):
                return self

            def __or__(self, other):
                return self

            def __ne__(self, other):
                return self

        sql = ModuleType("pyspark.sql")
        sql.functions = SimpleNamespace(lit=lambda value: Expression(), col=lambda name: Expression())
        pyspark = ModuleType("pyspark")
        pyspark.sql = sql
        return {"pyspark": pyspark, "pyspark.sql": sql}

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

    def test_manifest_missing_columns_is_terminal(self):
        frame = SimpleNamespace(columns=[])
        with patch.dict(sys.modules, self.fake_pyspark_functions()):
            with self.assertRaisesRegex(ManifestContractError, "missing columns") as caught:
                _manifest_map(frame, SimpleNamespace())
        self.assertEqual(caught.exception.code, "manifest_missing_columns")

    def test_manifest_product_count_mismatch_is_terminal(self):
        class EmptyQuery:
            def limit(self, count):
                return self

            def count(self):
                return 0

        class Selected:
            def filter(self, expression):
                return EmptyQuery()

            def count(self):
                return 1

        frame = SimpleNamespace(
            columns=list(REQUIRED_MANIFEST_FIELDS),
            select=lambda *columns: Selected(),
        )
        args = SimpleNamespace(sector=3, source_list_sha256="a" * 64, expected_products=2)
        with patch.dict(sys.modules, self.fake_pyspark_functions()):
            with self.assertRaisesRegex(ManifestContractError, "product count") as caught:
                _manifest_map(frame, args)
        self.assertEqual(caught.exception.code, "manifest_product_count_mismatch")

    def test_manifest_terminal_marker_is_written_to_attempt(self):
        written = {}

        class Output:
            def saveAsTextFile(self, path):
                written["path"] = path

        class Context:
            def parallelize(self, rows, partitions):
                written["rows"] = rows
                written["partitions"] = partitions
                return Output()

        args = SimpleNamespace(output="/staging/attempt", sector=3, run_id="run")
        _write_terminal_marker(
            SimpleNamespace(sparkContext=Context()),
            args,
            ManifestContractError("manifest_missing_columns", "manifest missing columns: sha256"),
        )
        marker = json.loads(written["rows"][0])
        self.assertEqual(written["path"], "/staging/attempt/_TERMINAL")
        self.assertEqual(written["partitions"], 1)
        self.assertEqual(marker["schema"], BRONZE_TERMINAL_SCHEMA)
        self.assertEqual(marker["error_code"], "manifest_missing_columns")

    def test_submit_maps_manifest_terminal_marker_to_data_contract_error(self):
        marker = {
            "schema": BRONZE_TERMINAL_SCHEMA,
            "failure_type": "data_contract",
            "error_stage": "manifest",
            "error_code": "manifest_product_count_mismatch",
            "error_detail": "manifest product count mismatch",
        }
        process = SimpleNamespace(stdout=iter(["application_1_1\n"]), wait=lambda: 1)
        context = {
            "path": "/lake/raw/sector=0003",
            "release": "release",
            "ready_sha256": "a" * 64,
            "ready": {"source_list_sha256": "b" * 64, "product_count": 2},
        }
        with tempfile.TemporaryDirectory() as root, patch(
            "tess_bronze_ctl.subprocess.Popen", return_value=process
        ), patch("tess_bronze_ctl.hdfs_exists", return_value=True), patch(
            "tess_bronze_ctl.hdfs_json", return_value=(marker, "c" * 64)
        ):
            with self.assertRaisesRegex(BronzeDataContractError, "manifest_product_count_mismatch"):
                submit(
                    release_dir=Path("."),
                    runtime_hdfs="/runtime.tar.gz",
                    context=context,
                    sector=3,
                    run_id="run",
                    pipeline_version="pipeline",
                    output="/staging/attempt",
                    output_partitions=1,
                    state_file=Path(root) / "state.json",
                    state={"status": "prepared"},
                )

    def test_sector_contract_failure_is_terminal(self):
        summary = {
            "contract_ok": False,
            "success_products": 0,
            "error_products": 1,
        }
        context = {"ready": {"product_count": 1}}
        with patch(
            "tess_bronze_ctl.hdfs",
            return_value=SimpleNamespace(stdout=json.dumps(summary) + "\n"),
        ):
            with self.assertRaisesRegex(BronzeDataContractError, "sector=3"):
                finalize_sector(
                    release_dir=Path("."),
                    context=context,
                    sector=3,
                    run_id="run",
                    pipeline_version="pipeline",
                    output="/staging/attempt",
                    application_id="application_1_1",
                )

    def test_terminal_failure_is_recorded_for_operator_review(self):
        with tempfile.TemporaryDirectory() as root, patch(
            "tess_bronze_ctl.audit_final", return_value=False
        ), patch("tess_bronze_ctl.prepare_spark_paths"), patch(
            "tess_bronze_ctl.submit", return_value="application_1_1"
        ), patch(
            "tess_bronze_ctl.finalize_sector",
            side_effect=BronzeDataContractError("bad checksum"),
        ):
            with self.assertRaises(BronzeDataContractError):
                run_sector(
                    release_dir=Path("."),
                    runtime_hdfs="/runtime.tar.gz",
                    context={},
                    sector=3,
                    run_id="run",
                    pipeline_version="pipeline",
                    output_partitions=1,
                    state_root=Path(root),
                )
            state = json.loads((Path(root) / "run=run" / "sector=0003.json").read_text())
            self.assertEqual(state["status"], "terminal_failed")
            self.assertEqual(state["failure_type"], "BronzeDataContractError")
            self.assertEqual(state["failure_detail"], "bad checksum")

    def test_submit_contract_failure_is_recorded_for_operator_review(self):
        with tempfile.TemporaryDirectory() as root, patch(
            "tess_bronze_ctl.audit_final", return_value=False
        ), patch("tess_bronze_ctl.prepare_spark_paths"), patch(
            "tess_bronze_ctl.submit",
            side_effect=BronzeDataContractError("manifest product count mismatch"),
        ), patch("tess_bronze_ctl.finalize_sector") as finalize:
            with self.assertRaises(BronzeDataContractError):
                run_sector(
                    release_dir=Path("."),
                    runtime_hdfs="/runtime.tar.gz",
                    context={},
                    sector=3,
                    run_id="run",
                    pipeline_version="pipeline",
                    output_partitions=1,
                    state_root=Path(root),
                )
            finalize.assert_not_called()
            state = json.loads((Path(root) / "run=run" / "sector=0003.json").read_text())
            self.assertEqual(state["status"], "terminal_failed")
            self.assertEqual(state["failure_detail"], "manifest product count mismatch")

    def test_cli_maps_only_data_contract_failures_to_non_retryable_exit(self):
        with patch("tess_bronze_ctl.main", side_effect=BronzeDataContractError("bad input")):
            self.assertEqual(cli(), DATA_CONTRACT_EXIT_CODE)
        with patch("tess_bronze_ctl.main", side_effect=RuntimeError("temporary outage")):
            with self.assertRaisesRegex(RuntimeError, "temporary outage"):
                cli()


if __name__ == "__main__":
    unittest.main()

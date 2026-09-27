"""80 외부 카탈로그 수집기: CSV 구조 검사, 원천 정의와 124 커널의 정합, HDFS 확정 흐름을 네트워크·HDFS 없이 본다."""
import hashlib
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "libs" / "astro-kernel"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import tess_external_ctl as collector  # noqa: E402
from astro_kernel.external_catalog import TIME_EVIDENCE, normalize_export_row  # noqa: E402

# One plausible value per required column; every source must normalize from these columns alone.
SAMPLE = {
    "nea_toi": {"tid": "1", "toi": "1.01", "tfopwg_disp": "PC", "pl_orbper": "2.0", "pl_tranmid": "2458355.0",
                "pl_trandurh": "3.0", "pl_trandep": "1000", "rowupdate": "2026-09-01"},
    "nea_pscomppars": {"tic_id": "TIC 1", "pl_name": "X b", "pl_orbper": "2.0", "pl_tranmid": "2458355.0",
                       "pl_tranmid_systemref": "BJD-TDB", "pl_trandur": "3.0", "pl_trandep": "0.1", "tran_flag": "1"},
    "mast_tce_s1_s13": {"ticid": "1", "tceid": "1-01", "tce_period": "2.0", "tce_time0bt": "1355.0",
                        "tce_duration": "3.0"},
    "exofop_toi": {"TIC ID": "1", "TOI": "1.01", "Period (days)": "2.0", "Epoch (BJD)": "2458355.0",
                   "Duration (hours)": "3.0", "TFOPWG Disposition": "PC", "Date TOI Updated (UTC)": "2026-09-01"},
}


def csv_bytes(name, preamble=""):
    columns = collector.SOURCES[name][1]
    header = ",".join(f'"{c}"' if " " in c else c for c in columns)
    return (preamble + header + "\n" + ",".join(SAMPLE[name][c] for c in columns) + "\n").encode()


class CsvInspectionTest(unittest.TestCase):
    def test_structure_is_checked_without_reading_values(self):
        info = collector.inspect_csv(csv_bytes("mast_tce_s1_s13", preamble="# MAST TCE\n\n"),
                                     collector.SOURCES["mast_tce_s1_s13"][1])
        self.assertEqual((info["row_count"], info["preamble_lines"]), (1, 2))
        required = collector.TOI_COLUMNS
        for data, reason in ((b"<html>error</html>", "html"), (b"tid,toi\n1,1.01\n", "missing_columns"),
                             (csv_bytes("nea_toi")[:-1] + b",extra\n", "width"),
                             (csv_bytes("nea_toi").split(b"\n")[0] + b"\n", "empty")):
            with self.assertRaisesRegex(ValueError, reason):
                collector.inspect_csv(data, required)

    def test_every_source_is_a_whole_table_the_kernel_can_normalize(self):
        self.assertEqual(set(collector.SOURCES), set(TIME_EVIDENCE))
        self.assertNotIn("where", collector.SOURCES["nea_toi"][0])
        self.assertIn("tic_id+is+not+null", collector.SOURCES["nea_pscomppars"][0])
        for name in collector.SOURCES:
            self.assertEqual(normalize_export_row(name, SAMPLE[name])["status"], "normalized", name)


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hdfs_files, self.calls, self.exists = {}, [], set()

    def tearDown(self):
        self.temp.cleanup()

    def fake_hdfs(self, *argv, input_text=None, check=True):
        self.calls.append(argv)
        if argv[:2] == ("dfs", "-put"):
            self.hdfs_files[argv[3]] = Path(argv[2]).read_bytes()
        return Namespace(stdout="", returncode=0)

    def collect(self, fetch):
        final = f"{collector.ROOT}/run_id=20260927T000000Z"

        def hdfs_json(path):
            data = self.hdfs_files[path.replace(final, f"{collector.ROOT}/.staging/run=20260927T000000Z")]
            return json.loads(data), hashlib.sha256(data).hexdigest()

        with patch.object(collector, "LOCAL_TMP", self.temp.name), patch.object(collector, "hdfs", self.fake_hdfs), \
                patch.object(collector, "hdfs_exists", lambda path: path in self.exists), \
                patch.object(collector, "hdfs_json", hdfs_json), patch.object(collector, "fsck_healthy"), \
                patch.object(collector, "atomic_commit") as commit:
            marker = collector.collect("20260927T000000Z", Path("/r"), fetch=fetch)
        return marker, commit

    def test_all_sources_are_committed_byte_for_byte_with_their_records(self):
        by_url = {url: csv_bytes(name) for name, (url, _) in collector.SOURCES.items()}
        marker, commit = self.collect(lambda url: (by_url[url], {"final_url": url, "content_type": "text/csv"}))
        stage = f"{collector.ROOT}/.staging/run=20260927T000000Z"
        commit.assert_called_once_with(Path("/r"), stage, f"{collector.ROOT}/run_id=20260927T000000Z")
        for name, (url, _) in collector.SOURCES.items():
            self.assertEqual(self.hdfs_files[f"{stage}/sources/{name}.csv"], by_url[url])
            entry = marker["sources"][name]
            self.assertEqual((entry["sha256"], entry["row_count"]), (hashlib.sha256(by_url[url]).hexdigest(), 1))
        self.assertEqual(json.loads(self.hdfs_files[f"{stage}/_READY.json"]), marker)

    def test_one_failed_source_commits_nothing(self):
        def fetch(url):
            if "exofop" in url:
                raise OSError("connection reset")
            return csv_bytes(next(n for n, (u, _) in collector.SOURCES.items() if u == url)), {}

        with self.assertRaisesRegex(RuntimeError, "exofop_toi not collected"):
            self.collect(fetch)
        self.assertFalse(any(argv[:2] == ("dfs", "-put") for argv in self.calls))

    def test_a_committed_run_is_reused_not_downloaded_again(self):
        final = f"{collector.ROOT}/run_id=20260927T000000Z"
        self.exists.add(final)
        self.hdfs_files[f"{collector.ROOT}/.staging/run=20260927T000000Z/_READY.json"] = json.dumps(
            {"schema": collector.EXTERNAL_READY_SCHEMA, "run_id": "20260927T000000Z"}).encode()
        marker, commit = self.collect(lambda url: self.fail("must not download"))
        self.assertEqual(marker["run_id"], "20260927T000000Z")
        commit.assert_not_called()


if __name__ == "__main__":
    unittest.main()

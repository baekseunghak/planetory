"""Node 1 collector for a Gold run's external catalogs (80): download, check, commit the raw CSVs.

Standard library only, like the other controllers. Each source is a whole public table,
kept byte-for-byte; the Gold job normalizes it with the 124 kernel and picks each star's
rows. A committed run snapshot is never rewritten: collecting the same run again reuses it.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from tess_bronze_ctl import atomic_commit, fsck_healthy, hdfs, hdfs_exists, hdfs_json, utc_now
from tess_silver_ctl import RUN_ID_RE

EXTERNAL_READY_SCHEMA = "planetory.tess-external-snapshot.v1"
COLLECTOR_VERSION = "external-collector-80-v1"
ROOT = "/lake/external/tess"
TAP_SYNC = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
USER_AGENT = "ssafy-planetory-pipeline/S15P21C206-80"
MAX_BYTES = 64 * 1024 * 1024
TIMEOUT_SECONDS = 300
LOCAL_TMP = "/var/tmp"


def _tap(columns: tuple[str, ...], table: str, where: str = "") -> str:
    query = f"select {','.join(columns)} from {table}{where}"
    return TAP_SYNC + "?" + urlencode({"query": query, "format": "csv"})


# Columns are the ones astro_kernel.external_catalog.normalize_export_row reads (116 mapping).
TOI_COLUMNS = ("tid", "toi", "tfopwg_disp", "pl_orbper", "pl_tranmid", "pl_trandurh", "pl_trandep", "rowupdate")
PSCOMPPARS_COLUMNS = ("tic_id", "pl_name", "pl_orbper", "pl_tranmid", "pl_tranmid_systemref", "pl_trandur",
                      "pl_trandep", "tran_flag")
SOURCES = {
    "nea_toi": (_tap(TOI_COLUMNS, "toi"), TOI_COLUMNS),
    # Rows without a TIC cannot belong to a TESS star; left in, they would mark the source unvalidated.
    "nea_pscomppars": (_tap(PSCOMPPARS_COLUMNS, "pscomppars", " where tic_id is not null"), PSCOMPPARS_COLUMNS),
    "mast_tce_s1_s13": ("https://archive.stsci.edu/missions/tess/catalogs/tce/"
                        "tess2018206190142-s0001-s0013_dvr-tcestats.csv",
                        ("ticid", "tceid", "tce_period", "tce_time0bt", "tce_duration")),
    "exofop_toi": ("https://exofop.ipac.caltech.edu/tess/download_toi.php?sort=toi&output=csv",
                   ("TIC ID", "TOI", "Period (days)", "Epoch (BJD)", "Duration (hours)", "TFOPWG Disposition",
                    "Date TOI Updated (UTC)")),
}


def download(url: str) -> tuple[bytes, dict[str, Any]]:
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=TIMEOUT_SECONDS) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("response_size_limit")
        expected = response.headers.get("Content-Length")
        if expected is not None and len(data) != int(expected):
            raise ValueError("incomplete_response")
        return data, {"final_url": response.geturl(), "content_type": response.headers.get("Content-Type")}


def inspect_csv(data: bytes, required: tuple[str, ...]) -> dict[str, Any]:
    """Structure only: never prints row values. MAST files may start with # metadata lines."""
    text = data.decode("utf-8-sig")
    if text.lstrip().startswith("<"):
        raise ValueError("html_or_xml_response")
    lines = text.splitlines(keepends=True)
    start = 0
    while start < len(lines) and (not lines[start].strip() or lines[start].lstrip().startswith("#")):
        start += 1
    reader = csv.reader(io.StringIO("".join(lines[start:])), strict=True)
    header = next(reader, [])
    if len(header) < 2 or any(not column.strip() for column in header) or len(set(header)) != len(header):
        raise ValueError("invalid_csv_header")
    missing = sorted(set(required) - set(header))
    if missing:
        raise ValueError(f"missing_columns:{','.join(missing)}")
    count = 0
    for row in reader:
        if not row:
            continue
        if len(row) != len(header):
            raise ValueError("inconsistent_csv_width")
        count += 1
    if count == 0:
        raise ValueError("empty_export")
    return {"columns": header, "row_count": count, "preamble_lines": start}


def failure(exc: Exception) -> str:
    """Why a download failed, without response bodies or third-party messages."""
    if isinstance(exc, HTTPError):
        return f"HTTPError status={exc.code}"
    if isinstance(exc, URLError):
        return f"URLError reason={type(exc.reason).__name__}"
    return f"{type(exc).__name__}: {exc}"[:200]


def fetch_sources(folder: Path, fetch: Callable[[str], tuple[bytes, dict]] = download) -> dict[str, Any]:
    """Download every source into folder. Any failure fails the run: a Gold run needs all of them."""
    entries = {}
    for name, (url, required) in SOURCES.items():
        try:
            data, metadata = fetch(url)
            entry = {"file": f"sources/{name}.csv", "requested_url": url, "retrieved_at": utc_now(),
                     "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), **metadata,
                     **inspect_csv(data, required)}
        except (OSError, ValueError, UnicodeError, csv.Error) as exc:
            raise RuntimeError(f"external source {name} not collected: {failure(exc)}") from exc
        (folder / f"{name}.csv").write_bytes(data)
        entries[name] = entry
        print(f"EXTERNAL_SOURCE_OK source={name} rows={entry['row_count']} bytes={entry['bytes']}", flush=True)
    return entries


def collect(run_id: str, release_dir: Path, fetch: Callable[[str], tuple[bytes, dict]] = download) -> dict[str, Any]:
    final = f"{ROOT}/run_id={run_id}"
    if hdfs_exists(final):
        marker, _ = hdfs_json(f"{final}/_READY.json")
        if marker.get("schema") != EXTERNAL_READY_SCHEMA or marker.get("run_id") != run_id:
            raise RuntimeError(f"existing external snapshot is not a committed run: {final}")
        print(f"EXTERNAL_SNAPSHOT_CACHED final={final}", flush=True)
        return marker
    stage = f"{ROOT}/.staging/run={run_id}"
    with tempfile.TemporaryDirectory(prefix="planetory-external-", dir=LOCAL_TMP) as temp:
        folder = Path(temp)
        os.chmod(folder, 0o755)  # the hdfs user uploads these files
        marker = {"schema": EXTERNAL_READY_SCHEMA, "collector_version": COLLECTOR_VERSION, "run_id": run_id,
                  "sources": fetch_sources(folder, fetch)}
        marker["completed_at_utc"] = utc_now()
        (folder / "_READY.json").write_text(json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n",
                                            encoding="utf-8")
        for path in folder.iterdir():
            os.chmod(path, 0o644)
        if hdfs_exists(stage):  # an earlier interrupted attempt of this run; its files are replaced whole
            hdfs("dfs", "-rm", "-r", "-skipTrash", stage)
        hdfs("dfs", "-mkdir", "-p", f"{stage}/sources")
        for name in marker["sources"]:
            hdfs("dfs", "-put", str(folder / f"{name}.csv"), f"{stage}/sources/{name}.csv")
        hdfs("dfs", "-put", str(folder / "_READY.json"), f"{stage}/_READY.json")
    hdfs("dfs", "-setrep", "-w", "2", stage)
    fsck_healthy(stage)
    atomic_commit(release_dir, stage, final)
    committed, _ = hdfs_json(f"{final}/_READY.json")
    if committed != marker:
        raise RuntimeError("external snapshot marker changed during commit")
    fsck_healthy(final)
    print(f"EXTERNAL_SNAPSHOT_COMMIT_OK final={final}", flush=True)
    return marker


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    child = subparsers.add_parser("collect")
    child.add_argument("--run-id", required=True)
    child.add_argument("--release-dir", required=True)
    args = parser.parse_args(argv)
    if not RUN_ID_RE.fullmatch(args.run_id):
        raise SystemExit("run ID must be UTC yyyyMMddTHHmmssZ")
    collect(args.run_id, Path(args.release_dir).resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())

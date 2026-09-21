"""Validation shared by the TESS Sector Airflow DAG and its offline test."""

from __future__ import annotations

import re
import shlex
from pathlib import PurePosixPath


RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RELEASE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def sector_inputs(params: dict, sector: int) -> tuple[str, str]:
    if sector not in range(1, 14):
        raise ValueError("Sector must be in 1..13")
    try:
        run_id = str(params["sector_runs"][str(sector)])
        source_sha = str(params["sector_source_sha256"][str(sector)])
    except (KeyError, TypeError) as error:
        raise ValueError(f"missing Sector {sector} lineage") from error
    if not RUN_ID_RE.fullmatch(run_id) or not SHA256_RE.fullmatch(source_sha):
        raise ValueError(f"invalid Sector {sector} lineage")
    return run_id, source_sha


def validate_download_markers(markers: list[dict], sector: int, run_id: str, source_sha: str) -> dict:
    slots = set()
    products = 0
    total_bytes = 0
    for marker in markers:
        try:
            slot = int(marker.get("worker_slot", 0))
            marker_sector = int(marker.get("sector", 0))
            validated = int(marker.get("validated", 0))
            marker_bytes = int(marker.get("total_bytes", 0))
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid download completion marker for Sector {sector}") from error
        if (
            marker.get("schema") != "planetory.ingestion-sector-complete.v1"
            or marker_sector != sector
            or marker.get("source_list_sha256") != source_sha
            or slot not in range(1, 6)
            or slot in slots
            or validated < 1
            or marker_bytes < 1
        ):
            raise ValueError(f"invalid download completion marker for Sector {sector}")
        slots.add(slot)
        products += validated
        total_bytes += marker_bytes
    if slots != set(range(1, 6)):
        raise ValueError(f"Sector {sector} does not have all five Worker markers")
    return {
        "sector": sector,
        "run_id": run_id,
        "source_list_sha256": source_sha,
        "product_count": products,
        "total_bytes": total_bytes,
    }


def exact_path(value: str, prefix: str) -> str:
    path = PurePosixPath(value)
    if not path.is_absolute() or ".." in path.parts or not str(path).startswith(prefix):
        raise ValueError(f"path must stay below {prefix}")
    return str(path)


def release_path(value: str, prefix: str) -> str:
    path = exact_path(value, prefix)
    if not RELEASE_RE.fullmatch(PurePosixPath(path).name):
        raise ValueError("invalid immutable release path")
    return path


def command(arguments: list[str]) -> str:
    return shlex.join(arguments)

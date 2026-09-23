"""MAST LC discovery and evidence-based Sector resume planning."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


INDEX_URL = "https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_ffi-tp-lc-dv.html"
SCRIPT_PATH = re.compile(r"^/missions/tess/download_scripts/sector/tesscurl_sector_([1-9][0-9]*)_lc\.sh$")
MAX_INDEX_BYTES = 4 * 1024 * 1024
STAGES = ("download", "raw", "cleanup", "bronze")


def effective_max_sector(param: object, configured_cap: object) -> int:
    """The persistent cap also applies to scheduled runs without a trigger conf."""
    try:
        if isinstance(param, bool) or isinstance(configured_cap, bool):
            raise ValueError
        requested, cap = int(param), int(configured_cap)
    except (TypeError, ValueError) as error:
        raise ValueError("max Sector and persistent cap must be integers in 14..70") from error
    if not 14 <= requested <= 70 or not 14 <= cap <= 70:
        raise ValueError("max Sector and persistent cap must be in 14..70")
    return min(requested, cap)


def completed_through(value: object) -> int:
    """Highest Sector whose contiguous 14..N Bronze evidence was already confirmed."""
    try:
        if isinstance(value, bool):
            raise ValueError
        sector = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("completed Sector mark must be an integer in 13..70") from error
    if not 13 <= sector <= 70:
        raise ValueError("completed Sector mark must be in 13..70")
    return sector


class _ScriptLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.scripts: dict[int, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        href = dict(attrs).get("href")
        if not href:
            return
        url = urljoin(INDEX_URL, href)
        parsed = urlsplit(url)
        match = SCRIPT_PATH.fullmatch(parsed.path)
        if not match or (parsed.scheme, parsed.netloc, parsed.query, parsed.fragment) != (
            "https", "archive.stsci.edu", "", ""
        ):
            return
        sector = int(match.group(1))
        if sector in self.scripts and self.scripts[sector] != url:
            raise ValueError(f"conflicting official LC script for Sector {sector}")
        self.scripts[sector] = url


def parse_lc_scripts(html: str) -> dict[int, str]:
    parser = _ScriptLinks()
    parser.feed(html)
    if not parser.scripts:
        raise ValueError("MAST index has no official two-minute LC scripts")
    return parser.scripts


def published_lc_scripts() -> dict[int, str]:
    request = Request(INDEX_URL, headers={"User-Agent": "Planetory-TESS-discovery/1"})
    with urlopen(request, timeout=30) as response:
        if response.geturl() != INDEX_URL:
            raise ValueError("MAST index redirected unexpectedly")
        body = response.read(MAX_INDEX_BYTES + 1)
    if len(body) > MAX_INDEX_BYTES:
        raise ValueError("MAST index exceeds size limit")
    return parse_lc_scripts(body.decode("utf-8", errors="replace"))


def latest_published_sector(published: dict[int, str], max_sector: int) -> int | None:
    if type(max_sector) is not int or not 1 <= max_sector <= 70:
        raise ValueError("max Sector must be an integer in 1..70")
    return max((sector for sector in published if sector <= max_sector), default=None)


def resume_stage(evidence: dict[str, bool]) -> str | None:
    """Downstream final evidence remains valid after local FITS cleanup."""
    if (
        not isinstance(evidence, dict)
        or set(evidence) - set(STAGES)
        or any(type(value) is not bool for value in evidence.values())
    ):
        raise ValueError("invalid Sector stage evidence")
    if (evidence.get("cleanup") or evidence.get("bronze")) and not evidence.get("raw"):
        raise ValueError("downstream Sector evidence exists without Raw final")
    if evidence.get("bronze") and not evidence.get("cleanup"):
        raise ValueError("Bronze final exists without local cleanup proof")
    for stage in reversed(STAGES):
        if evidence.get(stage, False):
            return STAGES[STAGES.index(stage) + 1] if stage != "bronze" else None
    return "download"


def next_sector_stage(
    published: dict[int, str], evidence: dict[int, dict[str, bool]], *,
    start_sector: int = 14, max_sector: int = 70,
) -> tuple[int, str] | None:
    if not 1 <= start_sector <= max_sector <= 70:
        raise ValueError("Sector range must stay within 1..70")
    for sector in range(start_sector, max_sector + 1):
        if sector not in published:
            return None  # Do not skip an unpublished Sector or infer a later one is safe.
        stage = resume_stage(evidence.get(sector, {}))
        if stage is not None:
            return sector, stage
    return None


def retry_attempt(runs: list[tuple[str, str]], prefix: str) -> int | None:
    """Return a fresh attempt, or None while the matching stage is active."""
    attempts = []
    active = False
    for run_id, state in runs:
        match = re.fullmatch(re.escape(prefix) + r"(\d+)", run_id)
        if not match:
            raise ValueError("unexpected Sector stage run ID")
        attempts.append(int(match.group(1)))
        if state in ("queued", "running"):
            active = True
            continue
        if state == "success":
            raise ValueError("successful Sector stage lacks its final evidence")
        if state != "failed":
            raise ValueError(f"unexpected Sector stage state: {state}")
    attempt = max(attempts, default=-1) + 1
    if attempt > 10000:
        raise ValueError("Sector stage retry limit exceeded")
    return None if active else attempt


def retry_attempt_from_task(ti: object, dag_id: str, prefix: str) -> int | None:
    """Read our contiguous attempt IDs through the Airflow 3 Task SDK."""
    runs = []
    for attempt in range(10002):
        run_id = f"{prefix}{attempt}"
        if not ti.get_dr_count(dag_id=dag_id, run_ids=[run_id]):
            return retry_attempt(runs, prefix)
        runs.append((run_id, ti.get_dagrun_state(dag_id=dag_id, run_id=run_id)))
    raise ValueError("Sector stage retry limit exceeded")

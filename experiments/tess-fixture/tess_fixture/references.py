# -*- coding: utf-8 -*-
"""NASA Exoplanet Archive 에서 표본 별의 확인 행성 참고값을 받아 references.csv 로 저장한다.

TAP 서비스의 `pscomppars`(Planetary Systems Composite Parameters) 테이블을 TIC 별로 조회한다.
결과는 검증 참고값이며 후보 화면에 정답으로 표시하지 않는다(README 규칙과 동일).
"""

from __future__ import annotations

import csv
import io
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .targets import Target

TAP_SYNC = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
COLUMNS = ("tic_id", "hostname", "pl_name", "pl_orbper", "pl_orbpererr1", "pl_tranmid", "pl_trandur",
           "pl_trandep", "pl_rade", "st_rad", "st_teff", "tran_flag", "disc_year", "disc_facility")
USER_AGENT = "ssafy-planetory-fixture/0.1"


def query_tic(tic_id: int, timeout: float = 120.0) -> list[dict[str, str]]:
    adql = (f"select {','.join(COLUMNS)} from pscomppars where tic_id='TIC {tic_id}' order by pl_orbper")
    url = TAP_SYNC + "?" + urllib.parse.urlencode({"query": adql, "format": "csv"})
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def fetch_references(targets: tuple[Target, ...], log=print) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for target in targets:
        result = query_tic(target.tic_id)
        log(f"[archive] {target.name} (TIC {target.tic_id}): {len(result)} planet row(s)")
        for row in result:
            row = {k: (v or "") for k, v in row.items()}
            row.update({"target_key": target.key, "role": target.role, "fetched_at": fetched_at})
            rows.append(row)
        if not result:
            rows.append({**{c: "" for c in COLUMNS}, "tic_id": f"TIC {target.tic_id}", "hostname": target.name,
                         "target_key": target.key, "role": target.role, "fetched_at": fetched_at})
    return rows


def write_references(rows: list[dict[str, str]], path: Path) -> None:
    fieldnames = ["target_key", "role", *COLUMNS, "fetched_at"]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

"""116 원천 export 수집. 운영 snapshot 게시나 기존 참고값 갱신은 하지 않는다."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from uuid import uuid4

from .references import TAP_SYNC, USER_AGENT
from .targets import TARGETS

MAX_BYTES = 32 * 1024 * 1024
VERSION = "external-source-inspection-v1"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_requests(tic_ids=None) -> dict[str, str]:
    """9별 Archive/TOI, S1–13 TCE, ExoFOP TOI export. 조회 범위를 고정한다."""
    ids = [str(t.tic_id) for t in TARGETS] if tic_ids is None else [str(t) for t in tic_ids]
    if not ids or len(set(ids)) != len(ids) or any(not t.isascii() or not t.isdigit() or int(t) <= 0 for t in ids):
        raise ValueError("unique positive TIC IDs required")
    toi = "select tid,toi,tfopwg_disp,pl_orbper,pl_tranmid,pl_trandurh,pl_trandep,rowupdate from toi where tid in (" + ",".join(ids) + ")"
    archive_ids = ",".join("'TIC " + tic + "'" for tic in ids)
    archive = "select tic_id,pl_name,pl_orbper,pl_tranmid,pl_tranmid_systemref,pl_trandur,pl_trandep,tran_flag from pscomppars where tic_id in (" + archive_ids + ")"
    return {
        "nea_toi": TAP_SYNC + "?" + urlencode({"query": toi, "format": "csv"}),
        "nea_pscomppars": TAP_SYNC + "?" + urlencode({"query": archive, "format": "csv"}),
        "mast_tce_s1_s13": "https://archive.stsci.edu/missions/tess/catalogs/tce/tess2018206190142-s0001-s0013_dvr-tcestats.csv",
        "exofop_toi": "https://exofop.ipac.caltech.edu/tess/download_toi.php?sort=toi&output=csv",
    }


def inspect_csv(data: bytes) -> dict:
    """행 값을 출력하지 않고 헤더·행 수만 검사하며 주석은 원본에 보존한다."""
    text = data.decode("utf-8-sig")
    if text.lstrip().startswith("<"):
        raise ValueError("html_or_xml_response")
    lines = text.splitlines(keepends=True)
    # MAST exports can have a metadata preamble; do not discard # inside quoted CSV fields.
    start = 0
    while start < len(lines) and (not lines[start].strip() or lines[start].lstrip().startswith("#")):
        start += 1
    reader = csv.reader(io.StringIO("".join(lines[start:])), strict=True)
    header = next(reader, [])
    if len(header) < 2 or any(not c.strip() for c in header) or len(set(header)) != len(header):
        raise ValueError("invalid_csv_header")
    count = 0
    for row in reader:
        if not row:
            continue
        if len(row) != len(header):
            raise ValueError("inconsistent_csv_width")
        count += 1
    if count == 0:
        raise ValueError("empty_export_requires_review")
    return {"columns": header, "row_count": count, "preamble_lines": start}


def download(url: str) -> tuple[bytes, dict]:
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=120) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("response_size_limit")
        expected = response.headers.get("Content-Length")
        if expected is not None and len(data) != int(expected):
            raise ValueError("incomplete_response")
        return data, {"final_url": response.geturl(), "content_type": response.headers.get("Content-Type")}


def error_details(exc: Exception) -> dict:
    """응답 본문·URL·임의 오류 문자열 없이 전송 실패 원인을 기록한다."""
    result = {"error_type": type(exc).__name__}
    if isinstance(exc, HTTPError):
        result["http_status"] = exc.code
    elif isinstance(exc, URLError):
        reason = exc.reason
        result["reason_type"] = type(reason).__name__
        for key in ("errno", "winerror", "verify_code"):
            value = getattr(reason, key, None)
            if isinstance(value, int):
                result[key] = value
    return result


def collect(root: Path, fetch=download, sources=None, tic_ids=None, sample_config=None) -> Path:
    if tic_ids is not None:
        tic_ids = list(tic_ids)
    requests = source_requests(tic_ids)
    selected = list(requests) if sources is None else list(dict.fromkeys(sources))
    if not selected or any(name not in requests for name in selected):
        raise ValueError("invalid_source_selection")
    run = root / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    run.mkdir(parents=True, exist_ok=False)
    manifest = {
        "version": VERSION, "task": "S15P21C206-109" if tic_ids is not None else "S15P21C206-116", "status": "collecting",
        "scope": "schema inspection only; not an approved operational snapshot",
        "target_tics": [str(t) for t in tic_ids] if tic_ids is not None else [str(t.tic_id) for t in TARGETS], "sources": {},
        "requested_sources": selected, "subset": len(selected) != len(requests),
        "implementation_sha256": sha256(Path(__file__).read_bytes()),
    }
    manifest_path = run / "manifest.json"
    if sample_config is not None:
        manifest["sample_config_sha256"] = sha256(Path(sample_config).read_bytes())

    def save():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save()
    for name in selected:
        url = requests[name]
        item = {"requested_url": url, "attempted_at": datetime.now(timezone.utc).isoformat()}
        try:
            data, metadata = fetch(url)
            # Even malformed responses keep their exact bytes for local investigation.
            path = run / (name + ".raw")
            path.write_bytes(data)
            item.update(metadata)
            item.update({"file": path.name, "sha256": sha256(data), "bytes": len(data),
                         "retrieved_at": datetime.now(timezone.utc).isoformat()})
            item.update(inspect_csv(data))
            item["status"] = "collected_schema_unverified"
        except (OSError, ValueError, UnicodeError, csv.Error) as exc:
            # Do not echo response bodies, third-party messages or personal export fields.
            item.update({"status": "failed", **error_details(exc)})
        manifest["sources"][name] = item
        save()
        print(f"{name}: {item['status']}; rows={item.get('row_count', '-')}", flush=True)
    manifest["status"] = "collected_schema_unverified" if all(
        s["status"] == "collected_schema_unverified" for s in manifest["sources"].values()
    ) else "incomplete"
    save()
    print(f"manifest: {manifest_path.resolve()}")
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("results/external-catalog"))
    parser.add_argument("--source", nargs="+", choices=list(source_requests()))
    parser.add_argument("--sample-config", type=Path, help="109 fixed service sample; default remains 116 nine targets")
    args = parser.parse_args()
    ids = None
    if args.sample_config is not None:
        from .service_sample import load_sample_config
        ids = [m.tic_id for m in load_sample_config(args.sample_config).members]
    path = collect(args.output, sources=args.source, tic_ids=ids, sample_config=args.sample_config)
    return 0 if json.loads(path.read_text(encoding="utf-8"))["status"] != "incomplete" else 1


if __name__ == "__main__":
    raise SystemExit(main())

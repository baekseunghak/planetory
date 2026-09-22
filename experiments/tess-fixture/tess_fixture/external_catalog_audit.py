"""저장된 116 export의 무결성·9 TIC 표본 감사. 다운로드·Git·운영 갱신 없음."""
import argparse
import csv
import io
import json
from collections import Counter
from pathlib import Path

from .external_catalog import inspect_csv, sha256, source_requests
from .targets import TARGETS

# Only astronomical fields are copied; free text and contributor fields are excluded.
FIELDS = {
    "nea_toi": ("tid", "toi", "tfopwg_disp", "pl_orbper", "pl_tranmid", "pl_trandurh", "pl_trandep", "rowupdate"),
    "nea_pscomppars": ("tic_id", "pl_name", "pl_orbper", "pl_tranmid", "pl_tranmid_systemref", "pl_trandur", "pl_trandep", "tran_flag"),
    "mast_tce_s1_s13": ("ticid", "tceid", "tce_plnt_num", "sectors", "tce_period", "tce_time0bt", "tce_time0", "tce_duration", "tce_depth"),
    "exofop_toi": ("TIC ID", "TOI", "Previous CTOI", "TFOPWG Disposition", "Period (days)", "Epoch (BJD)", "Duration (hours)", "Depth (ppm)", "Sectors", "Date TOI Updated (UTC)"),
}


def audit(manifests):
    selected = {}
    target_ids = {str(t.tic_id) for t in TARGETS}
    for path in manifests:
        path = Path(path).resolve()
        body = path.read_bytes()
        manifest = json.loads(body)
        if manifest.get("task") != "S15P21C206-116":
            raise ValueError("unexpected manifest task")
        for name, item in manifest["sources"].items():
            if item["status"] != "collected_schema_unverified":
                continue
            if name not in FIELDS or name in selected:
                raise ValueError("unknown or duplicate successful source")
            raw = (path.parent / item["file"]).resolve()
            if raw.parent != path.parent:
                raise ValueError("source outside run directory")
            data = raw.read_bytes()
            if sha256(data) != item["sha256"] or len(data) != item["bytes"]:
                raise ValueError("source checksum or size mismatch")
            profile = inspect_csv(data)
            if any(profile[k] != item[k] for k in ("columns", "row_count", "preamble_lines")):
                raise ValueError("source profile mismatch")
            fields = FIELDS[name]
            if set(fields) - set(profile["columns"]):
                raise ValueError("required source column missing")
            text = "".join(data.decode("utf-8-sig").splitlines(keepends=True)[profile["preamble_lines"]:])
            rows = []
            for row in csv.DictReader(io.StringIO(text)):
                tic = row[fields[0]].strip().removeprefix("TIC ").lstrip("0")
                if tic in target_ids:
                    rows.append({key: row[key] for key in fields})
            identifiers = Counter((r[fields[0]], r[fields[1]]) for r in rows)
            selected[name] = {
                "source_manifest": str(path), "source_manifest_sha256": sha256(body),
                "source_sha256": item["sha256"], "retrieved_at": item["retrieved_at"],
                "total_rows": profile["row_count"], "selected_rows": len(rows),
                "per_tic": dict(Counter(r[fields[0]] for r in rows)),
                "duplicate_keys": [list(key) for key, count in identifiers.items() if count > 1],
                "rows": rows,
            }
    if set(selected) != set(source_requests()):
        raise ValueError("four successful sources required")
    return {"task": "S15P21C206-116", "status": "source_audit_only", "sources": selected,
            "implementation_sha256": sha256(Path(__file__).read_bytes()),
            "limitation": "No time-scale normalization, candidate matching or snapshot publication approval"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.manifest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({k: {key: v[key] for key in ("total_rows", "selected_rows", "per_tic", "duplicate_keys")}
                      for k, v in result["sources"].items()}, ensure_ascii=False))


if __name__ == "__main__":
    main()

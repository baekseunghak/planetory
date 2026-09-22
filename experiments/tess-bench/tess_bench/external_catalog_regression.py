"""124 saved-export normalization and optional actual candidate catalog join.

No download, BLS, Git commands or database writes. Missing candidate input is
reported explicitly, never replaced with generated permanent IDs.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from astro_kernel.external_catalog import (
    build_snapshot, code_snapshot, join_catalog, normalize_export_row,
)
from tess_fixture.external_catalog_audit import audit
from tess_fixture.targets import TARGETS

ROOT = Path(__file__).resolve().parents[3]


def _entry(path):
    path = Path(path).resolve()
    return dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())


def _write(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def normalize_sources(audited):
    """Retain every selected record; unresolved rows are never silent drops."""
    reports, deliveries = {}, {}
    for name, s in audited["sources"].items():
        records = [normalize_export_row(name, r) for r in s["rows"]]
        held = [dict(tic_id=r["tic_id"], external_id=r["external_id"], reason=r["reason"])
                for r in records if r["status"] != "normalized"]
        source_manifest = json.loads(Path(s["source_manifest"]).read_bytes())
        meta = source_manifest["sources"][name]
        scope = [str(t.tic_id) for t in TARGETS
                 if name != "mast_tce_s1_s13" or all(1 <= s <= 13 for s in t.sectors)]
        deliveries[name] = build_snapshot(source=name,
            scope=scope, rows=[r["row"] for r in records if r["row"]],
            held_rows=held, raw_sha256=s["source_sha256"], retrieved_at=s["retrieved_at"],
            source_uri=meta["requested_url"], source_table=name,
            time_evidence="116:explicit pl_tranmid_systemref BJD-TDB only; other rows retained as held",
            complete=True, validated=not s["duplicate_keys"])
        reports[name] = dict(counts=dict(Counter(r["status"] for r in records)), records=records,
                             duplicate_keys=s["duplicate_keys"])
    return reports, deliveries


def run(manifests, output, candidate_input=None):
    audited = audit(manifests)
    paths = list(map(Path, manifests))
    for source in audited["sources"].values():
        manifest = Path(source["source_manifest"])
        body = json.loads(manifest.read_bytes())
        paths.extend(manifest.parent / s["file"] for s in body["sources"].values() if "file" in s)
    if candidate_input:
        paths.append(Path(candidate_input))
    for folder in (ROOT / "libs/astro-kernel/astro_kernel", ROOT / "experiments/tess-fixture/tess_fixture",
                   ROOT / "experiments/tess-bench/tess_bench"):
        paths.extend(folder / p for p in code_snapshot(folder))
    paths.extend([ROOT / "experiments/tess-bench/uv.lock", ROOT / "experiments/tess-bench/pyproject.toml"])
    inputs = [_entry(p) for p in sorted(set(paths))]
    out = Path(output) / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = dict(task="S15P21C206-124", inputs=inputs, scope="saved exports; no publication or ID allocation",
                candidate_input=str(candidate_input) if candidate_input else None)
    _write(out / "plan.json", plan)
    try:
        reports, deliveries = normalize_sources(audited)
        joined = None
        if candidate_input:
            data = json.loads(Path(candidate_input).read_bytes())
            joined = join_catalog(data["catalog"], deliveries, data["observed_times"],
                required_sources=data["required_sources"], approval=data.get("approval"), previous=data.get("previous"))
        result = dict(task="S15P21C206-124", normalization=reports, deliveries=deliveries, join=joined,
                      validation_scope="caller_supplied_ids_not_independently_verified" if joined else "candidate_input_missing",
                      publishable=False)
        _write(out / "result.json", result)
        if any(_entry(p["path"]) != p for p in inputs):
            raise ValueError("input_changed_during_run")
        _write(out / "manifest.json", dict(task="S15P21C206-124", status="completed", inputs=inputs,
            outputs=[_entry(out / "plan.json"), _entry(out / "result.json")], publishable=False,
            validation_scope=result["validation_scope"]))
    except Exception as exc:
        _write(out / "manifest.json", dict(task="S15P21C206-124", status="failed", error_type=type(exc).__name__))
        raise
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--candidate-input", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "experiments/tess-bench/results/external-catalog-regression")
    args = parser.parse_args()
    print(run(args.manifest, args.output, args.candidate_input))


if __name__ == "__main__":
    main()

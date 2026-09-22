"""116 user-run raw fixture BLS/external comparison; no injection or Git calls."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from uuid import uuid4

import numpy as np
from astro_kernel.iteration import iterate_bls
from astro_kernel.preprocessing import detrend_silver
from tess_fixture.external_catalog import sha256
from tess_fixture.external_catalog_audit import audit, FIELDS
from tess_fixture.lightcurve import load_sector, build_baseline
from tess_fixture.targets import select_targets, iter_products
from tess_fixture.manifest import environment_info

from .external_matching import match_source, normalize_epoch, RULE, VERSION

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "experiments/tess-fixture"
BENCH = ROOT / "experiments/tess-bench"


def convert(source, row):
    tic, identifier = FIELDS[source][:2]
    keys = {
        "nea_toi": ("pl_orbper", "pl_tranmid", "pl_trandurh", "BJD"),
        "nea_pscomppars": ("pl_orbper", "pl_tranmid", "pl_trandur", row.get("pl_tranmid_systemref")),
        "mast_tce_s1_s13": ("tce_period", "tce_time0", "tce_duration", "unverified"),
        "exofop_toi": ("Period (days)", "Epoch (BJD)", "Duration (hours)", "BJD"),
    }[source]
    period, epoch, duration, system = keys
    result = {"tic_id": str(int(row[tic].strip().removeprefix("TIC "))),
              "external_id": row[identifier], "raw": row, "time_system": system}
    try:
        result.update(period_days=float(row[period]), duration_hours=float(row[duration]),
                      epoch_btjd=normalize_epoch(row[epoch], system), time_system="BTJD-TDB")
    except (ValueError, TypeError):
        result["normalization_status"] = "unverified_time_or_missing_ephemeris"
    if source == "nea_pscomppars" and row.get("tran_flag") != "1":
        result["time_system"] = "not_transiting"
    return result


def entry(path):
    return {"path": str(path.resolve()), "sha256": sha256(path.read_bytes())}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def run(manifests, raw, results, targets=None):
    sources = audit(manifests)
    targets = select_targets(targets)
    products = list(iter_products(targets))
    paths = [raw / target.key / filename for target, _, filename, _ in products]
    paths += [Path(p) for p in manifests]
    for item in sources["sources"].values():
        m = Path(item["source_manifest"])
        source_manifest = json.loads(m.read_bytes())
        paths += [m.parent / s["file"] for s in source_manifest["sources"].values() if "file" in s]
    for folder in (BENCH / "tess_bench", FIXTURE / "tess_fixture", ROOT / "libs/astro-kernel/astro_kernel"):
        paths += list(folder.glob("*.py"))
    paths += [BENCH / "uv.lock", BENCH / "pyproject.toml"]
    inputs = [entry(p) for p in sorted(set(paths))]
    out = results / (datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ-") + uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    plan = {"task": "S15P21C206-116", "rule_version": VERSION, "rule": RULE, "inputs": inputs,
            "targets": [t.key for t in targets], "environment": environment_info(("numpy", "astropy", "scipy")),
            "scope": "raw real fixture; no realclean, no injection, no DB candidate IDs or publication",
            "time_policy": "Only explicit BJD-TDB is converted; other external time standards remain unverified"}
    write(out / "plan.json", plan)
    plan_entry = entry(out / "plan.json")
    print(f"Plan fixed: {out / 'plan.json'}", flush=True)
    start = time.perf_counter()
    records = []
    try:
        for target in targets:
            curves = [load_sector(raw / t.key / filename) for t, _, filename, _ in products if t.key == target.key]
            for curve in curves:
                if (curve.meta["TIMESYS"] != "TDB" or curve.meta["TIMEUNIT"] != "d"
                        or curve.meta["BJDREFI"] + curve.meta["BJDREFF"] != 2457000):
                    raise ValueError("unsupported FITS time standard")
            baseline = build_baseline(curves)
            prepared = detrend_silver(baseline.time, baseline.flux, baseline.sector_of_point)
            if prepared.status != "ok":
                raise ValueError("preprocessing failed")
            result = iterate_bls(prepared.time, prepared.flux_det, sector=baseline.sector_of_point,
                                 baseline_time=prepared.time, input_snapshot_id=plan_entry["sha256"],
                                 preprocessing_version=prepared.version)
            internal = [{"candidate_id": f"diagnostic:{target.key}:{c['step']}", "tic_id": str(target.tic_id),
                         "time_system": "BTJD-TDB", **{k: c[k] for k in ("period_days", "epoch_btjd", "duration_hours")}}
                        for c in result["accepted"] if c.get("validated_on_original") is True]
            times = prepared.time[np.isfinite(prepared.flux_det)]
            joins = {}
            for name, source in sources["sources"].items():
                external = [convert(name, r) for r in source["rows"]
                            if r[FIELDS[name][0]].strip().removeprefix("TIC ").lstrip("0") == str(target.tic_id)]
                joins[name] = match_source(internal, external, times)
            record = {"target": target.key, "iteration": result, "matches": joins,
                      "diagnostic_only": True, "observation_points": len(times)}
            write(out / f"{target.key}.json", record)
            counts = dict(Counter(row["status"] for join in joins.values() for row in join["rows"]))
            records.append({"target": target.key, "n_candidates": len(internal), "termination": result["termination"], "statuses": counts})
            print(f"{target.key}: {len(internal)} candidates; {counts}", flush=True)
        for item in inputs + [plan_entry]:
            if entry(Path(item["path"]))["sha256"] != item["sha256"]:
                raise ValueError("input changed during run")
        write(out / "manifest.json", {"task": "S15P21C206-116", "status": "completed", "approved": False,
              "plan": plan_entry, "wall_s": time.perf_counter() - start, "records": records,
              "outputs": [entry(p) for p in sorted(out.glob("*.json"))]})
    except Exception as exc:
        write(out / "manifest.json", {"task": "S15P21C206-116", "status": "failed", "error_type": type(exc).__name__, "plan": plan_entry})
        raise
    print(f"Completed: {out}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest", type=Path, action="append", required=True)
    p.add_argument("--raw", type=Path, default=FIXTURE / "sample_raw")
    p.add_argument("--results", type=Path, default=BENCH / "results/external-catalog-replay")
    p.add_argument("--targets", nargs="+")
    a = p.parse_args()
    run(a.manifest, a.raw, a.results, a.targets)


if __name__ == "__main__":
    main()

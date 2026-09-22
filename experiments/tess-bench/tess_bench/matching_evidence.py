"""128: checksum-verified partial matching evidence from saved 111 outputs.

No BLS execution, FITS loading, Git command, or policy promotion. Epoch and
observed-window overlap are deliberately not inferred from a min/max baseline.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from collections import Counter
from pathlib import Path

from .candidate_identity_audit import APPROVED_CODE


def sha(data):
    return hashlib.sha256(data).hexdigest()


def key(row):
    return tuple(row[k] for k in ("baseline_id", "group_id", "setting_id"))


def audit(manifest_path):
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    if manifest["code"]["git_commit"] != APPROVED_CODE or manifest["code"]["git_dirty"] is not False:
        raise ValueError("expected approved clean 111 source")
    tables, verified = {}, []
    for kind in ("steps", "iterations", "matches"):
        records = [r for r in manifest["outputs"] if r.get("kind") == kind]
        if len(records) != 1:
            raise ValueError(f"expected exactly one {kind} output")
        record = records[0]
        content = Path(record["path"]).read_bytes()
        if sha(content) != record["sha256"]:
            raise ValueError(f"checksum mismatch: {kind}")
        rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig"))))
        if len(rows) != record["rows"]:
            raise ValueError(f"row count mismatch: {kind}")
        tables[kind] = rows
        verified.append({"kind": kind, "sha256": sha(content), "rows": len(rows)})
    accepted = {}
    for row in tables["steps"]:
        if row["status"] == "accepted":
            k = (*key(row), int(row["step"]))
            if k in accepted:
                raise ValueError("duplicate accepted step")
            accepted[k] = row
    curves = {}
    for row in tables["iterations"]:
        k = key(row)
        if k in curves:
            raise ValueError("duplicate curve")
        curves[k] = row
    actual = Counter(k[:3] for k in accepted)
    if not set(actual) <= set(curves):
        raise ValueError("accepted step has no curve")
    for k, row in curves.items():
        if actual[k] != int(row["n_accepted"]):
            raise ValueError("accepted count mismatch")
    measurements = []
    skipped = 0
    for truth in tables["matches"]:
        if key(truth) not in curves:
            raise ValueError("truth row has no curve")
        if truth["match"] not in ("direct", "alias"):
            continue
        # Without per-step original validation details do not promote these
        # curves' accepted-stage rows to a final candidate catalog.
        if int(curves[key(truth)]["n_validation_failed"]):
            skipped += 1
            continue
        k = (*key(truth), int(truth["recovered_step"]))
        if k not in accepted:
            raise ValueError("recovery does not reference an accepted step")
        step = accepted[k]
        p, pc, d, dc = (float(truth["period_days"]), float(step["period_days"]),
                         float(truth["duration_hours"]), float(step["duration_hours"]))
        n = float(step["n_transits"])
        if not all(math.isfinite(x) and x > 0 for x in (p, pc, d, dc, n)) or not n.is_integer():
            raise ValueError("invalid measured period/duration/count")
        # 111 truth recovery is NOT the 128 matching definition. These two
        # conditions alone cannot classify matched/not_matched or ambiguity.
        m = min((1.0, 0.5, 2.0), key=lambda m: abs(p * m - pc))
        half = max(dc / 48, (20 / 1440) / 2)  # rule-0 example: two 10-minute bins
        period_errors = {str(cap): abs(p * m - pc) * min(n, cap) / half
                         for cap in (5, 10, 20, 50)}
        period_errors["uncapped"] = abs(p * m - pc) * n / half
        measurements.append({"baseline_id": truth["baseline_id"], "group_id": truth["group_id"],
            "injection_id": truth["injection_id"], "step": k[-1], "recovery_111": truth["match"],
            "period_multiplier": m, "n_transits_bls": int(n),
            "duration_ratio": d / dc, "duration_pass": 0.5 <= d / dc <= 2,
            "period_error_by_cap": period_errors})
    return {"source_manifest_sha256": sha(raw), "run_id": manifest["run_id"],
        "source_code": manifest["code"]["git_commit"], "outputs_verified": verified,
        "curves": len(curves), "accepted_stage_rows": len(accepted),
        "skipped_recoveries_in_original_validation_failed_curves": skipped,
        "measurements": measurements}


def summarize(runs):
    if len({r["run_id"] for r in runs}) != len(runs):
        raise ValueError("duplicate run")
    rows = [row for run in runs for row in run["measurements"]]
    return {"schema": "planetory.matching-partial-evidence.v1", "status": "diagnostic-not-policy-approval",
        "limitations": ["111 recovery labels are not 128 submission truth labels",
            "BLS n_transits is not Gold observed-window transit count",
            "No epoch, overlap, dominance or user-selection accuracy validation",
            "20-minute minimum window and caps are sensitivity examples, not adopted values",
            "Only saved output hashes are verified; no FITS/input checksum or BLS rerun"],
        "summary": {"curves": sum(r["curves"] for r in runs), "recovered_signals_examined": len(rows),
            "n_transits_histogram": dict(sorted(Counter(r["n_transits_bls"] for r in rows).items())),
            "duration_pass": sum(r["duration_pass"] for r in rows),
            "period_pass_by_cap": {cap: sum(r["period_error_by_cap"][cap] <= 1 for r in rows)
                                   for cap in ("5", "10", "20", "50", "uncapped")}},
        "runs": runs}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = summarize([audit(p) for p in args.manifest])
    result["implementation_sha256"] = sha(Path(__file__).read_bytes())
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()

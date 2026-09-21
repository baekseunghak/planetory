"""112: audit approved 111 candidate pairs; diagnostics, never a merge gate."""
import argparse
import csv
import hashlib
import itertools
import json
from collections import Counter, defaultdict
from pathlib import Path


APPROVED_CODE = "c68c1e21f19e2d9d21c4c76df04d88fbe22e9052"


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def audit(source):
    source = source.resolve()
    checks = json.loads((source / "checksums.json").read_text(encoding="utf-8-sig"))
    verified = set()
    for record in checks:
        path = (source / record["path"]).resolve()
        if not path.is_relative_to(source):
            raise ValueError("checksum path escapes source")
        if hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError(f"checksum mismatch: {record['path']}")
        verified.add(path)
    pairs, totals = [], Counter()
    runs = sorted(source.glob("*/manifest.json"))
    if len(runs) != 8:
        raise ValueError("expected eight approved runs")
    for path in runs:
        required = [path, path.parent / "steps.csv", path.parent / "iterations.csv"]
        if not set(required) <= verified:
            raise ValueError("required run files not covered by checksums")
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
        if manifest["code"]["git_commit"] != APPROVED_CODE or manifest["code"]["git_dirty"]:
            raise ValueError("not the approved clean 111 code")
        iterations = read_csv(path.parent / "iterations.csv")
        totals["curves"] += len(iterations)
        totals["qa_failed_curves"] += sum(int(r["qa_failed_step"]) >= 0 for r in iterations)
        groups = defaultdict(list)
        for row in read_csv(path.parent / "steps.csv"):
            if row["status"] == "accepted":
                groups[(row["baseline_id"], row["group_id"], row["setting_id"])].append(row)
        for curve in iterations:
            key = (curve["baseline_id"], curve["group_id"], curve["setting_id"])
            accepted = groups[key]
            if len(accepted) != int(curve["n_accepted"]):
                raise ValueError("accepted step count mismatch")
            totals["accepted_steps"] += len(accepted)
            totals["original_validation_failed"] += int(curve["n_validation_failed"])
            false_steps = set(filter(None, curve["false_candidate_steps"].split(";")))
            for a, b in itertools.combinations(accepted, 2):
                pa, pb = float(a["period_days"]), float(b["period_days"])
                small, large = sorted((pa, pb))
                # Rational proximity is a diagnostic only: genuine resonant planets
                # can have the same ratio and even matching epochs.
                ratios = [(n / d, n, d) for n in range(1, 10) for d in range(1, n + 1)]
                ratio, numerator, denominator = min(ratios, key=lambda x: (abs(large/small-x[0]), x[1]+x[2]))
                delta = abs(float(a["epoch_btjd"]) - float(b["epoch_btjd"]))
                cyclic = abs((delta + small / 2) % small - small / 2)
                pairs.append(dict(run=path.parent.name, baseline_id=key[0], group_id=key[1],
                    kind=curve["kind"], step_a=int(a["step"]), step_b=int(b["step"]),
                    period_ratio=large/small, nearest_ratio=f"{numerator}/{denominator}",
                    period_ratio_error=abs(large/small-ratio), epoch_distance_hours=cyclic*24,
                    duration_a_hours=float(a["duration_hours"]), duration_b_hours=float(b["duration_hours"]),
                    a_unmatched_in_111=a["step"] in false_steps, b_unmatched_in_111=b["step"] in false_steps))
    return dict(schema="planetory.candidate-identity-audit.v1", source_code=APPROVED_CODE,
                counts=dict(totals), pair_count=len(pairs),
                limitation="Unmatched is not a physical false-positive label; ratios do not prove identity.",
                pairs=pairs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.source)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({k:v for k,v in result.items() if k != "pairs"}, ensure_ascii=False))


if __name__ == "__main__":
    main()

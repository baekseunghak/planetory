"""112 frozen-candidate ratio-set sensitivity; not a rerun of iterative BLS."""
import argparse
import json
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

from tess_fixture import manifest as mf
from .candidate_identity_audit import audit, read_csv
from .iterate import is_duplicate
from .silver_regression import verify_snapshot


SETS = {
    "base": (.5, 1., 2.),
    "integer_3_4": (.25, 1/3, .5, 1., 2., 3., 4.),
    "observed_111": (1/9, 1/8, 1/7, 1/5, .25, 1/3, .4, .5, 2/3, 1., 1.5, 2., 2.5, 3., 4., 5., 7., 8., 9.),
    "rational_to_9": tuple(sorted({float(Fraction(n,d)) for n in range(1,10) for d in range(1,10)})),
}


def run(source, output):
    approved = audit(source)
    entries = [mf.file_entry(p) for p in sorted(source.glob("*/*.csv")) + sorted(source.glob("*/manifest.json"))]
    entries += [mf.file_entry(Path(__file__)), mf.file_entry(Path(__file__).with_name("iterate.py")),
                mf.file_entry(Path(__file__).with_name("candidate_identity_audit.py"))]
    output.mkdir(parents=True,exist_ok=False)
    plan = dict(task="S15P21C206-112",inputs=entries,ratio_sets=SETS,
                limitation="fixed accepted candidate pairs; cannot infer full search recovery or physical false positives")
    (output/"plan.json").write_text(json.dumps(plan,indent=2)+"\n",encoding="utf-8")
    plan_entry=mf.file_entry(output/"plan.json")
    decisions=[]
    for pair in approved["pairs"]:
        rows=read_csv(source/pair["run"]/"steps.csv")
        a,b=[next(r for r in rows if r["baseline_id"]==pair["baseline_id"] and r["group_id"]==pair["group_id"]
                  and r["status"]=="accepted" and int(r["step"])==step) for step in (pair["step_a"],pair["step_b"])]
        candidate=SimpleNamespace(step=int(a["step"]),period_days=float(a["period_days"]),duration_hours=float(a["duration_hours"]))
        flags={name:is_duplicate(float(b["period_days"]),float(b["duration_hours"])/24,int(b["n_transits"]),
                                 [candidate],multipliers)>=0 for name,multipliers in SETS.items()}
        decisions.append(dict(pair=pair,would_block=flags))
    summary={name:dict(pairs=len(decisions),blocked_pairs=sum(r["would_block"][name] for r in decisions),
        blocked_both_matched=sum(r["would_block"][name] and not r["pair"]["a_unmatched_in_111"]
                                 and not r["pair"]["b_unmatched_in_111"] for r in decisions),
        blocked_contains_unmatched=sum(r["would_block"][name] and (r["pair"]["a_unmatched_in_111"]
                                      or r["pair"]["b_unmatched_in_111"]) for r in decisions)) for name in SETS}
    (output/"report.json").write_text(json.dumps(dict(summary=summary,decisions=decisions,rule_approved=False),indent=2)+"\n",encoding="utf-8")
    verify_snapshot(entries+[plan_entry])
    (output/"manifest.json").write_text(json.dumps(dict(plan=plan_entry,outputs=[mf.file_entry(output/"report.json")],completed=True),indent=2)+"\n",encoding="utf-8")
    print(json.dumps(summary,indent=2))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--output",type=Path,required=True)
    args=p.parse_args()
    run(args.source,args.output)


if __name__=="__main__":
    main()

"""116 external join review proposal; no DB publication or candidate mutation."""
import math
from collections import Counter
from copy import deepcopy

import numpy as np
from astro_kernel.candidate_catalog import distance, possible_multipliers

VERSION = "external-match-review-v1"
# Proposals for 116 review, not calibrated or operationally approved thresholds.
RULE = {"identity_tolerance": 0.5, "duration_ratio_max": 2.0,
        "observed_jaccard_min": 0.5, "min_shared_points": 1}


def normalize_epoch(value, system):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("nonfinite_epoch")
    if system == "BJD-TDB":
        return value - 2457000.0
    if system == "BTJD-TDB":
        return value
    raise ValueError("unverified_time_standard")


def _validate(signal):
    if signal.get("time_system") != "BTJD-TDB":
        raise ValueError("unverified_time_standard")
    tic = signal.get("tic_id")
    if not isinstance(tic, str) or not tic.isdigit() or str(int(tic)) != tic or int(tic) <= 0:
        raise ValueError("noncanonical_tic")
    distance(signal, signal, 0.0, 1.0)


def pair_metrics(a, b, times):
    """times are actual finite observation timestamps, never a filled time grid."""
    start, end = float(times[0]), float(times[-1])
    d = distance(a, b, start, end)
    def inside(s):
        p = s["period_days"]
        phase = (times - s["epoch_btjd"] + p / 2) % p - p / 2
        return np.abs(phase) < s["duration_hours"] / 48
    ma, mb = inside(a), inside(b)
    shared, union = int(np.count_nonzero(ma & mb)), int(np.count_nonzero(ma | mb))
    ratio = max(a["duration_hours"], b["duration_hours"]) / min(a["duration_hours"], b["duration_hours"])
    return {"identity_distance": d, "duration_ratio": ratio,
            "shared_points": shared, "union_points": union,
            "observed_jaccard": shared / union if union else None,
            "possible_multipliers": possible_multipliers(a, b, start, end, RULE["identity_tolerance"])}


def match_source(internal, external, observed_times):
    """One TIC/one external source delivery per call; IDs supplied by caller.

    Different catalogs are matched separately, so duplicate reports in NEA and
    ExoFOP are not mistaken for competing physical objects in one source.
    """
    times = np.asarray(observed_times, dtype=float)
    if times.ndim != 1 or len(times) < 2 or not np.all(np.isfinite(times)):
        raise ValueError("finite_observation_times_required")
    times = np.unique(times)
    if len(times) < 2:
        raise ValueError("nonzero_observation_baseline_required")
    ids = [s["candidate_id"] for s in internal]
    refs = [s["external_id"] for s in external]
    if len(ids) != len(set(ids)) or len(refs) != len(set(refs)):
        raise ValueError("duplicate_id_in_source")
    for signal in internal:
        _validate(signal)
    if len({s["tic_id"] for s in internal}) > 1:
        raise ValueError("one_tic_per_call")
    invalid, edges, evidence, aliases = {}, [], [], set()
    for j, b in enumerate(external):
        try:
            _validate(b)
        except (ValueError, TypeError, KeyError, OverflowError):
            invalid[j] = "invalid_external_ephemeris_or_time"
            continue
        for i, a in enumerate(internal):
            if a["tic_id"] != b["tic_id"]:
                continue
            metrics = pair_metrics(a, b, times)
            direct = (metrics["identity_distance"] <= RULE["identity_tolerance"]
                      and metrics["duration_ratio"] <= RULE["duration_ratio_max"]
                      and metrics["shared_points"] >= RULE["min_shared_points"]
                      and metrics["observed_jaccard"] >= RULE["observed_jaccard_min"])
            evidence.append({"candidate_id": ids[i], "external_id": refs[j], **metrics, "direct_edge": direct})
            if direct:
                edges.append((i, j))
            elif metrics["possible_multipliers"]:
                aliases.add(j)
    ni, ne = Counter(i for i, _ in edges), Counter(j for _, j in edges)
    rows, matched = [], set()
    for j, b in enumerate(external):
        choices = [i for i, k in edges if k == j]
        if j in invalid:
            status = "invalid_external"
        elif choices and (ne[j] > 1 or any(ni[i] > 1 for i in choices)):
            status = "ambiguous_match"
        elif choices:
            status = "direct_match"
            matched.add(choices[0])
        elif j in aliases:
            status = "possible_alias"
        else:
            status = "external_only"
        rows.append({"external_id": refs[j], "status": status,
                     "matched_candidate_id": ids[choices[0]] if status == "direct_match" else None,
                     "candidate_options": [ids[i] for i in choices],
                     "reason": invalid.get(j)})
    return {"version": VERSION, "rule": dict(RULE), "approved": False,
            "rows": rows, "evidence": evidence,
            "unlinked_candidate_ids": [ids[i] for i in range(len(ids)) if i not in matched]}


def disposition(raw_labels):
    """Only already-direct-matched TFOPWG labels; raw source values retained."""
    mapping = {"KP": "planet", "CP": "planet", "FP": "not_planet", "FA": "not_planet",
               "PC": None, "APC": None, "": None, None: None}
    labels = list(raw_labels)
    if any(x not in mapping for x in labels):
        return {"planet_truth": None, "answer_class": "analysis", "source_conflict": True}
    meanings = {mapping[x] for x in labels}
    conflict = len(meanings) > 1
    truth = next(iter(meanings)) if len(meanings) == 1 else None
    return {"planet_truth": truth, "answer_class": "graded" if truth else "analysis", "source_conflict": conflict}


def snapshot_proposal(previous, incoming, *, complete, validated):
    """Pure review model only. Caller owns source/scope identity and DB transaction."""
    if complete is not True or validated is not True:
        return {"action": "retain_previous", "current": deepcopy(previous)}
    if previous is not None and any(previous[k] != incoming[k] for k in ("source", "scope")):
        raise ValueError("source_scope_mismatch")
    if not isinstance(incoming.get("sha256"), str) or len(incoming["sha256"]) != 64 or any(
        c not in "0123456789abcdef" for c in incoming["sha256"]
    ):
        raise ValueError("invalid_content_hash")
    if previous is not None and previous["sha256"] == incoming["sha256"]:
        return {"action": "unchanged", "current": deepcopy(previous)}
    return {"action": "review_new_snapshot", "current": deepcopy(previous), "proposed": deepcopy(incoming)}

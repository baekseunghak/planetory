"""Candidate lifecycle proposals using explicit, reviewed direct-identity rules.

No database IDs are generated here. A ready catalog is not a Gold publication:
discoverability and atomic publication remain the downstream publisher's work.
"""
import math
from copy import deepcopy
from collections.abc import Mapping
import json

from .iteration import ITERATION_VERSION
from .transit_model import parse_transit_model


VERSION = "candidate_identity_v3_review"
# Minimum expansion supported as review flags by the frozen 111 pair sweep.
# These are never an instruction to merge or to identify a physical planet.
REVIEW_MULTIPLIERS = (0.25, 1/3, 0.5, 2.0, 3.0, 4.0)


def possible_multipliers(a, b, start, end, tolerance):
    """Conservative symmetric review flag, not evidence of a common signal."""
    distance(a, a, start, end)
    distance(b, b, start, end)
    _tolerance(tolerance)
    pa, pb = a["period_days"], b["period_days"]
    limit = tolerance * min(a["duration_hours"], b["duration_hours"]) / 24
    def drift(p, q):
        return abs(p-q) * math.ceil((end-start)/min(p, q))
    return [m for m in REVIEW_MULTIPLIERS
            if min(drift(pa, pb/m), drift(pb, pa*m)) <= limit]


def distance(a, b, start, end):
    """Conservative epoch displacement plus accumulated period drift in durations.

    One fixed cycle offset is used over the entire interval; alias periods are
    deliberately not divided before assigning an existing identity.
    """
    for value in (start, end, *[c[k] for c in (a, b) for k in ("period_days", "epoch_btjd", "duration_hours")]):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("finite numeric ephemeris and interval required")
    pa, pb = a["period_days"], b["period_days"]
    ea, eb = a["epoch_btjd"], b["epoch_btjd"]
    da, db = a["duration_hours"] / 24, b["duration_hours"] / 24
    duration = min(da, db)
    if not all(math.isfinite(x) for x in (pa, pb, ea, eb, da, db, start, end)):
        raise ValueError("finite ephemeris and interval required")
    if min(pa, pb, da, db) <= 0 or da >= pa or db >= pb or end <= start:
        raise ValueError("invalid ephemeris or interval")
    # Anchor both ephemerides near the common interval midpoint. Integer epoch
    # re-labelling cannot change the astronomical signal.
    mid = (start + end) / 2
    def anchored(p, e, other_p, other_e):
        ca = e + math.floor((mid-e)/p + 0.5) * p
        cb = other_e + math.floor((ca-other_e)/other_p + 0.5) * other_p
        cycles = math.ceil(max(abs(start-ca), abs(end-ca)) / min(p, other_p))
        return (abs(ca-cb) + cycles*abs(p-other_p)) / duration
    # A one-sided anchor could change acceptance when the two bundles swap.
    return max(anchored(pa, ea, pb, eb), anchored(pb, eb, pa, ea))


def reconcile(old, new, start, end, *, tolerance, new_complete):
    """Unique direct pair only. Ambiguity blocks publication, never greedy ties.

    Added indices require the eventual DB allocator; do not hash floating point
    parameters into candidate IDs. Incomplete upstream runs must not call this.
    """
    _tolerance(tolerance)
    if new_complete is not True:
        return dict(version=VERSION,status="incomplete",publishable=False,
                    matches=[],added=[],retired=[])
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise ValueError("finite ascending interval required")
    for c in [*old, *new]:
        distance(c,c,start,end)
    ids = [c["candidate_id"] for c in old]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate old candidate ID")
    edges = [(i,j) for i,a in enumerate(old) for j,b in enumerate(new)
             if distance(a,b,start,end) <= tolerance]
    ambiguous = any(sum(x==i for x,_ in edges)>1 for i in range(len(old)))
    ambiguous |= any(sum(y==j for _,y in edges)>1 for j in range(len(new)))
    if ambiguous:
        return dict(version=VERSION, status="ambiguous", publishable=False,
                    matches=[], added=[], retired=[])
    matched_old, matched_new = {i for i,_ in edges}, {j for _,j in edges}
    # An unresolved harmonic relation must not retire the old identity.
    # This only flags review; ratio alone is insufficient evidence to merge.
    for i,a in enumerate(old):
        for j,b in enumerate(new):
            if i in matched_old and j in matched_new:
                continue
            # Alias epochs may pick different members of the event train.
            if possible_multipliers(a,b,start,end,tolerance):
                return dict(version=VERSION,status="possible_alias",publishable=False,
                            matches=[],added=[],retired=[])
    return dict(version=VERSION, status="resolved", publishable=True,
                matches=[dict(candidate_id=ids[i],new_index=j) for i,j in edges],
                added=[j for j in range(len(new)) if j not in matched_new],
                retired=[ids[i] for i in range(len(old)) if i not in matched_old])


def review_candidates(candidates, start, end, *, tolerance, complete):
    """Preserve raw peaks and pair evidence before any lifecycle decision.

    A representative orders the review display only: it neither establishes a
    physical period nor collapses different peaks. No transitive clustering of
    pairwise near matches is performed. IDs must be stable source peak IDs,
    never DB candidate IDs inferred from list position.
    """
    _tolerance(tolerance)
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise ValueError("finite ascending interval required")
    peaks = [dict(c) for c in candidates]
    ids = [c["peak_id"] for c in peaks]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("unique nonempty source peak IDs required")
    for c in peaks:
        distance(c, c, start, end)
    pairs = []
    ordered = sorted(peaks, key=lambda c: c["peak_id"])
    for i, a in enumerate(ordered):
        for b in ordered[i+1:]:
            direct = distance(a, b, start, end)
            ratios = possible_multipliers(a, b, start, end, tolerance)
            if direct <= tolerance or ratios:
                pairs.append(dict(peak_a=a["peak_id"], peak_b=b["peak_id"],
                                  relation="direct_overlap" if direct <= tolerance else "possible_alias",
                                  direct_distance=direct, possible_multipliers=ratios,
                                  confirmed_alias=False))
    # Finite original revalidation evidence first; this is not a new gate.
    def score(c):
        value = c.get("original_snr")
        return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None
    eligible = [c for c in peaks if c.get("validated_on_original") is True and score(c) is not None]
    eligible.sort(key=lambda c: (-score(c), c["peak_id"]))
    tied = bool(len(eligible) > 1 and score(eligible[0]) == score(eligible[1]))
    validated = all(c.get("validated_on_original") is True for c in peaks)
    status = "incomplete" if complete is not True or not validated else "review_required" if pairs else "clear"
    return dict(version=VERSION, status=status, raw_peaks=peaks, pair_evidence=pairs,
                review_order=[c["peak_id"] for c in eligible],
                display_representative=eligible[0]["peak_id"] if eligible else None,
                representative_tie=tied, physical_representative_confirmed=False,
                automatic_merge=False)


def group_exact_models(candidates, start, end, *, complete):
    """Pre-ID raw model copies only. Never consolidate existing DB identities.

    No tolerance is applied to depth, duration or period. Epochs may differ by
    exact integer cycles. Nearby estimates and sampled-window coincidences
    remain separate. Pairwise equality is required against every group member.
    """
    if any("candidate_id" in c for c in candidates):
        raise ValueError("group raw peaks before ID allocation; existing IDs require reconciliation")
    review=review_candidates(candidates,start,end,tolerance=.5,complete=complete)
    if review["status"]=="incomplete":
        return dict(version=VERSION,status="incomplete",groups=[],raw_peaks=review["raw_peaks"])
    groups=[]
    for c in sorted(candidates,key=lambda c:c["peak_id"]):
        if not isinstance(c.get("depth_ppm"),(int,float)) or not math.isfinite(c["depth_ppm"]) or not 0<c["depth_ppm"]<1e6:
            raise ValueError("finite positive model depth below unity required")
        equal=lambda b: all(c[k]==b[k] for k in ("period_days","duration_hours","depth_ppm")) and distance(c,b,start,end)==0
        matching=[g for g in groups if all(equal(b) for b in g)]
        if len(matching)>1:
            return dict(version=VERSION,status="ambiguous",groups=[],raw_peaks=review["raw_peaks"])
        if matching: matching[0].append(dict(c))
        else: groups.append([dict(c)])
    return dict(version=VERSION,status="grouped",raw_peaks=review["raw_peaks"],
                groups=[dict(representative=g[0],duplicates=g[1:],relation="exact_model_copy",
                             physical_period_confirmed=False) for g in groups])



def _tolerance(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 1:
        raise ValueError("tolerance must be a finite number in (0,1]")


def _bigint(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{name} must be a positive bigint")
    if isinstance(value, str) and (not value.isascii() or not value.isdigit()):
        raise ValueError(f"{name} must be a positive bigint")
    result = int(value)
    if not 0 < result <= 2**63-1:
        raise ValueError(f"{name} must be a positive bigint")
    return result


def _nonempty(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a nonempty string")
    return value


def _validate_candidate(candidate, start, end, *, new):
    if not isinstance(candidate, dict):
        raise ValueError("candidate must be a dictionary")
    distance(candidate, candidate, start, end)
    params = {key: candidate[key] for key in ("period_days", "epoch_btjd", "duration_hours", "depth_ppm")}
    parsed = parse_transit_model(dict(shape="box", parameters=params))
    if "transit_model" in candidate:
        stored = parse_transit_model(candidate["transit_model"])
        if stored.to_dict()["parameters"] != parsed.to_dict()["parameters"]:
            raise ValueError("candidate parameters disagree with transit_model")
        if not new and stored.candidate_id is not None and stored.candidate_id != f"c-{_bigint(candidate['candidate_id'], 'candidate_id')}":
            raise ValueError("transit_model candidate ID disagrees with row")
        if new and stored.candidate_id is not None:
            raise ValueError("new raw models must not have catalog IDs")
    if new:
        for key in ("bls_power", "sde", "snr"):
            value = candidate.get(key)
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError(f"finite {key} required")
        if "candidate_id" in candidate:
            raise ValueError("new raw peaks must not have candidate IDs")
        _nonempty(candidate.get("peak_id"), "peak_id")
        if type(candidate.get("step")) is not int or candidate["step"] < 0:
            raise ValueError("nonnegative integer removal step required")
    else:
        _bigint(candidate.get("candidate_id"), "candidate_id")
        if "updated_bundle_id" in candidate:
            _bigint(candidate["updated_bundle_id"], "updated_bundle_id")
        if candidate.get("status") not in ("active", "retired"):
            raise ValueError("previous candidate status must be active or retired")
    return parsed


def build_candidate_catalog(iteration_result, previous_bundle=None, *, tic_id, bundle_id,
                            identity_tolerance=.5, new_candidate_ids=None, identity_approval=None):
    """Build a copy-only catalog proposal and explicit lifecycle actions.

    new_candidate_ids maps stable source peak IDs to IDs allocated externally.
    identity_approval is a recorded review reference, not an inferred approval.
    Withheld/incomplete runs have no lifecycle actions. No result declares Gold
    publishable or derives discoverable/reopen state from numerical identity.
    """
    tic = _bigint(tic_id, "tic_id")
    bundle_id = _bigint(bundle_id, "bundle_id")
    _tolerance(identity_tolerance)
    if identity_approval is not None:
        _nonempty(identity_approval, "identity_approval")
    if not isinstance(iteration_result, Mapping):
        raise ValueError("iteration result must be a mapping")
    if iteration_result.get("iteration_version") != ITERATION_VERSION:
        raise ValueError("supported iteration version required")
    complete = iteration_result.get("complete")
    if type(complete) is not bool:
        raise ValueError("explicit iteration completeness required")
    for field in ("input_snapshot_id", "preprocessing_version", "iteration_config_sha256"):
        _nonempty(iteration_result.get(field), field)
    termination = iteration_result.get("termination")
    if complete and iteration_result.get("qa_failed_step", -1) != -1:
        raise ValueError("complete iteration must not contain a failed QA step")
    if complete and (termination not in ("no_quality_peak", "duplicate_or_harmonic_only") or iteration_result.get("status") != "ok"):
        raise ValueError("inconsistent iteration completion metadata")
    peaks = deepcopy(iteration_result.get("accepted"))
    if not isinstance(peaks, list):
        raise ValueError("accepted candidate list required")
    start, end = iteration_result.get("time_start_btjd"), iteration_result.get("time_end_btjd")
    # Empty or too-short failed inputs have no usable comparison interval.
    interval_valid = (type(start) in (int, float) and type(end) in (int, float)
                      and math.isfinite(start) and math.isfinite(end) and start < end)
    if not interval_valid and (complete or peaks):
        raise ValueError("finite ascending candidate interval required")
    previous = deepcopy(previous_bundle)
    old, aliases = [], []
    if previous is not None:
        if not isinstance(previous, Mapping) or previous.get("complete") is not True:
            raise ValueError("previous bundle must be explicitly complete")
        if _bigint(previous.get("tic_id"), "previous tic_id") != tic:
            raise ValueError("previous bundle belongs to another TIC")
        if _bigint(previous.get("bundle_id"), "previous bundle_id") == bundle_id:
            raise ValueError("new and previous bundle IDs must differ")
        ps, pe = previous.get("time_start_btjd"), previous.get("time_end_btjd")
        if not all(type(v) in (int, float) and math.isfinite(v) for v in (ps, pe)) or ps >= pe:
            raise ValueError("previous bundle interval required")
        old = previous.get("candidates")
        aliases = previous.get("candidate_aliases", [])
        if not isinstance(old, list) or not isinstance(aliases, list):
            raise ValueError("previous candidates and aliases must be lists")
        for candidate in old:
            _validate_candidate(candidate, ps, pe, new=False)
        old_ids = [_bigint(c["candidate_id"], "candidate_id") for c in old]
        if len(set(old_ids)) != len(old_ids):
            raise ValueError("duplicate previous candidate IDs")
        for alias in aliases:
            if not isinstance(alias, dict) or _bigint(alias.get("candidate_id"), "alias candidate_id") not in old_ids:
                raise ValueError("previous alias references an unknown candidate ID")
        if interval_valid:
            start, end = min(start, ps), max(end, pe)
    for candidate in [*old, *peaks]:
        if "tic_id" in candidate and _bigint(candidate["tic_id"], "candidate tic_id") != tic:
            raise ValueError("candidate belongs to another TIC")
    for candidate in peaks:
        _validate_candidate(candidate, start, end, new=True)
    json.dumps(dict(raw_peaks=peaks, previous_candidates=old, candidate_aliases=aliases), allow_nan=False)
    peak_ids = [c["peak_id"] for c in peaks]
    if len(set(peak_ids)) != len(peak_ids):
        raise ValueError("duplicate source peak IDs")
    allocation = {} if new_candidate_ids is None else new_candidate_ids
    if not isinstance(allocation, Mapping):
        raise ValueError("new_candidate_ids must be a mapping")
    allocations = {_nonempty(key, "allocation peak_id"): _bigint(value, "allocated candidate_id")
                   for key, value in allocation.items()}
    if len(set(allocations.values())) != len(allocations):
        raise ValueError("duplicate allocated candidate IDs")
    if set(allocations.values()) & {_bigint(c["candidate_id"], "candidate_id") for c in old}:
        raise ValueError("allocated IDs collide with existing active or retired identities")
    result = dict(status="held", catalog_ready=False, publishable=False,
        tic_id=tic, bundle_id=bundle_id, complete=complete,
        time_start_btjd=iteration_result.get("time_start_btjd"),
        time_end_btjd=iteration_result.get("time_end_btjd"),
        identity_version=VERSION, identity_tolerance=identity_tolerance,
        identity_approval=identity_approval, reasons=[], raw_peaks=peaks,
        pair_evidence=[], exact_model_groups=[], candidates=deepcopy(old),
        candidate_aliases=deepcopy(aliases), needed_new_peak_ids=[],
        identity_proposal=None, proposed_candidates=[], lifecycle_actions=[],
        downstream_required=["discoverability", "atomic_gold_publication"],
        iteration_summary={key: deepcopy(iteration_result.get(key)) for key in
            ("termination", "iteration_version", "iteration_config_sha256", "input_snapshot_id",
             "preprocessing_version", "bls_config_version", "candidate_quality_version", "qa_failed_step")})
    if not complete:
        result["reasons"] = ["incomplete_iteration"]
        return result
    valid = all(c.get("validated_on_original") is True and
                type(c.get("original_snr")) in (int, float) and math.isfinite(c["original_snr"])
                and c["original_snr"] >= 7 for c in peaks)
    if not valid:
        result["reasons"] = ["original_validation_failed"]
        return result
    grouped = group_exact_models(peaks, start, end, complete=True)
    result["exact_model_groups"] = grouped["groups"]
    representatives = [group["representative"] for group in grouped["groups"]]
    review = review_candidates(representatives, start, end, tolerance=identity_tolerance, complete=True)
    result["pair_evidence"] = review["pair_evidence"]
    if grouped["status"] != "grouped" or review["status"] != "clear":
        result["reasons"] = ["within_bundle_identity_ambiguous"]
        return result
    active = [dict(c, candidate_id=_bigint(c["candidate_id"], "candidate_id")) for c in old if c["status"] == "active"]
    retired = [c for c in old if c["status"] == "retired"]
    # Retired identity resurrection requires a separate reviewed policy.
    for previous_candidate in retired:
        for candidate in representatives:
            if (distance(previous_candidate, candidate, start, end) <= identity_tolerance or
                    possible_multipliers(previous_candidate, candidate, start, end, identity_tolerance)):
                result["reasons"] = ["retired_identity_review_required"]
                return result
    proposal = reconcile(active, representatives, start, end,
                         tolerance=identity_tolerance, new_complete=True)
    if not proposal["publishable"]:
        result["reasons"] = [proposal["status"]]
        return result
    needed = [representatives[index]["peak_id"] for index in proposal["added"]]
    if set(allocations) - set(needed):
        raise ValueError("allocated peak IDs must correspond only to new representatives")
    result["needed_new_peak_ids"] = sorted(set(needed) - set(allocations))
    result["identity_proposal"] = dict(
        matches=[dict(candidate_id=match["candidate_id"], peak_id=representatives[match["new_index"]]["peak_id"]) for match in proposal["matches"]],
        added_peak_ids=needed, retired_candidate_ids=proposal["retired"])
    if not representatives:
        result["reasons"] = ["no_candidates_publication_held"]
        return result
    if result["needed_new_peak_ids"]:
        result["reasons"].append("candidate_ids_required")
    if identity_approval is None:
        result["reasons"].append("identity_approval_required")
    if result["needed_new_peak_ids"]:
        return result
    assigned = {match["new_index"]: match["candidate_id"] for match in proposal["matches"]}
    assigned.update({index: allocations[representatives[index]["peak_id"]] for index in proposal["added"]})
    proposed = deepcopy(retired)
    for candidate in active:
        if candidate["candidate_id"] in proposal["retired"]:
            proposed.append(dict(candidate, status="retired", updated_bundle_id=bundle_id))
    for index, candidate in enumerate(representatives):
        cid = assigned[index]
        model = parse_transit_model(dict(shape="box", baseline={"kind":"unity"},
            residual_model_version="box-divide-v0", candidate_id=f"c-{cid}",
            parameters={key: candidate[key] for key in ("period_days","epoch_btjd","duration_hours","depth_ppm")})).to_dict()
        # Build from this run, not an old row: discoverability must be recomputed.
        record = {key: deepcopy(value) for key, value in candidate.items()
                  if key not in ("transit_model", "discoverable", "is_discoverable", "reopened", "reopen")}
        record.update(candidate_id=cid, status="active", tic_id=tic, updated_bundle_id=bundle_id, removal_step=candidate["step"], transit_model=model)
        proposed.append(record)
    result["proposed_candidates"] = sorted(proposed, key=lambda c: _bigint(c["candidate_id"], "candidate_id"))
    if not result["reasons"]:
        result.update(status="ready", catalog_ready=True, candidates=deepcopy(result["proposed_candidates"]))
        result["lifecycle_actions"] = ([dict(action="keep", **match) for match in result["identity_proposal"]["matches"]]
            + [dict(action="add", peak_id=key, candidate_id=allocations[key]) for key in needed]
            + [dict(action="retire", candidate_id=cid) for cid in proposal["retired"]])
    json.dumps(result, allow_nan=False)
    return result

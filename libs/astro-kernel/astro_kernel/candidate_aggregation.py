"""79 run-level aggregation of 125 staging proposals; no I/O, IDs or publication.

One row per active candidate carries its 124 external lineage and AI policy
state. Holds, source delivery failures and no-signal stars are counted per TIC
and never promoted. A run is complete only when every target reached a
terminal state; a retryable source failure or an unprocessed TIC keeps it open.
"""
from copy import deepcopy

from .external_catalog import content_hash
from .gold_serialization import (REQUIRED_VERSIONS, GoldValidationError, assemble,
                                 identifier, require, text)

VERSION = "candidate-aggregation-79-v1"
SCHEMA_VERSION = "planetory.publication-candidates.v1"
STATUSES = ("ready", "no_signal", "held", "request_failed", "rejected", "unprocessed")
RUN_LEVEL = {"calculation_versions", "ai_policy"}
# 123 candidate_quality is a content revision over each star's own models and
# removal history, so it is taken per star from discovery, never run-wide.
PER_STAR_VERSIONS = {"candidate_quality"}
# The only accepted AI state (126 hand-off). These strings feed bundle_version:
# changing them republishes every star, so they change only with a new decision.
AI_NOT_EXECUTED = "none/policy-hold-118"
AI_POLICY = dict(status="policy_not_executed", model_version=AI_NOT_EXECUTED,
                 threshold_version=AI_NOT_EXECUTED,
                 decision_reference="docs/requirements/planetory-decision-register.md#126-범위-변경과-ai-출시-유예")
# 122 holds a star without representatives; 125 rejects an empty active set.
NO_SIGNAL = {"no_candidates_publication_held", "empty_catalog_upstream_policy_required"}
# Non-dict inputs raise AttributeError; malformed input is a rejection, never a crash.
MALFORMED = (ValueError, TypeError, KeyError, AttributeError)
ROW_FIELDS = ("removal_step", "period_days", "epoch_btjd", "duration_hours", "depth_ppm",
              "bls_power", "discoverable", "transit_model")


def aggregate(*, run_id, silver_attempt, targets, results, calculation_versions, ai_policy):
    """Return the run's candidate table, staging proposals and manifest.

    targets is the fixed TIC scope. results holds one {tic_id, inputs} per
    processed TIC, where inputs are that star's assemble arguments without the
    run-level calculation_versions and ai_policy. calculation_versions carries
    every rule version except the per-star candidate_quality. publishable is always false:
    the publish gate (80) and Publisher still own approval and the DB write.
    This is combine() over evaluate() for every target, in one process.
    """
    try:
        tics = _scope(run_id, silver_attempt, targets, calculation_versions, ai_policy)
        scope, inputs = set(tics), {}
        for r in results:
            tic = identifier(r["tic_id"])
            require(tic in scope, "result_outside_targets")
            require(tic not in inputs, "duplicate_tic_result")
            require(not RUN_LEVEL & r["inputs"].keys(), "run_level_input_overridden")
            inputs[tic] = r["inputs"]
        stars = [evaluate(tic_id=tic, inputs=inputs.get(tic), calculation_versions=calculation_versions,
                          ai_policy=ai_policy) for tic in tics]
    except MALFORMED as exc:
        return dict(_rejected(exc), bundles=[])
    out = combine(run_id=run_id, silver_attempt=silver_attempt, targets=targets, stars=stars,
                  calculation_versions=calculation_versions, ai_policy=ai_policy)
    out["bundles"] = [s["payload"] for s in stars if s["payload"] is not None] if out["manifest"] else []
    return out


def evaluate(*, tic_id, inputs, calculation_versions, ai_policy):
    """One target's share of the run: status, reasons, 125 payload, manifest entry, rows.

    Callers with many stars (80 on Spark) run this where each star's inputs live,
    keep the heavy payload there and hand combine() only the light fields.
    inputs None means the target was not processed. Run-level versions and policy
    are validated again by combine(), so a bad value still rejects the run.
    """
    tic = identifier(tic_id)
    # Overriding run-level values is a caller bug; a non-dict input is the star's own rejection.
    require(not isinstance(inputs, dict) or not RUN_LEVEL & inputs.keys(), "run_level_input_overridden")
    status, reasons, payload, rows = _star(tic, inputs, calculation_versions, ai_policy)
    return dict(tic_id=tic, status=status, reasons=reasons, payload=payload,
                bundle=None if payload is None else _bundle_entry(payload), candidates=rows or [])


def combine(*, run_id, silver_attempt, targets, stars, calculation_versions, ai_policy):
    """Fold evaluate() results into the run manifest and candidate table.

    stars need tic_id, status, reasons, bundle and candidates; payload may be
    dropped. A target without a star is unprocessed. Order does not matter.
    """
    try:
        return _combine(run_id, silver_attempt, targets, stars, calculation_versions, ai_policy)
    except MALFORMED as exc:
        return _rejected(exc)


def _rejected(exc):
    return dict(status="rejected", publishable=False, aggregator_version=VERSION,
                reason=str(exc) if isinstance(exc, GoldValidationError) else "malformed_input",
                manifest=None, candidates=[])


def _scope(run_id, silver_attempt, targets, versions, policy):
    """Validate run-level inputs; return the targets in output order."""
    text(run_id)
    text(silver_attempt)
    require(not PER_STAR_VERSIONS & versions.keys(), "per_star_version_in_run")
    require(versions.keys() == REQUIRED_VERSIONS - PER_STAR_VERSIONS, "invalid_calculation_versions")
    require(policy == AI_POLICY, "unsupported_ai_policy")
    require(versions["ai_model"] == versions["ai_threshold"] == AI_NOT_EXECUTED, "ai_version_mismatch")
    tics = [identifier(t) for t in targets]
    require(bool(tics) and len(tics) == len(set(tics)), "invalid_targets")
    return sorted(tics)


def _combine(run_id, silver_attempt, targets, stars, versions, policy):
    tics = _scope(run_id, silver_attempt, targets, versions, policy)
    scope, by_tic = set(tics), {}
    for s in stars:
        tic = identifier(s["tic_id"])
        require(tic in scope, "result_outside_targets")
        require(tic not in by_tic, "duplicate_tic_result")
        # Stars cross a process boundary on Spark; a ready star must carry its bundle.
        require(s["status"] in STATUSES and (s["status"] == "ready") == (s["bundle"] is not None),
                "invalid_star_result")
        by_tic[tic] = s
    entries, bundles, rows = [], [], []
    for tic in tics:
        s = by_tic.get(tic) or dict(status="unprocessed", reasons=[], bundle=None, candidates=[])
        entries.append(dict(tic_id=tic, status=s["status"], reasons=s["reasons"]))
        if s["bundle"] is not None:
            bundles.append(deepcopy(s["bundle"]))
            rows += s["candidates"]
    require(len({r["candidate_id"] for r in rows}) == len(rows), "duplicate_candidate_id")
    require(len({b["bundle_id"] for b in bundles}) == len(bundles), "duplicate_bundle_id")
    counts = {s: sum(e["status"] == s for e in entries) for s in STATUSES}
    complete = counts["unprocessed"] == counts["request_failed"] == 0
    manifest = dict(schema_version=SCHEMA_VERSION, aggregator_version=VERSION, run_id=run_id,
        silver_attempt=silver_attempt, complete=complete, target_tic_count=len(tics),
        counts=counts, stars=entries, calculation_versions=deepcopy(versions), ai_policy=deepcopy(policy),
        bundles=bundles,
        # Pre-publication upper bound only: tutorial exclusion and publish QA come later.
        discoverable_ready_tic_count=len({r["tic_id"] for r in rows if r["discoverable"]}),
        candidate_count=len(rows), candidates_sha256=content_hash(rows))
    return dict(status="complete" if complete else "incomplete", publishable=False,
                aggregator_version=VERSION, manifest=manifest, candidates=rows)


def _bundle_entry(payload):
    b = payload["bundle"]
    return dict(tic_id=b["tic_id"], bundle_id=b["id"], bundle_version=b["bundle_version"],
                active_candidates=sum(c["status"] == "active" for c in payload["candidates"]),
                retired_candidates=sum(c["status"] == "retired" for c in payload["candidates"]),
                record_checksums=deepcopy(b["manifest"]["record_checksums"]))


def _star(tic, inputs, versions, policy):
    """Classify one TIC before 125 so hold reasons survive; then assemble it."""
    if inputs is None:
        return "unprocessed", [], None, None
    try:
        cat = inputs["catalog"]
        require(cat["tic_id"] == tic, "result_tic_mismatch")
        if cat.get("catalog_ready") is not True:
            raw = list(cat.get("reasons") or ["not_ready"])
            reasons = ["catalog:" + r for r in raw]
            if NO_SIGNAL & set(raw):
                return _no_signal(inputs, reasons)
            return "held", reasons, None, None
        disc = inputs["discovery"]
        if disc.get("status") != "ready":
            return "held", ["discoverability:" + r for r in disc.get("reasons") or ["not_ready"]], None, None
        if inputs["segmented"]["quarantined"] or not inputs["segmented"]["segments"]:
            return "held", ["segments_not_ready"], None, None
        ext = inputs["external"]
        if ext.get("status") != "ready":
            reasons = list(ext.get("reasons") or ["not_ready"])
            # 124 holds a whole delivery when collection was incomplete/unvalidated or
            # the delivered rows failed validation. Either way no valid snapshot exists,
            # so this is a source failure to fix and retry, never evidence of absence.
            failed = any(r.endswith(":source_held") for r in reasons)
            return ("request_failed" if failed else "held"), ["external:" + r for r in reasons], None, None
        star_versions = dict(versions, candidate_quality=disc["candidate_quality_revision"])
        result = assemble(**inputs, calculation_versions=star_versions, ai_policy=policy)
        if result["status"] != "validated":
            if result["reason"] in NO_SIGNAL:
                return _no_signal(inputs, [result["reason"]])
            return "rejected", [result["reason"]], None, None
        return "ready", [], result["payload"], _rows(result["payload"], ext, policy)
    except MALFORMED as exc:
        return "rejected", [str(exc) if isinstance(exc, GoldValidationError) else "malformed_input"], None, None


def _no_signal(inputs, reasons):
    """A star whose previous bundle had active candidates and now has none is a
    regression to review with its current kept, not a no-signal star. 122 returns
    the previous candidates on hold; 125 receives them as previous_bundle."""
    previous = [*inputs["catalog"].get("candidates", []),
                *(inputs.get("previous_bundle") or {}).get("candidates", [])]
    if any(c["status"] == "active" for c in previous):
        return "held", ["catalog:previous_candidates_vanished"], None, None
    return "no_signal", reasons, None, None


def _rows(payload, ext, policy):
    bundle, snapshots = payload["bundle"], ext["snapshots"]
    require(isinstance(snapshots, dict) and bool(snapshots), "missing_external_lineage")
    dispositions = {r["candidate_id"]: r for r in payload["candidate_dispositions"]}
    rows = []
    for c in payload["candidates"]:
        if c["status"] != "active":
            continue
        d = dispositions[c["id"]]
        refs = d["source_refs"]
        matched = {}
        for ref in refs["refs"]:
            # 124 allows one direct match per source; a second one is a duplicate join.
            require(ref["source"] in snapshots and ref["source"] not in matched, "duplicate_external_match")
            require(ref["snapshot_id"] == snapshots[ref["source"]]["snapshot_id"], "external_lineage_mismatch")
            matched[ref["source"]] = ref
        absent = {a["source"] for a in refs["absence_evidence"] or [] if a["reason"] == "unmatched"}
        require(absent == snapshots.keys() - matched.keys(), "external_lineage_mismatch")
        sources = []
        for source in sorted(snapshots):
            s, ref = snapshots[source], matched.get(source, {})
            sources.append(dict(source=source, snapshot_id=s["snapshot_id"], snapshot_sha256=s["sha256"],
                                retrieved_at=s["retrieved_at"],
                                match="direct_match" if ref else "unmatched",
                                external_id=ref.get("external_id"),
                                source_row_updated_at=ref.get("source_row_updated_at"),
                                raw_disposition=ref.get("raw_disposition")))
        rows.append(dict(tic_id=bundle["tic_id"], bundle_id=bundle["id"],
            bundle_version=bundle["bundle_version"], candidate_id=c["id"],
            **{k: deepcopy(c[k]) for k in ROW_FIELDS},
            external=dict(state="missing" if refs["decision_reason"] == "no_label" else "labeled",
                          disposition=d["disposition"], answer_class=d["answer_class"],
                          planet_truth=d["planet_truth"], is_confirmed=c["is_confirmed"],
                          rule_version=d["rule_version"], matching_rule_version=ext["matching_rule_version"],
                          decision_reason=refs["decision_reason"], sources=sources),
            ai=dict(status=policy["status"], score=None, model_version=policy["model_version"],
                    threshold_version=policy["threshold_version"],
                    decision_reference=policy["decision_reference"])))
    require(len(rows) == len(dispositions), "candidate_row_count_mismatch")
    return rows

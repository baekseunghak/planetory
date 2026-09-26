"""125 pre-publication projection of 122/123/124 proposals; no DB writes.

Physical IDs are supplied by the caller. Passing IDs does not prove allocation.
This validation adapter deliberately does not promote held upstream results.
"""
from copy import deepcopy
import math
import re

from astro_kernel.transit_model import parse_transit_model

from .gold_canonical import (CHECKSUM_VERSION, RECORD_CHECKSUM_VERSION,
                        array_checksum, bundle_version, normalize_array, record_checksum)


def null_runs(values):
    runs = []
    for i, v in enumerate(values):
        if v is None:
            if runs and runs[-1][1] == i - 1:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    return runs


VERSION = "gold-serialization-125-v1"
REQUIRED_VERSIONS = {"preprocessing", "bls_config", "residual_model",
                     "periodogram_config", "candidate_quality", "ai_model",
                     "ai_threshold", "external_matching"}


class GoldValidationError(ValueError):
    """Deterministic rejection, not a transient Publisher error."""


def require(condition, code):
    if not condition:
        raise GoldValidationError(code)


def identifier(value):
    require(type(value) is int and 0 < value < 2**63, "invalid_bigint")
    return value


def number(value, *, positive=False):
    require(type(value) in (int, float) and math.isfinite(value), "invalid_number")
    require(not positive or value > 0, "nonpositive_number")
    return float(value)


def text(value):
    require(isinstance(value, str) and bool(value.strip()), "missing_version_or_reference")
    return value


def assemble(*, catalog, segmented, discovery, external, periodogram,
             segment_ids, input_snapshot_ids, calculation_versions,
             fold_reference_time_btjd, base_days, ai_policy, fine_tune, previous_bundle=None):
    """Return a validated staging proposal. Approval/publication remains external.

    periodogram is the original (unremoved) provided-resolution 123 result,
    with candidate_id=None, periods and power. It is not a Silver search grid.
    ai_policy requires an explicit policy decision reference and both version
    strings; no default operational strings or internal AI scores are invented.
    """
    try:
        payload = _assemble(catalog, segmented, discovery, external, periodogram,
                            segment_ids, input_snapshot_ids, calculation_versions,
                            fold_reference_time_btjd, base_days, ai_policy, fine_tune, previous_bundle)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        return dict(status="rejected", decision="PUBLISH_REJECTED", publishable=False,
                    payload=None, reason=str(exc) if isinstance(exc, GoldValidationError)
                    else "malformed_input", serializer_version=VERSION)
    return dict(status="validated", publishable=False, payload=payload,
                serializer_version=VERSION, pending=["database_roundtrip", "publisher_transaction"])


def _assemble(cat, segmented, disc, ext, pg, allocated, snapshots, versions,
              fold, baseline, policy, fine_tune, previous):
    require(cat.get("catalog_ready") is True and cat.get("complete") is True
            and not cat.get("reasons"), "catalog_not_ready")
    require(disc.get("status") == "ready" and disc.get("discoverability_ready") is True
            and not disc.get("reasons"), "discoverability_not_ready")
    require(ext.get("status") == "ready" and not ext.get("reasons"), "external_not_ready")
    require(not segmented["quarantined"] and bool(segmented["segments"]), "segments_not_ready")
    tic, bid = identifier(cat["tic_id"]), identifier(cat["bundle_id"])
    require(disc["tic_id"] == tic and disc["bundle_id"] == bid
            and str(ext["tic_id"]) == str(tic) and ext["bundle_id"] == bid, "bundle_identity_mismatch")
    require(policy["status"] == "policy_not_executed", "unsupported_ai_policy")
    text(policy["decision_reference"])
    require(REQUIRED_VERSIONS <= versions.keys(), "missing_calculation_versions")
    for value in versions.values():
        text(value)
    require(versions["ai_model"] == text(policy["model_version"])
            and versions["ai_threshold"] == text(policy["threshold_version"]), "ai_version_mismatch")
    require(versions["candidate_quality"] == disc["candidate_quality_revision"], "quality_version_mismatch")
    require(versions["external_matching"] == ext["matching_rule_version"], "external_version_mismatch")
    require(type(fine_tune["half_width_cells"]) is int and fine_tune["half_width_cells"] >= 3,
            "invalid_fine_tune")
    require(isinstance(snapshots, list) and bool(snapshots)
            and all(isinstance(v, str) and re.fullmatch(r"[^\r\n]+:sha256:[0-9a-f]{64}(?::[^\r\n]+)?", v) for v in snapshots)
            and len(snapshots) == len(set(snapshots)), "invalid_input_snapshots")
    checksums, segments, used = {}, [], set()
    for raw in sorted(segmented["segments"], key=lambda s: s["sector"]):
        require(raw["tic_id"] == tic, "segment_tic_mismatch")
        sector = identifier(raw["sector"])
        require(sector not in used, "duplicate_sector")
        used.add(sector)
        sid = identifier(allocated[str(sector)])
        require(type(raw["n_points"]) is int and 0 < raw["n_points"] <= 20000,
                "invalid_segment_length")
        require(raw["bin_minutes"] == 10, "unsupported_bin_minutes")
        flux = normalize_array(raw["flux"])
        require(len(flux) == raw["n_points"] and any(v is not None for v in flux), "invalid_flux_length")
        require(raw["gaps"] == null_runs(flux), "gaps_mismatch")
        scatter = number(raw["flux_scatter"])
        require(scatter >= 0, "negative_scatter")
        segment = dict(id=sid, tic_id=tic, sector=sector,
                       binning_revision=text(raw["binning_revision"]),
                       start_btjd=number(raw["start_btjd"]), bin_minutes=10,
                       n_points=len(flux), flux=flux, flux_scatter=scatter, gaps=deepcopy(raw["gaps"]))
        segments.append(segment)
        checksums[f"segment:{sid}:flux"] = array_checksum(flux)
    require(set(allocated) == {str(s) for s in used}, "segment_allocation_mismatch")
    require(len({s["id"] for s in segments}) == len(segments), "duplicate_segment_id")

    original = {identifier(c["candidate_id"]): c for c in cat["candidates"]}
    proposed = {identifier(c["candidate_id"]): c for c in disc["proposed_candidates"]}
    require(len(original) == len(cat["candidates"]) and len(proposed) == len(disc["proposed_candidates"])
            and original.keys() == proposed.keys(), "candidate_set_mismatch")
    require(all(c["status"] in ("active", "retired") for c in proposed.values()), "invalid_candidate_status")
    old = {}
    if previous is not None:
        require(previous.get("complete") is True and previous["tic_id"] == tic
                and identifier(previous["bundle_id"]) != bid, "invalid_previous_bundle")
        old = {identifier(c["candidate_id"]): c for c in previous["candidates"]}
        require(len(old) == len(previous["candidates"]), "duplicate_previous_id")
    require(old.keys() <= proposed.keys(), "previous_candidate_dropped")
    active = {cid: c for cid, c in proposed.items() if c["status"] == "active"}
    retired = {cid: c for cid, c in proposed.items() if c["status"] == "retired"}
    require(retired.keys() <= old.keys(), "retired_previous_required")
    require(all(old[cid]["status"] != "retired" for cid in active if cid in old), "retired_reactivation_forbidden")
    dispositions = {identifier(r["candidate_id"]): r for r in ext["rows"]}
    require(len(dispositions) == len(ext["rows"]) and dispositions.keys() == active.keys(),
            "disposition_set_mismatch")
    candidates, rows = [], []
    for cid, c in sorted(active.items()):
        require(c["tic_id"] == tic and c["updated_bundle_id"] == bid, "candidate_identity_mismatch")
        model = parse_transit_model(c["transit_model"]).to_dict()
        require(model == original[cid]["transit_model"] and model["candidate_id"] == f"c-{cid}",
                "candidate_model_changed")
        require(model["residual_model_version"] == versions["residual_model"], "model_version_mismatch")
        require(all(number(c[k]) == v for k, v in model["parameters"].items()), "candidate_model_mismatch")
        require(type(c["discoverable"]) is bool, "missing_discoverable")
        require(type(c["removal_step"]) is int and c["removal_step"] >= 0, "invalid_removal_step")
        r = dispositions[cid]
        require(r["representative_model"] == {k: c[k] for k in ("period_days", "epoch_btjd", "duration_hours")},
                "external_model_changed")
        require(r["disposition"] in ("confirmed", "fp", "pc", "none"), "invalid_disposition")
        truth = {"confirmed": "planet", "fp": "not_planet"}.get(r["disposition"])
        require(r["planet_truth"] == truth and r["answer_class"] == ("graded" if truth else "analysis")
                and r["is_confirmed"] is (r["disposition"] == "confirmed"), "inconsistent_disposition")
        require(isinstance(r["source_refs"], dict) and bool(r["source_refs"]), "missing_source_refs")
        rows.append({k: deepcopy(r[k]) for k in ("candidate_id", "disposition", "answer_class",
                                               "planet_truth", "rule_version", "source_refs")})
        text(r["rule_version"])
        candidates.append(dict(id=cid, tic_id=tic, updated_bundle_id=bid, status="active",
            removal_step=c["removal_step"], **model["parameters"], bls_power=number(c["bls_power"]),
            transit_model=model, discoverable=c["discoverable"], is_confirmed=r["is_confirmed"]))
    require(bool(candidates), "empty_catalog_upstream_policy_required")
    require(len({c["removal_step"] for c in candidates}) == len(candidates), "duplicate_removal_step")
    pmax = max(40., 1.15 * max(c["period_days"] for c in candidates))
    for cid, c in sorted(retired.items()):
        before = old[cid]
        require(c["tic_id"] == tic and before["tic_id"] == tic, "retired_tic_mismatch")
        preserve = ("period_days", "epoch_btjd", "duration_hours", "depth_ppm", "bls_power",
                    "transit_model", "discoverable", "removal_step")
        require(all(c[k] == before[k] for k in preserve), "retired_value_changed")
        require(type(before["is_confirmed"]) is bool and type(c["discoverable"]) is bool,
                "retired_labels_required")
        model = parse_transit_model(c["transit_model"]).to_dict()
        require(model["candidate_id"] == f"c-{cid}" and model == original[cid]["transit_model"],
                "retired_model_mismatch")
        require(identifier(c["updated_bundle_id"]) in (bid, before["updated_bundle_id"]),
                "retired_bundle_mismatch")
        candidates.append(dict(id=cid, tic_id=tic, status="retired", updated_bundle_id=c["updated_bundle_id"],
                               is_confirmed=before["is_confirmed"], **{k: deepcopy(c[k]) for k in preserve}))
    candidates.sort(key=lambda c: c["id"])
    aliases = deepcopy(cat.get("candidate_aliases", []))
    old_aliases = [] if previous is None else previous.get("candidate_aliases", [])
    def alias_key(a):
        require(identifier(a["candidate_id"]) in proposed, "alias_candidate_missing")
        return (a["candidate_id"], number(a["multiplier"], positive=True),
                number(a["alias_period_days"], positive=True))
    require(sorted(map(alias_key, aliases)) == sorted(map(alias_key, old_aliases)), "alias_change_requires_upstream_rule")
    require(len(set(map(alias_key, aliases))) == len(aliases), "duplicate_alias")
    aliases = [{k: a[k] for k in ("candidate_id", "multiplier", "alias_period_days")} for a in aliases]
    for action in cat.get("lifecycle_actions", []):
        cid = identifier(action["candidate_id"])
        require(cid in proposed and action["action"] in ("add", "keep", "retire"), "invalid_lifecycle_action")
        require((action["action"] == "add" and cid not in old) or
                (action["action"] in ("keep", "retire") and cid in old), "lifecycle_previous_required")
        require(proposed[cid]["status"] == ("retired" if action["action"] == "retire" else "active"),
                "lifecycle_status_mismatch")
    history = deepcopy(disc.get("changes", [])) + deepcopy(ext.get("history", []))
    for h in history:
        require(identifier(h["candidate_id"]) in active and h["bundle_id"] == bid,
                "history_identity_mismatch")
        require(h["field"] in ("discoverable", "disposition", "planet_truth"), "history_field_invalid")
        require(h["old_value"] != h["new_value"], "history_without_change")
        text(h["reason"])
        text(h["rule_version"])
        cid = h["candidate_id"]
        value = (str(active[cid]["discoverable"]).lower() if h["field"] == "discoverable"
                 else dispositions[cid][h["field"]])
        require(value == h["new_value"], "history_value_mismatch")
        if cid in old:
            if h["field"] == "discoverable":
                expected_old = str(old[cid]["discoverable"]).lower()
            else:
                prior_dispositions = {r["candidate_id"]: r for r in previous["candidate_dispositions"]}
                expected_old = prior_dispositions[cid][h["field"]]
            require(h["old_value"] == expected_old, "history_previous_mismatch")
        else:
            require(h["old_value"] is None, "new_candidate_history_has_previous")
    require(pg["candidate_id"] is None, "residual_periodogram_forbidden")
    import numpy as np
    periods = np.asarray(pg["periods"], dtype=float)
    require(periods.shape == (5000,) and np.array_equal(periods, np.geomspace(.5, pmax, 5000)),
            "provided_grid_mismatch")
    power = normalize_array(pg["power"], allow_null=False)
    require(len(power) == 5000, "power_length_mismatch")
    checksums[f"periodogram:{bid}:power"] = array_checksum(power)
    semantic = dict(input_snapshot_ids=sorted(snapshots), segments=segments, calculation_versions=versions)
    refs = []
    for r in ext["external_references"]:
        require(r["tic_id"] == tic and (r["candidate_id"] is None or r["candidate_id"] in proposed),
                "external_reference_identity_mismatch")
        # Match the actual external_signal_references columns, not diagnostics.
        ref = {k: deepcopy(r[k]) for k in ("candidate_id", "tic_id", "source", "external_id",
                                           "disposition", "period_days", "epoch_btjd", "fetched_on")}
        candidate = proposed.get(r["candidate_id"])
        ref["candidate_key"] = ({k: candidate[k] for k in ("period_days", "epoch_btjd")}
                                if candidate else None)
        refs.append(ref)
    manifest = dict(segment_ids=[s["id"] for s in segments], array_checksums=checksums,
        checksum_version=CHECKSUM_VERSION, record_checksum_version=RECORD_CHECKSUM_VERSION,
        residual_model_version=versions["residual_model"], periodogram_config_version=versions["periodogram_config"],
        binning=dict(bin_minutes=10, rule="mean; empty bin NULL; over 20000 rejected"),
        period_grid=dict(period_min_days=.5, period_max_days=pmax, n_periods=5000, spacing="log"),
        fine_tune=deepcopy(fine_tune), curve_steps=dict(rule="one_candidate_per_step", order="removal_step"),
        input_snapshot_ids=sorted(snapshots), calculation_versions=deepcopy(versions), excluded_sectors=[],
        record_checksums=dict(candidates=record_checksum("candidates", candidates),
            ai_results=record_checksum("ai_results", []), external_statuses=record_checksum("external_statuses", refs)),
        qa=dict(serializer=VERSION, storage_validation="pending"), ai_policy=deepcopy(policy))
    return dict(bundle=dict(id=bid, tic_id=tic, bundle_version=bundle_version(semantic),
                            fold_reference_time_btjd=number(fold), base_days=number(baseline, positive=True),
                            manifest=manifest), segments=segments, candidates=candidates,
                candidate_dispositions=rows, external_statuses=refs, ai_results=[],
                candidate_aliases=aliases, history_proposals=history,
                lifecycle_actions=deepcopy(cat.get("lifecycle_actions", [])),
                retain_disposition_candidate_ids=sorted(retired),
                periodogram=dict(bundle_id=bid, period_min_days=.5, period_max_days=pmax,
                                 n_periods=5000, power=power))

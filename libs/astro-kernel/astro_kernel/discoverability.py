"""123 provided-resolution evaluation. Proposals only; no DB or experiment imports."""
from copy import deepcopy
import hashlib
import json

import numpy as np

from .bls import BlsError, bls_periodogram, period_grid
from .segmentation import BIN_MINUTES, MAX_POINTS
from .transit_model import parse_transit_model, phase_distance_days, remove_transit_models


RULE = dict(version="discoverability-1.0.0", bin_minutes=10.0,
            grid=dict(min_days=0.5, max_rule="max(40,1.15*candidate_max)", count=5000, spacing="log"),
            durations_hours=[1.2, 1.92, 2.88, 4.8], snr_min=7.0, sde_min=6.0,
            min_observed_transits=2, match_half_width_cells=3,
            epoch_tolerance="half_max_duration", harmonic_matching=False,
            peaks="strict_interior_maxima", noise="global_mad", objective="likelihood", oversample=10)
NUMERICAL_VERSION = "provided-bls-1.0.0"


def _digest(material):
    return hashlib.sha256(json.dumps(material, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def validate_rule(rule, half_width_cells):
    # This implementation supports exactly one scientific rule. Changing a
    # descriptive key cannot silently leave the calculation unchanged.
    if rule != RULE or _digest(rule) != _digest(RULE):
        raise ValueError("unsupported discoverability rule; new rules require a versioned implementation")
    if type(half_width_cells) is not int or half_width_cells < rule["match_half_width_cells"]:
        raise ValueError("match_half_width_cells must not exceed manifest fine_tune.half_width_cells")


def classify(pg, time, flux, model, rule):
    """Quality-peak presence, not independent signal count or UI top-N."""
    power = pg.power
    maxima = np.flatnonzero((power[1:-1] > power[:-2]) & (power[1:-1] > power[2:])) + 1
    peaks = []
    for i in maxima:
        if not (np.isfinite([pg.snr[i], pg.sde[i]]).all()
                and pg.snr[i] >= rule["snr_min"] and pg.sde[i] >= rule["sde_min"]):
            continue
        good = np.isfinite(flux) & (np.abs(phase_distance_days(time, pg.periods[i], pg.epoch_btjd[i]))
                                  < pg.duration_hours[i] / 48)
        ntr = len(np.unique(np.rint((time[good] - pg.epoch_btjd[i]) / pg.periods[i]).astype(np.int64)))
        if ntr >= rule["min_observed_transits"]:
            peaks.append(dict(grid_index=int(i), period_days=float(pg.periods[i]),
                              epoch_btjd=float(pg.epoch_btjd[i]), duration_hours=float(pg.duration_hours[i]),
                              snr=float(pg.snr[i]), sde=float(pg.sde[i]), n_transits=ntr))
    result = dict(status="measured", qualified_peaks=peaks, discoverable=None,
                  reason="quality_peak_present" if peaks else "no_quality_peak")
    if model is None:
        return result
    p = model["parameters"]
    if not pg.periods[0] <= p["period_days"] <= pg.periods[-1]:
        return dict(result, discoverable=False, reason="outside_provided_grid")
    cell = np.log(pg.periods[-1] / pg.periods[0]) / (len(pg.periods) - 1)
    matched = [peak["grid_index"] for peak in peaks
               if abs(np.log(peak["period_days"] / p["period_days"]) / cell) <= rule["match_half_width_cells"]
               and abs(float(phase_distance_days([peak["epoch_btjd"]], p["period_days"], p["epoch_btjd"])[0]))
               <= max(peak["duration_hours"], p["duration_hours"]) / 48]
    return dict(result, discoverable=bool(matched), matched_grid_indices=matched,
                reason="matched_peak" if matched else "no_matching_quality_peak")


def evaluate(time, flux, previous_models, model, periods, rule=RULE):
    """Programming/configuration errors propagate; only measurement failures become null."""
    validate_rule(rule, rule["match_half_width_cells"])
    t = np.asarray(time, dtype=float)
    residual = remove_transit_models(t, flux, previous_models).flux_residual
    try:
        pg = bls_periodogram(t, residual, periods, durations_hours=rule["durations_hours"],
                             config_version=rule["version"])
    except BlsError as exc:
        if exc.code not in ("insufficient_observations", "degenerate_flux", "numerical_failure"):
            raise
        return dict(status="input_insufficient" if exc.code == "insufficient_observations" else "calculation_failed",
                    reason=exc.code, discoverable=None, qualified_peaks=[]), residual, None
    return classify(pg, t, residual, model, rule), residual, pg


def provided_arrays(segments):
    """Return explicit per-bin indices into the sorted array, including overlapping Sectors."""
    times, fluxes, records = [], [], []
    cursor = 0
    for segment in sorted(segments, key=lambda s: s["sector"]):
        if type(segment["sector"]) is not int or segment["sector"] <= 0:
            raise ValueError("positive integer Sector required")
        n = segment["n_points"]
        if type(n) is not int or not 0 < n <= MAX_POINTS or segment["bin_minutes"] != BIN_MINUTES:
            raise ValueError("invalid provided segment grid")
        f = np.asarray(segment["flux"], dtype=float)
        if f.shape != (n,) or np.isinf(f).any() or not np.isfinite(segment["start_btjd"]):
            raise ValueError("invalid provided segment values")
        empty = np.flatnonzero(np.isnan(f))
        gaps = [[int(g[0]), int(g[-1])] for g in
                np.split(empty, np.flatnonzero(np.diff(empty) > 1) + 1) if len(g)]
        if segment["gaps"] != gaps:
            raise ValueError("gaps must exactly represent null bins")
        t = segment["start_btjd"] + (np.arange(n) + 0.5) * BIN_MINUTES / 1440
        times.append(t)
        fluxes.append(f)
        records.append(dict(sector=segment["sector"], gaps=deepcopy(segment["gaps"]),
                            index_space="sector_local_bins", concatenated_offset=cursor, n_points=n))
        cursor += n
    if not records or len({r["sector"] for r in records}) != len(records):
        raise ValueError("one nonempty segment per Sector required")
    t, f = np.concatenate(times), np.concatenate(fluxes)
    order = np.argsort(t, kind="stable")
    inverse = np.empty_like(order)
    inverse[order] = np.arange(len(order))
    for record in records:
        start = record["concatenated_offset"]
        record["sorted_indices"] = inverse[start:start + record["n_points"]].tolist()
    return t[order], f[order], records


def _id(value):
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError("positive BIGINT candidate/bundle/TIC ID required")
    return value


def prepare_discoverability(segmented, catalog, *, fine_tune, candidate_quality_version,
                            rule_approval=None, previous_bundle=None, rule=None):
    """Evaluate 122 proposals, never partially publish or allocate candidate IDs.

    previous_bundle is the existing public candidate snapshot, distinct from
    catalog['candidates'] (which already contains the NEW proposal on ready).
    Periodograms/residual arrays are runtime artifacts, not DB rows.
    """
    rule = deepcopy(RULE if rule is None else rule)
    validate_rule(rule, fine_tune.get("half_width_cells"))
    if not isinstance(candidate_quality_version, str) or not candidate_quality_version.strip():
        raise ValueError("upstream candidate_quality version required")
    if rule_approval is not None and (not isinstance(rule_approval, str) or not rule_approval.strip()):
        raise ValueError("explicit approval reference required")
    tic, bundle = _id(catalog["tic_id"]), _id(catalog["bundle_id"])
    old = []
    if previous_bundle is not None:
        if (_id(previous_bundle["tic_id"]) != tic or _id(previous_bundle["bundle_id"]) == bundle
                or previous_bundle.get("complete") is not True):
            raise ValueError("previous public bundle must be complete, same TIC, different ID")
        old = deepcopy(previous_bundle["candidates"])
        for c in old:
            _id(c["candidate_id"])
            if type(c.get("discoverable")) is not bool or c.get("status") not in ("active", "retired"):
                raise ValueError("previous candidates require boolean discoverable and lifecycle status")
        if len({_id(c["candidate_id"]) for c in old}) != len(old):
            raise ValueError("duplicate previous IDs")
    elif any(a["action"] in ("keep", "retire") for a in catalog.get("lifecycle_actions", [])):
        raise ValueError("previous public snapshot required for existing identities")
    result = dict(status="held", discoverability_ready=False, publishable=False,
                  tic_id=tic, bundle_id=bundle, candidates=deepcopy(old), proposed_candidates=[],
                  evaluations=[], changes=[], reasons=[], rule=rule, rule_approval=rule_approval,
                  candidate_quality_revision=None, periodograms=[],
                  downstream_required=["external_confirmation", "gold_validation", "atomic_publication", "member_reopening"])
    if catalog.get("catalog_ready") is not True or catalog.get("complete") is not True:
        result["reasons"] = ["catalog_not_ready"]
        return result
    if segmented["quarantined"] or not segmented["segments"]:
        result["reasons"] = ["segment_quarantined"]
        return result
    proposals = deepcopy(catalog["proposed_candidates"])
    ids = [_id(c["candidate_id"]) for c in proposals]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate proposed IDs")
    active = sorted((c for c in proposals if c["status"] == "active"), key=lambda c: c["removal_step"])
    if not active:
        result["reasons"] = ["no_candidates_publication_held"]
        return result
    for c in proposals:
        if c.get("status") not in ("active", "retired"):
            raise ValueError("invalid candidate status")
        if c["status"] == "retired" and type(c.get("discoverable")) is not bool:
            raise ValueError("retired candidates require boolean discoverable")
        model = parse_transit_model(c["transit_model"]).to_dict()
        if model["candidate_id"] != f"c-{c['candidate_id']}":
            raise ValueError("candidate model ID mismatch")
    if any(type(c["removal_step"]) is not int or c["removal_step"] < 0 for c in active):
        raise ValueError("nonnegative integer removal steps required")
    if len({c["removal_step"] for c in active}) != len(active):
        raise ValueError("duplicate removal steps")
    if any(c.get("validated_on_original") is not True for c in active):
        result["reasons"] = ["original_validation_failed"]
        return result
    raw_peaks = sorted(catalog["raw_peaks"], key=lambda c: c["step"])
    if any(type(c["step"]) is not int or c["step"] < 0 for c in raw_peaks):
        raise ValueError("raw removal steps must be nonnegative integers")
    for c in raw_peaks:
        parse_transit_model(c["transit_model"])
    if len({c["step"] for c in raw_peaks}) != len(raw_peaks):
        raise ValueError("duplicate raw removal steps")
    for c in active:
        source = [r for r in raw_peaks if r["peak_id"] == c["peak_id"] and r["step"] == c["removal_step"]]
        if len(source) != 1 or source[0]["transit_model"]["parameters"] != c["transit_model"]["parameters"]:
            raise ValueError("catalog candidate does not match original removal history")
    if any(s["tic_id"] != tic for s in segmented["segments"]):
        raise ValueError("segment TIC mismatch")
    t, f, index_map = provided_arrays(segmented["segments"])
    pmax = max([40.0] + [1.15 * c["transit_model"]["parameters"]["period_days"] for c in active])
    periods = period_grid(rule["grid"]["min_days"], pmax, rule["grid"]["count"], spacing=rule["grid"]["spacing"])
    material = dict(rule=rule, numerical_version=NUMERICAL_VERSION,
                    upstream_candidate_quality=candidate_quality_version, fine_tune=deepcopy(fine_tune),
                    segments=sorted(segmented["segments"], key=lambda s: s["sector"]),
                    models=[dict(candidate_id=c["candidate_id"], removal_step=c["removal_step"],
                                 transit_model=c["transit_model"]) for c in active],
                    removal_history=[dict(step=c["step"], transit_model=c["transit_model"]) for c in raw_peaks],
                    period_max_days=pmax)
    revision = "candidate-quality-v1-" + _digest(material)
    result.update(candidate_quality_revision=revision, segment_index_map=index_map,
                  period_max_days=pmax)
    for candidate in [None, *active]:
        model = candidate["transit_model"] if candidate else None
        # Identity grouping may omit a raw peak. Reconstruct discovery-stage
        # residuals from ALL earlier 122 removals, not only catalog representatives.
        previous_peaks = [r for r in raw_peaks if candidate and r["step"] < candidate["removal_step"]]
        previous_models = [r["transit_model"] for r in previous_peaks]
        verdict, residual, pg = evaluate(t, f, previous_models, model, periods, rule)
        result["evaluations"].append(dict(candidate_id=candidate["candidate_id"] if candidate else None,
                                          removed_peak_ids=[r["peak_id"] for r in previous_peaks], **verdict))
        result["periodograms"].append(dict(candidate_id=candidate["candidate_id"] if candidate else None,
                                          time=t, flux=residual, periodogram=pg))
        if candidate:
            candidate["discoverable"] = verdict["discoverable"]
        if verdict["status"] != "measured":
            result["reasons"].append(verdict["reason"])
    if not rule_approval:
        result["reasons"].append("discoverability_approval_required")
    # No proposal, history action, or partial current replacement on any failure.
    if result["reasons"]:
        return result
    old_by_id = {c["candidate_id"]: c for c in old}
    for c in active:
        before = old_by_id.get(c["candidate_id"])
        if before and before["status"] == "active" and before["discoverable"] != c["discoverable"]:
            if previous_bundle.get("candidate_quality_revision") == revision:
                raise ValueError("same candidate_quality revision has different decisions")
            result["changes"].append(dict(candidate_id=c["candidate_id"], bundle_id=bundle,
                                          field="discoverable", old_value=str(before["discoverable"]).lower(),
                                          new_value=str(c["discoverable"]).lower(), rule_version=revision,
                                          reason="provided_resolution_reevaluation"))
    result.update(status="ready", discoverability_ready=True,
                  candidates=deepcopy(proposals), proposed_candidates=proposals)
    return result

"""124 external snapshot/join proposals. No network, database or publication I/O.

Inputs are normalized astronomical rows, never arbitrary export dictionaries.
Source adapters must supply explicit time-scale and completeness evidence.
"""
from collections import Counter
from copy import deepcopy
from datetime import datetime
import hashlib
import json
from pathlib import Path

import numpy as np

from .candidate_catalog import distance, possible_multipliers

VERSION = "external-catalog-v1"
MATCH_VERSION = "external-match-review-v1"
DISPOSITION_VERSION = "external-disposition-review-v2"
RULE = {"identity_tolerance": 0.5, "duration_ratio_max": 2.0,
        "observed_jaccard_min": 0.5, "min_shared_points": 1}
LABELS = {"KP": "confirmed", "CP": "confirmed", "FP": "fp", "FA": "fp",
          "PC": "pc", "APC": "pc"}
ROW_FIELDS = {"tic_id", "external_id", "period_days", "epoch_btjd",
              "duration_hours", "time_system", "raw_disposition", "source_row_updated_at"}
# 2026-09-27 (S15P21C206-79): a column label need not spell TDB when official
# documents fix the scale. The TOI epoch is BTJD (BJD - 2457000) per the TOI
# release notes and catalog paper, TESS BTJD is TDB per the SPOC data products
# description, and TCE statistics come from DV XML epochs in BTJD. PSCompPars
# still needs an explicit per-row BJD-TDB; its bare "BJD" rows stay held.
TIME_RULE_VERSION = "external-time-evidence-v1"
_TESS_TDB = ("https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/"
             "active-missions/tess/_documents/EXP-TESS-ARC-ICD-TM-0014-Rev-F.pdf")
_TOI = ("https://tess.mit.edu/toi-releases/toi-release-notes/ https://arxiv.org/abs/2103.12538 "
        + _TESS_TDB)
TIME_EVIDENCE = {
    "nea_toi": f"{TIME_RULE_VERSION}: TOI epoch BTJD-TDB; NEA TOI copies ExoFOP TOI "
               f"(https://exoplanetarchive.ipac.caltech.edu/docs/TESSMission.html) {_TOI}",
    "exofop_toi": f"{TIME_RULE_VERSION}: TOI epoch BTJD-TDB {_TOI}",
    "mast_tce_s1_s13": f"{TIME_RULE_VERSION}: tce_time0bt from DV XML transitEpochBtjd, BTJD-TDB "
                       f"(https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_tce.html) {_TESS_TDB}",
    "nea_pscomppars": f"{TIME_RULE_VERSION}: explicit per-row pl_tranmid_systemref BJD-TDB only",
}


def normalize_export_row(source, raw):
    """116 field mapping. A scale is accepted only by TIME_RULE_VERSION evidence.

    An excluded non-transiting record is diagnostic, not evidence that a
    catalog is empty. The adapter must retain it in its normalization report.
    """
    systemref = raw.get("pl_tranmid_systemref")
    # (tic, id, period, epoch, duration, label, source's own time label, accepted scale)
    layouts = {
        "nea_toi": ("tid", "toi", "pl_orbper", "pl_tranmid", "pl_trandurh", "tfopwg_disp", "BJD", "BJD-TDB"),
        "nea_pscomppars": ("tic_id", "pl_name", "pl_orbper", "pl_tranmid", "pl_trandur", None, systemref, systemref),
        "mast_tce_s1_s13": ("ticid", "tceid", "tce_period", "tce_time0bt", "tce_duration", None, "BTJD", "BTJD-TDB"),
        "exofop_toi": ("TIC ID", "TOI", "Period (days)", "Epoch (BJD)", "Duration (hours)", "TFOPWG Disposition",
                       "BJD", "BJD-TDB"),
    }
    if source not in layouts:
        raise ValueError("unsupported_source")
    tic, key, period, epoch, duration, label, original, system = layouts[source]
    result = dict(status="hold", source=source, external_id=raw.get(key), tic_id=None, row=None,
                  raw_ephemeris={k: raw.get(k) for k in (tic, key, period, epoch, duration)},
                  original_time_system=original, time_rule_version=TIME_RULE_VERSION)
    try:
        t = str(int(str(raw[tic]).strip().removeprefix("TIC ")))
        _id(int(t))
        result["tic_id"] = t
        if not _text(raw.get(key)):
            raise ValueError("external_id_required")
        if source == "nea_pscomppars" and raw.get("tran_flag") == "0":
            result.update(status="excluded", reason="not_transiting")
            return result
        if source == "nea_pscomppars" and raw.get("tran_flag") != "1":
            raise ValueError("unverified_transit_flag")
        if system not in ("BJD-TDB", "BTJD-TDB"):
            raise ValueError("unverified_time_standard")
        e = float(raw[epoch]) - (2457000.0 if system == "BJD-TDB" else 0.0)
        row = dict(tic_id=t, external_id=raw[key], period_days=float(raw[period]),
                   epoch_btjd=e, duration_hours=float(raw[duration]), time_system="BTJD-TDB",
                   raw_disposition=raw.get(label) if label else None,
                   source_row_updated_at=raw.get("rowupdate") if source == "nea_toi" else
                       raw.get("Date TOI Updated (UTC)") if source == "exofop_toi" else None)
        distance(row, row, 0.0, 1.0)
        if not _text(row["external_id"]):
            raise ValueError("external_id_required")
        result.update(status="normalized", reason=None, row=row)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        result["reason"] = str(exc)
    return result


def content_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _id(value):
    if type(value) is not int or not 0 < value <= 9223372036854775807:
        raise ValueError("positive_bigint_required")
    return value


def _utc(value):
    if not isinstance(value, str):
        raise ValueError("utc_timestamp_required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError("utc_timestamp_required")


def code_snapshot(root):
    """Stable relative paths; nested modules contribute to the code digest."""
    root = Path(root)
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*.py")) if "__pycache__" not in p.parts}


def build_snapshot(*, source, scope, rows, raw_sha256, retrieved_at,
                   source_uri, source_table, time_evidence, complete, validated,
                   held_rows=None):
    """Return a source-local hold on invalid delivery, never a partial success.

    scope is a nonempty list of canonical TIC strings covered by the query.
    held_rows retain identifiable unresolved/excluded records. They allow
    diagnostic matching of valid rows but block classification for that TIC.
    """
    result = dict(version=VERSION, source=source, scope=deepcopy(scope), status="hold",
                  reasons=[], snapshot=None)
    try:
        if complete is not True or validated is not True:
            raise ValueError("incomplete_or_unvalidated_source")
        if not all(_text(x) for x in (source, source_uri, source_table, time_evidence)):
            raise ValueError("source_provenance_required")
        if not _hash(raw_sha256):
            raise ValueError("raw_checksum_required")
        _utc(retrieved_at)
        if not isinstance(scope, list) or not scope or len(scope) != len(set(scope)):
            raise ValueError("explicit_unique_tic_scope_required")
        for tic in scope:
            if not isinstance(tic, str) or not tic.isdecimal() or str(int(tic)) != tic:
                raise ValueError("canonical_tic_required")
            _id(int(tic))
        normalized = []
        for row in rows:
            if set(row) - ROW_FIELDS:
                raise ValueError("unexpected_normalized_field")
            if row["tic_id"] not in scope or not _text(row["external_id"]):
                raise ValueError("invalid_external_identity")
            if row["time_system"] != "BTJD-TDB":
                raise ValueError("unverified_time_standard")
            distance(row, row, 0.0, 1.0)
            label = row.get("raw_disposition")
            if label is not None and not isinstance(label, str):
                raise ValueError("invalid_label_type")
            normalized.append({k: deepcopy(row.get(k)) for k in sorted(ROW_FIELDS)})
        held = deepcopy(held_rows) if held_rows is not None else []
        if not isinstance(held, list):
            raise ValueError("held_rows_must_be_list")
        for row in held:
            if (set(row) != {"tic_id", "external_id", "reason"}
                    or row["tic_id"] not in scope
                    or not _text(row["external_id"]) or not _text(row["reason"])):
                raise ValueError("invalid_held_row_identity")
        keys = [(r["tic_id"], r["external_id"]) for r in [*normalized, *held]]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate_external_key")
        normalized.sort(key=lambda r: (r["tic_id"], r["external_id"]))
        held.sort(key=lambda r: (r["tic_id"], r["external_id"]))
        # Retrieval time is provenance, not a new scientific state.
        payload = dict(version=VERSION, source=source, scope=sorted(scope), rows=normalized,
                       raw_sha256=raw_sha256, source_uri=source_uri,
                       source_table=source_table, time_evidence=time_evidence, held_rows=held)
        digest = content_hash(payload)
        snapshot = dict(payload, sha256=digest, snapshot_id="external-" + digest,
                        retrieved_at=retrieved_at)
        result.update(status="ready", snapshot=snapshot)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        result["reasons"] = [str(exc)]
    return result


def _verified(delivery):
    if delivery.get("status") != "ready":
        return None
    s = delivery.get("snapshot")
    if not isinstance(s, dict):
        raise ValueError("missing_snapshot")
    rebuilt = build_snapshot(**{k: s[k] for k in (
        "source", "scope", "rows", "raw_sha256", "retrieved_at", "source_uri",
        "source_table", "time_evidence", "held_rows")}, complete=True, validated=True)
    if rebuilt["snapshot"] != s:
        raise ValueError("snapshot_integrity_mismatch")
    return s


def _join(candidates, rows, times):
    edges, evidence, aliases = [], [], set()
    for j, row in enumerate(rows):
        for i, candidate in enumerate(candidates):
            d = distance(candidate, row, float(times[0]), float(times[-1]))
            def mask(s):
                p = s["period_days"]
                return np.abs((times-s["epoch_btjd"]+p/2) % p-p/2) < s["duration_hours"]/48
            a, b = mask(candidate), mask(row)
            shared, union = int(np.count_nonzero(a & b)), int(np.count_nonzero(a | b))
            ratio = max(candidate["duration_hours"], row["duration_hours"]) / min(candidate["duration_hours"], row["duration_hours"])
            jac = shared / union if union else None
            direct = (d <= RULE["identity_tolerance"] and ratio <= RULE["duration_ratio_max"]
                      and shared >= RULE["min_shared_points"]
                      and jac is not None and jac >= RULE["observed_jaccard_min"])
            multipliers = possible_multipliers(candidate, row, float(times[0]), float(times[-1]), RULE["identity_tolerance"])
            evidence.append(dict(candidate_id=candidate["candidate_id"], external_id=row["external_id"],
                                 identity_distance=d, duration_ratio=ratio, shared_points=shared,
                                 observed_jaccard=jac, possible_multipliers=multipliers, direct_edge=direct))
            if direct:
                edges.append((i, j))
            elif multipliers:
                aliases.add(j)
    ci, ej = Counter(i for i, _ in edges), Counter(j for _, j in edges)
    matches = []
    for j, row in enumerate(rows):
        choices = [i for i, k in edges if k == j]
        ambiguous = choices and (ej[j] > 1 or any(ci[i] > 1 for i in choices))
        status = "ambiguous_match" if ambiguous else "direct_match" if choices else "possible_alias" if j in aliases else "external_only"
        matches.append(dict(external_id=row["external_id"], status=status,
                            candidate_id=candidates[choices[0]]["candidate_id"] if status == "direct_match" else None))
    return matches, evidence


def join_catalog(catalog, deliveries, observed_times, *, required_sources, approval,
                 previous=None):
    """Build immutable 125/Publisher proposals from a ready 122 catalog.

    previous is this function's last applied output, supplied by the adapter.
    Neither approval strings nor bigint shape prove a DB allocation: the caller
    must validate their provenance. No IDs, applied_at or DB writes are created.
    """
    previous = deepcopy(previous)
    result = dict(version=VERSION, status="hold", publishable=False, reasons=[],
                  rows=[], changes=[], history=[], joins={}, snapshots={}, external_references=[],
                  reference_changes=[],
                  retained_previous=previous, matching_rule_version=MATCH_VERSION,
                  disposition_rule_version=DISPOSITION_VERSION, rule=dict(RULE))
    if catalog.get("catalog_ready") is not True:
        result["reasons"] = ["candidate_catalog_not_ready"]
        return result
    if not _text(approval):
        result["reasons"] = ["external_contract_approval_required"]
        return result
    tic = str(_id(catalog["tic_id"]))
    bundle = _id(catalog["bundle_id"])
    if (not required_sources or not all(_text(s) for s in required_sources)
            or len(required_sources) != len(set(required_sources))):
        raise ValueError("explicit_unique_sources_required")
    if set(deliveries) != set(required_sources):
        result["reasons"] = ["source_set_mismatch"]
        return result
    candidates = [deepcopy(c) for c in catalog["candidates"] if c["status"] == "active"]
    ids = [_id(c["candidate_id"]) for c in candidates]
    if not candidates or len(ids) != len(set(ids)):
        raise ValueError("unique_active_candidates_required")
    times = np.asarray(observed_times, dtype=float)
    if times.ndim != 1 or not np.all(np.isfinite(times)):
        raise ValueError("actual_finite_times_required")
    times = np.unique(times)
    if len(times) < 2:
        raise ValueError("nonzero_baseline_required")
    for c in candidates:
        if str(c["tic_id"]) != tic or c["updated_bundle_id"] != bundle:
            raise ValueError("candidate_catalog_identity_mismatch")
        distance(c, c, float(times[0]), float(times[-1]))
    if previous is not None and (previous.get("status") != "ready" or previous.get("tic_id") != tic):
        raise ValueError("previous_success_same_tic_required")
    if previous:
        if set(previous["snapshots"]) != set(required_sources):
            result["reasons"] = ["changed_source_policy"]
            return result
        for snapshot in previous["snapshots"].values():
            _verified(dict(status="ready", snapshot=snapshot))
        old_ids = [_id(r["candidate_id"]) for r in previous["rows"]]
        if len(old_ids) != len(set(old_ids)):
            raise ValueError("duplicate_previous_candidate_id")
    result.update(tic_id=tic, bundle_id=bundle, approval=approval)
    for source in sorted(required_sources):
        s = _verified(deliveries[source])
        if s is None:
            result["reasons"].append(source + ":source_held")
            continue
        if s["source"] != source or tic not in s["scope"]:
            result["reasons"].append(source + ":source_scope_mismatch")
            continue
        if previous and source in previous["snapshots"]:
            old = previous["snapshots"][source]
            if old["scope"] != s["scope"]:
                result["reasons"].append(source + ":changed_scope")
                continue
            if old["sha256"] == s["sha256"]:
                s = old  # Keep first successful provenance on identical retry.
        result["snapshots"][source] = deepcopy(s)
        external = [r for r in s["rows"] if r["tic_id"] == tic]
        matches, evidence = _join(candidates, external, times)
        unresolved = [r for r in s["held_rows"] if r["tic_id"] == tic]
        result["joins"][source] = dict(rows=matches, evidence=evidence, held_rows=deepcopy(unresolved))
        if unresolved:
            result["reasons"].append(source + ":unresolved_external_rows")
        for row, match in zip(external, matches):
            result["external_references"].append(dict(candidate_id=match["candidate_id"],
                source=source, external_id=row["external_id"], disposition=row["raw_disposition"],
                period_days=row["period_days"], epoch_btjd=row["epoch_btjd"], tic_id=int(tic),
                fetched_on=s["retrieved_at"][:10], match_status=match["status"],
                snapshot_id=s["snapshot_id"], snapshot_sha256=s["sha256"]))
        if any(m["status"] in ("ambiguous_match", "possible_alias") for m in matches):
            result["reasons"].append(source + ":matching_held")
    if result["reasons"]:
        return result
    for c in candidates:
        refs, absence = [], []
        for source, s in result["snapshots"].items():
            matched = {m["external_id"] for m in result["joins"][source]["rows"] if m["candidate_id"] == c["candidate_id"]}
            base = dict(source=source, scope=s["scope"], snapshot_id=s["snapshot_id"], snapshot_sha256=s["sha256"])
            if not matched:
                absence.append(dict(base, complete=True, validated=True, reason="unmatched"))
            for r in s["rows"]:
                if r["tic_id"] == tic and r["external_id"] in matched:
                    refs.append(dict(base, source_table=s["source_table"], external_id=r["external_id"],
                                     tic_id=tic, retrieved_at=s["retrieved_at"],
                                     source_row_updated_at=r["source_row_updated_at"],
                                     match_status="direct_match", matching_rule_version=MATCH_VERSION,
                                     raw_disposition=r["raw_disposition"]))
                    if r["raw_disposition"] in (None, ""):
                        absence.append(dict(base, complete=True, validated=True, reason="missing_field"))
        labels = [r["raw_disposition"] for r in refs]
        present = [x for x in labels if x not in (None, "")]
        meanings = {LABELS[x] for x in present if x in LABELS}
        if any(x not in LABELS for x in present) or len(meanings) > 1:
            result["reasons"].append(f"{c['candidate_id']}:label_held")
            continue
        if not present and not absence:
            raise ValueError("absence_evidence_required")
        disposition = next(iter(meanings), "none")
        truth = {"confirmed": "planet", "fp": "not_planet"}.get(disposition)
        result["rows"].append(dict(candidate_id=c["candidate_id"], disposition=disposition,
            answer_class="graded" if truth else "analysis", planet_truth=truth,
            is_confirmed=disposition == "confirmed", rule_version=DISPOSITION_VERSION,
            source_refs=dict(schema_version="external-disposition-refs-v1", refs=refs,
                absence_evidence=absence or None, missing_label_count=len(labels)-len(present),
                decision_reason="no_label" if not present else "partial_labels" if len(labels)>len(present) else "consistent_labels"),
            representative_model={k: c[k] for k in ("period_days", "epoch_btjd", "duration_hours")}))
    if result["reasons"]:
        result["rows"] = []  # No partially classified catalog may be promoted.
        return result
    oldrows = {r["candidate_id"]: r for r in previous["rows"]} if previous else {}
    for row in result["rows"]:
        old = oldrows.get(row["candidate_id"])
        if old != row:
            result["changes"].append(dict(candidate_id=row["candidate_id"], before=deepcopy(old), after=deepcopy(row)))
            for field in ("disposition", "planet_truth"):
                before = old.get(field) if old else None
                if before != row[field]:
                    result["history"].append(dict(candidate_id=row["candidate_id"], field=field,
                        old_value=before, new_value=row[field], bundle_id=bundle,
                        reason="disposition_updated:external_catalog", rule_version=DISPOSITION_VERSION,
                        source_refs=deepcopy(row["source_refs"])))
    # Physical row IDs and transaction ordering belong to Publisher. A source
    # row disappearing is an explicit proposal, never an empty failed snapshot.
    def reference_map(rows):
        return {(r["source"], r["tic_id"], r["external_id"]): r for r in rows}
    oldrefs = reference_map(previous["external_references"]) if previous else {}
    newrefs = reference_map(result["external_references"])
    for key in sorted(oldrefs.keys() | newrefs.keys()):
        before, after = oldrefs.get(key), newrefs.get(key)
        if before != after:
            result["reference_changes"].append(dict(source=key[0], tic_id=key[1], external_id=key[2],
                action="remove" if after is None else "add" if before is None else "update",
                before=deepcopy(before), after=deepcopy(after)))
    result.update(status="ready", retained_previous=None)
    return result

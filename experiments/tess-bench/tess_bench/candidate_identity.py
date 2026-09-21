"""112 experimental direct identity proposal; not an operational ID allocator."""
import math


VERSION = "candidate_identity_v3_review"
# Minimum expansion supported as review flags by the frozen 111 pair sweep.
# These are never an instruction to merge or to identify a physical planet.
REVIEW_MULTIPLIERS = (0.25, 1/3, 0.5, 2.0, 3.0, 4.0)


def possible_multipliers(a, b, start, end, tolerance):
    """Conservative symmetric review flag, not evidence of a common signal."""
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
    if not math.isfinite(tolerance) or not 0 < tolerance <= 1:
        raise ValueError("tolerance must be in (0,1]")
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
    if not math.isfinite(tolerance) or not 0 < tolerance <= 1:
        raise ValueError("tolerance must be in (0,1]")
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


def window_evidence(time, flux, a, b):
    """Observed-window joint box-depth diagnostics. Does not authorize merging.

    A zero/weak conditional depth can be a missed weak planet, not proof of an
    alias. Equal sampled windows are unidentifiable even with perfect S/N.
    """
    import numpy as np
    from astro_kernel.transit_model import phase_distance_days

    t, f = np.asarray(time, dtype=float), np.asarray(flux, dtype=float)
    if t.ndim != 1 or f.shape != t.shape or not np.isfinite(t).all():
        raise ValueError("aligned vectors and finite time required")
    if len(t) < 4 or np.any(np.diff(t) <= 0) or np.isinf(f).any():
        raise ValueError("ascending time and finite-or-NaN flux required")
    for c in (a, b):
        distance(c, c, float(t[0]), float(t[-1]))
    valid = np.isfinite(f)
    masks = [np.abs(phase_distance_days(t, c["period_days"], c["epoch_btjd"]))
             < c["duration_hours"] / 48 for c in (a, b)]
    ma, mb = (m[valid] for m in masks)
    counts = dict(a_only=int((ma & ~mb).sum()), b_only=int((mb & ~ma).sum()),
                  both=int((ma & mb).sum()), outside=int((~ma & ~mb).sum()))
    base = dict(counts=counts, masked_points=int((~valid).sum()), auto_merge=False)
    if valid.sum() < 4 or counts["outside"] == 0:
        return dict(base, status="not_measurable")
    x = np.column_stack((np.ones(valid.sum()), -ma.astype(float), -mb.astype(float)))
    beta, _, rank, singular = np.linalg.lstsq(x, f[valid], rcond=None)
    if rank < 3:
        return dict(base, status="unidentifiable")
    residual = f[valid] - x @ beta
    sigma = float(np.sqrt(np.dot(residual, residual) / (len(residual)-3)))
    covariance = np.linalg.inv(x.T @ x)
    errors = sigma * np.sqrt(np.diag(covariance)[1:])
    # Avoid infinite significance in noiseless numerical fixtures.
    if sigma <= np.finfo(float).eps * max(1., abs(beta[0])):
        return dict(base, status="noise_not_measurable", depths=beta[1:].tolist())
    return dict(base, status="measured", depths=beta[1:].tolist(),
                depth_errors=errors.tolist(), conditional_snr=(beta[1:]/errors).tolist(),
                condition_number=float(singular[0]/singular[-1]))


def harmonic_equivalence(time, flux, a, b, *, margin_ppm):
    """Experimental 2:1 photometric equivalence, never physical planet identity.

    A margin MUST be supplied before looking at a result. Each fully observed
    long-period block must support equivalence, not merely a nonsignificant
    average depth difference. Correlation between blocks remains a limitation.
    No default margin is approved for production.
    """
    import numpy as np
    from scipy.stats import t as student_t
    from astro_kernel.transit_model import phase_distance_days

    if not math.isfinite(margin_ppm) or margin_ppm <= 0:
        raise ValueError("positive finite prespecified margin required")
    t, f = np.asarray(time,dtype=float), np.asarray(flux,dtype=float)
    if t.ndim != 1 or f.shape != t.shape or len(t)<4 or not np.isfinite(t).all():
        raise ValueError("aligned finite time vectors required")
    if np.any(np.diff(t)<=0) or np.isinf(f).any():
        raise ValueError("ascending time and finite-or-NaN flux required")
    start,end=float(t[0]),float(t[-1])
    for c in (a,b): distance(c,c,start,end)
    base=dict(version="harmonic_equivalence_v1_experiment",margin_ppm=margin_ppm,
              automatic_merge=False,physical_period_confirmed=False)
    def hold(reason, **evidence):
        return dict(base,status="undetermined",reason=reason,**evidence)
    if any(c.get("validated_on_original") is not True for c in (a,b)):
        return hold("original_validation_required")
    if any(not isinstance(c.get("depth_ppm"),(int,float)) or not math.isfinite(c["depth_ppm"])
           or not 0<c["depth_ppm"]<1e6 for c in (a,b)):
        return hold("valid_model_depth_required")
    short,long=sorted((a,b),key=lambda c:c["period_days"])
    if distance(short,dict(long,period_days=long["period_days"]/2),start,end)>.5:
        return hold("not_aligned_double_period")
    if short["duration_hours"] != long["duration_hours"]:
        return hold("different_duration_models")
    ms,ml=[np.abs(phase_distance_days(t,c["period_days"],c["epoch_btjd"])) < c["duration_hours"]/48
           for c in (short,long)]
    valid=np.isfinite(f)
    if np.any(ml & ~ms):
        return hold("different_transit_windows")
    p,e=long["period_days"],long["epoch_btjd"]
    block=np.floor((t-e)/p+.25).astype(int)
    differences,errors,depths=[],[],[]
    half=short["duration_hours"]/48
    first=math.ceil((start+half-e)/p)
    last=math.floor((end-half-p/2-e)/p)
    # Missing whole blocks, including missing sectors, cannot create equivalence.
    for k in range(first,last+1):
        masks=[(block==k)&valid&m for m in (ms&~ml,ml,~ms&~ml)]
        if min(int(m.sum()) for m in masks)<5:
            return hold("missing_distinguishing_windows",block=k)
        x,y,out=(f[m] for m in masks)
        differences.append(float(x.mean()-y.mean())*1e6)
        errors.append(float(np.sqrt(x.var(ddof=1)/len(x)+y.var(ddof=1)/len(y)))*1e6)
        depths.append(float(out.mean()-(x.mean()+y.mean())/2)*1e6)
    n=len(differences)
    if n<4:
        return hold("insufficient_paired_blocks",paired_blocks=n)
    delta=np.asarray(differences)
    # Bonferroni across paired blocks; diagnostic assumption: approximately
    # independent block means. Use between-block scatter as an error floor.
    critical=float(student_t.ppf(1-.001/n,n-1))
    error=max(max(errors),float(delta.std(ddof=1)/np.sqrt(n)))
    if error<=np.finfo(float).eps*1e6:
        return hold("noise_not_measurable",paired_blocks=n)
    upper=float(np.max(np.abs(delta))+critical*error)
    lower=float(abs(delta.mean())-critical*error)
    evidence=dict(paired_blocks=n,block_depth_difference_ppm=differences,
                  error_ppm=error,critical_value=critical,
                  equivalence_upper_ppm=upper,difference_lower_ppm=lower)
    if min(depths)<=critical*error:
        return hold("primary_depth_not_supported",**evidence)
    if upper < margin_ppm:
        model_error=max(abs(float(np.mean(depths))-c["depth_ppm"]) for c in (a,b))
        if model_error+critical*error>=margin_ppm:
            return hold("stored_depth_not_equivalent",stored_depth_error_ppm=model_error,**evidence)
        return dict(base,status="equivalent_within_margin",automatic_merge=True,
                    reason="all_paired_blocks_within_margin",**evidence)
    if lower > margin_ppm:
        return dict(base,status="distinct_depth_pattern",reason="difference_exceeds_margin",**evidence)
    return hold("uncertainty_exceeds_margin",**evidence)


def merge_harmonic_pair(time, flux, a, b, *, margin_ppm):
    """Keep both raw peaks; expose one photometric model only when supported."""
    if not all(isinstance(c.get("peak_id"),str) and c["peak_id"] for c in (a,b)):
        raise ValueError("source peak IDs required")
    if a["peak_id"]==b["peak_id"]:
        raise ValueError("distinct source peak IDs required")
    evidence=harmonic_equivalence(time,flux,a,b,margin_ppm=margin_ppm)
    short,long=sorted((a,b),key=lambda c:c["period_days"])
    return dict(evidence=evidence,raw_peaks=[dict(a),dict(b)],
                representative=dict(short) if evidence["automatic_merge"] else None,
                aliases=[dict(long)] if evidence["automatic_merge"] else [],
                unresolved_peak_ids=[] if evidence["automatic_merge"] else [a["peak_id"],b["peak_id"]])

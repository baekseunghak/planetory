"""112 experimental direct identity proposal; not an operational ID allocator."""
import math


VERSION = "candidate_identity_v1_proposal"
# Minimum expansion supported as review flags by the frozen 111 pair sweep.
# These are never an instruction to merge or to identify a physical planet.
REVIEW_MULTIPLIERS = (0.25, 1/3, 0.5, 2.0, 3.0, 4.0)


def distance(a, b, start, end):
    """Conservative epoch displacement plus accumulated period drift in durations.

    One fixed cycle offset is used over the entire interval; alias periods are
    deliberately not divided before assigning an existing identity.
    """
    pa, pb = a["period_days"], b["period_days"]
    ea, eb = a["epoch_btjd"], b["epoch_btjd"]
    duration = min(a["duration_hours"], b["duration_hours"]) / 24
    if not all(math.isfinite(x) for x in (pa, pb, ea, eb, duration, start, end)):
        raise ValueError("finite ephemeris and interval required")
    if min(pa, pb, duration) <= 0 or duration >= min(pa, pb) or end <= start:
        raise ValueError("invalid ephemeris or interval")
    # Anchor both ephemerides near the common interval midpoint. Integer epoch
    # re-labelling cannot change the astronomical signal.
    mid = (start + end) / 2
    ca = ea + math.floor((mid-ea)/pa + 0.5) * pa
    cb = eb + math.floor((ca-eb)/pb + 0.5) * pb
    cycles = math.ceil(max(abs(start-ca), abs(end-ca)) / min(pa, pb))
    return (abs(ca-cb) + cycles*abs(pa-pb)) / duration


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
            for multiplier in REVIEW_MULTIPLIERS:
                equivalent_period = b["period_days"] / multiplier
                cycles = math.ceil((end-start)/min(a["period_days"],equivalent_period))
                drift = abs(a["period_days"]-equivalent_period)*cycles
                # Alias epochs may pick different members of the short-period
                # event train. Period proximity flags review regardless of phase.
                if drift <= tolerance*min(a["duration_hours"],b["duration_hours"])/24:
                    return dict(version=VERSION,status="possible_alias",publishable=False,
                                matches=[],added=[],retired=[])
    return dict(version=VERSION, status="resolved", publishable=True,
                matches=[dict(candidate_id=ids[i],new_index=j) for i,j in edges],
                added=[j for j in range(len(new)) if j not in matched_new],
                retired=[ids[i] for i in range(len(old)) if i not in matched_old])


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

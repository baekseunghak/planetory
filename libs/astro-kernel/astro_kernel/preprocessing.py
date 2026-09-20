"""Silver preprocessing v1. Pure numpy; FITS decoding is a separate adapter.

The biweight arithmetic follows D03's frozen reference, not astropy/wotan.
Policy details and intentional reference differences live in README.md.
"""
from dataclasses import dataclass

import numpy as np

PREPROCESS_VERSION = "silver-biweight-1.0.0"


class PreprocessError(ValueError):
    def __init__(self, code: str, detail: str):
        self.code = code
        super().__init__(f"{code}: {detail}")


def preprocessing_config() -> dict:
    return dict(version=PREPROCESS_VERSION, quality="QUALITY == 0", gap_days=0.5,
                split_sectors=True, detrend_method="biweight", window_days=1.0,
                biweight_c=6.0, biweight_iterations=3, biweight_stride=10,
                sigma_upper=5.0, min_points=500, edge_mask_hours=0.0,
                stage1_method=None, clip_comparison="strict_less_than",
                time_unit="BTJD_TDB_day", flux_unit="relative")


@dataclass(frozen=True)
class SectorInput:
    tic_id: int
    sector: int
    product_id: str
    time: np.ndarray
    flux: np.ndarray
    flux_err: np.ndarray
    quality: np.ndarray
    cadenceno: np.ndarray


@dataclass
class PreparedCurve:
    tic_id: int
    time: np.ndarray
    flux: np.ndarray
    flux_err: np.ndarray
    sector: np.ndarray
    product_id: np.ndarray
    source_row: np.ndarray
    cadenceno: np.ndarray
    normalization_median: dict
    excluded: list[dict]
    n_raw: int


@dataclass
class DetrendedCurve:
    time: np.ndarray
    flux_in: np.ndarray
    trend: np.ndarray
    flux_det: np.ndarray
    kept: np.ndarray
    segment_id: np.ndarray
    segment_edges: np.ndarray
    noise_scatter: float
    reasons: np.ndarray
    failures: list[dict]
    status: str
    version: str = PREPROCESS_VERSION

    @property
    def n_edge_masked(self):
        return 0


def _array(value, name, *, integer=False):
    a = np.asarray(value)
    if a.ndim != 1 or a.dtype.kind not in ("iu" if integer else "iuf"):
        raise PreprocessError("invalid_array", name)
    if integer and (np.any(a < 0) or np.any(a > np.iinfo(np.int64).max)):
        raise PreprocessError("invalid_array", name)
    return a.astype(np.int64 if integer else np.float64, copy=True)


def _identifier(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) or value <= 0:
        raise PreprocessError("invalid_identity", name)


def prepare_silver(curves: list[SectorInput]) -> PreparedCurve:
    """Filter and normalize each Sector, preserving product + zero-based row.

    Non-finite flux errors are retained as missing metadata, not used as a
    new quality cut. Duplicate valid times within one Sector are rejected.
    No timestamp is deduplicated or averaged silently.
    """
    if not curves:
        raise PreprocessError("empty_input", "no products")
    parts, medians, excluded = [], {}, []
    seen, products, tic_ids, n_raw = set(), set(), set(), 0
    for c in curves:
        _identifier(c.tic_id, "tic_id")
        _identifier(c.sector, "sector")
        if not isinstance(c.product_id, str) or not c.product_id.strip():
            raise PreprocessError("invalid_identity", "product_id")
        if c.sector in seen or c.product_id in products:
            raise PreprocessError("duplicate_product", c.product_id)
        seen.add(c.sector)
        products.add(c.product_id)
        tic_ids.add(c.tic_id)
        if len(tic_ids) != 1:
            raise PreprocessError("mixed_tic", "one TIC per call")
        t, f, e = (_array(getattr(c, k), k) for k in ("time", "flux", "flux_err"))
        q, cadence = (_array(getattr(c, k), k, integer=True) for k in ("quality", "cadenceno"))
        if len({len(x) for x in (t, f, e, q, cadence)}) != 1:
            raise PreprocessError("length_mismatch", c.product_id)
        n_raw += len(t)
        valid = (q == 0) & np.isfinite(t) & np.isfinite(f)
        for i in np.flatnonzero(~valid):
            reasons = []
            if q[i] != 0:
                reasons.append("quality_flag")
            if not np.isfinite(t[i]):
                reasons.append("nonfinite_time")
            if not np.isfinite(f[i]):
                reasons.append("nonfinite_flux")
            excluded.append(dict(product_id=c.product_id, sector=c.sector,
                                 source_row=int(i), reasons=reasons))
        idx = np.flatnonzero(valid)
        idx = idx[np.argsort(t[idx], kind="stable")]
        if len(idx) and np.any(np.diff(t[idx]) == 0):
            raise PreprocessError("duplicate_time", c.product_id)
        if not len(idx):
            medians[c.sector] = None
            continue
        med = float(np.median(f[idx]))
        if not np.isfinite(med) or med <= 0:
            raise PreprocessError("invalid_normalization", c.product_id)
        medians[c.sector] = med
        with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
            normalized, error = f[idx] / med, e[idx] / med
        if not np.isfinite(normalized).all():
            raise PreprocessError("numerical_failure", "normalization overflow")
        # Error metadata is not a selection criterion of D03.
        error[~np.isfinite(error) | (error < 0)] = np.nan
        parts.append((t[idx], normalized, error, np.full(len(idx), c.sector, dtype=np.int64),
                      np.full(len(idx), c.product_id, dtype=object), idx, cadence[idx]))
    if parts:
        cols = [np.concatenate([p[k] for p in parts]) for k in range(7)]
        order = np.lexsort((cols[5], cols[3], cols[0]))
        cols = [x[order] for x in cols]
    else:
        cols = [np.empty(0, dtype=d) for d in (float, float, float, int, object, int, int)]
    return PreparedCurve(curves[0].tic_id, *cols, medians, excluded, n_raw)


def _biweight_location(x):
    m = float(np.median(x))
    for _ in range(3):
        mad = np.median(np.abs(x - m))
        if mad == 0:
            return m
        u = (x - m) / (6.0 * mad)
        w = (1 - u ** 2) ** 2
        w[np.abs(u) >= 1] = 0
        if w.sum() == 0:
            return m
        m = float(np.sum(w * x) / np.sum(w))
    return m


def _trend(t, f):
    anchors = np.arange(0, len(t), 10)
    if anchors[-1] != len(t) - 1:
        anchors = np.append(anchors, len(t) - 1)
    lo = np.searchsorted(t, t[anchors] - 0.5, side="left")
    hi = np.searchsorted(t, t[anchors] + 0.5, side="right")
    centers = np.array([_biweight_location(f[a:b]) for a, b in zip(lo, hi)])
    good = np.isfinite(centers)
    if good.sum() < 2:
        return np.full(len(t), np.median(f))
    return np.interp(t, t[anchors][good], centers[good])


def detrend_silver(time, normalized_flux, sector) -> DetrendedCurve:
    """D03 algorithm on normalized (optionally injected) values, no renormalization.

    Sector processing is independent even when sectors overlap in time.
    Clipping is pooled across the TIC, matching the D03 reference.
    """
    t, f = _array(time, "time"), _array(normalized_flux, "normalized_flux")
    s = _array(sector, "sector", integer=True)
    if not len(t) == len(f) == len(s):
        raise PreprocessError("length_mismatch", "detrend arrays")
    if not (np.isfinite(t).all() and np.isfinite(f).all()) or np.any(s <= 0):
        raise PreprocessError("invalid_input", "finite arrays and positive sectors required")
    if np.any(np.diff(t) < 0):
        raise PreprocessError("unsorted_time", "ascending time required")
    for sector_id in np.unique(s):
        if np.any(np.diff(t[s == sector_id]) == 0):
            raise PreprocessError("duplicate_time", str(sector_id))
    n = len(t)
    trend, det = np.full(n, np.nan), np.full(n, np.nan)
    kept, ids = np.zeros(n, bool), np.full(n, -1, dtype=int)
    reasons = np.full(n, "", dtype=object)
    failures, edges = [], []
    scatter = float("nan")
    if n < 500:
        reasons[:] = "insufficient_observations"
        return DetrendedCurve(t, f, trend, det, kept, ids, np.empty((2, 0)), scatter,
                              reasons, [], "insufficient_observations")
    for sector_id in np.unique(s):
        idx = np.flatnonzero(s == sector_id)
        for seg in np.split(idx, np.flatnonzero(np.diff(t[idx]) > 0.5) + 1):
            k = len(edges)
            ids[seg] = k
            edges.append((t[seg[0]], t[seg[-1]]))
            if len(seg) < 3:
                trend[seg] = np.median(f[seg])
                failures.append(dict(segment_id=k, reason="short_segment_median_fallback", n_points=len(seg)))
            else:
                with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
                    trend[seg] = _trend(t[seg], f[seg])
            bad = ~np.isfinite(trend[seg]) | (trend[seg] <= 0)
            if bad.any():
                reasons[seg[bad]] = "invalid_trend"
                trend[seg[bad]] = np.nan
                failures.append(dict(segment_id=k, reason="invalid_trend", n_points=int(bad.sum())))
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        fd = f / trend
    valid = np.isfinite(fd)
    reasons[~valid & (reasons == "")] = "nonfinite_detrended_flux"
    if valid.any():
        med = np.median(fd[valid])
        scatter = float(1.4826 * np.median(np.abs(fd[valid] - med)))
        if not np.isfinite(scatter):
            reasons[valid] = "nonfinite_scatter"
        else:
            kept = valid & (fd < 1 + 5.0 * scatter)
            reasons[valid & ~kept] = "upper_clip"
            det[kept] = fd[kept]
    # Partial numerical failure is not a successful curve with zero candidates.
    numerical = np.any((reasons != "") & (reasons != "upper_clip"))
    status = "numerical_failure" if numerical else "ok" if kept.sum() >= 500 else "insufficient_observations"
    return DetrendedCurve(t, f, trend, det, kept, ids, np.asarray(edges).T, scatter,
                          reasons, failures, status)


def preprocess_silver(curves: list[SectorInput]) -> tuple[PreparedCurve, DetrendedCurve]:
    """Return provenance + numerical result. Only status='ok' may reach BLS."""
    prepared = prepare_silver(curves)
    return prepared, detrend_silver(prepared.time, prepared.flux, prepared.sector)

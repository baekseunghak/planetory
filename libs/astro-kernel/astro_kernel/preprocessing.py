"""Silver preprocessing v1. Pure numpy; FITS decoding is a separate adapter.

The biweight arithmetic follows D03's frozen reference, not astropy/wotan.
Policy details and intentional reference differences live in README.md.
"""
from dataclasses import dataclass, asdict, field, replace
import re

import numpy as np

PREPROCESS_VERSION = "silver-biweight-1.0.0"
MASK_CONTRACT_VERSION = "silver-interval-mask-1.0.0"


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
    source_sha256: str | None = None


@dataclass(frozen=True)
class IntervalMask:
    interval_id: str
    product_id: str
    sector: int
    product_sha256: str
    coordinate: str
    start: float
    end: float
    closed: str
    reason: str
    source_uri: str
    source_sha256: str
    version: str


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
    original_quality: np.ndarray = field(default_factory=lambda: np.empty(0, dtype=np.int64))
    interval_masks: tuple[dict, ...] = ()


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


def _validate_masks(curves, interval_masks):
    masks = tuple(interval_masks)
    ids = set()
    normalized = []
    for m in masks:
        if not isinstance(m, IntervalMask):
            raise PreprocessError("invalid_mask", "IntervalMask required")
        for name in ("interval_id", "product_id", "reason", "source_uri", "version"):
            if not isinstance(getattr(m, name), str) or not getattr(m, name).strip():
                raise PreprocessError("invalid_mask", name)
        if m.interval_id in ids:
            raise PreprocessError("invalid_mask", "duplicate interval_id")
        ids.add(m.interval_id)
        _identifier(m.sector, "mask sector")
        for digest in (m.product_sha256, m.source_sha256):
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise PreprocessError("invalid_mask", "SHA-256 required")
        if m.coordinate not in ("cadenceno", "BTJD_TDB_day") or m.closed not in ("both", "left", "right", "neither"):
            raise PreprocessError("invalid_mask", "coordinate or boundary")
        if any(isinstance(v, (bool, np.bool_)) or not isinstance(v, (int, float, np.integer, np.floating)) or not np.isfinite(v) for v in (m.start, m.end)) or m.start >= m.end:
            raise PreprocessError("invalid_mask", "finite increasing bounds required")
        if m.coordinate == "cadenceno" and any(v < 0 or v != int(v) or v > np.iinfo(np.int64).max for v in (m.start, m.end)):
            raise PreprocessError("invalid_mask", "integer cadence bounds required")
        targets = [c for c in curves if c.product_id == m.product_id and c.sector == m.sector]
        if len(targets) != 1 or targets[0].source_sha256 != m.product_sha256:
            raise PreprocessError("mask_source_mismatch", m.interval_id)
        boundary_type = int if m.coordinate == "cadenceno" else float
        start, end = boundary_type(m.start), boundary_type(m.end)
        if not np.isfinite(start) or not np.isfinite(end) or start >= end:
            raise PreprocessError("invalid_mask", "bounds not representable in JSON numeric types")
        normalized.append(replace(m, sector=int(m.sector), start=start, end=end))
    return tuple(normalized)


def prepare_silver(curves: list[SectorInput], *, interval_masks=()) -> PreparedCurve:
    """Filter and normalize each Sector, preserving product + zero-based row.

    Non-finite flux errors are retained as missing metadata, not used as a
    new quality cut. Duplicate valid times within one Sector are rejected.
    No timestamp is deduplicated or averaged silently.
    """
    if not curves:
        raise PreprocessError("empty_input", "no products")
    masks = _validate_masks(curves, interval_masks)
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
        hits = {}
        for m in masks:
            if m.product_id != c.product_id:
                continue
            x = cadence if m.coordinate == "cadenceno" else t
            hit = ((x >= m.start) if m.closed in ("both", "left") else (x > m.start)) & ((x <= m.end) if m.closed in ("both", "right") else (x < m.end))
            hits[m.interval_id] = hit
        masked = np.logical_or.reduce(list(hits.values())) if hits else np.zeros(len(t), dtype=bool)
        valid = (q == 0) & np.isfinite(t) & np.isfinite(f) & ~masked
        for i in np.flatnonzero(~valid):
            reasons = []
            if q[i] != 0:
                reasons.append("quality_flag")
            if not np.isfinite(t[i]):
                reasons.append("nonfinite_time")
            if not np.isfinite(f[i]):
                reasons.append("nonfinite_flux")
            interval_ids = [key for key, hit in hits.items() if hit[i]]
            if interval_ids:
                reasons.append("interval_mask")
                reasons.extend(dict.fromkeys(m.reason for m in masks if m.interval_id in interval_ids))
            excluded.append(dict(product_id=c.product_id, sector=c.sector,
                                 source_row=int(i), cadenceno=int(cadence[i]), original_quality=int(q[i]),
                                 original_time=float(t[i]), reasons=reasons, interval_ids=interval_ids))
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
                      np.full(len(idx), c.product_id, dtype=object), idx, cadence[idx], q[idx]))
    if parts:
        cols = [np.concatenate([p[k] for p in parts]) for k in range(8)]
        order = np.lexsort((cols[5], cols[3], cols[0]))
        cols = [x[order] for x in cols]
    else:
        cols = [np.empty(0, dtype=d) for d in (float, float, float, int, object, int, int, int)]
    return PreparedCurve(curves[0].tic_id, *cols[:7], medians, excluded, n_raw, cols[7], tuple(asdict(m) for m in masks))


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


def preprocess_silver(curves: list[SectorInput], *, interval_masks=()) -> tuple[PreparedCurve, DetrendedCurve]:
    """Return provenance + numerical result. Only status='ok' may reach BLS."""
    prepared = prepare_silver(curves, interval_masks=interval_masks)
    return prepared, detrend_silver(prepared.time, prepared.flux, prepared.sector)


def exclusion_ledger(prepared: PreparedCurve, result: DetrendedCurve) -> list[dict]:
    """All preparation and detrending exclusions, keyed by original product/row.

    Non-finite original times use null plus original_time_nonfinite so the
    ledger is strict JSON and the original NaN/+Inf/-Inf distinction survives.
    """
    if len(prepared.time) != len(result.time) or not np.array_equal(prepared.time, result.time):
        raise PreprocessError("provenance_mismatch", "prepared/result time")
    if len(result.kept) != len(prepared.time) or len(result.reasons) != len(prepared.time):
        raise PreprocessError("provenance_mismatch", "prepared/result length")
    rows = [dict(row, reasons=list(row["reasons"]), interval_ids=list(row["interval_ids"])) for row in prepared.excluded]
    for i in np.flatnonzero(~result.kept):
        rows.append(dict(product_id=str(prepared.product_id[i]), sector=int(prepared.sector[i]),
                         source_row=int(prepared.source_row[i]), cadenceno=int(prepared.cadenceno[i]),
                         original_quality=int(prepared.original_quality[i]), original_time=float(prepared.time[i]),
                         reasons=[str(result.reasons[i])], interval_ids=[]))
    for row in rows:
        value = row["original_time"]
        if not np.isfinite(value):
            row["original_time_nonfinite"] = "NaN" if np.isnan(value) else "+Infinity" if value > 0 else "-Infinity"
            row["original_time"] = None
    return sorted(rows, key=lambda row: (row["product_id"], row["source_row"]))

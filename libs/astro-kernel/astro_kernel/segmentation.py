"""114's fixed 10-minute mean rule, without storage or discovery policy."""
from dataclasses import dataclass
import hashlib
import json
import re

import numpy as np

BINNING_RULE_VERSION = "bin-mean-10m-1.0.0"
NUMERICAL_VERSION = "segment-numpy-1.0.0"
BIN_MINUTES = 10.0
MAX_POINTS = 20_000


class SegmentationError(ValueError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(f"{code}: {detail}")


@dataclass
class Segment:
    start_btjd: float
    flux: np.ndarray
    counts: np.ndarray
    flux_scatter: float

    @property
    def centers(self):
        return self.start_btjd + (np.arange(len(self.flux)) + 0.5) * BIN_MINUTES / 1440

    @property
    def gaps(self):
        empty = np.flatnonzero(self.counts == 0)
        return [[int(g[0]), int(g[-1])] for g in
                np.split(empty, np.flatnonzero(np.diff(empty) > 1) + 1) if len(g)]

    def values(self):
        """Numerical fields only; Publisher supplies IDs and revision linkage."""
        return dict(start_btjd=self.start_btjd, bin_minutes=BIN_MINUTES,
                    n_points=len(self.flux),
                    flux=[float(v) if np.isfinite(v) else None for v in self.flux],
                    flux_scatter=self.flux_scatter, gaps=self.gaps)


def bin_sector(time, flux):
    """Use full prepared Sector time, retaining detrending exclusions as NaN.

    Caller must pass one Sector. Duplicate times are rejected as in Silver.
    Empty input/all-empty output is a failure, not an empty published segment.
    Zero MAD is valid descriptive scatter, not a usable noise denominator.
    """
    t, f = np.asarray(time), np.asarray(flux)
    if (t.ndim != 1 or f.shape != t.shape or not len(t)
            or t.dtype.kind not in "iuf" or f.dtype.kind not in "iuf"):
        raise SegmentationError("invalid_input", "aligned numeric vectors required")
    t, f = t.astype(float), f.astype(float)
    if not np.isfinite(t).all():
        raise SegmentationError("invalid_time", "prepared time must be finite")
    order = np.argsort(t, kind="stable")
    t, f = t[order], f[order]
    if np.any(np.diff(t) == 0):
        raise SegmentationError("duplicate_time", "one Sector required")
    with np.errstate(over="ignore", invalid="ignore"):
        scaled = (t - t[0]) * 1440 / BIN_MINUTES
    if not np.isfinite(scaled).all():
        raise SegmentationError("point_limit", "time span is not representable")
    rounded = np.rint(scaled)
    scaled = np.where(np.abs(scaled - rounded) <= 1e-8, rounded, scaled)
    # Check before allocating bins or converting very large floats to int64.
    if scaled[-1] >= MAX_POINTS:
        raise SegmentationError("point_limit", "10-minute grid exceeds 20000 points")
    ids = np.floor(scaled).astype(np.int64)
    n = int(ids[-1]) + 1
    valid = np.isfinite(f)
    if not valid.any():
        raise SegmentationError("no_valid_bins", "no finite detrended flux")
    counts = np.bincount(ids[valid], minlength=n)
    # Divide before summing to avoid overflow of a finite bin mean.
    means = np.bincount(ids[valid], weights=f[valid] / counts[ids[valid]], minlength=n)
    means[counts == 0] = np.nan
    finite = means[counts > 0]
    with np.errstate(over="ignore", invalid="ignore"):
        scatter = float(1.4826 * np.median(np.abs(finite - np.median(finite))))
    if not np.isfinite(finite).all() or not np.isfinite(scatter):
        raise SegmentationError("numerical_failure", "nonfinite mean or scatter")
    return Segment(float(t[0]), means, counts, scatter)


def segment_revision(*, tic_id, sector, snapshot_id, products, preprocessing_version,
                     preprocessing_parameters, numerical_version=NUMERICAL_VERSION):
    """Hash explicit scientific provenance; no paths, timestamps or lock hash.

    products maps product_id to raw SHA-256. Preprocessing parameters must
    include applied mask definitions/checksums when masks are used.
    """
    for name, value in (("tic_id", tic_id), ("sector", sector)):
        if type(value) is not int or value <= 0:
            raise SegmentationError("invalid_provenance", name)
    for value in (snapshot_id, preprocessing_version, numerical_version):
        if not isinstance(value, str) or not value.strip():
            raise SegmentationError("invalid_provenance", "nonempty version/snapshot required")
    if not isinstance(products, dict) or not products:
        raise SegmentationError("invalid_provenance", "source products required")
    for key, value in products.items():
        if (not isinstance(key, str) or not key.strip() or not isinstance(value, str)
                or re.fullmatch(r"[0-9a-f]{64}", value) is None):
            raise SegmentationError("invalid_provenance", "product ID and lowercase SHA-256 required")
    if not isinstance(preprocessing_parameters, dict) or not preprocessing_parameters:
        raise SegmentationError("invalid_provenance", "explicit preprocessing parameters required")
    material = dict(tic_id=tic_id, sector=sector, snapshot_id=snapshot_id,
                    products=products, preprocessing_version=preprocessing_version,
                    preprocessing_parameters=preprocessing_parameters,
                    binning_rule_version=BINNING_RULE_VERSION,
                    numerical_version=numerical_version,
                    binning_parameters=dict(minutes=BIN_MINUTES, reducer="mean", max_points=MAX_POINTS,
                                            boundary_snap_bins=1e-8))
    try:
        canonical = json.dumps(material, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise SegmentationError("invalid_provenance", "finite JSON parameters required") from exc
    return "bin-v1-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def segment_silver(prepared, detrended, *, snapshot_id, product_checksums,
                   preprocessing_parameters):
    """Adapt aligned 119 outputs; quarantine individual numerical failures.

    Returns proposals, not DB rows. No discoverable boolean is invented here.
    Caller preserves prior revisions and owns Publisher transactions.
    """
    if (not np.array_equal(prepared.time, detrended.time)
            or np.shape(prepared.sector) != np.shape(prepared.time)
            or np.shape(prepared.product_id) != np.shape(prepared.time)
            or np.shape(detrended.flux_det) != np.shape(prepared.time)
            or np.shape(detrended.kept) != np.shape(prepared.time)):
        raise SegmentationError("provenance_mismatch", "prepared/detrended alignment")
    if detrended.status != "ok":
        raise SegmentationError("preprocessing_failed", detrended.status)
    parameters = dict(preprocessing_parameters)
    # Mask provenance must not disappear when two runs share the same version.
    parameters["interval_masks"] = sorted(prepared.interval_masks, key=lambda m: m["interval_id"])
    proposals, quarantined = [], []
    for sector in np.unique(prepared.sector):
        selected = prepared.sector == sector
        products = {}
        for product_id in np.unique(prepared.product_id[selected]):
            if product_id not in product_checksums:
                raise SegmentationError("invalid_provenance", f"missing checksum: {product_id}")
            products[str(product_id)] = product_checksums[product_id]
        revision = segment_revision(tic_id=int(prepared.tic_id), sector=int(sector),
                                    snapshot_id=snapshot_id, products=products,
                                    preprocessing_version=detrended.version,
                                    preprocessing_parameters=parameters)
        try:
            segment = bin_sector(prepared.time[selected],
                                 np.where(detrended.kept[selected], detrended.flux_det[selected], np.nan))
        except SegmentationError as exc:
            quarantined.append(dict(sector=int(sector), reason=exc.code, binning_revision=revision))
            continue
        proposals.append(dict(tic_id=int(prepared.tic_id), sector=int(sector),
                              binning_revision=revision, **segment.values(),
                              diagnostics=dict(counts=segment.counts.tolist(),
                                               n_kept=int(segment.counts.sum()))))
    return dict(segments=proposals, quarantined=quarantined, publishable=False,
                discoverability_status="pending_115_rule")

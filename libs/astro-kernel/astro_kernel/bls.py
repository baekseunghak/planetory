"""D13: array-only BLS calculation and D04's frozen v0 quality gate.

Astropy is loaded only for BLS; the transit/preprocessing kernel stays numpy-only.
No experiment imports, file access, candidate identity, or repeated removal.
"""
from dataclasses import dataclass
import hashlib

import numpy as np

from .transit_model import phase_distance_days


SEARCH_VERSION = "bls_grid_v1/poc_linear20k"
QUALITY_VERSION = "gate_v1/snr7_sde6"
DURATIONS_HOURS = (1.2, 1.92, 2.88, 4.8)


def _search_input_sha256(time, flux, sector, baseline_time):
    """Bind an in-memory search result to its exact numerical inputs."""
    digest = hashlib.sha256()
    for value in (time, flux, sector, baseline_time):
        if value is None:
            digest.update(b"absent")
            continue
        array = np.ascontiguousarray(value, dtype="<f8")
        digest.update(b"present")
        digest.update(len(array).to_bytes(8, "big"))
        digest.update(array.tobytes())
    return digest.hexdigest()


class BlsError(ValueError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(f"{code}: {detail}")


def _vector(value, name):
    a = np.asarray(value)
    if a.ndim != 1 or a.dtype.kind not in "iuf":
        raise BlsError("invalid_input", f"{name}: numeric vector required")
    return a.astype(np.float64, copy=True)


def period_grid(period_min_days, period_max_days, n_periods, *, spacing):
    """Explicit grid for callers, including D06's logarithmic provided grid."""
    bounds = np.asarray([period_min_days, period_max_days])
    if (bounds.dtype.kind not in "iuf" or not np.isfinite(bounds).all()
            or not 0 < period_min_days < period_max_days):
        raise BlsError("invalid_grid", "finite 0 < min < max required")
    if (isinstance(n_periods, (bool, np.bool_))
            or not isinstance(n_periods, (int, np.integer)) or n_periods < 2):
        raise BlsError("invalid_grid", "integer n_periods >= 2 required")
    if spacing == "linear":
        return np.linspace(period_min_days, period_max_days, n_periods)
    if spacing == "log":
        return np.geomspace(period_min_days, period_max_days, n_periods)
    raise BlsError("invalid_grid", "spacing must be linear or log")


@dataclass
class Periodogram:
    periods: np.ndarray
    power: np.ndarray
    epoch_btjd: np.ndarray
    duration_hours: np.ndarray
    depth: np.ndarray
    depth_err: np.ndarray
    snr: np.ndarray
    sde: np.ndarray
    valid_input: np.ndarray
    config: dict


def bls_periodogram(time, flux, periods, *, durations_hours=DURATIONS_HOURS,
                    config_version):
    """Compute likelihood power with global MAD dy, exactly as D04 v0.

    Non-finite time is invalid. NaN flux is a missing observation; its
    original position is retained by valid_input. Failures raise BlsError.
    """
    t, f, p = (_vector(v, n) for v, n in
               ((time, "time"), (flux, "flux"), (periods, "periods")))
    if len(t) != len(f) or not np.isfinite(t).all() or np.any(np.diff(t) < 0):
        raise BlsError("invalid_input", "aligned arrays and finite ascending time required")
    if np.isinf(f).any():
        raise BlsError("numerical_failure", "infinite flux is not a missing observation")
    if (len(p) < 2 or not np.isfinite(p).all() or np.any(p <= 0)
            or np.any(np.diff(p) <= 0)):
        raise BlsError("invalid_grid", "strictly increasing positive periods required")
    d = _vector(durations_hours, "durations_hours")
    if not len(d) or not np.isfinite(d).all() or np.any(d <= 0) or np.any(d / 24 >= p[0]):
        raise BlsError("invalid_grid", "all durations must be positive and shorter than min period")
    if not isinstance(config_version, str) or not config_version.strip():
        raise BlsError("invalid_grid", "config_version required")
    valid = np.isfinite(f)
    if valid.sum() < 100 or np.ptp(t[valid]) <= 0:
        raise BlsError("insufficient_observations", "at least 100 points and positive baseline required")
    scatter = float(1.4826 * np.median(np.abs(f[valid] - np.median(f[valid]))))
    if not np.isfinite(scatter) or scatter <= 0:
        raise BlsError("degenerate_flux", "global MAD must be positive and finite")
    from astropy.timeseries import BoxLeastSquares
    try:
        result = BoxLeastSquares(t[valid], f[valid], dy=scatter).power(
            p, d / 24, objective="likelihood", oversample=10)
    except (ValueError, FloatingPointError, OverflowError) as exc:
        raise BlsError("numerical_failure", str(exc)) from exc
    power = np.asarray(result.power, dtype=float)
    if not np.isfinite(power).all():
        raise BlsError("numerical_failure", "non-finite power")
    std = float(np.std(power))
    if not np.isfinite(std) or std <= 0:
        raise BlsError("numerical_failure", "periodogram scatter is zero or non-finite")
    return Periodogram(p, power, np.asarray(result.transit_time),
                       np.asarray(result.duration) * 24, np.asarray(result.depth),
                       np.asarray(result.depth_err), np.asarray(result.depth_snr),
                       (power - np.mean(power)) / std, valid,
                       dict(version=config_version, durations_hours=d.tolist(),
                            objective="likelihood", oversample=10, dy="global_mad",
                            scatter=scatter, n_periods=len(p),
                            period_min_days=float(p[0]), period_max_days=float(p[-1])))


def top_period_peaks(periods, power, *, count=5, separation_rel=0.02):
    """D04 power-ranked 2% suppression; does not merge harmonic candidates."""
    p, y = _vector(periods, "periods"), _vector(power, "power")
    if len(p) != len(y) or not np.isfinite(p).all() or np.any(p <= 0):
        raise BlsError("invalid_grid", "aligned positive periods required")
    if (isinstance(count, (bool, np.bool_)) or not isinstance(count, (int, np.integer))
            or count < 1 or not np.isfinite(separation_rel) or separation_rel <= 0):
        raise BlsError("invalid_input", "positive count and separation required")
    selected = []
    for i in np.argsort(y)[::-1]:
        if np.isfinite(y[i]) and all(abs(p[i] / p[j] - 1) >= separation_rel for j in selected):
            selected.append(int(i))
        if len(selected) == count:
            break
    return selected


def quality_gate(snr, sde):
    """Only the approved strength gate. Observation diagnostics do not vote."""
    if not np.isfinite([snr, sde]).all():
        return "failed", ["non_finite_metric"]
    reasons = []
    if snr < 7:
        reasons.append("snr_below_threshold")
    if sde < 6:
        reasons.append("sde_below_threshold")
    return ("held" if reasons else "accepted"), reasons


def search_bls(time, flux, *, input_snapshot_id, preprocessing_version,
               sector=None, baseline_time=None):
    """Frozen D04 search. Sector/mask thresholds remain explicitly undecided.

    baseline_time must contain the pre-filter observation times, with identical
    multiplicities for every input observation (including overlapping sectors).
    Missing provenance is reported as unavailable, never as a zero fraction.
    """
    t, f = _vector(time, "time"), _vector(flux, "flux")
    if len(t) != len(f) or not np.isfinite(t).all() or np.any(np.diff(t) < 0):
        raise BlsError("invalid_input", "aligned arrays and finite ascending time required")
    for value in (input_snapshot_id, preprocessing_version):
        if not isinstance(value, str) or not value.strip():
            raise BlsError("invalid_input", "input and preprocessing versions required")
    if np.isinf(f).any():
        raise BlsError("numerical_failure", "infinite flux is not a missing observation")
    valid = np.isfinite(f)
    if valid.sum() < 100:
        raise BlsError("insufficient_observations", "at least 100 valid points required")
    sectors = None
    if sector is not None:
        sectors = _vector(sector, "sector")
        if (len(sectors) != len(t) or not np.isfinite(sectors).all()
                or np.any(sectors <= 0) or np.any(sectors != np.floor(sectors))):
            raise BlsError("invalid_input", "aligned positive integer sectors required")
    baseline = None
    if baseline_time is not None:
        baseline = _vector(baseline_time, "baseline_time")
        if not np.isfinite(baseline).all():
            raise BlsError("invalid_input", "finite baseline times required")
        times, counts = np.unique(t, return_counts=True)
        raw_times, raw_counts = np.unique(baseline, return_counts=True)
        positions = np.searchsorted(raw_times, times)
        if (np.any(positions >= len(raw_times)) or
                not np.array_equal(raw_times[positions], times) or
                np.any(raw_counts[positions] < counts)):
            raise BlsError("invalid_input", "baseline must contain every input observation")
    pmax = min(float(np.ptp(t[valid])) / 3, 100.0)
    if pmax <= 0.5:
        raise BlsError("insufficient_observations", "baseline/3 must exceed 0.5 day")
    pg = bls_periodogram(t, f, period_grid(0.5, pmax, 20000, spacing="linear"),
                         config_version=SEARCH_VERSION)
    tv, fv = t[valid], f[valid]
    input_sectors = np.unique(sectors) if sectors is not None else []
    peaks = []
    for rank, i in enumerate(top_period_peaks(pg.periods, pg.power), 1):
        period, epoch, duration = pg.periods[i], pg.epoch_btjd[i], pg.duration_hours[i] / 24
        metrics = [period, epoch, duration, pg.depth[i], pg.depth_err[i], pg.snr[i], pg.sde[i]]
        status, reasons = quality_gate(pg.snr[i], pg.sde[i])
        if (not np.isfinite(metrics).all() or not 0 < duration < period
                or not 0 < pg.depth[i] < 1 or pg.depth_err[i] <= 0):
            status, reasons = "failed", ["invalid_peak_geometry"]
        inside = np.abs(phase_distance_days(tv, period, epoch)) < duration / 2 if status != "failed" else np.zeros(len(tv), bool)
        cycles = np.floor((tv[inside] - epoch) / period + 0.5)
        cycle_ids, cycle_counts = np.unique(cycles, return_counts=True)
        sector_stats = []
        if sectors is not None and status != "failed":
            for sid in input_sectors:
                group = sectors[valid] == sid
                ni, no = int((group & inside).sum()), int((group & ~inside).sum())
                depth = float(np.mean(fv[group & ~inside]) - np.mean(fv[group & inside])) if ni and no else None
                error = pg.config["scatter"] * np.sqrt(1 / ni + 1 / no) if ni and no else None
                sector_stats.append(dict(sector=int(sid), n_in_transit=ni, n_out_transit=no,
                                         depth=depth, snr=depth / error if error else None))
        expected = None
        if baseline is not None and status != "failed":
            expected = int((np.abs(phase_distance_days(baseline, period, epoch)) < duration / 2).sum())
        dropped = float(1 - inside.sum() / expected) if expected else None
        peaks.append(dict(rank=rank, period_days=float(period), epoch_btjd=float(epoch),
                          duration_hours=float(duration * 24), depth=float(pg.depth[i]),
                          depth_err=float(pg.depth_err[i]), power=float(pg.power[i]),
                          sde=float(pg.sde[i]), snr=float(pg.snr[i]), status=status, reasons=reasons,
                          n_transits=len(cycle_ids), n_in_transit=int(inside.sum()),
                          transit_counts=cycle_counts.tolist(), sector_stats=sector_stats,
                          sector_consistency_status="unavailable" if sectors is None else
                          "not_applicable" if len(input_sectors) == 1 else "not_evaluated",
                          mask_dropped_fraction=dropped,
                          diagnostic_reasons=["sector_threshold_not_defined", "mask_threshold_not_defined"] +
                          (["baseline_time_unavailable"] if baseline is None else [])))
    accepted = [peak for peak in peaks if peak["status"] == "accepted"]
    # A failed peak must not masquerade as a successful empty candidate set.
    if any(peak["status"] == "failed" for peak in peaks):
        status = "failed"
        accepted = []
    else:
        status = "ok" if accepted else "no_quality_peak"
    return dict(status=status, peaks=peaks, accepted_peaks=accepted, periodogram=pg,
                input_snapshot_id=input_snapshot_id, preprocessing_version=preprocessing_version,
                search_input_sha256=_search_input_sha256(t, f, sectors, baseline),
                bls_config_version=SEARCH_VERSION, candidate_quality_version=QUALITY_VERSION,
                n_input=len(t), n_valid=int(valid.sum()), n_accepted=len(accepted))

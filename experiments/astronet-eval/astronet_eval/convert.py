# -*- coding: utf-8 -*-
"""fixture 곡선 → 42 채택 전처리 → 후보별 201/61 view NPZ.

흐름
1. `prepare_curve`: target 의 SPOC FITS 를 tess-fixture 규칙(QUALITY==0·Sector 중앙값 정규화)으로 바탕곡선을 만들고
   tess-bench `preprocess` 의 채택 설정(biweight 1일)으로 detrending 한다. 합성 잡음 곡선(seed)도 같은 전처리를 거친다.
2. `complete_geometry`: epoch·duration 이 없는 후보(EB)는 알려진 주기에서 BLS 로 채운다.
3. `junk_candidates`: 잡음 곡선의 최강 피크(junk), PC/EB 를 astro-kernel 로 제거한 실제 잔차의 최강 피크(junk_unverified).
4. `convert_candidate`: 후보 기하로 view 를 만들어 NPZ 로 저장한다. 실패는 사유와 함께 기록하고 점수 0 으로 대체하지 않는다.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from astro_kernel import TransitModelError, remove_transit_models
from tess_bench.preprocess import Setting, preprocess
from tess_fixture.lightcurve import Baseline, build_baseline, load_sector, synthetic_noise_baseline

from . import bls
from .labels import Candidate, split_for_tic
from .views import ViewFailure, ViewSpec, Views, make_views


@dataclass
class PreparedCurve:
    """전처리가 끝난 곡선 하나. time·flux 는 kept 점만(NaN 없음)."""
    baseline_id: str
    tic_id: int
    sectors: tuple[int, ...]
    time: np.ndarray
    flux: np.ndarray
    n_baseline_points: int
    n_kept: int
    preprocess_status: str
    preprocess_failures: list[dict] = field(default_factory=list)


def load_target_curves(target, raw_dir: Path):
    from tess_fixture.targets import iter_products
    curves = []
    for _, sector, filename, _url in iter_products((target,)):
        path = raw_dir / target.key / filename
        if not path.is_file():
            raise FileNotFoundError(f"missing {path}; run `python -m tess_fixture download --target {target.key}` in tess-fixture first")
        curves.append(load_sector(path))
    return curves


def prepare_curve(baseline: Baseline, baseline_id: str, setting: Setting) -> PreparedCurve:
    result = preprocess(baseline.time, baseline.flux, baseline.sector_of_point, setting)
    kept = result.kept & np.isfinite(result.flux_det)
    return PreparedCurve(baseline_id=baseline_id, tic_id=baseline.tic_id, sectors=baseline.sectors,
                         time=result.time[kept], flux=result.flux_det[kept], n_baseline_points=baseline.n_valid,
                         n_kept=int(kept.sum()), preprocess_status=result.status, preprocess_failures=list(result.failures))


def prepare_target(target, raw_dir: Path, setting: Setting, noise_seeds: list[int]) -> dict[str, PreparedCurve]:
    """<target>-real 과 <target>-noise<seed> 곡선을 같은 전처리로 준비한다."""
    curves = load_target_curves(target, raw_dir)
    real = build_baseline(curves)
    out = {f"{target.key}-real": prepare_curve(real, f"{target.key}-real", setting)}
    for seed in noise_seeds:
        bid = f"{target.key}-noise{seed}"
        out[bid] = prepare_curve(synthetic_noise_baseline(real, seed=seed), bid, setting)
    return out


# --------------------------------------------------------------------------- 기하 보완·junk 후보

def complete_geometry(candidate: Candidate, curve: PreparedCurve) -> Candidate:
    """epoch·duration 이 없는 후보(EB)를 알려진 주기의 BLS 로 채운다. 이미 있으면 그대로."""
    if candidate.epoch_btjd is not None and candidate.duration_hours is not None:
        return candidate
    peak = bls.geometry_at_known_period(curve.time, curve.flux, candidate.period_days)
    candidate.epoch_btjd = peak.epoch_btjd
    candidate.duration_hours = peak.duration_days * 24.0
    candidate.depth_ppm = max(peak.depth, 0.0) * 1e6 if np.isfinite(peak.depth) else None
    candidate.geometry_source = "bls_at_known_period"
    return candidate


def junk_from_noise(target, curve: PreparedCurve, seed: int, junk_cfg: dict, *, training_overlap: str) -> Candidate:
    peak = bls.strongest_peak(curve.time, curve.flux, period_min_days=junk_cfg["period_min_days"],
                              n_periods=junk_cfg["n_periods"], durations_days=junk_cfg["durations_days"])
    return Candidate(
        candidate_id=f"{target.key}-junk-noise{seed}", label="junk", in_truth=True,
        label_source="tess-fixture synthetic_noise_baseline (white noise, no signal by construction)",
        label_snapshot=f"seed={seed}", tic_id=target.tic_id, target_key=target.key, baseline_id=curve.baseline_id,
        split=split_for_tic(target.tic_id), training_overlap=training_overlap, source_name=f"noise seed {seed}",
        period_days=peak.period_days, epoch_btjd=peak.epoch_btjd, duration_hours=peak.duration_days * 24.0,
        depth_ppm=max(peak.depth, 0.0) * 1e6, geometry_source="bls_strongest_peak",
        notes=f"bls_power={peak.power:.3f}" + (f", snr={peak.snr:.2f}" if peak.snr is not None else ""),
    )


def junk_from_residual(target, curve: PreparedCurve, known: list[Candidate], junk_cfg: dict, *,
                       training_overlap: str) -> tuple[Candidate | None, str]:
    """PC/EB 를 astro-kernel 로 나눠 제거한 뒤 최강 피크. 정답 집합에는 넣지 않는다. (후보, 비고) 반환."""
    models = []
    skipped = []
    for c in known:
        if c.epoch_btjd is None or c.duration_hours is None or c.depth_ppm is None or not (0 < c.depth_ppm < 1e6):
            skipped.append(c.candidate_id)
            continue
        models.append({"shape": "box", "candidate_id": c.candidate_id,
                       "parameters": {"period_days": c.period_days, "epoch_btjd": c.epoch_btjd,
                                      "duration_hours": c.duration_hours, "depth_ppm": c.depth_ppm}})
    try:
        residual = remove_transit_models(curve.time, curve.flux, models).flux_residual if models else curve.flux
    except TransitModelError as exc:
        return None, f"removal_failed:{exc.code}"
    try:
        peak = bls.strongest_peak(curve.time, residual, period_min_days=junk_cfg["period_min_days"],
                                  n_periods=junk_cfg["n_periods"], durations_days=junk_cfg["durations_days"])
    except ValueError as exc:
        return None, f"bls_failed:{exc}"
    note = f"removed={len(models)}" + (f", skipped_no_depth={skipped}" if skipped else "") + f", bls_power={peak.power:.3f}"
    return Candidate(
        candidate_id=f"{target.key}-junkunv-residual", label="junk_unverified", in_truth=False,
        label_source="strongest BLS peak of real curve after removing PC/EB with astro-kernel (may be a real unknown signal)",
        label_snapshot="derived", tic_id=target.tic_id, target_key=target.key, baseline_id=curve.baseline_id,
        split=split_for_tic(target.tic_id), training_overlap=training_overlap, source_name="residual peak",
        period_days=peak.period_days, epoch_btjd=peak.epoch_btjd, duration_hours=peak.duration_days * 24.0,
        depth_ppm=max(peak.depth, 0.0) * 1e6, geometry_source="bls_strongest_peak", notes=note,
    ), note


# --------------------------------------------------------------------------- view 변환

CONVERSION_COLUMNS = ("candidate_id", "label", "in_truth", "split", "tic_id", "baseline_id", "status", "reason",
                      "n_points", "n_in_transit", "n_empty_global_bins", "n_empty_local_bins",
                      "global_argmin_bin", "local_argmin_bin", "global_sha256", "local_sha256", "npz_path")
# global_argmin_bin: 201 bin 중 최솟값(정규화 후 -1) 위치. 통과가 접기 중심에 맞으면 100 근처.
# 멀리 있으면 epoch 외삽 오차나 신호가 잡음보다 약한 경우다. local 은 61 bin 중 30 근처가 정상.


def _sha(a: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(a).tobytes()).hexdigest()


def convert_candidate(candidate: Candidate, curve: PreparedCurve, spec: ViewSpec, npz_dir: Path) -> dict:
    """후보 하나를 NPZ 로. 실패하면 status=input_incomplete 와 reason 을 기록한다."""
    base = {"candidate_id": candidate.candidate_id, "label": candidate.label, "in_truth": "true" if candidate.in_truth else "false",
            "split": candidate.split, "tic_id": candidate.tic_id, "baseline_id": candidate.baseline_id,
            "n_points": "", "n_in_transit": "", "n_empty_global_bins": "", "n_empty_local_bins": "",
            "global_argmin_bin": "", "local_argmin_bin": "", "global_sha256": "", "local_sha256": "", "npz_path": ""}
    if candidate.epoch_btjd is None or candidate.duration_hours is None:
        return {**base, "status": "input_incomplete", "reason": "missing_geometry"}
    try:
        views: Views = make_views(curve.time, curve.flux, period_days=candidate.period_days, epoch_btjd=candidate.epoch_btjd,
                                  duration_days=candidate.duration_hours / 24.0, spec=spec)
    except ViewFailure as exc:
        return {**base, "status": "input_incomplete", "reason": exc.reason}
    npz_dir.mkdir(parents=True, exist_ok=True)
    path = npz_dir / f"{candidate.candidate_id}.npz"
    np.savez(path,
             global_view=views.global_view, local_view=views.local_view,
             tic_id=np.int64(candidate.tic_id), sectors=np.asarray(curve.sectors, dtype=np.int64),
             period=np.float64(candidate.period_days), duration=np.float64(candidate.duration_hours / 24.0),
             t0=np.float64(candidate.epoch_btjd),
             candidate_id=np.str_(candidate.candidate_id), label=np.str_(candidate.label))
    return {**base, "status": "ok", "reason": "", "n_points": views.n_points, "n_in_transit": views.n_in_transit,
            "n_empty_global_bins": views.n_empty_global_bins, "n_empty_local_bins": views.n_empty_local_bins,
            "global_argmin_bin": int(np.argmin(views.global_view)), "local_argmin_bin": int(np.argmin(views.local_view)),
            "global_sha256": _sha(views.global_view), "local_sha256": _sha(views.local_view), "npz_path": str(path)}

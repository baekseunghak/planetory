# -*- coding: utf-8 -*-
"""SPOC LC FITS 읽기와 주입용 바탕곡선 준비.

주입은 전처리(detrending) 전에, 기존 PoC `pipeline.clean` 의 첫 단계와 같은 규칙으로 만든
Sector별 정규화 flux 에 넣는다: QUALITY==0, TIME·PDCSAP_FLUX 유한값, Sector 중앙값으로 나눔.
이후 단계(detrending·clipping·BLS)는 벤치마크 Task 에서 다시 실행한다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass
class SectorCurve:
    tic_id: int
    sector: int
    filename: str
    time: np.ndarray          # BTJD (BJD - 2457000), day
    flux: np.ndarray          # PDCSAP_FLUX, e-/s
    flux_err: np.ndarray      # PDCSAP_FLUX_ERR, e-/s
    quality: np.ndarray       # QUALITY bit flags
    cadenceno: np.ndarray
    meta: dict


REQUIRED_TIME_META = ("TIMESYS", "BJDREFI", "BJDREFF", "TIMEUNIT", "TIMEDEL")


def load_sector(path: Path) -> SectorCurve:
    from astropy.io import fits

    with fits.open(path, memmap=False) as hdul:
        primary = hdul[0].header
        table = hdul[1].data
        lc_header = hdul[1].header
        meta = {
            "TICID": int(primary["TICID"]),
            "SECTOR": int(primary["SECTOR"]),
            "CAMERA": int(primary.get("CAMERA", -1)),
            "CCD": int(primary.get("CCD", -1)),
            "PROCVER": str(primary.get("PROCVER", "")),
            "DATA_REL": int(primary.get("DATA_REL", -1)),
        }
        for key in REQUIRED_TIME_META:
            if key not in lc_header:
                raise ValueError(f"{path.name}: LIGHTCURVE header lacks {key}")
            meta[key] = lc_header[key]
        meta["FLUX_UNIT"] = _column_unit(lc_header, "PDCSAP_FLUX")
        return SectorCurve(
            tic_id=meta["TICID"], sector=meta["SECTOR"], filename=path.name,
            time=np.asarray(table["TIME"], dtype=np.float64),
            flux=np.asarray(table["PDCSAP_FLUX"], dtype=np.float64),
            flux_err=np.asarray(table["PDCSAP_FLUX_ERR"], dtype=np.float64),
            quality=np.asarray(table["QUALITY"], dtype=np.int64),
            cadenceno=np.asarray(table["CADENCENO"], dtype=np.int64),
            meta=meta,
        )


def _column_unit(header, name: str) -> str:
    for i in range(1, int(header.get("TFIELDS", 0)) + 1):
        if header.get(f"TTYPE{i}") == name:
            return str(header.get(f"TUNIT{i}", ""))
    return ""


@dataclass
class Baseline:
    """주입 대상 바탕곡선. Sector별 정규화 완료, detrending 전."""
    tic_id: int
    sectors: tuple[int, ...]
    time: np.ndarray
    flux: np.ndarray               # Sector 중앙값으로 나눈 상대 밝기
    sector_of_point: np.ndarray    # 각 점의 Sector
    normalization_median: dict[int, float]
    n_raw: int
    n_valid: int
    source_files: tuple[str, ...]

    @property
    def robust_scatter(self) -> float:
        med = np.median(self.flux)
        return float(1.4826 * np.median(np.abs(self.flux - med)))


def quality_keep_mask(quality: np.ndarray, quality_bitmask: int | None) -> np.ndarray:
    """quality_bitmask 가 None 이면 PoC 규칙(QUALITY == 0), 정수면 해당 비트가 하나도 켜지지 않은 점만 남긴다."""
    if quality_bitmask is None:
        return quality == 0
    return (quality & int(quality_bitmask)) == 0


def build_baseline(curves: list[SectorCurve], quality_bitmask: int | None = None) -> Baseline:
    """PoC clean() 첫 단계 재현: quality 선택, 유한값, Sector 중앙값 정규화, 시간 정렬.

    quality_bitmask 기본값 None 은 QUALITY == 0 (PoC 와 동일). 전처리 벤치마크에서 공식 비트마스크를 비교할 때만 정수를 준다.
    """
    if not curves:
        raise ValueError("no sector curves")
    tic_ids = {c.tic_id for c in curves}
    if len(tic_ids) != 1:
        raise ValueError(f"mixed TIC ids: {tic_ids}")
    sectors = [c.sector for c in curves]
    if len(set(sectors)) != len(sectors):
        raise ValueError(f"duplicate sectors: {sectors}")

    times, fluxes, sector_col = [], [], []
    medians: dict[int, float] = {}
    n_raw = 0
    for curve in sorted(curves, key=lambda c: c.sector):
        n_raw += len(curve.time)
        keep = quality_keep_mask(curve.quality, quality_bitmask) & np.isfinite(curve.time) & np.isfinite(curve.flux)
        t, f = curve.time[keep], curve.flux[keep]
        order = np.argsort(t)
        t, f = t[order], f[order]
        med = float(np.median(f)) if len(f) else float("nan")
        if not (np.isfinite(med) and med > 0):
            raise ValueError(f"sector {curve.sector}: invalid normalization median {med}")
        medians[curve.sector] = med
        times.append(t)
        fluxes.append(f / med)
        sector_col.append(np.full(len(t), curve.sector, dtype=np.int64))

    time = np.concatenate(times)
    flux = np.concatenate(fluxes)
    sector_of_point = np.concatenate(sector_col)
    order = np.argsort(time, kind="stable")
    return Baseline(
        tic_id=curves[0].tic_id, sectors=tuple(sorted(sectors)),
        time=time[order], flux=flux[order], sector_of_point=sector_of_point[order],
        normalization_median=medians, n_raw=n_raw, n_valid=int(len(time)),
        source_files=tuple(c.filename for c in sorted(curves, key=lambda c: c.sector)),
    )


def synthetic_noise_baseline(reference: Baseline, seed: int, scatter: float | None = None) -> Baseline:
    """실제 바탕곡선의 시각·공백 구조를 유지하고 밝기만 백색 잡음으로 바꾼 무신호 대조 곡선.

    실제 곡선은 알려지지 않은 신호가 있을 수 있으므로 순수 음성 정답은 이 합성 곡선으로만 정의한다.
    """
    rng = np.random.default_rng(seed)
    sigma = reference.robust_scatter if scatter is None else scatter
    flux = 1.0 + rng.normal(0.0, sigma, size=reference.time.shape)
    return Baseline(
        tic_id=reference.tic_id, sectors=reference.sectors,
        time=reference.time.copy(), flux=flux, sector_of_point=reference.sector_of_point.copy(),
        normalization_median={s: 1.0 for s in reference.sectors},
        n_raw=reference.n_raw, n_valid=reference.n_valid,
        source_files=tuple(f"synthetic-noise(seed={seed}, sigma={sigma:.3e}) from {f}" for f in reference.source_files),
    )

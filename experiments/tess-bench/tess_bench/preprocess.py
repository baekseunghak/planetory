# -*- coding: utf-8 -*-
"""전처리 설정과 실행.

PoC `pipeline.clean` 의 단계를 설정으로 분리했다.
  품질 선택(quality_bitmask) → 유한값 → Sector 중앙값 정규화   ... tess_fixture.lightcurve.build_baseline 이 담당
  → 구간 분리(gap_days, split_sectors) → 구간별 detrending(savgol | biweight) → 위쪽 sigma clipping

PoC 와 같은 값이 기본이다: 공백 0.5일, Savitzky–Golay 2일 창(2차, 홀수·최소 11점), 위쪽 5σ, 최소 500점.
detrending 결과가 유한하지 않거나 0 이하인 점은 실패 사유와 함께 NaN 으로 남긴다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

SETTING_FIELDS = ("quality_bitmask", "gap_days", "split_sectors", "detrend_method", "window_days",
                  "sigma_upper", "min_points", "biweight_stride")


@dataclass(frozen=True)
class Setting:
    setting_id: str
    factor: str = "baseline"
    description: str = ""
    quality_bitmask: int | None = None
    gap_days: float = 0.5
    split_sectors: bool = False
    detrend_method: str = "savgol"          # savgol | biweight | none
    window_days: float = 2.0
    sigma_upper: float = 5.0
    min_points: int = 500
    biweight_stride: int = 10

    def params(self) -> dict:
        return {k: getattr(self, k) for k in SETTING_FIELDS}


def load_settings(path: Path, only: list[str] | None = None) -> tuple[dict, list[Setting]]:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    defaults = cfg.get("defaults", {})
    settings: list[Setting] = []
    for raw in cfg["settings"]:
        merged = {**defaults, **{k: v for k, v in raw.items() if k in SETTING_FIELDS}}
        settings.append(Setting(setting_id=raw["setting_id"], factor=raw.get("factor", "baseline"),
                                description=raw.get("description", ""), **merged))
    ids = [s.setting_id for s in settings]
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate setting_id in {path.name}")
    if only:
        unknown = set(only) - set(ids)
        if unknown:
            raise KeyError(f"unknown setting id(s): {sorted(unknown)}; available: {ids}")
        settings = [s for s in settings if s.setting_id in only]
    for s in settings:
        if s.detrend_method not in ("savgol", "biweight", "none"):
            raise ValueError(f"{s.setting_id}: unknown detrend_method {s.detrend_method}")
    return cfg, settings


# ---------------------------------------------------------------------------- 구간 분리

def segment_indices(t: np.ndarray, sector: np.ndarray, gap_days: float, split_sectors: bool) -> list[np.ndarray]:
    """시간 공백(gap_days 초과) 에서 끊고, split_sectors 면 Sector 가 바뀌는 자리에서도 끊는다. 입력은 시간순."""
    if len(t) == 0:
        return []
    cut = np.diff(t) > gap_days
    if split_sectors:
        cut |= np.diff(sector) != 0
    return np.split(np.arange(len(t)), np.where(cut)[0] + 1)


# ---------------------------------------------------------------------------- detrending 방법

def savgol_window_points(window_days: float, cadence_days: float) -> int:
    """PoC 규칙: 창 길이를 점 수로 바꾸고 홀수·최소 11 로 맞춘다."""
    return max(int(window_days / cadence_days) | 1, 11)


def savgol_trend(f: np.ndarray, window_pts: int) -> np.ndarray:
    from scipy.signal import savgol_filter
    return savgol_filter(f, window_pts, 2)


def biweight_location(x: np.ndarray, c: float = 6.0, iters: int = 3) -> float:
    """Tukey biweight 위치 추정. 튀는 점(통과 구간 포함)의 영향을 줄인 강건한 중심값."""
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return float("nan")
    m = float(np.median(x))
    for _ in range(iters):
        mad = np.median(np.abs(x - m))
        if mad == 0:
            return m
        u = (x - m) / (c * mad)
        w = (1 - u ** 2) ** 2
        w[np.abs(u) >= 1] = 0
        if w.sum() == 0:
            return m
        m = float(np.sum(w * x) / np.sum(w))
    return m


def biweight_trend(t: np.ndarray, f: np.ndarray, window_days: float, stride: int = 10) -> np.ndarray:
    """이동 창 biweight 추세. 계산 비용을 위해 stride 점마다 추정하고 선형 보간한다 (창 안의 점은 모두 사용)."""
    n = len(t)
    if n == 0:
        return f.copy()
    eval_idx = np.arange(0, n, max(stride, 1))
    if eval_idx[-1] != n - 1:
        eval_idx = np.append(eval_idx, n - 1)
    half = 0.5 * window_days
    lo = np.searchsorted(t, t[eval_idx] - half, side="left")
    hi = np.searchsorted(t, t[eval_idx] + half, side="right")
    centers = np.array([biweight_location(f[a:b]) for a, b in zip(lo, hi)])
    good = np.isfinite(centers)
    if good.sum() < 2:
        return np.full(n, np.median(f) if n else np.nan)
    return np.interp(t, t[eval_idx][good], centers[good])


# ---------------------------------------------------------------------------- 실행

@dataclass
class PreprocessResult:
    time: np.ndarray
    flux_in: np.ndarray            # 입력(정규화·주입 후) flux
    trend: np.ndarray              # 추정 추세 (실패 점은 NaN)
    flux_det: np.ndarray           # flux_in / trend, clipping 된 점과 실패 점은 NaN
    kept: np.ndarray               # 최종 사용 점
    segment_id: np.ndarray         # 점별 구간 번호
    segment_edges: np.ndarray      # 구간 시작·끝 시각 (2 x n_seg)
    cadence_days: float
    noise_scatter: float           # clipping 전 잔차의 robust scatter
    failures: list[dict] = field(default_factory=list)   # {segment_id, reason, n_points}
    status: str = "ok"             # ok | too_few_points


def preprocess(t: np.ndarray, f: np.ndarray, sector: np.ndarray, setting: Setting) -> PreprocessResult:
    """정규화(및 주입)된 곡선에 설정을 적용한다. 입력은 시간순, 유한값이어야 한다."""
    n = len(t)
    nan = np.full(n, np.nan)
    if n < setting.min_points:
        return PreprocessResult(t, f, nan, nan, np.zeros(n, bool), np.full(n, -1), np.empty((2, 0)),
                                float("nan"), float("nan"), [{"segment_id": -1, "reason": "too_few_points", "n_points": n}],
                                status="too_few_points")

    cadence = float(np.median(np.diff(t))) if n > 1 else float("nan")
    segs = segment_indices(t, sector, setting.gap_days, setting.split_sectors)
    trend = np.full(n, np.nan)
    seg_id = np.full(n, -1)
    failures: list[dict] = []
    edges = np.empty((2, len(segs)))
    for k, seg in enumerate(segs):
        seg_id[seg] = k
        edges[:, k] = (t[seg[0]], t[seg[-1]])
        fs = f[seg]
        if setting.detrend_method == "none":
            trend[seg] = 1.0
        elif setting.detrend_method == "savgol":
            window = savgol_window_points(setting.window_days, cadence)
            if len(seg) >= window:
                trend[seg] = savgol_trend(fs, window)
            else:
                trend[seg] = np.median(fs)
                failures.append({"segment_id": k, "reason": "short_segment_median_fallback", "n_points": int(len(seg))})
        else:
            if len(seg) >= 3:
                trend[seg] = biweight_trend(t[seg], fs, setting.window_days, setting.biweight_stride)
            else:
                trend[seg] = np.median(fs)
                failures.append({"segment_id": k, "reason": "short_segment_median_fallback", "n_points": int(len(seg))})
        bad = ~np.isfinite(trend[seg]) | (trend[seg] <= 0)
        if bad.any():
            trend[seg[bad]] = np.nan
            failures.append({"segment_id": k, "reason": "invalid_trend", "n_points": int(bad.sum())})

    with np.errstate(invalid="ignore", divide="ignore"):
        fd = f / trend
    valid = np.isfinite(fd)
    if valid.sum() == 0:
        return PreprocessResult(t, f, trend, nan, valid, seg_id, edges, cadence, float("nan"),
                                failures + [{"segment_id": -1, "reason": "no_valid_points", "n_points": 0}], status="no_valid_points")
    med = np.median(fd[valid])
    scatter = float(1.4826 * np.median(np.abs(fd[valid] - med)))
    kept = valid & (fd < 1 + setting.sigma_upper * scatter)
    flux_det = np.where(kept, fd, np.nan)
    return PreprocessResult(t, f, trend, flux_det, kept, seg_id, edges, cadence, scatter, failures)

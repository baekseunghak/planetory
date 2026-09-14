# -*- coding: utf-8 -*-
"""전처리 설정과 실행.

PoC `pipeline.clean` 의 단계를 설정으로 분리했다.
  품질 선택(quality_bitmask) → 유한값 → Sector 중앙값 정규화   ... tess_fixture.lightcurve.build_baseline 이 담당
  → 구간 분리(gap_days, split_sectors) → 구간별 detrending(savgol | biweight) → 위쪽 sigma clipping

PoC 와 같은 값이 기본이다: 공백 0.5일, Savitzky–Golay 2일 창(2차, 홀수·최소 11점), 위쪽 5σ, 최소 500점.
detrending 결과가 유한하지 않거나 0 이하인 점은 실패 사유와 함께 NaN 으로 남긴다.

설정 1.1.0 추가 요인:
  edge_mask_hours   구간 시작·끝 N 시간을 추세 추정과 결과에서 제외 (궤도 근점·Sector 시작 산란광 구간 대응)
  stage1_*          2단계 detrending: 긴 창(1단계)으로 큰 변동을 지운 뒤 짧은 창(2단계)으로 잔여를 지움. trend = trend1 × trend2

"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

SETTING_FIELDS = ("quality_bitmask", "gap_days", "split_sectors", "detrend_method", "window_days",
                  "sigma_upper", "min_points", "biweight_stride", "edge_mask_hours",
                  "stage1_method", "stage1_window_days")


@dataclass(frozen=True)
class Setting:
    setting_id: str
    factor: str = "baseline"
    description: str = ""
    quality_bitmask: int | None = None
    gap_days: float = 0.5
    split_sectors: bool = False
    detrend_method: str = "savgol"          # savgol | biweight | none  (2단계면 2단계 방법)
    window_days: float = 2.0                # 단일 단계 창, 2단계면 2단계 창
    sigma_upper: float = 5.0
    min_points: int = 500
    biweight_stride: int = 10
    edge_mask_hours: float = 0.0            # 구간 시작·끝에서 제외할 시간. 0 이면 제외 없음 (PoC)
    stage1_method: str | None = None        # 2단계 detrending 의 1단계 방법. None 이면 단일 단계
    stage1_window_days: float | None = None # 1단계 창

    @property
    def two_stage(self) -> bool:
        return self.stage1_window_days is not None

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
        if s.two_stage and (s.stage1_method or s.detrend_method) not in ("savgol", "biweight"):
            raise ValueError(f"{s.setting_id}: stage1_method must be savgol or biweight")
        if s.edge_mask_hours < 0:
            raise ValueError(f"{s.setting_id}: edge_mask_hours must be >= 0")
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
    """Tukey biweight 위치 추정. 튀는 점(통과 구간 포함)의 영향을 줄인 강건한 중심값.

    이 벤치마크의 고정 구현이다: 초기값 중앙값, 척도는 MAD(정규화 상수 없음), 절단 c=6, 고정 3회 반복,
    MAD 가 0 이거나 가중치 합이 0 이면 현재 중심값을 그대로 반환. astropy.stats.biweight_location 이나 wotan 의
    구현과 초기값·반복 종료·척도 정의가 다를 수 있으며 동일하다고 가정하지 않는다.
    """
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
    """이동 창 biweight 추세. 계산 비용을 위해 stride 점마다 추정하고 선형 보간한다 (창 안의 점은 모두 사용).

    창은 평가점 시각 ±window_days/2 를 searchsorted 로 잡는다. 구간 시작·끝에서는 창이 한쪽만 채워진 채(패딩·반사 없음)
    계산하며, 평가점은 0, stride, 2·stride, … 와 마지막 점이다. 평가점 사이는 np.interp 선형 보간이다.
    """
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
    trend: np.ndarray              # 추정 추세 (실패 점·가장자리 제외 점은 NaN)
    flux_det: np.ndarray           # flux_in / trend, clipping 된 점과 실패·제외 점은 NaN
    kept: np.ndarray               # 최종 사용 점
    segment_id: np.ndarray         # 점별 구간 번호
    segment_edges: np.ndarray      # 구간 시작·끝 시각 (2 x n_seg)
    cadence_days: float
    noise_scatter: float           # clipping 전 잔차의 robust scatter
    failures: list[dict] = field(default_factory=list)   # {segment_id, reason, n_points}
    status: str = "ok"             # ok | too_few_points
    edge_masked: np.ndarray | None = None                 # 가장자리 마스크로 제외된 점

    @property
    def n_edge_masked(self) -> int:
        return int(self.edge_masked.sum()) if self.edge_masked is not None else 0


def _segment_trend(t_seg: np.ndarray, f_seg: np.ndarray, method: str, window_days: float, cadence: float,
                   stride: int, k: int, failures: list[dict]) -> np.ndarray:
    """구간 하나의 추세. 창보다 짧은 구간은 중앙값으로 대체하고 사유를 기록한다."""
    if method == "none":
        return np.ones_like(f_seg)
    if method == "savgol":
        window = savgol_window_points(window_days, cadence)
        if len(f_seg) >= window:
            return savgol_trend(f_seg, window)
    elif len(f_seg) >= 3:
        return biweight_trend(t_seg, f_seg, window_days, stride)
    failures.append({"segment_id": k, "reason": "short_segment_median_fallback", "n_points": int(len(f_seg))})
    return np.full(len(f_seg), np.median(f_seg))


def preprocess(t: np.ndarray, f: np.ndarray, sector: np.ndarray, setting: Setting) -> PreprocessResult:
    """정규화(및 주입)된 곡선에 설정을 적용한다. 입력은 시간순, 유한값이어야 한다.

    단계: 구간 분리 → (가장자리 제외) → [1단계 추세 → 나눔] → 추세 → 나눔 → 위쪽 clipping.
    가장자리 제외 점은 추세 추정에서도 빼고 결과에서도 NaN 으로 둔다.
    """
    n = len(t)
    nan = np.full(n, np.nan)
    if n < setting.min_points:
        return PreprocessResult(t, f, nan, nan, np.zeros(n, bool), np.full(n, -1), np.empty((2, 0)),
                                float("nan"), float("nan"), [{"segment_id": -1, "reason": "too_few_points", "n_points": n}],
                                status="too_few_points", edge_masked=np.zeros(n, bool))

    cadence = float(np.median(np.diff(t))) if n > 1 else float("nan")
    segs = segment_indices(t, sector, setting.gap_days, setting.split_sectors)
    trend = np.full(n, np.nan)
    seg_id = np.full(n, -1)
    edge_masked = np.zeros(n, dtype=bool)
    failures: list[dict] = []
    edges = np.empty((2, len(segs)))
    half_edge_days = setting.edge_mask_hours / 24.0
    for k, seg in enumerate(segs):
        seg_id[seg] = k
        edges[:, k] = (t[seg[0]], t[seg[-1]])
        if half_edge_days > 0:
            inner = ((t[seg] - t[seg[0]]) >= half_edge_days) & ((t[seg[-1]] - t[seg]) >= half_edge_days)
            edge_masked[seg[~inner]] = True
            seg = seg[inner]
            if len(seg) == 0:
                failures.append({"segment_id": k, "reason": "segment_fully_edge_masked", "n_points": 0})
                continue
        ts, fs = t[seg], f[seg]
        if setting.two_stage:
            stage1 = _segment_trend(ts, fs, setting.stage1_method or setting.detrend_method,
                                    float(setting.stage1_window_days), cadence, setting.biweight_stride, k, failures)
            with np.errstate(invalid="ignore", divide="ignore"):
                f1 = fs / stage1
            ok1 = np.isfinite(f1) & (stage1 > 0)
            stage2 = np.full(len(seg), np.nan)
            if ok1.sum() >= 3:
                stage2[ok1] = _segment_trend(ts[ok1], f1[ok1], setting.detrend_method, setting.window_days,
                                             cadence, setting.biweight_stride, k, failures)
            trend[seg] = stage1 * stage2
        else:
            trend[seg] = _segment_trend(ts, fs, setting.detrend_method, setting.window_days, cadence,
                                        setting.biweight_stride, k, failures)
        bad = ~np.isfinite(trend[seg]) | (trend[seg] <= 0)
        if bad.any():
            trend[seg[bad]] = np.nan
            failures.append({"segment_id": k, "reason": "invalid_trend", "n_points": int(bad.sum())})

    with np.errstate(invalid="ignore", divide="ignore"):
        fd = f / trend
    valid = np.isfinite(fd)
    if valid.sum() == 0:
        return PreprocessResult(t, f, trend, nan, valid, seg_id, edges, cadence, float("nan"),
                                failures + [{"segment_id": -1, "reason": "no_valid_points", "n_points": 0}],
                                status="no_valid_points", edge_masked=edge_masked)
    med = np.median(fd[valid])
    scatter = float(1.4826 * np.median(np.abs(fd[valid] - med)))
    kept = valid & (fd < 1 + setting.sigma_upper * scatter)
    flux_det = np.where(kept, fd, np.nan)
    return PreprocessResult(t, f, trend, flux_det, kept, seg_id, edges, cadence, scatter, failures,
                            edge_masked=edge_masked)

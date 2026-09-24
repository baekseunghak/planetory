"""합성 관측 곡선.

2분 간격 원본 시각(품질 필터·산란광 구간·궤도 전송 공백 반영)에 잡음을 만들고, astro-kernel 의
114 비닝 규칙(`bin_sector`)으로 10분 세그먼트를 만든 뒤 bin 중심에서 통과 모양을 곱한다.
bin 평균에 모델 값을 곱하는 것은 원본 점마다 같은 값을 곱한 뒤 평균한 것과 같다. box 로 넣은 신호는 같은
box 모델로 나누면(서비스 잔차 계산과 같은 식) 잡음만 남고, U자·V자로 넣은 신호는 실제 곡선처럼 가장자리가 남는다.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np
from astro_kernel import model_flux, phase_distance_days
from astro_kernel.segmentation import bin_sector

from .catalog import GENERATOR_VERSION, Signal, Star

SECTOR_ONE_START_BTJD = 1325.30      # TESS 1섹터 시작 근사값
SECTOR_LENGTH_DAYS = 27.40
ORBIT_DAYS = 12.90                   # 궤도 하나의 관측 길이
DOWNLINK_DAYS = 1.00                 # 두 궤도 사이 전송 공백
CADENCE_MINUTES = 2.0
QUALITY_DROP_FRACTION = 0.015        # 품질 플래그로 빠지는 점
SCATTERED_LIGHT = ((0.30, 0.22), (0.78, 0.18))   # (섹터 안 위치 비율, 길이 일)
RESIDUAL_MODEL_VERSION = "box-divide-v0"
# U자는 가장자리가 선형으로 들어가고 바닥이 주연 감광으로 둥글다. V자는 스치는 식의 삼각형이다.
# 전체 지속시간(T14)은 box 지속시간보다 길고, box 창 안의 평균 깊이가 후보 깊이와 같다.
SHAPE_TOTAL_RATIO = {"u": 1.3, "v": 1.4}   # T14 / box 지속시간
U_FLAT_RATIO = 0.6                         # 바닥(T23) / T14
U_LIMB_DARKENING = 0.4                     # 바닥 가운데가 바닥 끝보다 깊은 정도

_SEED = int.from_bytes(hashlib.sha256(GENERATOR_VERSION.encode()).digest()[:8], "little")


@dataclass
class SectorCurve:
    sector: int
    raw_time: np.ndarray             # 품질 필터를 통과한 원본 시각
    start_btjd: float                # 첫 bin 시작 = 첫 원본 시각
    centers: np.ndarray              # bin 중심 시각
    flux: np.ndarray                 # 통과 모델을 곱한 bin 평균. 빈 bin 은 NaN
    gaps: list[list[int]]


def raw_times(sector: int, rng: np.random.Generator) -> np.ndarray:
    start = SECTOR_ONE_START_BTJD + SECTOR_LENGTH_DAYS * (sector - 1) + 0.25
    step = CADENCE_MINUTES / 1440
    n_orbit = int(round(ORBIT_DAYS / step))
    t = np.concatenate([start + np.arange(n_orbit) * step,
                        start + ORBIT_DAYS + DOWNLINK_DAYS + np.arange(n_orbit) * step])
    keep = rng.random(t.size) >= QUALITY_DROP_FRACTION
    keep[0] = keep[-1] = True        # 첫 시각이 비닝 격자의 기준이라 고정한다
    span = 2 * ORBIT_DAYS + DOWNLINK_DAYS
    for position, length in SCATTERED_LIGHT:
        a = start + position * span
        keep &= ~((t >= a) & (t < a + length))
    return t[keep]


def epoch_of(signal: Signal, data_start: float) -> float:
    return round(data_start + signal.phase * signal.period_days, 5)


def transit_model(signal: Signal, epoch: float) -> dict:
    """Gold candidates.transit_model 계약 1.0 (candidate_id 는 적재할 때 DB id 로 채운다)."""
    return {"shape": "box",
            "parameters": {"period_days": signal.period_days, "epoch_btjd": epoch,
                           "duration_hours": signal.duration_hours, "depth_ppm": float(signal.depth_ppm)},
            "baseline": {"kind": "unity"},
            "residual_model_version": RESIDUAL_MODEL_VERSION}


def shape_profile(shape: str, u: np.ndarray) -> np.ndarray:
    """통과 중심에서의 거리 u(T14 반폭 단위, 0~1)에 대한 상대 깊이."""
    if shape == "v":
        return np.clip(1.0 - u, 0.0, None)
    floor_edge = 1.0 - U_LIMB_DARKENING * U_FLAT_RATIO ** 2
    return np.where(u <= U_FLAT_RATIO, 1.0 - U_LIMB_DARKENING * u ** 2,
                    np.where(u < 1.0, floor_edge * (1.0 - u) / (1.0 - U_FLAT_RATIO), 0.0))


def shape_scale(shape: str) -> float:
    """box 창(|거리| < box 지속시간/2) 안의 평균 상대 깊이가 1 이 되게 하는 배율."""
    u = np.linspace(0.0, 1.0 / SHAPE_TOTAL_RATIO[shape], 20_001)
    return float(1.0 / np.mean(shape_profile(shape, u)))


def injected_flux(centers: np.ndarray, signals: tuple[Signal, ...], epochs: dict[str, float]) -> np.ndarray:
    out = np.ones_like(centers)
    for signal in signals:
        epoch = epochs[signal.key]
        if signal.shape != "box":
            half_total = SHAPE_TOTAL_RATIO[signal.shape] * signal.duration_hours / 48
            u = np.abs(phase_distance_days(centers, signal.period_days, epoch)) / half_total
            out *= 1.0 - signal.depth_ppm / 1e6 * shape_scale(signal.shape) * shape_profile(signal.shape, u)
            continue
        if not signal.odd_even_ppm:
            out *= model_flux(centers, transit_model(signal, epoch))
            continue
        # 홀짝 깊이 차는 후보 모델(평균 깊이)이 표현하지 못하는 오검출 근거다.
        inside = np.abs(phase_distance_days(centers, signal.period_days, epoch)) < signal.duration_hours / 48
        number = np.rint((centers - epoch) / signal.period_days).astype(np.int64)
        depth = signal.depth_ppm + np.where(number % 2 == 0, signal.odd_even_ppm, -signal.odd_even_ppm)
        out[inside] *= 1.0 - depth[inside] / 1e6
    return out


def star_curves(star: Star) -> tuple[list[SectorCurve], dict[str, float]]:
    rngs = {s: np.random.default_rng([_SEED, star.tic_id, s]) for s in star.sectors}
    times = {s: raw_times(s, rngs[s]) for s in star.sectors}
    data_start = min(float(t[0]) for t in times.values())
    epochs = {signal.key: epoch_of(signal, data_start) for signal in star.signals}
    sigma_raw = star.noise_ppm * 1e-6 * np.sqrt(10 / CADENCE_MINUTES)   # 10분 bin 에 원본 5점
    curves = []
    for sector in sorted(star.sectors):
        t = times[sector]
        noise = 1.0 + rngs[sector].normal(0.0, sigma_raw, t.size)
        segment = bin_sector(t, noise)
        centers = segment.centers
        curves.append(SectorCurve(sector=sector, raw_time=t, start_btjd=segment.start_btjd, centers=centers,
                                  flux=segment.flux * injected_flux(centers, star.signals, epochs),
                                  gaps=segment.gaps))
    return curves, epochs

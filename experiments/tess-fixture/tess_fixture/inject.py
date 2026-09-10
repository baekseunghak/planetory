# -*- coding: utf-8 -*-
"""합성 감광 주입: 격자 → 주입 목록(catalog) → 주입 곡선.

- 모델: box (기본). 밝기에 (1 - depth·box(phase)) 를 곱한다. PoC `box_transit_model` 과 같은 정의.
- 주입 위치: Sector별 정규화 flux (detrending 전). 이미 detrending 된 곡선에 넣는 실험은 별도 구분.
- 재현성: 목록 순서·주입 ID·seed 를 catalog 에 기록한다. 주입 자체는 결정적이며 seed 는 잡음 바탕곡선에만 쓴다.
"""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .lightcurve import Baseline


@dataclass(frozen=True)
class Signal:
    period_days: float
    duration_hours: float
    depth_ppm: float
    phase_fraction: float

    @property
    def depth(self) -> float:
        return self.depth_ppm * 1e-6

    @property
    def duration_days(self) -> float:
        return self.duration_hours / 24.0

    def t0(self, t_min: float) -> float:
        return t_min + self.phase_fraction * self.period_days


@dataclass(frozen=True)
class InjectionRow:
    injection_id: str
    set_id: str
    baseline_id: str
    signal_index: int        # 다중 신호에서 몇 번째 신호인지 (단일은 0)
    group_id: str            # 같은 곡선에 함께 들어간 신호 묶음 (단일은 injection_id 와 같음)
    period_days: float
    duration_hours: float
    depth_ppm: float
    phase_fraction: float
    phase_label: str
    t0_btjd: float
    model: str
    n_transits_in_window: int
    n_points_in_transit: int


def load_grid(path: Path) -> dict:
    grid = json.loads(path.read_text(encoding="utf-8"))
    for key in ("grid_id", "version", "model", "period_days", "duration_hours", "depth_ppm", "phase_fraction"):
        if key not in grid:
            raise ValueError(f"grid {path.name} lacks '{key}'")
    return grid


def grid_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def single_signal_grid(grid: dict) -> list[tuple[str, Signal]]:
    """(phase_label, Signal) 목록. 순서는 period → duration → depth → phase 로 고정."""
    out: list[tuple[str, Signal]] = []
    for period in grid["period_days"]:
        for duration in grid["duration_hours"]:
            for depth in grid["depth_ppm"]:
                for label, fraction in grid["phase_fraction"].items():
                    out.append((label, Signal(float(period), float(duration), float(depth), float(fraction))))
    return out


def box_model(t: np.ndarray, signal: Signal, t0: float) -> np.ndarray:
    """통과 중 (1 - depth), 밖은 1. 위상 거리 기준 box."""
    phase = ((t - t0) / signal.period_days + 0.5) % 1.0 - 0.5
    in_transit = np.abs(phase * signal.period_days) < 0.5 * signal.duration_days
    model = np.ones_like(t)
    model[in_transit] = 1.0 - signal.depth
    return model


def _transit_stats(t: np.ndarray, signal: Signal, t0: float) -> tuple[int, int]:
    model = box_model(t, signal, t0)
    in_transit = model < 1.0
    # 관측점이 실제로 있는 통과 회차 수
    epochs = np.round((t[in_transit] - t0) / signal.period_days).astype(int)
    return int(len(np.unique(epochs))), int(in_transit.sum())


def make_injection_id(set_id: str, baseline_id: str, group_index: int, signal_index: int) -> str:
    return f"{set_id}-{baseline_id}-g{group_index:03d}-s{signal_index}"


def build_catalog(grid: dict, baseline: Baseline, baseline_id: str, set_id: str,
                  include_multi: bool = True) -> list[InjectionRow]:
    t_min = float(baseline.time.min())
    rows: list[InjectionRow] = []
    group_index = 0
    for label, signal in single_signal_grid(grid):
        t0 = signal.t0(t_min)
        n_tr, n_pts = _transit_stats(baseline.time, signal, t0)
        iid = make_injection_id(set_id, baseline_id, group_index, 0)
        rows.append(InjectionRow(iid, set_id, baseline_id, 0, iid, signal.period_days, signal.duration_hours,
                                 signal.depth_ppm, signal.phase_fraction, label, t0, grid["model"], n_tr, n_pts))
        group_index += 1
    if include_multi:
        for pair in grid.get("multi_signal_pairs", []):
            gid = f"{set_id}-{baseline_id}-g{group_index:03d}"
            for k, spec in enumerate(pair["signals"]):
                signal = Signal(float(spec["period_days"]), float(spec["duration_hours"]),
                                float(spec["depth_ppm"]), float(spec["phase_fraction"]))
                t0 = signal.t0(t_min)
                n_tr, n_pts = _transit_stats(baseline.time, signal, t0)
                rows.append(InjectionRow(make_injection_id(set_id, baseline_id, group_index, k), set_id, baseline_id,
                                         k, gid, signal.period_days, signal.duration_hours, signal.depth_ppm,
                                         signal.phase_fraction, pair["pair_id"], t0, grid["model"], n_tr, n_pts))
            group_index += 1
    return rows


def inject_group(baseline: Baseline, rows: list[InjectionRow]) -> np.ndarray:
    """같은 group_id 의 신호들을 모델 곱으로 한 곡선에 넣는다."""
    flux = baseline.flux.copy()
    for row in rows:
        signal = Signal(row.period_days, row.duration_hours, row.depth_ppm, row.phase_fraction)
        flux *= box_model(baseline.time, signal, row.t0_btjd)
    return flux


def write_catalog(rows: list[InjectionRow], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(asdict(rows[0]).keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def write_injected_curves(baseline: Baseline, rows: list[InjectionRow], out_dir: Path) -> list[Path]:
    """group 별 NPZ 저장 (Git 제외 경로). flux 는 float32, time 은 바탕곡선을 참조하도록 별도 파일 1개."""
    out_dir.mkdir(parents=True, exist_ok=True)
    base_path = out_dir / "baseline.npz"
    np.savez_compressed(base_path, time=baseline.time, flux=baseline.flux.astype(np.float32),
                        sector=baseline.sector_of_point)
    written = [base_path]
    groups: dict[str, list[InjectionRow]] = {}
    for row in rows:
        groups.setdefault(row.group_id, []).append(row)
    for gid, members in groups.items():
        flux = inject_group(baseline, members).astype(np.float32)
        path = out_dir / f"{gid}.npz"
        np.savez_compressed(path, flux=flux, injection_ids=np.array([m.injection_id for m in members]))
        written.append(path)
    return written

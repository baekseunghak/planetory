# -*- coding: utf-8 -*-
"""
분석 파이프라인 커널 — Silver 정제 + BLS + Phase Folding + Feature 추출

이 파일에는 Spark 의존성이 없다. 그게 핵심이다:
  같은 함수를 (1) 노트북에서 별 1개로 디버깅하고 (2) Spark Worker에서 수만 개에 적용한다.
  DS&AI가 여기를 고치면 DE는 아무것도 안 고쳐도 된다 (역할 경계와 정확히 일치).

Worker 의존성: numpy, scipy, astropy, pandas
"""
import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- Silver


def _segments(t, gap_days=0.5):
    """관측 공백으로 끊어진 연속 구간 인덱스. Detrending을 구간별로 해야 공백 경계에서 튀지 않는다."""
    return np.split(np.arange(len(t)), np.where(np.diff(t) > gap_days)[0] + 1)


def clean(df, savgol_window_days=2.0, sigma_upper=5.0, min_points=500):
    """Bronze -> Silver.

    quality!=0 제거 -> NaN 제거 -> observation_group(Quarter/Sector)별 정규화
    -> 구간별 Savitzky-Golay Detrending -> 위쪽만 sigma clip

    위쪽만 clip하는 이유: 아래쪽을 자르면 Transit 자체를 지운다.
    savgol 윈도(기본 2일)는 Transit duration(수 시간)보다 훨씬 길어야 신호가 보존된다.
    """
    from scipy.signal import savgol_filter

    n_raw = len(df)
    df = df[df["quality"] == 0].dropna(subset=["flux", "time"])
    if len(df) < min_points:
        return None, dict(raw=n_raw, reason="too_few_points")

    parts = []
    for _, grp in df.groupby("observation_group", sort=True):
        grp = grp.sort_values("time").copy()
        med = np.median(grp["flux"])
        if np.isfinite(med) and med > 0:
            grp["flux"] = grp["flux"] / med          # Quarter/Sector 경계 밝기 점프 보정
            parts.append(grp)
    if not parts:
        return None, dict(raw=n_raw, reason="no_valid_group")
    df = pd.concat(parts).sort_values("time")

    t = df["time"].to_numpy(np.float64)
    f = df["flux"].to_numpy(np.float64)
    cadence = float(np.median(np.diff(t)))
    window = max(int(savgol_window_days / cadence) | 1, 11)

    trend = np.ones_like(f)
    for seg in _segments(t):
        trend[seg] = savgol_filter(f[seg], window, 2) if len(seg) >= window else np.median(f[seg])
    fd = f / trend

    scatter = 1.4826 * np.median(np.abs(fd - np.median(fd)))
    keep = fd < 1 + sigma_upper * scatter
    return (t[keep], fd[keep]), dict(raw=n_raw, kept=int(keep.sum()),
                                     cadence_min=cadence * 1440, noise_ppm=scatter * 1e6)


# --------------------------------------------------------------------------- BLS + features


def bls_features(t, f, period_min=0.5, period_max=None, n_periods=20000, durations=None):
    """BLS 주기 탐색 -> Phase Folding -> AI 입력 Feature.

    period_max 기본값 = baseline/3 (Transit이 최소 3회 반복되어야 신뢰 가능).
    n_periods가 비용을 지배한다 — "분석 정밀도" 슬라이더가 조절해야 할 값이 바로 이것.
    """
    from astropy.timeseries import BoxLeastSquares

    baseline = float(t.max() - t.min())
    period_max = period_max or min(baseline / 3.0, 100.0)
    durations = np.asarray(durations if durations is not None else [0.05, 0.08, 0.12, 0.2])
    grid = np.linspace(period_min, period_max, n_periods)

    res = BoxLeastSquares(t, f).power(grid, durations)
    i = int(np.argmax(res.power))
    period = float(res.period[i])
    duration = float(res.duration[i])
    t0 = float(res.transit_time[i])
    depth = float(res.depth[i])

    phase = (t - t0 + 0.5 * period) % period - 0.5 * period      # Phase Folding
    in_transit = np.abs(phase) < 0.5 * duration
    out_transit = (np.abs(phase) > duration) & (np.abs(phase) < 3 * duration)

    scatter = (1.4826 * np.median(np.abs(f[out_transit] - np.median(f[out_transit])))
               if out_transit.sum() > 20 else float(np.std(f)))
    snr = float(depth / (scatter / np.sqrt(max(int(in_transit.sum()), 1)))) if scatter > 0 else 0.0

    epoch = np.floor((t - t0) / period + 0.5).astype(int)
    odd_mask, even_mask = in_transit & (epoch % 2 == 1), in_transit & (epoch % 2 == 0)
    d_odd = 1 - np.median(f[odd_mask]) if odd_mask.sum() > 5 else np.nan
    d_even = 1 - np.median(f[even_mask]) if even_mask.sum() > 5 else np.nan

    secondary = np.abs(np.abs(phase) - 0.5 * period) < 0.5 * duration

    return dict(
        period=period, depth=depth, duration_hr=duration * 24.0, t0=t0, snr=snr,
        bls_power=float(res.power[i]),
        odd_even_diff=float(abs(d_odd - d_even)) if np.isfinite(d_odd) and np.isfinite(d_even) else np.nan,
        secondary_depth=float(1 - np.median(f[secondary])) if secondary.sum() > 5 else np.nan,
        noise_level=scatter, n_in_transit=int(in_transit.sum()),
        n_transits=int(len(np.unique(epoch[in_transit]))),
        n_points=int(len(t)), baseline_days=baseline,
        n_periods=n_periods, period_max=period_max,
    )


def phase_distance(t, period, t0):
    """각 시각과 가장 가까운 주기적 통과 중심 사이의 거리(day)."""
    t = np.asarray(t, dtype=np.float64)
    if not np.isfinite(period) or period <= 0:
        raise ValueError("period는 0보다 큰 유한값이어야 합니다")
    return (t - float(t0) + 0.5 * period) % period - 0.5 * period


def box_transit_model(t, period, t0, duration, depth):
    """기준 밝기 1인 BLS 상자 통과 모델.

    마스킹과 달리 모델 나눗셈에 사용할 수 있어 다른 행성과 겹친 관측점을
    버리지 않는다.
    """
    if not np.isfinite(duration) or duration <= 0 or duration >= period:
        raise ValueError("duration은 0보다 크고 period보다 작아야 합니다")
    if not np.isfinite(depth) or not 0 <= depth < 1:
        raise ValueError("depth는 0 이상 1 미만이어야 합니다")
    model = np.ones_like(np.asarray(t, dtype=np.float64))
    model[np.abs(phase_distance(t, period, t0)) <= 0.5 * duration] = 1.0 - depth
    return model


def combined_box_model(t, candidates):
    """여러 후보의 곱셈형 통과 모델."""
    model = np.ones_like(np.asarray(t, dtype=np.float64))
    for candidate in candidates:
        model *= box_transit_model(
            t,
            float(candidate["period"]),
            float(candidate["t0"]),
            float(candidate["duration"]),
            float(candidate["depth"]),
        )
    return model


def residual_after_candidates(t, f, candidates, baseline=1.0):
    """후보 모델만 나누어 제거한 광도곡선. 모든 시각의 관측점을 보존한다."""
    f = np.asarray(f, dtype=np.float64)
    baseline = float(baseline)
    if not np.isfinite(baseline) or baseline <= 0:
        raise ValueError("baseline은 0보다 큰 유한값이어야 합니다")
    model = combined_box_model(t, candidates)
    if np.any(model <= 0):
        raise ValueError("통과 모델이 0 이하가 되어 나눗셈할 수 없습니다")
    return f / (baseline * model)


def isolate_candidate_signal(t, f, candidates, candidate_index, baseline=1.0):
    """다른 후보 모델만 나눠 특정 후보의 신호와 겹친 관측점을 보존한다."""
    candidates = [dict(candidate) for candidate in candidates]
    if not 0 <= int(candidate_index) < len(candidates):
        raise IndexError("candidate_index가 후보 범위를 벗어났습니다")
    other_candidates = [
        candidate for index, candidate in enumerate(candidates)
        if index != int(candidate_index)
    ]
    return residual_after_candidates(t, f, other_candidates, baseline=baseline)


def bls_periodogram(t, f, period_min=0.5, period_max=None, n_periods=8_000,
                    durations=None):
    """UI용 BLS periodogram과 각 주기에서의 최적 상자 변수를 반환한다."""
    from astropy.timeseries import BoxLeastSquares

    t = np.asarray(t, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    valid = np.isfinite(t) & np.isfinite(f)
    t, f = t[valid], f[valid]
    if len(t) < 20:
        raise ValueError("BLS 계산에 유효한 관측점이 부족합니다")

    baseline = float(t.max() - t.min())
    period_max = float(period_max or min(baseline / 2.5, 30.0))
    period_min = float(period_min)
    if not 0 < period_min < period_max:
        raise ValueError("0 < period_min < period_max 이어야 합니다")
    if n_periods < 100:
        raise ValueError("n_periods는 100 이상이어야 합니다")

    if durations is None:
        durations = np.geomspace(0.5 / 24.0, 8.0 / 24.0, 12)
    durations = np.asarray(durations, dtype=np.float64)
    durations = durations[np.isfinite(durations) & (durations > 0) & (durations < period_min)]
    if len(durations) == 0:
        raise ValueError("유효한 duration 후보가 없습니다")

    periods = np.linspace(period_min, period_max, int(n_periods))
    result = BoxLeastSquares(t, f).power(periods, durations)
    return {
        "periods": np.asarray(result.period, dtype=np.float64),
        "power": np.asarray(result.power, dtype=np.float64),
        "duration": np.asarray(result.duration, dtype=np.float64),
        "t0": np.asarray(result.transit_time, dtype=np.float64),
        "depth": np.asarray(result.depth, dtype=np.float64),
        "period_min": period_min,
        "period_max": period_max,
        "n_periods": int(n_periods),
        "time_baseline": baseline,
    }


def bls_period_candidates(periodogram, count=10):
    """BLS 격자에서 사람이 검토할 대표 주기 후보만 추린다.

    인접 격자점은 관측 시간축의 Rayleigh 주파수 분해능(1 / baseline)으로
    하나의 피크로 묶는다. 주기 차이가 아니라 주파수 차이를 사용하므로 P와
    2P 같은 조화 주기 후보는 별개로 남는다. 반환값에는 BLS가 내부적으로
    구한 t0/duration/depth나 원시 power/index를 노출하지 않는다.
    """
    from scipy.signal import find_peaks

    requested = min(max(int(count), 0), 10)
    if requested == 0:
        return []

    periods = np.asarray(periodogram["periods"], dtype=np.float64)
    power = np.asarray(periodogram["power"], dtype=np.float64)
    if periods.ndim != 1 or power.ndim != 1 or periods.shape != power.shape:
        raise ValueError("periods와 power는 길이가 같은 1차원 배열이어야 합니다")

    baseline = float(periodogram.get("time_baseline", np.nan))
    if not np.isfinite(baseline) or baseline <= 0:
        raise ValueError("time_baseline은 0보다 큰 유한값이어야 합니다")

    finite = np.isfinite(periods) & (periods > 0) & np.isfinite(power)
    finite_indices = np.flatnonzero(finite)
    if len(finite_indices) == 0:
        return []

    masked_power = np.where(finite, power, -np.inf)
    peak_indices, _ = find_peaks(masked_power)
    candidates = set(int(index) for index in peak_indices)
    candidates.add(int(finite_indices[np.argmax(power[finite_indices])]))

    # scipy.signal.find_peaks는 배열 양 끝을 피크로 취급하지 않는다.
    first, last = int(finite_indices[0]), int(finite_indices[-1])
    if first == 0 and (len(periods) == 1 or masked_power[first] >= masked_power[first + 1]):
        candidates.add(first)
    if last == len(periods) - 1 and (
        len(periods) == 1 or masked_power[last] >= masked_power[last - 1]
    ):
        candidates.add(last)

    ranked = sorted(candidates, key=lambda index: (-power[index], periods[index], index))
    min_frequency_separation = 1.0 / baseline

    finite_periods = np.sort(np.unique(periods[finite]))
    period_steps = np.diff(finite_periods)
    period_steps = period_steps[np.isfinite(period_steps) & (period_steps > 0)]
    grid_step = float(np.median(period_steps)) if len(period_steps) else np.nan
    period_low = float(finite_periods[0])
    period_high = float(finite_periods[-1])

    chosen = []
    chosen_powers = []
    for index in ranked:
        period = float(periods[index])
        frequency = 1.0 / period
        if any(
            abs(frequency - 1.0 / existing_period) < min_frequency_separation
            for existing_period in chosen
        ):
            continue
        chosen.append(period)
        chosen_powers.append(float(power[index]))
        if len(chosen) >= requested:
            break

    if not chosen:
        return []

    finite_power = power[finite]
    power_floor = float(np.min(finite_power))
    power_ceiling = float(np.max(finite_power))
    power_span = power_ceiling - power_floor

    output = []
    for rank, (period, candidate_power) in enumerate(zip(chosen, chosen_powers), start=1):
        local_step = grid_step if np.isfinite(grid_step) else max(period * 1e-4, 1e-7)
        half_width = max(0.015 * period, 4.0 * local_step)
        slider_min = max(period_low, period - half_width)
        slider_max = min(period_high, period + half_width)
        if slider_min >= slider_max:
            slider_min = max(np.finfo(float).eps, period - half_width)
            slider_max = period + half_width
        slider_step = max(local_step / 20.0, (slider_max - slider_min) / 1000.0, 1e-7)
        relative_power = (
            (candidate_power - power_floor) / power_span if power_span > 0 else 1.0
        )
        output.append({
            "candidate_id": f"P{rank}",
            "rank": rank,
            "period": period,
            "relative_power": float(np.clip(relative_power, 0.0, 1.0)),
            "slider_min": float(slider_min),
            "slider_max": float(slider_max),
            "slider_step": float(slider_step),
        })
    return output


def top_period_peaks(periodogram, count=8, min_separation=None):
    """서로 너무 가까운 격자 피크를 합쳐 사용자에게 보여줄 후보 목록을 만든다."""
    from scipy.signal import find_peaks

    periods = np.asarray(periodogram["periods"], dtype=np.float64)
    power = np.asarray(periodogram["power"], dtype=np.float64)
    finite = np.isfinite(periods) & np.isfinite(power)
    if not finite.any():
        return []

    peak_indices, _ = find_peaks(np.where(finite, power, -np.inf))
    finite_indices = np.flatnonzero(finite)
    peak_indices = np.unique(np.concatenate((
        peak_indices,
        np.array([finite_indices[0], finite_indices[-1], int(np.nanargmax(power))]),
    )))
    ranked = peak_indices[np.argsort(power[peak_indices])[::-1]]
    grid_step = float(np.nanmedian(np.diff(periods[finite_indices]))) if len(finite_indices) > 1 else 0.0

    chosen = []
    for index in ranked:
        period = float(periods[index])
        separation = (float(min_separation) if min_separation is not None
                      else max(3.0 * grid_step, 0.001 * period))
        if any(abs(period - item["period"]) < separation for item in chosen):
            continue
        chosen.append({
            "index": int(index),
            "period": period,
            "power": float(power[index]),
            "duration": float(np.asarray(periodogram["duration"])[index]),
            "t0": float(np.asarray(periodogram["t0"])[index]),
            "depth": float(np.asarray(periodogram["depth"])[index]),
        })
        if len(chosen) >= count:
            break
    return chosen


def phase_explorer_sample(t, f, maximum=8_000):
    """주기 슬라이더용 광도곡선을 결정론적으로 축약한다.

    NaN/inf가 한쪽에만 있어도 그 행 전체를 함께 제거하고, 남은 두 배열에서
    같은 원본 인덱스를 선택해 시간-광도 대응을 보존한다.
    """
    t = np.asarray(t, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    if t.ndim != 1 or f.ndim != 1 or t.shape != f.shape:
        raise ValueError("t와 f는 길이가 같은 1차원 배열이어야 합니다")
    maximum = int(maximum)
    if maximum <= 0:
        raise ValueError("maximum은 1 이상이어야 합니다")

    finite = np.isfinite(t) & np.isfinite(f)
    clean_t, clean_f = t[finite], f[finite]
    if len(clean_t) <= maximum:
        return clean_t.copy(), clean_f.copy()

    indices = np.linspace(0, len(clean_t) - 1, maximum, dtype=np.int64)
    return clean_t[indices], clean_f[indices]


def geometry_from_phase_interval(t, period, t_ref, x0_hours, x1_hours):
    """두 주기를 이어 그린 위상 그래프의 선택 구간을 P/t0/D 기하로 바꾼다.

    드래그 방향은 무관하다. 선택 중심은 period로 나머지를 취해 첫째/둘째
    반복 주기에서 같은 구간을 고르면 같은 epoch가 되며, 그 동치인 t0들 중
    관측 시각 중앙값에 가장 가까운 값을 반환한다.
    """
    t = np.asarray(t, dtype=np.float64)
    finite_t = t[np.isfinite(t)]
    period = float(period)
    t_ref = float(t_ref)
    x0_hours = float(x0_hours)
    x1_hours = float(x1_hours)

    if len(finite_t) == 0:
        raise ValueError("유효한 관측 시각이 필요합니다")
    if not np.isfinite(period) or period <= 0:
        raise ValueError("period는 0보다 큰 유한값이어야 합니다")
    if not np.isfinite(t_ref):
        raise ValueError("t_ref는 유한값이어야 합니다")
    if not np.isfinite(x0_hours) or not np.isfinite(x1_hours):
        raise ValueError("선택 구간 양 끝은 유한값이어야 합니다")

    left_hours, right_hours = sorted((x0_hours, x1_hours))
    duration = (right_hours - left_hours) / 24.0
    if not np.isfinite(duration) or duration <= 0 or duration >= period:
        raise ValueError("선택 구간의 지속시간은 0보다 크고 period보다 작아야 합니다")

    center_from_reference = ((left_hours + right_hours) / 48.0) % period
    base_t0 = t_ref + center_from_reference
    observation_center = float(np.median(finite_t))
    cycle = int(np.rint((observation_center - base_t0) / period))
    canonical_t0 = base_t0 + cycle * period
    return {"t0": float(canonical_t0), "duration": float(duration)}


def fit_box_near_period(t, f, period_guess, duration_guess=None, period_fraction=0.01,
                        n_periods=801, duration_count=9):
    """사용자가 고른 주기 주변만 촘촘히 BLS 재탐색한다."""
    from astropy.timeseries import BoxLeastSquares

    t = np.asarray(t, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    period_guess = float(period_guess)
    if period_guess <= 0:
        raise ValueError("period_guess는 0보다 커야 합니다")
    duration_guess = float(duration_guess or min(2.0 / 24.0, period_guess * 0.08))
    if not 0 < duration_guess < period_guess:
        raise ValueError("duration_guess는 0보다 크고 period_guess보다 작아야 합니다")
    duration_low = max(duration_guess * 0.55, 0.25 / 24.0)
    duration_high = min(duration_guess * 1.8, period_guess * 0.2)
    durations = np.geomspace(duration_low, duration_high, int(duration_count))
    half_width = max(period_guess * float(period_fraction), 0.002)
    periods = np.linspace(max(0.05, period_guess - half_width), period_guess + half_width,
                          int(n_periods))
    result = BoxLeastSquares(t, f).power(periods, durations)
    best = int(np.nanargmax(result.power))
    return {
        "period": float(result.period[best]),
        "t0": float(result.transit_time[best]),
        "duration": float(result.duration[best]),
        "depth": max(0.0, float(result.depth[best])),
        "power": float(result.power[best]),
    }


def candidate_from_geometry(t, f, period, t0, duration):
    """사용자가 고른 P/t0/D를 고정하고 강건한 중앙값으로 depth를 다시 계산한다."""
    t = np.asarray(t, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    if not np.isfinite(duration) or duration <= 0 or duration >= period:
        raise ValueError("duration은 0보다 크고 period보다 작아야 합니다")
    distance = np.abs(phase_distance(t, period, t0))
    inside = distance <= 0.5 * duration
    nearby_outside = (distance >= duration) & (distance <= 3.0 * duration)
    outside = nearby_outside if nearby_outside.sum() >= 20 else ~inside
    if inside.sum() < 3 or outside.sum() < 3:
        raise ValueError("선택한 통과 구간 안팎의 관측점이 부족합니다")
    outside_level = float(np.nanmedian(f[outside]))
    depth = max(0.0, outside_level - float(np.nanmedian(f[inside])))
    epochs = np.floor((t[inside] - t0) / period + 0.5).astype(int)
    return {
        "period": float(period),
        "t0": float(t0),
        "duration": float(duration),
        "depth": float(depth),
        "n_in_transit": int(inside.sum()),
        "n_transits": int(len(np.unique(epochs))),
    }


def _joint_depth_fit(t, f, candidates):
    """후보들의 기하(P/t0/D)를 고정하고 baseline과 모든 depth를 동시에 적합한다."""
    from scipy.optimize import least_squares

    if not candidates:
        return [], 1.0
    t = np.asarray(t, dtype=np.float64)
    f = np.asarray(f, dtype=np.float64)
    masks = [
        np.abs(phase_distance(t, item["period"], item["t0"])) <= 0.5 * item["duration"]
        for item in candidates
    ]
    scatter = 1.4826 * np.nanmedian(np.abs(f - np.nanmedian(f)))
    scatter = float(scatter if np.isfinite(scatter) and scatter > 0 else np.nanstd(f))
    scatter = max(scatter, 1e-8)

    x0 = np.array([1.0] + [np.clip(item["depth"], 1e-7, 0.2) for item in candidates])

    def residual(parameters):
        model = np.full_like(f, parameters[0])
        for depth, mask in zip(parameters[1:], masks):
            model[mask] *= 1.0 - depth
        return (f - model) / scatter

    fit = least_squares(
        residual,
        x0=x0,
        bounds=(np.array([0.97] + [0.0] * len(candidates)),
                np.array([1.03] + [0.25] * len(candidates))),
        loss="soft_l1",
        f_scale=1.5,
        max_nfev=100,
    )
    updated = [dict(item, depth=float(depth)) for item, depth in zip(candidates, fit.x[1:])]
    return updated, float(fit.x[0])


def joint_refit_candidates(t, f, candidates):
    """사용자 승인 기하를 유지하며 모든 depth와 baseline을 동시에 재적합한다.

    P/t0/D는 승인된 사용자 선택을 그대로 유지한다. 겹친 통과점까지 포함해 모든
    후보의 depth와 baseline만 원본 광도곡선에서 동시에 적합한다. 관측점은
    마스킹하거나 삭제하지 않는다.
    """
    current = [dict(candidate) for candidate in candidates]
    if not current:
        return [], 1.0
    return _joint_depth_fit(t, f, current)


def fold_for_service(t, f, period, t0, n_bins=200):
    """서비스 카드용 축약: 수만 포인트 -> 200 bin. 프론트로 보내는 것은 이것뿐이다."""
    phase = ((t - t0) / period + 0.5) % 1.0 - 0.5
    idx = np.clip((phase + 0.5) * n_bins, 0, n_bins - 1).astype(int)
    binned = np.full(n_bins, np.nan)
    for b in range(n_bins):
        m = idx == b
        if m.any():
            binned[b] = np.median(f[m])
    return (np.arange(n_bins) + 0.5) / n_bins - 0.5, binned


def analyze_target(bronze_df, **kwargs):
    """Bronze DataFrame 하나 -> Feature dict 하나. Spark Worker에서 호출하는 단위."""
    cleaned, stats = clean(bronze_df)
    if cleaned is None:
        return None
    t, f = cleaned
    feat = bls_features(t, f, **kwargs)
    feat["target_id"] = int(bronze_df["target_id"].iloc[0])
    feat["mission"] = str(bronze_df["mission"].iloc[0])
    feat["noise_ppm_silver"] = stats["noise_ppm"]
    feat["rows_raw"], feat["rows_kept"] = stats["raw"], stats["kept"]
    return feat

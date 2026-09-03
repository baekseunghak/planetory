import numpy as np

from pipeline import (
    bls_period_candidates,
    bls_periodogram,
    combined_box_model,
    geometry_from_phase_interval,
    isolate_candidate_signal,
    joint_refit_candidates,
    phase_explorer_sample,
    residual_after_candidates,
)


def candidate(period, t0, duration, depth, name):
    return {
        "period": period,
        "t0": t0,
        "duration": duration,
        "depth": depth,
        "name": name,
    }


def test_model_division_preserves_overlapping_second_signal():
    time = np.arange(0.0, 30.0, 2.0 / 24.0 / 60.0)
    first = candidate(3.0, 1.0, 0.12, 0.01, "A")
    second = candidate(5.0, 1.0, 0.16, 0.006, "B")
    observed = combined_box_model(time, [first, second])

    residual = residual_after_candidates(time, observed, [first])

    np.testing.assert_allclose(residual, combined_box_model(time, [second]), atol=1e-12)


def test_candidate_plot_signal_removes_only_the_other_refitted_models():
    time = np.arange(0.0, 30.0, 2.0 / 24.0 / 60.0)
    first = candidate(3.0, 1.0, 0.12, 0.01, "A")
    second = candidate(5.0, 1.0, 0.16, 0.006, "B")
    baseline = 1.002
    observed = baseline * combined_box_model(time, [first, second])

    isolated_first = isolate_candidate_signal(
        time, observed, [first, second], candidate_index=0, baseline=baseline
    )

    np.testing.assert_allclose(isolated_first, combined_box_model(time, [first]), atol=1e-12)


def test_joint_refit_recovers_depths_with_overlapping_transits():
    rng = np.random.default_rng(42)
    time = np.arange(0.0, 45.0, 5.0 / 24.0 / 60.0)
    truth = [
        candidate(3.0, 1.0, 0.12, 0.010, "A"),
        candidate(5.0, 1.0, 0.16, 0.006, "B"),
    ]
    flux = combined_box_model(time, truth) + rng.normal(0.0, 1e-4, len(time))
    initial = [dict(truth[0], depth=0.013), dict(truth[1], depth=0.003)]

    fitted, baseline = joint_refit_candidates(time, flux, initial)

    assert abs(baseline - 1.0) < 5e-4
    assert abs(fitted[0]["period"] - truth[0]["period"]) < 0.002
    assert abs(fitted[1]["period"] - truth[1]["period"]) < 0.002
    assert abs(fitted[0]["depth"] - truth[0]["depth"]) < 8e-4
    assert abs(fitted[1]["depth"] - truth[1]["depth"]) < 8e-4


def test_joint_refit_preserves_user_selected_geometry():
    time = np.arange(0.0, 30.0, 2.0 / 24.0 / 60.0)
    selected = candidate(3.0, 1.0, 0.12, 0.004, "selected")
    stronger_same_period = candidate(3.0, 2.2, 0.12, 0.010, "other phase")
    flux = combined_box_model(time, [selected, stronger_same_period])

    fitted, _ = joint_refit_candidates(time, flux, [selected])

    assert fitted[0]["period"] == selected["period"]
    assert fitted[0]["t0"] == selected["t0"]
    assert fitted[0]["duration"] == selected["duration"]


def test_top_period_peaks_keeps_global_maximum_at_boundary():
    from pipeline import top_period_peaks

    periodogram = {
        "periods": np.array([1.0, 2.0, 3.0, 4.0]),
        "power": np.array([10.0, 1.0, 5.0, 2.0]),
        "duration": np.full(4, 0.1),
        "t0": np.zeros(4),
        "depth": np.full(4, 0.01),
    }

    peaks = top_period_peaks(periodogram, count=2)

    assert peaks[0]["period"] == 1.0


def test_manual_period_candidates_are_capped_and_ui_safe():
    periods = np.linspace(0.5, 12.0, 231)
    power = np.zeros_like(periods)
    peak_indices = np.arange(3, len(periods) - 2, 4)
    power[peak_indices] = np.linspace(20.0, 1.0, len(peak_indices))
    periodogram = {
        "periods": periods,
        "power": power,
        "time_baseline": 2_000.0,
    }

    candidates = bls_period_candidates(periodogram, count=50)

    safe_fields = {
        "candidate_id", "rank", "period", "relative_power",
        "slider_min", "slider_max", "slider_step",
    }
    assert len(candidates) == 10
    assert all(set(item) == safe_fields for item in candidates)
    assert all("t0" not in item and "duration" not in item and "depth" not in item
               for item in candidates)
    assert candidates[0]["relative_power"] == 1.0


def test_bls_periodogram_exposes_observation_baseline():
    time = np.linspace(10.0, 20.0, 500)
    flux = np.ones_like(time)

    periodogram = bls_periodogram(
        time,
        flux,
        period_min=0.5,
        period_max=3.0,
        n_periods=100,
        durations=[1.0 / 24.0],
    )

    assert periodogram["time_baseline"] == 10.0


def test_manual_period_candidates_keep_boundary_global_maximum():
    periodogram = {
        "periods": np.array([1.0, 2.0, 3.0, 4.0]),
        "power": np.array([10.0, 1.0, 5.0, 2.0]),
        "time_baseline": 20.0,
    }

    candidates = bls_period_candidates(periodogram, count=2)

    assert candidates[0]["period"] == 1.0


def test_manual_period_candidates_preserve_harmonic_peaks():
    periods = np.linspace(1.0, 5.0, 401)
    power = np.zeros_like(periods)
    power[np.argmin(np.abs(periods - 2.0))] = 10.0
    power[np.argmin(np.abs(periods - 4.0))] = 8.0
    periodogram = {
        "periods": periods,
        "power": power,
        "time_baseline": 30.0,
    }

    candidates = bls_period_candidates(periodogram, count=5)
    selected_periods = [item["period"] for item in candidates]

    assert any(np.isclose(period, 2.0) for period in selected_periods)
    assert any(np.isclose(period, 4.0) for period in selected_periods)


def test_geometry_accepts_reverse_drag_and_returns_positive_duration():
    time = np.arange(100.0, 130.0, 0.1)

    forward = geometry_from_phase_interval(time, 3.0, 100.0, 4.0, 8.0)
    reverse = geometry_from_phase_interval(time, 3.0, 100.0, 8.0, 4.0)

    assert reverse == forward
    assert np.isclose(reverse["duration"], 4.0 / 24.0)


def test_geometry_second_cycle_selects_same_canonical_epoch():
    time = np.arange(100.0, 130.0, 0.1)
    period = 2.0

    first_cycle = geometry_from_phase_interval(time, period, 100.0, 4.0, 8.0)
    second_cycle = geometry_from_phase_interval(
        time, period, 100.0, 4.0 + period * 24.0, 8.0 + period * 24.0
    )

    assert np.isclose(first_cycle["t0"], second_cycle["t0"])
    assert np.isclose(first_cycle["duration"], second_cycle["duration"])
    assert abs(first_cycle["t0"] - np.median(time)) <= period / 2.0


def test_geometry_rejects_zero_or_period_wide_interval():
    time = np.arange(0.0, 10.0, 0.1)

    for x0, x1 in [(4.0, 4.0), (0.0, 48.0), (np.nan, 4.0)]:
        try:
            geometry_from_phase_interval(time, 2.0, 0.0, x0, x1)
        except ValueError:
            pass
        else:
            raise AssertionError("잘못된 선택 구간이 허용되었습니다")


def test_phase_explorer_sample_is_finite_deterministic_and_aligned():
    time = np.arange(20.0, dtype=float)
    flux = 100.0 + time
    time[3] = np.nan
    flux[7] = np.inf

    sampled_t, sampled_f = phase_explorer_sample(time, flux, maximum=5)
    sampled_t_again, sampled_f_again = phase_explorer_sample(time, flux, maximum=5)

    np.testing.assert_array_equal(sampled_t, sampled_t_again)
    np.testing.assert_array_equal(sampled_f, sampled_f_again)
    assert len(sampled_t) == 5
    assert np.all(np.isfinite(sampled_t)) and np.all(np.isfinite(sampled_f))
    np.testing.assert_allclose(sampled_f - sampled_t, 100.0)


def test_equal_depth_binary_eclipses_make_half_period_the_strongest_bls_candidate():
    time = np.arange(0.0, 24.0, 5.0 / 24.0 / 60.0)
    orbital_period = 1.2
    primary = candidate(orbital_period, 0.2, 0.06, 0.35, "primary")
    secondary = candidate(
        orbital_period, 0.2 + 0.5 * orbital_period, 0.06, 0.35, "secondary"
    )
    flux = combined_box_model(time, [primary, secondary])

    periodogram = bls_periodogram(
        time,
        flux,
        period_min=0.5,
        period_max=2.0,
        n_periods=3_001,
        durations=[0.06],
    )
    candidates = bls_period_candidates(periodogram, count=10)
    candidate_periods = [item["period"] for item in candidates]

    assert abs(candidate_periods[0] - 0.5 * orbital_period) < 0.002
    assert any(abs(period - orbital_period) < 0.002 for period in candidate_periods)

# -*- coding: utf-8 -*-
"""사용자 피크 선택 + 모델 나눗셈 + 공동 재적합 방식의 반자동 BLS UI."""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd
import streamlit as st
from astropy.io import fits

from phase_selector import phase_selector
from pipeline import (
    bls_period_candidates,
    bls_periodogram,
    candidate_from_geometry,
    combined_box_model,
    geometry_from_phase_interval,
    isolate_candidate_signal,
    joint_refit_candidates,
    phase_distance,
    phase_explorer_sample,
    residual_after_candidates,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = ROOT / "sample_raw" / "tess" / "toi270"
EXAMPLE_TARGETS = {
    "행성계 · TOI-270 · 확정 통과행성 3개": {
        "name": "TOI-270",
        "tic_id": 259377017,
        "data_dir": DEFAULT_DATA_DIR,
        "download_script": "download_toi270.py",
        "sectors": (3, 4, 5),
        "kind": "planetary_system",
    },
    "행성계 · L 98-59 · 확정 통과행성 3개": {
        "name": "L 98-59",
        "tic_id": 307210830,
        "data_dir": ROOT / "sample_raw" / "tess" / "l98_59",
        "download_script": "download_l98_59.py",
        "sectors": (2, 5, 8),
        "kind": "planetary_system",
    },
    "식쌍성 · CM Draconis · 주극소·부극소": {
        "name": "CM Draconis",
        "tic_id": 199574208,
        "data_dir": ROOT / "sample_raw" / "tess" / "cm_dra",
        "download_script": "download_cm_dra.py",
        "sectors": (16,),
        "kind": "eclipsing_binary",
    },
}


def configure_plot_font():
    """운영체제에 설치된 한글 글꼴을 골라 그래프의 네모 글자와 경고를 막는다."""
    for family in ("Malgun Gothic", "AppleGothic", "Noto Sans CJK KR", "NanumGothic"):
        try:
            font_manager.findfont(family, fallback_to_default=False)
        except ValueError:
            continue
        plt.rcParams["font.family"] = family
        plt.rcParams["axes.unicode_minus"] = False
        return


@st.cache_data(show_spinner=False)
def load_tess_light_curves(file_signatures):
    """여러 Sector의 SPOC LC FITS를 품질 필터 후 sector별 정규화·detrending한다."""
    from pipeline import clean

    frames = []
    sectors = []
    target_ids = []
    for filename, _, _ in file_signatures:
        path = Path(filename)
        with fits.open(path, memmap=False) as hdul:
            table = hdul[1].data
            header = hdul[0].header
            sector = int(header.get("SECTOR", len(sectors) + 1))
            target_id = int(header.get("TICID", 0))
            time = np.asarray(table["TIME"], dtype=np.float64)
            flux = np.asarray(table["PDCSAP_FLUX"], dtype=np.float64)
            quality = np.asarray(table["QUALITY"], dtype=np.int64)
        frames.append(pd.DataFrame({
            "mission": "TESS",
            "target_id": target_id,
            "observation_group": sector,
            "time": time,
            "flux": flux,
            "quality": quality,
        }))
        sectors.append(sector)
        target_ids.append(target_id)

    if set(target_ids) == {0}:
        raise ValueError("FITS PRIMARY 헤더에서 TICID를 찾지 못했습니다")
    if len(set(target_ids)) != 1:
        raise ValueError(f"서로 다른 TIC의 FITS가 섞여 있습니다: {sorted(set(target_ids))}")
    if len(sectors) != len(set(sectors)):
        raise ValueError(f"같은 Sector의 제품이 중복되어 있습니다: {sectors}")

    bronze = pd.concat(frames, ignore_index=True)
    cleaned, stats = clean(bronze)
    if cleaned is None:
        raise RuntimeError(f"정제된 관측점이 없습니다: {stats}")
    t, f = cleaned
    return t, f, stats, sorted(set(sectors)), sorted(set(target_ids))


def downsample(x, y, maximum=25_000):
    if len(x) <= maximum:
        return x, y
    index = np.linspace(0, len(x) - 1, maximum, dtype=int)
    return x[index], y[index]


def binned_phase(t, f, period, t0, window_days, bins=140):
    distance = phase_distance(t, period, t0)
    selected = np.abs(distance) <= window_days
    x, y = distance[selected] * 24.0, f[selected]
    edges = np.linspace(-window_days * 24.0, window_days * 24.0, bins + 1)
    centers = 0.5 * (edges[:-1] + edges[1:])
    index = np.digitize(x, edges) - 1
    medians = np.full(bins, np.nan)
    for bin_index in range(bins):
        values = y[index == bin_index]
        if len(values):
            medians[bin_index] = np.nanmedian(values)
    return x, y, centers, medians


def light_curve_figure(t, original, residual, candidates, baseline=1.0):
    figure, axis = plt.subplots(figsize=(9, 2.6))
    tx, original_x = downsample(t, original)
    _, residual_x = downsample(t, residual)
    axis.scatter(tx, (original_x - 1) * 1_000, s=2, alpha=0.16, color="#7a8494", label="원본 정제곡선")
    axis.scatter(tx, (residual_x - 1) * 1_000, s=2, alpha=0.48, color="#2563eb", label="현재 잔차")
    if candidates:
        model = baseline * combined_box_model(t, candidates)
        model_t, model_flux = downsample(t, model)
        axis.plot(
            model_t,
            (model_flux - 1) * 1_000,
            color="#dc2626",
            linewidth=1.4,
            alpha=0.9,
            drawstyle="steps-mid",
            label="공동 재적합 모델",
        )
    axis.axhline(0, color="#111827", linewidth=0.8)
    axis.set_xlabel("BTJD (day)")
    axis.set_ylabel("상대 밝기 (ppt)")
    axis.set_title(f"광도곡선 · 승인 후보 {len(candidates)}개")
    axis.legend(loc="lower right", fontsize=8)
    axis.grid(alpha=0.2)
    figure.tight_layout()
    return figure


def period_candidates_figure(candidates, selected_id=None):
    """전체 곡선 대신 사용자에게 공개할 이산 주기 후보만 그린다."""
    figure, axis = plt.subplots(figsize=(4.4, 2.65))
    periods = np.asarray([item["period"] for item in candidates], dtype=np.float64)
    powers = np.asarray([item["relative_power"] for item in candidates], dtype=np.float64)
    colors = [
        "#f97316" if item["candidate_id"] == selected_id else "#2563eb"
        for item in candidates
    ]
    axis.vlines(periods, 0, powers, color=colors, linewidth=1.5, alpha=0.72)
    axis.scatter(periods, powers, color=colors, s=34, zorder=3)
    for item in candidates:
        axis.annotate(
            str(item["rank"]),
            (item["period"], item["relative_power"]),
            xytext=(3, 4), textcoords="offset points", fontsize=8,
        )
    axis.set_xlabel("후보 주기 (day)")
    axis.set_ylabel("상대 BLS power")
    axis.set_title(f"BLS 주기 후보 {len(candidates)}개")
    axis.set_ylim(0, max(1.06, float(np.nanmax(powers)) * 1.08))
    axis.grid(alpha=0.2)
    figure.tight_layout()
    return figure


def folded_figure(t, f, candidate, selection_range_hours):
    duration = candidate["duration"]
    window_days = max(
        3.0 * duration,
        max(abs(selection_range_hours[0]), abs(selection_range_hours[1])) / 24.0 * 1.5,
    )
    x, y, centers, medians = binned_phase(
        t, f, candidate["period"], candidate["t0"], window_days
    )
    figure, axis = plt.subplots(figsize=(9, 2.3))
    px, py = downsample(x, y, maximum=18_000)
    axis.scatter(px, (py - 1) * 1_000, s=3, alpha=0.08, color="#64748b")
    valid = np.isfinite(medians)
    axis.plot(centers[valid], (medians[valid] - 1) * 1_000, color="#2563eb", linewidth=2.2)
    half_duration_hours = 0.5 * duration * 24.0
    axis.axvspan(-half_duration_hours, half_duration_hours, color="#f97316", alpha=0.18,
                 label="사용자가 지정한 감광 구간")
    axis.axhline(0, color="#111827", linewidth=0.8)
    axis.set_xlabel("감광 중심으로부터 시간 (hour)")
    axis.set_ylabel("상대 밝기 (ppt)")
    axis.set_title(f"위상 접힘 확대 · P={candidate['period']:.6f} d")
    axis.legend(loc="lower right", fontsize=8)
    axis.grid(alpha=0.2)
    figure.tight_layout()
    return figure


def refitted_candidate_figure(t, original_flux, candidates, candidate_index, baseline):
    """다른 후보만 제거한 위상곡선 위에 공동 재적합된 후보 모델을 표시한다."""
    candidate = candidates[candidate_index]
    isolated_flux = isolate_candidate_signal(
        t, original_flux, candidates, candidate_index, baseline=baseline
    )
    duration = float(candidate["duration"])
    window_days = max(3.5 * duration, 2.0 / 24.0)
    x, y, centers, medians = binned_phase(
        t, isolated_flux, candidate["period"], candidate["t0"], window_days
    )

    figure, axis = plt.subplots(figsize=(9, 2.7))
    px, py = downsample(x, y, maximum=18_000)
    axis.scatter(
        px, (py - 1) * 1_000, s=3, alpha=0.08, color="#64748b",
        label="다른 후보를 제거한 관측점",
    )
    valid = np.isfinite(medians)
    axis.plot(
        centers[valid], (medians[valid] - 1) * 1_000,
        color="#2563eb", linewidth=2.2, label="위상 구간 중앙값",
    )

    model_hours = np.linspace(-window_days * 24.0, window_days * 24.0, 1_200)
    half_duration_hours = 0.5 * duration * 24.0
    model_ppt = np.where(
        np.abs(model_hours) <= half_duration_hours,
        -float(candidate["depth"]) * 1_000.0,
        0.0,
    )
    axis.plot(
        model_hours, model_ppt, color="#dc2626", linewidth=2.4,
        drawstyle="steps-mid", label="공동 재적합 모델",
    )
    axis.axvline(-half_duration_hours, color="#f97316", linestyle="--", linewidth=1.0)
    axis.axvline(half_duration_hours, color="#f97316", linestyle="--", linewidth=1.0)
    axis.axhline(0, color="#111827", linewidth=0.8)
    axis.set_xlabel("감광 중심으로부터 시간 (hour)")
    axis.set_ylabel("상대 밝기 (ppt)")
    axis.set_title(
        f"공동 재적합 결과 · P={candidate['period']:.6f} d · "
        f"depth={candidate['depth'] * 1_000:.3f} ppt"
    )
    axis.legend(loc="lower right", fontsize=8)
    axis.grid(alpha=0.2)
    figure.tight_layout()
    return figure


def reset_analysis():
    fixed_keys = {
        "dataset_key", "candidates", "baseline", "periodogram", "period_choices",
        "manual_candidate_id", "manual_period", "period_locked",
        "phase_selector_nonce", "search_revision",
        "workspace_view", "pending_workspace_view", "approved_candidate_view",
    }
    dynamic_prefixes = ("period_choice_", "phase_selector_", "lock_period_",
                        "unlock_period_", "clear_interval_", "approve_candidate_")
    for key in list(st.session_state):
        if key in fixed_keys or key.startswith(dynamic_prefixes):
            st.session_state.pop(key, None)


def render_results(t, original_flux, residual_flux, candidates, baseline, target_ids, sectors):
    """전체 공동 모델과 선택 후보의 재적합 그래프를 한 화면의 두 열에 표시한다."""
    if not candidates:
        st.info("아직 승인된 후보가 없습니다. ‘후보 찾기’ 화면에서 첫 후보를 승인하세요.")
        return

    left, right = st.columns([1.08, 0.92], gap="medium")
    with left:
        st.markdown("##### 전체 공동 재적합")
        figure = light_curve_figure(t, original_flux, residual_flux, candidates, baseline=baseline)
        st.pyplot(figure, clear_figure=True)
        table = pd.DataFrame([
            {
                "후보": item.get("name", f"후보 {index + 1}"),
                "주기(d)": item["period"],
                "중심(BTJD)": item["t0"],
                "지속(h)": item["duration"] * 24.0,
                "깊이(ppt)": item["depth"] * 1_000.0,
            }
            for index, item in enumerate(candidates)
        ])
        st.dataframe(table, hide_index=True, width="stretch", height=min(145, 38 + 35 * len(table)))

    with right:
        if st.session_state.get("approved_candidate_view", 0) >= len(candidates):
            st.session_state.approved_candidate_view = 0
        selected_index = st.selectbox(
            "표시할 승인 후보",
            range(len(candidates)),
            format_func=lambda index: candidates[index].get("name", f"후보 {index + 1}"),
            key="approved_candidate_view",
        )
        fitted_figure = refitted_candidate_figure(
            t, original_flux, candidates, selected_index, baseline
        )
        st.pyplot(fitted_figure, clear_figure=True)
        st.caption("다른 후보 모델만 나눴으며 겹친 감광 관측점은 그대로 남아 있습니다.")
        action_left, action_right = st.columns(2)
        if action_left.button("마지막 후보 취소", width="stretch"):
            st.session_state.candidates = candidates[:-1]
            if st.session_state.candidates:
                fitted, updated_baseline = joint_refit_candidates(
                    t, original_flux, st.session_state.candidates
                )
                st.session_state.candidates = fitted
                st.session_state.baseline = updated_baseline
            else:
                st.session_state.baseline = 1.0
                st.session_state.pending_workspace_view = "후보 찾기"
            st.session_state.periodogram = None
            st.session_state.period_choices = None
            st.session_state.search_revision = st.session_state.get("search_revision", 0) + 1
            st.rerun()
        payload = json.dumps({
            "tic_ids": target_ids,
            "sectors": sectors,
            "baseline": baseline,
            "candidates": candidates,
        }, ensure_ascii=False, indent=2)
        action_right.download_button(
            "결과 JSON 다운로드", payload, "semi_auto_bls_candidates.json",
            "application/json", width="stretch",
        )


def render_search(t, original_flux, residual_flux, candidates, period_min,
                  period_max_input, n_periods, duration_min_hr, duration_max_hr):
    """BLS 후보 → 수동 주기 정렬 → 수동 구간 지정 순서로 후보를 만든다."""
    toolbar_left, toolbar_right = st.columns([0.72, 1.28], gap="small")
    calculate = toolbar_left.button(
        "현재 잔차에서 BLS 계산", type="primary", width="stretch"
    )
    toolbar_right.caption(
        f"{len(candidates) + 1}번째 후보 · ① 후보 선택 → ② 주기 맞추기 → "
        "③ 감광 구간 선택 → ④ 승인"
    )
    if calculate:
        if duration_max_hr <= duration_min_hr:
            st.error("최대 지속시간은 최소 지속시간보다 커야 합니다.")
        else:
            effective_period_max = min(
                float(period_max_input), float((t.max() - t.min()) / 2.0)
            )
            if float(period_min) >= effective_period_max:
                st.error("최소 주기는 최대 주기와 관측 기간 제한보다 작아야 합니다.")
                return
            if duration_min_hr / 24.0 >= float(period_min):
                st.error("최소 지속시간은 최소 주기보다 짧아야 합니다.")
                return
            durations = np.geomspace(duration_min_hr / 24.0, duration_max_hr / 24.0, 12)
            try:
                with st.spinner("BLS 격자를 계산하는 중입니다..."):
                    periodogram = bls_periodogram(
                        t,
                        residual_flux,
                        period_min=float(period_min),
                        period_max=effective_period_max,
                        n_periods=int(n_periods),
                        durations=durations,
                    )
                    period_choices = bls_period_candidates(periodogram, count=10)
            except ValueError as exc:
                st.error(str(exc))
                return
            st.session_state.periodogram = periodogram
            st.session_state.period_choices = period_choices
            st.session_state.search_revision = st.session_state.get("search_revision", 0) + 1
            for key in (
                "manual_candidate_id", "manual_period", "period_locked",
                "phase_selector_nonce",
            ):
                st.session_state.pop(key, None)

    periodogram = st.session_state.periodogram
    if periodogram is None:
        empty_left, empty_right = st.columns([1.15, 0.85], gap="medium")
        with empty_left:
            figure = light_curve_figure(
                t, original_flux, residual_flux, candidates,
                baseline=st.session_state.baseline,
            )
            st.pyplot(figure, clear_figure=True)
        with empty_right:
            st.info("왼쪽 위 버튼을 눌러 현재 잔차의 주기 후보를 계산하세요.")
            st.markdown(
                "1. BLS는 내부 격자를 계산하지만 화면에는 주기 후보 10개만 표시  \n"
                "2. 사용자가 위상 접힘을 보며 주기를 직접 조절  \n"
                "3. 감광 구간을 그래프에서 골라야 중심·지속시간을 계산"
            )
        return

    if "time_baseline" not in periodogram:
        periodogram["time_baseline"] = float(t.max() - t.min())

    period_choices = st.session_state.get("period_choices")
    if not period_choices:
        try:
            period_choices = bls_period_candidates(periodogram, count=10)
        except ValueError as exc:
            st.error(str(exc))
            return
        st.session_state.period_choices = period_choices
    if not period_choices:
        st.error("유효한 BLS 피크를 찾지 못했습니다. 탐색 범위나 전처리 결과를 확인하세요.")
        return

    search_revision = int(st.session_state.get("search_revision", 0))
    candidate_column, explorer_column = st.columns([0.58, 1.42], gap="medium")
    with candidate_column:
        st.markdown("##### ① BLS 주기 후보")
        selected_rank = st.selectbox(
            "조사할 후보",
            range(len(period_choices)),
            format_func=lambda index: (
                f"#{period_choices[index]['rank']} · "
                f"P={period_choices[index]['period']:.6f} d · "
                f"power={period_choices[index]['relative_power']:.3f}"
            ),
            key=f"period_choice_{search_revision}",
        )
        selected_choice = period_choices[selected_rank]
        figure = period_candidates_figure(
            period_choices, selected_id=selected_choice["candidate_id"]
        )
        st.pyplot(figure, clear_figure=True)
        st.caption("점과 번호만 공개합니다. BLS가 내부 계산한 중심·지속시간·깊이는 숨겨집니다.")

    if st.session_state.get("manual_candidate_id") != selected_choice["candidate_id"]:
        st.session_state.manual_candidate_id = selected_choice["candidate_id"]
        st.session_state.manual_period = float(selected_choice["period"])
        st.session_state.period_locked = False
        st.session_state.phase_selector_nonce = (
            int(st.session_state.get("phase_selector_nonce", 0)) + 1
        )

    sample_t, sample_f = phase_explorer_sample(t, residual_flux, maximum=len(t))
    sample_ppt = (sample_f - 1.0) * 1_000.0
    y_low, y_high = np.nanpercentile(sample_ppt, [0.5, 99.5])
    y_padding = max(0.08 * float(y_high - y_low), 0.15)
    t_ref = float(np.nanmedian(t))
    manual_period = float(st.session_state.get("manual_period", selected_choice["period"]))
    period_locked = bool(st.session_state.get("period_locked", False))
    selector_nonce = int(st.session_state.get("phase_selector_nonce", 0))
    selector_key = f"phase_selector_{search_revision}_{selector_nonce}"

    with explorer_column:
        selector_result = phase_selector(
            time=sample_t,
            flux_ppt=sample_ppt,
            t_ref=t_ref,
            period_days=manual_period,
            period_min=selected_choice["slider_min"],
            period_max=selected_choice["slider_max"],
            period_step=selected_choice["slider_step"],
            y_min=float(y_low - y_padding),
            y_max=float(y_high + y_padding),
            mode="select" if period_locked else "tune",
            interval=None,
            key=selector_key,
        )
        current_period = float(selector_result.period_days or manual_period)
        st.session_state.manual_period = current_period

        if not period_locked:
            if st.button(
                "이 주기로 감광 구간 선택", type="primary", width="stretch",
                key=f"lock_period_{search_revision}_{selector_nonce}",
            ):
                st.session_state.manual_period = current_period
                st.session_state.period_locked = True
                st.rerun()
            st.caption("슬라이더를 놓을 때만 값이 저장됩니다. 이 단계에서는 감광 중심과 폭을 알려주지 않습니다.")
            return

        interval = selector_result.interval
        edit_left, edit_right = st.columns(2)
        if edit_left.button(
            "주기 다시 조정", width="stretch",
            key=f"unlock_period_{search_revision}_{selector_nonce}",
        ):
            st.session_state.period_locked = False
            st.session_state.phase_selector_nonce = selector_nonce + 1
            st.rerun()
        if edit_right.button(
            "구간 다시 선택", width="stretch", disabled=interval is None,
            key=f"clear_interval_{search_revision}_{selector_nonce}",
        ):
            st.session_state.phase_selector_nonce = selector_nonce + 1
            st.rerun()

        if interval is None:
            st.caption("그래프에서 예상 감광 구간을 좌클릭한 채 드래그하세요.")
            return

        try:
            geometry = geometry_from_phase_interval(
                t,
                current_period,
                t_ref,
                interval["x0_hours"],
                interval["x1_hours"],
            )
            candidate = candidate_from_geometry(
                t,
                residual_flux,
                current_period,
                geometry["t0"],
                geometry["duration"],
            )
        except (KeyError, TypeError, ValueError) as exc:
            st.warning(str(exc))
            return

        candidate["name"] = f"후보 {len(candidates) + 1}"
        st.markdown(
            "**선택 구간 계산 결과** · "
            f"P `{candidate['period']:.6f} d` · "
            f"중심 `{candidate['t0']:.5f} BTJD` · "
            f"지속 `{candidate['duration'] * 24:.2f} h` · "
            f"깊이 `{candidate['depth'] * 1_000:.3f} ppt`"
        )

        if st.button(
            "후보 승인 → 전체 공동 재적합", type="primary", width="stretch",
            key=f"approve_candidate_{search_revision}_{selector_nonce}",
        ):
            with st.spinner("원본 광도곡선에서 후보들을 공동 재적합하는 중입니다..."):
                fitted, baseline = joint_refit_candidates(
                    t, original_flux, candidates + [candidate]
                )
            st.session_state.candidates = fitted
            st.session_state.baseline = baseline
            st.session_state.periodogram = None
            st.session_state.period_choices = None
            st.session_state.pending_workspace_view = "재적합 결과"
            st.session_state.search_revision = search_revision + 1
            st.rerun()


def main():
    configure_plot_font()
    st.set_page_config(
        page_title="반자동 BLS 감광 신호 탐색기", layout="wide", initial_sidebar_state="collapsed"
    )
    st.markdown(
        """
        <style>
        .block-container {padding-top: 2rem; padding-bottom: .2rem; max-width: 1500px;}
        h1 {font-size: 1.65rem !important; margin-bottom: 0 !important;}
        [data-testid="stCaptionContainer"] {margin-top: -.25rem;}
        [data-testid="stMetric"] {padding: .1rem .35rem;}
        [data-testid="stMetricLabel"] {font-size: .75rem;}
        [data-testid="stMetricValue"] {font-size: 1.25rem;}
        [data-testid="stPlotlyChart"], [data-testid="stImage"] {margin-bottom: 0;}
        div[data-testid="stRadio"] > label {display: none;}
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown("### 반자동 BLS 감광 신호 탐색기")

    with st.sidebar:
        st.header("데이터")
        target_label = st.selectbox("예시 천체", list(EXAMPLE_TARGETS), key="example_target")
        target = EXAMPLE_TARGETS[target_label]
        if st.session_state.get("last_example_target") != target_label:
            reset_analysis()
            st.session_state.data_dir_text = str(target["data_dir"])
            st.session_state.last_example_target = target_label
        data_dir_text = st.text_input("FITS 폴더", key="data_dir_text")
        data_dir = Path(data_dir_text).expanduser()
        try:
            using_preset_path = data_dir.resolve() == Path(target["data_dir"]).resolve()
        except OSError:
            using_preset_path = False
        files = sorted(data_dir.glob("*_lc.fits")) if data_dir.exists() else []
        st.write(f"발견한 LC FITS: {len(files)}개")
        if st.button("분석 상태 초기화", width="stretch"):
            reset_analysis()
            st.rerun()

        st.header("BLS 범위")
        period_min = st.number_input("최소 주기 (day)", min_value=0.1, value=0.5, step=0.1)
        period_max_input = st.number_input("최대 주기 (day)", min_value=1.0, value=15.0, step=1.0)
        n_periods = st.select_slider(
            "주기 격자 수", options=[2_000, 4_000, 8_000, 16_000], value=8_000
        )
        duration_min_hr = st.number_input(
            "최소 지속시간 (hour)", min_value=0.2, value=0.5, step=0.1
        )
        duration_max_hr = st.number_input(
            "최대 지속시간 (hour)", min_value=0.5, value=5.0, step=0.5
        )

    if not files:
        if using_preset_path:
            st.warning(f"{target['name']} FITS가 없습니다. 먼저 아래 명령을 실행하세요.")
            st.code(
                f"uv run python {target['download_script']}\n"
                "uv run streamlit run semi_auto_bls.py",
                language="bash",
            )
        else:
            st.warning("지정한 폴더에서 `*_lc.fits` 파일을 찾지 못했습니다.")
        return

    signatures = tuple(
        (str(path.resolve()), path.stat().st_size, path.stat().st_mtime_ns)
        for path in files
    )
    try:
        t, original_flux, stats, sectors, target_ids = load_tess_light_curves(signatures)
    except Exception as exc:
        st.error(f"FITS 로드 실패: {exc}")
        return

    dataset_key = repr((target_label, str(data_dir.resolve()), signatures))
    if st.session_state.get("dataset_key") != dataset_key:
        reset_analysis()
        st.session_state.dataset_key = dataset_key
        st.session_state.candidates = []
        st.session_state.baseline = 1.0
        st.session_state.periodogram = None
        st.session_state.period_choices = None
        st.session_state.search_revision = 0
        st.session_state.workspace_view = "후보 찾기"

    candidates = st.session_state.candidates
    baseline = st.session_state.baseline
    residual_flux = residual_after_candidates(t, original_flux, candidates, baseline=baseline)

    display_name = target["name"] if using_preset_path else "직접 지정 데이터"
    st.caption(
        f"{display_name}  ·  TIC {', '.join(map(str, target_ids))}  ·  "
        f"Sector {', '.join(map(str, sectors))}  ·  "
        f"관측점 {len(t):,}  ·  기간 {t.max() - t.min():.1f}일  ·  승인 후보 {len(candidates)}"
    )
    if using_preset_path and target.get("kind") == "eclipsing_binary":
        st.caption(
            "식쌍성 해석 힌트 · 한 공전에 주극소와 부극소가 한 번씩 나타납니다. "
            "두 깊이가 비슷하면 BLS의 가장 강한 주기가 실제 공전주기의 절반일 수 있으므로 "
            "상위 후보의 약 2배 주기도 함께 비교하세요."
        )

    pending_view = st.session_state.pop("pending_workspace_view", None)
    if pending_view is not None:
        st.session_state.workspace_view = pending_view
    view = st.radio(
        "작업 화면", ["후보 찾기", "재적합 결과"], horizontal=True,
        key="workspace_view", label_visibility="collapsed",
    )
    if view == "재적합 결과":
        render_results(
            t, original_flux, residual_flux, candidates, baseline, target_ids, sectors
        )
    else:
        render_search(
            t, original_flux, residual_flux, candidates, period_min,
            period_max_input, n_periods, duration_min_hr, duration_max_hr,
        )


if __name__ == "__main__":
    main()

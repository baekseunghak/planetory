# -*- coding: utf-8 -*-
"""주기 조절과 감광 구간 편집을 위한 Streamlit 양방향 컴포넌트."""

from __future__ import annotations

from collections.abc import Sequence

import streamlit as st


_HTML = """
<section class="phase-lab" aria-label="수동 위상 접힘 탐색기">
  <header class="phase-head">
    <div>
      <strong data-stage></strong>
      <span class="phase-subtitle" data-subtitle></span>
    </div>
    <output class="period-value" data-period aria-live="polite"></output>
  </header>
  <div class="period-control" data-period-control>
    <span data-min></span>
    <input data-slider type="range" aria-label="주기 조절" />
    <span data-max></span>
  </div>
  <canvas data-canvas tabindex="0"
          aria-label="두 주기를 반복한 위상 접힘 광도곡선"></canvas>
  <footer class="phase-foot">
    <span data-axis-label>고정 기준시각으로 접은 시간 (hour · 두 주기 반복)</span>
    <span class="phase-hint" data-hint></span>
  </footer>
</section>
"""


_CSS = """
:host { display: block; color: var(--st-text-color); font-family: var(--st-font); }
.phase-lab {
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px 8px;
  border: 1px solid color-mix(in srgb, var(--st-text-color) 16%, transparent);
  border-radius: 10px;
  background: var(--st-background-color);
  user-select: none;
}
.phase-head, .phase-foot, .period-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.phase-head { min-height: 30px; }
.phase-head strong { font-size: 14px; }
.phase-subtitle { margin-left: 7px; font-size: 11px; opacity: .66; }
.period-value {
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--st-primary-color);
  background: color-mix(in srgb, var(--st-primary-color) 11%, transparent);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  white-space: nowrap;
}
.period-control { margin: 4px 0 5px; font-size: 10px; opacity: .88; }
.period-control input { width: 100%; accent-color: var(--st-primary-color); cursor: ew-resize; }
.period-control.is-hidden { visibility: hidden; height: 0; margin: 0; overflow: hidden; }
canvas {
  display: block;
  width: 100%;
  height: 218px;
  border-radius: 6px;
  outline: none;
  touch-action: none;
  cursor: default;
}
canvas.selecting { cursor: crosshair; }
.phase-foot { padding: 4px 2px 0 42px; font-size: 10px; opacity: .7; }
.phase-hint { color: var(--st-primary-color); text-align: right; }
"""


_JS = r"""
export default function(component) {
  const { data, setStateValue, parentElement } = component;
  const root = parentElement.querySelector('.phase-lab');
  const canvas = parentElement.querySelector('[data-canvas]');
  const ctx = canvas.getContext('2d');
  const slider = parentElement.querySelector('[data-slider]');
  const control = parentElement.querySelector('[data-period-control]');
  const stage = parentElement.querySelector('[data-stage]');
  const subtitle = parentElement.querySelector('[data-subtitle]');
  const periodOutput = parentElement.querySelector('[data-period]');
  const minOutput = parentElement.querySelector('[data-min]');
  const maxOutput = parentElement.querySelector('[data-max]');
  const hint = parentElement.querySelector('[data-hint]');

  const times = Array.isArray(data.time) ? data.time : [];
  const flux = Array.isArray(data.flux_ppt) ? data.flux_ppt : [];
  const tRef = Number(data.t_ref);
  const periodMin = Number(data.period_min);
  const periodMax = Number(data.period_max);
  const periodStep = Number(data.period_step);
  const yMin = Number(data.y_min);
  const yMax = Number(data.y_max);
  const mode = data.mode === 'select' ? 'select' : 'tune';
  let period = Number(data.period_days);
  let interval = data.interval && Number.isFinite(Number(data.interval.x0_hours))
    && Number.isFinite(Number(data.interval.x1_hours))
    ? {
        x0_hours: Number(data.interval.x0_hours),
        x1_hours: Number(data.interval.x1_hours),
      }
    : null;
  let drag = null;
  let frame = null;
  let cssWidth = 0;
  const cssHeight = 218;
  const margin = { left: 48, right: 12, top: 10, bottom: 27 };
  const previousViewport = canvas.__phaseViewport;
  let viewport = previousViewport
    && Math.abs(Number(previousViewport.period) - period) < 1e-9
    && Number.isFinite(previousViewport.x_min)
    && Number.isFinite(previousViewport.x_max)
    ? {
        x_min: Number(previousViewport.x_min),
        x_max: Number(previousViewport.x_max),
      }
    : { x_min: 0, x_max: period * 48 };

  slider.min = String(periodMin);
  slider.max = String(periodMax);
  slider.step = String(periodStep);
  slider.value = String(period);
  control.classList.toggle('is-hidden', mode !== 'tune');
  canvas.classList.toggle('selecting', mode === 'select' && !interval);
  stage.textContent = mode === 'tune' ? '② 주기 맞추기' : '③ 예상 감광 구간 선택';
  subtitle.textContent = mode === 'tune'
    ? '전체 관측점·모든 주기 블럭 겹침 · 휠: X축 확대 · 더블클릭: 초기화'
    : '모든 주기 블럭 겹침 · 좌드래그 선택 · 휠: X축 확대';
  minOutput.textContent = `${periodMin.toFixed(5)} d`;
  maxOutput.textContent = `${periodMax.toFixed(5)} d`;
  hint.textContent = mode === 'tune'
    ? '휠: 포인터 기준 X축 확대·축소 · 더블클릭 초기화'
    : interval
      ? '휠: X축 확대·축소 · 주황색 끝선 드래그'
      : '휠: X축 확대·축소 · 좌클릭 드래그로 구간 선택';

  function modulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function plotWidth() {
    return Math.max(1, cssWidth - margin.left - margin.right);
  }

  function plotHeight() {
    return Math.max(1, cssHeight - margin.top - margin.bottom);
  }

  function xLimitHours() {
    return period * 48;
  }

  function xToPixel(value) {
    return margin.left + (value - viewport.x_min)
      / Math.max(1e-12, viewport.x_max - viewport.x_min) * plotWidth();
  }

  function pixelToX(value) {
    const bounded = Math.max(margin.left, Math.min(cssWidth - margin.right, value));
    return viewport.x_min + (bounded - margin.left) / plotWidth()
      * (viewport.x_max - viewport.x_min);
  }

  function yToPixel(value) {
    return margin.top + (yMax - value)
      / Math.max(1e-12, yMax - yMin) * plotHeight();
  }

  function rememberViewport() {
    canvas.__phaseViewport = { period, ...viewport };
  }

  function resetViewport() {
    viewport = {
      x_min: 0,
      x_max: xLimitHours(),
    };
    rememberViewport();
  }

  function rescaleViewportForPeriod(newPeriod) {
    const oldFullSpan = xLimitHours();
    const oldVisibleSpan = viewport.x_max - viewport.x_min;
    const zoom = oldFullSpan / Math.max(1e-12, oldVisibleSpan);
    const centerFraction = (viewport.x_min + viewport.x_max)
      / Math.max(1e-12, 2 * oldFullSpan);
    period = newPeriod;
    const newFullSpan = xLimitHours();
    const newVisibleSpan = newFullSpan / Math.max(1, zoom);
    let nextXMin = centerFraction * newFullSpan - 0.5 * newVisibleSpan;
    nextXMin = Math.max(0, Math.min(newFullSpan - newVisibleSpan, nextXMin));
    viewport = { x_min: nextXMin, x_max: nextXMin + newVisibleSpan };
    rememberViewport();
  }

  function setPeriodLabel(blockCount) {
    const zoom = xLimitHours() / Math.max(1e-12, viewport.x_max - viewport.x_min);
    const zoomLabel = zoom > 1.01 ? ` · ${zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)}×` : '';
    const dataLabel = Number.isFinite(blockCount)
      ? ` · ${blockCount}블럭 · ${times.length.toLocaleString('ko-KR')}점`
      : '';
    periodOutput.textContent = `P = ${period.toFixed(7)} day${zoomLabel}${dataLabel}`;
  }

  function formatTick(hours) {
    const step = (viewport.x_max - viewport.x_min) / 4;
    if (step >= 10) return hours.toFixed(0);
    if (step >= 1) return hours.toFixed(1);
    if (step >= 0.1) return hours.toFixed(2);
    if (step >= 0.01) return hours.toFixed(3);
    return hours.toFixed(4);
  }

  function draw() {
    frame = null;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const wantedWidth = Math.max(360, Math.floor(root.getBoundingClientRect().width - 24));
    if (wantedWidth !== cssWidth || canvas.width !== Math.floor(wantedWidth * ratio)) {
      cssWidth = wantedWidth;
      canvas.width = Math.floor(cssWidth * ratio);
      canvas.height = Math.floor(cssHeight * ratio);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const style = getComputedStyle(root);
    const textColor = style.color || '#31333f';
    const primary = style.getPropertyValue('--st-primary-color').trim() || '#ff4b4b';
    const chartBottom = cssHeight - margin.bottom;

    ctx.fillStyle = 'rgba(127, 127, 127, 0.035)';
    ctx.fillRect(margin.left, margin.top, plotWidth(), chartBottom - margin.top);

    ctx.strokeStyle = 'rgba(127, 127, 127, 0.18)';
    ctx.lineWidth = 1;
    ctx.font = '10px sans-serif';
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 0.72;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let index = 0; index <= 4; index += 1) {
      const value = yMin + (yMax - yMin) * index / 4;
      const y = yToPixel(value);
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(cssWidth - margin.right, y);
      ctx.stroke();
      ctx.fillText(value.toFixed(2), margin.left - 6, y);
    }
    ctx.save();
    ctx.translate(11, (margin.top + chartBottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('상대 밝기 (ppt)', 0, 0);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let index = 0; index <= 4; index += 1) {
      const value = viewport.x_min + (viewport.x_max - viewport.x_min) * index / 4;
      const x = xToPixel(value);
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, chartBottom);
      ctx.stroke();
      ctx.fillText(formatTick(value), x, chartBottom + 5);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(margin.left, margin.top, plotWidth(), chartBottom - margin.top);
    ctx.clip();
    ctx.fillStyle = '#2563eb';
    const currentZoom = xLimitHours() / Math.max(1e-12, viewport.x_max - viewport.x_min);
    ctx.globalAlpha = Math.min(0.28, 0.07 + Math.log2(currentZoom + 1) * 0.04);
    const pointSize = Math.min(1.8, (cssWidth < 700 ? 1.0 : 1.15)
      + Math.log10(Math.max(1, currentZoom)) * 0.18);
    let blockCount = 0;
    let previousBlock = null;
    for (let index = 0; index < times.length && index < flux.length; index += 1) {
      const block = Math.floor((times[index] - tRef) / period);
      if (block !== previousBlock) {
        blockCount += 1;
        previousBlock = block;
      }
      const foldedHours = modulo(times[index] - tRef, period) * 24;
      const y = yToPixel(flux[index]);
      if (y < margin.top - 2 || y > chartBottom + 2) continue;
      const x1 = xToPixel(foldedHours);
      const x2 = xToPixel(foldedHours + period * 24);
      ctx.fillRect(x1, y, pointSize, pointSize);
      ctx.fillRect(x2, y, pointSize, pointSize);
    }

    if (interval) {
      const low = Math.min(interval.x0_hours, interval.x1_hours);
      const high = Math.max(interval.x0_hours, interval.x1_hours);
      const x0 = xToPixel(low);
      const x1 = xToPixel(high);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(249, 115, 22, 0.16)';
      ctx.fillRect(x0, margin.top, Math.max(1, x1 - x0), chartBottom - margin.top);
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2.5;
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, chartBottom);
        ctx.stroke();
        ctx.fillStyle = '#f97316';
        ctx.fillRect(x - 4, margin.top + 5, 8, 20);
      }
    }
    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(127, 127, 127, 0.42)';
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotWidth(), chartBottom - margin.top);
    setPeriodLabel(blockCount);
  }

  function scheduleDraw() {
    if (frame === null) frame = requestAnimationFrame(draw);
  }

  function pointerPosition(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function inPlot(position) {
    return position.x >= margin.left && position.x <= cssWidth - margin.right
      && position.y >= margin.top && position.y <= cssHeight - margin.bottom;
  }

  slider.oninput = (event) => {
    rescaleViewportForPeriod(Number(event.target.value));
    interval = null;
    scheduleDraw();
  };
  slider.onchange = (event) => {
    const newPeriod = Number(event.target.value);
    if (Math.abs(newPeriod - period) > 1e-12) {
      rescaleViewportForPeriod(newPeriod);
    }
    setStateValue('period_days', period);
  };

  canvas.onpointerdown = (event) => {
    if (mode !== 'select') return;
    const position = pointerPosition(event);
    if (!inPlot(position)) return;
    const xValue = pixelToX(position.x);
    if (interval) {
      const leftPixel = xToPixel(Math.min(interval.x0_hours, interval.x1_hours));
      const rightPixel = xToPixel(Math.max(interval.x0_hours, interval.x1_hours));
      const leftDistance = Math.abs(position.x - leftPixel);
      const rightDistance = Math.abs(position.x - rightPixel);
      if (Math.min(leftDistance, rightDistance) > 11) return;
      drag = { type: leftDistance <= rightDistance ? 'left' : 'right' };
    } else {
      drag = { type: 'new', anchor: xValue };
      interval = { x0_hours: xValue, x1_hours: xValue };
    }
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    scheduleDraw();
  };

  canvas.onpointermove = (event) => {
    if (!drag) return;
    const xValue = pixelToX(pointerPosition(event).x);
    if (drag.type === 'new') {
      interval = {
        x0_hours: Math.min(drag.anchor, xValue),
        x1_hours: Math.max(drag.anchor, xValue),
      };
    } else if (drag.type === 'left') {
      interval.x0_hours = xValue;
    } else {
      interval.x1_hours = xValue;
    }
    scheduleDraw();
  };

  function handleWheel(event) {
    const position = pointerPosition(event);
    if (!inPlot(position)) return;
    event.preventDefault();
    event.stopPropagation();

    const normalizedDelta = event.deltaY
      * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? cssHeight : 1);
    const factor = Math.max(0.5, Math.min(2.0, Math.exp(normalizedDelta * 0.0015)));
    const fullXSpan = xLimitHours();
    const oldXSpan = viewport.x_max - viewport.x_min;
    const newXSpan = Math.max(fullXSpan / 500, Math.min(fullXSpan, oldXSpan * factor));
    const xRatio = (position.x - margin.left) / plotWidth();
    const anchorX = pixelToX(position.x);

    let nextXMin = anchorX - xRatio * newXSpan;
    nextXMin = Math.max(0, Math.min(fullXSpan - newXSpan, nextXMin));
    viewport = {
      x_min: nextXMin,
      x_max: nextXMin + newXSpan,
    };
    rememberViewport();
    scheduleDraw();
  }

  canvas.addEventListener('wheel', handleWheel, { passive: false });

  canvas.ondblclick = (event) => {
    event.preventDefault();
    resetViewport();
    scheduleDraw();
  };

  function finishPointer(event) {
    if (!drag || !interval) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const low = Math.max(0, Math.min(interval.x0_hours, interval.x1_hours));
    const high = Math.min(xLimitHours(), Math.max(interval.x0_hours, interval.x1_hours));
    drag = null;
    const visibleSpan = viewport.x_max - viewport.x_min;
    if (high - low < visibleSpan / Math.max(2000, plotWidth() * 4)) {
      interval = null;
      scheduleDraw();
      return;
    }
    interval = { x0_hours: low, x1_hours: high, revision: Date.now() };
    canvas.classList.remove('selecting');
    hint.textContent = '휠: X축 확대·축소 · 주황색 끝선 드래그';
    setStateValue('interval', interval);
    scheduleDraw();
  }

  canvas.onpointerup = finishPointer;
  canvas.onpointercancel = finishPointer;

  const observer = new ResizeObserver(scheduleDraw);
  observer.observe(root);
  rememberViewport();
  scheduleDraw();

  return () => {
    observer.disconnect();
    canvas.removeEventListener('wheel', handleWheel);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
"""


_phase_selector = st.components.v2.component(
    "manual_phase_selector",
    html=_HTML,
    css=_CSS,
    js=_JS,
)


def phase_selector(
    *,
    time: Sequence[float],
    flux_ppt: Sequence[float],
    t_ref: float,
    period_days: float,
    period_min: float,
    period_max: float,
    period_step: float,
    y_min: float,
    y_max: float,
    mode: str,
    interval: dict | None = None,
    key: str,
):
    """컴포넌트를 표시하고 확정된 주기/구간 상태를 반환한다."""
    state = st.session_state.get(key, {})
    state_period = float(state.get("period_days", period_days))
    state_interval = state.get("interval", interval)
    data = {
        "time": list(time),
        "flux_ppt": list(flux_ppt),
        "t_ref": float(t_ref),
        "period_days": state_period,
        "period_min": float(period_min),
        "period_max": float(period_max),
        "period_step": float(period_step),
        "y_min": float(y_min),
        "y_max": float(y_max),
        "mode": mode,
        "interval": state_interval,
    }
    return _phase_selector(
        key=key,
        data=data,
        default={"period_days": state_period, "interval": state_interval},
        width="stretch",
        height=304,
        on_period_days_change=lambda: None,
        on_interval_change=lambda: None,
    )

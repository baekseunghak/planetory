import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { normalizeInterval } from '../observation-math';
import { allowedWidth } from '../observation-data';

export type Interval = { phase_start: number; phase_end: number };
export type View = { zoom: number; center: number };
type Band = { start: number; end: number };

interface Props {
  label: string;
  x: readonly number[] | Float64Array;
  y: readonly number[];
  domain: [number, number];
  line?: boolean;
  repeat?: boolean;
  view: View;
  onView: (view: View) => void;
  interval?: Interval | null;
  onInterval?: (interval: Interval) => void;
  onPreview?: (interval: Interval | null) => void;
  onInvalid?: (message: string) => void;
  minWidth?: number;
  maxWidth?: number;
  bands?: Band[];
  markers?: { x: number; label: string }[];
  disabled?: boolean;
  onPick?: (x: number) => void;
  unit: string;
}

export function ObservationChart({
  label,
  x,
  y,
  domain,
  line = false,
  repeat = false,
  view,
  onView,
  interval,
  onInterval,
  onPreview,
  onInvalid,
  minWidth = 0.001,
  maxWidth = 0.25,
  bands = [],
  markers = [],
  disabled = false,
  onPick,
  unit,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 220 });
  const [brush, setBrush] = useState<Band | null>(null);
  const gesture = useRef<{
    start: number;
    end: number;
    mode: 'select' | 'pan' | 'start' | 'end';
    center: number;
    fixed?: number;
  } | null>(null);
  const span = (domain[1] - domain[0]) / view.zoom;
  const low = view.center - span / 2;
  const high = view.center + span / 2;
  const pos = (v: number) => ((v - low) / span) * 100;
  const latest = useRef({ view, low, span, disabled, domain, repeat, onView });
  latest.current = { view, low, span, disabled, domain, repeat, onView };

  useEffect(() => {
    const element = plot.current!;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = plot.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const state = latest.current;
      if (state.disabled) return;
      const ratio = Math.max(
        0,
        Math.min(1, (event.clientX - element.getBoundingClientRect().left) / element.clientWidth),
      );
      const anchor = state.low + ratio * state.span;
      const zoom = Math.max(1, Math.min(8, state.view.zoom * (event.deltaY < 0 ? 1.25 : 0.8)));
      const nextSpan = (state.domain[1] - state.domain[0]) / zoom;
      let center = anchor + (0.5 - ratio) * nextSpan;
      if (!state.repeat)
        center = Math.max(
          state.domain[0] + nextSpan / 2,
          Math.min(state.domain[1] - nextSpan / 2, center),
        );
      state.onView({ zoom, center });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  let minY = Infinity,
    maxY = -Infinity;
  for (const value of y) {
    minY = Math.min(minY, value);
    maxY = Math.max(maxY, value);
  }
  const margin = (maxY - minY || 0.01) * 0.08;
  minY -= margin;
  maxY += margin;

  useEffect(() => {
    const element = canvas.current!;
    const ctx = element.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    element.width = Math.round(size.width * dpr);
    element.height = Math.round(size.height * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.strokeStyle = '#2a3441';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i / 4) * size.height);
      ctx.lineTo(size.width, (i / 4) * size.height);
      ctx.stroke();
    }
    const px = (v: number) => ((v - low) / span) * size.width;
    const py = (v: number) => size.height - ((v - minY) / (maxY - minY)) * size.height;
    ctx.fillStyle = '#a6e8ce';
    ctx.strokeStyle = '#a6e8ce';
    ctx.globalAlpha = line ? 0.9 : 0.42;
    if (line) ctx.beginPath();
    // Every valid observation is rasterized. No binned series is used for folding or display.
    for (let i = 0; i < x.length; i++) {
      if (line) {
        if (i === 0) ctx.moveTo(px(x[i]), py(y[i]));
        else ctx.lineTo(px(x[i]), py(y[i]));
      } else if (repeat) {
        for (let k = Math.ceil(low - x[i]); k <= Math.floor(high - x[i]); k++)
          ctx.fillRect(px(x[i] + k), py(y[i]), 1.5, 1.5);
      } else if (x[i] >= low && x[i] <= high) ctx.fillRect(px(x[i]), py(y[i]), 1.5, 1.5);
    }
    if (line) ctx.stroke();
    ctx.globalAlpha = 1;
  }, [x, y, size, low, high, span, minY, maxY, repeat, line]);

  const displayBands = [...bands];
  if (interval) {
    for (
      let k = Math.ceil(low - interval.phase_end);
      k <= Math.floor(high - interval.phase_start);
      k++
    )
      displayBands.push({ start: interval.phase_start + k, end: interval.phase_end + k });
  }
  if (brush) displayBands.push(brush);
  const commit = (start: number, end: number) => {
    try {
      const value = normalizeInterval(start, end);
      if (!allowedWidth(value.phase_start, value.phase_end, minWidth, maxWidth)) {
        throw new Error('width');
      }
      onInterval?.(value);
    } catch {
      onInvalid?.(
        `선택 폭은 위상 ${minWidth}~${maxWidth} 범위여야 합니다. 기존 선택을 유지했어요.`,
      );
    }
  };
  const coordinate = (event: ReactPointerEvent) => {
    const rect = plot.current!.getBoundingClientRect();
    return low + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span;
  };
  const startGesture = (
    event: ReactPointerEvent,
    mode: 'select' | 'start' | 'end' = 'select',
    fixed?: number,
  ) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    plot.current!.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = coordinate(event);
    gesture.current = {
      start,
      end: start,
      mode: event.shiftKey ? 'pan' : mode,
      center: view.center,
      fixed,
    };
  };
  const moveGesture = (event: ReactPointerEvent) => {
    const active = gesture.current;
    if (!active || disabled) return;
    const point = coordinate(event);
    active.end = point;
    if (active.mode === 'pan') {
      const rect = plot.current!.getBoundingClientRect();
      const absolute =
        active.center -
        span / 2 +
        Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * span;
      let center = active.center + active.start - absolute;
      if (!repeat) center = Math.max(domain[0] + span / 2, Math.min(domain[1] - span / 2, center));
      onView({ ...view, center });
    } else if (onInterval) {
      const start =
        active.mode === 'end'
          ? active.fixed!
          : active.mode === 'start'
            ? point
            : Math.min(active.start, point);
      const end =
        active.mode === 'start'
          ? active.fixed!
          : active.mode === 'end'
            ? point
            : Math.max(active.start, point);
      setBrush({ start, end });
      try {
        onPreview?.(
          allowedWidth(start, end, minWidth, maxWidth) ? normalizeInterval(start, end) : null,
        );
      } catch {
        onPreview?.(null);
      }
    }
  };
  const finishGesture = () => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (!disabled && active.mode !== 'pan') {
      if (onInterval) {
        const start =
          active.mode === 'end'
            ? active.fixed!
            : active.mode === 'start'
              ? active.end
              : Math.min(active.start, active.end);
        const end =
          active.mode === 'start'
            ? active.fixed!
            : active.mode === 'end'
              ? active.end
              : Math.max(active.start, active.end);
        commit(start, end);
      } else onPick?.(active.end);
    }
    setBrush(null);
    onPreview?.(null);
  };
  const resetView = () => onView({ zoom: 1, center: (domain[0] + domain[1]) / 2 });
  const keyDown = (event: KeyboardEvent) => {
    if (disabled || event.target !== event.currentTarget) return;
    if (event.key === '0') {
      event.preventDefault();
      resetView();
    }
    if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      const levels = [1, 2, 4, 8];
      const zoom =
        event.key === '-'
          ? ([...levels].reverse().find((z) => z < view.zoom) ?? 1)
          : (levels.find((z) => z > view.zoom) ?? 8);
      const nextSpan = (domain[1] - domain[0]) / zoom;
      const center = repeat
        ? view.center
        : Math.max(domain[0] + nextSpan / 2, Math.min(domain[1] - nextSpan / 2, view.center));
      onView({ zoom, center });
    }
  };
  const offset = interval
    ? Math.round(view.center - (interval.phase_start + interval.phase_end) / 2)
    : 0;
  const handle = (kind: 'start' | 'end') => {
    if (!interval) return null;
    const value = (kind === 'start' ? interval.phase_start : interval.phase_end) + offset;
    const fixed = (kind === 'start' ? interval.phase_end : interval.phase_start) + offset;
    if (value < low || value > high) return null;
    return (
      <button
        type="button"
        className="phase-handle"
        role="slider"
        key={kind}
        aria-label={kind === 'start' ? '위상 시작 핸들' : '위상 끝 핸들'}
        aria-valuemin={kind === 'start' ? fixed - maxWidth : fixed + minWidth}
        aria-valuemax={kind === 'start' ? fixed - minWidth : fixed + maxWidth}
        aria-valuenow={value}
        aria-valuetext={`위상 ${value.toFixed(5)}`}
        aria-disabled={disabled}
        disabled={disabled}
        style={{ left: `${pos(value)}%` }}
        onPointerDown={(e) => startGesture(e, kind, fixed)}
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const step = (e.shiftKey ? 0.01 : 0.001) / view.zoom;
          const next = value + (e.key === 'ArrowLeft' ? -step : step);
          commit(kind === 'start' ? next : fixed, kind === 'end' ? next : fixed);
        }}
      >
        <span>{kind === 'start' ? '시작' : '끝'}</span>
      </button>
    );
  };
  return (
    <figure className={'observation-chart' + (disabled ? ' chart-disabled' : '')}>
      <div className="chart-y-labels">
        <span>{maxY.toFixed(line ? 4 : 3)}</span>
        <span>{((minY + maxY) / 2).toFixed(line ? 4 : 3)}</span>
        <span>{minY.toFixed(line ? 4 : 3)}</span>
      </div>
      <div
        ref={plot}
        className="observation-plot"
        tabIndex={disabled ? -1 : 0}
        role="group"
        aria-label={label}
        aria-disabled={disabled}
        data-point-count={x.length}
        onPointerDown={(e) => startGesture(e)}
        onPointerMove={moveGesture}
        onPointerUp={finishGesture}
        onPointerCancel={() => {
          gesture.current = null;
          setBrush(null);
          onPreview?.(null);
        }}
        onDoubleClick={() => {
          if (!disabled) resetView();
        }}
        onKeyDown={keyDown}
      >
        <canvas ref={canvas} aria-hidden="true" />
        {displayBands
          .filter((b) => b.end > low && b.start < high)
          .map((band, i) => (
            <div
              key={i}
              className="transit-band"
              style={{
                left: `${Math.max(0, pos(band.start))}%`,
                width: `${Math.min(100, pos(band.end)) - Math.max(0, pos(band.start))}%`,
              }}
            />
          ))}
        {markers
          .filter((m) => m.x >= low && m.x <= high)
          .map((m, i) => (
            <div key={i} className="chart-marker" style={{ left: `${pos(m.x)}%` }}>
              <span>{m.label}</span>
            </div>
          ))}
        {handle('start')}
        {handle('end')}
      </div>
      <div className="chart-x-labels">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i}>{(low + (span * i) / 4).toFixed(repeat ? 2 : 1)}</span>
        ))}
      </div>
      <figcaption>
        <span>{unit} · 휠 확대 / Shift+드래그 이동 / 0 초기화</span>
        <span data-testid={repeat ? 'fold-zoom' : undefined}>×{Number(view.zoom.toFixed(2))}</span>
      </figcaption>
    </figure>
  );
}

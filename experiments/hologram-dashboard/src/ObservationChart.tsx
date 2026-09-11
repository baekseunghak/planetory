import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ChartKind, Observation, Peak, PhaseRange } from './types';
import { foldPoints, formatPowerTick, normalizePhaseRange, positiveMod, powerAxisMaximum, zoomWindow } from './chart-math';
import './chart.css';

interface Props {
  data: Observation; kind: ChartKind; period: number; range: PhaseRange | null;
  onRangeChange?: (range: PhaseRange | null) => void;
  onPeakSelect?: (peak: Peak) => void; compact?: boolean; resetKey?: number;
  onBusyChange?: (busy: boolean) => void;
}
interface FoldResult {
  dataId: string; period: number; revision: number;
  phases: Float64Array; means: Float64Array; counts: Uint32Array;
}
const MARGIN = { left: 54, right: 17, top: 27, bottom: 31 };
const COMPACT_MARGIN = { left: 45, right: 12, top: 20, bottom: 21 };
const TITLES = { light: '밝기 변화 곡선', period: '반복 주기 그래프', phase: '주기로 겹친 곡선' };
const FOLD_TIMEOUT_MS = 15_000;
const number = (v: number, digits = 3) => Number.isFinite(v) ? v.toFixed(digits) : '—';

export function ObservationChart({ data, kind, period, range, onRangeChange, onPeakSelect,
  compact = false, resetKey = 0, onBusyChange }: Props) {
  const margin = compact ? COMPACT_MARGIN : MARGIN;
  const canvas = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const foldTimeout = useRef<number | null>(null);
  const revision = useRef(0);
  const [folded, setFolded] = useState<FoldResult | null>(null);
  const [busy, setBusy] = useState(kind === 'phase');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState(1);
  const [size, setSize] = useState({ width: 600, height: compact ? 177 : 245 });
  const [readout, setReadout] = useState<string | null>(null);
  const dragging = useRef<{ mode: 'new' | 'start' | 'end'; anchor: number } | null>(null);
  const dataId = `${data.id}:${data.bundle_id}:${data.point_count}`;
  const currentDataId = useRef(dataId);
  currentDataId.current = dataId;
  const clearFoldTimeout = useCallback(() => {
    if (foldTimeout.current !== null) window.clearTimeout(foldTimeout.current);
    foldTimeout.current = null;
  }, []);

  useEffect(() => {
    if (kind !== 'phase') return;
    try {
      const instance = new Worker(new URL('./fold.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      instance.onmessage = (event: MessageEvent) => {
        const result = event.data;
        if (worker.current !== instance || result.revision !== revision.current || result.dataId !== currentDataId.current) return;
        if (result.type !== 'error' && result.type !== 'folded') return;
        clearFoldTimeout();
        setBusy(false);
        if (result.type === 'error') { setError(result.message); return; }
        setError(''); setFolded(result);
      };
      instance.onerror = () => {
        if (worker.current !== instance) return;
        clearFoldTimeout();
        instance.onmessage = null; instance.onerror = null;
        instance.terminate(); worker.current = null;
        setBusy(false);
        setError('접기 계산이 중단되었습니다. 다시 시도해 주세요.');
      };
      return () => {
        clearFoldTimeout();
        revision.current++;
        instance.onmessage = null; instance.onerror = null;
        instance.terminate(); worker.current = null;
      };
    } catch {
      worker.current = null;
    }
  }, [kind, clearFoldTimeout]);

  useEffect(() => {
    if (kind !== 'phase' || !worker.current) return;
    const times = Float64Array.from(data.time_btjd);
    const flux = Float64Array.from(data.normalized_flux);
    worker.current.postMessage({ type: 'data', dataId, times, flux,
      reference: data.fold_reference_time_btjd }, [times.buffer, flux.buffer]);
  }, [data, dataId, kind]);

  useEffect(() => {
    if (kind !== 'phase') return;
    const nextRevision = ++revision.current;
    setBusy(true); setError('');
    setCenter(1);
    if (worker.current) {
      const instance = worker.current;
      foldTimeout.current = window.setTimeout(() => {
        if (worker.current !== instance || revision.current !== nextRevision || currentDataId.current !== dataId) return;
        foldTimeout.current = null;
        revision.current++;
        instance.onmessage = null; instance.onerror = null;
        instance.terminate(); worker.current = null;
        setBusy(false);
        setError('접기 계산 응답이 지연되었습니다. 다시 시도해 주세요.');
      }, FOLD_TIMEOUT_MS);
      instance.postMessage({ type: 'fold', dataId, period, revision: nextRevision });
      return clearFoldTimeout;
    }
    // A usable fallback for browsers that cannot create module workers.
    const timer = window.setTimeout(() => {
      try {
        const result = foldPoints(data.time_btjd, data.normalized_flux, period, data.fold_reference_time_btjd);
        if (nextRevision !== revision.current || dataId !== currentDataId.current) return;
        setFolded({ ...result, dataId, period, revision: nextRevision });
      } catch { setError('주기 또는 관측 배열을 확인해 주세요.'); }
      setBusy(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data, dataId, period, kind, retry, clearFoldTimeout]);

  useEffect(() => { setZoom(1); setCenter(1); }, [resetKey, dataId]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const prepared = useMemo(() => {
    let low = Infinity, high = -Infinity;
    for (const value of data.normalized_flux) {
      if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
    }
    if (!Number.isFinite(low)) { low = 0.98; high = 1.02; }
    const pad = Math.max((high - low) * 0.08, 0.00015);
    const windows = [...data.observation_windows].sort((a, b) => a.start_btjd - b.start_btjd);
    const fallbackStart = data.time_btjd[0] ?? 0;
    const fallbackEnd = data.time_btjd[data.time_btjd.length - 1] ?? 1;
    if (!windows.length) windows.push({ source_index: 0, sector: 0, start_btjd: fallbackStart, end_btjd: fallbackEnd });
    const totalObserved = windows.reduce((sum, w) => sum + w.end_btjd - w.start_btjd, 0);
    const gap = Math.max(totalObserved * 0.018, 0.08);
    let cursor = 0;
    const segments = windows.map(w => {
      const segment = { ...w, offset: cursor, length: w.end_btjd - w.start_btjd };
      cursor += segment.length + gap;
      return segment;
    });
    const timeX = new Float64Array(data.time_btjd.length);
    for (let i = 0; i < timeX.length; i++) {
      const time = data.time_btjd[i];
      const segment = segments.find(w => time >= w.start_btjd - 1e-8 && time <= w.end_btjd + 1e-8);
      timeX[i] = segment ? segment.offset + time - segment.start_btjd : NaN;
    }
    const pMin = Math.max(0.001, data.periodogram.period_days[0] ?? 0.5);
    const pMax = Math.max(pMin * 2, data.periodogram.period_days.at(-1) ?? 40);
    return { low: low - pad, high: high + pad, timeX, segments, timeSpan: Math.max(cursor - gap, 0.01),
      pMin, pMax, powerMax: powerAxisMaximum(data.periodogram.power), baseline: fallbackEnd - fallbackStart };
  }, [data]);

  const [xMin, xMax] = kind === 'phase' ? zoomWindow(zoom, center)
    : kind === 'period' ? [Math.log10(prepared.pMin), Math.log10(prepared.pMax)] : [0, prepared.timeSpan];
  const plotWidth = Math.max(20, size.width - margin.left - margin.right);
  const plotHeight = Math.max(20, size.height - margin.top - margin.bottom);
  const toX = useCallback((v: number) => margin.left + (v - xMin) / (xMax - xMin) * plotWidth,
    [xMin, xMax, plotWidth, margin]);
  const fromX = useCallback((pixel: number) => xMin + (pixel - margin.left) / plotWidth * (xMax - xMin),
    [xMin, xMax, plotWidth, margin]);
  const displayPeriod = kind === 'phase' && folded?.dataId === dataId ? folded.period : period;
  const phaseReady = !busy && !error && folded?.dataId === dataId && folded.period === period;
  const canEditRange = kind === 'phase' && !compact && !!onRangeChange && phaseReady;

  // Capture this chart's owner so switching kinds still releases its callback,
  // even when the next render no longer supplies onBusyChange.
  useLayoutEffect(() => {
    if (kind !== 'phase') return;
    return () => onBusyChange?.(false);
  }, [kind, onBusyChange]);
  useLayoutEffect(() => {
    if (kind === 'phase') onBusyChange?.(!phaseReady);
  }, [kind, onBusyChange, phaseReady]);

  const draw = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(size.width * ratio), height = Math.round(size.height * ratio);
    if (element.width !== width || element.height !== height) { element.width = width; element.height = height; }
    const ctx = element.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const yMin = kind === 'period' ? 0 : prepared.low;
    const yMax = kind === 'period' ? prepared.powerMax : prepared.high;
    const toY = (value: number) => margin.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;
    ctx.font = `${compact ? 9 : 10}px "IBM Plex Mono", "Consolas", monospace`;
    ctx.lineWidth = 1;
    const yTicks = compact ? 2 : 4;
    const xTicks = compact ? size.width < 350 ? 2 : 3 : 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = margin.top + plotHeight * i / yTicks;
      ctx.strokeStyle = 'rgba(131,211,216,.105)';
      ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(size.width - margin.right, y); ctx.stroke();
      ctx.fillStyle = 'rgba(167,199,205,.7)'; ctx.textAlign = 'right';
      const value = yMax - (yMax - yMin) * i / yTicks;
      ctx.fillText(kind === 'period' ? formatPowerTick(value, yMax) : number(value, yMax - yMin < 0.02 ? 4 : 3), margin.left - 9, y + 3);
    }
    for (let i = 0; i <= xTicks; i++) {
      const raw = xMin + (xMax - xMin) * i / xTicks;
      const x = toX(raw);
      ctx.strokeStyle = 'rgba(131,211,216,.07)';
      ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotHeight); ctx.stroke();
      let value = raw;
      if (kind === 'period') value = 10 ** raw;
      if (kind === 'light') {
        const segment = [...prepared.segments].reverse().find(s => raw >= s.offset) ?? prepared.segments[0];
        value = segment.start_btjd + Math.min(segment.length, Math.max(0, raw - segment.offset));
      }
      ctx.fillStyle = 'rgba(167,199,205,.7)'; ctx.textAlign = i === 0 ? 'left' : i === xTicks ? 'right' : 'center';
      ctx.fillText(number(value, kind === 'light' ? 1 : 2), x, margin.top + plotHeight + (compact ? 14 : 18));
    }
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(151,215,221,.75)';
    ctx.fillText(compact ? kind === 'period' ? 'BLS' : 'FLUX' : kind === 'period' ? 'BLS POWER' : 'NORMALIZED FLUX', margin.left, compact ? 11 : 14);
    ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(151,215,221,.6)';
    const axisLabel = compact ? kind === 'light' ? 'BTJD' : kind === 'period' ? 'PERIOD d' : 'PHASE'
      : kind === 'light' ? 'BTJD · 관측 공백 압축' : kind === 'period' ? 'PERIOD / DAYS · LOG' : 'PHASE · 2 CYCLES';
    ctx.fillText(axisLabel, size.width - margin.right, compact ? 11 : 14);

    ctx.save(); ctx.beginPath(); ctx.rect(margin.left, margin.top, plotWidth, plotHeight); ctx.clip();
    if (range && (kind !== 'phase' || phaseReady)) {
      ctx.fillStyle = 'rgba(245,194,107,.11)';
      if (kind === 'phase') {
        for (let cycle = -1; cycle <= 2; cycle++) {
          const left = toX(range[0] + cycle), right = toX(range[1] + cycle);
          ctx.fillRect(left, margin.top, right - left, plotHeight);
        }
      } else if (kind === 'light') {
        const phaseCenter = (range[0] + range[1]) / 2;
        const duration = (range[1] - range[0]) * period;
        for (const segment of prepared.segments) {
          const k0 = Math.floor((segment.start_btjd - data.fold_reference_time_btjd) / period - phaseCenter) - 1;
          const k1 = Math.ceil((segment.end_btjd - data.fold_reference_time_btjd) / period - phaseCenter) + 1;
          for (let k = k0; k <= k1; k++) {
            const epoch = data.fold_reference_time_btjd + (phaseCenter + k) * period;
            const start = Math.max(segment.start_btjd, epoch - duration / 2);
            const end = Math.min(segment.end_btjd, epoch + duration / 2);
            if (start < end) ctx.fillRect(toX(segment.offset + start - segment.start_btjd), margin.top,
              (end - start) / (xMax - xMin) * plotWidth, plotHeight);
          }
        }
      }
    }
    if (kind === 'period') {
      const threshold = prepared.baseline / 2;
      if (threshold > prepared.pMin && threshold < prepared.pMax) {
        const x = toX(Math.log10(threshold));
        ctx.fillStyle = 'rgba(233,173,92,.055)'; ctx.fillRect(x, margin.top, size.width - x, plotHeight);
      }
      ctx.strokeStyle = '#80e5eb'; ctx.lineWidth = 1.3; ctx.beginPath();
      let active = false;
      for (let i = 0; i < data.periodogram.period_days.length; i++) {
        const p = data.periodogram.period_days[i], power = data.periodogram.power[i];
        if (!Number.isFinite(p) || !Number.isFinite(power) || p <= 0) { active = false; continue; }
        const x = toX(Math.log10(p)), y = toY(power);
        if (active) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        active = true;
      }
      ctx.stroke();
      const selectedX = toX(Math.log10(period));
      ctx.strokeStyle = 'rgba(245,194,107,.8)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(selectedX, margin.top); ctx.lineTo(selectedX, margin.top + plotHeight); ctx.stroke(); ctx.setLineDash([]);
    } else {
      const phases = folded?.dataId === dataId ? folded.phases : null;
      ctx.fillStyle = kind === 'phase' ? 'rgba(114,207,221,.24)' : 'rgba(114,213,225,.45)';
      ctx.beginPath();
      for (let i = 0; i < data.normalized_flux.length; i++) {
        const value = data.normalized_flux[i];
        if (!Number.isFinite(value)) continue;
        const raw = kind === 'phase' ? phases?.[i] : prepared.timeX[i];
        if (raw === undefined || !Number.isFinite(raw)) continue;
        const y = toY(value);
        for (let cycle = 0; cycle < (kind === 'phase' ? 2 : 1); cycle++) {
          const xv = raw + cycle;
          if (xv >= xMin && xv <= xMax) ctx.rect(toX(xv), y, 1.15, 1.15);
        }
      }
      ctx.fill();
      if (kind === 'phase' && folded?.dataId === dataId) {
        ctx.strokeStyle = '#d9f6f1'; ctx.lineWidth = 1.45; ctx.beginPath();
        for (let cycle = 0; cycle < 2; cycle++) {
          let active = false;
          for (let i = 0; i < folded.means.length; i++) {
            const mean = folded.means[i];
            if (!Number.isFinite(mean)) { active = false; continue; }
            const x = toX((i + 0.5) / folded.means.length + cycle), y = toY(mean);
            if (active) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            active = true;
          }
        }
        ctx.stroke();
      }
    }
    if (kind === 'light') {
      for (const segment of prepared.segments) {
        const x = toX(segment.offset);
        ctx.strokeStyle = 'rgba(138,190,205,.25)'; ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotHeight); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(172,211,218,.65)'; ctx.textAlign = 'left'; ctx.fillText(`S${segment.sector}`, x + 5, margin.top + 13);
      }
    }
    if (kind === 'phase' && range && phaseReady) {
      ctx.strokeStyle = '#f5c26b'; ctx.lineWidth = 1.3; ctx.fillStyle = '#f5c26b';
      for (let cycle = -1; cycle <= 2; cycle++) {
        for (const phase of range) {
          const x = toX(phase + cycle);
          ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, margin.top + plotHeight); ctx.stroke();
          if (canEditRange) ctx.fillRect(x - 3, margin.top + plotHeight / 2 - 11, 6, 22);
        }
      }
    }
    ctx.restore();
    if (kind === 'period') {
      for (const peak of data.peaks) {
        const x = toX(Math.log10(peak.period_days));
        ctx.fillStyle = Math.abs(period - peak.period_days) < (peak.period_step || 1e-6) ? '#f5c26b' : '#9ddde5';
        ctx.textAlign = 'center'; ctx.fillText(`${peak.rank}`, x, margin.top + 13);
      }
    }
  }, [data, kind, period, range, folded, prepared, size, dataId, phaseReady, canEditRange, compact, margin, xMin, xMax, plotWidth, plotHeight, toX]);

  useEffect(() => { const frame = requestAnimationFrame(draw); return () => cancelAnimationFrame(frame); }, [draw]);

  const changeZoom = useCallback((next: number, anchor = center) => {
    const bounded = Math.max(1, Math.min(8, next));
    const fractional = (anchor - xMin) / (xMax - xMin);
    const newWidth = 2 / bounded;
    const nextMin = anchor - fractional * newWidth;
    setZoom(bounded);
    setCenter(bounded === 1 ? 1 : Math.max(newWidth / 2, Math.min(2 - newWidth / 2, nextMin + newWidth / 2)));
  }, [center, xMin, xMax]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || kind !== 'phase') return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const localX = event.clientX - element.getBoundingClientRect().left;
      if (localX < margin.left || localX > size.width - margin.right) return;
      changeZoom(zoom * (event.deltaY < 0 ? 1.22 : 1 / 1.22), fromX(localX));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [kind, zoom, changeZoom, fromX, size.width, margin]);

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(event);
    if (x < margin.left || x > size.width - margin.right || y < margin.top || y > margin.top + plotHeight) return;
    event.currentTarget.focus();
    if (kind === 'period') {
      const peak = [...data.peaks].sort((a, b) => Math.abs(toX(Math.log10(a.period_days)) - x)
        - Math.abs(toX(Math.log10(b.period_days)) - x))[0];
      if (peak) onPeakSelect?.(peak);
      return;
    }
    if (!canEditRange || !onRangeChange) return;
    const raw = fromX(x);
    dragging.current = { mode: 'new', anchor: raw };
    if (range) {
      for (let cycle = -1; cycle <= 2; cycle++) {
        if (Math.abs(toX(range[0] + cycle) - x) < 10) dragging.current = { mode: 'start', anchor: range[1] + cycle };
        else if (Math.abs(toX(range[1] + cycle) - x) < 10) dragging.current = { mode: 'end', anchor: range[0] + cycle };
      }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x } = localPoint(event);
    const raw = fromX(Math.max(margin.left, Math.min(size.width - margin.right, x)));
    setReadout(kind === 'phase' ? `위상 ${number(positiveMod(raw), 4)}`
      : kind === 'period' ? `${number(10 ** raw, 4)} 일` : null);
    const drag = dragging.current;
    if (!drag || !canEditRange || !onRangeChange) return;
    const min = data.selection_rules.min_width_phase, max = data.selection_rules.max_width_phase;
    if (drag.mode === 'start') onRangeChange(normalizePhaseRange(Math.max(drag.anchor - max, Math.min(drag.anchor - min, raw)), drag.anchor, min, max));
    else if (drag.mode === 'end') onRangeChange(normalizePhaseRange(drag.anchor, Math.min(drag.anchor + max, Math.max(drag.anchor + min, raw)), min, max));
    else onRangeChange(normalizePhaseRange(drag.anchor, raw, min, max));
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (kind !== 'phase') return;
    if (event.key === '0') { event.preventDefault(); setZoom(1); setCenter(1); }
    if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      const levels = [1, 2, 4, 8];
      const next = event.key === '-' ? [...levels].reverse().find(v => v < zoom - 0.01) ?? 1 : levels.find(v => v > zoom + 0.01) ?? 8;
      changeZoom(next);
    }
    if (event.key === 'Escape' && canEditRange) {
      event.preventDefault(); event.stopPropagation();
      dragging.current = null;
      onRangeChange?.(null);
    }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && range && canEditRange) {
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      const step = direction * Math.max(data.selection_rules.min_width_phase, 0.001);
      const min = data.selection_rules.min_width_phase, max = data.selection_rules.max_width_phase;
      const start = range[0] + (event.shiftKey ? 0 : step);
      const end = event.shiftKey ? Math.max(start + min, Math.min(start + max, range[1] + step)) : range[1] + step;
      onRangeChange?.(normalizePhaseRange(start, end, min, max));
    }
    if (event.key === 'Enter' && !range && canEditRange) {
      event.preventDefault();
      onRangeChange?.(normalizePhaseRange(center - 0.02, center + 0.02,
        data.selection_rules.min_width_phase, data.selection_rules.max_width_phase));
    }
  };

  return <div className={`holo-chart${compact ? ' holo-chart--compact' : ''}`}>
    <div className="holo-chart__toolbar">
      <span className="holo-chart__legend"><i />{kind === 'phase' ? `${data.point_count.toLocaleString()} 관측점 · 평균선` : kind === 'light' ? `${data.point_count.toLocaleString()} 관측점` : '봉우리를 선택하세요'}</span>
      {kind === 'phase' && <div className="holo-chart__zoom" aria-label="위상 그래프 가로 확대">
        <button type="button" onClick={() => changeZoom(zoom / 2)} disabled={zoom <= 1} aria-label="가로 축소">−</button>
        <button type="button" onClick={() => { setZoom(1); setCenter(1); }} title="전체 보기">×{number(zoom, Number.isInteger(zoom) ? 0 : 1)}</button>
        <button type="button" onClick={() => changeZoom(zoom * 2)} disabled={zoom >= 8} aria-label="가로 확대">+</button>
      </div>}
    </div>
    <div className="holo-chart__surface" ref={surface}>
      <canvas ref={canvas} className={canEditRange ? 'holo-chart__canvas--select' : ''}
        role="img" aria-label={`${TITLES[kind]}. ${kind === 'phase' ? `주기 ${number(displayPeriod, 5)}일. ${canEditRange ? '드래그하여 가려짐 구간 선택. Enter로 중앙 구간 생성, 방향키로 이동, Shift 방향키로 폭 조절.' : '보기 전용입니다.'} 플러스, 마이너스, 0으로 확대 조절.` : kind === 'period' ? compact ? '그래프의 봉우리를 선택해 주기를 살펴보세요.' : '아래 봉우리 버튼으로도 주기를 선택할 수 있습니다.' : '관측 공백을 압축한 밝기 산점도.'}`}
        tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove}
        onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}
        onPointerLeave={() => setReadout(null)} onKeyDown={keyDown}
        onDoubleClick={() => { if (kind === 'phase') { setZoom(1); setCenter(1); } }} />
      {kind === 'phase' && busy && <div className="holo-chart__status" role="status"><span />{folded?.dataId === dataId ? '현재 곡선 유지 · ' : ''}주기 {number(period, 5)}일로 갱신 중</div>}
      {kind === 'phase' && error && <div className="holo-chart__status holo-chart__status--error" role="alert">{error}<button type="button" onClick={() => setRetry(v => v + 1)}>재시도</button></div>}
      {readout && <div className="holo-chart__readout">{readout}</div>}
    </div>
    {kind === 'period' ? <div className="holo-chart__peaks">
      {data.peaks.map(peak => <button type="button" key={peak.id} onClick={() => onPeakSelect?.(peak)}
        aria-label={`봉우리 ${peak.rank}, 주기 ${number(peak.period_days, 5)}일`}
        className={period >= peak.period_min && period <= peak.period_max ? 'is-selected' : ''}>
        <span>{String(peak.rank).padStart(2, '0')}</span>{number(peak.period_days, 4)}<small>일</small>
      </button>)}
    </div> : kind === 'phase' ? <div className="holo-chart__footer">
      <span>{range ? `${canEditRange ? '' : '보기 전용 · '}선택 위상 ${number(range[0], 4)} → ${number(range[1], 4)}` : canEditRange ? '드래그해서 가려짐 구간을 선택하세요' : '보기 전용 · 곡선 미리보기'}</span>
      {range && canEditRange ? <button type="button" onClick={() => onRangeChange?.(null)}>구간 지우기</button> : <span className="holo-chart__hint">휠: 가로 확대 · 더블클릭: 전체</span>}
    </div> : <div className="holo-chart__footer"><span>각 점은 정제된 실제 관측값입니다</span><span className="holo-chart__hint">금색 띠: 선택 구간 미리보기</span></div>}
  </div>;
}

// Canvas drawing for the new panel. Presentation only: every coordinate comes
// from the classic models (time-curve, periodogram-view, folded-curve), so the
// numbers the member reads and the ones the server receives are the same.
import type { FoldView } from "../../features/analysis/folded-curve";
import type { CandidatePeaks } from "../../features/analysis/periodogram-data";
import {
  periodAtFraction,
  periodFraction,
  periodViewBounds,
  type PeriodPlot,
  type PeriodView,
} from "../../features/analysis/periodogram-view";
import type { TimeCurve } from "../../features/analysis/time-curve";
import type { TransitBand } from "../../features/analysis/transit-bands";
import { phaseTick, periodTick } from "../analysis/format";
import { binsForWidth, foldBins, PERIOD_PLOT, periodPlotY } from "./model";

// Same values as src/cinema/styles/tokens.css (canvas cannot read var()).
export const PALETTE = {
  ink: "#e8eef8",
  dim: "#8d99ad",
  faint: "#566176",
  dot: "rgba(205, 218, 240, 0.42)",
  dotDim: "rgba(205, 218, 240, 0.28)",
  grid: "rgba(150, 180, 225, 0.08)",
  gap: "rgba(150, 180, 225, 0.06)",
  accent: "#ffd369",
  accentLine: "rgba(255, 211, 105, 0.85)",
  accentFill: "rgba(255, 211, 105, 0.12)",
  band: "rgba(255, 211, 105, 0.24)",
  secondary: "#5ec4f7",
  secondaryLine: "rgba(94, 196, 247, 0.85)",
  secondaryFill: "rgba(94, 196, 247, 0.12)",
  matched: "rgba(182, 156, 255, 0.6)",
};
const MONO = '10px "IBM Plex Mono", ui-monospace, Consolas, monospace';

export type CanvasSize = { width: number; height: number; dpr: number };

/** Size the backing store for the device pixel ratio and clear it. */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  size: CanvasSize,
): CanvasRenderingContext2D | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const width = Math.round(size.width * size.dpr);
  const height = Math.round(size.height * size.dpr);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  return ctx;
}

/** Raw time curve strip. Sector gaps are compressed exactly as in time-curve. */
export function drawStrip(
  ctx: CanvasRenderingContext2D,
  curve: TimeCurve,
  width: number,
  height: number,
  bands: readonly TransitBand[],
) {
  const px = (x: number) => (x / curve.width) * width;
  const [min, max] = curve.fluxDomain;
  const top = 3,
    bottom = 3;
  const py = (flux: number) =>
    top + (1 - (flux - min) / (max - min)) * (height - top - bottom);
  ctx.save();
  curve.segments.forEach((segment, index) => {
    if (index > 0) {
      const start = px(curve.segments[index - 1].end);
      ctx.fillStyle = PALETTE.gap;
      ctx.fillRect(start, 0, px(segment.start) - start, height);
    }
    ctx.fillStyle = PALETTE.gap;
    for (const gap of segment.gaps)
      ctx.fillRect(px(gap.start), 0, px(gap.end) - px(gap.start), height);
  });
  ctx.fillStyle = PALETTE.band;
  for (const band of bands)
    ctx.fillRect(
      px(band.xStart),
      0,
      Math.max(1.5, px(band.xEnd) - px(band.xStart)),
      height,
    );
  ctx.fillStyle = PALETTE.dot;
  for (const point of curve.points)
    ctx.fillRect(px(point.x) - 0.5, py(point.flux) - 0.5, 1, 1);
  ctx.restore();
}

const TICKS = [0.5, 1, 2, 3, 5, 10, 20, 40, 80, 160];

/**
 * Periodogram on the server's log grid, drawn as 세기 (0..1, the strongest
 * peak = 1; `plot` and `candidates` carry strengths), with peaks and the
 * periods already matched. Room above the tallest peak is left for its rank
 * label (PERIOD_PLOT, shared with the DOM labels).
 */
export function drawPeriodogram(
  ctx: CanvasRenderingContext2D,
  plot: PeriodPlot,
  candidates: CandidatePeaks,
  view: PeriodView,
  width: number,
  height: number,
) {
  const { grid } = plot;
  const { low, high } = periodViewBounds(view);
  const span = high - low;
  const axis = PERIOD_PLOT.axis;
  const x = (fraction: number) => ((fraction - low) / span) * width;
  const y = (strength: number) => periodPlotY(strength, height);
  ctx.save();
  // Periods beyond half the observing baseline, as in the classic chart.
  const boundary = x(periodFraction(grid, grid.baselineHalfDays));
  if (boundary < width) {
    ctx.fillStyle = PALETTE.gap;
    ctx.fillRect(Math.max(0, boundary), 0, width, height - axis);
  }
  ctx.strokeStyle = PALETTE.matched;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  for (const matched of candidates.matchedCandidates) {
    const at = x(periodFraction(grid, matched.periodDays));
    if (at < 0 || at > width) continue;
    ctx.beginPath();
    ctx.moveTo(at, 0);
    ctx.lineTo(at, height - axis);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const first = Math.max(0, Math.floor(low * (grid.nPeriods - 1)));
  const last = Math.min(
    grid.nPeriods - 1,
    Math.ceil(high * (grid.nPeriods - 1)),
  );
  ctx.beginPath();
  ctx.moveTo(x(first / (grid.nPeriods - 1)), height - axis);
  for (let index = first; index <= last; index++)
    ctx.lineTo(x(index / (grid.nPeriods - 1)), y(grid.power[index]));
  ctx.lineTo(x(last / (grid.nPeriods - 1)), height - axis);
  ctx.closePath();
  ctx.fillStyle = PALETTE.secondaryFill;
  ctx.fill();
  ctx.beginPath();
  for (let index = first; index <= last; index++) {
    const px = x(index / (grid.nPeriods - 1)),
      py = y(grid.power[index]);
    if (index === first) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = PALETTE.secondaryLine;
  ctx.lineWidth = 1;
  ctx.stroke();
  for (const peak of candidates.peaks) {
    const px = x(peak.gridIndex / (grid.nPeriods - 1));
    if (px < 0 || px > width) continue;
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.arc(px, y(peak.power), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = PALETTE.faint;
  ctx.font = MONO;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const lowDays = periodAtFraction(grid, low),
    highDays = periodAtFraction(grid, high);
  const visible = TICKS.filter((tick) => tick >= lowDays && tick <= highDays);
  const ticks = visible.length >= 2 ? visible : [lowDays, highDays];
  for (const tick of ticks) {
    const px = Math.max(
      14,
      Math.min(width - 14, x(periodFraction(grid, tick))),
    );
    ctx.fillText(
      `${periodTick(tick)}${tick === ticks[ticks.length - 1] ? "일" : ""}`,
      px,
      height - 3,
    );
  }
  ctx.restore();
}

/** Folded curve: faint observations and the binned mean in the accent. */
export function drawFold(
  ctx: CanvasRenderingContext2D,
  phases: ArrayLike<number>,
  flux: ArrayLike<number>,
  domain: [number, number],
  view: FoldView,
  width: number,
  height: number,
) {
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  const axis = 14;
  const plotHeight = height - axis;
  const x = (phase: number) => ((phase - low) / (high - low)) * width;
  const y = (value: number) =>
    4 + (1 - (value - domain[0]) / (domain[1] - domain[0])) * (plotHeight - 8);
  ctx.save();
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (plotHeight * i) / 4);
    ctx.lineTo(width, (plotHeight * i) / 4);
    ctx.stroke();
  }
  const size = phases.length > 4000 ? 1.1 : 1.8;
  ctx.fillStyle = phases.length > 4000 ? PALETTE.dotDim : PALETTE.dot;
  for (let i = 0; i < phases.length; i++) {
    const py = y(flux[i]);
    for (let repeat = -1; repeat <= 1; repeat++) {
      const phase = phases[i] + repeat;
      if (phase < low || phase >= high) continue;
      ctx.fillRect(x(phase) - size / 2, py - size / 2, size, size);
    }
  }
  const count = binsForWidth(width);
  const bins = foldBins(phases, flux, low, high, count);
  ctx.beginPath();
  let drawing = false;
  bins.forEach((mean, bin) => {
    if (mean === null) {
      drawing = false;
      return;
    }
    const px = x(low + ((bin + 0.5) / count) * (high - low));
    if (drawing) ctx.lineTo(px, y(mean));
    else ctx.moveTo(px, y(mean));
    drawing = true;
  });
  ctx.strokeStyle = PALETTE.secondaryLine;
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = PALETTE.faint;
  ctx.font = MONO;
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const value = low + ((high - low) * i) / 4;
    ctx.fillText(
      phaseTick(value),
      Math.max(16, Math.min(width - 16, x(value))),
      height - 3,
    );
  }
  ctx.restore();
}

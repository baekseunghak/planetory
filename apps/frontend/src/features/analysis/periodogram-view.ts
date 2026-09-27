import {
  periodAt,
  type CandidatePeaks,
  type Periodogram,
} from "./periodogram-data";

export type PeriodView = { zoom: number; center: number };
export const FULL_PERIOD_VIEW: PeriodView = { zoom: 1, center: 0.5 };
// View magnification only; it does not limit scientific period selection.
export function clampPeriodView(view: PeriodView): PeriodView {
  const zoom = Math.max(
    1,
    Math.min(64, Number.isFinite(view.zoom) ? view.zoom : 1),
  );
  const half = 0.5 / zoom;
  return {
    zoom,
    center: Math.max(
      half,
      Math.min(1 - half, Number.isFinite(view.center) ? view.center : 0.5),
    ),
  };
}
export function periodViewBounds(view: PeriodView) {
  const current = clampPeriodView(view);
  return {
    low: current.center - 0.5 / current.zoom,
    high: current.center + 0.5 / current.zoom,
  };
}
export function zoomPeriodView(
  view: PeriodView,
  factor: number,
  anchor = 0.5,
): PeriodView {
  const current = clampPeriodView(view),
    zoom = clampPeriodView({ ...current, zoom: current.zoom * factor }).zoom;
  return clampPeriodView({
    zoom,
    center: current.center + (anchor - 0.5) * (1 / current.zoom - 1 / zoom),
  });
}
export function periodFraction(grid: Periodogram, periodDays: number): number {
  return (
    (Math.log(periodDays) - Math.log(grid.periodMinDays)) /
    (Math.log(grid.periodMaxDays) - Math.log(grid.periodMinDays))
  );
}
export function periodAtFraction(grid: Periodogram, fraction: number): number {
  if (fraction <= 0) return grid.periodMinDays;
  if (fraction >= 1) return grid.periodMaxDays;
  return Math.exp(
    Math.log(grid.periodMinDays) +
      fraction * (Math.log(grid.periodMaxDays) - Math.log(grid.periodMinDays)),
  );
}
export function buildPeriodPlot(grid: Periodogram) {
  let min = Infinity,
    max = -Infinity;
  const periods = grid.power.map((power, index) => {
    min = Math.min(min, power);
    max = Math.max(max, power);
    return periodAt(grid, index);
  });
  const padding = (max - min || Math.max(1, Math.abs(max)) * 0.02) * 0.08;
  return { grid, periods, yMin: min - padding, yMax: max + padding };
}
export type PeriodPlot = ReturnType<typeof buildPeriodPlot>;
export function indexAtFraction(grid: Periodogram, fraction: number) {
  return Math.max(
    0,
    Math.min(grid.nPeriods - 1, Math.round(fraction * (grid.nPeriods - 1))),
  );
}
/** A peak's rank label on the plot, in CSS pixels (text centre, baseline). */
export type RankLabel = { rank: number; x: number; y: number };

/**
 * Rank labels that do not overlap (시네마 화면만 쓴다). Stronger ranks are
 * placed first at their usual spot; a label that would overlap one already
 * placed moves up one line (away from the curve), and is left out when that
 * collides too. The peak's dot and its button stay either way.
 */
export function placeRankLabels(
  labels: readonly RankLabel[],
  width: number,
  lineHeight = 13,
): RankLabel[] {
  const placed: { label: RankLabel; box: [number, number, number, number] }[] =
    [];
  const boxOf = (label: RankLabel): [number, number, number, number] => {
    const half = (String(label.rank).length * 7 + 4) / 2;
    return [label.x - half, label.y - lineHeight + 2, label.x + half, label.y];
  };
  const hits = (box: [number, number, number, number]) =>
    placed.some(
      ({ box: other }) =>
        box[0] < other[2] &&
        other[0] < box[2] &&
        box[1] < other[3] &&
        other[1] < box[3],
    );
  for (const label of [...labels].sort((a, b) => a.rank - b.rank)) {
    const x = Math.max(8, Math.min(width - 8, label.x));
    for (const shift of [0, -lineHeight]) {
      const candidate = {
        rank: label.rank,
        x,
        y: Math.max(14, label.y + shift),
      };
      const box = boxOf(candidate);
      if (hits(box)) continue;
      placed.push({ label: candidate, box });
      break;
    }
  }
  return placed.map(({ label }) => label);
}

export function drawPeriodogram(
  ctx: CanvasRenderingContext2D,
  model: PeriodPlot,
  candidates: CandidatePeaks,
  view: PeriodView,
  width: number,
  height: number,
  overview = false,
  /** "avoid": leave out or move rank labels that would overlap (cinema). */
  rankLabels: "all" | "avoid" = "all",
) {
  const { low, high } = periodViewBounds(view),
    span = high - low;
  const { grid, yMin, yMax } = model;
  const x = (fraction: number) => ((fraction - low) / span) * width;
  const y = (power: number) =>
    height - 8 - ((power - yMin) / (yMax - yMin)) * (height - 16);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  const boundary = x(periodFraction(grid, grid.baselineHalfDays));
  ctx.fillStyle = "rgba(238,238,238,0.06)";
  ctx.fillRect(
    Math.max(0, boundary),
    0,
    Math.max(0, width - Math.max(0, boundary)),
    height,
  );
  ctx.strokeStyle = "rgba(238,238,238,0.3)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  if (boundary >= 0 && boundary <= width) {
    ctx.beginPath();
    ctx.moveTo(boundary, 0);
    ctx.lineTo(boundary, height);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,211,105,0.5)";
  ctx.setLineDash([2, 5]);
  for (const matched of candidates.matchedCandidates) {
    const position = x(periodFraction(grid, matched.periodDays));
    ctx.beginPath();
    ctx.moveTo(position, 0);
    ctx.lineTo(position, height);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(238,238,238,0.8)";
  ctx.lineWidth = overview ? 1 : 1.5;
  ctx.beginPath();
  const first = Math.max(0, Math.floor(low * (grid.nPeriods - 1))),
    last = Math.min(grid.nPeriods - 1, Math.ceil(high * (grid.nPeriods - 1)));
  for (let index = first; index <= last; index++) {
    const px = x(index / (grid.nPeriods - 1)),
      py = y(grid.power[index]);
    if (index === first) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (!overview && rankLabels === "avoid") {
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    const labels: RankLabel[] = [];
    for (const peak of candidates.peaks) {
      const px = x(peak.gridIndex / (grid.nPeriods - 1));
      if (px < 0 || px > width) continue;
      const py = y(peak.power);
      ctx.fillStyle = "#ffd369";
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      labels.push({ rank: peak.rank, x: px, y: py - 8 });
    }
    ctx.fillStyle = "#eeeeee";
    for (const label of placeRankLabels(labels, width))
      ctx.fillText(String(label.rank), label.x, label.y);
  } else if (!overview) {
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    for (const peak of candidates.peaks) {
      const px = x(peak.gridIndex / (grid.nPeriods - 1));
      if (px < 0 || px > width) continue;
      const py = y(peak.power);
      ctx.fillStyle = "#ffd369";
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#eeeeee";
      ctx.fillText(
        String(peak.rank),
        Math.max(8, Math.min(width - 8, px)),
        Math.max(14, py - 8),
      );
    }
  }
  ctx.restore();
}

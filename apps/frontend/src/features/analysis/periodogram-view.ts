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
/** A peak's dot on the plot, in CSS pixels (its centre). */
export type RankPeak = { rank: number; x: number; y: number };
/** A peak's rank label on the plot, in CSS pixels (text centre, baseline). */
export type RankLabel = { rank: number; x: number; y: number };
type Box = [left: number, top: number, right: number, bottom: number];

/** Rank label metrics for the 12px canvas font (digits ≈ 7px wide). */
export const RANK_LABEL = {
  digit: 7,
  padding: 2,
  ascent: 10,
  descent: 2,
  /** Peak dot radius, and the gap between a dot and its label. */
  dot: 3,
  gap: 2,
  line: 13,
} as const;

/** The box a rank label takes (text centre `x`, baseline `y`). */
export function rankLabelBox(label: RankLabel): Box {
  const half =
    (String(label.rank).length * RANK_LABEL.digit + RANK_LABEL.padding) / 2;
  return [
    label.x - half,
    label.y - RANK_LABEL.ascent,
    label.x + half,
    label.y + RANK_LABEL.descent,
  ];
}

const overlaps = (a: Box, b: Box) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * Rank labels that stay inside the plot and do not overlap (시네마 화면만
 * 쓴다). Stronger ranks are placed first. Each label tries, in order: above its
 * dot; beside it (right, then left, level with the dot) — where a peak near the
 * top goes, instead of being pushed onto its own dot and spike; one line
 * higher. A spot must lie wholly inside `width` × `height`, must not overlap a
 * label already placed, and should not cover a peak dot or the selected
 * period's line (`avoidX`); when only those soft rules fail it is used anyway.
 * A label with no spot left is left out; the peak's dot and button stay.
 * The strongest rank always finds a spot.
 */
export function placeRankLabels(
  peaks: readonly RankPeak[],
  plot: { width: number; height: number; avoidX?: number | null },
): RankLabel[] {
  const { width, height, avoidX = null } = plot;
  const { dot, gap, ascent, descent, line } = RANK_LABEL;
  const dots: Box[] = peaks.map(({ x, y }) => [
    x - dot,
    y - dot,
    x + dot,
    y + dot,
  ]);
  const avoid: Box | null =
    avoidX === null || !Number.isFinite(avoidX)
      ? null
      : [avoidX - 1.5, 0, avoidX + 1.5, height];
  const placed: { label: RankLabel; box: Box }[] = [];
  const inside = (box: Box) =>
    box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height;
  const free = (box: Box) =>
    !placed.some(({ box: other }) => overlaps(box, other));
  const clear = (box: Box) =>
    !dots.some((other) => overlaps(box, other)) &&
    !(avoid && overlaps(box, avoid));
  for (const peak of [...peaks].sort((a, b) => a.rank - b.rank)) {
    const half =
      (String(peak.rank).length * RANK_LABEL.digit + RANK_LABEL.padding) / 2;
    const centred = Math.max(half, Math.min(width - half, peak.x));
    // Level with the dot: the glyph's middle on the dot's centre, kept inside.
    const level = Math.max(
      ascent,
      Math.min(height - descent, peak.y + (ascent - descent) / 2),
    );
    const above = peak.y - dot - gap - descent;
    const spots: RankLabel[] = [
      { rank: peak.rank, x: centred, y: above },
      { rank: peak.rank, x: peak.x + dot + gap + half, y: level },
      { rank: peak.rank, x: peak.x - dot - gap - half, y: level },
      { rank: peak.rank, x: centred, y: above - line },
    ];
    const usable = spots
      .map((label) => ({ label, box: rankLabelBox(label) }))
      .filter(({ box }) => inside(box) && free(box));
    const spot = usable.find(({ box }) => clear(box)) ?? usable[0];
    if (spot) placed.push(spot);
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
  /** "avoid": keep rank labels inside the plot, apart (cinema). */
  rankLabels: "all" | "avoid" = "all",
  /** With "avoid": the selected period, whose line labels keep clear of. */
  selectedPeriodDays: number | null = null,
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
    const dots: RankPeak[] = [];
    for (const peak of candidates.peaks) {
      const px = x(peak.gridIndex / (grid.nPeriods - 1));
      if (px < 0 || px > width) continue;
      const py = y(peak.power);
      ctx.fillStyle = "#ffd369";
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      dots.push({ rank: peak.rank, x: px, y: py });
    }
    ctx.fillStyle = "#eeeeee";
    const avoidX =
      selectedPeriodDays !== null && Number.isFinite(selectedPeriodDays)
        ? x(periodFraction(grid, selectedPeriodDays))
        : null;
    for (const label of placeRankLabels(dots, { width, height, avoidX }))
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

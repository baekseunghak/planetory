import type { CurveSegment } from "./analysis-data";

export type TimePoint = {
  x: number;
  btjd: number;
  flux: number;
  index: number;
  sector: number;
  segmentId: string;
};
export type TimeSegment = {
  source: CurveSegment;
  start: number;
  end: number;
  cadence: number;
  runs: TimePoint[][];
  gaps: { start: number; end: number }[];
};
export type TimeCurve = {
  segments: TimeSegment[];
  points: TimePoint[];
  width: number;
  fluxDomain: [number, number];
};
export type TimeView = { zoom: number; center: number };

// Display time is compressed between segments only. Scientific time is never rewritten.
export function buildTimeCurve(segments: readonly CurveSegment[]): TimeCurve {
  const ordered = [...segments].sort(
    (a, b) => a.startBtjd - b.startBtjd || a.sector - b.sector,
  );
  const total = ordered.reduce(
    (sum, s) => sum + (s.nPoints * s.binMinutes) / 1440,
    0,
  );
  const separator = (total * 0.08) / Math.max(1, ordered.length - 1);
  let cursor = 0,
    min = Infinity,
    max = -Infinity;
  const points: TimePoint[] = [];
  const display = ordered.map((source): TimeSegment => {
    const cadence = source.binMinutes / 1440;
    const start = cursor,
      end = start + source.nPoints * cadence;
    const runs: TimePoint[][] = [],
      gaps: { start: number; end: number }[] = [];
    let run: TimePoint[] | null = null,
      gap: { start: number; end: number } | null = null;
    for (let index = 0; index < source.nPoints; index++) {
      const flux = source.flux[index];
      if (flux === null) {
        run = null;
        if (!gap) {
          gap = {
            start: start + index * cadence,
            end: start + (index + 1) * cadence,
          };
          gaps.push(gap);
        } else gap.end = start + (index + 1) * cadence;
        continue;
      }
      gap = null;
      const point = {
        x: start + (index + 0.5) * cadence,
        btjd: source.startBtjd + (index + 0.5) * cadence,
        flux,
        index,
        sector: source.sector,
        segmentId: source.segmentId,
      };
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(point);
      points.push(point);
      min = Math.min(min, flux);
      max = Math.max(max, flux);
    }
    cursor = end + separator;
    return { source, start, end, cadence, runs, gaps };
  });
  const margin =
    (max > min ? max - min : Math.max(Math.abs(min) * 0.001, 0.001)) * 0.12;
  return {
    segments: display,
    points,
    width: display.at(-1)?.end ?? 1,
    fluxDomain: points.length ? [min - margin, max + margin] : [0, 1],
  };
}
export function clampTimeView(view: TimeView, width: number): TimeView {
  const zoom = Math.max(1, Math.min(64, view.zoom));
  const half = width / zoom / 2;
  return { zoom, center: Math.max(half, Math.min(width - half, view.center)) };
}
export function zoomTimeView(
  view: TimeView,
  width: number,
  factor: number,
  ratio = 0.5,
): TimeView {
  const next = clampTimeView({ ...view, zoom: view.zoom * factor }, width);
  const anchor = view.center + ((ratio - 0.5) * width) / view.zoom;
  return clampTimeView(
    { zoom: next.zoom, center: anchor + ((0.5 - ratio) * width) / next.zoom },
    width,
  );
}
export function pointAtDisplay(curve: TimeCurve, x: number): TimePoint | null {
  const segment = curve.segments.find((s) => x >= s.start && x < s.end);
  if (!segment) return null;
  const index = Math.min(
    segment.source.nPoints - 1,
    Math.floor((x - segment.start) / segment.cadence),
  );
  const flux = segment.source.flux[index];
  if (flux === null) return null;
  return {
    x: segment.start + (index + 0.5) * segment.cadence,
    btjd: segment.source.startBtjd + (index + 0.5) * segment.cadence,
    flux,
    index,
    sector: segment.source.sector,
    segmentId: segment.source.segmentId,
  };
}

// Separate paths for each contiguous run: neither null bins nor Sector boundaries are connected.
export function drawTimeCurve(
  ctx: CanvasRenderingContext2D,
  curve: TimeCurve,
  view: TimeView,
  width: number,
  height: number,
) {
  const span = curve.width / view.zoom,
    low = view.center - span / 2;
  const px = (x: number) => ((x - low) / span) * width;
  const [min, max] = curve.fluxDomain;
  const py = (y: number) => height - ((y - min) / (max - min)) * height;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.strokeStyle = "rgba(238,238,238,0.42)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (height * i) / 4);
    ctx.lineTo(width, (height * i) / 4);
    ctx.stroke();
  }
  curve.segments.forEach((segment, i) => {
    if (i > 0) {
      const start = px(curve.segments[i - 1].end),
        end = px(segment.start);
      ctx.fillStyle = "rgba(238,238,238,0.05)";
      ctx.fillRect(start, 0, end - start, height);
    }
    ctx.fillStyle = "rgba(238,238,238,0.1)";
    for (const gap of segment.gaps)
      ctx.fillRect(px(gap.start), 0, px(gap.end) - px(gap.start), height);
    ctx.strokeStyle = "rgba(238,238,238,0.8)";
    ctx.fillStyle = "rgba(238,238,238,0.8)";
    ctx.lineWidth = 1.25;
    for (const run of segment.runs) {
      ctx.beginPath();
      run.forEach((point, index) => {
        if (index === 0) ctx.moveTo(px(point.x), py(point.flux));
        else ctx.lineTo(px(point.x), py(point.flux));
      });
      ctx.stroke();
      for (const point of run)
        if (point.x >= low && point.x <= low + span) {
          ctx.beginPath();
          ctx.arc(
            px(point.x),
            py(point.flux),
            curve.points.length > 2000 ? 1.2 : 3,
            0,
            2 * Math.PI,
          );
          ctx.fill();
        }
    }
  });
  ctx.restore();
}

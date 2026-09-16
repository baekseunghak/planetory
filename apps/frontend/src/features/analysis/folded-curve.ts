import type { FoldPoint } from "./fold-data";

export type FoldView = { zoom: number; center: number };
export const fullFoldView: FoldView = { zoom: 1, center: 0.5 };
export function clampFoldView(view: FoldView): FoldView {
  const zoom = Math.max(1, Math.min(8, view.zoom));
  const half = 1 / zoom;
  return {
    zoom,
    center: Math.max(-0.5 + half, Math.min(1.5 - half, view.center)),
  };
}
export function zoomFoldView(
  view: FoldView,
  factor: number,
  ratio = 0.5,
): FoldView {
  const next = clampFoldView({ ...view, zoom: view.zoom * factor });
  const anchor = view.center + ((ratio - 0.5) * 2) / view.zoom;
  return clampFoldView({
    zoom: next.zoom,
    center: anchor + ((0.5 - ratio) * 2) / next.zoom,
  });
}
export function foldFluxDomain(points: readonly FoldPoint[]): [number, number] {
  let min = Infinity,
    max = -Infinity;
  for (const point of points) {
    min = Math.min(min, point.flux);
    max = Math.max(max, point.flux);
  }
  if (!points.length) return [0, 1];
  const margin =
    (max > min ? max - min : Math.max(Math.abs(min) * 0.001, 0.001)) * 0.12;
  return [min - margin, max + margin];
}

/** Repeat observations on the two-cycle display only; never duplicate scientific inputs. */
export function drawFoldedCurve(
  ctx: CanvasRenderingContext2D,
  points: readonly FoldPoint[],
  phases: Float64Array,
  domain: [number, number],
  view: FoldView,
  width: number,
  height: number,
) {
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.strokeStyle = "#ffffff18";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (height * i) / 4);
    ctx.lineTo(width, (height * i) / 4);
    ctx.stroke();
  }
  ctx.fillStyle = "#a6e8ce";
  for (let i = 0; i < points.length; i++) {
    const y =
      height -
      ((points[i].flux - domain[0]) / (domain[1] - domain[0])) * height;
    for (let repeat = -1; repeat <= 1; repeat++) {
      const phase = phases[i] + repeat;
      if (phase < low || phase >= high) continue;
      ctx.beginPath();
      ctx.arc(
        ((phase - low) / (high - low)) * width,
        y,
        points.length > 2000 ? 1.2 : 3,
        0,
        2 * Math.PI,
      );
      ctx.fill();
    }
  }
  ctx.restore();
}

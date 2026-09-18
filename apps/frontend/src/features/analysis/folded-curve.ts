import type { FoldPoint } from "./fold-data";

export type FoldView = { zoom: number; center: number };
export const MAX_FOLD_ZOOM = 32;
export const fullFoldView: FoldView = { zoom: 1, center: 0.5 };
export function clampFoldView(view: FoldView): FoldView {
  const zoom = Math.max(1, Math.min(MAX_FOLD_ZOOM, view.zoom));
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
  raster?: {
    surface: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    image: ImageData;
    dpr: number;
  },
) {
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
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
  // This switches rendering methods, never caps or samples observations.
  let visibleDots = 0;
  if (raster) {
    for (const phase of phases) {
      for (let repeat = -1; repeat <= 1; repeat++) {
        if (phase + repeat >= low && phase + repeat < high) visibleDots++;
      }
      if (visibleDots > 50_000) break;
    }
  }
  if (raster && visibleDots > 50_000) {
    rasterFoldPoints(points, phases, domain, view, raster.image, raster.dpr);
    raster.ctx.putImageData(raster.image, 0, 0);
    ctx.drawImage(raster.surface, 0, 0, width, height);
    ctx.restore();
    return;
  }
  ctx.fillStyle = "rgba(238,238,238,0.8)";
  const radius = points.length > 2000 ? 1.2 : 3;
  for (let i = 0; i < points.length; i++) {
    const y =
      height -
      ((points[i].flux - domain[0]) / (domain[1] - domain[0])) * height;
    for (let repeat = -1; repeat <= 1; repeat++) {
      const phase = phases[i] + repeat;
      if (phase < low || phase >= high) continue;
      const x = ((phase - low) / (high - low)) * width;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** All visible observations contribute a circle; no sampling, binning or data rewrite. */
export function rasterFoldPoints(
  points: readonly FoldPoint[],
  phases: Float64Array,
  domain: [number, number],
  view: FoldView,
  image: Pick<ImageData, "width" | "height" | "data">,
  dpr: number,
) {
  const { width, height, data } = image;
  data.fill(0);
  const low = view.center - 1 / view.zoom,
    high = view.center + 1 / view.zoom;
  const radius = 1.2 * dpr,
    reach = radius + 0.5;
  for (let i = 0; i < points.length; i++) {
    const cy =
      height -
      ((points[i].flux - domain[0]) / (domain[1] - domain[0])) * height;
    const y0 = Math.max(0, Math.floor(cy - reach)),
      y1 = Math.min(height - 1, Math.ceil(cy + reach));
    for (let repeat = -1; repeat <= 1; repeat++) {
      const phase = phases[i] + repeat;
      if (phase < low || phase >= high) continue;
      const cx = ((phase - low) / (high - low)) * width;
      const x0 = Math.max(0, Math.floor(cx - reach)),
        x1 = Math.min(width - 1, Math.ceil(cx + reach));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const offset = (y * width + x) * 4;
          if (data[offset + 3] === 255) continue;
          const dx = x + 0.5 - cx,
            dy = y + 0.5 - cy;
          const coverage = Math.min(
            1,
            Math.max(0, reach - Math.sqrt(dx * dx + dy * dy)),
          );
          if (!coverage) continue;
          data[offset] = 238;
          data[offset + 1] = 238;
          data[offset + 2] = 238;
          data[offset + 3] += (255 - data[offset + 3]) * coverage;
        }
    }
  }
}

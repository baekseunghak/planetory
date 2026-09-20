import {
  periodCurveFixture,
  FOLD_SAMPLE,
} from "../../../dev/periodogram-fixtures";
import { FoldClient } from "../../../src/features/analysis/fold-client";
import {
  drawFoldedCurve,
  foldFluxDomain,
  type FoldView,
} from "../../../src/features/analysis/folded-curve";
import type { FoldPoint } from "../../../src/features/analysis/fold-data";
import { GpuFoldRenderer } from "./webgl-renderer";

const width = 1024,
  height = 280;
const frame = () => new Promise<number>(requestAnimationFrame);
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    p50: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      null,
    max: sorted.at(-1) ?? null,
  };
};
function surface(dpr: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  document.querySelector("#surface")!.replaceChildren(canvas);
  return canvas;
}
function canvasRenderer(
  canvas: HTMLCanvasElement,
  points: FoldPoint[],
  domain: [number, number],
  dpr: number,
) {
  const ctx = canvas.getContext("2d")!;
  const scratch = document.createElement("canvas");
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const rasterContext = scratch.getContext("2d")!;
  const raster = {
    surface: scratch,
    ctx: rasterContext,
    image: rasterContext.createImageData(scratch.width, scratch.height),
    dpr,
  };
  return (phases: Float64Array, view: FoldView) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFoldedCurve(ctx, points, phases, domain, view, width, height, raster);
  };
}
async function run(
  mode: "canvas" | "webgl",
  size: number,
  scenario: "refold-full" | "refold-zoom" | "pan" | "zoom",
) {
  const source = periodCurveFixture().segments[0];
  const times = Float64Array.from(
    { length: size },
    (_, i) => FOLD_SAMPLE.startBtjd + (i * 120) / (size - 1),
  );
  const points = Array.from(times, (btjd, i) => ({
    btjd,
    index: i,
    flux: source.flux[i % source.nPoints]!,
    sector: 14,
    segmentId: "synthetic",
  }));
  const domain = foldFluxDomain(points);
  const canvas = surface(1);
  const worker = new FoldClient(
    { dataId: "gpu-benchmark", times, reference: FOLD_SAMPLE.referenceBtjd },
    { timeoutMs: 30000 },
  );
  let gpu: GpuFoldRenderer | null = null;
  const beforeSetup = performance.now();
  const cpuDraw =
    mode === "canvas" ? canvasRenderer(canvas, points, domain, 1) : null;
  if (mode === "webgl")
    gpu = new GpuFoldRenderer(
      canvas,
      Float32Array.from(
        points,
        (p) => (p.flux - domain[0]) / (domain[1] - domain[0]),
      ),
      1,
    );
  const setupMs = performance.now() - beforeSetup;
  try {
    let result = (await worker.request(FOLD_SAMPLE.periodDays))!;
    const draw = (view: FoldView, timed = false) =>
      gpu
        ? gpu.draw(result.phases, view, timed)
        : cpuDraw!(result.phases, view);
    const baseView = { zoom: scenario === "refold-full" ? 1 : 32, center: 0.5 };
    for (let i = 0; i < 4; i++) {
      draw(baseView);
      await frame();
    }
    const cpuMs: number[] = [],
      workerRoundTripMs: number[] = [],
      nextFrameMs: number[] = [],
      timerGaps: number[] = [],
      longTasks: number[] = [];
    let lastTick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      timerGaps.push(now - lastTick);
      lastTick = now;
    }, 16);
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((e) => e.duration)),
    );
    observer.observe({ type: "longtask", buffered: false });
    const started = performance.now();
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      if (scenario.startsWith("refold")) {
        result = (await worker.request(
          FOLD_SAMPLE.periodDays + (i % 2) * 0.001,
        ))!;
        if (!result || !worker.isCurrent(result))
          throw new Error("Unexpected stale result");
        workerRoundTripMs.push(performance.now() - start);
      }
      const view =
        scenario === "pan"
          ? { zoom: 32, center: 0.45 + (i % 8) * 0.0125 }
          : scenario === "zoom"
            ? { zoom: 2 ** (i % 6), center: 0.5 }
            : baseView;
      const submit = performance.now();
      draw(view, true);
      cpuMs.push(performance.now() - submit);
      // Two animation frame callbacks let at least one presentation opportunity pass.
      await frame();
      await frame();
      nextFrameMs.push(performance.now() - start);
    }
    const elapsedMs = performance.now() - started;
    clearInterval(timer);
    observer.disconnect();
    const gpuTimes = gpu ? await gpu.timings() : null;
    const precisionMaxPx = Math.max(
      ...[1, 32].map((zoom) => {
        let max = 0;
        for (const phase of result.phases)
          max = Math.max(
            max,
            (Math.abs(Math.fround(phase) - phase) * zoom * width) / 2,
          );
        return max;
      }),
    );
    const report = {
      mode,
      size,
      scenario,
      frames: 40,
      width,
      height,
      dpr: 1,
      setupMs,
      elapsedMs,
      cpuSubmitMs: stats(cpuMs),
      workerRoundTripMs: stats(workerRoundTripMs),
      nextFrameMs: stats(nextFrameMs),
      timerGapMs: stats(timerGaps),
      longTasksMs: stats(longTasks),
      gpuDrawMs: gpuTimes ? stats(gpuTimes) : null,
      gpu: gpu?.info ?? null,
      precisionMaxPx,
      gpuBufferBytes: mode === "webgl" ? size * 8 : 0,
    };
    document.querySelector("#status")!.textContent = JSON.stringify(
      report,
      null,
      2,
    );
    // Copy the presented frame before disposing GPU resources; excluded from timings.
    const picture = document.createElement("canvas");
    picture.width = canvas.width;
    picture.height = canvas.height;
    draw(baseView);
    picture.getContext("2d")!.drawImage(canvas, 0, 0);
    document.querySelector("#surface")!.replaceChildren(picture);
    return report;
  } finally {
    worker.dispose();
    gpu?.dispose();
  }
}
async function validate(dpr: number) {
  const canvas = surface(dpr),
    phases = new Float64Array([0, 0.249, 0.5, 0.99999]);
  const normalized = new Float32Array([0.15, 0.35, 0.65, 0.85]);
  const gpu = new GpuFoldRenderer(canvas, normalized, dpr);
  try {
    let checked = 0;
    for (const view of [
      { zoom: 1, center: 0.5 },
      { zoom: 32, center: 0 },
      { zoom: 32, center: 1 },
    ]) {
      gpu.draw(phases, view);
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gpu.gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gpu.gl.RGBA,
        gpu.gl.UNSIGNED_BYTE,
        pixels,
      );
      for (let i = 0; i < phases.length; i++)
        for (let repeat = -1; repeat <= 1; repeat++) {
          const phase = phases[i] + repeat,
            low = view.center - 1 / view.zoom,
            high = view.center + 1 / view.zoom;
          if (phase < low || phase >= high) continue;
          const x = Math.min(
            canvas.width - 1,
            Math.floor(((phase - low) / (high - low)) * canvas.width),
          );
          const y = Math.floor(normalized[i] * canvas.height),
            offset = (y * canvas.width + x) * 4;
          if (
            pixels[offset + 1] - pixels[offset] < 15 ||
            pixels[offset + 3] === 0
          )
            throw new Error(`Missing GPU point ${i}/${repeat} at ${x},${y}`);
          checked++;
        }
      if (gpu.gl.getError() !== gpu.gl.NO_ERROR) throw new Error("WebGL error");
    }
    const ext = gpu.gl.getExtension("WEBGL_lose_context");
    let lossDetected = false;
    if (ext) {
      const lost = new Promise<void>((resolve) =>
        canvas.addEventListener(
          "webglcontextlost",
          (event) => {
            event.preventDefault();
            resolve();
          },
          { once: true },
        ),
      );
      ext.loseContext();
      await lost;
      try {
        gpu.draw(phases, { zoom: 1, center: 0.5 });
      } catch {
        lossDetected = true;
      }
    }
    // Explicit fallback prototype: use a NEW canvas after GPU context loss.
    const fallback = surface(dpr),
      points = Array.from(normalized, (flux, index) => ({
        btjd: index,
        flux,
        index,
        sector: 1,
        segmentId: "test",
      }));
    canvasRenderer(
      fallback,
      points,
      [0, 1],
      dpr,
    )(phases, { zoom: 1, center: 0.5 });
    const pixel = fallback
      .getContext("2d")!
      .getImageData(
        Math.floor(fallback.width * 0.25),
        Math.floor(fallback.height * 0.85),
        1,
        1,
      ).data;
    if (pixel[1] - pixel[0] < 15) throw new Error("Fallback point missing");
    return { dpr, checked, lossDetected, fallback: true, gpu: gpu.info };
  } finally {
    gpu.dispose();
  }
}
Object.assign(window, { gpuExperiment: { run, validate } });
document.querySelector("#status")!.textContent = "측정 준비 완료";
export type GpuExperiment = { run: typeof run; validate: typeof validate };
declare global {
  interface Window {
    gpuExperiment: GpuExperiment;
  }
}

// Only the separate benchmark entry imports these probes. The product entry never does.
import { SkyDataStore } from "../src/features/sky-data/store";
import { GalaxyRenderer } from "../src/features/sky-renderer/renderer";
import { HitGrid } from "../src/features/sky-renderer/interaction";
import { ProjectedStarIndex } from "../src/features/sky-renderer/star-index";
let store: SkyDataStore | undefined, renderer: GalaxyRenderer | undefined;
let firstStar: number | null = null,
  fullLoad: number | null = null;
let active = false,
  last = 0,
  frames: number[] = [],
  pendingFrames = 0;
let cpu: { name: string; ms: number; count?: number }[] = [];
let invalid: string[] = [];
let gpuActive = false;
let gpuQuery: WebGLQuery | null = null;
let gpuTimes: number[] = [];
let gpuDisjoint = false;
let camera: {
  matrix: number[];
  width: number;
  height: number;
  zoom: number;
} | null = null;
const setCamera = GalaxyRenderer.prototype.setCamera;
GalaxyRenderer.prototype.setCamera = function (...args) {
  camera = {
    matrix: [...args[0]],
    width: args[1],
    height: args[2],
    zoom: args[3] ?? 1,
  };
  return setCamera.apply(this, args);
};
const view = SkyDataStore.prototype.setView;
SkyDataStore.prototype.setView = function (...args) {
  store = this;
  return view.apply(this, args);
};
const draw = GalaxyRenderer.prototype.draw;
GalaxyRenderer.prototype.draw = function (...args) {
  renderer = this;
  const gl = gpuActive
    ? document.querySelector("canvas")?.getContext("webgl2")
    : null;
  const ext = gl?.getExtension("EXT_disjoint_timer_query_webgl2");
  if (
    gl &&
    ext &&
    gpuQuery &&
    gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT_AVAILABLE)
  ) {
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuDisjoint = true;
    else gpuTimes.push(gl.getQueryParameter(gpuQuery, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(gpuQuery);
    gpuQuery = null;
  }
  const beginGpu = !!(gl && ext && !gpuQuery);
  if (beginGpu) {
    gpuQuery = gl!.createQuery();
    gl!.beginQuery(ext.TIME_ELAPSED_EXT, gpuQuery);
  }
  const started = performance.now();
  draw.apply(this, args);
  if (beginGpu) gl!.endQuery(ext.TIME_ELAPSED_EXT);
  if (active)
    cpu.push({ name: "draw-submit", ms: performance.now() - started });
  if (firstStar === null && this.metrics().stars > 0)
    requestAnimationFrame(() => {
      firstStar ??= performance.now();
    });
};
const scene = GalaxyRenderer.prototype.setScene;
GalaxyRenderer.prototype.setScene = function (...args) {
  const started = performance.now();
  const value = scene.apply(this, args);
  if (active)
    cpu.push({
      name: "pack-scene",
      ms: performance.now() - started,
      count: args[0].stars.length,
    });
  return value;
};
const hit = HitGrid.prototype.hit;
HitGrid.prototype.hit = function (...args) {
  const started = performance.now(),
    result = hit.apply(this, args);
  if (active)
    cpu.push({
      name: "hit",
      ms: performance.now() - started,
      count: this.examined,
    });
  return result;
};
const starHit = ProjectedStarIndex.prototype.hit;
ProjectedStarIndex.prototype.hit = function (...args) {
  const started = performance.now(),
    result = starHit.apply(this, args);
  if (active)
    cpu.push({
      name: "hit",
      ms: performance.now() - started,
      count: this.examined,
    });
  return result;
};
function tick(now: number) {
  const data = store?.getSnapshot();
  if (
    data?.meta &&
    data.loadedCount === data.meta.starCount &&
    !data.pending &&
    !data.loadingMeta
  )
    fullLoad ??= now;
  if (active) {
    if (last) frames.push(now - last);
    if (data?.pending || data?.loadingMeta) pendingFrames++;
  }
  last = now;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
document.addEventListener("visibilitychange", () => {
  if (active && document.hidden) invalid.push("hidden document");
});
const info = () => {
  const data = store?.getSnapshot(),
    canvas = document.querySelector("canvas"),
    gl = canvas?.getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    firstStarFromNavigationMs: firstStar,
    fullLoadFromNavigationMs: fullLoad,
    account: data?.meta?.starCount,
    loaded: data?.loadedCount,
    pending: data?.pending,
    failures: data?.failures.map((f) => f.error.message),
    error: data?.error?.message,
    pages: data?.pageProgress,
    metrics: renderer?.metrics(),
    selected: data?.selectedTicId,
    camera,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    dpr: devicePixelRatio,
    gpu:
      gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable",
    dom: document.querySelectorAll("*").length,
    resources: performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/sky/tiles?"))
      .map((e) => {
        const r = e as PerformanceResourceTiming;
        return {
          url: r.name,
          ms: r.duration,
          bytes: r.encodedBodySize,
          transfer: r.transferSize,
        };
      }),
  };
};
const benchmark = {
  info,
  beginGpu() {
    gpuTimes = [];
    gpuDisjoint = false;
    gpuActive = true;
  },
  endGpu() {
    gpuActive = false;
    const gl = document.querySelector("canvas")?.getContext("webgl2");
    if (gpuQuery && gl) gl.deleteQuery(gpuQuery);
    gpuQuery = null;
    return {
      supported: !!gl?.getExtension("EXT_disjoint_timer_query_webgl2"),
      disjoint: gpuDisjoint,
      ms: gpuTimes,
    };
  },
  begin() {
    frames = [];
    cpu = [];
    pendingFrames = 0;
    invalid = [];
    active = true;
    last = 0;
  },
  end() {
    active = false;
    return { frames, cpu, pendingFrames, invalid, after: info() };
  },
  settled() {
    const d = store?.getSnapshot();
    return (
      !!d?.meta &&
      !d.pending &&
      !d.loadingMeta &&
      !d.error &&
      !d.failures.length &&
      !!renderer?.metrics().stars
    );
  },
};
Object.assign(window, { __planetoryBenchmark: benchmark });
await import("../src/main");

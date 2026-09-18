// Test-only instrumentation. No timer, hook or metric is included in the application.
export function installFoldMetrics(options?: { reactCommits?: boolean }) {
  const metrics = {
    active: false,
    commits: 0,
    gpuDraws: 0,
    inputs: 0,
    workerMs: [] as number[],
    draws: [] as number[],
    inputToDrawMs: [] as number[],
    timerGaps: [] as number[],
    longTasks: [] as number[],
    positions: [] as number[],
    statusChanges: 0,
    reset() {
      lastInput = 0;
      previousPeriod =
        document
          .querySelector('[data-testid="fold-result"]')
          ?.getAttribute("data-period") ?? null;
      previousStatus =
        document.querySelector('[data-testid="fold-status"]')?.textContent ??
        "";
      previousTimer = performance.now();
      this.commits = this.inputs = this.statusChanges = 0;
      this.gpuDraws = 0;
      this.workerMs = [];
      this.draws = [];
      this.inputToDrawMs = [];
      this.timerGaps = [];
      this.longTasks = [];
      this.positions = [];
      this.active = true;
    },
  };
  Object.assign(window, { foldMetrics: metrics });
  // DevTools hook counts root commits, not component render calls. The renderer
  // map also supports Vite's React Refresh preamble in development comparisons.
  const renderers = new Map<number, unknown>();
  if (options?.reactCommits !== false)
    Object.assign(window, {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers,
        inject: (renderer: unknown) => {
          renderers.set(1, renderer);
          return 1;
        },
        onCommitFiberUnmount() {},
        onCommitFiberRoot() {
          if (metrics.active) metrics.commits++;
        },
      },
    });
  if (typeof WebGL2RenderingContext !== "undefined") {
    const draw = WebGL2RenderingContext.prototype.drawArraysInstanced;
    WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args) {
      if (
        metrics.active &&
        (this.canvas as HTMLCanvasElement).dataset?.renderer === "webgl"
      )
        metrics.gpuDraws++;
      return draw.apply(this, args);
    };
  }
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", ({ data }) => {
        if (metrics.active && data.type === "test-fold-duration")
          metrics.workerMs.push(data.ms);
      });
    }
  };
  const starts = new WeakMap<CanvasRenderingContext2D, number>();
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  const restore = CanvasRenderingContext2D.prototype.restore;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) {
    if (
      metrics.active &&
      this.canvas.parentElement?.classList.contains("fold-plot")
    )
      starts.set(this, performance.now());
    return clear.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.restore = function () {
    const result = restore.call(this);
    const start = starts.get(this);
    if (start !== undefined) {
      metrics.draws.push(performance.now() - start);
      starts.delete(this);
    }
    return result;
  };
  let lastInput = 0,
    previousPeriod: string | null = null,
    previousStatus = "";
  document.addEventListener(
    "click",
    (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.textContent?.includes("한 간격")
      )
        return;
      if (metrics.active) {
        lastInput = performance.now();
        metrics.inputs++;
      }
    },
    true,
  );
  new MutationObserver(() => {
    if (!metrics.active) return;
    const status =
      document.querySelector('[data-testid="fold-status"]')?.textContent ?? "";
    const panel = document.querySelector('[data-testid="fold-panel"]');
    const plot = document.querySelector(".fold-plot");
    if (status !== previousStatus) {
      metrics.statusChanges++;
      previousStatus = status;
      if (panel && plot)
        metrics.positions.push(
          plot.getBoundingClientRect().top - panel.getBoundingClientRect().top,
        );
    }
    const period =
      document
        .querySelector('[data-testid="fold-result"]')
        ?.getAttribute("data-period") ?? null;
    if (period !== previousPeriod) {
      previousPeriod = period;
      if (lastInput) metrics.inputToDrawMs.push(performance.now() - lastInput);
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-period", "data-fold-ready"],
  });
  let previousTimer = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (metrics.active) metrics.timerGaps.push(now - previousTimer);
    previousTimer = now;
  }, 16);
  new PerformanceObserver((list) => {
    if (metrics.active)
      for (const entry of list.getEntries())
        metrics.longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: false });
}

export type FoldMetrics = {
  active: boolean;
  reset(): void;
  commits: number;
  gpuDraws: number;
  inputs: number;
  workerMs: number[];
  draws: number[];
  inputToDrawMs: number[];
  timerGaps: number[];
  longTasks: number[];
  positions: number[];
  statusChanges: number;
};
declare global {
  interface Window {
    foldMetrics: FoldMetrics;
  }
}

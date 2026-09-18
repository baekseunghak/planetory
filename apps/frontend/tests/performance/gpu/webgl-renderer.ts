import type { FoldView } from "../../../src/features/analysis/folded-curve";
import { FoldWebglRenderer } from "../../../dev/fold-webgl-renderer";
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
// Instrumentation stays in the test harness; app integration uses the shared renderer.
export class GpuFoldRenderer extends FoldWebglRenderer {
  readonly info: {
    renderer: string;
    vendor: string;
    timerAvailable: boolean;
    software: boolean;
  };
  private timer: TimerExtension | null;
  private queries: WebGLQuery[] = [];
  constructor(
    canvas: HTMLCanvasElement,
    normalizedFlux: Float32Array,
    dpr: number,
  ) {
    super(canvas, normalizedFlux, dpr);
    const gl = this.gl;
    this.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
    );
    this.info = {
      renderer,
      vendor: String(
        gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
      ),
      timerAvailable: Boolean(this.timer),
      software: /swiftshader|llvmpipe|software|basic render/i.test(renderer),
    };
  }
  override draw(phases: Float64Array, view: FoldView, timed = false) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("WebGL context lost");
    this.upload(phases);
    const query = timed && this.timer ? gl.createQuery() : null;
    if (query) {
      gl.beginQuery(this.timer!.TIME_ELAPSED_EXT, query);
      this.queries.push(query);
    }
    super.draw(phases, view);
    if (query) gl.endQuery(this.timer!.TIME_ELAPSED_EXT);
    gl.flush();
  }
  async timings() {
    if (!this.timer) return null;
    const gl = this.gl,
      values: number[] = [],
      deadline = performance.now() + 3000;
    while (this.queries.length && performance.now() < deadline) {
      if (gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
        this.queries.forEach((q) => gl.deleteQuery(q));
        this.queries = [];
        return null;
      }
      const query = this.queries[0];
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        values.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(query);
        this.queries.shift();
      } else await new Promise(requestAnimationFrame);
    }
    this.queries.forEach((q) => gl.deleteQuery(q));
    this.queries = [];
    return values;
  }

  override dispose() {
    this.queries?.forEach((q) => this.gl.deleteQuery(q));
    this.queries = [];
    super.dispose();
  }
}

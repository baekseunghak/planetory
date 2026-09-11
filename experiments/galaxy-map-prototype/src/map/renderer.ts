import type { MapNode, Viewport, Signal } from "../../shared/types";
export const COLORS = ["#d9dcff", "#b7a6ff", "#8fbfff", "#9be7d6", "#f6c9ea"];
export const starColor = (planetCount: number, status: string) =>
  planetCount === 0 && status === "complete"
    ? "#f1cfa3"
    : COLORS[Math.min(4, planetCount)];
const rgb = (s: string) =>
  [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
const PALETTE = COLORS.map(rgb),
  APRICOT = rgb("#f1cfa3");
const ORBIT_SEGMENTS = Array.from({ length: 48 }, (_, k) => {
  const a = (k / 48) * Math.PI * 2,
    b = ((k + 1) / 48) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
});
export interface PlanetHit {
  x: number;
  y: number;
  starId: string;
  index: number;
}
export class SkyRenderer {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  lineProgram: WebGLProgram;
  buffer: WebGLBuffer;
  lineBuffer: WebGLBuffer;
  points = new Float32Array(50000);
  lines = new Float32Array(300000);
  hits = new Map<string, PlanetHit[]>();
  drawCalls = 0;
  orbitStars = 0;
  reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) throw new Error("WebGL을 사용할 수 없습니다.");
    this.gl = gl;
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) || "셰이더 오류");
      return shader;
    };
    const link = (vs: string, fs: string) => {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("프로그램 연결 오류");
      return program;
    };
    this.program = link(
      "attribute vec2 pos;attribute vec3 color;attribute float size;attribute float kind;uniform vec2 resolution;varying vec3 c;varying float k;void main(){gl_Position=vec4(pos/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);gl_PointSize=size;c=color;k=kind;}",
      "precision mediump float;varying vec3 c;varying float k;void main(){vec2 p=gl_PointCoord*2.-1.;float r=length(p);float a=k>0.5?exp(-dot(p*vec2(1.,1.4),p*vec2(1.,1.4))*4.)*.5:exp(-r*r*18.)*.35+exp(-r*r*180.);gl_FragColor=vec4(c,a*(1.-smoothstep(.8,1.,r)));}",
    );
    this.lineProgram = link(
      "attribute vec2 pos;uniform vec2 resolution;void main(){gl_Position=vec4(pos/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);}",
      "precision mediump float;void main(){gl_FragColor=vec4(.52,.56,.62,.45);}",
    );
    this.buffer = gl.createBuffer()!;
    this.lineBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.points.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lines.byteLength, gl.DYNAMIC_DRAW);
  }
  draw(nodes: MapNode[], view: Viewport, time: number) {
    const gl = this.gl,
      dpr = Math.min(devicePixelRatio, 2),
      w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this.hits.clear();
    this.orbitStars = 0;
    let pi = 0,
      li = 0;
    const point = (
      x: number,
      y: number,
      c: number[],
      size: number,
      kind: number,
    ) => {
      if (pi + 7 > this.points.length) return;
      this.points[pi] = x;
      this.points[pi + 1] = y;
      this.points[pi + 2] = c[0];
      this.points[pi + 3] = c[1];
      this.points[pi + 4] = c[2];
      this.points[pi + 5] = size * dpr;
      this.points[pi + 6] = kind;
      pi += 7;
    };
    for (const n of nodes) {
      const x = (n.x - view.x) * view.zoom + w / 2,
        y = (n.y - view.y) * view.zoom + h / 2;
      if (x < -100 || x > w + 100 || y < -100 || y > h + 100) continue;
      if (n.count > 1) {
        const count = n.count,
          c = [
            (0.72 * n.counts.new +
              0.4 * n.counts.done +
              0.3 * n.counts.planet) /
              count,
            (0.74 * n.counts.new +
              0.43 * n.counts.done +
              0.5 * n.counts.planet) /
              count,
            (0.86 * n.counts.new + 0.5 * n.counts.done + n.counts.planet) /
              count,
          ];
        point(x, y, c, Math.min(160, 64 + Math.log2(n.count) * 7), 1);
        continue;
      }
      const s = n.star!;
      point(
        x,
        y,
        s.planetCount === 0 && s.status === "complete"
          ? APRICOT
          : PALETTE[Math.min(4, s.planetCount)],
        s.planetCount ? 74 + Math.min(4, s.planetCount) * 12 : 64,
        0,
      );
      if (
        view.zoom >= 0.55 &&
        s.planetCount > 0 &&
        this.orbitStars < 60 &&
        x >= 0 &&
        x <= w &&
        y >= 0 &&
        y <= h
      ) {
        this.orbitStars++;
        const maxPlanets = Math.min(
          s.planetCount,
          Math.floor((this.points.length - pi) / 7),
        );
        for (let j = 0; j < maxPlanets; j++) {
          const rx = (30 + j * 12) * Math.min(1.4, Math.max(0.75, view.zoom)),
            ry = rx * 0.4,
            phase =
              ((this.reduced ? 1 : time / 1000) * 0.12) / (j + 1) + j * 1.8;
          for (let k = 0; k < 48; k++) {
            if (li + 4 > this.lines.length) break;
            const segment = ORBIT_SEGMENTS[k];
            this.lines[li] = x + segment[0] * rx;
            this.lines[li + 1] = y + segment[1] * ry;
            this.lines[li + 2] = x + segment[2] * rx;
            this.lines[li + 3] = y + segment[3] * ry;
            li += 4;
          }
          const px = x + Math.cos(phase) * rx,
            py = y + Math.sin(phase) * ry;
          point(px, py, PALETTE[Math.min(4, j + 1)], 12, 0);
          const key = Math.floor(px / 64) + "," + Math.floor(py / 64),
            cell = this.hits.get(key) || [];
          cell.push({ x: px, y: py, starId: s.id, index: j });
          this.hits.set(key, cell);
        }
      }
    }
    this.drawCalls = 0;
    if (li) {
      gl.useProgram(this.lineProgram);
      gl.uniform2f(gl.getUniformLocation(this.lineProgram, "resolution"), w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lines.subarray(0, li));
      const loc = gl.getAttribLocation(this.lineProgram, "pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 8, 0);
      gl.drawArrays(gl.LINES, 0, li / 2);
      this.drawCalls++;
    }
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, "resolution"), w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.points.subarray(0, pi));
    for (const [name, count, offset] of [
      ["pos", 2, 0],
      ["color", 3, 8],
      ["size", 1, 20],
      ["kind", 1, 24],
    ] as const) {
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, count, gl.FLOAT, false, 28, offset);
    }
    gl.drawArrays(gl.POINTS, 0, pi / 7);
    this.drawCalls++;
    this.canvas.dataset.drawCalls = String(this.drawCalls);
    this.canvas.dataset.orbitStars = String(this.orbitStars);
    this.canvas.dataset.rendered = String(nodes.length);
  }
  hit(x: number, y: number) {
    const cx = Math.floor(x / 64),
      cy = Math.floor(y / 64);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const match = this.hits
          .get(cx + i + "," + (cy + j))
          ?.find((p) => Math.hypot(p.x - x, p.y - y) < 8);
        if (match) return match;
      }
    return null;
  }
  destroy() {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteBuffer(this.lineBuffer);
    this.gl.deleteProgram(this.program);
    this.gl.deleteProgram(this.lineProgram);
  }
}

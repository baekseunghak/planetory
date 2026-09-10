import {
  project,
  ROLL,
  sceneScale,
  sceneCenterX,
  type GalaxyCamera,
  type GalaxyStar,
} from "../../shared/galaxy";
import { starColor } from "./renderer";

const color = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const vertex = `
attribute vec3 position; attribute vec3 color; attribute float size; attribute float index;
uniform vec2 resolution; uniform vec4 rotation; uniform vec2 pan; uniform float scale;
uniform float dpr; uniform float zoom; uniform float selected; uniform vec3 selectedColor; uniform float glow;
varying vec3 tint; varying float strength;
void main() {
  float a = position.x * rotation.x - position.y * rotation.y;
  float b = position.x * rotation.y + position.y * rotation.x;
  float v = b * rotation.z - position.z * rotation.w;
  float u = a * ${Math.cos(ROLL).toFixed(9)} - v * ${Math.sin(ROLL).toFixed(9)};
  float t = a * ${Math.sin(ROLL).toFixed(9)} + v * ${Math.cos(ROLL).toFixed(9)};
  vec2 screen = (vec2(u,t)-pan)*scale + vec2(resolution.x*(resolution.x<1200.?.39:.46),resolution.y*.46);
  gl_Position = vec4(screen/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
  bool active = abs(index-selected)<.1;
  float radius = active ? 24. : size;
  float fit = active ? 1. : min(resolution.x/1680.,resolution.y/974.);
  float sizeScale = zoom < 1. ? zoom : pow(zoom,.36);
  float desiredSize = radius * fit * dpr * sizeScale * (glow>.5?8.0:1.0);
  gl_PointSize = clamp(desiredSize,1.25,160.);
  tint = active ? selectedColor : color;
  strength = glow>.5 ? (active?.14:.048) : (active?1.0:.88);
  // Subpixel stars lose energy instead of piling up into a white square far away.
  strength *= min(1., desiredSize * desiredSize / (1.25 * 1.25));
}`;
const fragment = `
precision mediump float; varying vec3 tint; varying float strength;
void main(){vec2 p=gl_PointCoord*2.-1.;float d=dot(p,p);if(d>1.)discard;
float a=exp(-d*22.)+exp(-d*4.5)*.22;gl_FragColor=vec4(tint,a*strength);}`;

export class GalaxyRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private locations: Record<string, WebGLUniformLocation | null> = {};
  private stars: GalaxyStar[] = [];
  private index = new Map<string, number>();
  private grid = new Map<number, number[]>();
  private gridKey = "";
  private screen = new Float32Array(0);
  private selected = "";
  drawCalls = 0;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL을 사용할 수 없습니다.");
    this.gl = gl;
    const shader = (kind: number, source: string) => {
      const s = gl.createShader(kind)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(message || "셰이더 오류");
      }
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, vertex),
      fs = shader(gl.FRAGMENT_SHADER, fragment);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error("은하 렌더러 초기화 실패");
    this.buffer = gl.createBuffer()!;
    for (const name of [
      "resolution",
      "rotation",
      "pan",
      "scale",
      "dpr",
      "zoom",
      "selected",
      "selectedColor",
      "glow",
    ])
      this.locations[name] = gl.getUniformLocation(this.program, name);
  }
  setStars(stars: GalaxyStar[]) {
    if (stars === this.stars) return;
    this.stars = stars;
    this.index = new Map(stars.map((s, i) => [s.id, i]));
    this.screen = new Float32Array(stars.length * 3);
    this.gridKey = "";
    const packed = new Float32Array(stars.length * 8);
    stars.forEach((s, i) => {
      const t = s.warmth;
      const variation = ((i * 17) % 101) / 100;
      const cold =
        variation < 0.13
          ? [0.89, 0.72, 1]
          : [0.48 + variation * 0.24, 0.66 + variation * 0.15, 1];
      const warm = [1, 0.72, 0.44];
      packed.set(
        [
          s.x,
          s.y,
          s.z,
          ...cold.map((c, j) => c * (1 - t) + warm[j] * t),
          s.size,
          i,
        ],
        i * 8,
      );
    });
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);
  }
  select(id: string | null) {
    this.selected = id || "";
  }
  getStar(id: string) {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.stars[i];
  }
  draw(camera: GalaxyCamera) {
    const gl = this.gl,
      w = this.canvas.clientWidth,
      h = this.canvas.clientHeight,
      dpr = Math.min(devicePixelRatio, 2);
    if (
      this.canvas.width !== Math.round(w * dpr) ||
      this.canvas.height !== Math.round(h * dpr)
    ) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.001, 0.002, 0.004, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const [name, n, offset] of [
      ["position", 3, 0],
      ["color", 3, 12],
      ["size", 1, 24],
      ["index", 1, 28],
    ] as const) {
      const a = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, n, gl.FLOAT, false, 32, offset);
    }
    gl.uniform2f(this.locations.resolution, w, h);
    gl.uniform4f(
      this.locations.rotation,
      Math.cos(camera.yaw),
      Math.sin(camera.yaw),
      Math.cos(camera.tilt),
      Math.sin(camera.tilt),
    );
    gl.uniform2f(this.locations.pan, camera.x, camera.y);
    gl.uniform1f(this.locations.scale, sceneScale(w, h, camera.zoom));
    gl.uniform1f(this.locations.dpr, dpr);
    gl.uniform1f(this.locations.zoom, camera.zoom);
    const active = this.getStar(this.selected);
    gl.uniform1f(this.locations.selected, this.index.get(this.selected) ?? -1);
    const c = color(
      starColor(active?.planetCount || 0, active?.status || "unexplored"),
    );
    gl.uniform3f(this.locations.selectedColor, c[0], c[1], c[2]);
    gl.uniform1f(this.locations.glow, 1);
    gl.drawArrays(gl.POINTS, 0, this.stars.length);
    gl.uniform1f(this.locations.glow, 0);
    gl.drawArrays(gl.POINTS, 0, this.stars.length);
    this.drawCalls = this.stars.length ? 2 : 0;
    this.canvas.dataset.rendered = String(this.stars.length);
    this.canvas.dataset.drawCalls = String(this.drawCalls);
    this.canvas.dataset.camera = JSON.stringify(camera);
  }
  /** Rebuilt on demand after a camera/size change, never in the animation loop. */
  private refreshGrid(camera: GalaxyCamera) {
    const w = this.canvas.clientWidth,
      h = this.canvas.clientHeight;
    const key = [
      w,
      h,
      camera.x,
      camera.y,
      camera.zoom,
      camera.yaw,
      camera.tilt,
    ].join(",");
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.grid.clear();
    const cy = Math.cos(camera.yaw),
      sy = Math.sin(camera.yaw),
      ct = Math.cos(camera.tilt),
      st = Math.sin(camera.tilt),
      cr = Math.cos(ROLL),
      sr = Math.sin(ROLL),
      scale = sceneScale(w, h, camera.zoom);
    this.stars.forEach((s, i) => {
      const a = s.x * cy - s.y * sy,
        b = s.x * sy + s.y * cy,
        v = b * ct - s.z * st;
      const x = (a * cr - v * sr - camera.x) * scale + sceneCenterX(w),
        y = (a * sr + v * cr - camera.y) * scale + h * 0.46;
      this.screen[i * 3] = x;
      this.screen[i * 3 + 1] = y;
      this.screen[i * 3 + 2] = b * st + s.z * ct;
      if (x < 0 || y < 0 || x > w || y > h) return;
      const cell = Math.floor(y / 32) * 4096 + Math.floor(x / 32);
      const bucket = this.grid.get(cell);
      if (bucket) bucket.push(i);
      else this.grid.set(cell, [i]);
    });
  }
  hit(x: number, y: number, camera: GalaxyCamera): GalaxyStar | null {
    this.refreshGrid(camera);
    let closest = -1,
      score = Infinity;
    const cx = Math.floor(x / 32),
      cy = Math.floor(y / 32);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        for (const i of this.grid.get((cy + a) * 4096 + cx + b) || []) {
          const distance = Math.hypot(
            this.screen[i * 3] - x,
            this.screen[i * 3 + 1] - y,
          );
          const threshold = this.stars[i].size > 6 ? 15 : 7;
          const priority =
            distance - (this.stars[i].id === this.selected ? 2 : 0);
          if (distance < threshold && priority < score) {
            score = priority;
            closest = i;
          }
        }
      }
    return closest < 0 ? null : this.stars[closest];
  }
  destroy() {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.grid.clear();
    this.index.clear();
  }
}

import { planetOrbit, planetLabel, type HitTarget } from "./interaction.ts";
import { screenPoint } from "./model.ts";
import type { Matrix } from "../sky-data/geometry.ts";
import { galaxyExposure } from "./exposure.ts";
import {
  ORBIT_COLOR,
  rgb,
  stablePhase,
  starStyle,
  type OwnedSystem,
  type RenderPlan,
} from "./model.ts";

// The same two triangles share their middle edge; avoid processing two duplicate
// vertices per body in both the glow and surface passes.
const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const common = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
layout(location=1) in vec3 center;
uniform mat4 matrix; uniform vec2 viewport;
out vec2 uv; out vec3 tint; out float seed; out float mode; out float density;
`;
const bodyVertex =
  common +
  `
layout(location=2) in float baseSize;
layout(location=3) in vec3 color;
layout(location=4) in float selected;
uniform float zoom; uniform float dpr; uniform float glow; uniform float exposure;
out float strength;
void main(){
  bool selectedStar=selected>.5;
  float radius=selected>1.5?96.:selectedStar?24.:baseSize*1.35;
  float fit=selectedStar?1.:max(.55,min(viewport.x/1680.,viewport.y/974.));
  float sizeScale=zoom<1.?pow(zoom,.78):pow(zoom,.36);
  float desired=radius*fit*dpr*sizeScale*(glow>.5?8.:1.);
  float diameter=clamp(desired,1.25,160.)/dpr;
  vec4 p=matrix*vec4(center,1.);
  p.xy+=corner*diameter*vec2(1.,-1.)/viewport;
  gl_Position=p; uv=corner; tint=color; seed=0.;mode=selected;density=1.;
  strength=(glow>.5?(selectedStar?.14:.048):(selectedStar?1.:.88))*min(1.,desired*desired/1.5625)*(selectedStar?1.:exposure);
}`;
const bodyFragment = `#version 300 es
precision highp float;
in vec2 uv; in vec3 tint; in float strength; in float mode; uniform float glow; uniform float focusMix; out vec4 outputColor;
void main(){float d=dot(uv,uv);if(d>1.)discard;
if(mode>1.5 && glow<.5){
vec3 n=vec3(uv,sqrt(1.-d));
float surface=.86+.08*sin(uv.x*41.)*sin(uv.y*53.)+.06*cos((uv.x+uv.y)*73.);
float light=.48+.52*max(0.,dot(n,normalize(vec3(-.5,-.2,1.))));
outputColor=vec4(tint*surface*light,(1.-smoothstep(.94,1.,d))*(1.-focusMix));return;}
float a=exp(-d*22.)+exp(-d*4.5)*.22;outputColor=vec4(tint,a*strength*(mode>1.5?1.-focusMix:1.));}`;
const orbitVertex = `#version 300 es
precision highp float; layout(location=0) in vec3 center; layout(location=1) in vec2 offset;
uniform mat4 matrix; uniform vec2 viewport;
void main(){vec4 p=matrix*vec4(center,1.);p.xy+=offset*vec2(2.,-2.)/viewport*p.w;gl_Position=p;}`;
const orbitFragment = `#version 300 es
precision highp float; uniform vec3 color; uniform float focusMix; out vec4 outputColor;
void main(){outputColor=vec4(color,.34*(1.-focusMix));}`;
const planetVertex =
  common +
  `
layout(location=2) in vec4 orbit;
layout(location=3) in vec3 color;
uniform float time; uniform float focusPhase; uniform float focusMix;
void main(){float a=orbit.y+time*orbit.z;vec2 offset=vec2(cos(a),sin(a)*.48)*orbit.x;
bool focused=abs(orbit.y-focusPhase)<.000001;
float radius=focused?mix(orbit.w,min(viewport.x,viewport.y)*.22,focusMix):orbit.w;
if(focused)offset*=1.-focusMix;
vec4 p=matrix*vec4(center,1.);p.xy+=(offset+corner*radius)*vec2(2.,-2.)/viewport*p.w;
gl_Position=p;uv=corner;tint=color;seed=orbit.y;mode=focused?1.:0.;density=focused?1.:1.-focusMix;}`;
const planetFragment = `#version 300 es
precision highp float; in vec2 uv;in vec3 tint;in float seed;in float density;out vec4 outputColor;
void main(){float d=dot(uv,uv);if(d>1.)discard;vec3 normal=vec3(uv,sqrt(1.-d));
float light=.22+.78*max(0.,dot(normal,normalize(vec3(-.5,-.3,1.))));
float bands=.85+.10*sin(uv.y*35.+seed*3.+sin(uv.x*8.+seed)*2.)+.05*cos(uv.x*43.+seed);
outputColor=vec4(tint*light*bands,(1.-smoothstep(.87,1.,d))*density);}`;

export type RendererMetrics = {
  stars: number;
  orbitStars: number;
  planets: number;
  detailedSystems: number;
  bodyDrawCalls: number;
  orbitDrawCalls: number;
  planetDrawCalls: number;
  drawCalls: number;
  gpuBuffers: number;
  backgroundBlits: number;
  backgroundCacheAvailable: boolean;
  backgroundBytes: number;
  bodyDrawCallsTotal: number;
  bufferAllocations: number;
  uploadBytes: number;
  frameCount: number;
  packedNodes: number;
  animatedSeconds: number;
  exposure: number;
};
function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const result = gl.createProgram();
  if (!result) throw new Error("WebGL 프로그램을 만들 수 없습니다.");
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("셰이더를 만들 수 없습니다.");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message || "셰이더 컴파일 실패");
      }
      gl.attachShader(result, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(result) || "프로그램 연결 실패");
    return result;
  } catch (error) {
    gl.deleteProgram(result);
    throw error;
  }
}
// Capacity survives tile/LOD changes. Only changed ranges are uploaded after packing.
class ReusableBuffer {
  readonly buffer: WebGLBuffer;
  private data = new Float32Array(0);
  length = 0;
  allocations = 0;
  uploadBytes = 0;
  constructor(private gl: WebGL2RenderingContext) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("GPU 버퍼 생성 실패");
    this.buffer = buffer;
  }
  update(values: ArrayLike<number>) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (values.length > this.data.length) {
      this.data = new Float32Array(
        2 ** Math.ceil(Math.log2(Math.max(64, values.length))),
      );
      this.allocations++;
      gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
      this.data.fill(NaN);
    }
    // Values are already float32 for the large star buffer. Find the changed
    // span at its boundaries, then copy in native code instead of assigning
    // hundreds of thousands of JS numbers on every culled camera view.
    const floats =
      values instanceof Float32Array ? values : Float32Array.from(values);
    let first = 0,
      last = floats.length - 1;
    while (first <= last && this.data[first] === floats[first]) first++;
    while (last >= first && this.data[last] === floats[last]) last--;
    if (first <= last) {
      this.data.set(floats.subarray(first, last + 1), first);
      this.upload(first, last + 1);
    }
    this.length = values.length;
  }
  private upload(start: number, end: number) {
    this.gl.bufferSubData(
      this.gl.ARRAY_BUFFER,
      start * 4,
      this.data,
      start,
      end - start,
    );
    this.uploadBytes += (end - start) * 4;
  }
  dispose() {
    this.gl.deleteBuffer(this.buffer);
  }
}
type Pipeline = {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  matrix: WebGLUniformLocation | null;
  viewport: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  zoom: WebGLUniformLocation | null;
  dpr: WebGLUniformLocation | null;
  glow: WebGLUniformLocation | null;
  exposure: WebGLUniformLocation | null;
  focusPhase: WebGLUniformLocation | null;
  focusMix: WebGLUniformLocation | null;
};
export class GalaxyRenderer {
  private gl: WebGL2RenderingContext;
  private quadBuffer: WebGLBuffer;
  private bodies: ReusableBuffer;
  private rings: ReusableBuffer;
  private planets: ReusableBuffer;
  private bodyPipeline: Pipeline;
  private ringPipeline: Pipeline;
  private planetPipeline: Pipeline;
  private matrix = new Float32Array(16);
  private background: WebGLFramebuffer | null;
  private backgroundColor: WebGLRenderbuffer | null;
  private backgroundWidth = 0;
  private backgroundHeight = 0;
  private backgroundReady = false;
  private backgroundDirty = true;
  private backgroundFocusMix = -1;
  private width = 1;
  private height = 1;
  private time = 0;
  private renderedTime = 0;
  private system: OwnedSystem | null = null;
  private focusedPlanet: string | null = null;
  private focusMix = 0;
  private zoom = 1;
  private starCount = 0;
  private previousScene: {
    stars: RenderPlan["stars"];
    selected: string | null;
    system: OwnedSystem | null;
    width: number;
    height: number;
  } | null = null;
  private bodyStaging = new Float32Array(0);
  private packedSources = new WeakMap<readonly object[], Float32Array>();
  private styles = new WeakMap<object, ReturnType<typeof starStyle>>();
  private disposed = false;
  private stats = {
    stars: 0,
    orbitStars: 0,
    planets: 0,
    detailedSystems: 0,
    bodyDrawCalls: 0,
    orbitDrawCalls: 0,
    planetDrawCalls: 0,
    drawCalls: 0,
    frameCount: 0,
    packedNodes: 0,
    backgroundBlits: 0,
    bodyDrawCallsTotal: 0,
  };
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL 2를 사용할 수 없습니다.");
    this.gl = gl;
    this.background = gl.createFramebuffer();
    this.backgroundColor = gl.createRenderbuffer();
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    this.bodies = new ReusableBuffer(gl);
    this.rings = new ReusableBuffer(gl);
    this.planets = new ReusableBuffer(gl);
    const bodyProgram = program(gl, bodyVertex, bodyFragment);
    this.bodyPipeline = this.pipeline(
      bodyProgram,
      this.bodies,
      8,
      [
        [1, 3, 0],
        [2, 1, 3],
        [3, 3, 4],
        [4, 1, 7],
      ],
      true,
    );
    this.ringPipeline = this.pipeline(
      program(gl, orbitVertex, orbitFragment),
      this.rings,
      5,
      [
        [0, 3, 0],
        [1, 2, 3],
      ],
      false,
    );
    this.planetPipeline = this.pipeline(
      program(gl, planetVertex, planetFragment),
      this.planets,
      10,
      [
        [1, 3, 0],
        [2, 4, 3],
        [3, 3, 7],
      ],
      true,
    );
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }
  private pipeline(
    p: WebGLProgram,
    buffer: ReusableBuffer,
    stride: number,
    attributes: number[][],
    instanced: boolean,
  ): Pipeline {
    const gl = this.gl,
      vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    if (instanced) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer);
    for (const [location, count, offset] of attributes) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        count,
        gl.FLOAT,
        false,
        stride * 4,
        offset * 4,
      );
      gl.vertexAttribDivisor(location, instanced ? 1 : 0);
    }
    gl.bindVertexArray(null);
    return {
      program: p,
      vao,
      matrix: gl.getUniformLocation(p, "matrix"),
      viewport: gl.getUniformLocation(p, "viewport"),
      time: gl.getUniformLocation(p, "time"),
      color: gl.getUniformLocation(p, "color"),
      zoom: gl.getUniformLocation(p, "zoom"),
      dpr: gl.getUniformLocation(p, "dpr"),
      glow: gl.getUniformLocation(p, "glow"),
      exposure: gl.getUniformLocation(p, "exposure"),
      focusPhase: gl.getUniformLocation(p, "focusPhase"),
      focusMix: gl.getUniformLocation(p, "focusMix"),
    };
  }
  setCamera(
    matrix: Matrix,
    width: number,
    height: number,
    zoom = 1,
    starCount = 0,
  ) {
    if (
      width !== this.width ||
      height !== this.height ||
      zoom !== this.zoom ||
      starCount !== this.starCount ||
      matrix.some((value, i) => Math.fround(value) !== this.matrix[i])
    )
      this.backgroundDirty = true;
    this.zoom = zoom;
    this.starCount = starCount;
    this.matrix.set(matrix);
    this.width = width;
    this.height = height;
  }
  setScene(
    plan: RenderPlan,
    selected: string | null,
    system: OwnedSystem | null = null,
  ) {
    this.system = system;
    if (system && system.ticId !== selected)
      throw new Error("선택한 별과 행성 목록이 다릅니다.");
    const previous = this.previousScene;
    if (
      previous &&
      previous.selected === selected &&
      previous.system === system &&
      previous.width === this.width &&
      previous.height === this.height &&
      (previous.stars === plan.stars ||
        (previous.stars.length === plan.stars.length &&
          previous.stars.every((s, i) => s === plan.stars[i])))
    )
      return;
    if (this.bodyStaging.length < plan.stars.length * 8)
      this.bodyStaging = new Float32Array(
        2 ** Math.ceil(Math.log2(Math.max(64, plan.stars.length * 8))),
      );
    const body = this.bodyStaging.subarray(0, plan.stars.length * 8),
      rings: number[] = [],
      planets: number[] = [];
    const source = plan.spans?.source ?? plan.stars;
    let packed = this.packedSources.get(source);
    if (!packed) {
      packed = new Float32Array(source.length * 8);
      let offset = 0;
      for (const star of source) {
        let style = this.styles.get(star);
        if (!style) {
          style = starStyle(star);
          this.styles.set(star, style);
        }
        packed[offset++] = star.x;
        packed[offset++] = star.y;
        packed[offset++] = star.depthZ;
        packed[offset++] = style.baseSize;
        packed[offset++] = style.rgb[0];
        packed[offset++] = style.rgb[1];
        packed[offset++] = style.rgb[2];
        packed[offset++] = 0;
      }
      this.packedSources.set(source, packed);
    }
    if (plan.spans) {
      let offset = 0;
      for (const [start, end] of plan.spans.ranges) {
        body.set(packed.subarray(start * 8, end * 8), offset);
        offset += (end - start) * 8;
      }
    } else body.set(packed);
    const selectedIndex =
      selected === null
        ? -1
        : plan.stars.findIndex((s) => s.ticId === selected);
    if (selectedIndex >= 0) body[selectedIndex * 8 + 7] = system ? 2 : 1;
    let orbitStars = 0;
    const addOrbits = (
      position: { x: number; y: number; depthZ: number },
      items: OwnedSystem["items"],
      detailed: boolean,
    ) => {
      if (!items.length) return;
      orbitStars++;
      items.forEach((item, i) => {
        const radius = detailed
          ? planetOrbit(i, items.length, this.width, this.height).radius
          : 16 + i * 6;
        for (let j = 0; j < 64; j++)
          for (const k of [j, j + 1]) {
            const a = (k / 64) * Math.PI * 2;
            rings.push(
              position.x,
              position.y,
              position.depthZ,
              Math.cos(a) * radius,
              Math.sin(a) * radius * 0.48,
            );
          }
        const phase = stablePhase(item.candidateId),
          color =
            item.kind === "confirmed"
              ? [0.63 + Math.sin(phase) * 0.13, 0.76, 0.94]
              : [0.9, 0.7, 0.83];
        planets.push(
          position.x,
          position.y,
          position.depthZ,
          radius,
          phase,
          detailed
            ? planetOrbit(i, items.length, this.width, this.height).speed
            : 0,
          detailed ? 8 + Math.sin(phase) * 1.5 : 2,
          ...color,
        );
      });
    };
    if (system) {
      const existing = plan.stars[selectedIndex];
      if (
        existing &&
        (existing.x !== system.position.x ||
          existing.y !== system.position.y ||
          existing.depthZ !== system.position.depthZ ||
          existing.layoutOrdinal !== system.position.layoutOrdinal ||
          existing.planetCount !== system.items.length)
      )
        throw new Error(
          "타일과 상세의 좌표/행성 수가 다릅니다. 최신 자료를 확인해 주세요.",
        );
      if (!existing)
        throw new Error("상세 렌더링에 선택 별의 타일 자료가 필요합니다.");
      addOrbits(system.position, system.items, true);
    }
    this.bodies.update(body);
    this.rings.update(rings);
    this.planets.update(planets);
    this.backgroundDirty = true;
    Object.assign(this.stats, {
      stars: plan.stars.length,
      orbitStars,
      planets: planets.length / 10,
      detailedSystems: system ? 1 : 0,
      packedNodes: this.stats.packedNodes + plan.stars.length,
    });
    this.previousScene = {
      stars: plan.stars,
      selected,
      system,
      width: this.width,
      height: this.height,
    };
  }
  setPlanetFocus(id: string | null) {
    const next = this.system?.items.some((p) => p.candidateId === id)
      ? id
      : null;
    if (this.focusedPlanet !== next) this.focusMix = 0;
    this.focusedPlanet = next;
  }
  private bind(p: Pipeline) {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.bindVertexArray(p.vao);
    gl.uniformMatrix4fv(p.matrix, false, this.matrix);
    gl.uniform2f(p.viewport, this.width, this.height);
    gl.uniform1f(p.focusMix, this.focusMix);
    gl.uniform1f(
      p.focusPhase,
      this.focusedPlanet ? stablePhase(this.focusedPlanet) : -1,
    );
  }
  draw(deltaSeconds = 0, reducedMotion = false) {
    if (this.disposed || this.gl.isContextLost()) return;
    const gl = this.gl,
      dpr = Math.min(window.devicePixelRatio || 1, 2),
      w = Math.round(this.width * dpr),
      h = Math.round(this.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    if (
      this.background &&
      this.backgroundColor &&
      (w !== this.backgroundWidth || h !== this.backgroundHeight)
    ) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.backgroundColor);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.background);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.backgroundColor,
      );
      this.backgroundReady =
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
        gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_WIDTH) ===
          w &&
        gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_HEIGHT) ===
          h;
      this.backgroundWidth = w;
      this.backgroundHeight = h;
      this.backgroundDirty = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    }
    this.time += reducedMotion ? 0 : Math.max(0, Math.min(deltaSeconds, 0.05));
    this.focusMix = this.focusedPlanet
      ? reducedMotion
        ? 1
        : Math.min(
            1,
            this.focusMix + Math.max(0, Math.min(deltaSeconds, 0.05)) * 2.5,
          )
      : 0;
    this.renderedTime = reducedMotion ? 0 : this.time;
    if (this.focusMix !== this.backgroundFocusMix) this.backgroundDirty = true;
    let bodyCalls = 0,
      ringCalls = 0,
      planetCalls = 0;
    if (!this.backgroundReady || this.backgroundDirty) {
      gl.bindFramebuffer(
        gl.FRAMEBUFFER,
        this.backgroundReady ? this.background : null,
      );
      gl.clearColor(0.001, 0.002, 0.004, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      if (this.bodies.length) {
        this.bind(this.bodyPipeline);
        gl.uniform1f(this.bodyPipeline.zoom, this.zoom);
        gl.uniform1f(this.bodyPipeline.dpr, dpr);
        gl.uniform1f(
          this.bodyPipeline.exposure,
          galaxyExposure(this.starCount, this.zoom),
        );
        for (const glow of [1, 0]) {
          gl.uniform1f(this.bodyPipeline.glow, glow);
          gl.drawArraysInstanced(
            gl.TRIANGLE_STRIP,
            0,
            4,
            this.bodies.length / 8,
          );
          bodyCalls++;
        }
      }
      this.backgroundDirty = false;
      this.backgroundFocusMix = this.focusMix;
    }
    this.stats.backgroundBlits = 0;
    if (this.backgroundReady) {
      // Copy pixels at the exact canvas resolution. No resampling, reduced DPR,
      // changed glow, missing stars or extra scene is used for the cached frame.
      // Initialize the non-preserved default drawing buffer before binding a
      // separate read source (including frames after browser compositing).
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0.001, 0.002, 0.004, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.background);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(
        0,
        0,
        w,
        h,
        0,
        0,
        w,
        h,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.stats.backgroundBlits = 1;
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.rings.length) {
      this.bind(this.ringPipeline);
      gl.uniform3f(
        this.ringPipeline.color,
        ...(rgb(ORBIT_COLOR) as [number, number, number]),
      );
      gl.drawArrays(gl.LINES, 0, this.rings.length / 5);
      ringCalls++;
    }
    if (this.planets.length) {
      this.bind(this.planetPipeline);
      gl.uniform1f(this.planetPipeline.time, reducedMotion ? 0 : this.time);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.planets.length / 10);
      planetCalls++;
    }
    this.stats.bodyDrawCalls = bodyCalls;
    this.stats.bodyDrawCallsTotal += bodyCalls;
    this.stats.orbitDrawCalls = ringCalls;
    this.stats.planetDrawCalls = planetCalls;
    this.stats.drawCalls = bodyCalls + ringCalls + planetCalls;
    this.stats.frameCount++;
  }
  planetTargets(): HitTarget[] {
    if (!this.system || this.disposed || this.gl.isContextLost()) return [];
    const { position, items } = this.system;
    const center = screenPoint(
      Array.from(this.matrix),
      this.width,
      this.height,
      position.x,
      position.y,
      position.depthZ,
    );
    return items.flatMap((p, i) => {
      if (this.focusedPlanet && p.candidateId !== this.focusedPlanet) return [];
      const orbit = planetOrbit(i, items.length, this.width, this.height);
      const angle =
        stablePhase(p.candidateId) + this.renderedTime * orbit.speed;
      const mix = this.focusedPlanet === p.candidateId ? this.focusMix : 0;
      const x = center.x + Math.cos(angle) * orbit.radius * (1 - mix),
        y = center.y + Math.sin(angle) * orbit.radius * 0.48 * (1 - mix);
      return x < 0 || y < 0 || x > this.width || y > this.height
        ? []
        : [
            {
              id: p.candidateId,
              kind: "planet" as const,
              x,
              y,
              radius:
                10 * (1 - mix) + Math.min(this.width, this.height) * 0.22 * mix,
              label: planetLabel(p),
              planet: p,
              systemTicId: this.system!.ticId,
            },
          ];
    });
  }
  metrics(): RendererMetrics {
    const buffers = [this.bodies, this.rings, this.planets];
    return {
      ...this.stats,
      backgroundCacheAvailable: this.backgroundReady,
      backgroundBytes: this.backgroundReady
        ? this.backgroundWidth * this.backgroundHeight * 4
        : 0,
      gpuBuffers: 4,
      bufferAllocations: 1 + buffers.reduce((n, b) => n + b.allocations, 0),
      uploadBytes:
        quad.byteLength + buffers.reduce((n, b) => n + b.uploadBytes, 0),
      animatedSeconds: this.time,
      exposure: galaxyExposure(this.starCount, this.zoom),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [this.bodies, this.rings, this.planets]) b.dispose();
    const pipelines = [
      this.bodyPipeline,
      this.ringPipeline,
      this.planetPipeline,
    ];
    for (const p of pipelines) this.gl.deleteVertexArray(p.vao);
    for (const p of new Set(pipelines.map((p) => p.program)))
      this.gl.deleteProgram(p);
    this.gl.deleteBuffer(this.quadBuffer);
    this.gl.deleteFramebuffer(this.background);
    this.gl.deleteRenderbuffer(this.backgroundColor);
  }
}

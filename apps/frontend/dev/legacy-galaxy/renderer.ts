import type { Matrix } from "./geometry.ts";
import type { Star } from "./contracts.ts";
import {
  clusterColor,
  ORBIT_COLOR,
  rgb,
  stablePhase,
  starStyle,
  type OwnedSystem,
  type RenderPlan,
} from "./model.ts";

const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
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
layout(location=2) in vec2 radius;
layout(location=3) in vec3 color;
layout(location=4) in float identity;
layout(location=5) in float kind;
layout(location=6) in float count;
void main(){ vec4 p=matrix*vec4(center,1.); p.xy+=corner*radius*vec2(2.,-2.)/viewport*p.w;
gl_Position=p; uv=corner; tint=color; seed=identity; mode=kind; density=count; }`;
const bodyFragment = `#version 300 es
precision highp float;
in vec2 uv; in vec3 tint; in float seed; in float mode; in float density; out vec4 outputColor;
float noise(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7))+seed)*43758.5453);}
void main(){float d=dot(uv,uv); if(d>1.)discard;
float a=exp(-d*28.)*.95+exp(-d*5.)*.18;
if(mode>.5){float cloud=.58+.26*sin(uv.x*11.+seed)*cos(uv.y*8.-seed)+.16*noise(floor(uv*80.));
a=exp(-d*3.8)*cloud*(.28+min(.38,log(1.+density)*.055))*(1.-smoothstep(.65,1.,d));}
outputColor=vec4(tint,a); }`;
const orbitVertex = `#version 300 es
precision highp float; layout(location=0) in vec3 center; layout(location=1) in vec2 offset;
uniform mat4 matrix; uniform vec2 viewport;
void main(){vec4 p=matrix*vec4(center,1.);p.xy+=offset*vec2(2.,-2.)/viewport*p.w;gl_Position=p;}`;
const orbitFragment = `#version 300 es
precision highp float; uniform vec3 color; out vec4 outputColor;
void main(){outputColor=vec4(color,.34);}`;
const planetVertex =
  common +
  `
layout(location=2) in vec4 orbit;
layout(location=3) in vec3 color;
uniform float time;
void main(){float a=orbit.y+time*orbit.z;vec2 offset=vec2(cos(a),sin(a)*.48)*orbit.x;
vec4 p=matrix*vec4(center,1.);p.xy+=(offset+corner*orbit.w)*vec2(2.,-2.)/viewport*p.w;
gl_Position=p;uv=corner;tint=color;seed=0.;mode=0.;density=1.;}`;
const planetFragment = `#version 300 es
precision highp float; in vec2 uv;in vec3 tint;out vec4 outputColor;
void main(){float d=dot(uv,uv);if(d>1.)discard;vec3 normal=vec3(uv,sqrt(1.-d));
float light=.22+.78*max(0.,dot(normal,normalize(vec3(-.5,-.3,1.))));
outputColor=vec4(tint*light,1.-smoothstep(.87,1.,d));}`;

export type RendererMetrics = {
  stars: number;
  clusters: number;
  orbitStars: number;
  planets: number;
  detailedSystems: number;
  bodyDrawCalls: number;
  orbitDrawCalls: number;
  planetDrawCalls: number;
  drawCalls: number;
  gpuBuffers: number;
  bufferAllocations: number;
  uploadBytes: number;
  frameCount: number;
  packedNodes: number;
  animatedSeconds: number;
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
  update(values: number[]) {
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
    let first = -1;
    for (let i = 0; i < values.length; i++) {
      const value = Math.fround(values[i]);
      if (this.data[i] !== value) {
        this.data[i] = value;
        if (first < 0) first = i;
      } else if (first >= 0) {
        this.upload(first, i);
        first = -1;
      }
    }
    if (first >= 0) this.upload(first, values.length);
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
};
export class GalaxyRenderer {
  private gl: WebGL2RenderingContext;
  private quadBuffer: WebGLBuffer;
  private bodies: ReusableBuffer;
  private clouds: ReusableBuffer;
  private rings: ReusableBuffer;
  private planets: ReusableBuffer;
  private bodyPipeline: Pipeline;
  private cloudPipeline: Pipeline;
  private ringPipeline: Pipeline;
  private planetPipeline: Pipeline;
  private matrix = new Float32Array(16);
  private width = 1;
  private height = 1;
  private time = 0;
  private disposed = false;
  private stats = {
    stars: 0,
    clusters: 0,
    orbitStars: 0,
    planets: 0,
    detailedSystems: 0,
    bodyDrawCalls: 0,
    orbitDrawCalls: 0,
    planetDrawCalls: 0,
    drawCalls: 0,
    frameCount: 0,
    packedNodes: 0,
  };
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL 2를 사용할 수 없습니다.");
    this.gl = gl;
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    this.bodies = new ReusableBuffer(gl);
    this.clouds = new ReusableBuffer(gl);
    this.rings = new ReusableBuffer(gl);
    this.planets = new ReusableBuffer(gl);
    const bodyProgram = program(gl, bodyVertex, bodyFragment);
    const bodyLayout = [
      [1, 3, 0],
      [2, 2, 3],
      [3, 3, 5],
      [4, 1, 8],
      [5, 1, 9],
      [6, 1, 10],
    ];
    this.bodyPipeline = this.pipeline(
      bodyProgram,
      this.bodies,
      11,
      bodyLayout,
      true,
    );
    this.cloudPipeline = this.pipeline(
      bodyProgram,
      this.clouds,
      11,
      bodyLayout,
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
    };
  }
  setCamera(matrix: Matrix, width: number, height: number) {
    this.matrix.set(matrix);
    this.width = width;
    this.height = height;
  }
  setScene(
    plan: RenderPlan,
    selected: string | null,
    system: OwnedSystem | null = null,
  ) {
    if (plan.overflow)
      throw new Error(
        `렌더 예산 초과: ${plan.overflow}. 서버 군집 단계가 필요합니다.`,
      );
    if (system && system.ticId !== selected)
      throw new Error("선택한 별과 행성 목록이 다릅니다.");
    const body: number[] = [],
      cloud: number[] = [],
      rings: number[] = [],
      planets: number[] = [];
    const starIds = new Set<string>();
    const addStar = (s: Star) => {
      const style = starStyle(s);
      body.push(
        s.x,
        s.y,
        s.depthZ,
        style.radius * 4,
        style.radius * 4,
        ...rgb(style.color),
        stablePhase(s.ticId),
        0,
        1,
      );
      starIds.add(s.ticId);
    };
    for (const s of plan.stars) addStar(s);
    for (const { node: c, rx, ry } of plan.clusters)
      cloud.push(
        c.x,
        c.y,
        0,
        rx,
        ry,
        ...clusterColor(c),
        stablePhase(c.nodeId),
        1,
        c.count,
      );
    let orbitStars = 0;
    const addOrbits = (
      position: { x: number; y: number; depthZ: number },
      items: { candidateId: string; kind: string }[],
      detailed: boolean,
    ) => {
      if (!items.length) return;
      orbitStars++;
      items.forEach((item, i) => {
        const radius = detailed
          ? 35 +
            ((i + 1) / (items.length + 1)) *
              Math.min(this.width, this.height) *
              0.34
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
          detailed ? 0.12 + 0.18 / (i + 1) : 0,
          detailed ? 4.5 : 2,
          ...color,
        );
      });
    };
    for (const s of plan.orbitStars)
      if (s.ticId !== system?.ticId) addOrbits(s, s.orbits, false);
    if (system) {
      const existing = plan.stars.find((s) => s.ticId === system.ticId);
      if (
        existing &&
        (existing.x !== system.position.x ||
          existing.y !== system.position.y ||
          existing.depthZ !== system.position.depthZ ||
          existing.planetCount !== system.items.length)
      )
        throw new Error(
          "타일과 상세의 좌표/행성 수가 다릅니다. 최신 자료를 확인해 주세요.",
        );
      if (!starIds.has(system.ticId))
        throw new Error("상세 렌더링에 선택 별의 타일 자료가 필요합니다.");
      addOrbits(system.position, system.items, true);
    }
    this.bodies.update(body);
    this.clouds.update(cloud);
    this.rings.update(rings);
    this.planets.update(planets);
    Object.assign(this.stats, {
      stars: plan.stars.length,
      clusters: plan.clusters.length,
      orbitStars,
      planets: planets.length / 10,
      detailedSystems: system ? 1 : 0,
      packedNodes:
        this.stats.packedNodes + plan.stars.length + plan.clusters.length,
    });
  }
  private bind(p: Pipeline) {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.bindVertexArray(p.vao);
    gl.uniformMatrix4fv(p.matrix, false, this.matrix);
    gl.uniform2f(p.viewport, this.width, this.height);
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
    gl.clearColor(0.001, 0.002, 0.004, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.time += reducedMotion ? 0 : Math.max(0, Math.min(deltaSeconds, 0.05));
    let bodyCalls = 0,
      ringCalls = 0,
      planetCalls = 0;
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    if (this.clouds.length) {
      this.bind(this.cloudPipeline);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.clouds.length / 11);
      bodyCalls++;
    }
    if (this.bodies.length) {
      this.bind(this.bodyPipeline);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.bodies.length / 11);
      bodyCalls++;
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
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.planets.length / 10);
      planetCalls++;
    }
    this.stats.bodyDrawCalls = bodyCalls;
    this.stats.orbitDrawCalls = ringCalls;
    this.stats.planetDrawCalls = planetCalls;
    this.stats.drawCalls = bodyCalls + ringCalls + planetCalls;
    this.stats.frameCount++;
  }
  metrics(): RendererMetrics {
    const buffers = [this.bodies, this.clouds, this.rings, this.planets];
    return {
      ...this.stats,
      gpuBuffers: 5,
      bufferAllocations: 1 + buffers.reduce((n, b) => n + b.allocations, 0),
      uploadBytes:
        quad.byteLength + buffers.reduce((n, b) => n + b.uploadBytes, 0),
      animatedSeconds: this.time,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of [this.bodies, this.clouds, this.rings, this.planets])
      b.dispose();
    const pipelines = [
      this.bodyPipeline,
      this.cloudPipeline,
      this.ringPipeline,
      this.planetPipeline,
    ];
    for (const p of pipelines) this.gl.deleteVertexArray(p.vao);
    for (const p of new Set(pipelines.map((p) => p.program)))
      this.gl.deleteProgram(p);
    this.gl.deleteBuffer(this.quadBuffer);
  }
}

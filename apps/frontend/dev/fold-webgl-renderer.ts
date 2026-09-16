import type { FoldView } from "../src/features/analysis/folded-curve";

const vertex = `#version 300 es
precision highp float;
layout(location=0) in float phase;
layout(location=1) in float fluxY;
uniform vec2 view;
uniform vec2 resolution;
uniform float radius;
out vec2 circle;
void main(){
 vec2 corner=vec2((gl_VertexID==1||gl_VertexID==3)?1.0:-1.0, gl_VertexID>=2?1.0:-1.0);
 circle=corner*(radius+0.5);
 float p=phase+float(gl_InstanceID%3-1);
 float low=view.y-1.0/view.x;
 float x=(p-low)*view.x-1.0;
 if(p<low||p>=view.y+1.0/view.x){gl_Position=vec4(2.0,2.0,0.0,1.0);return;}
 gl_Position=vec4(vec2(x,fluxY*2.0-1.0)+circle*2.0/resolution,0.0,1.0);
}`;
const fragment = `#version 300 es
precision highp float;
in vec2 circle;
uniform float radius;
out vec4 color;
void main(){float a=clamp(radius+0.5-length(circle),0.0,1.0);if(a==0.0)discard;color=vec4(vec3(166.,232.,206.)/255.,a);}`;
const gridVertex = `#version 300 es
void main(){gl_Position=vec4((gl_VertexID==1||gl_VertexID==3)?1.0:-1.0,gl_VertexID>=2?1.0:-1.0,0.,1.);}`;
const gridFragment = `#version 300 es
precision highp float;
uniform float height;
uniform float pixelRatio;
out vec4 color;
void main(){float p=gl_FragCoord.y/(height/4.);float d=min(fract(p),1.-fract(p))*(height/4.);color=vec4(1.,1.,1.,d<=pixelRatio*0.5?24./255.:0.);}`;

/** Display-only renderer. Scientific Float64 arrays are never modified. */
export class FoldWebglRenderer {
  readonly gl: WebGL2RenderingContext;
  private programs: WebGLProgram[] = [];
  private shaders: WebGLShader[] = [];
  private buffers: WebGLBuffer[] = [];
  private vao: WebGLVertexArrayObject | null = null;
  private phase32: Float32Array;
  private lastPhases: Float64Array | null = null;
  private disposed = false;
  private uniforms!: {
    view: WebGLUniformLocation | null;
    resolution: WebGLUniformLocation | null;
    radius: WebGLUniformLocation | null;
    height: WebGLUniformLocation | null;
    pixelRatio: WebGLUniformLocation | null;
  };
  constructor(
    readonly canvas: HTMLCanvasElement,
    normalizedFlux: Float32Array,
    private dpr: number,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
    });
    if (!gl || gl.isContextLost()) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.phase32 = new Float32Array(normalizedFlux.length);
    try {
      this.program(vertex, fragment);
      this.program(gridVertex, gridFragment);
      this.uniforms = {
        view: gl.getUniformLocation(this.programs[0], "view"),
        resolution: gl.getUniformLocation(this.programs[0], "resolution"),
        radius: gl.getUniformLocation(this.programs[0], "radius"),
        height: gl.getUniformLocation(this.programs[1], "height"),
        pixelRatio: gl.getUniformLocation(this.programs[1], "pixelRatio"),
      };
      this.vao = gl.createVertexArray();
      if (!this.vao) throw new Error("WebGL vertex array allocation failed");
      gl.bindVertexArray(this.vao);
      for (let i = 0; i < 2; i++) {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error("WebGL buffer allocation failed");
        this.buffers.push(buffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        if (i === 0)
          gl.bufferData(
            gl.ARRAY_BUFFER,
            this.phase32.byteLength,
            gl.DYNAMIC_DRAW,
          );
        else gl.bufferData(gl.ARRAY_BUFFER, normalizedFlux, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 1, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(i, 3);
      }
      // Check allocations once, never synchronously read pixels/errors per frame.
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("WebGL initialization failed");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private program(vs: string, fs: string) {
    const gl = this.gl;
    const p = gl.createProgram();
    if (!p) throw new Error("WebGL program allocation failed");
    this.programs.push(p);
    const compiled: WebGLShader[] = [];
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("WebGL shader allocation failed");
      this.shaders.push(shader);
      compiled.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(p, shader);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error("WebGL shader linking failed");
    for (const shader of compiled) {
      gl.detachShader(p, shader);
      gl.deleteShader(shader);
    }
    this.shaders = [];
  }
  resize(width: number, height: number, dpr: number) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(width * dpr)),
      h = Math.max(1, Math.round(height * dpr));
    const changed = this.canvas.width !== w || this.canvas.height !== h;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (changed && this.gl.getError() !== this.gl.NO_ERROR)
      throw new Error("WebGL resize failed");
  }
  draw(phases: Float64Array, view: FoldView) {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost())
      throw new Error("WebGL context lost");
    if (phases.length !== this.phase32.length)
      throw new Error("Phase buffer length mismatch");
    gl.bindVertexArray(this.vao);
    this.upload(phases);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    gl.useProgram(this.programs[1]);
    gl.uniform1f(this.uniforms.height, this.canvas.height);
    gl.uniform1f(this.uniforms.pixelRatio, this.dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.useProgram(this.programs[0]);
    gl.uniform2f(this.uniforms.view, view.zoom, view.center);
    gl.uniform2f(
      this.uniforms.resolution,
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform1f(
      this.uniforms.radius,
      (phases.length > 2000 ? 1.2 : 3) * this.dpr,
    );
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, phases.length * 3);
    gl.flush();
  }
  protected upload(phases: Float64Array) {
    const gl = this.gl;
    if (this.lastPhases !== phases) {
      this.phase32.set(phases);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[0]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.phase32);
      this.lastPhases = phases;
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    this.shaders.forEach((s) => gl.deleteShader(s));
    this.programs.forEach((p) => gl.deleteProgram(p));
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (!gl.isContextLost())
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.buffers = [];
    this.shaders = [];
    this.programs = [];
    this.vao = null;
    this.lastPhases = null;
  }
}

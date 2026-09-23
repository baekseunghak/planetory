import {
  mix,
  signalSeed,
  systemGeometry,
  type BodyPoint,
  type FocusRequest,
} from "./personal-system";

const quadVertex = `attribute vec2 position; uniform vec2 resolution; uniform vec4 rect; varying vec2 uv;
void main(){uv=position;vec2 p=rect.xy+position*rect.zw;gl_Position=vec4(p/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);}`;
const surfaceFragment = `precision highp float;
varying vec2 uv; uniform float star;uniform float seed;uniform float time;uniform float opacity;uniform vec2 rotation;
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec3(2.1,3.4,1.7);a*=.5;}return v;}
void main(){
 vec2 q=uv*1.3;float d=length(q);
 if(d>1.){float rim=exp(-(d-1.)*(star>.5?15.:48.));float a=(star>.5?.33:.10)*rim*opacity;if(d>1.3)discard;gl_FragColor=vec4(star>.5?vec3(1.,.37,.075):vec3(.25,.5,1.),a);return;}
 vec3 n=vec3(q.x,-q.y,sqrt(max(0.,1.-dot(q,q))));vec3 p=n;
 float ax=rotation.x+time*.012,ay=rotation.y*.4;
 p=vec3(p.x*cos(ax)+p.z*sin(ax),p.y,-p.x*sin(ax)+p.z*cos(ax));
 p=vec3(p.x,p.y*cos(ay)-p.z*sin(ay),p.y*sin(ay)+p.z*cos(ay));
 vec3 col;
 if(star>.5){
   float fire=fbm(p*13.+vec3(time*.025,0,0));float cells=noise(p*105.);
   col=mix(vec3(.85,.11,.015),vec3(1.,.77,.27),smoothstep(.25,.8,fire));
   col+=vec3(1.,.43,.08)*pow(cells,5.)*.26;
   col*=.52+.60*pow(n.z,.4);
 }else{
   vec3 warp=vec3(fbm(p*5.2+seed*17.),fbm(p*5.2+12.),fbm(p*5.2-7.));
   float belt=sin(p.y*40.+warp.x*10.+sin(p.x*5.)*1.5);
   float cloud=fbm(p*20.+warp*2.6);
   float fine=fbm(p*62.+warp);
   vec3 ocean=vec3(.10,.23,.37),ice=vec3(.78,.80,.77);
   if(seed>.68){ocean=vec3(.32,.19,.11);ice=vec3(.88,.77,.57);}else if(seed<.17){ocean=vec3(.12,.28,.27);ice=vec3(.65,.79,.77);}
   col=mix(ocean,ice,smoothstep(.25,.83,cloud*.75+belt*.15+.18));
   col*=.81+fine*.32;
   float light=max(0.,dot(n,normalize(vec3(-.72,.45,.65))));
   float terminator=smoothstep(-.15,.14,dot(n,normalize(vec3(-.72,.45,.65))));
   col*=.035+pow(light,.66)*.95*terminator;
   col+=vec3(.26,.46,.70)*pow(1.-n.z,4.)*light*.65;
 }
 float aa=1.-smoothstep(.996,1.,d);
 gl_FragColor=vec4(col,opacity*aa);
}`;
const backdropFragment = `precision highp float;varying vec2 uv;uniform vec2 resolution;uniform float opacity;uniform vec2 rotation;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){vec2 p=(uv*.5+.5)*resolution+rotation*45.;vec2 cell=floor(p/58.);vec2 point=fract(p/58.)-.12-.76*vec2(hash(cell),hash(cell+31.));float r=length(point);float light=exp(-r*r*15000.)*step(.55,hash(cell+5.));vec3 col=vec3(.001,.002,.005)+vec3(.48,.58,.75)*light*.6;gl_FragColor=vec4(col,opacity*.90);}`;
const lineVertex = `attribute vec2 position;uniform vec2 resolution;void main(){gl_Position=vec4(position/resolution*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);}`;
const lineFragment = `precision mediump float;uniform float opacity;void main(){gl_FragColor=vec4(.68,.65,.59,opacity*.35);}`;
function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const result = gl.createProgram()!;
  for (const [kind, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const s = gl.createShader(kind)!;
    const upgraded = source
      .replace(/attribute /g, "in ")
      .replace(/varying /g, kind === gl.VERTEX_SHADER ? "out " : "in ")
      .replace(/gl_FragColor/g, "fragmentColor");
    gl.shaderSource(
      s,
      "#version 300 es\n" +
        (kind === gl.FRAGMENT_SHADER
          ? "precision highp float; out vec4 fragmentColor;\n"
          : "") +
        upgraded,
    );
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) || "천체 셰이더 오류");
    gl.attachShader(result, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(result) || "천체 연결 오류");
  return result;
}
export class SystemRenderer {
  private surface: WebGLProgram;
  private backdrop: WebGLProgram;
  private orbit: WebGLProgram;
  private quad: WebGLBuffer;
  private lines: WebGLBuffer;
  private locations = new Map<
    WebGLProgram,
    Map<string, WebGLUniformLocation | null>
  >();
  private previous = new Map<string, BodyPoint>();
  private currentId = "";
  bodies: BodyPoint[] = [];
  drawCalls = 0;
  constructor(private gl: WebGL2RenderingContext) {
    this.surface = program(gl, quadVertex, surfaceFragment);
    this.backdrop = program(gl, quadVertex, backdropFragment);
    this.orbit = program(gl, lineVertex, lineFragment);
    this.quad = gl.createBuffer()!;
    this.lines = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
  }
  private uniform(p: WebGLProgram, n: string) {
    if (!this.locations.has(p)) this.locations.set(p, new Map());
    const map = this.locations.get(p)!;
    if (!map.has(n)) map.set(n, this.gl.getUniformLocation(p, n));
    return map.get(n)!;
  }
  private bind(p: WebGLProgram, b: WebGLBuffer, w: number, h: number) {
    const gl = this.gl;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    const attr = gl.getAttribLocation(p, "position");
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uniform(p, "resolution"), w, h);
  }
  draw(
    request: FocusRequest,
    w: number,
    h: number,
    center: { x: number; y: number },
    amount: number,
    time: number,
    dt: number,
    reduced: boolean,
  ) {
    this.drawCalls = 0;
    this.gl.bindVertexArray(null);
    const gl = this.gl,
      alpha = Math.min(1, amount * 2),
      model = systemGeometry(
        request.planets,
        request.view,
        w,
        h,
        center,
        Math.max(0.015, amount),
        1,
        reduced || request.view.body !== "system" ? 0 : time / 1000,
      );
    if (this.currentId !== request.id) {
      this.previous.clear();
      this.currentId = request.id;
    }
    const follow = reduced ? 1 : 1 - Math.exp(-dt / 85);
    this.bodies = model.bodies.map((b) => {
      const prev = this.previous.get(b.id);
      const next = prev
        ? {
            ...b,
            x: mix(prev.x, b.x, follow),
            y: mix(prev.y, b.y, follow),
            radius: mix(prev.radius, b.radius, follow),
          }
        : b;
      this.previous.set(b.id, next);
      return next;
    });
    for (const id of this.previous.keys())
      if (!this.bodies.some((b) => b.id === id)) this.previous.delete(id);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Existing galaxy and detailed bodies share this WebGL context and canvas.
    this.bind(this.backdrop, this.quad, w, h);
    gl.uniform4f(
      this.uniform(this.backdrop, "rect"),
      w / 2,
      h / 2,
      w / 2,
      h / 2,
    );
    gl.uniform1f(this.uniform(this.backdrop, "opacity"), amount);
    gl.uniform2f(
      this.uniform(this.backdrop, "rotation"),
      request.view.yaw,
      request.view.tilt,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.drawCalls++;
    if (model.lines.length) {
      this.bind(this.orbit, this.lines, w, h);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array(model.lines),
        gl.DYNAMIC_DRAW,
      );
      gl.uniform1f(
        this.uniform(this.orbit, "opacity"),
        amount * model.orbitOpacity,
      );
      gl.drawArrays(gl.LINES, 0, model.lines.length / 2);
      this.drawCalls++;
    }
    this.bind(this.surface, this.quad, w, h);
    gl.uniform1f(this.uniform(this.surface, "opacity"), alpha);
    gl.uniform1f(this.uniform(this.surface, "time"), reduced ? 0 : time / 1000);
    gl.uniform2f(
      this.uniform(this.surface, "rotation"),
      request.view.yaw,
      request.view.tilt,
    );
    for (const b of this.bodies) {
      if (
        b.x + b.radius * 1.3 < 0 ||
        b.x - b.radius * 1.3 > w ||
        b.y + b.radius * 1.3 < 0 ||
        b.y - b.radius * 1.3 > h
      )
        continue;
      gl.uniform4f(
        this.uniform(this.surface, "rect"),
        b.x,
        b.y,
        b.radius * 1.3,
        b.radius * 1.3,
      );
      gl.uniform1f(this.uniform(this.surface, "star"), b.star ? 1 : 0);
      gl.uniform1f(
        this.uniform(this.surface, "seed"),
        b.star ? signalSeed(request.id) : b.seed,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.drawCalls++;
    }
  }
  clear() {
    this.bodies = [];
    this.previous.clear();
    this.currentId = "";
  }
  destroy() {
    for (const p of [this.surface, this.backdrop, this.orbit])
      this.gl.deleteProgram(p);
    for (const b of [this.quad, this.lines]) this.gl.deleteBuffer(b);
    this.locations.clear();
    this.clear();
  }
}

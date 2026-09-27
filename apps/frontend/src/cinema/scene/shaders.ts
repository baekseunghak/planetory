// GLSL for the cinema scene. three.js ShaderMaterial prepends the usual
// matrices/cameraPosition and upgrades this GLSL1-style source to GLSL3.
// Colours are written as display values (the renderer outputs linear, no
// sRGB conversion), matching the real sky renderer.

/** Star points: galaxy stars, dust and far stars share it. */
export const starVertex = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aTwinkle;
uniform float uPix;
uniform float uTime;
uniform float uTwinkle;
uniform float uRef;
uniform float uAttMax;
uniform float uSizeScale;
uniform float uBrightness;
uniform vec3 uFocus;
uniform float uFocusRadius;
uniform float uFocusAmount;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(1e-4, -mv.z);
  float att = clamp(uRef / depth, 0.55, uAttMax);
  float hide = 0.0;
  if (uFocusAmount > 0.0) {
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    float d = distance(world, uFocus);
    hide = uFocusAmount * (1.0 - smoothstep(uFocusRadius * 0.35, uFocusRadius, d));
  }
  gl_PointSize = aSize * 1.5 * uPix * uSizeScale * pow(att, 0.55) * (1.0 - hide);
  float tw = mix(1.0, 0.86 + 0.14 * sin(uTime * 1.3 + aTwinkle), uTwinkle);
  vColor = aColor * tw * uBrightness;
  gl_Position = projectionMatrix * mv;
  if (gl_PointSize < 0.35) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

/** Same core as the real renderer: exp(-d*22) + exp(-d*4.5)*.22. */
export const starFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float i = exp(-r2 * 22.0) + exp(-r2 * 4.5) * 0.22;
  gl_FragColor = vec4(vColor * i * 0.95, 1.0);
}`;

/** Instanced camera-facing puffs for the nebula along the arms. */
export const nebulaVertex = /* glsl */ `
attribute vec3 iOffset;
attribute float iScale;
attribute vec3 iColor;
attribute float iAlpha;
uniform float uBrightness;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
  float dist = -mv.z;
  float fade = clamp((dist - 0.6) / 3.0, 0.0, 1.0);
  mv.xy += position.xy * iScale;
  vUv = position.xy * 2.0;
  vColor = iColor;
  vAlpha = iAlpha * fade * uBrightness;
  gl_Position = projectionMatrix * mv;
}`;
export const nebulaFragment = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float r = length(vUv);
  if (r >= 1.0 || vAlpha <= 0.0) discard;
  float g = r < 0.35 ? mix(1.0, 0.35, r / 0.35) : 0.35 * (1.0 - (r - 0.35) / 0.65);
  gl_FragColor = vec4(vColor, g * vAlpha);
}`;

/** Camera-facing quad sized by the object's world scale. */
export const billboardVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mv.xy += position.xy * scale;
  gl_Position = projectionMatrix * mv;
}`;
/** Soft glow: a hot core and an exponential halo, optional faint rays. */
export const glowFragment = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHalo;
uniform float uOpacity;
uniform float uCoreSharpness;
uniform float uHaloFalloff;
uniform float uRays;
uniform float uTime;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r >= 1.0 || uOpacity <= 0.0) discard;
  float core = exp(-r * r * uCoreSharpness);
  float halo = exp(-r * uHaloFalloff) * (1.0 - r);
  if (uRays > 0.0) {
    float a = atan(vUv.y, vUv.x);
    halo *= 1.0 + uRays * (0.5 + 0.5 * sin(a * 11.0 + uTime * 0.15) * sin(a * 5.0 - uTime * 0.1)) * smoothstep(0.1, 0.45, r);
  }
  vec3 col = uCore * core + uHalo * halo;
  // Dither the long, dark tail of the glow so 8-bit output does not band.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float alpha = clamp(core + halo + (n - 0.5) / 255.0, 0.0, 1.0) * uOpacity;
  gl_FragColor = vec4(col / max(0.001, core + halo), alpha);
}`;

/** Expanding shockwave in the galaxy plane (quad lies in its own XY). */
/** Last pass: add +-0.5 LSB of noise so dark gradients (bloom, glow) do not band. */
export const ditherShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(c.rgb + (n - 0.5) / 255.0, c.a);
}`,
};

export const ringVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
export const ringFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r >= 1.0 || uOpacity <= 0.0) discard;
  float edge = exp(-pow((r - 0.93) / 0.035, 2.0));
  float fill = 0.08 * smoothstep(0.2, 0.93, r) * step(r, 0.93);
  gl_FragColor = vec4(uColor, (edge + fill) * uOpacity);
}`;

/** Orbit line: solid, or dashed (32 dashes) for unconfirmed candidates. */
export const orbitVertex = /* glsl */ `
attribute float aU;
varying float vU;
void main() {
  vU = aU;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
export const orbitFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDashes;
varying float vU;
void main() {
  if (uOpacity <= 0.0) discard;
  if (uDashes > 0.5 && fract(vU * uDashes) > 0.5) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}`;

const noise3 = /* glsl */ `
float hash3(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm3(vec3 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise3(p);p=p*2.03+vec3(2.1,3.4,1.7);a*=.5;}return v;}`;

const simplex = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=mod289(i);
vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
float sfbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<5;i++){f+=a*snoise(p);p*=2.03;a*=0.5;}return f;}`;

export const bodyVertex = /* glsl */ `
varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vObject = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

/** Star surface: fbm granulation, deep red -> gold, limb darkening. */
export const sunFragment = /* glsl */ `
uniform float uTime;
uniform float uBright;
varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
${simplex}
${noise3}
void main() {
  vec3 p = normalize(vObject) * 3.2;
  float n = sfbm(p + vec3(0.0, uTime * 0.05, uTime * 0.03));
  float n2 = sfbm(p * 2.6 - vec3(uTime * 0.07));
  float heat = clamp(0.5 + 0.5 * n + 0.28 * n2, 0.0, 1.0);
  vec3 c = mix(vec3(0.85, 0.11, 0.015), vec3(1.0, 0.77, 0.27), smoothstep(0.2, 0.85, heat));
  c = mix(c, vec3(1.0, 0.92, 0.66), smoothstep(0.78, 1.0, heat));
  c += vec3(1.0, 0.43, 0.08) * pow(noise3(normalize(vObject) * 105.0), 5.0) * 0.26;
  vec3 v = normalize(cameraPosition - vWorld);
  float mu = clamp(dot(normalize(vNormalW), v), 0.0, 1.0);
  float limb = 0.3 + 0.7 * pow(mu, 0.55);
  gl_FragColor = vec4(c * limb * uBright * 1.08, 1.0);
}`;

/** Planet: palette by seed (ocean/ice, brown > .68, teal < .17), lit by the star. */
export const planetFragment = /* glsl */ `
uniform float uSeed;
uniform vec3 uLight;
uniform float uOpacity;
varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
${noise3}
void main() {
  vec3 p = normalize(vObject);
  vec3 warp = vec3(fbm3(p * 5.2 + uSeed * 17.0), fbm3(p * 5.2 + 12.0), fbm3(p * 5.2 - 7.0));
  float belt = sin(p.y * 40.0 + warp.x * 10.0 + sin(p.x * 5.0) * 1.5);
  float cloud = fbm3(p * 20.0 + warp * 2.6);
  float fine = fbm3(p * 62.0 + warp);
  vec3 ocean = vec3(0.10, 0.23, 0.37), ice = vec3(0.78, 0.80, 0.77);
  if (uSeed > 0.68) { ocean = vec3(0.32, 0.19, 0.11); ice = vec3(0.88, 0.77, 0.57); }
  else if (uSeed < 0.17) { ocean = vec3(0.12, 0.28, 0.27); ice = vec3(0.65, 0.79, 0.77); }
  vec3 col = mix(ocean, ice, smoothstep(0.25, 0.83, cloud * 0.75 + belt * 0.15 + 0.18));
  col *= 0.81 + fine * 0.32;
  vec3 n = normalize(vNormalW);
  vec3 l = normalize(uLight - vWorld);
  vec3 v = normalize(cameraPosition - vWorld);
  float ndl = dot(n, l);
  float light = max(0.0, ndl);
  col *= 0.035 + pow(light, 0.66) * 0.95 * smoothstep(-0.15, 0.14, ndl);
  float rim = pow(1.0 - max(0.0, dot(n, v)), 4.0);
  col += vec3(0.26, 0.46, 0.70) * rim * (light * 0.65 + 0.1);
  gl_FragColor = vec4(col, uOpacity);
}`;

/** Translucent accent body with a bright rim (ghost planet). */
export const ghostFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vObject;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  if (uOpacity <= 0.0) discard;
  vec3 v = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - max(0.0, dot(normalize(vNormalW), v)), 2.0);
  gl_FragColor = vec4(uColor, uOpacity * (0.3 + 0.7 * rim));
}`;

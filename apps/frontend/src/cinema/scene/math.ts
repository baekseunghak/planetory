// Pure scene math. No three.js and no DOM, so tests run in Node.
// World space: galaxy x -> world X, render z (depthZ * DEPTH_SCALE) -> world Y
// (up), galaxy y -> world Z, all times WORLD_SCALE. Seen from above this keeps
// the real renderer's handedness (galaxy +y is screen-down in the default view).
import { DEPTH_SCALE } from "../../features/sky-data/contracts";
import type { ViewInset } from "./contract";

export type Vec3 = [number, number, number];
/** Column-major 4x4 (three.js `Matrix4.elements`, WebGL order). */
export type Mat4 = ArrayLike<number>;

export const WORLD_SCALE = 0.01;
/** Real default camera (INITIAL_CAMERA in sky-renderer/model.ts). */
export const DEFAULT_VIEW = { yaw: 0.12, tilt: 1, roll: -0.28 } as const;
/** Real system view (INITIAL_SYSTEM in sky-renderer/personal-system.ts). */
export const SYSTEM_VIEW = { yaw: -0.28, tilt: 0.67 } as const;
export const BASE_FOV = 45;
export const HOVER_RADIUS_PX = 14;
export const CLICK_SLOP_PX = 5;
/** `projectPlanet(GHOST_PLANET_ID)` places a label on the analysis ghost planet. */
export const GHOST_PLANET_ID = "__ghost__";

// System sizes follow personal-system.ts (orbit 180 + 85i, planet 18 + 9 seed,
// star 56), scaled so the star is 4 galaxy units across its radius.
export const SYSTEM_UNIT = 0.04 / 56;
export const STAR_RADIUS = 56 * SYSTEM_UNIT;
export const orbitSlotRadius = (index: number) =>
  (180 + 85 * Math.max(0, index)) * SYSTEM_UNIT;
export const planetBodyRadius = (seed: number) =>
  (18 + clamp01(seed) * 9) * SYSTEM_UNIT;
/** Outer edge of a system with `count` planets, including the last body. */
export const systemRadius = (count: number) =>
  count > 0 ? orbitSlotRadius(count - 1) + 27 * SYSTEM_UNIT : STAR_RADIUS * 3.2;

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
export const clamp01 = (v: number) => clamp(Number.isFinite(v) ? v : 0, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function easeInOutCubic(k: number) {
  const t = clamp01(k);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
export const easeOutCubic = (k: number) => 1 - Math.pow(1 - clamp01(k), 3);
/** Frame-rate independent approach factor for `value += (target - value) * f`. */
export const approach = (rate: number, dt: number) =>
  1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));

export function starWorld(x: number, y: number, depthZ: number): Vec3 {
  return [x * WORLD_SCALE, depthZ * DEPTH_SCALE * WORLD_SCALE, y * WORLD_SCALE];
}

/** Unit vector from the target toward the camera for a real yaw/tilt pair. */
export function viewDirection(yaw: number, tilt: number): Vec3 {
  const st = Math.sin(tilt);
  return [Math.sin(yaw) * st, Math.cos(tilt), Math.cos(yaw) * st];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Camera axes for a camera looking back along `back` with world +Y up, then
 * rolled like three's `camera.rotateZ(roll)` (roll -0.28 turns the picture
 * counter-clockwise, as the real renderer's roll does).
 */
export function cameraBasis(back: Vec3, roll = 0) {
  const b = norm(back);
  let right = cross([0, 1, 0], b);
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0];
  right = norm(right);
  const up = cross(b, right);
  const c = Math.cos(roll),
    s = Math.sin(roll);
  return {
    back: b,
    right: [
      right[0] * c + up[0] * s,
      right[1] * c + up[1] * s,
      right[2] * c + up[2] * s,
    ] as Vec3,
    up: [
      up[0] * c - right[0] * s,
      up[1] * c - right[1] * s,
      up[2] * c - right[2] * s,
    ] as Vec3,
  };
}

/** Focal length in CSS px for a vertical field of view (camera.zoom = 1). */
export const focalPx = (heightPx: number, fovDeg = BASE_FOV) =>
  heightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);

/**
 * Camera distance so that every point fits inside `fill` of the free area.
 * Points are world positions; the camera sits at target + back * distance.
 */
export function fitDistance(
  points: readonly Vec3[],
  target: Vec3,
  basis: { back: Vec3; right: Vec3; up: Vec3 },
  focal: number,
  freeWidth: number,
  freeHeight: number,
  fill = 0.8,
) {
  const halfW = Math.max(1, freeWidth) * 0.5 * fill,
    halfH = Math.max(1, freeHeight) * 0.5 * fill;
  let distance = 0;
  for (const p of points) {
    const rel: Vec3 = [p[0] - target[0], p[1] - target[1], p[2] - target[2]];
    const x = Math.abs(dot(rel, basis.right)),
      y = Math.abs(dot(rel, basis.up)),
      z = dot(rel, basis.back);
    distance = Math.max(
      distance,
      z + (x * focal) / halfW,
      z + (y * focal) / halfH,
    );
  }
  return distance;
}

export type Bounds = { minX: number; maxX: number; minY: number; maxY: number };
/** The stored bounds with the whole normalized depth slab, in world space. */
export function boundsCorners(bounds: Bounds, depth = 1): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [bounds.minX, bounds.maxX])
    for (const y of [bounds.minY, bounds.maxY])
      for (const z of [-depth, depth]) out.push(starWorld(x, y, z));
  return out;
}
/**
 * Points the overview frames: an ellipse a little outside the one inscribed
 * in the stored bounds, at the depth band stars actually use. The spiral is
 * round, so box corners (and the full depth slab) would leave it small under
 * perspective; stars in the very corners may sit just past the 80% fill.
 */
export function boundsFramePoints(
  bounds: Bounds,
  steps = 32,
  spread = 1.12,
  depth = 0.2,
): Vec3[] {
  const cx = (bounds.minX + bounds.maxX) / 2,
    cy = (bounds.minY + bounds.maxY) / 2;
  const rx = Math.max(40, (bounds.maxX - bounds.minX) / 2) * spread,
    ry = Math.max(40, (bounds.maxY - bounds.minY) / 2) * spread;
  const out: Vec3[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    for (const z of [-depth, depth])
      out.push(starWorld(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, z));
  }
  return out;
}
export const boundsCenter = (bounds: Bounds): Vec3 =>
  starWorld(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    0,
  );

/** Resolved inset: numbers only, clamped so a free area always remains. */
export function resolveInset(inset: ViewInset, width: number, height: number) {
  const pick = (v: number | undefined, max: number) =>
    clamp(Number.isFinite(v) ? (v as number) : 0, 0, Math.max(0, max));
  const left = pick(inset.left, width - 80);
  const right = pick(inset.right, width - 80 - left);
  const top = pick(inset.top, height - 80);
  const bottom = pick(inset.bottom, height - 80 - top);
  return { top, right, bottom, left };
}

/**
 * Projection that centres the camera target in the area the panels leave
 * free, with the same pixel scale as the plain camera. Feed the result to
 * `camera.fov`, `camera.aspect` and `camera.setViewOffset(...)`.
 */
export function viewOffset(
  width: number,
  height: number,
  inset: ViewInset,
  baseFov = BASE_FOV,
) {
  const w = Math.max(1, width),
    h = Math.max(1, height);
  const r = resolveInset(inset, w, h);
  const dx = (r.left - r.right) / 2,
    dy = (r.top - r.bottom) / 2;
  const fullWidth = w + 2 * Math.abs(dx),
    fullHeight = h + 2 * Math.abs(dy);
  const fov =
    (Math.atan(Math.tan((baseFov * Math.PI) / 360) * (fullHeight / h)) * 360) /
    Math.PI;
  return {
    fov,
    aspect: fullWidth / fullHeight,
    fullWidth,
    fullHeight,
    offsetX: Math.abs(dx) - dx,
    offsetY: Math.abs(dy) - dy,
    width: w,
    height: h,
    /** Free area in CSS px (for framing). */
    free: {
      x: r.left,
      y: r.top,
      width: w - r.left - r.right,
      height: h - r.top - r.bottom,
    },
    shifted: Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5,
  };
}

export type Projected = {
  x: number;
  y: number;
  /** Clip w: distance along the view axis for a perspective camera. */
  depth: number;
  inFront: boolean;
  visible: boolean;
};
/** World point through a column-major view-projection matrix to CSS px. */
export function projectPoint(
  m: Mat4,
  px: number,
  py: number,
  pz: number,
  width: number,
  height: number,
): Projected {
  const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
  const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
  const cz = m[2] * px + m[6] * py + m[10] * pz + m[14];
  const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
  if (!(cw > 1e-9))
    return { x: NaN, y: NaN, depth: cw, inFront: false, visible: false };
  const x = ((cx / cw + 1) / 2) * width,
    y = ((1 - cy / cw) / 2) * height,
    z = cz / cw;
  return {
    x,
    y,
    depth: cw,
    inFront: true,
    visible: z >= -1 && z <= 1 && x >= 0 && x <= width && y >= 0 && y <= height,
  };
}

/**
 * Screen-space nearest star within `maxDistance` CSS px. `positions` holds
 * xyz triples; `skip(i)` hides stars (not yet ignited, focused away...).
 * Ties go to the star nearer to the camera.
 */
export function pickNearest(
  positions: ArrayLike<number>,
  count: number,
  m: Mat4,
  width: number,
  height: number,
  px: number,
  py: number,
  maxDistance = HOVER_RADIUS_PX,
  skip?: (index: number) => boolean,
): {
  index: number;
  distance: number;
  x: number;
  y: number;
  depth: number;
} | null {
  let best = -1,
    bestD2 = maxDistance * maxDistance,
    bestDepth = Infinity,
    bx = 0,
    by = 0;
  const m0 = m[0],
    m1 = m[1],
    m2 = m[2],
    m3 = m[3],
    m4 = m[4],
    m5 = m[5],
    m6 = m[6],
    m7 = m[7],
    m8 = m[8],
    m9 = m[9],
    m10 = m[10],
    m11 = m[11],
    m12 = m[12],
    m13 = m[13],
    m14 = m[14],
    m15 = m[15];
  const hw = width / 2,
    hh = height / 2;
  for (let i = 0; i < count; i++) {
    const o = i * 3,
      x = positions[o],
      y = positions[o + 1],
      z = positions[o + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (!(w > 1e-9)) continue;
    const nz = (m2 * x + m6 * y + m10 * z + m14) / w;
    if (nz < -1 || nz > 1) continue;
    const sx = ((m0 * x + m4 * y + m8 * z + m12) / w + 1) * hw;
    const sy = (1 - (m1 * x + m5 * y + m9 * z + m13) / w) * hh;
    const d2 = (sx - px) * (sx - px) + (sy - py) * (sy - py);
    // Within 1e-6 px² counts as a tie; the star nearer the camera wins.
    const tie = Math.abs(d2 - bestD2) <= 1e-6;
    if ((d2 > bestD2 && !tie) || (tie && w >= bestDepth)) continue;
    if (skip?.(i)) continue;
    best = i;
    bestD2 = d2;
    bestDepth = w;
    bx = sx;
    by = sy;
  }
  return best < 0
    ? null
    : {
        index: best,
        distance: Math.sqrt(bestD2),
        x: bx,
        y: by,
        depth: bestDepth,
      };
}

/** Circle hit test for bodies (planets): nearest edge within `pad` px. */
export function pickCircle(
  targets: readonly { x: number; y: number; radius: number; depth: number }[],
  px: number,
  py: number,
  pad = 8,
) {
  let best = -1,
    bestScore = Infinity,
    bestDepth = Infinity;
  targets.forEach((t, i) => {
    const d = Math.hypot(t.x - px, t.y - py);
    if (d > t.radius + pad) return;
    const score = Math.max(0, d - t.radius);
    if (score < bestScore || (score === bestScore && t.depth < bestDepth)) {
      best = i;
      bestScore = score;
      bestDepth = t.depth;
    }
  });
  return best;
}

/** Point sprite size in CSS px; same formula as the star vertex shader. */
export function starPointCss(
  baseSize: number,
  viewportHeight: number,
  referenceDistance: number,
  depth: number,
  maxAttenuation = 6,
) {
  const attenuation = clamp(
    referenceDistance / Math.max(1e-6, depth),
    0.55,
    maxAttenuation,
  );
  return (
    baseSize *
    1.5 *
    clamp(viewportHeight / 836, 0.8, 1.6) *
    Math.pow(attenuation, 0.55)
  );
}
/**
 * Point size factor for dense galaxies. Additive halos (and bloom) would
 * saturate 100k stars into a white sheet, so points shrink with the star
 * count at the overview and grow back as the camera approaches, on the same
 * log-zoom smoothstep as galaxyExposure() in sky-renderer/exposure.ts.
 */
export function densityScale(starCount: number, zoom: number) {
  const base = clamp(
    Math.pow(1000 / Math.max(1000, starCount || 0), 0.16),
    0.45,
    1,
  );
  const t = clamp01(Math.log(Math.max(1, zoom || 0)) / Math.log(6));
  return base + (1 - base) * t * t * (3 - 2 * t);
}
/** Bloom strength factor for dense galaxies (overview only matters). */
export const densityBloom = (starCount: number) =>
  clamp(Math.pow(1000 / Math.max(1000, starCount || 0), 0.12), 0.5, 1);

/** Hit radius of a star point: the bright core, never below 6 px. */
export const starHitRadius = (pointCss: number) => Math.max(6, pointCss * 0.3);

/** Apparent radius in CSS px of a sphere of `radius` at view depth `depth`. */
export const sphereScreenRadius = (
  radius: number,
  depth: number,
  focal: number,
) => (depth > 1e-9 ? (radius * focal) / depth : 0);

// ---------- planets and orbits (personal-system.ts) ----------

export type PlanetPalette = "ocean" | "brown" | "teal";
export const planetPalette = (seed: number): PlanetPalette =>
  seed > 0.68 ? "brown" : seed < 0.17 ? "teal" : "ocean";

/** Angular speed in rad/s: 0.32 / sqrt(period), period clamped like the 2D view. */
export const orbitSpeed = (periodDays: number | null) =>
  0.32 / Math.sqrt(Math.max(0.4, periodDays ?? 1));
export const orbitAngle = (
  index: number,
  seed: number,
  periodDays: number | null,
  seconds: number,
) => 0.75 + index * 2.13 + seed * 0.7 + seconds * orbitSpeed(periodDays);

/**
 * Ghost orbit scale k in `r = k * P^(2/3)` (Kepler's third law). Planets with
 * a known period anchor it (log mean over their slots), so the ghost lines up
 * with the orbits already drawn; otherwise the next free slot is ~10 days.
 */
export function ghostScale(
  planets: readonly { periodDays: number | null; radius: number }[],
  nextSlotRadius: number,
  defaultPeriod = 10,
) {
  const known = planets.filter(
    (p) => p.periodDays !== null && p.periodDays > 0 && p.radius > 0,
  );
  if (!known.length) return nextSlotRadius / Math.pow(defaultPeriod, 2 / 3);
  const logK =
    known.reduce(
      (sum, p) => sum + Math.log(p.radius) - (2 / 3) * Math.log(p.periodDays!),
      0,
    ) / known.length;
  return Math.exp(logK);
}
export function ghostRadius(
  periodDays: number,
  scale: number,
  min = STAR_RADIUS * 1.7,
  max = orbitSlotRadius(12),
) {
  if (!(periodDays > 0) || !(scale > 0)) return min;
  return clamp(scale * Math.pow(periodDays, 2 / 3), min, max);
}
/**
 * Ghost orbit radius as drawn: Kepler radius with a soft floor, so short
 * periods clear the star's corona instead of vanishing inside it. Far above
 * the floor it stays on the Kepler radius (an orbit with a known period
 * still lines up); near it, radii keep their order but never fall below it.
 */
export function ghostDisplayRadius(
  periodDays: number,
  scale: number,
  floor: number,
  max: number,
) {
  const top = Math.max(floor, max);
  if (!(periodDays > 0) || !(scale > 0)) return floor;
  const kepler = scale * Math.pow(periodDays, 2 / 3);
  const soft = Math.pow(kepler ** 4 + floor ** 4, 1 / 4);
  return clamp(soft, floor, top);
}
/** Softest ghost radius: clear of the corona of the (shrunk) analysis star. */
export const GHOST_FLOOR = STAR_RADIUS * 1.55;
/** The star is drawn smaller in analysis so the ghost orbit reads. */
export const ANALYSIS_STAR_SCALE = 0.72;
/** Faint for weak powers; only strong peaks glow (strength^4). */
export const ghostOpacity = (strength: number) =>
  0.05 + 0.85 * Math.pow(clamp01(strength), 4);

// ---------- transit ----------

/** Area of the lens where two circles (radii R, r, centres d apart) overlap. */
export function circleOverlapArea(R: number, r: number, d: number) {
  if (!(R > 0) || !(r > 0)) return 0;
  const dist = Math.abs(d);
  if (dist >= R + r) return 0;
  if (dist <= Math.abs(R - r)) return Math.PI * Math.min(R, r) ** 2;
  const a =
    r *
    r *
    Math.acos(clamp((dist * dist + r * r - R * R) / (2 * dist * r), -1, 1));
  const b =
    R *
    R *
    Math.acos(clamp((dist * dist + R * R - r * r) / (2 * dist * R), -1, 1));
  const c =
    0.5 *
    Math.sqrt(
      Math.max(
        0,
        (-dist + r + R) * (dist + r - R) * (dist - r + R) * (dist + r + R),
      ),
    );
  return a + b - c;
}
/** Share of the planet's disc that lies on the star, 0..1. */
export const transitCoverage = (R: number, r: number, d: number) =>
  r > 0 ? clamp01(circleOverlapArea(R, r, d) / (Math.PI * r * r)) : 0;
/** Share of the stellar disc that is covered, 0..1. */
export const coveredFraction = (R: number, r: number, d: number) =>
  R > 0 ? clamp01(circleOverlapArea(R, r, d) / (Math.PI * R * R)) : 0;
/** Linear limb darkening, 1 at the disc centre and 1-u at the edge. */
export const limbWeight = (rho: number, u = 0.6) =>
  1 - u * (1 - Math.sqrt(1 - clamp01(rho) ** 2));
/**
 * Relative flux reported to the UI. At full coverage near the centre it equals
 * 1 - depth, so the live curve matches the depth the member measured.
 */
export const transitFlux = (depth: number, coverage: number, rho = 0) =>
  1 -
  Math.max(0, Number.isFinite(depth) ? depth : 0) *
    clamp01(coverage) *
    limbWeight(rho);
/** Drawn star brightness: the covered area, exaggerated so the dip is seen. */
export const transitBrightness = (covered: number, gain = 7) =>
  1 - clamp(clamp01(covered) * gain, 0, 0.55);
/** Planet radius drawn for the transit (true sqrt(depth), exaggerated). */
export const transitPlanetRadius = (depth: number, starRadius = STAR_RADIUS) =>
  starRadius * clamp(Math.sqrt(Math.max(0, depth || 0)) * 2, 0.12, 0.28);
/** Half the orbital angle the pass needs so the planet starts and ends off the disc. */
export const transitHalfAngle = (orbit: number, star: number, planet: number) =>
  Math.asin(clamp((1.9 * (star + planet)) / Math.max(orbit, 1e-9), 0, 0.95));
/**
 * Offset from the camera direction at pass fraction t (0..1). The pass runs
 * from +half to -half: with `right = up x back`, that is the direction the
 * system's orbits turn (orbitAngle grows), so the discovered planet can keep
 * going along its orbit when the pass ends.
 */
export const transitTheta = (half: number, t: number) =>
  half - 2 * half * clamp01(t);

// ---------- flights ----------

/**
 * Middle control point of a curved flight: sideways by `arc` and up by `lift`,
 * both relative to the flight length.
 */
export function arcMidpoint(
  from: Vec3,
  to: Vec3,
  arc: number,
  lift: number,
): Vec3 {
  const dir: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const length = Math.hypot(...dir);
  let side = cross(dir, [0, 1, 0]);
  if (Math.hypot(...side) < 1e-9) side = [1, 0, 0];
  side = norm(side);
  return [
    (from[0] + to[0]) / 2 + side[0] * length * arc,
    (from[1] + to[1]) / 2 + side[1] * length * arc + length * lift,
    (from[2] + to[2]) / 2 + side[2] * length * arc,
  ];
}

/**
 * Software WebGL (Chromium's SwiftShader, Mesa llvmpipe/softpipe, Windows'
 * Basic Render Driver). These draw the full scene at a few frames a second,
 * which also stalls the page's input, so the engine takes its cheap path.
 */
export function isSoftwareRenderer(name: string | null | undefined): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(
    name ?? "",
  );
}
/** Pixel ratio for the cheap path: a quarter of the pixels at DPR 1. */
export const LOW_POWER_DPR = 0.5;

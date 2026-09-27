// Seeded decoration. None of this is member data: it only fills the intro
// before stars arrive and adds haze along the personal-spiral-v1 arms.
import { DEPTH_SCALE } from "../../features/sky-data/contracts";
import { clamp, starWorld, type Vec3 } from "./math";

/** mulberry32 */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (random: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(1e-5, random()))) *
  Math.cos(2 * Math.PI * random());

/** Angle of spiral arm `arm` (0..3) at `radius` galaxy units, personal-spiral-v1. */
export const armAngle = (arm: number, radius: number) =>
  (arm * Math.PI) / 2 + Math.pow(Math.max(0, radius) / 1200, 0.7) * 5.6;

/**
 * Decorative star in the personal-spiral-v1 shape (same distribution as the
 * layout reference). Used for the anonymous intro only, never for members.
 */
export function decorativeStar(ordinal: number) {
  let seed = Math.imul(ordinal + 71, 2654435761) >>> 0;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let x: number, y: number, z: number;
  if (ordinal % 10 < 2) {
    x = gaussian(random) * 122;
    y = gaussian(random) * 112;
    z = gaussian(random) * 45;
  } else {
    const radius = 85 + Math.pow(random(), 0.72) * 1140;
    const theta =
      ordinal % 7 === 0
        ? random() * Math.PI * 2
        : armAngle(ordinal % 4, radius) +
          gaussian(random) * (0.075 + radius / 17000);
    const spread = gaussian(random) * (ordinal % 9 === 0 ? 115 : 26);
    x = Math.cos(theta) * (radius + spread);
    y = Math.sin(theta) * (radius + spread);
    z = gaussian(random) * (10 + 19 * (1 - radius / 1350));
  }
  return {
    x,
    y,
    depthZ: clamp(z / DEPTH_SCALE, -1, 1),
    layoutOrdinal: ordinal,
  };
}

export type Puff = {
  position: Vec3;
  scale: number;
  color: Vec3;
  alpha: number;
};

/**
 * Faint nebula puffs along the four arms plus a warm core, in world units.
 * Alphas are low on purpose: the haze should read as depth, not as clouds.
 */
export function nebulaPuffs(count = 360, seed = 99): Puff[] {
  const random = seeded(seed);
  const out: Puff[] = [];
  for (let i = 0; i < count; i++) {
    const arm = i % 4,
      radius = 110 + Math.pow(random(), 0.85) * 1080;
    const theta =
      armAngle(arm, radius) + gaussian(random) * (0.09 + radius / 14000);
    const spread = gaussian(random) * 55;
    const x = Math.cos(theta) * (radius + spread),
      y = Math.sin(theta) * (radius + spread),
      z = gaussian(random) * 14;
    const warm = clamp(1 - radius / 520, 0, 1);
    const cool = random() < 0.18 ? [0.62, 0.45, 1] : [0.36, 0.5, 1];
    out.push({
      position: starWorld(x, y, z / DEPTH_SCALE),
      scale: (1.1 + random() * 2.6) * (1 + 0.4 * (radius / 1200)),
      color: [
        cool[0] * (1 - warm) + warm,
        cool[1] * (1 - warm) + 0.66 * warm,
        cool[2] * (1 - warm) + 0.38 * warm,
      ],
      alpha: (0.018 + random() * 0.032) * (1 - 0.6 * warm),
    });
  }
  for (let i = 0; i < 40; i++)
    out.push({
      position: [
        gaussian(random) * 1.2,
        gaussian(random) * 0.3,
        gaussian(random) * 1.1,
      ],
      scale: 1.5 + random() * 2.5,
      color: [1, 0.72, 0.45],
      alpha: 0.01 + random() * 0.012,
    });
  out.push({
    position: [0, 0, 0],
    scale: 7,
    color: [1, 0.78, 0.52],
    alpha: 0.1,
  });
  return out;
}

/** Fine dust grains hugging the arms (tiny, very faint points). */
export function dustGrains(count = 5200, seed = 7) {
  const random = seeded(seed);
  const position = new Float32Array(count * 3),
    color = new Float32Array(count * 3),
    size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const arm = i % 4,
      radius = 140 + Math.pow(random(), 0.8) * 1100;
    const theta =
      armAngle(arm, radius) + 0.12 + gaussian(random) * (0.06 + radius / 20000);
    const spread = gaussian(random) * 34;
    const p = starWorld(
      Math.cos(theta) * (radius + spread),
      Math.sin(theta) * (radius + spread),
      (gaussian(random) * 8) / DEPTH_SCALE,
    );
    position.set(p, i * 3);
    const k = 0.1 + random() * 0.12;
    color.set([k * 0.8, k * 0.88, k], i * 3);
    size[i] = 0.9 + random() * 1.4;
  }
  return { position, color, size };
}

/** Far stars on a sphere that follows the camera (always "at infinity"). */
export function backgroundStars(count = 2600, seed = 11, radius = 320) {
  const random = seeded(seed);
  const position = new Float32Array(count * 3),
    color = new Float32Array(count * 3),
    size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = random() * 2 - 1,
      theta = random() * Math.PI * 2,
      r = radius + random() * 80,
      q = Math.sqrt(1 - u * u);
    position.set(
      [r * q * Math.cos(theta), r * u, r * q * Math.sin(theta)],
      i * 3,
    );
    const k = 0.25 + random() * 0.45;
    color.set([k * 0.85, k * 0.9, k], i * 3);
    size[i] = 1.2 + Math.pow(random(), 3) * 2.4;
  }
  return { position, color, size };
}

/** Stable 0..2π twinkle phase for a layout ordinal. */
export const twinklePhase = (ordinal: number) =>
  ((Math.imul(ordinal + 1, 2654435761) >>> 0) / 4294967296) * Math.PI * 2;

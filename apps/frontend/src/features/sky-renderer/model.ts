import {
  SkyContractError,
  readPersonalDetailProjection,
  type SkyMeta,
  type Star,
  type PersonalDetailProjection,
} from "../sky-data/contracts.ts";
import {
  galaxyMatrix,
  transform,
  type Matrix,
  type GalaxyCamera,
} from "../sky-data/geometry.ts";
export type { GalaxyCamera } from "../sky-data/geometry.ts";
export const INITIAL_CAMERA: GalaxyCamera = {
  x: 0,
  y: 0,
  zoom: 1,
  yaw: 0.12,
  tilt: 1,
  roll: -0.28,
};
export const ORBIT_COLOR = "#8d96a6";
export const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
// personal-galaxy-v1: appearance only. Stored positions are never regenerated here.
export function starStyle(s: Pick<Star, "x" | "y" | "layoutOrdinal">) {
  const ordinal = s.layoutOrdinal;
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 2147483647)
    throw new SkyContractError("안정된 별 순번이 필요합니다.");
  let seed = Math.imul(ordinal + 71, 2654435761) >>> 0;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const draws = ordinal % 10 < 2 || ordinal % 7 === 0 ? 6 : 7;
  for (let i = 0; i < draws; i++) random();
  const baseSize = ordinal < 6 ? 6.5 : 3.2 + Math.pow(random(), 4) * 5.5;
  const warmth = Math.max(0, Math.min(1, 1 - Math.hypot(s.x, s.y) / 420));
  const variation = ((ordinal * 17) % 101) / 100;
  const cold =
    variation < 0.13
      ? [0.89, 0.72, 1]
      : [0.48 + variation * 0.24, 0.66 + variation * 0.15, 1];
  const warm = [1, 0.72, 0.44];
  return {
    rgb: cold.map((c, i) => c * (1 - warmth) + warm[i] * warmth),
    baseSize,
  };
}
export const cameraMatrix = galaxyMatrix;
export function screenPoint(
  matrix: Matrix,
  width: number,
  height: number,
  x: number,
  y: number,
  z = 0,
) {
  const p = transform(matrix, { x, y, z });
  return {
    x: ((p.x + 1) * width) / 2,
    y: ((1 - p.y) * height) / 2,
    depth: p.z,
  };
}
// Whole-view framing uses stored bounds, including the entire normalized-depth slab.
export function initialCamera(
  meta: SkyMeta,
  width: number,
  height: number,
): GalaxyCamera {
  const base = { ...INITIAL_CAMERA };
  if (meta.starCount === 0) return base;
  const m = cameraMatrix(base, 3100, 2020),
    b = meta.bounds;
  const points = [];
  for (const x of [b.minX, b.maxX])
    for (const y of [b.minY, b.maxY])
      for (const z of [-1, 1]) {
        const p = screenPoint(m, 3100, 2020, x, y, z);
        points.push({ x: p.x - 1550, y: p.y - 2020 * 0.46 });
      }
  const minX = Math.min(...points.map((p) => p.x)),
    maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y)),
    maxY = Math.max(...points.map((p) => p.y));
  const scale = Math.min(width / 3100, height / 2020);
  return {
    ...base,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(
      0.001,
      Math.min(
        1.5,
        (width * 0.8) / (Math.max(1, maxX - minX) * scale),
        (height * 0.8) / (Math.max(1, maxY - minY) * scale),
      ),
    ),
  };
}
export type RenderPlan = { stars: Star[] };
export function renderPlan(
  stars: readonly Star[],
  matrix: Matrix,
  width: number,
  height: number,
): RenderPlan {
  // Culling only at data/camera changes. No star-count cap and no per-frame input scan.
  return {
    stars: stars.filter((s) => {
      const p = screenPoint(matrix, width, height, s.x, s.y, s.depthZ);
      return (
        Math.abs(p.depth) <= 1 &&
        p.x >= -80 &&
        p.x <= width + 80 &&
        p.y >= -80 &&
        p.y <= height + 80
      );
    }),
  };
}
export type OwnedPlanet = PersonalDetailProjection["planets"]["items"][number];
export type OwnedSystem = Omit<PersonalDetailProjection, "planets"> & {
  items: OwnedPlanet[];
};
export function readOwnedSystem(
  value: unknown,
  meta: SkyMeta,
  expectedTicId: string,
  loadedStar?: Star,
): OwnedSystem {
  const { planets, ...detail } = readPersonalDetailProjection(
    value,
    meta,
    expectedTicId,
    loadedStar,
  );
  return { ...detail, items: planets.items };
}
export function stablePhase(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

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
export type RenderPlan = {
  stars: Star[];
  // Ordered spans of the immutable source: reuse packed attributes when only
  // the camera changes. This is CPU culling, never a cluster or a count limit.
  spans?: { source: readonly Star[]; ranges: [number, number][] };
};
type BoundsNode = {
  start: number;
  end: number;
  min: number[];
  max: number[];
  children?: [BoundsNode, BoundsNode];
};
const trees = new WeakMap<readonly Star[], BoundsNode>();
function boundsTree(
  stars: readonly Star[],
  start = 0,
  end = stars.length,
): BoundsNode {
  const node: BoundsNode = {
    start,
    end,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  if (end - start > 128) {
    const middle = (start + end) >>> 1;
    node.children = [
      boundsTree(stars, start, middle),
      boundsTree(stars, middle, end),
    ];
    for (let axis = 0; axis < 3; axis++) {
      node.min[axis] = Math.min(...node.children.map((n) => n.min[axis]));
      node.max[axis] = Math.max(...node.children.map((n) => n.max[axis]));
    }
  } else {
    for (let i = start; i < end; i++) {
      const s = stars[i],
        values = [s.x, s.y, s.depthZ];
      for (let axis = 0; axis < 3; axis++) {
        node.min[axis] = Math.min(node.min[axis], values[axis]);
        node.max[axis] = Math.max(node.max[axis], values[axis]);
      }
    }
  }
  return node;
}
// A conservative bounds check skips per-star projection when the entire loaded set
// is visible. Immutable store snapshots make the weak cache safe and reclaimable.
const boundsCache = new WeakMap<
  readonly Star[],
  { x: [number, number]; y: [number, number]; z: [number, number] }
>();
export function renderPlan(
  stars: readonly Star[],
  matrix: Matrix,
  width: number,
  height: number,
): RenderPlan {
  let bounds = boundsCache.get(stars);
  if (!bounds && stars.length) {
    bounds = {
      x: [Infinity, -Infinity],
      y: [Infinity, -Infinity],
      z: [Infinity, -Infinity],
    };
    for (const s of stars) {
      bounds.x[0] = Math.min(bounds.x[0], s.x);
      bounds.x[1] = Math.max(bounds.x[1], s.x);
      bounds.y[0] = Math.min(bounds.y[0], s.y);
      bounds.y[1] = Math.max(bounds.y[1], s.y);
      bounds.z[0] = Math.min(bounds.z[0], s.depthZ);
      bounds.z[1] = Math.max(bounds.z[1], s.depthZ);
    }
    boundsCache.set(stars, bounds);
  }
  // The application uses an affine projection. Perspective matrices use the exact path.
  if (
    bounds &&
    matrix[3] === 0 &&
    matrix[7] === 0 &&
    matrix[11] === 0 &&
    matrix[15] === 1
  ) {
    let allVisible = true;
    for (const x of bounds.x)
      for (const y of bounds.y)
        for (const z of bounds.z) {
          const p = screenPoint(matrix, width, height, x, y, z);
          if (
            Math.abs(p.depth) > 1 ||
            p.x < -80 ||
            p.x > width + 80 ||
            p.y < -80 ||
            p.y > height + 80
          )
            allVisible = false;
        }
    if (allVisible) return { stars: stars as Star[] };
  }
  if (
    stars.length &&
    matrix[3] === 0 &&
    matrix[7] === 0 &&
    matrix[11] === 0 &&
    matrix[15] === 1
  ) {
    let root = trees.get(stars);
    if (!root) {
      root = boundsTree(stars);
      trees.set(stars, root);
    }
    const ranges: [number, number][] = [],
      visible: Star[] = [];
    const low = [-1 - 160 / width, -1 - 160 / height, -1];
    const high = [1 + 160 / width, 1 + 160 / height, 1];
    const append = (start: number, end: number) => {
      const last = ranges.at(-1);
      if (last?.[1] === start) last[1] = end;
      else ranges.push([start, end]);
      for (let i = start; i < end; i++) visible.push(stars[i]);
    };
    const visit = (node: BoundsNode) => {
      let inside = true;
      for (let axis = 0; axis < 3; axis++) {
        let min = matrix[12 + axis],
          max = min;
        for (let world = 0; world < 3; world++) {
          const a = matrix[world * 4 + axis] * node.min[world];
          const b = matrix[world * 4 + axis] * node.max[world];
          min += Math.min(a, b);
          max += Math.max(a, b);
        }
        // Keep a conservative tolerance at the bounds; exact leaf checks below
        // preserve the existing 80px/depth edges despite floating-point sums.
        if (min > high[axis] + 1e-10 || max < low[axis] - 1e-10) return;
        if (min < low[axis] + 1e-10 || max > high[axis] - 1e-10) inside = false;
      }
      if (inside) append(node.start, node.end);
      else if (node.children) node.children.forEach(visit);
      else {
        for (let i = node.start; i < node.end; i++) {
          const s = stars[i],
            p = screenPoint(matrix, width, height, s.x, s.y, s.depthZ);
          if (
            Math.abs(p.depth) <= 1 &&
            p.x >= -80 &&
            p.x <= width + 80 &&
            p.y >= -80 &&
            p.y <= height + 80
          )
            append(i, i + 1);
        }
      }
    };
    visit(root);
    return { stars: visible, spans: { source: stars, ranges } };
  }
  // Perspective matrices retain the exact projection path.
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
  // Avalanche adjacent candidate IDs so planets do not line up on the same angle.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

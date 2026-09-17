import {
  SkyContractError,
  type Cluster,
  type SkyMeta,
  type Star,
} from "./contracts.ts";
import { orthographicMatrix, transform, type Matrix } from "./geometry.ts";

export const RENDER_BUDGET = {
  stars: 400,
  orbitStars: 60,
  clusters: 80,
} as const;
export const STAR_COLORS = [
  "#d9dcff",
  "#b7a6ff",
  "#8fbfff",
  "#9be7d6",
  "#f6c9ea",
] as const;
export const COMPLETE_COLOR = "#f1cfa3";
export const ORBIT_COLOR = "#8d96a6";
export const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
export function starStyle(s: Star) {
  const level = Math.min(4, s.planetCount);
  if (s.colorLevel !== level || s.sizeLevel !== level)
    throw new SkyContractError(
      "행성 수와 별의 색/크기 단계가 일치하지 않습니다.",
    );
  return {
    color: s.completedWithoutPlanets ? COMPLETE_COLOR : STAR_COLORS[level],
    radius: 2.4 + level * 0.85,
  };
}
export function clusterColor(c: Cluster) {
  const colors = [
    rgb(STAR_COLORS[1]),
    rgb(COMPLETE_COLOR),
    rgb(STAR_COLORS[0]),
  ];
  return colors[0].map(
    (_, i) =>
      (colors[0][i] * c.counts.planet +
        colors[1][i] * c.counts.done +
        colors[2][i] * c.counts.new) /
      c.count,
  );
}
export type GalaxyCamera = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  tilt: number;
  roll: number;
};
export function initialCamera(
  meta: SkyMeta,
  width: number,
  height: number,
): GalaxyCamera {
  const b = meta.bounds;
  return {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
    scale:
      Math.min(
        width / Math.max(400, b.maxX - b.minX),
        height / Math.max(400, b.maxY - b.minY),
      ) * 0.72,
    rotation: 0.12,
    tilt: 0.78,
    roll: -0.28,
  };
}
export function cameraMatrix(
  c: GalaxyCamera,
  width: number,
  height: number,
): Matrix {
  if (
    ![...Object.values(c), width, height].every(Number.isFinite) ||
    c.scale <= 0 ||
    width <= 0 ||
    height <= 0 ||
    Math.abs(c.tilt) > 1.42
  )
    throw new SkyContractError("카메라 크기/배율/기울기가 유효하지 않습니다.");
  // Normalized depth is expanded only in this projection, never in the source DTO.
  const m = [
    ...orthographicMatrix(
      c,
      width,
      height,
      160,
      Math.max(1e6, Math.abs(c.x) + Math.abs(c.y)) * 4,
    ),
  ];
  const cr = Math.cos(c.roll),
    sr = Math.sin(c.roll);
  for (let col = 0; col < 4; col++) {
    const x = m[col * 4],
      y = m[col * 4 + 1];
    m[col * 4] = cr * x + (sr * y * height) / width;
    m[col * 4 + 1] = (-sr * x * width) / height + cr * y;
  }
  return m;
}
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
export type VisibleCluster = { node: Cluster; rx: number; ry: number };
export type RenderPlan = {
  stars: Star[];
  clusters: VisibleCluster[];
  orbitStars: Star[];
  overflow: string | null;
};
export function renderPlan(
  stars: readonly Star[],
  clusters: readonly Cluster[],
  matrix: Matrix,
  width: number,
  height: number,
): RenderPlan {
  // Runs only when camera/received nodes change. draw() never traverses this input.
  const visibleStars = stars.filter((s) => {
    const p = screenPoint(matrix, width, height, s.x, s.y, s.depthZ);
    return (
      Math.abs(p.depth) <= 1 &&
      p.x >= -48 &&
      p.x <= width + 48 &&
      p.y >= -48 &&
      p.y <= height + 48
    );
  });
  visibleStars.forEach(starStyle);
  const visibleClusters: VisibleCluster[] = [];
  for (const c of clusters) {
    const center = screenPoint(matrix, width, height, c.x, c.y);
    let rx = 0,
      ry = 0;
    for (const x of [c.bounds.x, c.bounds.x + c.bounds.w])
      for (const y of [c.bounds.y, c.bounds.y + c.bounds.h])
        for (const z of [-1, 1]) {
          const p = screenPoint(matrix, width, height, x, y, z);
          rx = Math.max(rx, Math.abs(p.x - center.x));
          ry = Math.max(ry, Math.abs(p.y - center.y));
        }
    rx = Math.max(14, rx);
    ry = Math.max(14, ry);
    if (
      center.x + rx >= 0 &&
      center.x - rx <= width &&
      center.y + ry >= 0 &&
      center.y - ry <= height
    )
      visibleClusters.push({ node: c, rx, ry });
  }
  const orbitStars = visibleStars.filter((s) => s.planetCount > 0);
  const overflow =
    visibleStars.length > RENDER_BUDGET.stars
      ? "별 400개"
      : orbitStars.length > RENDER_BUDGET.orbitStars
        ? "궤도 표시 별 60개"
        : visibleClusters.length > RENDER_BUDGET.clusters
          ? "성운 80개"
          : null;
  return {
    stars: visibleStars,
    clusters: visibleClusters,
    orbitStars,
    overflow,
  };
}

export type OwnedPlanet = {
  candidateId: string;
  kind: "confirmed" | "unconfirmed";
  periodDays: number | null;
  depthPpm: number | null;
};
export type OwnedSystem = {
  ticId: string;
  position: { x: number; y: number; depthZ: number };
  completedWithoutPlanets: boolean;
  items: OwnedPlanet[];
};
export function readOwnedSystem(value: unknown): OwnedSystem {
  if (!value || typeof value !== "object")
    throw new SkyContractError("별 상세 객체가 필요합니다.");
  const v = value as Record<string, any>,
    p = v.unlock?.position,
    planets = v.planets;
  if (
    typeof v.ticId !== "string" ||
    !v.ticId ||
    !p ||
    ![p.x, p.y, p.depthZ].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    ) ||
    Math.abs(p.depthZ) > 1 ||
    !planets ||
    !Array.isArray(planets.items) ||
    planets.count !== planets.items.length ||
    typeof planets.completedWithoutPlanets !== "boolean"
  )
    throw new SkyContractError("별 상세 좌표/행성 수가 유효하지 않습니다.");
  const ids = new Set<string>();
  const items: OwnedPlanet[] = planets.items.map((item: any) => {
    if (
      !item ||
      typeof item.candidateId !== "string" ||
      !item.candidateId ||
      ids.has(item.candidateId) ||
      !["confirmed", "unconfirmed"].includes(item.kind)
    )
      throw new SkyContractError("내 행성 식별자/종류/중복을 확인해 주세요.");
    ids.add(item.candidateId);
    for (const key of ["periodDays", "depthPpm"])
      if (
        item[key] !== null &&
        (typeof item[key] !== "number" ||
          !Number.isFinite(item[key]) ||
          item[key] < 0 ||
          (key === "periodDays" && item[key] === 0))
      )
        throw new SkyContractError("행성 수치가 유효하지 않습니다.");
    return {
      candidateId: item.candidateId,
      kind: item.kind,
      periodDays: item.periodDays,
      depthPpm: item.depthPpm,
    };
  });
  if (planets.completedWithoutPlanets && items.length)
    throw new SkyContractError(
      "행성 없는 완료 상태와 목록이 일치하지 않습니다.",
    );
  return {
    ticId: v.ticId,
    position: { x: p.x, y: p.y, depthZ: p.depthZ },
    completedWithoutPlanets: planets.completedWithoutPlanets,
    items,
  };
}
export function stablePhase(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++)
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

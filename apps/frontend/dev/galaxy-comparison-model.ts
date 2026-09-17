import {
  readSkyMeta,
  readSkyTiles,
  type SkyMeta,
  type Star,
  type Cluster,
} from "./legacy-galaxy/contracts";
import { levelForScale, type Matrix } from "./legacy-galaxy/geometry";
import { renderPlan, type RenderPlan } from "./legacy-galaxy/model";

export type ComparisonSnapshot = {
  meta: SkyMeta;
  stars: Star[];
  levels: { level: number; clusters: Cluster[] }[];
};
export function readComparisonSnapshot(value: unknown): ComparisonSnapshot {
  const raw = value as ComparisonSnapshot;
  const meta = readSkyMeta(raw?.meta);
  if (
    !Array.isArray(raw.levels) ||
    raw.levels.length !== meta.zoomLevels.length
  )
    throw new Error("비교할 배율 자료가 일치하지 않습니다.");
  const b = meta.bounds;
  const base = {
    version: meta.version,
    versionChanged: false,
    bounds: {
      x: b.minX,
      y: b.minY,
      w: Math.max(1, b.maxX - b.minX),
      h: Math.max(1, b.maxY - b.minY),
    },
  };
  const stars = readSkyTiles({
    ...base,
    level: 0,
    stars: raw.stars,
    clusters: [],
  }).stars;
  if (stars.length !== meta.starCount)
    throw new Error("원본 별 개수가 메타와 다릅니다.");
  const levels = raw.levels.map((row, i) => {
    if (row.level !== i) throw new Error("비교 배율이 연속하지 않습니다.");
    const clusters = readSkyTiles({
      ...base,
      level: i,
      stars: [],
      clusters: row.clusters,
    }).clusters;
    if (
      meta.zoomLevels[i].clustered &&
      clusters.reduce((n, c) => n + c.count, 0) !== stars.length
    )
      throw new Error("군집이 대표하는 별 개수가 원본과 다릅니다.");
    return { level: i, clusters };
  });
  return { meta, stars, levels };
}
export function comparisonPlans(
  snapshot: ComparisonSnapshot,
  matrix: Matrix,
  width: number,
  height: number,
  scale: number,
  fixedClusters: boolean,
  showOrbits: boolean,
) {
  const raw = renderPlan(snapshot.stars, [], matrix, width, height);
  const withoutOrbits = (plan: RenderPlan): RenderPlan =>
    showOrbits ? plan : { ...plan, orbitStars: [] };
  // Explicit comparison-only bypass: the regular /sky renderer keeps its budgets.
  const individual = { ...withoutOrbits(raw), overflow: null };
  let level = fixedClusters ? 0 : levelForScale(snapshot.meta, scale);
  function planAt(i: number) {
    const grouped = snapshot.meta.zoomLevels[i].clustered;
    return renderPlan(
      grouped ? [] : snapshot.stars,
      grouped ? snapshot.levels[i].clusters : [],
      matrix,
      width,
      height,
    );
  }
  let grouped = planAt(level);
  while (grouped.overflow && level > 0) grouped = planAt(--level);
  return {
    individual,
    grouped: withoutOrbits(grouped),
    level,
    rawBudget: raw.overflow,
  };
}

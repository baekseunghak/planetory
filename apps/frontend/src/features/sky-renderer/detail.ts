import {
  SkyContractError,
  type SkyMeta,
  type Star,
} from "../sky-data/contracts.ts";
import {
  readOwnedSystem,
  cameraMatrix,
  screenPoint,
  type GalaxyCamera,
} from "./model.ts";

const fail = (): never => {
  throw new SkyContractError("별 상세의 정보/행동 필드가 올바르지 않습니다.");
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown) => (typeof v === "string" && v.length ? v : fail());
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : fail();
const count = (v: unknown) =>
  Number.isSafeInteger(v) && num(v) >= 0 ? (v as number) : fail();
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail());
const nullable = (v: unknown) => (v === null ? null : num(v));
const nullableText = (v: unknown) => (v === null ? null : text(v));
function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  return values.includes(v as T) ? (v as T) : fail();
}
export class DetailVersionChanged extends Error {}
export function readStarDetail(
  value: unknown,
  meta: SkyMeta,
  ticId: string,
  tile?: Star,
) {
  const v = obj(value);
  if (typeof v.version === "string" && v.version !== meta.version)
    throw new DetailVersionChanged(
      "지도와 상세의 버전이 달라 최신 자료를 확인합니다.",
    );
  const system = readOwnedSystem(value, meta, ticId, tile);
  const s = obj(v.star),
    u = obj(v.unlock),
    p = obj(v.progress),
    a = obj(v.actions),
    achievement = obj(v.achievement),
    byType = obj(achievement.byType);
  const sectors = Array.isArray(s.sectors) ? s.sectors.map(count) : fail();
  const sectorCount = count(s.sectorCount);
  if (
    sectorCount !== sectors.length ||
    sectors.some((n, i) => n < 1 || (i > 0 && sectors[i - 1] >= n))
  )
    fail();
  const stage = oneOf(p.stage, [
    "unexplored",
    "in_progress",
    "completed",
  ] as const);
  const completedWithoutPlanets = bool(obj(v.planets).completedWithoutPlanets);
  if (
    completedWithoutPlanets !==
    (stage === "completed" && system.items.length === 0)
  )
    fail();
  return {
    system,
    star: {
      sectors,
      sectorCount,
      tmag: nullable(s.tmag),
      teffK: nullable(s.teffK),
      radiusRsun: nullable(s.radiusRsun),
    },
    unlock: { reason: text(u.reason), unlockedAt: text(u.unlockedAt) },
    progress: {
      stage,
      currentCurveStep:
        p.currentCurveStep === null ? null : count(p.currentCurveStep),
      completionReason: nullableText(p.completionReason),
      reopenPending: bool(p.reopenPending),
    },
    completedWithoutPlanets,
    achievement: {
      count: count(achievement.count),
      grade: nullableText(achievement.grade),
      byType: {
        confirmed: count(byType.confirmed),
        unconfirmed: count(byType.unconfirmed),
        fp: count(byType.fp),
      },
    },
    actions: {
      analysis: oneOf(a.analysis, ["start", "continue", "review"] as const),
      resultAvailable: bool(a.resultAvailable),
      boardOpen: bool(a.boardOpen),
      threadCount: count(a.threadCount),
    },
  };
}
export type StarDetail = ReturnType<typeof readStarDetail>;
const measurement = (value: unknown, unit: string) => {
  if (value === null) return null;
  const v = obj(value);
  if (v.unit !== unit || ![null, -1, 0, 1].includes(v.limit as number | null))
    fail();
  const decimal = (n: unknown) => {
    if (n === null) return null;
    const result = text(n);
    if (result.length > 40 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result))
      fail();
    return result;
  };
  return {
    value: decimal(v.value),
    limit: v.limit as -1 | 0 | 1 | null,
  };
};
export function readPlanetExplanations(value: unknown, detail: StarDetail) {
  const v = obj(value);
  if (v.ticId !== detail.system.ticId || v.version !== detail.system.version)
    throw new DetailVersionChanged(
      "별 정보가 변경됐어요. 최신 별 정보를 다시 확인해 주세요.",
    );
  const rows = Array.isArray(v.items) ? v.items : fail();
  const planets = new Map(
    detail.system.items.map((item) => [item.candidateId, item.kind]),
  );
  if (rows.length !== planets.size) fail();
  const seen = new Set<string>();
  return rows.map((value) => {
    const row = obj(value);
    const candidateId = text(row.candidateId);
    const kind = oneOf(row.kind, ["confirmed", "unconfirmed"] as const);
    const status = text(row.status);
    if (seen.has(candidateId) || planets.get(candidateId) !== kind) fail();
    seen.add(candidateId);
    if ((kind === "unconfirmed") !== (status === "not_applicable")) fail();
    const content = row.content === null ? null : obj(row.content);
    if ((status === "ready") !== (content !== null)) fail();
    const facts = row.facts === null ? null : obj(row.facts);
    if (
      facts &&
      (kind !== "confirmed" ||
        row.sourceStatus !== "ready" ||
        facts.sourceTable !== "ps" ||
        facts.sourceUrl !== "https://exoplanetarchive.ipac.caltech.edu/")
    )
      fail();
    const timestamp = (v: unknown) => {
      const result = nullableText(v);
      if (result !== null && !Number.isFinite(Date.parse(result))) fail();
      return result;
    };
    return {
      candidateId,
      kind,
      status,
      content: content && {
        name: text(content.name),
        orbitalPeriod: text(content.orbitalPeriod),
        radius: text(content.radius),
        mass: text(content.mass),
        discovery: text(content.discovery),
      },
      facts: facts && {
        planetName: text(facts.planetName),
        orbitalPeriod: measurement(facts.orbitalPeriod, "days"),
        radius: measurement(facts.radius, "earth_radius"),
        mass: measurement(facts.mass, "earth_mass"),
        discoveryMethod: nullableText(facts.discoveryMethod),
        discoveryYear:
          facts.discoveryYear === null ? null : count(facts.discoveryYear),
        controversial:
          facts.controversial === null ? null : bool(facts.controversial),
        sourceUrl:
          facts.sourceUrl as "https://exoplanetarchive.ipac.caltech.edu/",
      },
      sourceStatus: nullableText(row.sourceStatus),
      fetchedAt: timestamp(row.fetchedAt),
      refreshStatus: nullableText(row.refreshStatus),
      generatedAt: timestamp(row.generatedAt),
      retryAt: timestamp(row.retryAt),
      failure: nullableText(row.failure),
    };
  });
}
export type PlanetExplanation = ReturnType<
  typeof readPlanetExplanations
>[number];
export function detailStar(detail: StarDetail): Star {
  return {
    ticId: detail.system.ticId,
    ...detail.system.position,
    planetCount: detail.system.items.length,
    progressStage: detail.progress.stage,
    completedWithoutPlanets: detail.completedWithoutPlanets,
    marker: null,
    reopened: false,
  };
}
// Screen-plane center preserves the current orientation and uses the stored depth.
export function focusCamera(
  c: GalaxyCamera,
  position: Pick<Star, "x" | "y" | "depthZ">,
): GalaxyCamera {
  const p = screenPoint(
    cameraMatrix({ ...c, x: 0, y: 0, zoom: 1 }, 3100, 2020),
    3100,
    2020,
    position.x,
    position.y,
    position.depthZ,
  );
  return { ...c, x: p.x - 1550, y: p.y - 2020 * 0.46, zoom: 4 };
}

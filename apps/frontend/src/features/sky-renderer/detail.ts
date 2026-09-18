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

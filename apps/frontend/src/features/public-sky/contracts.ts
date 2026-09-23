import { ApiError } from "../../api/client";
import {
  readSkyMeta,
  readSkyTiles,
  type SkyMeta,
  type Star,
} from "../sky-data/contracts";
import { readOwnedSystem } from "../sky-renderer/model";
export function publicStarLabel(star: Star) {
  const progress = {
    unexplored: "미탐사",
    in_progress: "탐색 중",
    completed: "탐색 완료",
  };
  return `TIC ${star.ticId} · 공개 행성 ${star.planetCount}개 · ${progress[star.progressStage]}${star.completedWithoutPlanets ? " · 현재 공개할 행성이 없습니다" : ""}`;
}
const invalid = (): never => {
  throw new ApiError(
    0,
    "INVALID_RESPONSE",
    "공개 은하 응답 형식이 올바르지 않습니다.",
  );
};
const row = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
export function readPublicMeta(value: unknown, memberId: string) {
  const v = row(value),
    owner = row(v.owner);
  if (
    owner.memberId !== memberId ||
    typeof owner.nickname !== "string" ||
    !owner.nickname.trim() ||
    v.scope !== "all-owned" ||
    v.visibility !== "PUBLIC"
  )
    invalid();
  return {
    ...readSkyMeta({ ...v, firstVisit: false, centerTicIds: [] }),
    owner: { memberId, nickname: owner.nickname as string },
  };
}
export function publicTiles(value: unknown) {
  const v = row(value);
  if (!Array.isArray(v.stars)) invalid();
  // Explicit public allowlist. Never display owner tutorial/challenge or re-open state.
  const stars = (v.stars as unknown[]).map((value) => {
    const s = row(value);
    return {
      ticId: s.ticId,
      x: s.x,
      y: s.y,
      depthZ: s.depthZ,
      layoutOrdinal: s.layoutOrdinal,
      planetCount: s.planetCount,
      progressStage: s.progressStage,
      completedWithoutPlanets: s.completedWithoutPlanets,
      marker: null,
      reopened: false,
    };
  });
  return readSkyTiles({ ...v, stars });
}
export function readPublicSystem(
  value: unknown,
  meta: SkyMeta,
  ticId: string,
  memberId: string,
  star?: Star,
) {
  const v = row(value);
  if (v.memberId !== memberId) invalid();
  // Use existing geometry/count validation on a deliberately constructed projection.
  return readOwnedSystem(
    {
      ticId: v.ticId,
      version: v.version,
      presentationVersion: v.presentationVersion,
      unlock: { position: v.position },
      planets: v.planets,
    },
    meta,
    ticId,
    star,
  );
}

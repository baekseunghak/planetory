import {
  readBox,
  SkyContractError,
  type SkyMeta,
} from "../sky-data/contracts.ts";
export type StarFilters = { ticId: string; stage: string; grade: string };
export const emptyStarFilters: StarFilters = {
  ticId: "",
  stage: "",
  grade: "",
};
export function normalizeStarFilters(filters: StarFilters): StarFilters {
  const ticId = filters.ticId.trim().replace(/^TIC\s*/i, "");
  if (
    (ticId &&
      (!/^[1-9]\d{0,18}$/.test(ticId) ||
        BigInt(ticId) > 9223372036854775807n)) ||
    !["", "unexplored", "in_progress", "completed"].includes(filters.stage) ||
    !["", "A", "S", "SS", "SSS"].includes(filters.grade)
  )
    throw new Error("TIC 번호와 탐사 상태·등급을 확인해 주세요.");
  return { ...filters, ticId };
}
const keys = {
  ticId: "filterTic",
  stage: "filterStage",
  grade: "filterGrade",
} as const;
export function filtersFromSearch(search: string): StarFilters {
  const params = new URLSearchParams(search);
  return normalizeStarFilters({
    ticId: params.get(keys.ticId) ?? "",
    stage: params.get(keys.stage) ?? "",
    grade: params.get(keys.grade) ?? "",
  });
}
export function searchWithFilters(
  search: string,
  filters: StarFilters,
): string {
  const params = new URLSearchParams(search),
    clean = normalizeStarFilters(filters);
  for (const k of Object.keys(keys) as (keyof StarFilters)[]) {
    if (clean[k]) params.set(keys[k], clean[k]);
    else params.delete(keys[k]);
  }
  params.delete("star");
  params.delete("focus");
  return params.toString();
}
export function starSearchPath(
  filters: StarFilters,
  cursor: string | null = null,
  scope: "discovered" | "submitted" = "discovered",
) {
  const clean = normalizeStarFilters(filters),
    params = new URLSearchParams({ scope, sort: "recent", size: "20" });
  for (const [key, value] of Object.entries(clean))
    if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return "/v1/me/stars?" + params;
}
export class LocateVersionChanged extends Error {}
export function readStarLocation(
  value: unknown,
  expectedTic: string,
  meta: SkyMeta,
) {
  const fail = (): never => {
    throw new SkyContractError("별 위치 응답을 확인해 주세요.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const row = value as Record<string, unknown>;
  if (
    row.ticId !== expectedTic ||
    typeof row.version !== "string" ||
    row.layoutVersion !== meta.layoutVersion
  )
    return fail();
  if (row.version !== meta.version)
    throw new LocateVersionChanged(
      "지도 자료가 바뀌었습니다. 새 지도에서 다시 선택해 주세요.",
    );
  const { x, y, depthZ, level, layoutOrdinal } = row;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof depthZ !== "number" ||
    !Number.isFinite(depthZ) ||
    Math.abs(depthZ) > 1 ||
    !Number.isSafeInteger(layoutOrdinal) ||
    (layoutOrdinal as number) < 0 ||
    (layoutOrdinal as number) > 2147483647
  )
    return fail();
  const zoom = meta.zoomLevels.find((z) => z.level === level);
  const bounds = readBox(row.bounds);
  if (
    !zoom ||
    x < bounds.x ||
    x >= bounds.x + bounds.w ||
    y < bounds.y ||
    y >= bounds.y + bounds.h ||
    x < meta.bounds.minX ||
    x > meta.bounds.maxX ||
    y < meta.bounds.minY ||
    y > meta.bounds.maxY
  )
    return fail();
  return {
    ticId: expectedTic,
    x,
    y,
    depthZ,
    level: zoom.level,
    zoom: zoom.scale,
    bounds,
    version: row.version,
    layoutOrdinal: layoutOrdinal as number,
  };
}
export type StarLocation = ReturnType<typeof readStarLocation>;

import type { Box, SkyMeta, Star } from "../../src/features/sky-data/contracts";
export const meta = (version = "v1"): SkyMeta => ({
  representation: "individual-stars",
  layoutVersion: "personal-spiral-v1",
  presentationVersion: "personal-galaxy-v1",
  version,
  starCount: 10000,
  bounds: { minX: -1024, maxX: 8191, minY: -1024, maxY: 4095 },
  tileSize: 256,
  zoomLevels: [0.1, 0.4, 1, 2, 4, 8].map((scale, level) => ({ level, scale })),
  centerTicIds: ["1"],
  firstVisit: false,
  asOf: "2026-09-15T00:00:00Z",
});
export const star = (ticId: string, x: number, y: number): Star => ({
  ticId,
  x,
  y,
  depthZ: 0.42,
  layoutOrdinal: Number(BigInt(ticId) % 2147483648n),
  planetCount: 0,
  progressStage: "unexplored",
  completedWithoutPlanets: false,
  marker: null,
  reopened: false,
});
export function parse(path: string) {
  const p = new URL(path, "https://fixture.test").searchParams;
  return {
    level: Number(p.get("level")),
    box: {
      x: Number(p.get("x")),
      y: Number(p.get("y")),
      w: Number(p.get("w")),
      h: Number(p.get("h")),
    },
    version: p.get("version"),
    limit: Number(p.get("limit")),
    cursor: p.get("cursor"),
  };
}
export function tile(m: SkyMeta, box: Box, level: number, stars: Star[] = []) {
  const s = stars
    .filter(
      (s) =>
        s.x >= box.x &&
        s.x < box.x + box.w &&
        s.y >= box.y &&
        s.y < box.y + box.h,
    )
    .sort((a, b) => (BigInt(a.ticId) < BigInt(b.ticId) ? -1 : 1));
  return {
    representation: "individual-stars",
    version: m.version,
    versionChanged: false,
    level,
    bounds: box,
    stars: s,
    rangeStarCount: s.length,
    nextCursor: null,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

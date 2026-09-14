import type { Box, SkyMeta, Star } from "../../src/features/sky-data/contracts";
export const meta = (version = "v1"): SkyMeta => ({
  version,
  starCount: 1000,
  bounds: { minX: -1024, maxX: 8191, minY: -1024, maxY: 4095 },
  tileSize: 256,
  zoomLevels: [0.1, 0.4, 1, 2, 4, 8].map((scale, level) => ({
    level,
    scale,
    clustered: scale < 0.8,
  })),
  centerTicIds: ["0"],
  overview: [
    {
      nodeId: "root",
      x: 0,
      y: 0,
      count: 1000,
      counts: { planet: 0, done: 0, new: 1000 },
      bounds: { x: -1024, y: -1024, w: 9216, h: 5120 },
    },
  ],
  firstVisit: false,
  asOf: "2026-09-14T00:00:00Z",
});
export const star = (ticId: string, x: number, y: number): Star => ({
  ticId,
  x,
  y,
  depthZ: 0.42,
  planetCount: 0,
  colorLevel: 0,
  sizeLevel: 0,
  progressStage: "unexplored",
  completedWithoutPlanets: false,
  marker: null,
  reopened: false,
  orbits: [],
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
  };
}
export function tile(m: SkyMeta, box: Box, level: number, stars: Star[] = []) {
  return {
    version: m.version,
    versionChanged: false,
    level,
    bounds: box,
    stars: stars.filter(
      (s) =>
        s.x >= box.x &&
        s.x < box.x + box.w &&
        s.y >= box.y &&
        s.y < box.y + box.h,
    ),
    clusters: [],
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

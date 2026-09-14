import type { Plugin } from "vite";
import type {
  Box,
  Cluster,
  SkyMeta,
  Star,
} from "../src/features/sky-data/contracts.ts";
import { intersects } from "../src/features/sky-data/geometry.ts";

// Serve-only synthetic coordinates for boundary/tiling checks, not the galaxy placement algorithm.
export function skyFixturePlugin(): Plugin {
  let revision = 1,
    failed = false;
  const stars: Star[] = Array.from({ length: 128 }, (_, i) => {
    const planetCount = i % 3,
      completedWithoutPlanets = planetCount === 0 && i % 2 === 0;
    return {
      ticId: String(900000000 + i),
      x: ((i % 16) - 8) * 512 + 128,
      y: (Math.floor(i / 16) - 4) * 512 + 192,
      depthZ: (i % 3) - 1,
      planetCount,
      colorLevel: planetCount,
      sizeLevel: planetCount,
      progressStage: completedWithoutPlanets ? "completed" : "in_progress",
      completedWithoutPlanets,
      marker: i === 0 ? { type: "tutorial", seq: 1 } : null,
      reopened: false,
      orbits: Array.from({ length: planetCount }, (_, j) => ({
        candidateId: `sky-fixture-203-c-${i}-${j}`,
        periodDays: 2 + j,
        kind: "confirmed",
      })),
    };
  });
  const version = () => `sky-fixture-203:${revision}`;
  function clusters(level: number): Cluster[] {
    const span = level === 0 ? 2048 : 1024,
      groups = new Map<string, Star[]>();
    for (const star of stars) {
      const key = `${Math.floor(star.x / span)}:${Math.floor(star.y / span)}`;
      const list = groups.get(key) || [];
      list.push(star);
      groups.set(key, list);
    }
    return [...groups].map(([key, items]) => {
      const [x, y] = key.split(":").map(Number),
        counts = { planet: 0, done: 0, new: 0 };
      for (const s of items)
        counts[
          s.planetCount ? "planet" : s.completedWithoutPlanets ? "done" : "new"
        ]++;
      return {
        nodeId: `sky-fixture-203-n-${level}-${key}`,
        x: items.reduce((a, s) => a + s.x, 0) / items.length,
        y: items.reduce((a, s) => a + s.y, 0) / items.length,
        count: items.length,
        counts,
        bounds: { x: x * span, y: y * span, w: span, h: span },
      };
    });
  }
  const levels = [0.125, 0.5, 1, 2, 4, 8].map((scale, level) => ({
    level,
    scale,
    clustered: scale < 0.8,
  }));
  const meta = (): SkyMeta => ({
    version: version(),
    starCount: stars.length,
    bounds: {
      minX: Math.min(...stars.map((s) => s.x)),
      maxX: Math.max(...stars.map((s) => s.x)),
      minY: Math.min(...stars.map((s) => s.y)),
      maxY: Math.max(...stars.map((s) => s.y)),
    },
    tileSize: 512,
    zoomLevels: levels,
    centerTicIds: [stars[0].ticId],
    overview: clusters(0),
    firstVisit: false,
    asOf: new Date().toISOString(),
  });
  return {
    name: "sky-fixture-203",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        if (req.method === "POST" && url.pathname.startsWith("/dev-sky-203/")) {
          const action = url.pathname.split("/").at(-1);
          if (action === "change") {
            revision++;
            const old = stars.at(-1)!;
            stars.push({
              ...old,
              ticId: String(900000000 + stars.length),
              x: old.x + 180,
              y: old.y,
              orbits: old.orbits.map((o, j) => ({
                ...o,
                candidateId: `sky-fixture-203-new-${revision}-${j}`,
              })),
            });
          } else if (action === "fail") failed = true;
          else if (action === "recover") failed = false;
          else
            return reply(404, {
              code: "NOT_FOUND",
              message: "검증 시나리오가 없습니다.",
            });
          return reply(200, {
            skyVersion: version(),
            asOf: new Date().toISOString(),
          });
        }
        if (req.method !== "GET")
          return reply(405, {
            code: "READ_ONLY_FIXTURE",
            message: "개발용 읽기 응답입니다.",
          });
        if (url.pathname === "/v1/me")
          return reply(200, {
            memberId: "sky-fixture-member-203",
            nickname: "타일확인",
            onboardingDone: true,
            tutorialCompleted: true,
          });
        if (url.pathname === "/v1/me/sky") return reply(200, meta());
        if (url.pathname === "/v1/me/sky/tiles") {
          const level = Number(url.searchParams.get("level")),
            keys = ["level", "x", "y", "w", "h", "version"];
          const b: Box = {
            x: Number(url.searchParams.get("x")),
            y: Number(url.searchParams.get("y")),
            w: Number(url.searchParams.get("w")),
            h: Number(url.searchParams.get("h")),
          };
          if (
            [...url.searchParams.keys()].some((k) => !keys.includes(k)) ||
            keys.slice(0, 5).some((k) => !url.searchParams.has(k)) ||
            !levels[level] ||
            !Object.values(b).every(Number.isFinite) ||
            b.w <= 0 ||
            b.h <= 0 ||
            b.w > 512 * 64 ||
            b.h > 512 * 64
          )
            return reply(400, {
              code: "VALIDATION_FAILED",
              message: "level 및 월드 경계 상자의 상한을 확인해 주세요.",
            });
          if (failed && b.x + b.w > 0)
            return reply(503, {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "개발용 영역 실패 응답입니다.",
            });
          const x = Math.floor(b.x / 512) * 512,
            y = Math.floor(b.y / 512) * 512,
            bounds = {
              x,
              y,
              w: Math.ceil((b.x + b.w) / 512) * 512 - x,
              h: Math.ceil((b.y + b.h) / 512) * 512 - y,
            };
          return reply(200, {
            version: version(),
            versionChanged:
              url.searchParams.has("version") &&
              url.searchParams.get("version") !== version(),
            level,
            bounds,
            stars: levels[level].clustered
              ? []
              : stars.filter(
                  (s) =>
                    s.x >= bounds.x &&
                    s.x < bounds.x + bounds.w &&
                    s.y >= bounds.y &&
                    s.y < bounds.y + bounds.h,
                ),
            clusters: levels[level].clustered
              ? clusters(level).filter((c) => intersects(c.bounds, bounds))
              : [],
            asOf: new Date().toISOString(),
          });
        }
        return reply(404, {
          code: "RESOURCE_NOT_FOUND",
          message: "이 개발 응답에는 해당 기능이 없습니다.",
        });
      });
    },
  };
}

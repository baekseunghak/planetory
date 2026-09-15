import type { Plugin } from "vite";
import type {
  Box,
  Cluster,
  SkyMeta,
  Star,
} from "../src/features/sky-data/contracts.ts";
import { intersects } from "../src/features/sky-data/geometry.ts";

// Development HTTP provider only. This is not C05's approved placement implementation.
export function galaxyFixturePlugin(): Plugin {
  let revision = 1,
    count = 1000,
    failed = false,
    empty = false;
  const layoutVersion = "galaxy-fixture-204-layout";
  const makeStar = (i: number): Star => {
    const radius = i === 0 ? 0 : 40 + Math.sqrt(i / 1024) * 1450;
    const angle =
      ((i % 4) * Math.PI) / 2 + radius * 0.0057 + Math.sin(i * 12.9898) * 0.14;
    const planetCount =
      i % 10 === 0
        ? 5
        : i % 10 === 1
          ? 2
          : i % 10 === 2
            ? 1
            : i % 10 === 3
              ? 3
              : i % 10 === 4
                ? 4
                : 0;
    const complete = planetCount === 0 && i % 3 === 0;
    return {
      ticId: i === 0 ? "259377017" : String(910000000 + i),
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      depthZ: Math.sin(i * 7.23) * 0.32,
      planetCount,
      colorLevel: Math.min(4, planetCount),
      sizeLevel: Math.min(4, planetCount),
      progressStage: complete
        ? "completed"
        : planetCount
          ? "in_progress"
          : "unexplored",
      completedWithoutPlanets: complete,
      marker: i === 0 ? { type: "tutorial", seq: 1 } : null,
      reopened: false,
      orbits: Array.from({ length: planetCount }, (_, j) => ({
        candidateId: `galaxy-fixture-204-c-${i}-${j}`,
        kind: j % 2 ? "unconfirmed" : "confirmed",
        periodDays: 2 + j * 3.25,
      })),
    };
  };
  let stars = Array.from({ length: count }, (_, i) => makeStar(i));
  const scales = [0.125, 0.35, 0.7, 1.4, 2.8, 5.6];
  const levels = scales.map((scale, level) => ({
    level,
    scale,
    clustered: level < 3,
  }));
  let cache: Map<number, Cluster[]> = new Map();
  function precompute() {
    cache = new Map();
    for (let level = 0; level < 3; level++) {
      const span = [512, 256, 128][level],
        groups = new Map<string, Star[]>();
      for (const star of stars) {
        const key = `${Math.floor(star.x / span)}:${Math.floor(star.y / span)}`;
        const group = groups.get(key) || [];
        group.push(star);
        groups.set(key, group);
      }
      const nodes = [...groups].map(([key, items]): Cluster => {
        const [x, y] = key.split(":").map(Number),
          counts = { planet: 0, done: 0, new: 0 };
        for (const s of items)
          counts[
            s.planetCount
              ? "planet"
              : s.completedWithoutPlanets
                ? "done"
                : "new"
          ]++;
        return {
          nodeId: `galaxy-fixture-204-n-${level}-${key}`,
          x: items.reduce((n, s) => n + s.x, 0) / items.length,
          y: items.reduce((n, s) => n + s.y, 0) / items.length,
          count: items.length,
          counts,
          bounds: { x: x * span, y: y * span, w: span, h: span },
        };
      });
      cache.set(level, nodes);
    }
  }
  precompute();
  const version = () => `galaxy-fixture-204:${revision}`;
  const meta = (): SkyMeta => ({
    version: version(),
    starCount: empty ? 0 : stars.length,
    bounds: { minX: -1536, maxX: 1536, minY: -1536, maxY: 1536 },
    tileSize: 256,
    zoomLevels: levels,
    centerTicIds: empty ? [] : [stars[0].ticId],
    overview: empty ? [] : cache.get(0)!,
    firstVisit: count === 1,
    asOf: new Date().toISOString(),
  });
  return {
    name: "galaxy-fixture-204",
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
        if (
          req.method === "POST" &&
          url.pathname.startsWith("/dev-galaxy-204/")
        ) {
          const action = url.pathname.split("/").at(-1);
          if (action === "reset") {
            const n = Number(url.searchParams.get("count"));
            if (![1, 10, 100, 1000].includes(n))
              return reply(400, {
                code: "BAD_FIXTURE",
                message: "지원하지 않는 검증 계정",
              });
            count = n;
            stars = Array.from({ length: count }, (_, i) => makeStar(i));
            failed = false;
            empty = false;
            revision++;
            precompute();
          } else if (action === "change") {
            stars.push(makeStar(stars.length));
            revision++;
            precompute();
          } else if (action === "status") {
            const s = stars[0];
            s.planetCount = 0;
            s.colorLevel = 0;
            s.sizeLevel = 0;
            s.progressStage = "completed";
            s.completedWithoutPlanets = true;
            s.orbits = [];
            revision++;
            precompute();
          } else if (action === "fail") {
            failed = true;
            revision++;
          } else if (action === "recover") failed = false;
          else if (action === "empty") {
            empty = true;
            revision++;
          } else
            return reply(404, { code: "NOT_FOUND", message: "검증 기능 없음" });
          return reply(200, {
            skyVersion: version(),
            asOf: new Date().toISOString(),
          });
        }
        if (req.method !== "GET")
          return reply(405, {
            code: "READ_ONLY",
            message: "읽기 전용 개발 응답",
          });
        if (url.pathname === "/v1/me")
          return reply(200, {
            memberId: "galaxy-fixture-204-member",
            nickname: "은하확인",
            onboardingDone: true,
            tutorialCompleted: count > 1,
          });
        if (url.pathname === "/v1/me/sky") return reply(200, meta());
        if (url.pathname === "/v1/me/sky/tiles") {
          const level = Number(url.searchParams.get("level")),
            b: Box = {
              x: Number(url.searchParams.get("x")),
              y: Number(url.searchParams.get("y")),
              w: Number(url.searchParams.get("w")),
              h: Number(url.searchParams.get("h")),
            };
          if (
            !levels[level] ||
            !Object.values(b).every(Number.isFinite) ||
            b.w <= 0 ||
            b.h <= 0 ||
            b.w > 16384 ||
            b.h > 16384
          )
            return reply(400, {
              code: "VALIDATION_FAILED",
              message: "타일 경계 확인",
            });
          if (failed && b.x >= 0)
            return reply(503, {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "검증용 일부 영역 실패",
            });
          const x = Math.floor(b.x / 256) * 256,
            y = Math.floor(b.y / 256) * 256,
            bounds = {
              x,
              y,
              w: Math.ceil((b.x + b.w) / 256) * 256 - x,
              h: Math.ceil((b.y + b.h) / 256) * 256 - y,
            };
          return reply(200, {
            version: version(),
            versionChanged: url.searchParams.get("version") !== version(),
            level,
            bounds,
            stars:
              empty || level < 3
                ? []
                : stars.filter(
                    (s) =>
                      s.x >= bounds.x &&
                      s.x < bounds.x + bounds.w &&
                      s.y >= bounds.y &&
                      s.y < bounds.y + bounds.h,
                  ),
            clusters:
              empty || level >= 3
                ? []
                : cache.get(level)!.filter((c) => intersects(c.bounds, bounds)),
            asOf: new Date().toISOString(),
          });
        }
        const match = url.pathname.match(/^\/v1\/me\/stars\/([^/]+)$/);
        if (match) {
          const s = stars.find((s) => s.ticId === decodeURIComponent(match[1]));
          if (!s || empty)
            return reply(403, {
              code: "STAR_LOCKED",
              message: "열리지 않은 별입니다.",
            });
          return reply(200, {
            ticId: s.ticId,
            unlock: {
              position: { x: s.x, y: s.y, depthZ: s.depthZ, layoutVersion },
            },
            planets: {
              count: s.planetCount,
              completedWithoutPlanets: s.completedWithoutPlanets,
              items: s.orbits.map((o, i) => ({
                ...o,
                depthPpm: i === 0 ? null : 300 + i * 100,
              })),
            },
          });
        }
        return reply(404, {
          code: "NOT_FOUND",
          message: "204 검증 범위 밖의 API입니다.",
        });
      });
    },
  };
}

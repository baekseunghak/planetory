import type { Plugin } from "vite";
import { exampleStar } from "./sky-reference/reference.mjs";
import {
  LAYOUT_VERSION,
  PRESENTATION_VERSION,
} from "../src/features/sky-data/contracts";
// Local synthetic producer, deliberately independent from /me data.
export function publicSkyFixturePlugin(): Plugin {
  const stars = Array.from({ length: 1000 }, (_, i) => ({
    ...exampleStar(i),
    planetCount: i === 0 ? 2 : 0,
  }));
  return {
    name: "public-sky-250",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const u = new URL(req.url ?? "/", "http://localhost"),
          m = u.pathname.match(
            /^\/v1\/members\/([^/]+)\/(sky(?:\/tiles)?|stars\/\d+)$/,
          );
        if (!m) return next();
        const owner = decodeURIComponent(m[1]),
          path = m[2],
          version = "public-fixture-250:" + owner;
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        if (owner === "private" || owner === "deleted")
          return reply(404, {
            code: "PUBLIC_SKY_NOT_AVAILABLE",
            message: "공개 은하를 찾을 수 없습니다.",
          });
        if (req.method !== "GET")
          return reply(405, { code: "METHOD_NOT_ALLOWED" });
        const meta = {
          owner: { memberId: owner, nickname: "공개 탐사자" },
          scope: "all-owned",
          visibility: "PUBLIC",
          representation: "individual-stars",
          layoutVersion: LAYOUT_VERSION,
          presentationVersion: PRESENTATION_VERSION,
          version,
          starCount: stars.length,
          bounds: {
            minX: Math.min(...stars.map((s) => s.x)),
            maxX: Math.max(...stars.map((s) => s.x)),
            minY: Math.min(...stars.map((s) => s.y)),
            maxY: Math.max(...stars.map((s) => s.y)),
          },
          tileSize: 512,
          zoomLevels: [0.25, 1, 4].map((scale, level) => ({ scale, level })),
        };
        if (path === "sky") return reply(200, meta);
        if (path === "sky/tiles") {
          const q = u.searchParams,
            bounds = {
              x: Number(q.get("x")),
              y: Number(q.get("y")),
              w: Number(q.get("w")),
              h: Number(q.get("h")),
            };
          const all = stars
              .filter(
                (s) =>
                  s.x >= bounds.x &&
                  s.x < bounds.x + bounds.w &&
                  s.y >= bounds.y &&
                  s.y < bounds.y + bounds.h,
              )
              .sort((a, b) => Number(a.ticId) - Number(b.ticId)),
            offset = Number(q.get("cursor") ?? 0),
            limit = Math.min(1000, Number(q.get("limit") ?? 1000));
          return reply(200, {
            representation: "individual-stars",
            version,
            versionChanged: false,
            level: Number(q.get("level")),
            bounds,
            rangeStarCount: all.length,
            stars: all
              .slice(offset, offset + limit)
              .map(({ marker, reopened, ...s }) => s),
            nextCursor:
              offset + limit < all.length ? String(offset + limit) : null,
          });
        }
        const star = stars.find((s) => s.ticId === path.split("/")[1]);
        if (!star) return reply(404, { code: "STAR_NOT_FOUND" });
        return reply(200, {
          memberId: owner,
          ticId: star.ticId,
          version,
          presentationVersion: PRESENTATION_VERSION,
          position: {
            x: star.x,
            y: star.y,
            depthZ: star.depthZ,
            layoutOrdinal: star.layoutOrdinal,
            layoutVersion: LAYOUT_VERSION,
          },
          planets: {
            count: star.planetCount,
            items: Array.from({ length: star.planetCount }, (_, i) => ({
              candidateId: "public-planet-" + i,
              kind: i ? "unconfirmed" : "confirmed",
              periodDays: i ? null : 3.37,
              depthPpm: i ? null : 320,
            })),
          },
        });
      });
    },
  };
}

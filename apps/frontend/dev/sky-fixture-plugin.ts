import type { Plugin } from "vite";
import { randomUUID } from "node:crypto";
import {
  LAYOUT_VERSION,
  PRESENTATION_VERSION,
  compareTic,
  type Box,
  type SkyMeta,
  type Star,
} from "../src/features/sky-data/contracts.ts";
import { exampleStar } from "./sky-reference/reference.mjs";

// Serve-only HTTP fixture, pinned to MR !41 7f67c568. Never imported by production code.
export function skyFixturePlugin(): Plugin {
  let revision = 1,
    failed = false;
  let stars: Star[] = Array.from({ length: 2501 }, (_, i) => exampleStar(i));
  const cursors = new Map<string, { scope: string; offset: number }>();
  const version = () => "sky-fixture-203:" + revision;
  const levels = [0.25, 1, 4].map((scale, level) => ({ scale, level }));
  const meta = (): SkyMeta => ({
    representation: "individual-stars",
    layoutVersion: LAYOUT_VERSION,
    presentationVersion: PRESENTATION_VERSION,
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
        const bad = () =>
          reply(400, {
            code: "VALIDATION_FAILED",
            message: "level·bbox·version·limit·cursor를 확인해 주세요.",
          });
        if (req.method === "POST" && url.pathname.startsWith("/dev-sky-203/")) {
          const action = url.pathname.split("/").at(-1);
          if (action === "reset") {
            stars = Array.from({ length: 2501 }, (_, i) => exampleStar(i));
            failed = false;
            revision++;
            cursors.clear();
          } else if (action === "change") {
            stars.push(exampleStar(stars.length));
            revision++;
            cursors.clear();
          } else if (action === "fail") {
            failed = true;
            revision++;
            cursors.clear();
          } else if (action === "recover") failed = false;
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
          const q = url.searchParams,
            required = ["level", "x", "y", "w", "h", "version"];
          const level = Number(q.get("level")),
            limit = q.has("limit") ? Number(q.get("limit")) : 1000;
          const box: Box = {
            x: Number(q.get("x")),
            y: Number(q.get("y")),
            w: Number(q.get("w")),
            h: Number(q.get("h")),
          };
          if (
            [...q.keys()].some(
              (k) =>
                ![...required, "limit", "cursor"].includes(k) ||
                q.getAll(k).length !== 1,
            ) ||
            required.some((k) => !q.get(k)) ||
            !levels[level] ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 2000 ||
            !Object.values(box).every(Number.isFinite) ||
            box.w <= 0 ||
            box.h <= 0 ||
            box.w > 512 * 64 ||
            box.h > 512 * 64
          )
            return bad();
          if (q.get("version") !== version())
            return reply(200, {
              representation: "individual-stars",
              version: version(),
              level,
              versionChanged: true,
              stars: [],
              nextCursor: null,
              asOf: new Date().toISOString(),
            });
          const scope = JSON.stringify([
            "sky-fixture-member-203",
            version(),
            level,
            box,
            limit,
          ]);
          const continuation = q.has("cursor")
            ? cursors.get(q.get("cursor")!)
            : undefined;
          if (
            q.has("cursor") &&
            (!continuation || continuation.scope !== scope)
          )
            return bad();
          const offset = continuation?.offset || 0;
          if (failed && offset > 0)
            return reply(503, {
              code: "DEPENDENCY_UNAVAILABLE",
              message: "개발용 중간 페이지 실패입니다.",
            });
          const x = Math.floor(box.x / 512) * 512,
            y = Math.floor(box.y / 512) * 512;
          const bounds = {
            x,
            y,
            w: Math.ceil((box.x + box.w) / 512) * 512 - x,
            h: Math.ceil((box.y + box.h) / 512) * 512 - y,
          };
          const items = stars
            .filter(
              (s) =>
                s.x >= bounds.x &&
                s.x < bounds.x + bounds.w &&
                s.y >= bounds.y &&
                s.y < bounds.y + bounds.h,
            )
            .sort((a, b) => compareTic(a.ticId, b.ticId));
          const page = items.slice(offset, offset + limit);
          let nextCursor: string | null = null;
          if (offset + page.length < items.length) {
            nextCursor = randomUUID();
            cursors.set(nextCursor, { scope, offset: offset + page.length });
          }
          return reply(200, {
            representation: "individual-stars",
            version: version(),
            level,
            versionChanged: false,
            bounds,
            rangeStarCount: items.length,
            stars: page,
            nextCursor,
            asOf: new Date().toISOString(),
          });
        }
        return reply(404, {
          code: "NOT_FOUND",
          message: "203 범위 밖의 개발 응답입니다.",
        });
      });
    },
  };
}

import type { Plugin } from "vite";
import { createHash, randomUUID } from "node:crypto";
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
export function galaxyFixturePlugin(
  performanceFixture = false,
  initialStarCount = 1000,
): Plugin {
  let revision = 1,
    failed = false;
  const completedTutorials = new Map<number, string>();
  const makeStar = (i: number): Star => ({
    ...exampleStar(i),
    planetCount: performanceFixture
      ? i === 1
        ? 1
        : i === 2
          ? 32
          : i >= 3 && i <= 995
            ? 5
            : i === 996
              ? 2
              : 0
      : i === 0
        ? 5
        : i === 7
          ? 2
          : 0,
  });
  let stars: Star[] = Array.from({ length: initialStarCount }, (_, i) =>
    makeStar(i),
  );
  const cursors = new Map<string, { scope: string; offset: number }>();
  const version = () => "galaxy-fixture-204:" + revision;
  const levels = [0.25, 1, 4].map((scale, level) => ({ scale, level }));
  const meta = (): SkyMeta => ({
    representation: "individual-stars",
    layoutVersion: LAYOUT_VERSION,
    presentationVersion: PRESENTATION_VERSION,
    version: version(),
    starCount: stars.length,
    bounds: {
      minX: stars.length ? Math.min(...stars.map((s) => s.x)) : 0,
      maxX: stars.length ? Math.max(...stars.map((s) => s.x)) : 0,
      minY: stars.length ? Math.min(...stars.map((s) => s.y)) : 0,
      maxY: stars.length ? Math.max(...stars.map((s) => s.y)) : 0,
    },
    tileSize: 512,
    zoomLevels: levels,
    centerTicIds: stars.length ? [stars[0].ticId] : [],
    firstVisit: stars.length === 1,
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
        const bad = () =>
          reply(400, {
            code: "VALIDATION_FAILED",
            message: "level·bbox·version·limit·cursor를 확인해 주세요.",
          });
        if (
          performanceFixture &&
          req.method === "GET" &&
          url.pathname === "/dev-galaxy-204/manifest"
        )
          return reply(200, {
            stars: stars.length,
            planets: stars.reduce((n, s) => n + s.planetCount, 0),
            sha256: createHash("sha256")
              .update(JSON.stringify(stars))
              .digest("hex"),
            layoutVersion: LAYOUT_VERSION,
            presentationVersion: PRESENTATION_VERSION,
          });
        if (
          req.method === "POST" &&
          url.pathname.startsWith("/dev-galaxy-204/")
        ) {
          const action = url.pathname.split("/").at(-1);
          if (action === "reset") {
            const count = Number(url.searchParams.get("count") ?? 1000);
            if (
              !(
                performanceFixture ? [1, 500, 100000] : [1, 10, 100, 1000, 2501]
              ).includes(count)
            )
              return bad();
            stars = Array.from({ length: count }, (_, i) => makeStar(i));
            if (count === 1) stars[0] = { ...stars[0], planetCount: 0 };
            failed = false;
            completedTutorials.clear();
            revision++;
            cursors.clear();
          } else if (
            action === "complete-tutorial" ||
            action === "reopen-tutorial"
          ) {
            const seq = Number(url.searchParams.get("seq") ?? 1);
            if (seq < 1 || seq > 5 || !stars[seq - 1]) return bad();
            const item = stars[seq - 1];
            if (action === "complete-tutorial")
              completedTutorials.set(
                seq,
                url.searchParams.get("reason") === "skipped"
                  ? "skipped"
                  : "all_found",
              );
            stars[seq - 1] = {
              ...item,
              progressStage:
                action === "complete-tutorial" ? "completed" : "in_progress",
              completedWithoutPlanets:
                action === "complete-tutorial" && item.planetCount === 0,
              reopened: action === "reopen-tutorial",
            };
            revision++;
            cursors.clear();
          } else if (action === "change") {
            stars.push(makeStar(stars.length));
            revision++;
            cursors.clear();
          } else if (action === "status") {
            if (stars[0])
              stars[0] = {
                ...stars[0],
                planetCount: 0,
                progressStage: "completed",
                completedWithoutPlanets: true,
              };
            revision++;
            cursors.clear();
          } else if (action === "empty") {
            stars = [];
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
            memberId: "galaxy-fixture-204-member",
            nickname: "은하확인",
            onboardingDone: true,
            tutorialCompleted: stars.length > 1,
          });
        if (url.pathname === "/v1/me/quests")
          return reply(200, {
            asOf: new Date().toISOString(),
            tutorial: {
              completedCount: completedTutorials.size,
              items: Array.from({ length: 5 }, (_, i) => ({
                seq: i + 1,
                intent: [
                  "deep_confirmed",
                  "shallow_confirmed",
                  "fp",
                  "deep_fp",
                  "multi_fp",
                ][i],
                ticId: stars[i]?.ticId ?? null,
                status: completedTutorials.has(i + 1)
                  ? "completed"
                  : stars[i]
                    ? "unlocked"
                    : "locked",
                completionReason: completedTutorials.get(i + 1) ?? null,
              })),
            },
            challenge: {
              round: stars[5]
                ? {
                    roundId: "cr-901",
                    roundNo: 1,
                    startsOn: "2026-09-14",
                    endsOn: "2026-09-21",
                    description: "얕은 밝기 신호를 찾아보세요",
                  }
                : null,
              eligible: !!stars[5],
              ticId: stars[5]?.ticId ?? null,
              unlocked: !!stars[5],
              progressStage: stars[5]?.progressStage ?? null,
              participantCount: stars[5] ? 12 : null,
            },
            reopened: [],
          });
        if (url.pathname === "/v1/challenges/current")
          return reply(
            200,
            stars[5]
              ? {
                  round: {
                    roundId: "cr-901",
                    roundNo: 1,
                    ticId: stars[5].ticId,
                    startsOn: "2026-09-14",
                    endsOn: "2026-09-21",
                    status: "active",
                    description: "얕은 밝기 신호를 찾아보세요",
                  },
                  eligible: true,
                  participantCount: 12,
                }
              : { round: null, eligible: false },
          );
        if (url.pathname === "/v1/me/sky") return reply(200, meta());
        if (url.pathname === "/v1/me/stars") {
          const q = url.searchParams;
          if (
            q.get("scope") !== "discovered" ||
            q.get("sort") !== "recent" ||
            q.get("size") !== "20" ||
            [...q.keys()].some(
              (k) => !["scope", "sort", "size", "cursor"].includes(k),
            )
          )
            return bad();
          const scope = "discovered-list:" + version();
          const continuation = q.has("cursor")
            ? cursors.get(q.get("cursor")!)
            : undefined;
          if (q.has("cursor") && continuation?.scope !== scope) return bad();
          const offset = continuation?.offset ?? 0;
          const items = stars.slice(offset, offset + 20).map((s) => ({
            ticId: s.ticId,
            progressStage: s.progressStage,
            planetCount: s.planetCount,
            completedWithoutPlanets: s.completedWithoutPlanets,
            achievementCount: s.planetCount ? 1 : 0,
            grade: s.planetCount ? "A" : null,
            currentCurveStep: s.progressStage === "unexplored" ? null : 0,
            reopenPending: false,
            reopened: s.reopened,
            unpublishedSignalCount: 0,
            lastActivityAt: "2026-09-17T00:00:00Z",
            unlockReason: "achievement",
            marker: s.marker,
          }));
          let nextCursor: string | null = null;
          if (offset + items.length < stars.length) {
            nextCursor = randomUUID();
            cursors.set(nextCursor, { scope, offset: offset + items.length });
          }
          return reply(200, {
            items,
            nextCursor,
            hasNext: nextCursor !== null,
          });
        }
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
            "galaxy-fixture-204-member",
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
          if (failed && (offset > 0 || box.x >= 0))
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
        const match = url.pathname.match(/^\/v1\/me\/stars\/([^/]+)$/);
        if (match) {
          const star = stars.find(
            (s) => s.ticId === decodeURIComponent(match[1]),
          );
          if (!star)
            return reply(403, {
              code: "STAR_LOCKED",
              message: "열리지 않은 별입니다.",
            });
          return reply(200, {
            ticId: star.ticId,
            version: version(),
            presentationVersion: PRESENTATION_VERSION,
            star: {
              sectorCount: 2,
              sectors: [14, 41],
              tmag: 9.8,
              teffK: null,
              radiusRsun: null,
            },
            progress: {
              stage: star.progressStage,
              currentCurveStep: 0,
              completionReason: null,
              reopenPending: false,
              reopenedAt: null,
              completedAt: null,
            },
            achievement: {
              count: star.planetCount ? 1 : 0,
              grade: star.planetCount ? "A" : null,
              byType: {
                confirmed: star.planetCount ? 1 : 0,
                unconfirmed: 0,
                fp: 0,
              },
            },
            actions: {
              analysis:
                star.progressStage === "completed"
                  ? "review"
                  : star.progressStage === "in_progress"
                    ? "continue"
                    : "start",
              resultAvailable: star.progressStage !== "unexplored",
              boardOpen: true,
              threadCount: 1,
            },
            unlock: {
              reason: "tutorial",
              unlockedAt: "2026-09-15T05:20:00Z",
              position: {
                x: star.x,
                y: star.y,
                depthZ: star.depthZ,
                layoutOrdinal: star.layoutOrdinal,
                layoutVersion: LAYOUT_VERSION,
              },
            },
            planets: {
              count: star.planetCount,
              completedWithoutPlanets: star.completedWithoutPlanets,
              items: Array.from({ length: star.planetCount }, (_, i) => ({
                candidateId: performanceFixture
                  ? `performance-215-${star.ticId}-${String(i).padStart(3, "0")}`
                  : "fixture-204-p-" + i,
                kind: i % 2 ? "unconfirmed" : "confirmed",
                periodDays: i ? 2 + i * 3.25 : null,
                depthPpm: i ? 300 + i * 100 : 0,
              })),
            },
          });
        }
        return reply(404, {
          code: "NOT_FOUND",
          message: "204 범위 밖의 개발 응답입니다.",
        });
      });
    },
  };
}

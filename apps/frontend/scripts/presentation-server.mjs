// Local visual review only. All data is synthetic and kept in memory.
// This entry point is never loaded by the production Vite configuration.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { galaxyFixturePlugin } from "../dev/galaxy-fixture-plugin.ts";
import { communityFixturePlugin } from "../dev/community-fixture-plugin.ts";
import { createProfileFixture } from "../dev/profile-fixture-plugin.ts";
import { hotTopicsFixturePlugin } from "../dev/hot-topics-fixture-plugin.ts";

const port = Number(process.env.PRESENTATION_PORT ?? 58381);
const starCount = 5000;
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = createProfileFixture();
const community = communityFixturePlugin({
  writable: true,
  commentWrites: true,
  reactionWrites: true,
  materialWrites: true,
  searchable: true,
  hotTopics: true,
  currentNickname: profile.nickname,
});
// Individual feature tests keep their banners; this preview measures product layout.
delete community.transformIndexHtml;

// The existing galaxy fixture handles unknown routes with a 404. Mount it only
// on its own routes so community/profile requests reach their fixture owner.
function galaxyRoutes(plugin) {
  return {
    name: "presentation-galaxy-routes",
    configureServer(server) {
      const wrapped = {
        ...server,
        middlewares: {
          use(mount, handler) {
            server.middlewares.use(mount, (req, res, next) => {
              const path = new URL(req.url ?? "/", "http://localhost").pathname;
              if (
                !/^\/v1\/(me\/(sky|stars|quests)(\/|$)|challenges\/current$)/.test(
                  path,
                ) &&
                !path.startsWith("/dev-galaxy-204/")
              )
                return next();
              Promise.resolve(handler(req, res, next)).catch(next);
            });
          },
        },
      };
      return plugin.configureServer.call(this, wrapped);
    },
  };
}
const server = await createServer({
  root,
  configFile: false,
  cacheDir: `node_modules/.vite-presentation-${port}`,
  mode: "presentation",
  plugins: [
    react(),
    {
      name: "presentation-member",
      configureServer(server) {
        server.middlewares.use("/api", (req, res, next) => {
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          if (req.method !== "GET" || path !== "/v1/me") return next();
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Planetory-Data": "synthetic-preview-only",
          });
          res.end(
            JSON.stringify({
              memberId: "u-209",
              nickname: profile.nickname(),
              joinedAt: "2026-09-01T00:00:00Z",
              role: "MEMBER",
              starListVisibility: "PUBLIC",
              onboardingDone: true,
              tutorialCompleted: true,
              achievementSummary: {
                discoveredStarCount: starCount,
                completedStarCount: 5,
                signalCount: 7,
                byType: { confirmed: 7, unconfirmed: 0, fp: 0 },
                starCountByGrade: { A: 1, S: 0, SS: 1, SSS: 0 },
              },
            }),
          );
        });
      },
    },
    profile.plugin,
    hotTopicsFixturePlugin(),
    galaxyRoutes(galaxyFixturePlugin(false, starCount)),
    community,
  ],
  define: Object.fromEntries(
    Object.entries({
      VITE_API_BASE: "/api",
      VITE_SKY_RENDERER_ENABLED: "true",
      VITE_FIXTURE: "false",
      VITE_GALAXY_FIXTURE: "false",
      VITE_INTERACTION_FIXTURE: "false",
      VITE_SKY_DATA_FIXTURE: "false",
      VITE_OBSERVATIONS: "false",
    }).map(([key, value]) => ["import.meta.env." + key, JSON.stringify(value)]),
  ),
  server: { host: "127.0.0.1", port, strictPort: true },
});
await server.listen();
for (let seq = 1; seq <= 5; seq++) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/dev-galaxy-204/complete-tutorial?seq=${seq}`,
    { method: "POST" },
  );
  if (!response.ok) {
    await server.close();
    throw new Error("Cannot seed local tutorial fixture");
  }
}
console.log(
  `248 화면 검토용 · 메모리 임시 별 ${starCount}개 · 실제 OAuth/DB 연동 아님: http://127.0.0.1:${port}/sky`,
);

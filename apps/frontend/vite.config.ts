import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

function unavailableApi(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(503, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "서버 연결이 아직 준비되지 않았습니다.",
    }),
  );
}

export default defineConfig(async ({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const fixture =
    command === "serve" &&
    !isPreview &&
    ["fixture", "observations"].includes(mode);
  const observations = fixture && mode === "observations";
  const authFixture = command === "serve" && !isPreview && mode === "auth";
  const skyFixture = command === "serve" && !isPreview && mode === "sky-data";
  const galaxyFixture =
    command === "serve" &&
    !isPreview &&
    ["galaxy", "interaction"].includes(mode);
  const communityFixture =
    command === "serve" &&
    !isPreview &&
    [
      "community",
      "posts",
      "comments",
      "reactions",
      "materials",
      "profiles",
      "settings",
      "search",
      "hot-topics",
    ].includes(mode);
  const profileFixture =
    command === "serve" && !isPreview && ["profiles", "settings"].includes(mode)
      ? (await import("./dev/profile-fixture-plugin.ts")).createProfileFixture()
      : null;
  const testing =
    fixture || authFixture || skyFixture || galaxyFixture || communityFixture;
  const target = process.env.API_PROXY_TARGET ?? env.API_PROXY_TARGET;
  const proxy = target
    ? Object.fromEntries(
        ["/api", "/oauth2", "/login/oauth2"].map((path) => [
          path,
          {
            target,
            changeOrigin: false,
            configure(proxy: import("vite").HttpProxy.ProxyServer) {
              proxy.on("proxyRes", (response, request) => {
                if (
                  request.url?.startsWith("/login/oauth2/code/") &&
                  [401, 403, 503].includes(response.statusCode ?? 0)
                ) {
                  response.statusCode = 302;
                  const cancelled =
                    new URL(request.url, "http://localhost").searchParams.get(
                      "error",
                    ) === "access_denied";
                  response.headers.location =
                    "/oauth/callback?error=" +
                    (cancelled ? "access_denied" : "authentication_failed");
                  response.headers["cache-control"] = "no-store";
                }
              });
            },
          },
        ]),
      )
    : undefined;
  return {
    plugins: [
      react(),
      ...(communityFixture && mode === "settings"
        ? [
            (
              await import("./dev/settings-fixture-plugin.ts")
            ).settingsFixturePlugin(),
          ]
        : []),
      ...(communityFixture && mode === "hot-topics"
        ? [
            (
              await import("./dev/hot-topics-fixture-plugin.ts")
            ).hotTopicsFixturePlugin(),
          ]
        : []),
      ...(profileFixture ? [profileFixture.plugin] : []),
      ...(mode === "profiles"
        ? [
            (
              await import("./dev/my-lists-fixture-plugin.ts")
            ).myListsFixturePlugin(),
          ]
        : []),
      ...(communityFixture
        ? [
            (
              await import("./dev/community-fixture-plugin.ts")
            ).communityFixturePlugin({
              writable: [
                "posts",
                "comments",
                "reactions",
                "materials",
                "profiles",
              ].includes(mode),
              commentWrites: [
                "comments",
                "reactions",
                "materials",
                "profiles",
              ].includes(mode),
              reactionWrites: ["reactions", "materials", "profiles"].includes(
                mode,
              ),
              materialWrites: ["materials", "profiles"].includes(mode),
              currentNickname: profileFixture?.nickname,
              searchable: mode === "search",
              hotTopics: mode === "hot-topics",
            }),
          ]
        : []),
      ...(fixture
        ? [
            (await import("./dev/fixture-plugin.ts")).fixturePlugin(
              observations,
            ),
          ]
        : []),
      ...(authFixture
        ? [(await import("./dev/auth-fixture-plugin.ts")).authFixturePlugin()]
        : []),
      ...(skyFixture
        ? [(await import("./dev/sky-fixture-plugin.ts")).skyFixturePlugin()]
        : []),
      ...(galaxyFixture
        ? [
            (
              await import("./dev/legacy-galaxy/fixture.ts")
            ).legacyGalaxyFixturePlugin(),
            (
              await import("./dev/galaxy-fixture-plugin.ts")
            ).galaxyFixturePlugin(),
          ]
        : []),
      ...(!testing && !target
        ? [
            {
              name: "unconfigured-api",
              configureServer(server: import("vite").ViteDevServer) {
                server.middlewares.use("/api", unavailableApi);
              },
              configurePreviewServer(server: import("vite").PreviewServer) {
                server.middlewares.use("/api", unavailableApi);
              },
            },
          ]
        : []),
    ],
    define: {
      "import.meta.env.VITE_OBSERVATIONS": JSON.stringify(
        observations ? "true" : "false",
      ),
      "import.meta.env.VITE_INTERACTION_FIXTURE": JSON.stringify(
        command === "serve" && !isPreview && mode === "interaction"
          ? "true"
          : "false",
      ),
      "import.meta.env.VITE_GALAXY_FIXTURE": JSON.stringify(
        galaxyFixture ? "true" : "false",
      ),
      "import.meta.env.VITE_SKY_DATA_FIXTURE": JSON.stringify(
        skyFixture ? "true" : "false",
      ),
      "import.meta.env.VITE_FIXTURE": JSON.stringify(
        fixture ? "true" : "false",
      ),
      ...(testing
        ? { "import.meta.env.VITE_API_BASE": JSON.stringify("/api") }
        : {}),
      ...(authFixture
        ? Object.fromEntries(
            Object.entries({
              VITE_OAUTH_SSAFY_URL: "/api/dev-auth-202/ssafy",
              VITE_OAUTH_GOOGLE_URL: "/api/dev-auth-202/google",
              VITE_CSRF_HEADER: "X-Fixture-202-CSRF",
              VITE_CSRF_COOKIE: "auth-fixture-202-csrf",
              VITE_NICKNAME_REQUIRED_CODE: "FIXTURE_NICKNAME_REQUIRED_202",
              VITE_INITIAL_NICKNAME_PATH: "/v1/me/profile",
            }).map(([key, value]) => [
              `import.meta.env.${key}`,
              JSON.stringify(value),
            ]),
          )
        : {}),
    },
    server: {
      proxy: !testing ? proxy : undefined,
    },
    preview: {
      proxy,
    },
    build: { target: ["chrome110", "edge110", "firefox115", "safari16.4"] },
  };
});

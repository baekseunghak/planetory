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
  const fixture = command === "serve" && !isPreview && mode === "fixture";
  const authFixture = command === "serve" && !isPreview && mode === "auth";
  const skyFixture = command === "serve" && !isPreview && mode === "sky-data";
  const galaxyFixture = command === "serve" && !isPreview && mode === "galaxy";
  const communityFixture =
    command === "serve" && !isPreview && mode === "community";
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
      ...(communityFixture
        ? [
            (
              await import("./dev/community-fixture-plugin.ts")
            ).communityFixturePlugin(),
          ]
        : []),
      ...(fixture
        ? [(await import("./dev/fixture-plugin.ts")).fixturePlugin()]
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

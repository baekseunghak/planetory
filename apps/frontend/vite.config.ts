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
  const target = process.env.API_PROXY_TARGET ?? env.API_PROXY_TARGET;
  const proxy = target
    ? Object.fromEntries(
        ["/api", "/oauth2", "/login/oauth2"].map((path) => [
          path,
          { target, changeOrigin: false },
        ]),
      )
    : undefined;
  return {
    plugins: [
      react(),
      ...(fixture
        ? [
            (await import("./dev/fixture-plugin.ts")).fixturePlugin(
              observations,
            ),
          ]
        : []),
      ...(!fixture && !target
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
      "import.meta.env.VITE_FIXTURE": JSON.stringify(
        fixture ? "true" : "false",
      ),
      ...(fixture
        ? { "import.meta.env.VITE_API_BASE": JSON.stringify("/api") }
        : {}),
    },
    server: {
      proxy: !fixture ? proxy : undefined,
    },
    preview: {
      proxy,
    },
    build: { target: ["chrome110", "edge110", "firefox115", "safari16.4"] },
  };
});

import { defineConfig } from "@playwright/test";
const dockerDefaults = process.env.FRONTEND_DOCKER_DEFAULTS === "1";
const port = dockerDefaults ? 58330 : 58264;
export default defineConfig({
  testDir: "./tests/production",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: dockerDefaults
    ? "test-results/docker-defaults"
    : "test-results/production",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run preview -- --port ${port}${dockerDefaults ? " --outDir dist/docker-defaults" : ""}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { API_PROXY_TARGET: "" },
  },
});

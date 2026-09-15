import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/renderer-production",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/renderer-production",
  use: {
    baseURL: "http://127.0.0.1:58274",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run build:renderer && npm run preview -- --port 58274",
    url: "http://127.0.0.1:58274",
    reuseExistingServer: false,
    env: { API_PROXY_TARGET: "" },
  },
});

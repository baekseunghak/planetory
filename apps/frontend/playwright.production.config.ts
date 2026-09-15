import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/production",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/production",
  use: {
    baseURL: "http://127.0.0.1:58264",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run preview -- --port 58264",
    url: "http://127.0.0.1:58264",
    reuseExistingServer: false,
    env: { API_PROXY_TARGET: "" },
  },
});

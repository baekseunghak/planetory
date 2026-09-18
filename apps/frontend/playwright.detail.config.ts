import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/detail",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/detail",
  use: {
    baseURL: "http://127.0.0.1:58336",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "msedge", use: { browserName: "chromium", channel: "msedge" } },
  ],
  webServer: {
    command: "npm run dev -- --mode interaction --port 58336 --strictPort",
    url: "http://127.0.0.1:58336",
    reuseExistingServer: false,
  },
});

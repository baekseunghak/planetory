import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:58262",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "msedge", use: { browserName: "chromium", channel: "msedge" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "npm run dev -- --mode fixture --port 58262 --strictPort",
    url: "http://127.0.0.1:58262",
    reuseExistingServer: false,
  },
});

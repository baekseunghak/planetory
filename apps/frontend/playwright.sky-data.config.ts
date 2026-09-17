import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/sky-data",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/sky-data",
  use: {
    baseURL: "http://127.0.0.1:58271",
    viewport: { width: 1440, height: 1000 },
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
    command: "npm run dev -- --mode sky-data --port 58271 --strictPort",
    url: "http://127.0.0.1:58271",
    reuseExistingServer: false,
  },
});

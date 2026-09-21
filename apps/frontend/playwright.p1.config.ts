import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/p1",
  outputDir: "test-results/p1",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:58393",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
  ],
  webServer: {
    command: "node --import tsx scripts/p1-server.mjs --test",
    url: "http://127.0.0.1:58393",
    reuseExistingServer: false,
  },
});

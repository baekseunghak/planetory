import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/presentation",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/presentation",
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
  ],
  use: {
    baseURL: "http://127.0.0.1:58405",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev:presentation",
    env: { PRESENTATION_PORT: "58405" },
    url: "http://127.0.0.1:58405",
    reuseExistingServer: false,
  },
});

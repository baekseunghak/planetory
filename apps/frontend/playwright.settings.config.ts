import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/settings",
  outputDir: "test-results/settings",
  workers: 1,
  retries: 0,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:58383",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --mode settings --port 58383 --strictPort",
    url: "http://127.0.0.1:58383",
    reuseExistingServer: false,
  },
});

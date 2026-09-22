import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/star-search",
  outputDir: "test-results/star-search",
  workers: 1,
  retries: 0,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:58385",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --mode interaction --port 58385 --strictPort",
    url: "http://127.0.0.1:58385",
    reuseExistingServer: false,
  },
});

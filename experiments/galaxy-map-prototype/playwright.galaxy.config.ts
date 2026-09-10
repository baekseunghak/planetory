import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/galaxy",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: "test-results/galaxy/artifacts",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/galaxy/results.json" }],
  ],
  // Tests own fresh state and separate ports; never reuse a user's demo server.
  webServer: [
    {
      command: "npm run api",
      url: "http://127.0.0.1:58246/api/session",
      env: {
        PORT: "58246",
        CLIENT_PORT: "58245",
        FIXTURE_RESET: "1",
        FIXTURE_STATE_PATH: ".local/galaxy-test/state.json",
      },
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 58245 --strictPort",
      url: "http://127.0.0.1:58245",
      env: { API_PROXY_TARGET: "http://127.0.0.1:58246" },
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:58245",
    channel: process.env.TEST_BROWSER || undefined,
    viewport: { width: 1680, height: 1050 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});

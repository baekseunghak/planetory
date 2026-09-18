import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/observations",
  workers: 1,
  reporter: "list",
  timeout: 30000,
  outputDir: "test-results/observations",
  use: {
    baseURL: "http://127.0.0.1:58265",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --mode observations --port 58265 --strictPort",
    url: "http://127.0.0.1:58265",
    reuseExistingServer: false,
  },
});

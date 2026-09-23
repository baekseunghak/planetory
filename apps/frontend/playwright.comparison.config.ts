import { defineConfig } from "@playwright/test";
import base from "./playwright.statistics.config";
export default defineConfig({
  ...base,
  testDir: "./tests/statistics",
  outputDir: "test-results/comparison",
  use: { ...base.use, baseURL: "http://127.0.0.1:58400" },
  webServer: {
    command: "npm run dev -- --mode profiles --port 58400 --strictPort",
    url: "http://127.0.0.1:58400",
    reuseExistingServer: !process.env.CI,
    env: { VITE_P1_ENABLED: "true" },
  },
});

import { defineConfig } from "@playwright/test";
import base from "./playwright.profiles.config";
export default defineConfig({
  ...base,
  testDir: "./tests/global-statistics",
  outputDir: "test-results/global-statistics",
  use: { ...base.use, baseURL: "http://127.0.0.1:58399" },
  webServer: {
    command: "npm run dev -- --mode profiles --port 58399 --strictPort",
    url: "http://127.0.0.1:58399",
    reuseExistingServer: !process.env.CI,
    env: { VITE_P1_ENABLED: "true" },
  },
});

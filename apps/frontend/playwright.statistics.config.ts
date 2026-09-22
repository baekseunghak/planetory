import { defineConfig } from "@playwright/test";
import base from "./playwright.profiles.config";
export default defineConfig({
  ...base,
  testDir: "./tests/statistics",
  outputDir: "test-results/statistics",
  use: { ...base.use, baseURL: "http://127.0.0.1:58398" },
  webServer: {
    command: "npm run dev -- --mode profiles --port 58398 --strictPort",
    url: "http://127.0.0.1:58398",
    reuseExistingServer: false,
    env: { VITE_P1_ENABLED: "true" },
  },
});

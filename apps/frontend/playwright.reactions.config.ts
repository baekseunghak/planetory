import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/reactions",
  outputDir: "test-results/reactions",
  use: { ...community.use, baseURL: "http://127.0.0.1:58353" },
  webServer: {
    command: "npm run dev -- --mode reactions --port 58353 --strictPort",
    url: "http://127.0.0.1:58353",
    reuseExistingServer: false,
  },
});

import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/comments",
  outputDir: "test-results/comments",
  use: { ...community.use, baseURL: "http://127.0.0.1:58351" },
  webServer: {
    command: "npm run dev -- --mode comments --port 58351 --strictPort",
    url: "http://127.0.0.1:58351",
    reuseExistingServer: false,
  },
});

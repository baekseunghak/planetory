import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/posts",
  outputDir: "test-results/posts",
  use: { ...community.use, baseURL: "http://127.0.0.1:58349" },
  webServer: {
    command: "npm run dev -- --mode posts --port 58349 --strictPort",
    url: "http://127.0.0.1:58349",
    reuseExistingServer: false,
  },
});

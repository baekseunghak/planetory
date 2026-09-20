import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/search",
  outputDir: "test-results/search",
  use: { ...community.use, baseURL: "http://127.0.0.1:58365" },
  webServer: {
    command: "npm run dev -- --mode search --port 58365 --strictPort",
    url: "http://127.0.0.1:58365",
    reuseExistingServer: false,
  },
});

import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/hot-topics",
  outputDir: "test-results/hot-topics",
  use: { ...community.use, baseURL: "http://127.0.0.1:58369" },
  webServer: {
    command: "npm run dev -- --mode hot-topics --port 58369 --strictPort",
    url: "http://127.0.0.1:58369",
    reuseExistingServer: false,
  },
});

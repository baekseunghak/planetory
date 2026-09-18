import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  testDir: "./tests/materials",
  outputDir: "test-results/materials",
  use: { ...community.use, baseURL: "http://127.0.0.1:58355" },
  webServer: {
    command: "npm run dev -- --mode materials --port 58355 --strictPort",
    url: "http://127.0.0.1:58355",
    reuseExistingServer: false,
  },
});

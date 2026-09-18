import { defineConfig } from "@playwright/test";
import production from "./playwright.production.config";

export default defineConfig({
  ...production,
  testDir: "./tests/performance",
  testMatch: "fold-performance.spec.ts",
  outputDir: "test-results/performance",
  timeout: 60_000,
});

import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/performance/gpu",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 120000,
  reporter: "list",
  outputDir: "test-results/gpu-results",
  use: {
    baseURL: "http://127.0.0.1:58265",
    browserName: "chromium",
    viewport: { width: 1200, height: 900 },
    launchOptions: { args: ["--use-angle=d3d11"] },
  },
  webServer: {
    command:
      "npx vite build --config tests/performance/gpu/vite.config.ts && npx vite preview --config tests/performance/gpu/vite.config.ts",
    url: "http://127.0.0.1:58265/tests/performance/gpu/index.html",
    reuseExistingServer: false,
  },
});

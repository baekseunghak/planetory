import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/gpu-app",
  workers: 1,
  timeout: 90000,
  reporter: "list",
  outputDir: "test-results/gpu-app",
  use: {
    baseURL: "http://127.0.0.1:58266",
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--use-angle=d3d11"] },
  },
  webServer: {
    command:
      "npx vite build --config tests/gpu-app/vite.config.ts && npx vite preview --config tests/gpu-app/vite.config.ts",
    url: "http://127.0.0.1:58266",
    reuseExistingServer: false,
  },
});

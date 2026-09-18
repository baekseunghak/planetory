import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/community",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/community",
  use: {
    baseURL: "http://127.0.0.1:58347",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
    { name: "msedge", use: { browserName: "chromium", channel: "msedge" } },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
        channel: "moz-firefox",
        launchOptions: {
          ...(process.env.FIREFOX_EXECUTABLE
            ? { executablePath: process.env.FIREFOX_EXECUTABLE }
            : {}),
        },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --mode community --port 58347 --strictPort",
    url: "http://127.0.0.1:58347",
    reuseExistingServer: false,
  },
});

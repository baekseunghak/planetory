import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/quests",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/quests",
  use: {
    baseURL: "http://127.0.0.1:58346",
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
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
          executablePath:
            process.env.FIREFOX_EXECUTABLE ||
            "C:/Program Files/Mozilla Firefox/firefox.exe",
        },
      },
    },
  ],
  webServer: {
    command: "npm run dev -- --mode interaction --port 58346 --strictPort",
    url: "http://127.0.0.1:58346",
    reuseExistingServer: false,
  },
});

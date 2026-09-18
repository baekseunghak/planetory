import { defineConfig } from "@playwright/test";
const port = Number(process.env.FRONTEND_TEST_PORT ?? 58346);
export default defineConfig({
  testDir: "./tests/quests",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  outputDir: "test-results/quests",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
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
    command: `npm run dev -- --mode interaction --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});

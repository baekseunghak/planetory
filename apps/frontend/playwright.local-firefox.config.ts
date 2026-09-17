import { defineConfig } from "@playwright/test";
import foundation from "./playwright.config";

// Optional stock Firefox BiDi route when the bundled Firefox cannot start.
// Reuses the foundation suite; install Firefox before running this config.
export default defineConfig({
  ...foundation,
  outputDir: "test-results/stock-firefox",
  projects: [
    {
      name: "stock-firefox",
      use: {
        browserName: "firefox",
        channel: "moz-firefox",
        launchOptions: process.env.FIREFOX_EXECUTABLE
          ? { executablePath: process.env.FIREFOX_EXECUTABLE }
          : {},
      },
    },
  ],
});

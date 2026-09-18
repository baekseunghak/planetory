import { defineConfig } from "@playwright/test";
import community from "./playwright.community.config";
export default defineConfig({
  ...community,
  projects: community.projects?.map((project) =>
    project.name !== "firefox"
      ? project
      : {
          ...project,
          use: {
            ...project.use,
            launchOptions: {
              ...project.use?.launchOptions,
              // Official Firefox BiDi does not apply reducedMotion emulation here.
              // Test the real browser preference instead of replacing matchMedia.
              firefoxUserPrefs: { "ui.prefersReducedMotion": 1 },
            },
          },
        },
  ),
  testDir: "./tests/profiles",
  outputDir: "test-results/profiles",
  use: { ...community.use, baseURL: "http://127.0.0.1:58357" },
  webServer: {
    command: "npm run dev -- --mode profiles --port 58357 --strictPort",
    url: "http://127.0.0.1:58357",
    reuseExistingServer: false,
  },
});

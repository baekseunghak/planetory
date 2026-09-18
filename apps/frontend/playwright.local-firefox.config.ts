import { defineConfig } from "@playwright/test";
import foundation from "./playwright.config";
import auth from "./playwright.auth.config";
import data from "./playwright.sky-data.config";
import galaxy from "./playwright.galaxy.config";
import interaction from "./playwright.interaction.config";

// Optional stock Firefox BiDi route for Windows installations where the bundled
// patched Firefox cannot launch. Reuses the existing feature tests unchanged.
const suites = { foundation, auth, data, galaxy, interaction };
const suite = process.env.FRONTEND_SUITE ?? "foundation";
if (!(suite in suites)) throw new Error("Unknown FRONTEND_SUITE: " + suite);
const base = suites[suite as keyof typeof suites];
export default defineConfig({
  ...base,
  outputDir: `test-results/local-firefox/${suite}`,
  projects: [
    {
      name: "stock-firefox",
      use: {
        browserName: "firefox",
        channel: "moz-firefox",
        launchOptions: {
          ...(process.env.FIREFOX_EXECUTABLE
            ? { executablePath: process.env.FIREFOX_EXECUTABLE }
            : {}),
          ...(process.env.FIREFOX_REDUCED_MOTION === "1"
            ? { firefoxUserPrefs: { "ui.prefersReducedMotion": 1 } }
            : {}),
        },
      },
    },
  ],
});

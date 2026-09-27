import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  analysisVariantFromBuild,
  parseAnalysisVariant,
  planAnalysisVariant,
} from "../../src/cinema/analysis/variant";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("the new design unless VITE_CINEMA_ANALYSIS=classic", () => {
  assert.equal(analysisVariantFromBuild("classic"), "classic");
  // Production builds do not set it: the new design. So does anything else.
  for (const value of [
    undefined,
    null,
    "",
    "new",
    "cinematic",
    "CLASSIC",
    " classic",
    "a",
    "0",
  ])
    assert.equal(analysisVariantFromBuild(value), "cinematic", String(value));
});

test("members get the build's variant and never the toggle", () => {
  for (const stored of [null, "classic", "cinematic", "junk"]) {
    for (const build of [undefined, "new", ""])
      assert.deepEqual(
        planAnalysisVariant({ build, devTools: false, stored }),
        { variant: "cinematic", toggle: false },
      );
    assert.deepEqual(
      planAnalysisVariant({ build: "classic", devTools: false, stored }),
      { variant: "classic", toggle: false },
    );
  }
});

test("developer tools show the toggle; a stored choice wins", () => {
  assert.deepEqual(
    planAnalysisVariant({ build: undefined, devTools: true, stored: null }),
    { variant: "cinematic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({ build: "classic", devTools: true, stored: null }),
    { variant: "classic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({
      build: undefined,
      devTools: true,
      stored: "classic",
    }),
    { variant: "classic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({ build: "classic", devTools: true, stored: "junk" }),
    { variant: "classic", toggle: true },
  );
  assert.equal(parseAnalysisVariant("cinematic"), "cinematic");
  assert.equal(parseAnalysisVariant("new"), null);
});

test("the demo server defines VITE_CINEMA_ANALYSIS from CINEMA_ANALYSIS (new by default)", () => {
  const server = source("scripts/cinema-server.mjs");
  assert.match(server, /process\.env\.CINEMA_ANALYSIS/);
  assert.match(server, /\.trim\(\)\.toLowerCase\(\) \|\| "new"/);
  assert.match(server, /VITE_CINEMA_ANALYSIS: analysis/);
  assert.match(server, /\["classic", "new"\]\.includes\(analysis\)/);
});

test("the route reads build constants only (production: new design, no toggle)", () => {
  // Literal comparisons, so a build without the variables drops the toggle
  // and the classic variant; the same rule as analysisVariantFromBuild.
  const tools = source("src/cinema/analysis/dev-tools.ts");
  assert.match(
    tools,
    /import\.meta\.env\.DEV && import\.meta\.env\.VITE_CINEMA_DEV_TOOLS === "true"/,
  );
  assert.match(tools, /import\.meta\.env\.VITE_CINEMA_ANALYSIS === "classic"/);
  const route = source("src/cinema/analysis/AnalysisSwitch.tsx");
  const member = route.slice(route.indexOf("export function AnalysisSwitch"));
  assert.match(member, /if \(cinemaDevTools\)\s+return <DevAnalysisSwitch/);
  assert.match(
    member,
    /return cinemaAnalysisClassic \? \(\s*<ClassicAnalysis key="classic" \/>\s*\) : \(\s*<CinematicAnalysis key="cinematic" \/>/,
  );
  // A stored toggle choice is read only with developer tools.
  assert.doesNotMatch(
    member.slice(0, member.indexOf("function DevAnalysisSwitch")),
    /readStored|localStorage/,
  );
});

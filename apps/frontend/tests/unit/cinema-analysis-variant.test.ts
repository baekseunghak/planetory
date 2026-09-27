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

test("only VITE_CINEMA_ANALYSIS=new selects the new design", () => {
  assert.equal(analysisVariantFromBuild("new"), "cinematic");
  assert.equal(analysisVariantFromBuild(true), "cinematic");
  // Production builds do not set it; anything else stays classic.
  for (const value of [
    undefined,
    null,
    false,
    "",
    "classic",
    "cinematic",
    "NEW",
    " new",
    "b",
    "1",
  ])
    assert.equal(analysisVariantFromBuild(value), "classic", String(value));
});

test("members get the build's variant and never the toggle", () => {
  for (const stored of [null, "classic", "cinematic", "junk"]) {
    for (const build of [undefined, "classic", false])
      assert.deepEqual(
        planAnalysisVariant({ build, devTools: false, stored }),
        { variant: "classic", toggle: false },
      );
    for (const build of ["new", true])
      assert.deepEqual(
        planAnalysisVariant({ build, devTools: false, stored }),
        { variant: "cinematic", toggle: false },
      );
  }
});

test("developer tools show the toggle; a stored choice wins", () => {
  assert.deepEqual(
    planAnalysisVariant({ build: undefined, devTools: true, stored: null }),
    { variant: "classic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({ build: "new", devTools: true, stored: null }),
    { variant: "cinematic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({ build: true, devTools: true, stored: "classic" }),
    { variant: "classic", toggle: true },
  );
  assert.deepEqual(
    planAnalysisVariant({ build: "classic", devTools: true, stored: "junk" }),
    { variant: "classic", toggle: true },
  );
  assert.equal(parseAnalysisVariant("cinematic"), "cinematic");
  assert.equal(parseAnalysisVariant("new"), null);
});

test("the demo server defines VITE_CINEMA_ANALYSIS from CINEMA_ANALYSIS", () => {
  const server = source("scripts/cinema-server.mjs");
  assert.match(server, /process\.env\.CINEMA_ANALYSIS/);
  assert.match(server, /\.trim\(\)\.toLowerCase\(\) \|\| "classic"/);
  assert.match(server, /VITE_CINEMA_ANALYSIS: analysis/);
  assert.match(server, /\["classic", "new"\]\.includes\(analysis\)/);
});

test("the route reads build constants only (production: classic, no toggle)", () => {
  // Literal comparisons, so a build without the variables drops the toggle
  // and variant B; the same rule as analysisVariantFromBuild.
  const tools = source("src/cinema/analysis/dev-tools.ts");
  assert.match(
    tools,
    /import\.meta\.env\.DEV && import\.meta\.env\.VITE_CINEMA_DEV_TOOLS === "true"/,
  );
  assert.match(tools, /import\.meta\.env\.VITE_CINEMA_ANALYSIS === "new"/);
  const route = source("src/cinema/analysis/AnalysisSwitch.tsx");
  const member = route.slice(route.indexOf("export function AnalysisSwitch"));
  assert.match(member, /if \(cinemaDevTools\)\s+return <DevAnalysisSwitch/);
  assert.match(
    member,
    /return cinemaAnalysisNew \? \(\s*<CinematicAnalysis key="cinematic" \/>\s*\) : \(\s*<ClassicAnalysis key="classic" \/>/,
  );
  // A stored toggle choice is read only with developer tools.
  assert.doesNotMatch(
    member.slice(0, member.indexOf("function DevAnalysisSwitch")),
    /readStored|localStorage/,
  );
});

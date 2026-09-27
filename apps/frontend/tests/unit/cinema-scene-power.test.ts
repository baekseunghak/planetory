import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  POWER_DPR,
  POWER_STORAGE_KEY,
  PowerMonitor,
  decidePower,
  driftInterval,
  effectsFor,
  forgetPower,
  initialPower,
  lowerLevel,
  median,
  parseRememberedPower,
  readForcedPower,
  readRememberedPower,
  rememberPower,
  startingPower,
  type PowerAction,
  type PowerTier,
} from "../../src/cinema/scene/power";

// Weak graphics: detect software WebGL at start, watch the frame rate while
// the galaxy is at rest, step down once per slow window, never back up.

const session = new Map<string, string>();
beforeEach(() => session.clear());
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (key: string) => session.get(key) ?? null,
  setItem: (key: string, value: string) => void session.set(key, value),
  removeItem: (key: string) => void session.delete(key),
};

const SWIFTSHADER =
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";

test("software WebGL starts at the low tier; a real GPU at full", () => {
  for (const renderer of [
    SWIFTSHADER,
    "llvmpipe (LLVM 15.0.7, 256 bits)",
    "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)",
  ])
    assert.deepEqual(initialPower({ renderer }), {
      level: "low",
      software: true,
      pinned: false,
    });
  for (const renderer of [
    "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "",
    null,
  ])
    assert.deepEqual(initialPower({ renderer }), {
      level: "full",
      software: false,
      pinned: false,
    });
});

test("a level kept in this tab only lowers the start, a pin or auto overrides", () => {
  const intel = "ANGLE (Intel, Intel(R) UHD Graphics 620)";
  const kept = (level: "reduced" | "low" | "list") => ({
    level,
    pinned: false,
  });
  assert.equal(
    initialPower({ renderer: intel, remembered: kept("reduced") }).level,
    "reduced",
  );
  // Never back up: software stays low even if the tab kept `reduced`.
  assert.equal(
    initialPower({ renderer: SWIFTSHADER, remembered: kept("reduced") }).level,
    "low",
  );
  assert.equal(
    initialPower({ renderer: intel, remembered: kept("list") }).level,
    "list",
  );
  // ?power=full pins even software WebGL (a demo on a known machine).
  assert.deepEqual(initialPower({ renderer: SWIFTSHADER, forced: "full" }), {
    level: "full",
    software: true,
    pinned: true,
  });
  assert.equal(
    initialPower({ renderer: intel, forced: "auto", remembered: kept("low") })
      .level,
    "full",
  );
  assert.equal(
    initialPower({
      renderer: intel,
      remembered: { level: "reduced", pinned: true },
    }).pinned,
    true,
  );
});

test("?power= and the kept value parse strictly", () => {
  assert.equal(readForcedPower("?power=low"), "low");
  assert.equal(readForcedPower("?star=900000003&power=list"), "list");
  assert.equal(readForcedPower("?power=auto"), "auto");
  assert.equal(readForcedPower("?power=turbo"), null);
  assert.equal(readForcedPower(""), null);
  assert.deepEqual(parseRememberedPower("pin:full"), {
    level: "full",
    pinned: true,
  });
  assert.deepEqual(parseRememberedPower("reduced"), {
    level: "reduced",
    pinned: false,
  });
  assert.equal(parseRememberedPower("pin:ultra"), null);
  assert.equal(parseRememberedPower(null), null);
  assert.equal(lowerLevel("full", "low"), "low");
  assert.equal(lowerLevel("list", "reduced"), "list");
});

test("the tab keeps a step, a pin from the URL, and forgets on auto", () => {
  rememberPower("reduced");
  assert.deepEqual(readRememberedPower(), { level: "reduced", pinned: false });
  assert.equal(startingPower("", "ANGLE (Intel)").level, "reduced");
  // A later page of the tab without the parameter keeps the pin.
  assert.equal(startingPower("?power=full", "ANGLE (Intel)").pinned, true);
  assert.equal(session.get(POWER_STORAGE_KEY), "pin:full");
  assert.deepEqual(startingPower("", SWIFTSHADER), {
    level: "full",
    software: true,
    pinned: true,
  });
  assert.equal(startingPower("?power=auto", SWIFTSHADER).level, "low");
  assert.equal(session.has(POWER_STORAGE_KEY), false);
  rememberPower("list");
  forgetPower();
  assert.equal(readRememberedPower(), null);
});

test("tiers: DPR caps, default effects and slower frames while drifting", () => {
  assert.deepEqual(POWER_DPR, { full: 1.75, reduced: 1, low: 0.5 });
  assert.equal(effectsFor("full", null), true);
  assert.equal(effectsFor("reduced", null), false);
  assert.equal(effectsFor("low", null), false);
  // The member's explicit choice holds on every tier.
  assert.equal(effectsFor("low", true), true);
  assert.equal(effectsFor("full", false), false);
  assert.equal(driftInterval("full", "backdrop"), 30);
  assert.equal(driftInterval("low", "backdrop"), 45);
  assert.equal(driftInterval("full", "intro"), 0);
  assert.equal(driftInterval("reduced", "intro"), 30);
  for (const mode of ["galaxy", "system", "analysis", "transit"] as const)
    assert.equal(driftInterval("low", mode), 0, mode);
});

test("one step down per slow window: full, reduced, low, list", () => {
  const at = (tier: PowerTier, effects: boolean) => ({ tier, effects });
  assert.equal(decidePower(58, at("full", true)), null);
  assert.equal(decidePower(24, at("full", true)), null);
  assert.equal(decidePower(20, at("full", true)), "reduced");
  // The member's own effects choice is not overridden, only the tier moves.
  assert.equal(decidePower(20, at("reduced", true)), "low");
  assert.equal(decidePower(20, at("reduced", false)), "low");
  assert.equal(decidePower(3, at("low", true)), null);
  // At low with effects off only a truly unusable rate goes to the list.
  assert.equal(decidePower(15, at("low", false)), null);
  assert.equal(decidePower(8, at("low", false)), "list");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

/** Frames every `ms` from `t0` for `span` ms; returns the first action. */
function run(
  monitor: PowerMonitor,
  t0: number,
  span: number,
  ms: number,
  context: { tier: PowerTier; effects: boolean },
  measurable = true,
): { action: PowerAction | null; at: number; end: number } {
  let t = t0;
  for (; t <= t0 + span; t += ms) {
    const action = monitor.frame(t, measurable, context);
    if (action) return { action, at: t, end: t };
  }
  return { action: null, at: -1, end: t };
}

test("a steady 60 fps never steps down; a steady 15 fps does after grace + window", () => {
  const full = { tier: "full" as const, effects: true };
  const fast = new PowerMonitor();
  fast.hold(0);
  assert.equal(run(fast, 0, 20000, 1000 / 60, full).action, null);
  const slow = new PowerMonitor();
  slow.hold(0);
  const step = run(slow, 0, 20000, 1000 / 15, full);
  assert.equal(step.action, "reduced");
  // 2 s grace, then a 3 s window.
  assert.ok(step.at >= 5000 && step.at < 5200, String(step.at));
});

test("flights, other modes and stalls are never measured", () => {
  const full = { tier: "full" as const, effects: true };
  const monitor = new PowerMonitor();
  // 10 s of slow frames that are all flights: nothing.
  assert.equal(run(monitor, 0, 10000, 100, full, false).action, null);
  // A few seconds of slow frames interrupted by flights every 2.5 s: the
  // window never fills.
  let t = 10000;
  for (let i = 0; i < 6; i++) {
    const at = run(monitor, t, 2400, 100, full).end;
    t = run(monitor, at, 200, 100, full, false).end;
  }
  assert.equal(run(monitor, t, 1500, 100, full).action, null);
  // A tab switch (one 30 s gap) is a stall, not a frame rate.
  const stalled = new PowerMonitor();
  stalled.hold(0);
  run(stalled, 0, 2500, 16, full);
  assert.equal(stalled.frame(32500, true, full), null);
  assert.equal(run(stalled, 32516, 2500, 16, full).action, null);
});

test("occasional long frames do not move the median", () => {
  const monitor = new PowerMonitor();
  monitor.hold(0);
  const full = { tier: "full" as const, effects: true };
  let t = 0;
  for (let i = 0; i < 600; i++) {
    t += i % 10 === 0 ? 250 : 16.7; // a 250 ms hitch every tenth frame
    assert.equal(monitor.frame(t, true, full), null);
  }
});

test("at low without effects only 5 s under 10 fps switches to the list", () => {
  const low = { tier: "low" as const, effects: false };
  const ok = new PowerMonitor();
  ok.hold(0);
  assert.equal(run(ok, 0, 20000, 1000 / 12, low).action, null);
  const dead = new PowerMonitor();
  dead.hold(0);
  const step = run(dead, 0, 20000, 1000 / 5, low);
  assert.equal(step.action, "list");
  assert.ok(step.at >= 6800 && step.at < 7400, String(step.at));
  // Effects the member turned on at low stay on: their choice, not the list.
  const lit = new PowerMonitor();
  lit.hold(0);
  assert.equal(
    run(lit, 0, 20000, 1000 / 5, { tier: "low", effects: true }).action,
    null,
  );
});

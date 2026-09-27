import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNoopSceneController,
  type SceneError,
  type SceneState,
  type StarPointer,
} from "../../src/cinema/scene/contract";
import {
  createSceneProxy,
  type SceneEngineLike,
} from "../../src/cinema/scene/proxy";
import type { SkyMeta, Star } from "../../src/features/sky-data/contracts";

/** Fake engine: the no-op state machine plus a call log and event hooks. */
function fakeEngine() {
  const base = createNoopSceneController();
  const calls: string[] = [];
  const hooks = {
    error: new Set<(e: SceneError) => void>(),
    hover: new Set<(p: StarPointer | null) => void>(),
  };
  let ready = false;
  const engine: SceneEngineLike = {
    ...base,
    getState: () => ({ ...base.getState(), ready }) as SceneState,
    setStars: (stars) => void calls.push(`setStars:${stars.length}`),
    setSystem: (system) =>
      void calls.push(`setSystem:${system?.ticId ?? null}`),
    setViewInset: (inset) => void calls.push(`inset:${inset.bottom}`),
    setAnalysisHint: (hint) =>
      void calls.push(`hint:${hint?.periodDays ?? null}`),
    setEffects: (on) => (calls.push(`effects:${on}`), base.setEffects(on)),
    focusStar: (tic) => (calls.push(`focusStar:${tic}`), base.focusStar(tic)),
    restore: (target) =>
      void calls.push(`restore:${target.mode}:${target.focusedTicId}`),
    dispose: () => void calls.push("dispose"),
    onError: (fn) => (hooks.error.add(fn), () => void hooks.error.delete(fn)),
    onStarHover: (fn) => (
      hooks.hover.add(fn),
      () => void hooks.hover.delete(fn)
    ),
  };
  return {
    engine,
    calls,
    hooks,
    markReady() {
      ready = true;
    },
  };
}

const meta = { version: "v1", starCount: 1 } as SkyMeta;
const star = { ticId: "900000001" } as Star;

test("before the engine loads the proxy keeps mode, focus and a stable snapshot", async () => {
  const { controller } = createSceneProxy();
  const first = controller.getState();
  assert.equal(controller.getState(), first, "stable snapshot");
  assert.equal(first.mode, "galaxy");
  let changes = 0;
  controller.subscribe(() => changes++);
  await controller.focusStar("900000010");
  assert.equal(controller.getState().mode, "system");
  controller.setMode("analysis");
  assert.equal(controller.getState().mode, "analysis");
  controller.focusPlanet("p-1");
  assert.equal(controller.getState().focusedPlanetId, "p-1");
  await controller.playTransit({
    periodDays: 11.7,
    depth: 0.008,
    durationHours: 2,
  });
  await controller.ignite("900001001");
  await controller.returnToGalaxy();
  assert.equal(controller.getState().focusedTicId, null);
  controller.setMode("system");
  assert.equal(
    controller.getState().mode,
    "galaxy",
    "system needs a focused star",
  );
  assert.equal(controller.projectStar("900000010"), null);
  assert.equal(changes, 4);
});

test("attach replays the latest data and restores the state instantly", () => {
  const proxy = createSceneProxy();
  const c = proxy.controller;
  c.setStars([star], meta);
  c.setStars([star, star], meta);
  c.setSystem({
    ticId: "900000001",
    version: "v1",
    position: { x: 0, y: 0, depthZ: 0, layoutOrdinal: 0 },
    planets: [],
  });
  c.setViewInset({ bottom: 320, right: 0 });
  c.setAnalysisHint({ periodDays: 11.7, strength: 1, selection: null });
  c.setEffects(false);
  void c.focusStar("900000001");
  c.setMode("analysis");
  const fake = fakeEngine();
  proxy.attach(fake.engine);
  assert.deepEqual(fake.calls, [
    "effects:false",
    "inset:320",
    "setStars:2",
    "setSystem:900000001",
    "hint:11.7",
    "restore:analysis:900000001",
  ]);
  // afterwards the proxy forwards and mirrors the engine
  void c.focusStar("900000008");
  assert.equal(fake.calls.at(-1), "focusStar:900000008");
  assert.equal(c.getState().focusedTicId, "900000008");
});

test("only an explicit effects choice is replayed; held stars wait for their ignition", async () => {
  const proxy = createSceneProxy();
  const c = proxy.controller;
  c.holdStars?.(["900001001", "900001002"]);
  // Ignited before the engine came (instant): no longer held.
  await c.ignite("900001002");
  const fake = fakeEngine();
  fake.engine.holdStars = (ids) =>
    void fake.calls.push(`hold:${ids === null ? "null" : ids.join(",")}`);
  proxy.attach(fake.engine);
  // No setEffects call yet: the engine's power tier decides, the proxy's
  // default (on) must not override it.
  assert.equal(
    fake.calls.some((call) => call.startsWith("effects:")),
    false,
  );
  assert.deepEqual(
    fake.calls.filter((call) => call.startsWith("hold:")),
    ["hold:900001001"],
  );
  c.holdStars?.(null);
  assert.equal(fake.calls.at(-1), "hold:null");
  // A member's choice goes through and is replayed to the next engine.
  c.setEffects(true);
  assert.equal(fake.calls.at(-1), "effects:true");
  proxy.detach();
  const next = fakeEngine();
  proxy.attach(next.engine);
  assert.equal(next.calls[0], "effects:true");
});

test("engine events reach listeners registered before attach; errors mark failure", async () => {
  const proxy = createSceneProxy();
  const hovered: (string | null)[] = [];
  const errors: SceneError[] = [];
  proxy.controller.onStarHover((p) => hovered.push(p?.ticId ?? null));
  proxy.controller.onError((e) => errors.push(e));
  const fake = fakeEngine();
  proxy.attach(fake.engine);
  const screen = { x: 1, y: 2, depth: 3, radius: 6, visible: true };
  fake.hooks.hover.forEach((fn) => fn({ ticId: "900000003", screen }));
  fake.hooks.error.forEach((fn) =>
    fn({ message: "잠시 끊김", recoverable: true }),
  );
  assert.equal(
    proxy.controller.getState().failed,
    null,
    "recoverable is not a failure",
  );
  fake.hooks.error.forEach((fn) => fn({ message: "끊김", recoverable: false }));
  assert.equal(proxy.controller.getState().failed, "끊김");
  proxy.detach();
  assert.deepEqual(hovered, ["900000003", null], "detach clears the hover");
  assert.equal(errors.length, 2);
  // a late onError subscriber still learns about the failure
  const late: SceneError[] = [];
  proxy.controller.onError((e) => late.push(e));
  await Promise.resolve();
  assert.equal(late[0]?.recoverable, false);
});

test("fail() without an engine resolves everything and reports once", async () => {
  const proxy = createSceneProxy();
  const errors: SceneError[] = [];
  proxy.controller.onError((e) => errors.push(e));
  proxy.fail("WebGL 없음");
  assert.equal(proxy.controller.getState().failed, "WebGL 없음");
  assert.equal(errors.length, 1);
  await proxy.controller.focusStar("900000001");
  await proxy.controller.playIntro();
  assert.equal(proxy.controller.getState().failed, "WebGL 없음");
});

test("onReady fires for late subscribers once the engine drew a frame", async () => {
  const proxy = createSceneProxy();
  const fake = fakeEngine();
  fake.markReady();
  proxy.attach(fake.engine);
  let ready = 0;
  proxy.controller.onReady(() => ready++);
  await Promise.resolve();
  assert.equal(ready, 1);
});

test("a login fly-in asked for before the engine loads plays once it attaches", async () => {
  const proxy = createSceneProxy();
  proxy.controller.setMode("intro");
  await proxy.controller.playIntro();
  assert.equal(proxy.controller.getState().mode, "galaxy");
  const fake = fakeEngine();
  fake.engine.playIntro = () => {
    fake.calls.push("playIntro");
    return Promise.resolve();
  };
  proxy.attach(fake.engine);
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith("restore") || c === "playIntro"),
    ["restore:intro:null", "playIntro"],
  );
});

test("a camera move after the early fly-in replaces it", async () => {
  const proxy = createSceneProxy();
  proxy.controller.setMode("intro");
  await proxy.controller.playIntro();
  await proxy.controller.focusStar("900000010");
  const fake = fakeEngine();
  fake.engine.playIntro = () => {
    fake.calls.push("playIntro");
    return Promise.resolve();
  };
  proxy.attach(fake.engine);
  assert.deepEqual(
    fake.calls.filter((c) => c.startsWith("restore") || c === "playIntro"),
    ["restore:system:900000010"],
  );
});

test("the home frame (tutorial markers to keep in view) goes through and is replayed before the stars", () => {
  const proxy = createSceneProxy();
  const c = proxy.controller;
  const frame = {
    ticIds: ["900000001", "900000004"],
    margin: { top: 121, right: 63, bottom: 124, left: 63 },
  };
  c.setHomeFrame?.(frame);
  c.setStars([star], meta);
  const fake = fakeEngine();
  fake.engine.setHomeFrame = (next) =>
    void fake.calls.push(`frame:${next ? next.ticIds.join(",") : "null"}`);
  proxy.attach(fake.engine);
  // Before setStars: the stars' first placement already keeps them in.
  assert.deepEqual(
    fake.calls.filter((call) => /^(frame|setStars)/.test(call)),
    ["frame:900000001,900000004", "setStars:1"],
  );
  c.setHomeFrame?.(null);
  assert.equal(fake.calls.at(-1), "frame:null");
  proxy.detach();
  const next = fakeEngine();
  next.engine.setHomeFrame = (value) =>
    void next.calls.push(`frame:${value ? "set" : "null"}`);
  proxy.attach(next.engine);
  assert.equal(next.calls.includes("frame:null"), true);
});

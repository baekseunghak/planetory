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

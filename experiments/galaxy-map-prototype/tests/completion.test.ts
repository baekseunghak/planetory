import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store";
import { readAnalysisView } from "../shared/analysis-contract";
import { nextTutorialStep, TUTORIAL_EVENTS } from "../shared/tutorial";
import { budgetFailures } from "../shared/performance-budget";
import { MapTelemetry } from "../src/map/telemetry";

test("DEC-16 performance gate rejects threshold excess, missing baseline, NaN and exact 20% regression", () => {
  const r = {
    count: 100000,
    scene: "home",
    p95: 12,
    worst: 20,
    firstDisplayMs: 500,
    heapMB: 50,
    drawCalls: 2,
    orbitStars: 60,
  };
  assert.deepEqual(budgetFailures([r]), []);
  assert.ok(budgetFailures([{ ...r, p95: 16.8 }]).length);
  assert.ok(budgetFailures([{ ...r, heapMB: NaN }]).length);
  assert.ok(budgetFailures([r], []).length);
  assert.ok(
    budgetFailures([r], [{ ...r, p95: 10 }]).some((s) =>
      s.includes("regression"),
    ),
  );
});
test("DEC-16 telemetry carries aggregate fields only and excludes hidden-tab intervals", (t) => {
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const oldDoc = Object.getOwnPropertyDescriptor(globalThis, "document"),
    oldWidth = Object.getOwnPropertyDescriptor(globalThis, "innerWidth");
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
  });
  Object.defineProperty(globalThis, "innerWidth", {
    value: 1440,
    configurable: true,
  });
  t.after(() => {
    if (oldDoc) Object.defineProperty(globalThis, "document", oldDoc);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldWidth) Object.defineProperty(globalThis, "innerWidth", oldWidth);
    else Reflect.deleteProperty(globalThis, "innerWidth");
  });
  const sent: object[] = [];
  const m = new MapTelemetry(true, (p) => sent.push(p));
  m.sample(1, 10);
  m.sample(18, 10);
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  // Background requestAnimationFrame can stop completely: no sample occurs here.
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  m.sample(100000, 25);
  m.sample(100016, 25);
  assert.equal(sent.length, 0);
  m.sample(160001, 25);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ["p95", "samples", "schema", "visibleCount", "widthBucket", "worst"].sort(),
  );
  const disabled = new MapTelemetry(false, (p) => sent.push(p));
  disabled.sample(200000, 1);
  disabled.sample(300000, 1);
  assert.equal(sent.length, 1);
  m.dispose();
  disabled.dispose();
});

test("HOME-09 guidance follows successful ordered events, never skips a stage", () => {
  assert.equal(nextTutorialStep(null, "peak_selected"), null);
  assert.equal(nextTutorialStep(1, "judgment_selected"), 1);
  let step: number | null = 0;
  for (const event of TUTORIAL_EVENTS) step = nextTutorialStep(step, event);
  assert.equal(step, null);
});
test("HIS-02 stores independent plot/folding state; bad ranges rejected and historical state immutable", () => {
  const s = new Store();
  s.addUser("contract", "계약검증");
  const view = readAnalysisView({
    periodogramViewport: { xMin: 1, xMax: 10, yMin: 0, yMax: 20 },
    folding: {
      phaseOrigin: "bundle_reference",
      timeSystem: "BTJD",
      phaseOffset: 0.25,
    },
  });
  const h = s.submit("contract", {
    starId: "259377017",
    period: 3.6,
    phaseStart: 0.95,
    phaseEnd: 1.05,
    judgment: "LIKELY_PLANET",
    analysisView: view,
    viewport: { x: 300, y: 400, zoom: 2 },
    requestId: "view",
  });
  assert.deepEqual(
    h.reproduction?.periodogramViewport,
    view.periodogramViewport,
  );
  assert.deepEqual(h.viewport, { x: 300, y: 400, zoom: 2 });
  view.periodogramViewport!.xMin = 9;
  s.state.bundleId = "fixture-new-v2";
  assert.equal(
    s.history("contract", h.id).reproduction?.periodogramViewport?.xMin,
    1,
  );
  assert.equal(s.history("contract", h.id).bundleId, "fixture-2026-09-v1");
  assert.equal(h.reproduction?.versions.residual, null);
  assert.throws(() =>
    readAnalysisView({
      periodogramViewport: { xMin: 4, xMax: 1, yMin: 0, yMax: 2 },
    }),
  );
  assert.throws(() =>
    readAnalysisView({
      folding: {
        phaseOrigin: "bundle_reference",
        timeSystem: "BTJD",
        phaseOffset: 1,
      },
    }),
  );
  assert.deepEqual(readAnalysisView(null), {
    periodogramViewport: null,
    folding: null,
  });
});
test("COM-19 destination inspection does not create/award; existing and hidden destinations agree with publish", () => {
  const s = new Store();
  s.addUser("contract", "계약검증");
  s.unlock("contract", "900000099", "challenge", null, null);
  const h = s.submit("contract", {
    starId: "900000099",
    period: 4.35,
    phaseStart: 0.2,
    phaseEnd: 0.3,
    judgment: "UNSURE",
    requestId: "dest",
  });
  // This fixture already has peer threads; remove only this isolated test's destination.
  s.state.posts = s.state.posts.filter((p) => p.signalId !== h.signalId);
  const before = structuredClone(s.state);
  const d = s.publicationDestinations("contract", h.starId)[0];
  assert.equal(d.status, "new");
  assert.equal(d.threadId, null);
  assert.deepEqual(s.state, before);
  const p = s.publish("contract", h.id);
  assert.equal(
    s.publicationDestinations("contract", h.starId)[0].threadId,
    p.threadId,
  );
  const card = s.sourceCard({ kind: "thread", id: p.threadId });
  assert.equal(card.signalSummary?.period, 4.35);
  assert.equal(card.signalSummary?.id, h.signalId);
  s.state.posts.find((x) => x.id === p.threadId)!.hidden = true;
  const hidden = s.publicationDestinations("contract", h.starId)[0];
  assert.equal(hidden.status, "unavailable");
  assert.equal(hidden.threadId, null);
  assert.equal(
    s.sourceCard({ kind: "thread", id: p.threadId }).signalSummary,
    undefined,
  );
  assert.throws(() => s.publish("contract", h.id));
});

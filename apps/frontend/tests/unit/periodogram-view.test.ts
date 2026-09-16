import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidatePeaksFixture,
  periodContextFixture,
  periodogramFixture,
  PERIODOGRAM_FIXTURE_TICS,
} from "../../dev/periodogram-fixtures";
import { decodeAnalysisContext } from "../../src/features/analysis/analysis-data";
import {
  decodeCandidatePeaks,
  decodePeriodogram,
} from "../../src/features/analysis/periodogram-data";
import {
  buildPeriodPlot,
  clampPeriodView,
  drawPeriodogram,
  FULL_PERIOD_VIEW,
  indexAtFraction,
  periodAtFraction,
  periodFraction,
  periodViewBounds,
  zoomPeriodView,
} from "../../src/features/analysis/periodogram-view";

const context = decodeAnalysisContext(
  periodContextFixture(),
  PERIODOGRAM_FIXTURE_TICS.normal,
);
const grid = decodePeriodogram(periodogramFixture(), context);
const candidates = decodeCandidatePeaks(candidatePeaksFixture(), context, grid);
test("plot keeps all 5000 periods and maps indices and actual log periods without changing source", () => {
  const original = JSON.stringify(grid),
    model = buildPeriodPlot(grid);
  assert.equal(model.periods.length, 5000);
  assert.equal(model.periods[0], 0.5);
  assert.equal(model.periods[4999], 40);
  for (const index of [0, 1, 1600, 2500, 3600, 4999]) {
    const fraction = periodFraction(grid, model.periods[index]);
    assert.equal(indexAtFraction(grid, fraction), index);
    assert.ok(
      Math.abs(periodAtFraction(grid, fraction) - model.periods[index]) < 1e-10,
    );
  }
  assert.equal(JSON.stringify(grid), original);
});
test("zoom keeps its anchor, clamps both boundaries, and reset has exact full coverage", () => {
  const anchor = 0.3,
    view = zoomPeriodView(FULL_PERIOD_VIEW, 4, anchor);
  const { low, high } = periodViewBounds(view);
  assert.ok(Math.abs(low + anchor * (high - low) - anchor) < 1e-12);
  assert.deepEqual(
    periodViewBounds(clampPeriodView({ zoom: 4, center: -100 })),
    { low: 0, high: 0.25 },
  );
  assert.deepEqual(
    periodViewBounds(clampPeriodView({ zoom: 4, center: 100 })),
    { low: 0.75, high: 1 },
  );
  assert.equal(clampPeriodView({ zoom: 10000, center: 0.5 }).zoom, 64);
  assert.deepEqual(periodViewBounds(FULL_PERIOD_VIEW), { low: 0, high: 1 });
});
test("constant and negative power retain finite plot geometry and reference boundaries may lie outside domain", () => {
  for (const value of [0, -2, 1]) {
    const model = buildPeriodPlot({
      ...grid,
      power: grid.power.map(() => value),
    });
    assert.ok(Number.isFinite(model.yMin) && Number.isFinite(model.yMax));
    assert.ok(model.yMax > model.yMin);
  }
  assert.ok(periodFraction(grid, 0.1) < 0);
  assert.ok(periodFraction(grid, 80) > 1);
});
test("Canvas draws every visible grid value, observation-limit shading and matched reference lines", () => {
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args: unknown[]) =>
          calls.push({ name: String(name), args }),
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  drawPeriodogram(
    ctx,
    buildPeriodPlot(grid),
    candidates,
    FULL_PERIOD_VIEW,
    800,
    280,
  );
  // Three separate paths: boundary, matched line, then all 5000 power points.
  assert.equal(calls.filter((call) => call.name === "lineTo").length, 5001);
  assert.equal(calls.filter((call) => call.name === "fillText").length, 3);
  const shade = calls.find((call) => call.name === "fillRect")!
    .args as number[];
  assert.ok(Math.abs(shade[0] - periodFraction(grid, 3.5) * 800) < 1e-10);
  for (const call of calls)
    for (const argument of call.args)
      if (typeof argument === "number") assert.ok(Number.isFinite(argument));
});

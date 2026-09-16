import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampFoldView,
  drawFoldedCurve,
  foldFluxDomain,
  fullFoldView,
  zoomFoldView,
} from "../../src/features/analysis/folded-curve";
import type { FoldPoint } from "../../src/features/analysis/fold-data";
const points: FoldPoint[] = [0, 1, 2].map((i) => ({
  btjd: 100 + i,
  flux: 1 - i / 100,
  segmentId: "sample",
  index: i,
  sector: 1,
}));

test("fold view has two cycles, pointer-preserving x zoom, bounded pan and maximum x32", () => {
  assert.deepEqual(clampFoldView({ zoom: 0.5, center: -10 }), fullFoldView);
  const ratio = 0.7;
  const next = zoomFoldView(fullFoldView, 2, ratio);
  const before = fullFoldView.center + (ratio - 0.5) * 2;
  const after = next.center + ((ratio - 0.5) * 2) / next.zoom;
  assert.ok(Math.abs(before - after) < 1e-12);
  assert.equal(zoomFoldView(next, 100).zoom, 32);
  assert.deepEqual(zoomFoldView(next, 0.01), fullFoldView);
  assert.deepEqual(clampFoldView({ zoom: 32, center: 100 }), {
    zoom: 32,
    center: 1.46875,
  });
  assert.deepEqual(clampFoldView({ zoom: 32, center: -100 }), {
    zoom: 32,
    center: -0.46875,
  });
});

test("fold zoom visits every power-of-two step up to 32 and reverses without moving its anchor", () => {
  let view = fullFoldView;
  for (const expected of [2, 4, 8, 16, 32, 32, 16, 8, 4, 2, 1, 1]) {
    const factor = expected > view.zoom || expected === 32 ? 2 : 0.5;
    view = zoomFoldView(view, factor);
    assert.equal(view.zoom, expected);
    assert.equal(view.center, 0.5);
  }
  const previous = { zoom: 16, center: 0.0125 };
  const ratio = 0.2;
  const next = zoomFoldView(previous, 2, ratio);
  assert.equal(next.zoom, 32);
  assert.ok(
    Math.abs(
      previous.center +
        ((ratio - 0.5) * 2) / previous.zoom -
        (next.center + ((ratio - 0.5) * 2) / next.zoom),
    ) < 1e-12,
  );
  assert.equal(zoomFoldView({ zoom: 32, center: 1.46875 }, 0.5).center, 1.4375);
});

test("Canvas repeats every point on two cycles without connecting gaps or rewriting scientific inputs", () => {
  const original = structuredClone(points),
    phases = new Float64Array([0, 0.5, 0.75]);
  const dots: number[][] = [],
    lines: number[][] = [];
  const ctx = {
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
    moveTo() {},
    stroke() {},
    fill() {},
    lineTo: (...args: number[]) => lines.push(args),
    arc: (...args: number[]) => dots.push(args),
  } as unknown as CanvasRenderingContext2D;
  const domain = foldFluxDomain(points);
  drawFoldedCurve(ctx, points, phases, domain, fullFoldView, 400, 200);
  assert.equal(dots.length, points.length * 2);
  assert.equal(lines.length, 5); // Grid lines only, never connect phase-sorted observations.
  assert.deepEqual(
    dots.map((p) => p[0]),
    [100, 300, 0, 200, 50, 250],
  );
  assert.deepEqual(points, original);
  const y = dots[0][1];
  dots.length = 0;
  drawFoldedCurve(
    ctx,
    points,
    phases,
    domain,
    { zoom: 2, center: 0 },
    400,
    200,
  );
  assert.equal(dots.find((p) => p[0] === 200)?.[1], y);
});

test("constant and empty flux domains remain finite without inventing zero observations", () => {
  assert.deepEqual(foldFluxDomain([]), [0, 1]);
  const domain = foldFluxDomain([points[0], points[0]]);
  assert.ok(domain[0] < 1 && domain[1] > 1);
});

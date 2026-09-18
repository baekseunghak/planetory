import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisContextFixture,
  analysisCurveFixture,
} from "../../dev/analysis-fixtures";
import {
  decodeAnalysisContext,
  decodeCurve,
} from "../../src/features/analysis/analysis-data";
import {
  buildTimeCurve,
  clampTimeView,
  drawTimeCurve,
  pointAtDisplay,
  zoomTimeView,
} from "../../src/features/analysis/time-curve";

function sample() {
  const context = analysisContextFixture();
  const curve = decodeCurve(
    analysisCurveFixture(),
    decodeAnalysisContext(context, context.ticId),
    200,
  );
  if (curve.kind !== "ready") throw new Error("expected ready");
  return curve.segments;
}
test("actual BTJD uses each segment cadence while the long display gap is compressed", () => {
  const segments = sample(),
    curve = buildTimeCurve(segments);
  assert.equal(curve.points.length, 11);
  assert.equal(curve.points[1].btjd, 1683.35 + 10 / 1440);
  assert.equal(curve.points[7].btjd, 2419.99 + (2 * 20) / 1440);
  assert.equal(curve.points[7].index, 2);
  assert.ok(curve.width < 1);
  assert.ok(curve.points.at(-1)!.btjd - curve.points[0].btjd > 700);
  assert.deepEqual(
    curve.segments.map((s) => s.runs.map((run) => run.length)),
    [
      [2, 4],
      [1, 4],
    ],
  );
  assert.ok(curve.fluxDomain[0] > 0.99);
  assert.deepEqual(segments, sample());
});
test("pointer lookup returns no observation in null bins or compressed Sector separators", () => {
  const curve = buildTimeCurve(sample());
  const segment = curve.segments[0];
  assert.equal(
    pointAtDisplay(curve, (segment.gaps[0].start + segment.gaps[0].end) / 2),
    null,
  );
  assert.equal(
    pointAtDisplay(curve, (segment.end + curve.segments[1].start) / 2),
    null,
  );
  assert.equal(
    pointAtDisplay(curve, curve.points[1].x)?.btjd,
    curve.points[1].btjd,
  );
  assert.equal(pointAtDisplay(curve, -1), null);
});
test("renderer draws separate paths across both kinds of gaps and rasterizes every valid point", () => {
  const curve = buildTimeCurve(sample());
  const strokes: number[][][] = [];
  let path: number[][] = [],
    dots = 0;
  const ctx = {
    clearRect() {},
    save() {},
    restore() {},
    rect() {},
    clip() {},
    fillRect() {},
    fill() {},
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push([x, y]);
    },
    lineTo(x: number, y: number) {
      path.push([x, y]);
    },
    stroke() {
      strokes.push(path);
    },
    arc() {
      dots++;
    },
  } as unknown as CanvasRenderingContext2D;
  drawTimeCurve(ctx, curve, { zoom: 1, center: curve.width / 2 }, 1000, 280);
  assert.equal(dots, 11);
  assert.deepEqual(
    strokes.slice(5).map((run) => run.length),
    [2, 4, 1, 4],
  );
  const toX = (x: number) => (x / curve.width) * 1000;
  assert.ok(strokes[5].at(-1)![0] < toX(curve.segments[0].gaps[0].start));
  assert.ok(strokes[6][0][0] > toX(curve.segments[0].gaps[0].end));
  assert.ok(strokes[6].at(-1)![0] < toX(curve.segments[0].end));
  assert.ok(strokes[7][0][0] > toX(curve.segments[1].start));
});
test("single-point, constant and all-null inputs keep finite display geometry", () => {
  const one = { ...sample()[0], nPoints: 1, flux: [0], gaps: [] };
  const curve = buildTimeCurve([one]);
  assert.equal(curve.points.length, 1);
  assert.equal(curve.points[0].flux, 0);
  assert.ok(curve.width > 0);
  assert.ok(curve.fluxDomain.every(Number.isFinite));
  assert.ok(curve.fluxDomain[1] > curve.fluxDomain[0]);
  assert.deepEqual(buildTimeCurve([{ ...one, flux: [null] }]).points, []);
  assert.deepEqual(buildTimeCurve([]).points, []);
});
test("overlapping segments remain separate and a full 20,000-bin segment is not reduced", () => {
  const first = sample()[0];
  const overlapping = {
    ...first,
    segmentId: "overlap",
    startBtjd: first.startBtjd,
  };
  const model = buildTimeCurve([first, overlapping]);
  assert.equal(model.points.length, 12);
  assert.ok(model.segments[1].start > model.segments[0].end);
  const large = buildTimeCurve([
    {
      ...first,
      nPoints: 20000,
      flux: Array.from({ length: 20000 }, (_, i) => 1 + i * 1e-8),
      gaps: [],
    },
  ]);
  assert.equal(large.points.length, 20000);
  assert.equal(
    large.points.at(-1)!.btjd,
    first.startBtjd + (19999 * first.binMinutes) / 1440,
  );
});
test("zoom preserves its pointer anchor and panning cannot leave the display bounds", () => {
  const width = 100,
    view = { zoom: 1, center: 50 };
  const next = zoomTimeView(view, width, 2, 0.25);
  assert.equal(next.center + ((0.25 - 0.5) * width) / next.zoom, 25);
  assert.deepEqual(clampTimeView({ zoom: 4, center: -100 }, width), {
    zoom: 4,
    center: 12.5,
  });
  assert.deepEqual(clampTimeView({ zoom: 4, center: 200 }, width), {
    zoom: 4,
    center: 87.5,
  });
  assert.equal(clampTimeView({ zoom: 100, center: 50 }, width).zoom, 64);
  assert.deepEqual(zoomTimeView(next, width, 0.5), view);
});
